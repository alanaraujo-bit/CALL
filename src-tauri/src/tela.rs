//! Captura de tela nativa, para o seletor de fontes ter a cara do CALL em vez
//! da caixa cinza que o Windows entrega a qualquer site que chame
//! `getDisplayMedia`. O vídeo sai daqui como quadros JPEG por evento; quem
//! monta o `MediaStreamTrack` de verdade é a interface, desenhando cada
//! quadro num `<canvas>` e chamando `captureStream()` nele.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageEncoder, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use xcap::{Monitor, Window};

/// Uma janela ou uma tela inteira, do jeito que o seletor mostra: já com a
/// miniatura pronta, para a grade não esperar rede nem disco — só o tempo de
/// capturar e reduzir cada imagem uma vez.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fonte {
    id: u32,
    tipo: &'static str,
    nome: String,
    miniatura: String,
    largura: u32,
    altura: u32,
}

/// Reduz para uma miniatura leve e devolve como `data:` URL — o formato que
/// uma tag `<img>` aceita direto, sem outra viagem até o disco.
fn miniaturizar(imagem: &RgbaImage, largura_alvo: u32) -> String {
    let proporcao = imagem.height() as f32 / imagem.width().max(1) as f32;
    let altura_alvo = ((largura_alvo as f32) * proporcao).round().max(1.0) as u32;
    let reduzida = image::imageops::resize(imagem, largura_alvo, altura_alvo, FilterType::Triangle);

    let mut bytes = Vec::new();
    // PNG aqui, não JPEG: a miniatura é estática e pequena, e texto de janela
    // sofre visivelmente com a compressão com perdas nesse tamanho.
    let _ = image::codecs::png::PngEncoder::new(&mut bytes).write_image(
        reduzida.as_raw(),
        reduzida.width(),
        reduzida.height(),
        image::ExtendedColorType::Rgba8,
    );
    format!("data:image/png;base64,{}", STANDARD.encode(&bytes))
}

/// Lista as telas e depois as janelas — a ordem que o Discord usa, e que
/// coloca a opção mais comum (a tela toda) antes da mais específica.
///
/// Falhas em capturar uma janela isolada (fechada entre a listagem e a
/// captura, sem permissão, minimizada) não derrubam a lista inteira: essa
/// janela só não aparece.
#[tauri::command]
pub fn listar_fontes_de_tela() -> Result<Vec<Fonte>, String> {
    let mut fontes = Vec::new();

    let monitores = Monitor::all().map_err(|e| e.to_string())?;
    for monitor in monitores {
        let Ok(imagem) = monitor.capture_image() else {
            continue;
        };
        if imagem.width() == 0 || imagem.height() == 0 {
            continue;
        }
        let Ok(id) = monitor.id() else { continue };
        let nome = monitor
            .friendly_name()
            .or_else(|_| monitor.name())
            .unwrap_or_else(|_| "Tela".into());

        fontes.push(Fonte {
            id,
            tipo: "tela",
            nome,
            miniatura: miniaturizar(&imagem, 320),
            largura: imagem.width(),
            altura: imagem.height(),
        });
    }

    let janelas = Window::all().map_err(|e| e.to_string())?;
    for janela in janelas {
        // Minimizada captura preto sólido na maioria dos sistemas — pior do
        // que não oferecer a opção é oferecer e entregar uma tela vazia.
        if matches!(janela.is_minimized(), Ok(true)) {
            continue;
        }
        let Ok(imagem) = janela.capture_image() else {
            continue;
        };
        if imagem.width() < 40 || imagem.height() < 40 {
            continue;
        }
        let Ok(id) = janela.id() else { continue };
        let titulo = janela.title().unwrap_or_default();
        if titulo.trim().is_empty() {
            continue;
        }

        fontes.push(Fonte {
            id,
            tipo: "janela",
            nome: titulo,
            miniatura: miniaturizar(&imagem, 320),
            largura: imagem.width(),
            altura: imagem.height(),
        });
    }

    Ok(fontes)
}

/// Sinal de parada da captura em curso. Um só de cada vez: começar uma nova
/// avisa a anterior antes de seguir, então nunca há duas threads desenhando
/// quadros ao mesmo tempo.
#[derive(Default)]
pub struct CapturaAtiva(Mutex<Option<Arc<AtomicBool>>>);

impl CapturaAtiva {
    fn parar_a_anterior(&self) {
        if let Ok(mut atual) = self.0.lock() {
            if let Some(parar) = atual.take() {
                parar.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// Quadro de vídeo, do jeito que a interface recebe: só o essencial para
/// desenhar num canvas — os bytes e o tamanho, já que um quadro pode chegar
/// menor que o pedido quando a janela capturada muda de tamanho.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Quadro {
    dados: String,
    largura: u32,
    altura: u32,
}

enum FonteViva {
    Tela(Monitor),
    Janela(Window),
}

impl FonteViva {
    fn capturar(&self) -> xcap::XCapResult<RgbaImage> {
        match self {
            FonteViva::Tela(m) => m.capture_image(),
            FonteViva::Janela(w) => w.capture_image(),
        }
    }
}

fn encontrar_fonte(tipo: &str, id: u32) -> Option<FonteViva> {
    match tipo {
        "tela" => Monitor::all()
            .ok()?
            .into_iter()
            .find(|m| m.id().ok() == Some(id))
            .map(FonteViva::Tela),
        "janela" => Window::all()
            .ok()?
            .into_iter()
            .find(|w| w.id().ok() == Some(id))
            .map(FonteViva::Janela),
        _ => None,
    }
}

/// Começa a mandar quadros da fonte escolhida pelo evento `quadro-tela`, no
/// ritmo pedido pelo perfil de qualidade. Roda numa thread própria porque é
/// um laço com `sleep`: numa das threads do runtime assíncrono ele travaria
/// outros comandos no meio do caminho.
#[tauri::command]
pub fn iniciar_captura_de_tela(
    app: AppHandle,
    estado: State<'_, CapturaAtiva>,
    tipo: String,
    id: u32,
    largura_max: u32,
    altura_max: u32,
    quadros: u32,
) -> Result<(), String> {
    estado.parar_a_anterior();

    // O achado aqui é só para falhar cedo se a fonte já sumiu — o valor em
    // si não atravessa para a thread: um `HMONITOR`/`HWND` do Windows não é
    // `Send`, então quem captura busca a própria fonte de novo, já lá dentro.
    encontrar_fonte(&tipo, id).ok_or_else(|| "Essa fonte não está mais disponível.".to_string())?;

    let parar = Arc::new(AtomicBool::new(false));
    *estado
        .0
        .lock()
        .map_err(|_| "Estado interno inconsistente.".to_string())? = Some(parar.clone());

    let quadros = quadros.max(1).min(60);
    let intervalo = Duration::from_millis(1000 / quadros as u64);

    thread::spawn(move || {
        let Some(fonte) = encontrar_fonte(&tipo, id) else {
            return;
        };

        while !parar.load(Ordering::SeqCst) {
            let inicio = Instant::now();

            if let Ok(imagem) = fonte.capturar() {
                let redimensionada = if imagem.width() > largura_max || imagem.height() > altura_max
                {
                    let escala = (largura_max as f32 / imagem.width() as f32)
                        .min(altura_max as f32 / imagem.height() as f32);
                    let largura = ((imagem.width() as f32) * escala).round().max(1.0) as u32;
                    let altura = ((imagem.height() as f32) * escala).round().max(1.0) as u32;
                    DynamicImage::ImageRgba8(imagem).resize_exact(largura, altura, FilterType::Triangle)
                } else {
                    DynamicImage::ImageRgba8(imagem)
                };
                let rgb = redimensionada.to_rgb8();

                let mut bytes = Vec::new();
                let escritor = JpegEncoder::new_with_quality(Cursor::new(&mut bytes), 82);
                if escritor
                    .write_image(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .is_ok()
                {
                    let quadro = Quadro {
                        dados: STANDARD.encode(&bytes),
                        largura: rgb.width(),
                        altura: rgb.height(),
                    };
                    if app.emit("quadro-tela", quadro).is_err() {
                        break;
                    }
                }
            } else {
                // A janela pode ter fechado no meio da transmissão. Sem a
                // imagem não há o que mandar, mas isso sozinho não é motivo
                // para desistir — só a pessoa que compartilha, pelo botão,
                // decide quando parar.
            }

            let decorrido = inicio.elapsed();
            if decorrido < intervalo {
                thread::sleep(intervalo - decorrido);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn parar_captura_de_tela(estado: State<'_, CapturaAtiva>) -> Result<(), String> {
    estado.parar_a_anterior();
    Ok(())
}

/* ═══ Áudio do sistema (captura em loopback via WASAPI) ═════════════ */

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

const AUDIO_TAXA_DE_AMOSTRAGEM: usize = 48_000;
const AUDIO_CANAIS: usize = 2;
/// 20 ms por pedaço: curto o bastante para não se ouvir como atraso, longo o
/// bastante para não virar uma enxurrada de eventos.
const AUDIO_QUADROS_POR_PEDACO: usize = 960;

/// Mesmo desenho do `CapturaAtiva`: um sinal de parada por vez.
#[derive(Default)]
pub struct AudioAtivo(Mutex<Option<Arc<AtomicBool>>>);

impl AudioAtivo {
    fn parar_o_anterior(&self) {
        if let Ok(mut atual) = self.0.lock() {
            if let Some(parar) = atual.take() {
                parar.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PedacoDeAudio {
    dados: String,
    taxa_de_amostragem: usize,
    canais: usize,
}

/// Grava o que sai dos alto-falantes, não o microfone: pede o dispositivo de
/// *saída* padrão em modo de captura, o mesmo mecanismo por trás da antiga
/// "Mixagem estéreo" do Windows. As amostras chegam em ponto flutuante — o
/// formato nativo do mecanismo de áudio do Windows — e saem daqui em inteiro
/// de 16 bits, que é metade do tamanho e já é mais resolução do que o ouvido
/// nota nessa viagem.
fn gravar_audio_do_sistema(app: &AppHandle, parar: &AtomicBool) -> Result<(), wasapi::WasapiError> {
    initialize_mta().ok()?;

    let formato = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        AUDIO_TAXA_DE_AMOSTRAGEM,
        AUDIO_CANAIS,
        None,
    );
    let enumerador = DeviceEnumerator::new()?;
    let dispositivo = enumerador.get_default_device(&Direction::Render)?;
    let mut cliente = dispositivo.get_iaudioclient()?;
    let (_padrao, minimo) = cliente.get_device_period()?;
    let modo = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: minimo,
    };
    // Pedir `Capture` a um dispositivo aberto como `Render` é o que ativa o
    // loopback — não existe uma opção "loopback: true" separada.
    cliente.initialize_client(&formato, &Direction::Capture, &modo)?;
    let evento = cliente.set_get_eventhandle()?;
    let capturador = cliente.get_audiocaptureclient()?;
    let bytes_por_quadro = formato.get_blockalign() as usize;
    let bytes_por_pedaco = bytes_por_quadro * AUDIO_QUADROS_POR_PEDACO;

    let mut fila: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    cliente.start_stream()?;

    while !parar.load(Ordering::SeqCst) {
        while fila.len() >= bytes_por_pedaco {
            let pedaco_f32: Vec<u8> = fila.drain(..bytes_por_pedaco).collect();
            let amostras_i16: Vec<u8> = pedaco_f32
                .chunks_exact(4)
                .flat_map(|quatro| {
                    let amostra = f32::from_le_bytes([quatro[0], quatro[1], quatro[2], quatro[3]]);
                    let inteiro = (amostra.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                    inteiro.to_le_bytes()
                })
                .collect();

            let pedaco = PedacoDeAudio {
                dados: STANDARD.encode(&amostras_i16),
                taxa_de_amostragem: AUDIO_TAXA_DE_AMOSTRAGEM,
                canais: AUDIO_CANAIS,
            };
            if app.emit("audio-tela", pedaco).is_err() {
                let _ = cliente.stop_stream();
                return Ok(());
            }
        }
        capturador.read_from_device_to_deque(&mut fila)?;
        if evento.wait_for_event(1000).is_err() {
            break;
        }
    }

    let _ = cliente.stop_stream();
    Ok(())
}

#[tauri::command]
pub fn iniciar_audio_da_tela(app: AppHandle, estado: State<'_, AudioAtivo>) -> Result<(), String> {
    estado.parar_o_anterior();

    let parar = Arc::new(AtomicBool::new(false));
    *estado
        .0
        .lock()
        .map_err(|_| "Estado interno inconsistente.".to_string())? = Some(parar.clone());

    thread::spawn(move || {
        if let Err(erro) = gravar_audio_do_sistema(&app, &parar) {
            eprintln!("[tela] captura de áudio do sistema encerrada: {erro}");
        }
    });

    Ok(())
}

#[tauri::command]
pub fn parar_audio_da_tela(estado: State<'_, AudioAtivo>) -> Result<(), String> {
    estado.parar_o_anterior();
    Ok(())
}
