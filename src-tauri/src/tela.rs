//! Áudio que acompanha a transmissão de tela.
//!
//! O vídeo é capturado diretamente pelo WebView2 e já nasce como uma
//! `MediaStreamTrack`; fazê-lo atravessar o IPC como screenshots comprimidos
//! duplicava o trabalho do codec e limitava a transmissão a cerca de 15 fps.
//! Aqui fica apenas o recurso que a API web não resolve sozinha no Windows: o
//! loopback do sistema excluindo as vozes reproduzidas pelo próprio CALL.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const AUDIO_TAXA_DE_AMOSTRAGEM: usize = 48_000;
const AUDIO_CANAIS: usize = 2;
/// 20 ms por pedaço: curto o bastante para não se ouvir como atraso, longo o
/// bastante para não virar uma enxurrada de eventos.
const AUDIO_QUADROS_POR_PEDACO: usize = 960;

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

/// Grava o som do sistema sem capturar o próprio CALL. O loopback tradicional
/// do dispositivo inclui também as vozes remotas que o aplicativo acabou de
/// tocar; enviá-las de volta cria o eco ouvido por toda a sala. O process
/// loopback do Windows, em modo EXCLUDE_TARGET_PROCESS_TREE, captura tudo menos
/// este processo e seus filhos — exatamente a separação usada por aplicativos
/// de chamada.
///
/// As amostras chegam em ponto flutuante e saem daqui em inteiro de 16 bits,
/// metade do tamanho e ainda acima da resolução útil depois do Opus.
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
    // `false` seleciona PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
    // Esta API existe no Windows 10 build 20348 em diante. Em versões mais
    // antigas preferimos seguir sem som de tela a reintroduzir retorno de voz.
    let mut cliente = AudioClient::new_application_loopback_client(std::process::id(), false)?;
    let modo = StreamMode::EventsShared {
        autoconvert: true,
        // Process loopback não expõe get_device_period; 20 ms casa com o
        // tamanho dos pedaços enviados à interface.
        buffer_duration_hns: 200_000,
    };
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
            let _ = app.emit("erro-audio-tela", erro.to_string());
        }
    });

    Ok(())
}

#[tauri::command]
pub fn parar_audio_da_tela(estado: State<'_, AudioAtivo>) -> Result<(), String> {
    estado.parar_o_anterior();
    Ok(())
}
