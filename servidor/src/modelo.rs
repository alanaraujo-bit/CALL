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

/// Teto de um clipe do soundboard. Coerente com o resto do projeto — medido
/// em quilobytes, nao em megabytes: um clipe curto de efeito sonoro cabe
/// folgado, e um teto pequeno mantem `sons.json`/o volume montado pequenos
/// mesmo com dezenas deles por grupo.
pub const SOM_BYTES_MAX: usize = 300 * 1024;
/// Quantos sons cabem na biblioteca de um grupo. Sem teto, a pasta de blobs
/// cresceria sem limite — como `grupos.json`, o projeto prefere recusar cedo
/// a crescer sem controle.
pub const SONS_POR_GRUPO_MAX: usize = 50;
pub const SOM_NOME_MAX: usize = 40;

/// Um clipe do soundboard: o metadado. Os bytes em si vivem a parte — em
/// `Acervo::blobs`, e no disco em `DADOS/sons/grupos/<codigo>/<id>` quando ha
/// pasta — pelo mesmo motivo de `mensagens.jsonl` nao embutir anexos: um
/// arquivo JSON reescrito a cada mudanca nao deve carregar dados binarios
/// grandes.
#[derive(Clone, Serialize, Deserialize)]
pub struct Som {
    pub id: String,
    pub dono: String,
    pub nome: String,
    /// O que o navegador de quem enviou relatou (`audio/mpeg`, `audio/ogg`,
    /// ...). O servidor nunca decodifica o clipe — quem toca e o motor de
    /// audio do cliente, com `decodeAudioData`.
    pub mime: String,
    pub bytes: u64,
    pub criado_em: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Mensagem {
    pub id: String,
    pub canal: String,
    pub autor: String,
    pub apelido: String,
    /// Mascote de quem escreveu, no momento em que escreveu.
    ///
    /// `default` porque o `mensagens.jsonl` de um servidor que ja rodava nao
    /// tem este campo: sem ele, uma linha antiga faria a desserializacao
    /// falhar e o historico inteiro do canal sumiria em silencio na primeira
    /// atualizacao do servidor.
    #[serde(default)]
    pub avatar: String,
    pub texto: String,
    pub em: u64,
    /// Id do emoji (ver `EMOJIS_VALIDOS` em `main.rs`) -> lista de `usuario`
    /// que reagiu com ele. `default` pelo mesmo motivo do `avatar`: uma
    /// mensagem gravada antes deste campo existir nao pode falhar ao carregar.
    #[serde(default)]
    pub reacoes: HashMap<String, Vec<String>>,
}

/// Tudo que sobrevive a uma reinicializacao.
pub struct Acervo {
    pub grupos: HashMap<String, Grupo>,
    mensagens: HashMap<String, VecDeque<Mensagem>>,
    /// codigo do grupo -> sons da biblioteca dele.
    sons: HashMap<String, Vec<Som>>,
    /// id do som -> bytes. Sempre em memoria (mesmo sem `pasta`, o sidecar
    /// sem `DADOS` precisa continuar tocando sons durante a sessao), e
    /// espelhado em disco quando ha pasta.
    blobs: HashMap<String, Vec<u8>>,
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
            sons: HashMap::new(),
            blobs: HashMap::new(),
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

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("sons.json")) {
            match serde_json::from_str::<HashMap<String, Vec<Som>>>(&bruto) {
                Ok(mapa) => {
                    for (codigo, lista) in &mapa {
                        for som in lista {
                            if let Ok(dados) = std::fs::read(
                                pasta.join("sons").join("grupos").join(codigo).join(&som.id),
                            ) {
                                acervo.blobs.insert(som.id.clone(), dados);
                            }
                        }
                    }
                    acervo.sons = mapa;
                }
                Err(e) => eprintln!("[sinalizacao] sons.json ilegivel: {e}"),
            }
        }

        println!(
            "[sinalizacao] acervo carregado: {} grupo(s), {} linha(s) de mensagem, {} som(ns)",
            acervo.grupos.len(),
            acervo.linhas_gravadas,
            acervo.blobs.len()
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

    /// Alterna a reacao de `usuario` numa mensagem: se ela ja tinha reagido
    /// com este emoji, tira; senao, poe. Devolve as reacoes atualizadas, ou
    /// `None` quando a mensagem nao existe (canal errado, ou historico velho
    /// demais e ja saiu da janela de `HISTORICO_POR_CANAL`).
    ///
    /// Ao contrario de `registrar_mensagem`, que so acrescenta, reagir muda
    /// uma linha que ja existe — entao a unica forma de manter o arquivo
    /// fiel ao que esta em memoria e reescreve-lo por inteiro, e nao so
    /// acrescentar. `compactar` ja faz exatamente isso, e o historico
    /// inteiro cabe folgadamente em memoria, entao chama-lo a cada reacao
    /// custa pouco.
    pub fn reagir(
        &mut self,
        canal: &str,
        mensagem_id: &str,
        usuario: &str,
        emoji: &str,
    ) -> Option<HashMap<String, Vec<String>>> {
        let fila = self.mensagens.get_mut(canal)?;
        let m = fila.iter_mut().find(|m| m.id == mensagem_id)?;

        let usuarios = m.reacoes.entry(emoji.to_string()).or_default();
        match usuarios.iter().position(|u| u == usuario) {
            Some(posicao) => {
                usuarios.remove(posicao);
                if usuarios.is_empty() {
                    m.reacoes.remove(emoji);
                }
            }
            None => usuarios.push(usuario.to_string()),
        }

        let atualizado = m.reacoes.clone();
        self.compactar();
        Some(atualizado)
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

    pub fn sons_do_grupo(&self, codigo: &str) -> Vec<Som> {
        self.sons.get(codigo).cloned().unwrap_or_default()
    }

    pub fn bytes_do_som(&self, id: &str) -> Option<Vec<u8>> {
        self.blobs.get(id).cloned()
    }

    /// Acrescenta um som a biblioteca do grupo. Recusa com uma mensagem
    /// pronta para o cliente quando algum teto estoura — o mesmo espirito de
    /// `alterar_estrutura`, que tambem devolve o motivo em vez de so falhar.
    pub fn adicionar_som(
        &mut self,
        grupo: &str,
        dono: &str,
        nome: String,
        mime: String,
        dados: Vec<u8>,
    ) -> Result<Som, &'static str> {
        if dados.len() > SOM_BYTES_MAX {
            return Err("Esse som passa do tamanho máximo (300 KB).");
        }
        if dados.is_empty() {
            return Err("Som vazio.");
        }
        let lista = self.sons.entry(grupo.to_string()).or_default();
        if lista.len() >= SONS_POR_GRUPO_MAX {
            return Err("Este grupo já tem sons demais na biblioteca (50).");
        }

        let som = Som {
            id: novo_id(),
            dono: dono.to_string(),
            nome: nome.chars().take(SOM_NOME_MAX).collect(),
            mime,
            bytes: dados.len() as u64,
            criado_em: agora_ms(),
        };

        if let Some(pasta) = &self.pasta {
            let pasta_grupo = pasta.join("sons").join("grupos").join(grupo);
            if std::fs::create_dir_all(&pasta_grupo).is_ok() {
                if let Err(e) = std::fs::write(pasta_grupo.join(&som.id), &dados) {
                    eprintln!("[sinalizacao] falha ao gravar som {}: {e}", som.id);
                }
            }
        }
        self.blobs.insert(som.id.clone(), dados);
        lista.push(som.clone());
        self.salvar_sons();
        Ok(som)
    }

    /// Remove um som, se `quem` for quem o enviou ou o dono do grupo. Devolve
    /// o som removido, para quem chamou montar o aviso de difusao.
    pub fn remover_som(&mut self, grupo: &str, id: &str, quem: &str) -> Result<Som, &'static str> {
        let dono_do_grupo = self.grupos.get(grupo).map(|g| g.dono.clone());
        let Some(lista) = self.sons.get_mut(grupo) else {
            return Err("Som não encontrado.");
        };
        let Some(posicao) = lista.iter().position(|s| s.id == id) else {
            return Err("Som não encontrado.");
        };
        if lista[posicao].dono != quem && dono_do_grupo.as_deref() != Some(quem) {
            return Err("Só quem enviou o som, ou o dono do grupo, pode removê-lo.");
        }

        let som = lista.remove(posicao);
        self.blobs.remove(&som.id);
        if let Some(pasta) = &self.pasta {
            let _ = std::fs::remove_file(pasta.join("sons").join("grupos").join(grupo).join(&som.id));
        }
        self.salvar_sons();
        Ok(som)
    }

    fn salvar_sons(&self) {
        let Some(pasta) = &self.pasta else { return };
        match serde_json::to_string(&self.sons) {
            Ok(corpo) => {
                if let Err(e) = gravar_atomico(&pasta.join("sons.json"), &corpo) {
                    eprintln!("[sinalizacao] falha ao salvar sons: {e}");
                }
            }
            Err(e) => eprintln!("[sinalizacao] sons nao serializaveis: {e}"),
        }
    }
}

/// Grava por arquivo temporario e rename: no pior caso o arquivo antigo
/// sobrevive inteiro, e nunca existe um arquivo meio escrito.
pub fn gravar_atomico(destino: &Path, corpo: &str) -> std::io::Result<()> {
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

pub fn sortear(tamanho: usize) -> String {
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
