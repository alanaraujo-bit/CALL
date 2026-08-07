use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

mod tela;
use tela::CapturaAtiva;

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

/// Convite que chegou por `call://` e ainda nao foi consumido pela interface.
#[derive(Default)]
struct Convite(Mutex<Option<String>>);

/// Extrai o codigo de um endereco `call://entrar/CODIGO`. Aceita tambem
/// `call://CODIGO`, porque a barra a mais e o tipo de coisa que se perde ao
/// copiar um link de dentro de um aplicativo de mensagens.
///
/// A validacao aqui nao e cortesia: o valor vem de um clique em qualquer
/// pagina da internet e vai virar um pedido ao servidor. Dez caracteres
/// alfanumericos, e nada mais atravessa.
fn codigo_do_endereco(endereco: &str) -> Option<String> {
    let sem_esquema = endereco.strip_prefix("call://")?;
    let sem_consulta = sem_esquema.split(['?', '#']).next()?;
    let codigo = sem_consulta
        .split('/')
        .filter(|parte| !parte.is_empty())
        .next_back()?
        .to_uppercase();

    let formato_valido = codigo.len() == 10 && codigo.chars().all(|c| c.is_ascii_alphanumeric());
    formato_valido.then_some(codigo)
}

/// Guarda o convite e avisa a interface. O aviso nao carrega o codigo: quem o
/// entrega e `convite_pendente`, e um caminho so significa que ninguem entra
/// no grupo duas vezes se o evento e a leitura inicial se cruzarem na partida.
fn anotar_convite(app: &tauri::AppHandle, endereco: &str) {
    let Some(codigo) = codigo_do_endereco(endereco) else {
        return;
    };

    if let Ok(mut vaga) = app.state::<Convite>().0.lock() {
        *vaga = Some(codigo);
    }

    if let Some(janela) = app.get_webview_window("main") {
        // Quem clicou no link espera ver a janela, e nao um icone piscando na
        // barra de tarefas. `unminimize` antes do foco: uma janela minimizada
        // aceita o foco sem se mostrar.
        let _ = janela.unminimize();
        let _ = janela.set_focus();
    }
    let _ = app.emit("convite", ());
}

/// Entrega o convite pendente e o esquece. Devolver `None` e o caso normal:
/// significa que o aplicativo foi aberto pelo icone, e nao por um link.
#[tauri::command]
fn convite_pendente(estado: State<'_, Convite>) -> Option<String> {
    estado.0.lock().ok()?.take()
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

    let mut construtor = tauri::Builder::default();

    // Instancia unica e o que faz um link clicado com o CALL aberto chegar a
    // janela que ja existe. O preco e que duas janelas na mesma maquina deixam
    // de ser possiveis — e os roteiros que testam duas pessoas conversando
    // dependem exatamente disso. A saida e explicita e so eles a usam.
    if std::env::var_os("CALL_INSTANCIAS_MULTIPLAS").is_none() {
        // Primeiro de todos, por exigencia do proprio plugin: e ele quem
        // decide se este processo continua vivo ou entrega os argumentos a
        // instancia que ja estava aberta.
        construtor = construtor.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(janela) = app.get_webview_window("main") {
                let _ = janela.unminimize();
                let _ = janela.set_focus();
            }
        }));
    }

    let app = construtor
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;

            app.manage(Hospedagem::default());
            app.manage(Convite::default());
            app.manage(CapturaAtiva::default());

            // O instalador registra o esquema no sistema; em desenvolvimento
            // nao passa instalador nenhum, e sem isto o `call://` nao existiria
            // fora de uma maquina onde o CALL ja foi instalado alguma vez.
            let _ = app.deep_link().register_all();

            // Aplicativo aberto pelo proprio link: a URL ja veio na linha de
            // comando e nao dispara evento nenhum.
            if let Ok(Some(enderecos)) = app.deep_link().get_current() {
                if let Some(primeiro) = enderecos.first() {
                    anotar_convite(app.handle(), primeiro.as_str());
                }
            }

            let alca = app.handle().clone();
            app.deep_link().on_open_url(move |evento| {
                if let Some(endereco) = evento.urls().first() {
                    anotar_convite(&alca, endereco.as_str());
                }
            });

            if let Some(janela) = app.get_webview_window("main") {
                liberar_microfone(&janela);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hospedar,
            encerrar_hospedagem,
            convite_pendente,
            procurar_atualizacao,
            instalar_atualizacao,
            tela::listar_fontes_de_tela,
            tela::iniciar_captura_de_tela,
            tela::parar_captura_de_tela
        ])
        .build(tauri::generate_context!())
        .expect("Falha ao iniciar a aplicação.");

    // O servidor hospedado e um processo separado: sem isto ele sobreviveria
    // ao fechamento da janela e manteria a porta ocupada.
    app.run(|app, evento| {
        if let RunEvent::Exit = evento {
            app.state::<Hospedagem>().encerrar();
            let _ = tela::parar_captura_de_tela(app.state::<CapturaAtiva>());
        }
    });
}

#[cfg(test)]
mod testes {
    use super::codigo_do_endereco;

    #[test]
    fn aceita_as_formas_que_um_link_real_assume() {
        assert_eq!(
            codigo_do_endereco("call://entrar/K7M2XQ9PVR"),
            Some("K7M2XQ9PVR".into())
        );
        // Sem a barra, como sobra quando o link e reescrito por um aplicativo
        // de mensagens.
        assert_eq!(
            codigo_do_endereco("call://K7M2XQ9PVR"),
            Some("K7M2XQ9PVR".into())
        );
        // O nome do grupo viaja como consulta e nao pertence ao codigo.
        assert_eq!(
            codigo_do_endereco("call://entrar/K7M2XQ9PVR?g=Equipe"),
            Some("K7M2XQ9PVR".into())
        );
        // A `Url` do plugin acrescenta a barra final sozinha em alguns casos.
        assert_eq!(
            codigo_do_endereco("call://entrar/K7M2XQ9PVR/"),
            Some("K7M2XQ9PVR".into())
        );
        assert_eq!(
            codigo_do_endereco("call://entrar/k7m2xq9pvr"),
            Some("K7M2XQ9PVR".into())
        );
    }

    #[test]
    fn recusa_o_que_nao_e_um_codigo() {
        // Comprimento errado: o servidor sorteia dez caracteres, sempre.
        assert_eq!(codigo_do_endereco("call://entrar/ABC"), None);
        assert_eq!(codigo_do_endereco("call://entrar/K7M2XQ9PVRZZ"), None);
        // Injecao de caracteres fora do alfabeto do convite.
        assert_eq!(codigo_do_endereco("call://entrar/K7M2XQ9P%00"), None);
        assert_eq!(codigo_do_endereco("call://entrar/../../etc"), None);
        // Esquema alheio: nada a fazer com ele.
        assert_eq!(codigo_do_endereco("https://exemplo/K7M2XQ9PVR"), None);
        assert_eq!(codigo_do_endereco("call://"), None);
    }
}
