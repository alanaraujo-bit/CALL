// Roda sem janela de console: o servidor e iniciado pelo proprio aplicativo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Servidor de sinalizacao WebRTC.
//!
//! Encaminha ofertas/respostas/ICE entre participantes de uma mesma sala.
//! Nao toca em audio nem em video: a midia trafega ponto a ponto (mesh).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

type Fila = UnboundedSender<Message>;

#[derive(Clone)]
struct Participante {
    id: u64,
    apelido: String,
    sala: String,
    fila: Fila,
    mudo: bool,
    transmitindo: bool,
}

#[derive(Default)]
struct Estado {
    participantes: HashMap<u64, Participante>,
}

impl Estado {
    fn da_sala(&self, sala: &str) -> Vec<Participante> {
        self.participantes
            .values()
            .filter(|p| p.sala == sala)
            .cloned()
            .collect()
    }
}

static PROXIMO_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() {
    let porta = std::env::args()
        .nth(1)
        .and_then(|a| a.parse::<u16>().ok())
        .unwrap_or(8787);

    let escuta = match TcpListener::bind(("0.0.0.0", porta)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sinalizacao] falha ao abrir a porta {porta}: {e}");
            std::process::exit(1);
        }
    };

    println!("[sinalizacao] pronto em ws://0.0.0.0:{porta}");

    let estado = Arc::new(Mutex::new(Estado::default()));

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

async fn atender(fluxo: TcpStream, estado: Arc<Mutex<Estado>>) -> Result<(), String> {
    let _ = fluxo.set_nodelay(true);
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
    let mut entrou = false;

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

        match v.get("tipo").and_then(Value::as_str).unwrap_or("") {
            "entrar" if !entrou => {
                let sala = v
                    .get("sala")
                    .and_then(Value::as_str)
                    .unwrap_or("geral")
                    .trim()
                    .to_lowercase();
                let apelido = v
                    .get("apelido")
                    .and_then(Value::as_str)
                    .unwrap_or("Convidado")
                    .trim()
                    .chars()
                    .take(24)
                    .collect::<String>();

                let novo = Participante {
                    id,
                    apelido: if apelido.is_empty() {
                        "Convidado".into()
                    } else {
                        apelido
                    },
                    sala: if sala.is_empty() { "geral".into() } else { sala },
                    fila: fila.clone(),
                    mudo: false,
                    transmitindo: false,
                };

                let colegas = {
                    let mut e = estado.lock().unwrap();
                    let colegas = e.da_sala(&novo.sala);
                    e.participantes.insert(id, novo.clone());
                    colegas
                };

                let lista: Vec<Value> = colegas
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id.to_string(),
                            "apelido": p.apelido,
                            "mudo": p.mudo,
                            "transmitindo": p.transmitindo
                        })
                    })
                    .collect();

                let _ = fila.send(texto_json(&json!({
                    "tipo": "bem-vindo",
                    "id": id.to_string(),
                    "sala": novo.sala,
                    "pares": lista
                })));

                let aviso = json!({
                    "tipo": "entrou",
                    "id": id.to_string(),
                    "apelido": novo.apelido
                });
                for p in colegas {
                    let _ = p.fila.send(texto_json(&aviso));
                }

                entrou = true;
            }

            "sinal" if entrou => {
                let Some(destino) = v
                    .get("para")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok())
                else {
                    continue;
                };

                let alvo = {
                    let e = estado.lock().unwrap();
                    match (e.participantes.get(&destino), e.participantes.get(&id)) {
                        // So encaminha entre participantes da mesma sala.
                        (Some(a), Some(eu)) if a.sala == eu.sala => Some(a.fila.clone()),
                        _ => None,
                    }
                };

                if let Some(f) = alvo {
                    let _ = f.send(texto_json(&json!({
                        "tipo": "sinal",
                        "de": id.to_string(),
                        "dados": v.get("dados").cloned().unwrap_or(Value::Null)
                    })));
                }
            }

            "estado" if entrou => {
                let mudo = v.get("mudo").and_then(Value::as_bool).unwrap_or(false);
                let transmitindo = v
                    .get("transmitindo")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

                let colegas = {
                    let mut e = estado.lock().unwrap();
                    let Some(eu) = e.participantes.get_mut(&id) else {
                        continue;
                    };
                    eu.mudo = mudo;
                    eu.transmitindo = transmitindo;
                    let sala = eu.sala.clone();
                    e.da_sala(&sala)
                };

                let aviso = json!({
                    "tipo": "estado",
                    "de": id.to_string(),
                    "mudo": mudo,
                    "transmitindo": transmitindo
                });
                for p in colegas.iter().filter(|p| p.id != id) {
                    let _ = p.fila.send(texto_json(&aviso));
                }
            }

            _ => {}
        }
    }

    // Saida: remove e avisa quem ficou.
    let restantes = {
        let mut e = estado.lock().unwrap();
        match e.participantes.remove(&id) {
            Some(p) => e.da_sala(&p.sala),
            None => Vec::new(),
        }
    };
    let aviso = json!({ "tipo": "saiu", "id": id.to_string() });
    for p in restantes {
        let _ = p.fila.send(texto_json(&aviso));
    }

    envio.abort();
    Ok(())
}

fn texto_json(v: &Value) -> Message {
    Message::Text(v.to_string())
}
