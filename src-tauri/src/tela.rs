//! Áudio que acompanha a transmissão de tela.
//!
//! O vídeo é capturado diretamente pelo WebView2 e já nasce como uma
//! `MediaStreamTrack`; fazê-lo atravessar o IPC como screenshots comprimidos
//! duplicava o trabalho do codec e limitava a transmissão a cerca de 15 fps.
//! Aqui fica apenas o recurso que a API web não resolve sozinha no Windows: o
//! loopback por processo.
//!
//! São dois modos, e quem decide é o que a pessoa escolheu transmitir:
//!
//! - **uma janela** → só o som do programa dono dela (`INCLUDE_TARGET_PROCESS_TREE`).
//!   É o que o Discord faz: transmitir o jogo não leva junto a música do
//!   Spotify, o vídeo do YouTube na outra aba nem as notificações do sistema.
//! - **a tela inteira**, ou uma janela que não deu para identificar → o som do
//!   sistema todo menos o próprio CALL (`EXCLUDE_TARGET_PROCESS_TREE`), que é o
//!   comportamento de antes.
//!
//! As amostras saem daqui como bytes crus num `Channel`, e não como evento com
//! base64 dentro de JSON: cinquenta eventos por segundo, cada um codificado,
//! interpretado e decodificado no thread da interface, eram exatamente o que
//! fazia o som da tela estalar quando a interface engasgava.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const AUDIO_TAXA_DE_AMOSTRAGEM: usize = 48_000;
const AUDIO_CANAIS: usize = 2;
/// 20 ms por pedaço: curto o bastante para não se ouvir como atraso, longo o
/// bastante para não virar uma enxurrada de mensagens.
const AUDIO_QUADROS_POR_PEDACO: usize = 960;

#[derive(Default)]
pub struct AudioAtivo {
    captura: Mutex<Option<Arc<AtomicBool>>>,
    processo_webview: Mutex<Option<u32>>,
}

impl AudioAtivo {
    fn parar_o_anterior(&self) {
        if let Ok(mut atual) = self.captura.lock() {
            if let Some(parar) = atual.take() {
                parar.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn definir_processo_webview(&self, processo: u32) {
        if processo == 0 {
            return;
        }
        if let Ok(mut atual) = self.processo_webview.lock() {
            *atual = Some(processo);
        }
    }

    fn processo_webview(&self) -> Option<u32> {
        self.processo_webview.lock().ok().and_then(|atual| *atual)
    }
}

/// De que processo vem o som, e se ele entra sozinho ou é o único que sai.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Alvo {
    /// Só este processo e seus filhos — a janela que está sendo transmitida.
    SoEste(u32),
    /// Tudo menos este processo e seus filhos — o próprio CALL.
    TudoMenos(u32),
}

/// O que a interface precisa saber para dizer à pessoa o que está indo junto
/// com a imagem.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FonteDoSom {
    /// `"programa"` ou `"sistema"`.
    modo: &'static str,
    /// O executável, quando o modo é `programa` — `chrome.exe`, `cs2.exe`.
    programa: Option<String>,
}

/// O Chromium rotula a trilha de uma captura de janela com o identificador
/// da fonte, no formato `window:<HWND>:<n>` — o mesmo que o `desktopCapturer`
/// do Electron devolve. Uma captura de tela inteira vem como `screen:<n>:<n>`
/// e não tem janela para devolver.
fn alca_do_rotulo(rotulo: &str) -> Option<isize> {
    let resto = rotulo.trim().strip_prefix("window:")?;
    let numero = resto.split(':').next()?;
    let alca: isize = numero.parse().ok()?;
    (alca != 0).then_some(alca)
}

/// Executáveis que hospedam a janela de outro programa sem tocar o som dele.
/// Incluir só o processo de uma dessas janelas transmitiria silêncio — pior do
/// que o som do sistema, que pelo menos leva o som certo junto com o resto.
fn hospeda_janela_alheia(programa: &str) -> bool {
    matches!(
        programa.to_ascii_lowercase().as_str(),
        "applicationframehost.exe" | "explorer.exe" | "dwm.exe"
    )
}

#[cfg(windows)]
mod janelas {
    use std::ffi::c_void;

    type Alca = *mut c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    extern "system" {
        fn IsWindow(janela: Alca) -> i32;
        fn IsWindowVisible(janela: Alca) -> i32;
        fn GetWindowThreadProcessId(janela: Alca, processo: *mut u32) -> u32;
        fn GetWindowTextW(janela: Alca, destino: *mut u16, tamanho: i32) -> i32;
        fn EnumWindows(
            visitar: unsafe extern "system" fn(Alca, isize) -> i32,
            contexto: isize,
        ) -> i32;
        fn OpenProcess(acesso: u32, herdar: i32, processo: u32) -> Alca;
        fn QueryFullProcessImageNameW(
            processo: Alca,
            estilo: u32,
            destino: *mut u16,
            tamanho: *mut u32,
        ) -> i32;
        fn CloseHandle(alca: Alca) -> i32;
    }

    fn titulo(janela: Alca) -> String {
        let mut destino = [0u16; 512];
        let lidos = unsafe { GetWindowTextW(janela, destino.as_mut_ptr(), destino.len() as i32) };
        String::from_utf16_lossy(&destino[..lidos.max(0) as usize])
    }

    struct Procura<'a> {
        titulo: &'a str,
        achada: Alca,
    }

    unsafe extern "system" fn comparar(janela: Alca, contexto: isize) -> i32 {
        let procura = &mut *(contexto as *mut Procura);
        if IsWindowVisible(janela) != 0 && titulo(janela) == procura.titulo {
            procura.achada = janela;
            return 0; // achou: para a enumeração
        }
        1
    }

    /// Plano B quando o rótulo não traz o identificador: uma janela visível
    /// com exatamente o mesmo título. Título repetido acha a primeira — e é
    /// por isso que este caminho só serve de reserva.
    fn pelo_titulo(texto: &str) -> Option<Alca> {
        let texto = texto.trim();
        if texto.is_empty() {
            return None;
        }
        let mut procura = Procura {
            titulo: texto,
            achada: std::ptr::null_mut(),
        };
        unsafe { EnumWindows(comparar, &mut procura as *mut Procura as isize) };
        (!procura.achada.is_null()).then_some(procura.achada)
    }

    /// Processo dono da janela que o rótulo descreve.
    pub fn processo_do_rotulo(rotulo: &str) -> Option<u32> {
        let janela = super::alca_do_rotulo(rotulo)
            .map(|alca| alca as Alca)
            .filter(|&janela| unsafe { IsWindow(janela) } != 0)
            .or_else(|| pelo_titulo(rotulo))?;
        let mut processo = 0u32;
        unsafe { GetWindowThreadProcessId(janela, &mut processo) };
        (processo != 0).then_some(processo)
    }

    /// Só o nome do executável — `chrome.exe`, e não o caminho inteiro.
    pub fn programa(processo: u32) -> Option<String> {
        unsafe {
            let alca = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, processo);
            if alca.is_null() {
                return None;
            }
            let mut destino = [0u16; 512];
            let mut tamanho = destino.len() as u32;
            let deu_certo = QueryFullProcessImageNameW(alca, 0, destino.as_mut_ptr(), &mut tamanho);
            CloseHandle(alca);
            if deu_certo == 0 || tamanho == 0 {
                return None;
            }
            let caminho = String::from_utf16_lossy(&destino[..tamanho as usize]);
            caminho.rsplit(['\\', '/']).next().map(str::to_owned)
        }
    }
}

#[cfg(not(windows))]
mod janelas {
    pub fn processo_do_rotulo(_rotulo: &str) -> Option<u32> {
        None
    }
    pub fn programa(_processo: u32) -> Option<String> {
        None
    }
}

/// Decide o alvo do loopback. Cai para "tudo menos o CALL" sempre que não dá
/// para afirmar qual programa é o dono da janela: um som do sistema inteiro é
/// um som a mais, mas um processo errado é silêncio.
fn escolher_alvo(rotulo: Option<&str>, proprio: u32, webview: Option<u32>) -> (Alvo, FonteDoSom) {
    let excluido = webview.unwrap_or(proprio);
    let sistema = (
        Alvo::TudoMenos(excluido),
        FonteDoSom {
            modo: "sistema",
            programa: None,
        },
    );

    let Some(processo) = rotulo.and_then(janelas::processo_do_rotulo) else {
        return sistema;
    };
    // Transmitir a própria janela do CALL com o som dela traria de volta as
    // vozes da sala — o eco que o modo de exclusão existe para evitar.
    if processo == proprio || Some(processo) == webview {
        return sistema;
    }
    let programa = janelas::programa(processo);
    if programa.as_deref().is_some_and(hospeda_janela_alheia) {
        return sistema;
    }
    (
        Alvo::SoEste(processo),
        FonteDoSom {
            modo: "programa",
            programa,
        },
    )
}

/// Grava o som pedido. As amostras chegam em ponto flutuante e saem daqui em
/// inteiro de 16 bits, metade do tamanho e ainda acima da resolução útil depois
/// do Opus.
fn gravar_audio(
    canal: &Channel<InvokeResponseBody>,
    parar: &AtomicBool,
    alvo: Alvo,
) -> Result<(), wasapi::WasapiError> {
    initialize_mta().ok()?;

    let formato = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        AUDIO_TAXA_DE_AMOSTRAGEM,
        AUDIO_CANAIS,
        None,
    );
    // Esta API existe no Windows 10 build 20348 em diante. Em versões mais
    // antigas preferimos seguir sem som de tela a reintroduzir retorno de voz.
    let (processo, incluir) = match alvo {
        Alvo::SoEste(processo) => (processo, true),
        Alvo::TudoMenos(processo) => (processo, false),
    };
    let mut cliente = AudioClient::new_application_loopback_client(processo, incluir)?;
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
            let amostras_i16: Vec<u8> = fila
                .drain(..bytes_por_pedaco)
                .collect::<Vec<u8>>()
                .chunks_exact(4)
                .flat_map(|quatro| {
                    let amostra = f32::from_le_bytes([quatro[0], quatro[1], quatro[2], quatro[3]]);
                    let inteiro = (amostra.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                    inteiro.to_le_bytes()
                })
                .collect();

            // O canal só falha quando a página que o abriu não existe mais.
            if canal.send(InvokeResponseBody::Raw(amostras_i16)).is_err() {
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

/// `rotulo` é o `label` da trilha de vídeo que o `getDisplayMedia` devolveu.
/// É por ele que se sabe se a pessoa escolheu uma janela, e qual.
#[tauri::command]
pub fn iniciar_audio_da_tela(
    app: AppHandle,
    estado: State<'_, AudioAtivo>,
    canal: Channel<InvokeResponseBody>,
    rotulo: Option<String>,
) -> Result<FonteDoSom, String> {
    estado.parar_o_anterior();

    let parar = Arc::new(AtomicBool::new(false));
    *estado
        .captura
        .lock()
        .map_err(|_| "Estado interno inconsistente.".to_string())? = Some(parar.clone());
    // O som do CALL é renderizado pelo conjunto de processos do WebView2, não
    // pelo executável hospedeiro do Tauri: é a raiz desse conjunto que precisa
    // ficar de fora do som do sistema.
    let (alvo, fonte) = escolher_alvo(
        rotulo.as_deref(),
        std::process::id(),
        estado.processo_webview(),
    );

    thread::spawn(move || {
        if let Err(erro) = gravar_audio(&canal, &parar, alvo) {
            eprintln!("[tela] captura de áudio encerrada: {erro}");
            let _ = app.emit("erro-audio-tela", erro.to_string());
        }
    });

    Ok(fonte)
}

#[tauri::command]
pub fn parar_audio_da_tela(estado: State<'_, AudioAtivo>) -> Result<(), String> {
    estado.parar_o_anterior();
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn le_a_janela_do_rotulo_do_chromium() {
        assert_eq!(alca_do_rotulo("window:132154:0"), Some(132154));
        assert_eq!(alca_do_rotulo(" window:7:1 "), Some(7));
    }

    #[test]
    fn tela_inteira_e_rotulo_estranho_nao_viram_janela() {
        assert_eq!(alca_do_rotulo("screen:0:0"), None);
        assert_eq!(alca_do_rotulo("window:0:0"), None);
        assert_eq!(alca_do_rotulo("window:abc:0"), None);
        assert_eq!(alca_do_rotulo("Discord"), None);
        assert_eq!(alca_do_rotulo(""), None);
    }

    #[test]
    fn hospedeiros_de_janela_alheia_nao_sao_alvo() {
        assert!(hospeda_janela_alheia("ApplicationFrameHost.exe"));
        assert!(hospeda_janela_alheia("explorer.exe"));
        assert!(!hospeda_janela_alheia("chrome.exe"));
        assert!(!hospeda_janela_alheia("cs2.exe"));
    }

    #[test]
    fn sem_janela_reconhecida_o_som_e_do_sistema_sem_o_call() {
        let (alvo, fonte) = escolher_alvo(Some("screen:0:0"), 100, Some(200));
        assert_eq!(alvo, Alvo::TudoMenos(200));
        assert_eq!(fonte.modo, "sistema");

        let (alvo, _) = escolher_alvo(None, 100, None);
        assert_eq!(alvo, Alvo::TudoMenos(100));
    }

    #[cfg(windows)]
    #[test]
    fn janela_que_nao_existe_cai_no_modo_seguro() {
        // O rótulo aponta para uma janela inexistente: sem alvo confiável, o
        // modo continua sendo o seguro.
        let (alvo, fonte) = escolher_alvo(Some("window:1:0"), std::process::id(), None);
        assert_eq!(alvo, Alvo::TudoMenos(std::process::id()));
        assert_eq!(fonte.modo, "sistema");
    }
}
