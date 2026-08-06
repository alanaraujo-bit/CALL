use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Processo do servidor de sinalizacao, quando esta maquina esta hospedando.
#[derive(Default)]
struct Hospedagem(Mutex<Option<CommandChild>>);

impl Hospedagem {
    fn encerrar(&self) {
        if let Ok(mut atual) = self.0.lock() {
            if let Some(filho) = atual.take() {
                let _ = filho.kill();
            }
        }
    }
}

#[tauri::command]
fn hospedar(
    app: tauri::AppHandle,
    estado: State<'_, Hospedagem>,
    porta: u16,
) -> Result<String, String> {
    let mut atual = estado
        .0
        .lock()
        .map_err(|_| "Estado interno inconsistente.".to_string())?;

    if atual.is_some() {
        return Err("O servidor já está em execução.".into());
    }

    let (_rx, filho) = app
        .shell()
        .sidecar("sinalizacao")
        .map_err(|_| "O servidor de sinalização não foi encontrado nesta instalação.".to_string())?
        .args([porta.to_string()])
        .spawn()
        .map_err(|_| {
            format!("Não foi possível iniciar o servidor na porta {porta}. Ela pode estar ocupada.")
        })?;

    *atual = Some(filho);
    Ok(format!("ws://127.0.0.1:{porta}"))
}

#[tauri::command]
fn encerrar_hospedagem(estado: State<'_, Hospedagem>) -> Result<(), String> {
    estado.encerrar();
    Ok(())
}

/// Consulta o servidor de atualizacao e devolve a versao nova, se houver.
/// Devolver `None` e o caso normal: significa que ja estamos em dia.
#[tauri::command]
async fn procurar_atualizacao(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let achado = app
        .updater()
        .map_err(|erro| erro.to_string())?
        .check()
        .await
        .map_err(|erro| erro.to_string())?;

    Ok(achado.map(|atualizacao| atualizacao.version))
}

/// Baixa e executa o instalador da versao nova. A assinatura do pacote e
/// conferida contra a chave publica embutida no aplicativo: um instalador
/// trocado no caminho e recusado antes de rodar.
///
/// No Windows o instalador encerra o aplicativo por conta propria, entao o
/// que vem depois do `await` normalmente nao chega a executar.
#[tauri::command]
async fn instalar_atualizacao(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let achado = app
        .updater()
        .map_err(|erro| erro.to_string())?
        .check()
        .await
        .map_err(|erro| erro.to_string())?;

    let Some(atualizacao) = achado else {
        return Err("Nenhuma atualizacao disponivel.".into());
    };

    atualizacao
        .download_and_install(|_baixado, _total| {}, || {})
        .await
        .map_err(|erro| erro.to_string())?;

    Ok(())
}

/// O WebView2 pediria confirmacao nativa a cada uso do microfone. Como o
/// usuario ja pediu explicitamente para entrar na chamada, concedemos de uma
/// vez so o microfone; qualquer outra permissao continua seguindo o padrao.
#[cfg(windows)]
fn liberar_microfone(janela: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = janela.with_webview(|webview| unsafe {
        let Ok(nucleo) = webview.controller().CoreWebView2() else {
            return;
        };
        // A API devolve um token de registro; nao precisamos remover o handler.
        let mut ficha = 0i64;
        let _ = nucleo.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, argumentos| {
                let Some(argumentos) = argumentos else {
                    return Ok(());
                };
                let mut tipo = COREWEBVIEW2_PERMISSION_KIND::default();
                argumentos.PermissionKind(&mut tipo)?;
                if tipo == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    argumentos.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut ficha,
        );
    });
}

#[cfg(not(windows))]
fn liberar_microfone(_janela: &tauri::WebviewWindow) {}

/// Argumentos passados ao WebView2. Desligar servicos de fundo do Chromium
/// evita trabalho continuo que nao serve a nada neste aplicativo.
fn afinar_webview() {
    const ARGUMENTOS: &str = concat!(
        "--disable-background-networking ",
        "--disable-component-update ",
        "--disable-sync ",
        "--disable-breakpad ",
        "--no-first-run"
    );
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ARGUMENTOS);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    afinar_webview();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(Hospedagem::default());
            if let Some(janela) = app.get_webview_window("main") {
                liberar_microfone(&janela);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hospedar,
            encerrar_hospedagem,
            procurar_atualizacao,
            instalar_atualizacao
        ])
        .build(tauri::generate_context!())
        .expect("Falha ao iniciar a aplicação.");

    // O servidor hospedado e um processo separado: sem isto ele sobreviveria
    // ao fechamento da janela e manteria a porta ocupada.
    app.run(|app, evento| {
        if let RunEvent::Exit = evento {
            app.state::<Hospedagem>().encerrar();
        }
    });
}
