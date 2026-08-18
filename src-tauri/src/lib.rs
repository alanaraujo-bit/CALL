use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

mod atividade;
mod controle;
mod google;
mod resumo;
mod tela;
use tela::AudioAtivo;

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

/// Traz a janela principal para a frente — do jeito que faz sentido tanto
/// vindo de um clique num link, de uma segunda instância, ou do ícone da
/// bandeja: minimizada aceita o foco sem se mostrar, e escondida (depois de
/// um fechamento que virou bandeja) não sai da minimização sozinha. Os dois
/// passos juntos cobrem as duas origens.
fn mostrar_janela_principal(app: &tauri::AppHandle) {
    if let Some(janela) = app.get_webview_window("main") {
        let _ = janela.unminimize();
        let _ = janela.show();
        let _ = janela.set_focus();
    }
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

    // Quem clicou no link espera ver a janela — inclusive se ela estava
    // escondida na bandeja, e não só minimizada na barra de tarefas.
    mostrar_janela_principal(app);
    let _ = app.emit("convite", ());
}

/// Entrega o convite pendente e o esquece. Devolver `None` e o caso normal:
/// significa que o aplicativo foi aberto pelo icone, e nao por um link.
#[tauri::command]
fn convite_pendente(estado: State<'_, Convite>) -> Option<String> {
    estado.0.lock().ok()?.take()
}

/// Servidor imposto por variavel de ambiente, que vence o gravado nas
/// preferencias. Devolver `None` e o caso normal.
///
/// Existe porque o endereco do servidor saiu da tela de entrada e virou
/// ajuste: os roteiros que dirigem duas janelas reais precisavam de um jeito
/// de apontar o aplicativo para um servidor local sem navegar um painel
/// modal por coordenada de clique — que e justamente o tipo de teste que
/// quebra em silencio quando o layout muda. Serve tambem a quem sobe o CALL
/// numa rede local e nao quer mexer em ajuste nenhum.
#[tauri::command]
fn servidor_do_ambiente() -> Option<String> {
    std::env::var("CALL_SERVIDOR").ok().filter(|s| !s.is_empty())
}

/// Apelido imposto por variavel de ambiente, que faz o aplicativo entrar
/// direto, sem conta. Devolver `None` e o caso normal.
///
/// Existe pelo mesmo motivo de `servidor_do_ambiente`, e pelo mesmo tipo de
/// dor: os roteiros que dirigem duas janelas reais preenchiam o apelido
/// clicando numa coordenada da tela de entrada. Coordenada de clique quebra
/// quando o layout muda de altura — e a tela de entrada acabou de virar um
/// portal de conta, com aba, mascote e medidor de senha. Uma variavel de
/// ambiente nao tem altura.
#[tauri::command]
fn apelido_do_ambiente() -> Option<String> {
    std::env::var("CALL_APELIDO").ok().filter(|s| !s.is_empty())
}

/// Fonte unica para o numero mostrado pela interface. Ler os metadados do
/// executavel evita que um texto esquecido no JavaScript anuncie uma versao
/// diferente daquela que o atualizador realmente compara.
#[tauri::command]
fn versao_do_aplicativo(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// O que a interface precisa saber de uma versao nova: o numero, e o texto
/// das notas que o publicador escreveu no manifesto (`latest.json`). As notas
/// viajam do plugin para ca no campo `body` — e o que o cartao "Ver o que ha
/// de novo" mostra antes de alguem decidir atualizar.
#[derive(serde::Serialize)]
struct Atualizacao {
    versao: String,
    notas: Option<String>,
}

/// Consulta o servidor de atualizacao e devolve a versao nova, se houver.
/// Devolver `None` e o caso normal: significa que ja estamos em dia.
#[tauri::command]
async fn procurar_atualizacao(app: tauri::AppHandle) -> Result<Option<Atualizacao>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let achado = app
        .updater()
        .map_err(|erro| erro.to_string())?
        .check()
        .await
        .map_err(|erro| erro.to_string())?;

    Ok(achado.map(|atualizacao| Atualizacao {
        versao: atualizacao.version,
        notas: atualizacao.body,
    }))
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

/// Atalho global de mudo, guardado como string de aceleração
/// (`"Ctrl+Shift+KeyM"`) para poder desregistrar antes de trocar por outro.
#[derive(Default)]
struct AtalhoMudo(Mutex<Option<String>>);

/// Verdadeiro só entre o clique em "Sair" no ícone da bandeja e o
/// fechamento de fato. É o que diferencia esse fechamento do clique no X da
/// janela, que deve minimizar para a bandeja, não encerrar o aplicativo.
#[derive(Default)]
struct SaindoDeVerdade(AtomicBool);

/// Troca o atalho global de mutar/desmutar. `None` só desliga o anterior.
///
/// Precisa ser *global* — não um `keydown` na interface — porque o pedido é
/// que funcione com a janela sem foco ou escondida na bandeja, os dois casos
/// em que um `keydown` da própria página nunca dispara.
#[tauri::command]
fn definir_atalho_mudo(
    app: tauri::AppHandle,
    estado: State<'_, AtalhoMudo>,
    atalho: Option<String>,
) -> Result<(), String> {
    let mut atual = estado
        .0
        .lock()
        .map_err(|_| "Estado interno inconsistente.".to_string())?;

    if let Some(anterior) = atual.take() {
        let _ = app.global_shortcut().unregister(anterior.as_str());
    }

    if let Some(novo) = atalho {
        app.global_shortcut()
            .on_shortcut(novo.as_str(), |app, _atalho, evento| {
                if evento.state == ShortcutState::Pressed {
                    let _ = app.emit("atalho-mudo", ());
                }
            })
            .map_err(|_| "Esse atalho já está em uso por outro programa.".to_string())?;
        *atual = Some(novo);
    }

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

    let app = janela.app_handle().clone();
    let _ = janela.with_webview(move |webview| unsafe {
        let Ok(nucleo) = webview.controller().CoreWebView2() else {
            return;
        };
        // O WebView2 reproduz o áudio em processos próprios. A captura de som
        // da tela usa este pid como raiz da árvore a excluir, para não mandar
        // as vozes da chamada de volta aos participantes.
        let mut processo = 0u32;
        if nucleo.BrowserProcessId(&mut processo).is_ok() {
            app.state::<AudioAtivo>().definir_processo_webview(processo);
        }
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
            mostrar_janela_principal(app);
        }));
    }

    let app = construtor
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;

            app.manage(Hospedagem::default());
            app.manage(Convite::default());
            app.manage(AudioAtivo::default());
            app.manage(AtalhoMudo::default());
            app.manage(SaindoDeVerdade::default());

            // Canal de controle local (ver `controle.rs`). Sobe cedo, e sem poder
            // derrubar a partida: quem nao tem o SLATE instalado nunca precisa
            // saber que ele existe.
            let controle = std::sync::Arc::new(controle::Controle::default());
            app.manage(controle.clone());
            controle::iniciar(app.handle(), controle);

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

            // Ícone na bandeja: é o que permite ao aplicativo continuar vivo
            // (e o atalho de mudo continuar valendo) depois que a janela
            // fecha — ver o tratamento de `CloseRequested` mais abaixo.
            let abrir = MenuItem::with_id(app, "abrir", "Abrir CALL", true, None::<&str>)?;
            let sair = MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&abrir, &sair])?;

            TrayIconBuilder::with_id("call-bandeja")
                .tooltip("CALL")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, evento| match evento.id.as_ref() {
                    "abrir" => mostrar_janela_principal(app),
                    "sair" => {
                        app.state::<SaindoDeVerdade>().0.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, evento| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = evento
                    {
                        mostrar_janela_principal(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|janela, evento| {
            // O X da janela minimiza para a bandeja, não encerra — do jeito
            // que o Discord e a maioria dos apps de chamada se comportam.
            // Fechar de verdade só acontece pelo "Sair" da bandeja, que marca
            // `SaindoDeVerdade` antes de pedir o fechamento.
            if let tauri::WindowEvent::CloseRequested { api, .. } = evento {
                let app = janela.app_handle();
                if !app.state::<SaindoDeVerdade>().0.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = janela.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            hospedar,
            encerrar_hospedagem,
            convite_pendente,
            servidor_do_ambiente,
            apelido_do_ambiente,
            versao_do_aplicativo,
            procurar_atualizacao,
            instalar_atualizacao,
            definir_atalho_mudo,
            controle::anotar_estado_de_controle,
            google::google_autenticar,
            tela::iniciar_audio_da_tela,
            tela::parar_audio_da_tela,
            atividade::atividade_em_foco,
            atividade::atividade_ainda_aberta,
            resumo::resumo_de_atividade
        ])
        .build(tauri::generate_context!())
        .expect("Falha ao iniciar a aplicação.");

    // O servidor hospedado e um processo separado: sem isto ele sobreviveria
    // ao fechamento da janela e manteria a porta ocupada.
    app.run(|app, evento| {
        if let RunEvent::Exit = evento {
            app.state::<Hospedagem>().encerrar();
            controle::esquecer_descoberta();
            let _ = tela::parar_audio_da_tela(app.state::<AudioAtivo>());
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
