// Roda sem janela de console: o servidor e iniciado pelo proprio aplicativo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Servidor do CALL.
//!
//! Faz tres coisas, e nenhuma delas e tocar em midia:
//!
//! 1. Guarda a estrutura dos grupos (categorias, canais) e o historico dos
//!    canais de texto.
//! 2. Encaminha ofertas/respostas/ICE entre quem esta no mesmo canal de voz.
//!    O audio e o video trafegam ponto a ponto entre os participantes.
//! 3. Guarda contas — e-mail, senha, perfil e a lista de grupos —, para que
//!    trocar de computador nao signifique virar outra pessoa. Ver `contas.rs`.
//!
//! O mesmo binario atende os dois modos de uso: hospedado na internet, com
//! uma pasta de dados, ou como sidecar na maquina de quem hospeda uma
//! conversa na rede local, sem pasta nenhuma e sem memoria entre execucoes.

mod contas;
mod google;
mod modelo;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use contas::Cofre;
use modelo::{agora_ms, novo_codigo, novo_id, Acervo, Canal, Categoria, Grupo, TipoCanal};

type Fila = UnboundedSender<Message>;

const APELIDO_MAX: usize = 24;
const NOME_MAX: usize = 40;
const TEXTO_MAX: usize = 2000;
/// Uma linha sobre a pessoa. O servidor nao le isto, so repassa — o teto e o
/// que impede um cliente adulterado de empurrar um romance para dentro do
/// cartao de perfil de todo mundo no grupo.
const BIO_MAX: usize = 160;
/// Identificador do mascote. O servidor de proposito **nao** conhece a lista:
/// mascote e assunto da interface, e uma versao nova do aplicativo com um
/// setimo desenho nao pode depender de o servidor hospedado ser atualizado
/// junto. Quem nao reconhece o identificador desenha as iniciais.
const AVATAR_MAX: usize = 24;
/// Nome do aplicativo em uso. O servidor nao interpreta este texto — ele so o
/// repassa —, entao o teto e o que impede um cliente adulterado de empurrar
/// um romance para dentro da lista de participantes de todo mundo.
const ATIVIDADE_MAX: usize = 40;

/// Teto de mensagens por janela. Nao e defesa contra um atacante dedicado —
/// e o que impede um cliente com defeito de encher o disco de quem hospeda.
const MENSAGENS_POR_JANELA: u32 = 20;
const JANELA_MS: u64 = 10_000;

/// O que a pessoa apresenta ao grupo. Viaja na saudacao, vive enquanto a
/// conexao viver, e some com ela.
///
/// Quem entra **sem conta** continua como sempre foi: o `usuario` e um numero
/// que o proprio cliente sorteou e guarda, e o perfil e o que ele disser que
/// e — o servidor nao tem como conferir, e nao finge que tem.
///
/// Quem entra **com conta** traz um token, e ai o `usuario` deixa de ser
/// palavra do cliente: e o identificador da conta, resolvido pelo servidor.
/// E a diferenca entre "eu digo que sou a Ana" e "eu provei que sou a Ana".
#[derive(Clone)]
struct Cartao {
    usuario: String,
    apelido: String,
    avatar: String,
    bio: String,
    /// Conta a que esta conexao pertence, quando o token da saudacao valeu.
    conta: Option<String>,
}

impl Cartao {
    /// Le e recorta o cartao de uma mensagem do cliente. Recortar aqui, e nao
    /// so na interface, e o que vale: a interface e do outro lado da rede.
    ///
    /// O cofre entra para resolver o token. Com o backend de arquivo isso e
    /// so leitura de tabela; com Postgres e uma ida ao banco — por isso o
    /// metodo e assincrono, e por isso quem chama nao pode estar com nenhuma
    /// tranca de `Estado` na mao neste instante.
    async fn ler(v: &Value, cofre: &Cofre) -> Self {
        let token = texto_de(v, "token");
        let conta = if token.is_empty() {
            None
        } else {
            cofre.conta_do_token(&token).await.map(|c| c.id)
        };

        Cartao {
            usuario: match &conta {
                Some(id) => id.clone(),
                None => identidade(v),
            },
            apelido: limitar(texto_de(v, "apelido"), APELIDO_MAX, "Convidado"),
            avatar: texto_de(v, "avatar")
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
                .take(AVATAR_MAX)
                .collect(),
            bio: texto_de(v, "bio").trim().chars().take(BIO_MAX).collect(),
            conta,
        }
    }
}

#[derive(Clone)]
struct Conexao {
    id: u64,
    usuario: String,
    apelido: String,
    /// Identificador do mascote escolhido, ou vazio para as iniciais.
    avatar: String,
    /// Uma linha sobre a pessoa, mostrada no cartao de perfil dela.
    bio: String,
    /// Conta que esta conexao provou ser, ou `None` para quem entrou sem
    /// conta. E o que autoriza gravar o perfil e a lista de grupos.
    conta: Option<String>,
    grupo: Option<String>,
    canal_voz: Option<String>,
    fila: Fila,
    mudo: bool,
    transmitindo: bool,
    /// Aplicativo em primeiro plano na maquina da pessoa, quando ela escolhe
    /// mostrar. Fica na conexao, e nao no acervo: e estado do momento e nao
    /// deve sobreviver a quem o produziu.
    atividade: Option<String>,
}

impl Conexao {
    fn resumo(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "usuario": self.usuario,
            "apelido": self.apelido,
            "avatar": self.avatar,
            "bio": self.bio,
            "canalVoz": self.canal_voz,
            "mudo": self.mudo,
            "transmitindo": self.transmitindo,
            "atividade": self.atividade
        })
    }
}

/// Grupos, mensagens e quem esta conectado agora. As contas moram fora
/// daqui, em `Cofre` — ver a nota em `main()` sobre o porque dos dois
/// trancados separadamente.
struct Estado {
    conexoes: HashMap<u64, Conexao>,
    acervo: Acervo,
}

impl Estado {
    fn do_grupo(&self, codigo: &str) -> Vec<Conexao> {
        self.conexoes
            .values()
            .filter(|c| c.grupo.as_deref() == Some(codigo))
            .cloned()
            .collect()
    }

    /// Quem esta no mesmo canal de voz — a malha WebRTC e formada aqui, e nao
    /// no grupo inteiro: estar no mesmo servidor nao e estar na mesma conversa.
    fn na_voz(&self, canal: &str) -> Vec<Conexao> {
        self.conexoes
            .values()
            .filter(|c| c.canal_voz.as_deref() == Some(canal))
            .cloned()
            .collect()
    }

    fn difundir(&self, codigo: &str, aviso: &Value, exceto: Option<u64>) {
        for c in self.do_grupo(codigo) {
            if Some(c.id) != exceto {
                let _ = c.fila.send(texto_json(aviso));
            }
        }
    }
}

static PROXIMO_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() {
    // A porta vem do argumento (sidecar) ou de PORT (servicos de hospedagem
    // atribuem a porta ao processo, nao o contrario).
    let porta = std::env::args()
        .nth(1)
        .and_then(|a| a.parse::<u16>().ok())
        .or_else(|| std::env::var("PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(8787);

    let pasta = std::env::var("DADOS").ok().map(PathBuf::from);

    let escuta = match TcpListener::bind(("0.0.0.0", porta)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sinalizacao] falha ao abrir a porta {porta}: {e}");
            std::process::exit(1);
        }
    };

    println!("[sinalizacao] pronto em ws://0.0.0.0:{porta}");

    if google::disponivel() {
        println!("[contas] entrar com o Google: ligado");
    }

    // Duas trancas, e nao uma, de proposito. `Estado` (grupos, mensagens,
    // quem esta conectado) muda a cada mensagem de voz e precisa de acesso
    // sincrono e barato. `Cofre` (contas) pode, com Postgres, esperar a rede
    // — e segurar `Estado` durante essa espera pararia o encaminhamento de
    // voz de todo mundo por causa de um cadastro de outra pessoa.
    let cofre = Arc::new(Cofre::carregar(pasta.clone()).await);
    let estado = Arc::new(Mutex::new(Estado {
        conexoes: HashMap::new(),
        acervo: Acervo::carregar(pasta),
    }));

    loop {
        // Um erro de accept costuma ser transitorio (descritor esgotado, par
        // que desistiu antes do handshake). Derrubar o laco mataria o servidor
        // em silencio, ja que ele roda sem console.
        let fluxo = match escuta.accept().await {
            Ok((fluxo, _)) => fluxo,
            Err(e) => {
                eprintln!("[sinalizacao] accept falhou: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };

        let estado = estado.clone();
        let cofre = cofre.clone();
        tokio::spawn(async move {
            if let Err(e) = atender(fluxo, estado, cofre).await {
                eprintln!("[sinalizacao] conexao encerrada: {e}");
            }
        });
    }
}

/// Cabecalho HTTP maior que isto e recusado. Um aperto de mao de WebSocket de
/// navegador, ja acrescido dos `X-Forwarded-*` que um proxy de hospedagem
/// insere, fica na casa de 1 KB; 8 KB e o limite usual dos servidores HTTP.
const CABECALHO_MAX: usize = 8192;

/// Servicos de hospedagem verificam a saude do processo com um GET comum.
/// O aperto de mao do WebSocket recusaria esse GET, e o servico concluiria
/// que o servidor esta morto. Respondemos a ele antes de entregar o fluxo ao
/// WebSocket — sem consumir nada, para o aperto de mao seguir intacto.
///
/// A decisao so pode ser tomada com o bloco de cabecalhos inteiro em maos.
/// Espiar uma janela curta parece equivalente e nao e: `Upgrade` nao tem
/// posicao fixa, vem depois do `User-Agent` (que num navegador e longo), e um
/// proxy ainda empurra tudo para baixo com os cabecalhos que acrescenta. Um
/// aperto de mao de navegador atras de proxy passava de 512 bytes sem que o
/// `Upgrade` aparecesse na janela — e era servido como se fosse um GET comum,
/// fechando a conexao com o codigo 1006 do lado do cliente.
async fn responder_se_for_http(fluxo: &TcpStream) -> Result<bool, String> {
    let mut espiada = vec![0u8; CABECALHO_MAX];

    for _ in 0..200 {
        // `peek` nao consome: o aperto de mao do WebSocket relera os mesmos
        // bytes logo em seguida.
        let lidos = match fluxo.peek(&mut espiada).await {
            Ok(0) => return Err("conexao fechada antes do pedido".into()),
            Ok(n) => n,
            Err(e) => return Err(e.to_string()),
        };

        let visto = String::from_utf8_lossy(&espiada[..lidos]).to_lowercase();

        // Com o bloco inteiro em maos a resposta e definitiva.
        if let Some(fim) = visto.find("\r\n\r\n") {
            return Ok(!visto[..fim].contains("upgrade: websocket"));
        }

        // Sem o fim do bloco, so uma resposta e segura: achar o Upgrade prova
        // que e WebSocket. Nao acha-lo ainda nao prova nada.
        if visto.contains("upgrade: websocket") {
            return Ok(false);
        }

        if lidos >= CABECALHO_MAX {
            return Ok(true);
        }

        // O cabecalho chegou pela metade. `peek` devolveria os mesmos bytes na
        // hora, entao esperar um instante e o que evita girar em falso.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    Ok(true)
}

async fn atender(mut fluxo: TcpStream, estado: Arc<Mutex<Estado>>, cofre: Arc<Cofre>) -> Result<(), String> {
    let _ = fluxo.set_nodelay(true);

    if responder_se_for_http(&fluxo).await? {
        use tokio::io::AsyncWriteExt;
        let corpo = "CALL: servidor de sinalizacao no ar.";
        let resposta = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
            corpo.len()
        );
        let _ = fluxo.write_all(resposta.as_bytes()).await;
        let _ = fluxo.shutdown().await;
        return Ok(());
    }

    let ws = tokio_tungstenite::accept_async(fluxo)
        .await
        .map_err(|e| e.to_string())?;
    let (mut escritor, mut leitor) = ws.split();

    let (fila, mut receptor) = unbounded_channel::<Message>();

    // Bombeia a fila de saida em uma tarefa propria para que o relay
    // entre participantes nunca bloqueie o laco de leitura.
    let envio = tokio::spawn(async move {
        while let Some(msg) = receptor.recv().await {
            if escritor.send(msg).await.is_err() {
                break;
            }
        }
    });

    let id = PROXIMO_ID.fetch_add(1, Ordering::Relaxed);
    let mut janela_inicio = agora_ms();
    let mut enviadas_na_janela = 0u32;
    let mut pedidos_de_conta = 0u32;

    while let Some(Ok(msg)) = leitor.next().await {
        let texto = match msg {
            Message::Text(t) => t,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };

        let Ok(v) = serde_json::from_str::<Value>(&texto) else {
            continue;
        };

        let agora = agora_ms();
        if agora.saturating_sub(janela_inicio) > JANELA_MS {
            janela_inicio = agora;
            enviadas_na_janela = 0;
        }

        let tipo = v.get("tipo").and_then(Value::as_str).unwrap_or("");
        if tipo == "mensagem" {
            enviadas_na_janela += 1;
            if enviadas_na_janela > MENSAGENS_POR_JANELA {
                let _ = fila.send(erro("Muitas mensagens em pouco tempo."));
                continue;
            }
        }

        // Cadastro e login precisam de Argon2 (e, com Postgres, de rede), e
        // nao podem acontecer com `Estado` trancado nem dentro deste laco
        // sem controle de repeticao. Por isso saem daqui, e nao de `tratar`.
        if e_pedido_de_conta(tipo) {
            pedidos_de_conta += 1;
            // Um cliente honesto faz um punhado destes por conexao. Passar
            // muito disso e alguem varrendo senhas — e cada tentativa custa
            // Argon2 do lado de ca.
            if pedidos_de_conta > PEDIDOS_DE_CONTA_MAX {
                let _ = fila.send(recusa("senha", "Tentativas demais nesta conexão."));
                continue;
            }
            atender_conta(tipo, &v, &fila, &cofre).await;
            continue;
        }

        tratar(tipo, &v, id, &fila, &estado, &cofre).await;
    }

    despedir(id, &estado);
    envio.abort();
    Ok(())
}

async fn tratar(tipo: &str, v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    match tipo {
        "criar-grupo" => criar_grupo(v, id, fila, estado, cofre).await,
        "entrar" => entrar(v, id, fila, estado, cofre).await,
        "entrar-voz" => entrar_voz(v, id, fila, estado),
        "sair-voz" => sair_voz(id, estado),
        "sinal" => sinal(v, id, estado),
        "estado" => estado_de_midia(v, id, estado),
        "perfil" => perfil(v, id, estado, cofre).await,
        "mensagem" => mensagem(v, id, fila, estado),
        "historico" => historico(v, id, fila, estado),
        "criar-categoria" => criar_categoria(v, id, fila, estado),
        "criar-canal" => criar_canal(v, id, fila, estado),
        "renomear" => renomear(v, id, fila, estado),
        "remover" => remover(v, id, fila, estado),
        "guardar" => guardar(v, fila, cofre).await,
        _ => {}
    }
}

// ----------------------------------------------------------------- contas

/// Teto de pedidos de conta por conexao. Generoso para quem erra a senha e
/// tenta de novo, apertado para quem esta varrendo.
const PEDIDOS_DE_CONTA_MAX: u32 = 30;

fn e_pedido_de_conta(tipo: &str) -> bool {
    matches!(
        tipo,
        "cadastrar" | "entrar-conta" | "retomar" | "sair-conta" | "google-config" | "google-entrar"
    )
}

async fn atender_conta(tipo: &str, v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    match tipo {
        "cadastrar" => cadastrar(v, fila, cofre).await,
        "entrar-conta" => entrar_conta(v, fila, cofre).await,
        "retomar" => retomar(v, fila, cofre).await,
        "sair-conta" => sair_conta(v, fila, cofre).await,
        "google-config" => {
            let _ = fila.send(texto_json(&json!({
                "tipo": "google",
                "disponivel": google::disponivel(),
                "clienteId": google::cliente_id().unwrap_or_default()
            })));
        }
        "google-entrar" => google_entrar(v, fila, cofre).await,
        _ => {}
    }
}

/// Calcula o hash longe do laco de eventos. Argon2 gasta 19 MB e dezenas de
/// milissegundos de CPU: feito aqui dentro, cada login pararia o
/// encaminhamento de voz de todo mundo pelo tempo da conta.
async fn em_paralelo<F, T>(trabalho: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(trabalho).await.ok()
}

async fn cadastrar(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let email = match contas::normalizar_email(&texto_de(v, "email")) {
        Ok(e) => e,
        Err(r) => return recusar(fila, r),
    };
    let senha = texto_de(v, "senha");
    if let Err(r) = contas::conferir_senha_nova(&senha) {
        return recusar(fila, r);
    }

    let apelido = limitar(texto_de(v, "apelido"), APELIDO_MAX, "");
    if apelido.is_empty() {
        return recusar(
            fila,
            contas::Recusa {
                campo: "apelido",
                motivo: "Escolha como querem te chamar.".into(),
            },
        );
    }

    // Conferido antes de gastar o Argon2 — poupa a CPU de um pedido que ja se
    // sabe recusado. O cofre confere de novo por dentro, na hora de gravar:
    // duas pessoas podem pedir o mesmo e-mail enquanto o hash rodava, e so
    // ali a resposta e definitiva.
    if cofre.email_ocupado(&email).await {
        return recusar(
            fila,
            contas::Recusa {
                campo: "email",
                motivo: "Já existe uma conta com este e-mail.".into(),
            },
        );
    }

    let Some(Ok(hash)) = em_paralelo(move || contas::cifrar(&senha)).await else {
        let _ = fila.send(erro("Não foi possível criar a conta agora."));
        return;
    };

    // O mascote e a bio ja vem escolhidos: o cadastro e uma tela so, e nao
    // um formulario seguido de "agora monte seu perfil".
    let avatar: String = texto_de(v, "avatar").chars().take(AVATAR_MAX).collect();
    let bio: String = texto_de(v, "bio").trim().chars().take(BIO_MAX).collect();

    match cofre.cadastrar(email, hash, apelido, avatar, bio).await {
        Ok(id) => responder_sessao(cofre, &id, fila).await,
        Err(r) => recusar(fila, r),
    }
}

async fn entrar_conta(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    // O e-mail e normalizado, mas um erro de forma aqui nao merece a licao de
    // gramatica do cadastro: quem esta entrando ou acerta a conta que tem, ou
    // nao tem conta — e as duas respostas sao a mesma.
    let email = contas::normalizar_email(&texto_de(v, "email")).unwrap_or_default();
    let senha = texto_de(v, "senha");

    let restante = cofre.castigo_restante(&email);
    if restante > 0 {
        let minutos = (restante / 60_000) + 1;
        return recusar(
            fila,
            contas::Recusa {
                campo: "senha",
                motivo: format!("Muitas tentativas. Tente de novo em {minutos} minuto(s)."),
            },
        );
    }

    // Um e-mail sem conta segue o mesmo caminho, com hash vazio: e
    // `contas::conferir` quem gasta o mesmo tempo dos outros, para que o
    // relogio nao conte a ninguem quais e-mails existem aqui.
    let (id, hash) = cofre.hash_de(&email).await.unwrap_or((String::new(), String::new()));

    let confere = em_paralelo(move || contas::conferir(&senha, &hash)).await.unwrap_or(false);

    if !confere || id.is_empty() {
        cofre.anotar_falha(&email);
        return recusar(
            fila,
            contas::Recusa {
                campo: "senha",
                motivo: "E-mail ou senha incorretos.".into(),
            },
        );
    }

    cofre.perdoar(&email);
    responder_sessao(cofre, &id, fila).await;
}

/// Token guardado no computador de quem volta. E o que faz o CALL abrir
/// direto na lista de grupos em vez de pedir a senha toda manha.
async fn retomar(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let token = texto_de(v, "token");

    let Some(conta) = cofre.conta_do_token(&token).await else {
        // Nao e erro: e a resposta honesta a "esta sessao ainda vale?".
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "sessao",
        "token": token,
        "conta": conta.resumo()
    })));
}

async fn sair_conta(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    cofre.fechar_sessao(&texto_de(v, "token")).await;
    let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
}

async fn google_entrar(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let identidade = google::trocar_codigo(
        &texto_de(v, "codigo"),
        &texto_de(v, "verificador"),
        &texto_de(v, "redirecionamento"),
    )
    .await;

    let identidade = match identidade {
        Ok(i) => i,
        Err(motivo) => {
            return recusar(
                fila,
                contas::Recusa {
                    campo: "google",
                    motivo,
                },
            )
        }
    };

    // O Google devolve o nome completo; o CALL mostra um apelido de 24
    // caracteres numa coluna estreita. "Maria Fernanda Albuquerque" vira
    // "Maria" — trocavel no perfil, e melhor que truncado.
    let apelido = limitar(
        identidade.nome.split_whitespace().next().unwrap_or_default().to_string(),
        APELIDO_MAX,
        "Convidado",
    );
    let email = contas::normalizar_email(&identidade.email).unwrap_or(identidade.email);

    let id = cofre.pelo_google(&identidade.sub, &email, &apelido, "").await;
    responder_sessao(cofre, &id, fila).await;
}

/// Perfil e lista de grupos gravados na conta. E o que a conta promete: o
/// mesmo apelido, o mesmo mascote e os mesmos grupos num computador novo.
async fn guardar(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let token = texto_de(v, "token");

    let Some(id) = cofre.conta_do_token(&token).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    let campo_opcional = |nome: &str| v.get(nome).and_then(Value::as_str);
    let atalhos = v.get("atalhos").and_then(Value::as_array).map(|lista| {
        lista
            .iter()
            .filter_map(|a| {
                let codigo = texto_de(a, "codigo");
                // Um codigo tem dez caracteres do alfabeto do convite. Filtrar
                // aqui evita que um cliente com defeito encha a conta de lixo
                // que ninguem consegue abrir depois.
                (codigo.len() == 10 && codigo.chars().all(|c| c.is_ascii_alphanumeric())).then(
                    || contas::Atalho {
                        codigo,
                        nome: limitar(texto_de(a, "nome"), NOME_MAX, "Grupo"),
                    },
                )
            })
            .take(ATALHOS_MAX)
            .collect()
    });

    cofre
        .guardar_perfil(
            &id,
            campo_opcional("apelido").map(|t| limitar(t.to_string(), APELIDO_MAX, "")),
            campo_opcional("avatar").map(|t| t.chars().take(AVATAR_MAX).collect()),
            campo_opcional("bio").map(|t| t.trim().chars().take(BIO_MAX).collect()),
            atalhos,
        )
        .await;

    if let Some(conta) = cofre.por_id(&id).await {
        let _ = fila.send(texto_json(&json!({ "tipo": "conta", "conta": conta.resumo() })));
    }
}

/// Quantos grupos cabem numa conta. A coluna da esquerda nao rola bem alem
/// disso, e o teto e o que impede um cliente adulterado de crescer a conta
/// sem limite.
const ATALHOS_MAX: usize = 60;

async fn responder_sessao(cofre: &Cofre, id: &str, fila: &Fila) {
    let token = cofre.abrir_sessao(id).await;
    let Some(conta) = cofre.por_id(id).await else {
        let _ = fila.send(erro("Conta não encontrada."));
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "sessao",
        "token": token,
        "conta": conta.resumo()
    })));
}

fn recusar(fila: &Fila, r: contas::Recusa) {
    let _ = fila.send(recusa(r.campo, &r.motivo));
}

/// Diferente de `erro`: leva o campo em que a interface deve pintar o
/// problema. Um "senha incorreta" mostrado como aviso passageiro no canto da
/// tela e um aviso; mostrado embaixo do campo da senha, e uma resposta.
fn recusa(campo: &str, motivo: &str) -> Message {
    texto_json(&json!({ "tipo": "recusa", "campo": campo, "motivo": motivo }))
}

// ---------------------------------------------------------------- entrada

async fn criar_grupo(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "Meu grupo");

    // O token e resolvido antes de tocar em `Estado`: com Postgres isto pode
    // esperar a rede, e essa espera nao pode acontecer com a tranca de todo
    // mundo na mao.
    let cartao = Cartao::ler(v, cofre).await;

    // Confere duplicata cedo, antes de gastar as idas ao cofre — poupa
    // trabalho no caso comum. A checagem que vale, porque so ela acontece
    // sem intervalo, e a de dentro do lock final, mais abaixo.
    if estado.lock().unwrap().conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }

    // O codigo nasce aqui, antes do grupo existir em `Estado`: e o que
    // permite gravar o grupo na conta e ja ter o resumo atualizado em maos
    // quando o "bem-vindo" for montado, sem uma segunda volta ao cofre.
    let codigo = novo_codigo();
    let conta_resumo = sincronizar_conta_e_buscar_resumo(cofre, &cartao, &codigo, &nome).await;

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }

    let grupo = Grupo::novo(codigo.clone(), nome, cartao.usuario.clone());
    e.acervo.grupos.insert(codigo.clone(), grupo);
    e.acervo.salvar_grupos();

    admitir(&mut e, id, cartao, &codigo, fila, conta_resumo);
}

async fn entrar(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let codigo = texto_de(v, "codigo").trim().to_uppercase();
    let cartao = Cartao::ler(v, cofre).await;

    // Primeira olhada: confirma que da para entrar e pega o nome do grupo,
    // sem alterar nada ainda. A checagem que vale acontece de novo depois,
    // ja com a conta atualizada — o grupo poderia, em tese, ter sido
    // removido nesse meio tempo.
    let nome_do_grupo = {
        let e = estado.lock().unwrap();
        if e.conexoes.contains_key(&id) {
            let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
            return;
        }
        match e.acervo.grupos.get(&codigo) {
            Some(g) => g.nome.clone(),
            None => {
                let _ = fila.send(erro("Convite invalido ou grupo removido."));
                return;
            }
        }
    };

    let conta_resumo = sincronizar_conta_e_buscar_resumo(cofre, &cartao, &codigo, &nome_do_grupo).await;

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }
    if !e.acervo.grupos.contains_key(&codigo) {
        let _ = fila.send(erro("Convite invalido ou grupo removido."));
        return;
    }

    admitir(&mut e, id, cartao, &codigo, fila, conta_resumo);
}

/// Grava o grupo e o perfil atuais na conta (quando ha conta) e devolve o
/// resumo ja atualizado, pronto para embutir no "bem-vindo".
///
/// Espera terminar de proposito, em vez de rodar em segundo plano: a
/// resposta a pessoa precisa trazer o grupo que ela acabou de entrar — sem
/// isso, a coluna da esquerda so mostraria o grupo novo depois de uma
/// reconexao, e "entrar num grupo" pareceria ter falhado pela metade.
async fn sincronizar_conta_e_buscar_resumo(
    cofre: &Cofre,
    cartao: &Cartao,
    codigo: &str,
    nome_do_grupo: &str,
) -> Option<Value> {
    let conta = cartao.conta.as_ref()?;
    cofre.lembrar_grupo(conta, codigo, nome_do_grupo).await;
    cofre
        .guardar_perfil(
            conta,
            Some(cartao.apelido.clone()),
            Some(cartao.avatar.clone()),
            Some(cartao.bio.clone()),
            None,
        )
        .await;
    cofre.por_id(conta).await.map(|c| c.resumo())
}

/// Registra a conexao no grupo, entrega o estado inteiro a ela e anuncia a
/// chegada aos demais.
///
/// So mexe em `Estado` — nenhuma chamada ao cofre aqui dentro, de proposito:
/// esta funcao roda com a tranca de `Estado` na mao, e o cofre pode precisar
/// de rede. `conta_resumo` chega ja pronto, buscado por quem chamou antes de
/// trancar.
fn admitir(e: &mut Estado, id: u64, cartao: Cartao, codigo: &str, fila: &Fila, conta_resumo: Option<Value>) {
    let nova = Conexao {
        id,
        usuario: cartao.usuario,
        apelido: cartao.apelido,
        avatar: cartao.avatar,
        bio: cartao.bio,
        conta: cartao.conta,
        grupo: Some(codigo.to_string()),
        canal_voz: None,
        fila: fila.clone(),
        mudo: false,
        transmitindo: false,
        atividade: None,
    };

    let presentes: Vec<Value> = e.do_grupo(codigo).iter().map(Conexao::resumo).collect();
    let grupo = e.acervo.grupos.get(codigo).cloned();

    let aviso = json!({ "tipo": "entrou", "membro": nova.resumo() });
    e.difundir(codigo, &aviso, None);

    let _ = fila.send(texto_json(&json!({
        "tipo": "bem-vindo",
        "eu": nova.resumo(),
        "grupo": grupo,
        "presentes": presentes,
        "conta": conta_resumo
    })));

    e.conexoes.insert(id, nova);
}

fn despedir(id: u64, estado: &Arc<Mutex<Estado>>) {
    let mut e = estado.lock().unwrap();
    let Some(saindo) = e.conexoes.remove(&id) else {
        return;
    };
    let Some(codigo) = saindo.grupo.clone() else {
        return;
    };

    // Quem estava na mesma voz precisa desmontar o elo WebRTC; o resto do
    // grupo so precisa parar de ver a pessoa na lista.
    if let Some(canal) = &saindo.canal_voz {
        let aviso = json!({ "tipo": "saiu-voz", "id": id.to_string(), "canal": canal });
        for c in e.na_voz(canal) {
            let _ = c.fila.send(texto_json(&aviso));
        }
    }

    let aviso = json!({ "tipo": "saiu", "id": id.to_string() });
    e.difundir(&codigo, &aviso, None);
}

// -------------------------------------------------------------------- voz

fn entrar_voz(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let mut e = estado.lock().unwrap();

    let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) else {
        return;
    };
    let valido = e
        .acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Voz)
        .unwrap_or(false);
    if !valido {
        let _ = fila.send(erro("Canal de voz inexistente."));
        return;
    }

    // Sair da voz anterior antes de entrar na nova: ninguem fala em duas
    // salas ao mesmo tempo, e o elo antigo precisa ser desfeito dos dois lados.
    largar_voz(&mut e, id);

    let pares: Vec<Value> = e.na_voz(&canal).iter().map(Conexao::resumo).collect();
    if let Some(c) = e.conexoes.get_mut(&id) {
        c.canal_voz = Some(canal.clone());
    }

    let Some(eu) = e.conexoes.get(&id).cloned() else {
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "voz",
        "canal": canal,
        "pares": pares
    })));

    let aviso = json!({ "tipo": "entrou-voz", "membro": eu.resumo(), "canal": canal });
    e.difundir(&codigo, &aviso, Some(id));
}

fn sair_voz(id: u64, estado: &Arc<Mutex<Estado>>) {
    let mut e = estado.lock().unwrap();
    largar_voz(&mut e, id);
}

fn largar_voz(e: &mut Estado, id: u64) {
    let Some(anterior) = e.conexoes.get(&id).and_then(|c| c.canal_voz.clone()) else {
        return;
    };
    if let Some(c) = e.conexoes.get_mut(&id) {
        c.canal_voz = None;
        c.transmitindo = false;
    }

    let aviso = json!({ "tipo": "saiu-voz", "id": id.to_string(), "canal": anterior });
    if let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) {
        e.difundir(&codigo, &aviso, Some(id));
    }
}

fn sinal(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let Some(destino) = v
        .get("para")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u64>().ok())
    else {
        return;
    };

    let e = estado.lock().unwrap();
    // So encaminha entre quem esta no mesmo canal de voz. Sem esta checagem,
    // qualquer conexao poderia negociar midia com qualquer outra.
    let alvo = match (e.conexoes.get(&destino), e.conexoes.get(&id)) {
        (Some(a), Some(eu))
            if a.canal_voz.is_some() && a.canal_voz == eu.canal_voz =>
        {
            Some(a.fila.clone())
        }
        _ => None,
    };

    if let Some(f) = alvo {
        let _ = f.send(texto_json(&json!({
            "tipo": "sinal",
            "de": id.to_string(),
            "dados": v.get("dados").cloned().unwrap_or(Value::Null)
        })));
    }
}

fn estado_de_midia(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let mudo = v.get("mudo").and_then(Value::as_bool).unwrap_or(false);
    let transmitindo = v
        .get("transmitindo")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Ausente e "nao mostro nada", que e diferente de uma cadeia vazia vinda
    // de um cliente com defeito — os dois viram `None` e ninguem ve nada.
    let atividade = v
        .get("atividade")
        .and_then(Value::as_str)
        .map(|texto| texto.trim().chars().take(ATIVIDADE_MAX).collect::<String>())
        .filter(|texto| !texto.is_empty());

    let mut e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get_mut(&id) else {
        return;
    };
    eu.mudo = mudo;
    eu.transmitindo = transmitindo;
    eu.atividade = atividade.clone();
    let Some(codigo) = eu.grupo.clone() else {
        return;
    };

    let aviso = json!({
        "tipo": "estado",
        "de": id.to_string(),
        "mudo": mudo,
        "transmitindo": transmitindo,
        "atividade": atividade
    });
    e.difundir(&codigo, &aviso, Some(id));
}

/// Perfil trocado com o grupo ja em andamento. Sem isto, mudar o apelido, o
/// mascote ou a bio so valeria na proxima entrada, e os outros continuariam
/// vendo o perfil antigo pelo resto da sessao.
///
/// O `usuario` **nao** e relido aqui de proposito. Ele e o que atribui autoria
/// as mensagens e o que decide quem e o dono do grupo: aceitar uma troca dele
/// no meio da sessao seria deixar qualquer um se apresentar como outra pessoa
/// depois de ja ter sido admitido.
async fn perfil(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let cartao = Cartao::ler(v, cofre).await;

    let conta = {
        let mut e = estado.lock().unwrap();
        let Some(eu) = e.conexoes.get_mut(&id) else {
            return;
        };
        eu.apelido = cartao.apelido.clone();
        eu.avatar = cartao.avatar.clone();
        eu.bio = cartao.bio.clone();
        let conta = eu.conta.clone();
        let Some(codigo) = eu.grupo.clone() else {
            return;
        };

        let aviso = json!({
            "tipo": "perfil",
            "de": id.to_string(),
            "apelido": cartao.apelido.clone(),
            "avatar": cartao.avatar.clone(),
            "bio": cartao.bio.clone()
        });
        e.difundir(&codigo, &aviso, Some(id));
        conta
    };

    // Numa conexao com conta, mudar o perfil no meio da conversa e mudar o
    // perfil, e nao so o cracha desta sessao.
    if let Some(conta) = conta {
        cofre
            .guardar_perfil(&conta, Some(cartao.apelido), Some(cartao.avatar), Some(cartao.bio), None)
            .await;
    }
}

// ------------------------------------------------------------------ texto

fn mensagem(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let texto: String = texto_de(v, "texto").trim().chars().take(TEXTO_MAX).collect();
    if texto.is_empty() {
        return;
    }

    let mut e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get(&id).cloned() else {
        return;
    };
    let Some(codigo) = eu.grupo.clone() else { return };

    let valido = e
        .acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Texto)
        .unwrap_or(false);
    if !valido {
        let _ = fila.send(erro("Canal de texto inexistente."));
        return;
    }

    // Apelido e avatar sao gravados na mensagem, e nao buscados na hora de
    // ler: o historico e de quem escreveu naquele dia. Quem trocou de mascote
    // depois nao reescreve o passado, e quem nem esta no grupo agora continua
    // aparecendo como apareceu.
    let m = modelo::Mensagem {
        id: novo_id(),
        canal: canal.clone(),
        autor: eu.usuario.clone(),
        apelido: eu.apelido.clone(),
        avatar: eu.avatar.clone(),
        texto,
        em: agora_ms(),
    };

    e.acervo.registrar_mensagem(m.clone());

    // Inclusive de volta para quem escreveu: a mensagem so aparece na tela
    // depois de aceita pelo servidor, entao ninguem ve algo que nao foi
    // guardado.
    let aviso = json!({ "tipo": "mensagem", "mensagem": m });
    e.difundir(&codigo, &aviso, None);
}

fn historico(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let e = estado.lock().unwrap();
    let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) else {
        return;
    };
    if e.acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .is_none()
    {
        return;
    }

    let _ = fila.send(texto_json(&json!({
        "tipo": "historico",
        "canal": canal,
        "mensagens": e.acervo.historico(&canal)
    })));
}

// -------------------------------------------------------------- estrutura

/// Toda mudanca de estrutura passa por aqui: confere que quem pediu e o dono
/// do grupo, aplica a mudanca, salva e difunde a estrutura nova inteira.
/// Difundir o todo em vez de um delta custa alguns bytes numa acao rara e
/// elimina a chance de duas telas divergirem.
fn alterar_estrutura<F>(id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, mutacao: F)
where
    F: FnOnce(&mut Grupo) -> Result<Vec<String>, String>,
{
    let mut e = estado.lock().unwrap();
    let Some((codigo, usuario)) = e
        .conexoes
        .get(&id)
        .and_then(|c| c.grupo.clone().map(|g| (g, c.usuario.clone())))
    else {
        return;
    };
    let Some(grupo) = e.acervo.grupos.get_mut(&codigo) else {
        return;
    };

    // O convite abre a porta para conversar, nao para desmontar o grupo. Sem
    // esta checagem, qualquer pessoa com o codigo apagaria canais e historico.
    if grupo.dono != usuario {
        let _ = fila.send(erro("Só quem criou o grupo pode alterar seus canais."));
        return;
    }

    let canais_removidos = match mutacao(grupo) {
        Ok(removidos) => removidos,
        Err(motivo) => {
            let _ = fila.send(erro(&motivo));
            return;
        }
    };

    let copia = grupo.clone();
    e.acervo.esquecer_canais(&canais_removidos);
    e.acervo.salvar_grupos();

    // Quem estava numa voz que deixou de existir precisa ser retirado dela.
    if !canais_removidos.is_empty() {
        let orfaos: Vec<u64> = e
            .conexoes
            .values()
            .filter(|c| {
                c.canal_voz
                    .as_ref()
                    .is_some_and(|v| canais_removidos.contains(v))
            })
            .map(|c| c.id)
            .collect();
        for orfao in orfaos {
            largar_voz(&mut e, orfao);
        }
    }

    e.difundir(&codigo, &json!({ "tipo": "grupo", "grupo": copia }), None);
}

fn criar_categoria(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "Nova categoria");
    alterar_estrutura(id, fila, estado, |g| {
        g.categorias.push(Categoria {
            id: novo_id(),
            nome,
            canais: Vec::new(),
        });
        Ok(Vec::new())
    });
}

fn criar_canal(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let categoria = texto_de(v, "categoria");
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "novo-canal");
    let tipo = if texto_de(v, "tipoCanal") == "voz" {
        TipoCanal::Voz
    } else {
        TipoCanal::Texto
    };

    alterar_estrutura(id, fila, estado, move |g| {
        let Some(cat) = g.categoria_mut(&categoria) else {
            return Err("Categoria inexistente.".into());
        };
        cat.canais.push(Canal {
            id: novo_id(),
            nome,
            tipo,
        });
        Ok(Vec::new())
    });
}

fn renomear(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let alvo = texto_de(v, "alvo");
    let referencia = texto_de(v, "id");
    let nome = texto_de(v, "nome").trim().chars().take(NOME_MAX).collect::<String>();
    if nome.is_empty() {
        return;
    }

    alterar_estrutura(id, fila, estado, move |g| {
        match alvo.as_str() {
            "grupo" => g.nome = nome,
            "categoria" => {
                let Some(c) = g.categoria_mut(&referencia) else {
                    return Err("Categoria inexistente.".into());
                };
                c.nome = nome;
            }
            "canal" => {
                let canal = g
                    .categorias
                    .iter_mut()
                    .flat_map(|c| c.canais.iter_mut())
                    .find(|c| c.id == referencia);
                let Some(canal) = canal else {
                    return Err("Canal inexistente.".into());
                };
                canal.nome = nome;
            }
            _ => return Err("Alvo desconhecido.".into()),
        }
        Ok(Vec::new())
    });
}

fn remover(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let alvo = texto_de(v, "alvo");
    let referencia = texto_de(v, "id");

    alterar_estrutura(id, fila, estado, move |g| match alvo.as_str() {
        "categoria" => {
            let Some(pos) = g.categorias.iter().position(|c| c.id == referencia) else {
                return Err("Categoria inexistente.".into());
            };
            if g.categorias.len() == 1 {
                return Err("O grupo precisa de pelo menos uma categoria.".into());
            }
            let fora = g.categorias.remove(pos);
            Ok(fora.canais.into_iter().map(|c| c.id).collect())
        }
        "canal" => {
            if g.ids_de_canal().len() == 1 {
                return Err("O grupo precisa de pelo menos um canal.".into());
            }
            for cat in g.categorias.iter_mut() {
                if let Some(pos) = cat.canais.iter().position(|c| c.id == referencia) {
                    cat.canais.remove(pos);
                    return Ok(vec![referencia]);
                }
            }
            Err("Canal inexistente.".into())
        }
        _ => Err("Alvo desconhecido.".into()),
    });
}

// ------------------------------------------------------------------ apoio

fn texto_de(v: &Value, campo: &str) -> String {
    v.get(campo)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn limitar(bruto: String, maximo: usize, padrao: &str) -> String {
    let cortado: String = bruto.trim().chars().take(maximo).collect();
    if cortado.is_empty() {
        padrao.to_string()
    } else {
        cortado
    }
}

/// Identidade que o cliente guarda e reapresenta. Nao autentica ninguem: serve
/// para reconhecer a mesma pessoa entre reconexoes e atribuir autoria. Quem
/// tem o codigo do convite entra, e isso e deliberado.
///
/// O prefixo `conta-` e reservado: ele so pode sair de um token conferido, em
/// `Cartao::ler`. Sem esta recusa, dizer-se `conta-ABC` na saudacao seria
/// suficiente para assinar mensagens como a pessoa dona daquela conta — e
/// para virar dono de um grupo que nao e seu.
fn identidade(v: &Value) -> String {
    let bruto = texto_de(v, "usuario");
    let limpo: String = bruto
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    if limpo.is_empty() || limpo.starts_with("conta-") {
        novo_id()
    } else {
        limpo
    }
}

fn erro(motivo: &str) -> Message {
    texto_json(&json!({ "tipo": "erro", "motivo": motivo }))
}

fn texto_json(v: &Value) -> Message {
    Message::Text(v.to_string())
}

#[cfg(test)]
mod testes {
    use super::*;

    /// A recusa de um `usuario` alegando ser conta e a linha `identidade()`
    /// verifica sozinha, sem servidor nenhum de pe — direto na funcao pura.
    #[test]
    fn recusa_quem_se_diz_dono_de_uma_conta_sem_prova() {
        let v = json!({ "usuario": "conta-XYZ123456789" });
        assert!(!identidade(&v).starts_with("conta-"));

        let v = json!({ "usuario": "identidade-legitima" });
        assert_eq!(identidade(&v), "identidade-legitima");
    }
}
