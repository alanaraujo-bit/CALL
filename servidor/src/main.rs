// Roda sem janela de console: o servidor e iniciado pelo proprio aplicativo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Servidor do CALL.
//!
//! Faz duas coisas, e nenhuma delas e tocar em midia:
//!
//! 1. Guarda a estrutura dos grupos (categorias, canais) e o historico dos
//!    canais de texto.
//! 2. Encaminha ofertas/respostas/ICE entre quem esta no mesmo canal de voz.
//!    O audio e o video trafegam ponto a ponto entre os participantes.
//!
//! O mesmo binario atende os dois modos de uso: hospedado na internet, com
//! uma pasta de dados, ou como sidecar na maquina de quem hospeda uma
//! conversa na rede local, sem pasta nenhuma e sem memoria entre execucoes.

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

use modelo::{agora_ms, novo_codigo, novo_id, Acervo, Canal, Categoria, Grupo, TipoCanal};

type Fila = UnboundedSender<Message>;

const APELIDO_MAX: usize = 24;
const NOME_MAX: usize = 40;
const TEXTO_MAX: usize = 2000;

/// Teto de mensagens por janela. Nao e defesa contra um atacante dedicado —
/// e o que impede um cliente com defeito de encher o disco de quem hospeda.
const MENSAGENS_POR_JANELA: u32 = 20;
const JANELA_MS: u64 = 10_000;

#[derive(Clone)]
struct Conexao {
    id: u64,
    usuario: String,
    apelido: String,
    grupo: Option<String>,
    canal_voz: Option<String>,
    fila: Fila,
    mudo: bool,
    transmitindo: bool,
}

impl Conexao {
    fn resumo(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "usuario": self.usuario,
            "apelido": self.apelido,
            "canalVoz": self.canal_voz,
            "mudo": self.mudo,
            "transmitindo": self.transmitindo
        })
    }
}

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
        tokio::spawn(async move {
            if let Err(e) = atender(fluxo, estado).await {
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

async fn atender(mut fluxo: TcpStream, estado: Arc<Mutex<Estado>>) -> Result<(), String> {
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

        tratar(tipo, &v, id, &fila, &estado);
    }

    despedir(id, &estado);
    envio.abort();
    Ok(())
}

fn tratar(tipo: &str, v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    match tipo {
        "criar-grupo" => criar_grupo(v, id, fila, estado),
        "entrar" => entrar(v, id, fila, estado),
        "entrar-voz" => entrar_voz(v, id, fila, estado),
        "sair-voz" => sair_voz(id, estado),
        "sinal" => sinal(v, id, estado),
        "estado" => estado_de_midia(v, id, estado),
        "mensagem" => mensagem(v, id, fila, estado),
        "historico" => historico(v, id, fila, estado),
        "criar-categoria" => criar_categoria(v, id, fila, estado),
        "criar-canal" => criar_canal(v, id, fila, estado),
        "renomear" => renomear(v, id, fila, estado),
        "remover" => remover(v, id, fila, estado),
        _ => {}
    }
}

// ---------------------------------------------------------------- entrada

fn criar_grupo(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "Meu grupo");
    let apelido = limitar(texto_de(v, "apelido"), APELIDO_MAX, "Convidado");
    let usuario = identidade(v);

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }

    let grupo = Grupo::novo(novo_codigo(), nome, usuario.clone());
    let codigo = grupo.codigo.clone();
    e.acervo.grupos.insert(codigo.clone(), grupo);
    e.acervo.salvar_grupos();

    admitir(&mut e, id, usuario, apelido, &codigo, fila);
}

fn entrar(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let codigo = texto_de(v, "codigo").trim().to_uppercase();
    let apelido = limitar(texto_de(v, "apelido"), APELIDO_MAX, "Convidado");
    let usuario = identidade(v);

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }
    if !e.acervo.grupos.contains_key(&codigo) {
        let _ = fila.send(erro("Convite invalido ou grupo removido."));
        return;
    }

    admitir(&mut e, id, usuario, apelido, &codigo, fila);
}

/// Registra a conexao no grupo, entrega o estado inteiro a ela e anuncia a
/// chegada aos demais.
fn admitir(
    e: &mut Estado,
    id: u64,
    usuario: String,
    apelido: String,
    codigo: &str,
    fila: &Fila,
) {
    let nova = Conexao {
        id,
        usuario,
        apelido,
        grupo: Some(codigo.to_string()),
        canal_voz: None,
        fila: fila.clone(),
        mudo: false,
        transmitindo: false,
    };

    let presentes: Vec<Value> = e.do_grupo(codigo).iter().map(Conexao::resumo).collect();
    let grupo = e.acervo.grupos.get(codigo).cloned();

    let aviso = json!({ "tipo": "entrou", "membro": nova.resumo() });
    e.difundir(codigo, &aviso, None);

    let _ = fila.send(texto_json(&json!({
        "tipo": "bem-vindo",
        "eu": nova.resumo(),
        "grupo": grupo,
        "presentes": presentes
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

    let mut e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get_mut(&id) else {
        return;
    };
    eu.mudo = mudo;
    eu.transmitindo = transmitindo;
    let Some(codigo) = eu.grupo.clone() else {
        return;
    };

    let aviso = json!({
        "tipo": "estado",
        "de": id.to_string(),
        "mudo": mudo,
        "transmitindo": transmitindo
    });
    e.difundir(&codigo, &aviso, Some(id));
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

    let m = modelo::Mensagem {
        id: novo_id(),
        canal: canal.clone(),
        autor: eu.usuario.clone(),
        apelido: eu.apelido.clone(),
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
fn identidade(v: &Value) -> String {
    let bruto = texto_de(v, "usuario");
    let limpo: String = bruto
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    if limpo.is_empty() {
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
