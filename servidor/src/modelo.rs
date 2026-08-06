//! Modelo de dados dos grupos e sua persistencia em disco.
//!
//! Nao ha banco de dados aqui de proposito. O servidor e o mesmo binario que
//! viaja dentro do instalador como sidecar, e o projeto inteiro e medido em
//! quilobytes: embutir um SQLite custaria cerca de 1 MB para guardar algumas
//! dezenas de linhas de estrutura e um historico limitado de mensagens, que
//! cabem folgadamente em memoria.
//!
//! Sao dois arquivos, com caracteristicas de escrita bem diferentes:
//!
//! * `grupos.json` — a estrutura (grupos, categorias, canais). Muda raramente
//!   e e pequena, entao e reescrita inteira, por arquivo temporario e rename,
//!   para que uma queda no meio da gravacao nunca deixe um arquivo pela metade.
//! * `mensagens.jsonl` — uma mensagem por linha, so acrescimo. Escrever uma
//!   mensagem nao pode custar reescrever o historico todo.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Quantas mensagens por canal ficam disponiveis. O que passa disso sai do
/// historico servido e deixa de ser regravado na proxima compactacao.
pub const HISTORICO_POR_CANAL: usize = 500;

/// A partir de quantas linhas o arquivo de mensagens e reescrito so com o que
/// ainda esta em memoria. Sem isto ele cresceria para sempre, guardando
/// mensagens que ninguem mais consegue ler.
const LINHAS_ANTES_DE_COMPACTAR: usize = 20_000;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoCanal {
    Texto,
    Voz,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Canal {
    pub id: String,
    pub nome: String,
    pub tipo: TipoCanal,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Categoria {
    pub id: String,
    pub nome: String,
    pub canais: Vec<Canal>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Grupo {
    pub codigo: String,
    pub nome: String,
    pub dono: String,
    pub categorias: Vec<Categoria>,
}

impl Grupo {
    /// Estrutura inicial de um grupo novo: uma categoria com um canal de cada
    /// tipo. Um grupo vazio nao teria onde falar nem onde escrever, e a
    /// primeira coisa que a pessoa faz depois de criar e convidar alguem.
    pub fn novo(codigo: String, nome: String, dono: String) -> Self {
        Grupo {
            codigo,
            nome,
            dono,
            categorias: vec![Categoria {
                id: novo_id(),
                nome: "Geral".into(),
                canais: vec![
                    Canal {
                        id: novo_id(),
                        nome: "geral".into(),
                        tipo: TipoCanal::Texto,
                    },
                    Canal {
                        id: novo_id(),
                        nome: "Sala de voz".into(),
                        tipo: TipoCanal::Voz,
                    },
                ],
            }],
        }
    }

    pub fn canal(&self, id: &str) -> Option<&Canal> {
        self.categorias
            .iter()
            .flat_map(|c| c.canais.iter())
            .find(|c| c.id == id)
    }

    pub fn categoria_mut(&mut self, id: &str) -> Option<&mut Categoria> {
        self.categorias.iter_mut().find(|c| c.id == id)
    }

    /// Todos os identificadores de canal do grupo — usado para varrer o
    /// historico quando uma categoria inteira e removida.
    pub fn ids_de_canal(&self) -> Vec<String> {
        self.categorias
            .iter()
            .flat_map(|c| c.canais.iter())
            .map(|c| c.id.clone())
            .collect()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Mensagem {
    pub id: String,
    pub canal: String,
    pub autor: String,
    pub apelido: String,
    pub texto: String,
    pub em: u64,
}

/// Tudo que sobrevive a uma reinicializacao.
pub struct Acervo {
    pub grupos: HashMap<String, Grupo>,
    mensagens: HashMap<String, VecDeque<Mensagem>>,
    pasta: Option<PathBuf>,
    linhas_gravadas: usize,
}

impl Acervo {
    /// Sem pasta o servidor funciona igual, so que esquece tudo ao fechar —
    /// e o caso do sidecar rodando na maquina de quem hospeda uma partida
    /// rapida na rede local.
    pub fn carregar(pasta: Option<PathBuf>) -> Self {
        let mut acervo = Acervo {
            grupos: HashMap::new(),
            mensagens: HashMap::new(),
            pasta: pasta.clone(),
            linhas_gravadas: 0,
        };

        let Some(pasta) = pasta else {
            return acervo;
        };
        if let Err(e) = std::fs::create_dir_all(&pasta) {
            eprintln!("[sinalizacao] pasta de dados indisponivel: {e}");
            acervo.pasta = None;
            return acervo;
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("grupos.json")) {
            match serde_json::from_str::<Vec<Grupo>>(&bruto) {
                Ok(lista) => {
                    for g in lista {
                        acervo.grupos.insert(g.codigo.clone(), g);
                    }
                }
                // Preferimos comecar vazio a derrubar o servidor: um arquivo
                // corrompido nao deve impedir a criacao de grupos novos.
                Err(e) => eprintln!("[sinalizacao] grupos.json ilegivel: {e}"),
            }
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("mensagens.jsonl")) {
            for linha in bruto.lines().filter(|l| !l.trim().is_empty()) {
                acervo.linhas_gravadas += 1;
                if let Ok(m) = serde_json::from_str::<Mensagem>(linha) {
                    acervo.guardar_em_memoria(m);
                }
            }
        }

        println!(
            "[sinalizacao] acervo carregado: {} grupo(s), {} linha(s) de mensagem",
            acervo.grupos.len(),
            acervo.linhas_gravadas
        );
        acervo
    }

    fn guardar_em_memoria(&mut self, m: Mensagem) {
        let fila = self.mensagens.entry(m.canal.clone()).or_default();
        fila.push_back(m);
        while fila.len() > HISTORICO_POR_CANAL {
            fila.pop_front();
        }
    }

    pub fn historico(&self, canal: &str) -> Vec<Mensagem> {
        self.mensagens
            .get(canal)
            .map(|f| f.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn registrar_mensagem(&mut self, m: Mensagem) {
        if let Some(pasta) = &self.pasta {
            let linha = match serde_json::to_string(&m) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[sinalizacao] mensagem nao serializavel: {e}");
                    return;
                }
            };
            let escrita = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(pasta.join("mensagens.jsonl"))
                .and_then(|mut a| writeln!(a, "{linha}"));
            match escrita {
                Ok(()) => self.linhas_gravadas += 1,
                Err(e) => eprintln!("[sinalizacao] falha ao gravar mensagem: {e}"),
            }
        }

        self.guardar_em_memoria(m);

        if self.linhas_gravadas > LINHAS_ANTES_DE_COMPACTAR {
            self.compactar();
        }
    }

    /// Descarta do disco o que ja saiu do historico servido.
    fn compactar(&mut self) {
        let Some(pasta) = self.pasta.clone() else {
            self.linhas_gravadas = 0;
            return;
        };

        let mut corpo = String::new();
        let mut linhas = 0usize;
        for fila in self.mensagens.values() {
            for m in fila {
                if let Ok(l) = serde_json::to_string(m) {
                    corpo.push_str(&l);
                    corpo.push('\n');
                    linhas += 1;
                }
            }
        }

        if gravar_atomico(&pasta.join("mensagens.jsonl"), &corpo).is_ok() {
            self.linhas_gravadas = linhas;
        }
    }

    /// Chamado depois de qualquer mudanca na estrutura dos grupos.
    pub fn salvar_grupos(&self) {
        let Some(pasta) = &self.pasta else { return };
        let lista: Vec<&Grupo> = self.grupos.values().collect();
        match serde_json::to_string(&lista) {
            Ok(corpo) => {
                if let Err(e) = gravar_atomico(&pasta.join("grupos.json"), &corpo) {
                    eprintln!("[sinalizacao] falha ao salvar grupos: {e}");
                }
            }
            Err(e) => eprintln!("[sinalizacao] grupos nao serializaveis: {e}"),
        }
    }

    pub fn esquecer_canais(&mut self, ids: &[String]) {
        for id in ids {
            self.mensagens.remove(id);
        }
    }
}

/// Grava por arquivo temporario e rename: no pior caso o arquivo antigo
/// sobrevive inteiro, e nunca existe um arquivo meio escrito.
fn gravar_atomico(destino: &Path, corpo: &str) -> std::io::Result<()> {
    let temporario = destino.with_extension("tmp");
    {
        let mut arquivo = std::fs::File::create(&temporario)?;
        arquivo.write_all(corpo.as_bytes())?;
        arquivo.sync_all()?;
    }
    std::fs::rename(&temporario, destino)
}

/// Alfabeto sem os caracteres que se confundem lidos em voz alta ou copiados
/// de uma captura de tela: sem I, L, O, 0 e 1.
const ALFABETO: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn sortear(tamanho: usize) -> String {
    let mut bytes = vec![0u8; tamanho];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Sem entropia do sistema nao ha como sortear um codigo que nao seja
        // adivinhavel, e um convite adivinhavel e pior que nenhum convite.
        panic!("[sinalizacao] o sistema nao forneceu numeros aleatorios");
    }
    bytes
        .iter()
        .map(|b| ALFABETO[*b as usize % ALFABETO.len()] as char)
        .collect()
}

/// Codigo do convite. Dez caracteres nesse alfabeto sao cerca de 49 bits: nao
/// se acha um grupo por tentativa e erro.
pub fn novo_codigo() -> String {
    sortear(10)
}

pub fn novo_id() -> String {
    sortear(12)
}

pub fn agora_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
