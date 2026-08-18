//! Contas: o que sobrevive a troca de computador.
//!
//! Ate a versao 0.7.0 o CALL nao guardava pessoa nenhuma. A identidade era um
//! numero sorteado no primeiro uso e gravado no `localStorage`: bastava
//! reinstalar o Windows para virar outra pessoa, perder os grupos e ver o
//! historico atribuir as proprias mensagens a um desconhecido.
//!
//! Uma conta e o remendo disso, e nada alem: e-mail, uma senha, o perfil e a
//! lista de grupos. Nao ha papeis, nao ha assinatura, nao ha cobranca. Entrar
//! num grupo continua sendo questao de ter o convite — a conta diz *quem voce
//! e*, e nunca *o que voce pode*.
//!
//! **A conta e opcional de proposito.** O CALL roda em rede local, sem
//! internet, com o servidor dentro do proprio instalador; exigir cadastro
//! nesse cenario seria exigir um servico que talvez nem exista. Quem entra sem
//! conta continua entrando exatamente como antes.
//!
//! ## Dois guarda-costas atras da mesma porta
//!
//! O `Cofre` fala uma interface so, e por baixo dela ha dois jeitos de
//! guardar a mesma coisa:
//!
//! * **Postgres**, quando `DATABASE_URL` esta no ambiente e o binario foi
//!   compilado com `--features banco`. E o caso da imagem da nuvem.
//! * **Um par de arquivos** (`contas.json`, `sessoes.json`), reescritos por
//!   inteiro a cada mudanca — exatamente como `grupos.json` — quando nao ha
//!   banco. E o caso do sidecar que hospeda uma conversa em rede local sem
//!   internet: ali nao ha Postgres nenhum para se conectar, e o mesmo binario
//!   que roda na nuvem precisa continuar rodando ali tambem.
//!
//! A escolha e em tempo de execucao, nao so de compilacao: um `DATABASE_URL`
//! ausente ou fora do ar faz o servidor cair para o arquivo em vez de recusar
//! subir — e a mesma filosofia do resto do projeto, que prefere degradar a
//! travar.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::modelo::{agora_ms, gravar_atomico, novo_id, sortear, SOM_BYTES_MAX, SOM_NOME_MAX};

/// Quantos sons cabem na biblioteca pessoal de uma conta. Bem menor que o
/// teto por grupo (50): e uma coleção pequena para o som de entrada e para
/// usar em qualquer grupo, não um soundboard inteiro.
pub const SONS_PESSOAIS_MAX: usize = 3;

/// Um clipe da biblioteca pessoal — o mesmo papel de `modelo::Som`, mas preso
/// a conta em vez de a um grupo, e por isso guardado ao lado dela (Postgres
/// quando existe, `sons_pessoais.json` quando não).
#[derive(Clone, Serialize, Deserialize)]
pub struct SomPessoal {
    pub id: String,
    pub nome: String,
    pub mime: String,
    pub bytes: u64,
    pub criado_em: u64,
}

/// O que toca quando a pessoa entra num canal de voz, no lugar do sino
/// sintetizado padrão. `origem` é `"grupo"` (um som da biblioteca de um
/// grupo específico — só toca dentro dele) ou `"pessoal"` (a biblioteca
/// própria, funciona em qualquer grupo).
#[derive(Clone, Serialize, Deserialize)]
pub struct PreferenciaSom {
    pub origem: String,
    #[serde(default)]
    pub grupo: Option<String>,
    pub id: String,
}

/// Tamanho máximo do título e da descrição de um feedback — generoso o
/// bastante para um relato completo, apertado o bastante para não virar
/// upload de texto disfarçado.
pub const FEEDBACK_TITULO_MAX: usize = 120;
pub const FEEDBACK_DESCRICAO_MAX: usize = 4000;

/// Teto de feedbacks abertos por conta. O limite de taxa em `main.rs`
/// (`MENSAGENS_POR_JANELA`) já impede uma rajada; este é o teto de longo
/// prazo, para que uma conta esquecida enviando o mesmo relato por meses não
/// cresça a tabela sem limite.
pub const FEEDBACK_POR_CONTA_MAX: usize = 200;

/// Um relato — bug, sugestão ou elogio — mandado por uma conta. `apelido` é
/// uma cópia de quando foi enviado, o mesmo princípio de `PedidoAmigo`: o
/// painel administrativo mostra quem pediu como a pessoa era naquele
/// momento, e o relato não muda de nome sozinho se a conta for renomeada
/// depois.
///
/// `status` começa em `"recebido"` e só muda pelo painel administrativo (uma
/// peça futura, ainda não construída) — o valor aqui é sempre a verdade
/// atual, nunca reconstruído a partir de outra coisa.
#[derive(Clone, Serialize, Deserialize)]
pub struct Feedback {
    pub id: String,
    pub conta_id: String,
    pub apelido: String,
    pub categoria: String,
    pub titulo: String,
    pub descricao: String,
    pub status: String,
    pub criado_em: u64,
    pub atualizado_em: u64,
}

const CATEGORIAS_FEEDBACK: [&str; 3] = ["bug", "sugestao", "elogio"];

/// Os quatro estados que o painel administrativo pode atribuir a um
/// relato — a mesma lista que `src/feedback.js` conhece do lado do
/// cliente, em `ROTULOS_STATUS`.
const STATUS_FEEDBACK: [&str; 4] = ["recebido", "aceito", "em_andamento", "finalizado"];

/// Quanto tempo um token vale sem que ninguem o use. Noventa dias e o
/// intervalo em que "eu uso o CALL" ainda e verdade; alem disso, pedir a senha
/// de novo custa dez segundos e evita que uma maquina emprestada continue
/// aberta para sempre.
const SESSAO_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// Depois de tantas senhas erradas seguidas, o e-mail para de aceitar
/// tentativas pelo tempo de `CASTIGO_MS`. Nao e defesa contra um adversario
/// com mil maquinas — e o que torna inviavel varrer as senhas obvias de um
/// e-mail conhecido a partir de uma so.
const FALHAS_ATE_CASTIGO: u32 = 8;
const CASTIGO_MS: u64 = 15 * 60 * 1000;

pub const EMAIL_MAX: usize = 160;
pub const SENHA_MIN: usize = 8;
pub const SENHA_MAX: usize = 128;

/// Grupo que a pessoa conhece. E a coluna da esquerda do aplicativo, guardada
/// aqui para que ela apareca igual num computador novo.
#[derive(Clone, Serialize, Deserialize)]
pub struct Atalho {
    pub codigo: String,
    pub nome: String,
    #[serde(default)]
    pub foto: String,
}

/// Quantos pedidos de amizade pendentes cabem numa conta. Generoso para uso
/// normal, apertado o bastante para que ninguem consiga inundar o convite de
/// alguem com pedidos.
pub const PEDIDOS_AMIGO_MAX: usize = 60;

/// Pedido de amizade pendente, guardado em quem ainda nao respondeu.
/// `apelido`/`avatar` sao uma copia de quando o pedido foi mandado — o mesmo
/// principio de `modelo::Mensagem::avatar`: o pedido mostra quem pediu como
/// ela era naquele momento, e nao muda sozinho se a pessoa trocar de mascote
/// antes de alguem responder.
#[derive(Clone, Serialize, Deserialize)]
pub struct PedidoAmigo {
    pub de: String,
    pub apelido: String,
    #[serde(default)]
    pub avatar: String,
    pub em: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Conta {
    /// Identificador que viaja como `usuario` no protocolo. Prefixado para
    /// nunca colidir com o numero sorteado por quem entra sem conta.
    pub id: String,
    /// Normalizado em minusculas. E a chave por onde se procura alguem.
    pub email: String,
    /// String PHC do Argon2id. Vazia numa conta que so entra pelo Google —
    /// e uma senha vazia nao autentica ninguem, porque a verificacao exige
    /// que este campo tenha um hash valido.
    #[serde(default)]
    pub senha: String,
    /// O `sub` do Google, que e estavel mesmo quando a pessoa troca o e-mail
    /// da conta Google. Vazio quando a conta nunca foi vinculada.
    #[serde(default)]
    pub google: String,
    pub apelido: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub atalhos: Vec<Atalho>,
    #[serde(default)]
    pub som_entrada: Option<PreferenciaSom>,
    /// Ids de conta dos amigos — simetrico, cada lado guarda o id do outro
    /// depois que o pedido e aceito.
    #[serde(default)]
    pub amigos: Vec<String>,
    /// Pedidos de amizade recebidos e ainda nao respondidos.
    #[serde(default)]
    pub pedidos_amigo: Vec<PedidoAmigo>,
    pub criada_em: u64,
}

impl Conta {
    /// O que o cliente ve da propria conta. A senha nao sai daqui nem em
    /// forma de hash: ninguem do outro lado tem o que fazer com ela.
    pub fn resumo(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "email": self.email,
            "apelido": self.apelido,
            "avatar": self.avatar,
            "bio": self.bio,
            "atalhos": self.atalhos,
            "google": !self.google.is_empty(),
            "temSenha": !self.senha.is_empty(),
            "somEntrada": self.som_entrada,
        })
    }
}

/// O que deu errado. Separado do texto porque a interface precisa saber *em
/// qual campo* pintar o erro, e nao so o que dizer.
#[derive(Debug)]
pub struct Recusa {
    pub campo: &'static str,
    pub motivo: String,
}

fn recusar(campo: &'static str, motivo: &str) -> Recusa {
    Recusa {
        campo,
        motivo: motivo.to_string(),
    }
}

/// Quantas senhas erradas seguidas, e ate quando o e-mail esta de castigo.
/// Vive so em memoria, nos dois backends: reiniciar o servidor perdoa, e tudo
/// bem — reiniciar o servidor nao e algo que um atacante consiga pedir.
#[derive(Default)]
struct Tentativas {
    falhas: u32,
    ate: u64,
}

/// O cofre de contas — a porta unica que `main.rs` conhece. Por dentro, um
/// dos dois backends do modulo; ver a nota do topo.
pub struct Cofre {
    armazem: Armazem,
    castigo: Mutex<HashMap<String, Tentativas>>,
}

enum Armazem {
    Arquivo(Mutex<EstadoArquivo>),
    #[cfg(feature = "banco")]
    Postgres(sqlx::PgPool),
}

impl Cofre {
    /// Decide o backend e sobe o cofre.
    ///
    /// Tenta o Postgres primeiro, e so quando a opcao `banco` foi compilada e
    /// `DATABASE_URL` esta no ambiente. Qualquer falha em conectar ou migrar
    /// cai para o arquivo em vez de derrubar o servidor — um Postgres fora do
    /// ar por um instante nao deveria impedir ate quem entra sem conta de
    /// conversar.
    pub async fn carregar(pasta: Option<PathBuf>) -> Self {
        #[cfg(feature = "banco")]
        if let Ok(url) = std::env::var("DATABASE_URL") {
            if !url.is_empty() {
                match postgres::conectar(&url, pasta.as_deref()).await {
                    Ok(pool) => {
                        return Cofre {
                            armazem: Armazem::Postgres(pool),
                            castigo: Mutex::new(HashMap::new()),
                        };
                    }
                    Err(e) => {
                        eprintln!("[contas] Postgres indisponivel ({e}); usando o arquivo local");
                    }
                }
            }
        }

        let estado = EstadoArquivo::carregar(pasta);
        Cofre {
            armazem: Armazem::Arquivo(Mutex::new(estado)),
            castigo: Mutex::new(HashMap::new()),
        }
    }

    pub async fn por_id(&self, id: &str) -> Option<Conta> {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().contas.get(id).cloned(),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::por_id(pool, id).await,
        }
    }

    /// Hash guardado para um e-mail, ou `None` se ninguem usa esse e-mail.
    /// Devolvido por copia de proposito: verificar a senha leva dezenas de
    /// milissegundos e nao pode acontecer com o estado trancado.
    pub async fn hash_de(&self, email: &str) -> Option<(String, String)> {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let e = estado.lock().unwrap();
                let id = e.por_email.get(email)?;
                let conta = e.contas.get(id)?;
                Some((conta.id.clone(), conta.senha.clone()))
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::hash_de(pool, email).await,
        }
    }

    pub async fn email_ocupado(&self, email: &str) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().por_email.contains_key(email),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::email_ocupado(pool, email).await,
        }
    }

    /// Quanto falta do castigo, em milissegundos. Zero quando o e-mail esta
    /// livre para tentar. Sincrono nos dois backends: fica so em memoria.
    pub fn castigo_restante(&self, email: &str) -> u64 {
        self.castigo
            .lock()
            .unwrap()
            .get(email)
            .map(|t| t.ate.saturating_sub(agora_ms()))
            .unwrap_or(0)
    }

    pub fn anotar_falha(&self, email: &str) {
        let agora = agora_ms();
        let mut castigo = self.castigo.lock().unwrap();
        let t = castigo.entry(email.to_string()).or_default();
        // Um castigo vencido zera a contagem: oito erros espalhados por um ano
        // sao uma pessoa distraida, nao um ataque.
        if t.ate != 0 && t.ate < agora {
            t.falhas = 0;
        }
        t.falhas += 1;
        if t.falhas >= FALHAS_ATE_CASTIGO {
            t.ate = agora + CASTIGO_MS;
            t.falhas = 0;
        }
    }

    pub fn perdoar(&self, email: &str) {
        self.castigo.lock().unwrap().remove(email);
    }

    /// Cria a conta. O hash ja vem pronto de fora, calculado longe da tranca.
    pub async fn cadastrar(
        &self,
        email: String,
        hash: String,
        apelido: String,
        avatar: String,
        bio: String,
    ) -> Result<String, Recusa> {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                // Reconferido aqui, e nao so antes de calcular o hash: duas
                // pessoas podem ter pedido o mesmo e-mail enquanto o Argon2
                // rodava.
                if e.por_email.contains_key(&email) {
                    return Err(recusar("email", "Já existe uma conta com este e-mail."));
                }
                let conta = Conta {
                    id: format!("conta-{}", novo_id()),
                    email,
                    senha: hash,
                    google: String::new(),
                    apelido,
                    avatar,
                    bio,
                    atalhos: Vec::new(),
                    som_entrada: None,
                    amigos: Vec::new(),
                    pedidos_amigo: Vec::new(),
                    criada_em: agora_ms(),
                };
                let id = conta.id.clone();
                e.indexar(conta);
                e.salvar_contas();
                Ok(id)
            }
            // No Postgres a corrida se resolve sozinha: a UNIQUE do e-mail e
            // quem decide, num INSERT so, sem checar-e-inserir em dois passos.
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::cadastrar(pool, email, hash, apelido, avatar, bio).await,
        }
    }

    /// Encontra ou cria a conta correspondente a uma identidade do Google.
    ///
    /// Vincular pelo e-mail quando o `sub` e novo e deliberado: quem se
    /// cadastrou com senha e depois clicou em "Entrar com o Google" espera
    /// achar a propria conta, e nao uma segunda vazia. So e seguro porque o
    /// Google so devolve o e-mail depois de verifica-lo — por isso a checagem
    /// de `verificado` acontece antes de chegar aqui.
    pub async fn pelo_google(&self, sub: &str, email: &str, nome: &str, avatar_sugerido: &str) -> String {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                if let Some(id) = e.por_google.get(sub) {
                    return id.clone();
                }
                if let Some(id) = e.por_email.get(email).cloned() {
                    if let Some(conta) = e.contas.get_mut(&id) {
                        conta.google = sub.to_string();
                    }
                    e.por_google.insert(sub.to_string(), id.clone());
                    e.salvar_contas();
                    return id;
                }
                let conta = Conta {
                    id: format!("conta-{}", novo_id()),
                    email: email.to_string(),
                    senha: String::new(),
                    google: sub.to_string(),
                    apelido: nome.to_string(),
                    avatar: avatar_sugerido.to_string(),
                    bio: String::new(),
                    atalhos: Vec::new(),
                    som_entrada: None,
                    amigos: Vec::new(),
                    pedidos_amigo: Vec::new(),
                    criada_em: agora_ms(),
                };
                let id = conta.id.clone();
                e.indexar(conta);
                e.salvar_contas();
                id
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::pelo_google(pool, sub, email, nome, avatar_sugerido).await,
        }
    }

    /// Perfil trocado pela pessoa. Campos ausentes ficam como estavam: o
    /// cliente manda o que mudou, e nunca um perfil pela metade.
    pub async fn guardar_perfil(
        &self,
        id: &str,
        apelido: Option<String>,
        avatar: Option<String>,
        bio: Option<String>,
        atalhos: Option<Vec<Atalho>>,
    ) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let Some(conta) = e.contas.get_mut(id) else {
                    return false;
                };
                if let Some(v) = apelido {
                    if !v.is_empty() {
                        conta.apelido = v;
                    }
                }
                if let Some(v) = avatar {
                    conta.avatar = v;
                }
                if let Some(v) = bio {
                    conta.bio = v;
                }
                if let Some(v) = atalhos {
                    conta.atalhos = v;
                }
                e.salvar_contas();
                true
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::guardar_perfil(pool, id, apelido, avatar, bio, atalhos).await,
        }
    }

    /// Anota o grupo na conta de quem acabou de entrar nele. Devolve `true`
    /// quando algo mudou, para nao regravar a vista toa.
    pub async fn lembrar_grupo(&self, id: &str, codigo: &str, nome: &str, foto: &str) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let Some(conta) = e.contas.get_mut(id) else {
                    return false;
                };
                match conta.atalhos.iter_mut().find(|a| a.codigo == codigo) {
                    Some(existente) if existente.nome == nome && existente.foto == foto => return false,
                    Some(existente) => {
                        existente.nome = nome.to_string();
                        existente.foto = foto.to_string();
                    }
                    None => conta.atalhos.push(Atalho {
                        codigo: codigo.to_string(),
                        nome: nome.to_string(),
                        foto: foto.to_string(),
                    }),
                }
                e.salvar_contas();
                true
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::lembrar_grupo(pool, id, codigo, nome, foto).await,
        }
    }

    pub async fn sons_pessoais_de(&self, conta_id: &str) -> Vec<SomPessoal> {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado
                .lock()
                .unwrap()
                .sons_pessoais
                .get(conta_id)
                .cloned()
                .unwrap_or_default(),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::sons_pessoais_de(pool, conta_id).await,
        }
    }

    /// Bytes de um som pessoal — só devolvidos a quem é dono da conta, nunca
    /// a outra pessoa: diferente do soundboard de grupo, este clipe nunca
    /// precisa ser buscado por ninguém além de quem o enviou (o áudio chega
    /// aos outros pela própria trilha WebRTC de quem o toca).
    pub async fn bytes_de_som_pessoal(&self, conta_id: &str, id: &str) -> Option<Vec<u8>> {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let e = estado.lock().unwrap();
                let pertence = e.sons_pessoais.get(conta_id)?.iter().any(|s| s.id == id);
                if !pertence {
                    return None;
                }
                e.blobs.get(id).cloned()
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::bytes_de_som_pessoal(pool, conta_id, id).await,
        }
    }

    pub async fn adicionar_som_pessoal(
        &self,
        conta_id: &str,
        nome: String,
        mime: String,
        dados: Vec<u8>,
    ) -> Result<SomPessoal, &'static str> {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().adicionar_som_pessoal(conta_id, nome, mime, dados),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::adicionar_som_pessoal(pool, conta_id, nome, mime, dados).await,
        }
    }

    pub async fn remover_som_pessoal(&self, conta_id: &str, id: &str) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().remover_som_pessoal(conta_id, id),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::remover_som_pessoal(pool, conta_id, id).await,
        }
    }

    /// Registra um relato novo. Recusa categoria fora de bug/sugestão/elogio
    /// e uma conta que já acumulou relatos demais — ver `FEEDBACK_POR_CONTA_MAX`.
    pub async fn enviar_feedback(
        &self,
        de: &Conta,
        categoria: String,
        titulo: String,
        descricao: String,
    ) -> Result<Feedback, &'static str> {
        if !CATEGORIAS_FEEDBACK.contains(&categoria.as_str()) {
            return Err("Categoria de feedback inválida.");
        }
        let titulo: String = titulo.trim().chars().take(FEEDBACK_TITULO_MAX).collect();
        let descricao: String = descricao.trim().chars().take(FEEDBACK_DESCRICAO_MAX).collect();
        if titulo.is_empty() || descricao.is_empty() {
            return Err("Título e descrição não podem ficar vazios.");
        }

        match &self.armazem {
            Armazem::Arquivo(estado) => {
                estado.lock().unwrap().enviar_feedback(de, categoria, titulo, descricao)
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::enviar_feedback(pool, de, categoria, titulo, descricao).await,
        }
    }

    /// Os relatos que uma conta já enviou, mais recente primeiro — é a lista
    /// que mostra ao próprio autor o status de cada pedido.
    pub async fn meu_feedback(&self, conta_id: &str) -> Vec<Feedback> {
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().feedback_de(conta_id),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::feedback_de(pool, conta_id).await,
        }
    }

    /// Todos os relatos, de todas as contas, mais recente primeiro — só o
    /// painel administrativo chama isto; ninguém mais tem por que ver o
    /// feedback de outra pessoa.
    pub async fn todos_feedbacks(&self) -> Vec<Feedback> {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let e = estado.lock().unwrap();
                let mut todos: Vec<Feedback> = e.feedback.values().flatten().cloned().collect();
                todos.sort_by(|a, b| b.criado_em.cmp(&a.criado_em));
                todos
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::todos_feedbacks(pool).await,
        }
    }

    /// Muda o status de um relato pelo id. `None` quando o id não existe ou
    /// o status pedido não é um dos quatro válidos — o painel administrativo
    /// é a única porta para isto, e ela não decide status novo nenhum.
    pub async fn mudar_status_feedback(&self, id: &str, status: &str) -> Option<Feedback> {
        if !STATUS_FEEDBACK.contains(&status) {
            return None;
        }
        match &self.armazem {
            Armazem::Arquivo(estado) => estado.lock().unwrap().mudar_status_feedback(id, status),
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::mudar_status_feedback(pool, id, status).await,
        }
    }

    /// `None` volta o som de entrada para o sino sintetizado padrão.
    pub async fn guardar_som_entrada(&self, conta_id: &str, preferencia: Option<PreferenciaSom>) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let Some(conta) = e.contas.get_mut(conta_id) else {
                    return false;
                };
                conta.som_entrada = preferencia;
                e.salvar_contas();
                true
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::guardar_som_entrada(pool, conta_id, preferencia).await,
        }
    }

    /// Manda um pedido de amizade de `de` para a conta `para_id`. Devolve
    /// `true` quando os dois ja viraram amigos direto — porque `para_id` ja
    /// tinha mandado um pedido para `de` antes, e pedir de volta fecha esse
    /// pedido em vez de abrir um segundo pendurado no sentido contrario.
    pub async fn pedir_amizade(&self, de: &Conta, para_id: &str) -> Result<bool, &'static str> {
        if para_id == de.id {
            return Err("Você não pode adicionar a si mesmo.");
        }
        if de.amigos.iter().any(|a| a == para_id) {
            return Err("Vocês já são amigos.");
        }
        if de.pedidos_amigo.iter().any(|p| p.de == para_id) {
            self.responder_pedido_amigo(&de.id, para_id, true).await?;
            return Ok(true);
        }

        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let Some(alvo) = e.contas.get_mut(para_id) else {
                    return Err("Não existe conta com esse código.");
                };
                if alvo.pedidos_amigo.iter().any(|p| p.de == de.id) {
                    return Ok(false); // ja pedido, nada a fazer de novo
                }
                if alvo.pedidos_amigo.len() >= PEDIDOS_AMIGO_MAX {
                    return Err("Essa pessoa tem pedidos demais pendentes.");
                }
                alvo.pedidos_amigo.push(PedidoAmigo {
                    de: de.id.clone(),
                    apelido: de.apelido.clone(),
                    avatar: de.avatar.clone(),
                    em: agora_ms(),
                });
                e.salvar_contas();
                Ok(false)
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::pedir_amizade(pool, de, para_id).await,
        }
    }

    /// Aceita ou recusa um pedido pendente. `id` e quem esta respondendo;
    /// `de_id` e quem mandou o pedido original.
    pub async fn responder_pedido_amigo(&self, id: &str, de_id: &str, aceitar: bool) -> Result<(), &'static str> {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let existia = e
                    .contas
                    .get(id)
                    .map(|c| c.pedidos_amigo.iter().any(|p| p.de == de_id))
                    .unwrap_or(false);
                if !existia {
                    return Err("Esse pedido não existe mais.");
                }
                if let Some(minha) = e.contas.get_mut(id) {
                    minha.pedidos_amigo.retain(|p| p.de != de_id);
                    if aceitar && !minha.amigos.iter().any(|a| a == de_id) {
                        minha.amigos.push(de_id.to_string());
                    }
                }
                if aceitar {
                    if let Some(outra) = e.contas.get_mut(de_id) {
                        if !outra.amigos.iter().any(|a| a == id) {
                            outra.amigos.push(id.to_string());
                        }
                    }
                }
                e.salvar_contas();
                Ok(())
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::responder_pedido_amigo(pool, id, de_id, aceitar).await,
        }
    }

    /// Desfaz uma amizade dos dois lados. `true` quando havia o que desfazer.
    pub async fn remover_amigo(&self, id: &str, amigo_id: &str) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let tinha = e
                    .contas
                    .get(id)
                    .map(|c| c.amigos.iter().any(|a| a == amigo_id))
                    .unwrap_or(false);
                if !tinha {
                    return false;
                }
                if let Some(minha) = e.contas.get_mut(id) {
                    minha.amigos.retain(|a| a != amigo_id);
                }
                if let Some(outra) = e.contas.get_mut(amigo_id) {
                    outra.amigos.retain(|a| a != id);
                }
                e.salvar_contas();
                true
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::remover_amigo(pool, id, amigo_id).await,
        }
    }

    /// Abre uma sessao e devolve o token em claro — a unica vez em que ele
    /// existe fora do cliente.
    pub async fn abrir_sessao(&self, conta: &str) -> String {
        let token = sortear(40);
        let marca = marca_do_token(&token);
        let expira = agora_ms() + SESSAO_MS;

        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                e.sessoes.insert(
                    marca.clone(),
                    Sessao {
                        marca,
                        conta: conta.to_string(),
                        expira,
                    },
                );
                e.limpar_sessoes_vencidas();
                e.salvar_sessoes();
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::abrir_sessao(pool, &marca, conta, expira).await,
        }
        token
    }

    pub async fn fechar_sessao(&self, token: &str) {
        let marca = marca_do_token(token);
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                if e.sessoes.remove(&marca).is_some() {
                    e.salvar_sessoes();
                }
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::fechar_sessao(pool, &marca).await,
        }
    }

    /// Conta dona do token, quando ele existe e ainda vale.
    pub async fn conta_do_token(&self, token: &str) -> Option<Conta> {
        let marca = marca_do_token(token);
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let e = estado.lock().unwrap();
                let sessao = e.sessoes.get(&marca)?;
                if sessao.expira <= agora_ms() {
                    return None;
                }
                e.contas.get(&sessao.conta).cloned()
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::conta_do_token(pool, &marca).await,
        }
    }
}

/* ─── Backend de arquivo ──────────────────────────────────────────────── */

/// `contas.json` — as contas. Muda quando alguem se cadastra ou edita o
/// perfil, e e reescrito inteiro, por temporario e rename.
///
/// `sessoes.json` — os tokens vivos. Muda a cada entrada e a cada saida. Fica
/// separado para que perde-lo custe uma tela de login, e nao as contas.
struct EstadoArquivo {
    contas: HashMap<String, Conta>, // id -> conta
    por_email: HashMap<String, String>,
    por_google: HashMap<String, String>,
    sessoes: HashMap<String, Sessao>, // marca -> sessao
    /// conta_id -> sons da biblioteca pessoal dela.
    sons_pessoais: HashMap<String, Vec<SomPessoal>>,
    /// id do som -> bytes. Sempre em memoria, como os blobs de grupo em
    /// `modelo::Acervo`.
    blobs: HashMap<String, Vec<u8>>,
    /// conta_id -> relatos que ela enviou.
    feedback: HashMap<String, Vec<Feedback>>,
    pasta: Option<PathBuf>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Sessao {
    /// Impressao do token, e nao o token. Quem le `sessoes.json` num backup
    /// esquecido nao entra na conta de ninguem com o que encontra ali.
    marca: String,
    conta: String,
    expira: u64,
}

impl EstadoArquivo {
    fn carregar(pasta: Option<PathBuf>) -> Self {
        let mut estado = EstadoArquivo {
            contas: HashMap::new(),
            por_email: HashMap::new(),
            por_google: HashMap::new(),
            sessoes: HashMap::new(),
            sons_pessoais: HashMap::new(),
            blobs: HashMap::new(),
            feedback: HashMap::new(),
            pasta: pasta.clone(),
        };

        let Some(pasta) = pasta else {
            return estado;
        };

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("contas.json")) {
            match serde_json::from_str::<Vec<Conta>>(&bruto) {
                Ok(lista) => {
                    for conta in lista {
                        estado.indexar(conta);
                    }
                }
                // Comecar sem contas e ruim; derrubar o servidor e pior, e
                // impediria ate quem entra sem conta de conversar.
                Err(e) => eprintln!("[contas] contas.json ilegivel: {e}"),
            }
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("sessoes.json")) {
            if let Ok(lista) = serde_json::from_str::<Vec<Sessao>>(&bruto) {
                let agora = agora_ms();
                for s in lista {
                    if s.expira > agora && estado.contas.contains_key(&s.conta) {
                        estado.sessoes.insert(s.marca.clone(), s);
                    }
                }
            }
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("sons_pessoais.json")) {
            match serde_json::from_str::<HashMap<String, Vec<SomPessoal>>>(&bruto) {
                Ok(mapa) => {
                    for lista in mapa.values() {
                        for som in lista {
                            if let Ok(dados) =
                                std::fs::read(pasta.join("sons").join("pessoais").join(&som.id))
                            {
                                estado.blobs.insert(som.id.clone(), dados);
                            }
                        }
                    }
                    estado.sons_pessoais = mapa;
                }
                Err(e) => eprintln!("[contas] sons_pessoais.json ilegivel: {e}"),
            }
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("feedback.json")) {
            match serde_json::from_str::<HashMap<String, Vec<Feedback>>>(&bruto) {
                Ok(mapa) => estado.feedback = mapa,
                Err(e) => eprintln!("[contas] feedback.json ilegivel: {e}"),
            }
        }

        println!(
            "[contas] arquivo local: {} conta(s), {} sessao(oes) viva(s), {} som(ns) pessoal(is)",
            estado.contas.len(),
            estado.sessoes.len(),
            estado.blobs.len()
        );
        estado
    }

    fn indexar(&mut self, conta: Conta) {
        self.por_email.insert(conta.email.clone(), conta.id.clone());
        if !conta.google.is_empty() {
            self.por_google.insert(conta.google.clone(), conta.id.clone());
        }
        self.contas.insert(conta.id.clone(), conta);
    }

    fn salvar_contas(&self) {
        let Some(pasta) = &self.pasta else { return };
        let lista: Vec<&Conta> = self.contas.values().collect();
        match serde_json::to_string(&lista) {
            Ok(corpo) => {
                if let Err(e) = gravar_atomico(&pasta.join("contas.json"), &corpo) {
                    eprintln!("[contas] falha ao salvar contas: {e}");
                }
            }
            Err(e) => eprintln!("[contas] contas nao serializaveis: {e}"),
        }
    }

    fn salvar_sessoes(&self) {
        let Some(pasta) = &self.pasta else { return };
        let lista: Vec<&Sessao> = self.sessoes.values().collect();
        if let Ok(corpo) = serde_json::to_string(&lista) {
            if let Err(e) = gravar_atomico(&pasta.join("sessoes.json"), &corpo) {
                eprintln!("[contas] falha ao salvar sessoes: {e}");
            }
        }
    }

    fn limpar_sessoes_vencidas(&mut self) {
        let agora = agora_ms();
        self.sessoes.retain(|_, s| s.expira > agora);
    }

    fn salvar_sons_pessoais(&self) {
        let Some(pasta) = &self.pasta else { return };
        match serde_json::to_string(&self.sons_pessoais) {
            Ok(corpo) => {
                if let Err(e) = gravar_atomico(&pasta.join("sons_pessoais.json"), &corpo) {
                    eprintln!("[contas] falha ao salvar sons pessoais: {e}");
                }
            }
            Err(e) => eprintln!("[contas] sons pessoais nao serializaveis: {e}"),
        }
    }

    fn adicionar_som_pessoal(
        &mut self,
        conta_id: &str,
        nome: String,
        mime: String,
        dados: Vec<u8>,
    ) -> Result<SomPessoal, &'static str> {
        if dados.len() > SOM_BYTES_MAX {
            return Err("Esse som passa do tamanho máximo (300 KB).");
        }
        if dados.is_empty() {
            return Err("Som vazio.");
        }
        let lista = self.sons_pessoais.entry(conta_id.to_string()).or_default();
        if lista.len() >= SONS_PESSOAIS_MAX {
            return Err("Sua biblioteca pessoal já tem sons demais (3).");
        }

        let som = SomPessoal {
            id: novo_id(),
            nome: nome.chars().take(SOM_NOME_MAX).collect(),
            mime,
            bytes: dados.len() as u64,
            criado_em: agora_ms(),
        };

        if let Some(pasta) = &self.pasta {
            let pasta_conta = pasta.join("sons").join("pessoais");
            if std::fs::create_dir_all(&pasta_conta).is_ok() {
                if let Err(e) = std::fs::write(pasta_conta.join(&som.id), &dados) {
                    eprintln!("[contas] falha ao gravar som pessoal {}: {e}", som.id);
                }
            }
        }
        self.blobs.insert(som.id.clone(), dados);
        lista.push(som.clone());
        self.salvar_sons_pessoais();
        Ok(som)
    }

    fn remover_som_pessoal(&mut self, conta_id: &str, id: &str) -> bool {
        let Some(lista) = self.sons_pessoais.get_mut(conta_id) else {
            return false;
        };
        let Some(posicao) = lista.iter().position(|s| s.id == id) else {
            return false;
        };
        let som = lista.remove(posicao);
        self.blobs.remove(&som.id);
        if let Some(pasta) = &self.pasta {
            let _ = std::fs::remove_file(pasta.join("sons").join("pessoais").join(&som.id));
        }
        self.salvar_sons_pessoais();
        true
    }

    fn salvar_feedback(&self) {
        let Some(pasta) = &self.pasta else { return };
        match serde_json::to_string(&self.feedback) {
            Ok(corpo) => {
                if let Err(e) = gravar_atomico(&pasta.join("feedback.json"), &corpo) {
                    eprintln!("[contas] falha ao salvar feedback: {e}");
                }
            }
            Err(e) => eprintln!("[contas] feedback nao serializavel: {e}"),
        }
    }

    fn enviar_feedback(
        &mut self,
        de: &Conta,
        categoria: String,
        titulo: String,
        descricao: String,
    ) -> Result<Feedback, &'static str> {
        let lista = self.feedback.entry(de.id.clone()).or_default();
        if lista.len() >= FEEDBACK_POR_CONTA_MAX {
            return Err("Você já enviou relatos demais — tente reaproveitar um existente.");
        }
        let agora = agora_ms();
        let feedback = Feedback {
            id: novo_id(),
            conta_id: de.id.clone(),
            apelido: de.apelido.clone(),
            categoria,
            titulo,
            descricao,
            status: "recebido".to_string(),
            criado_em: agora,
            atualizado_em: agora,
        };
        lista.push(feedback.clone());
        self.salvar_feedback();
        Ok(feedback)
    }

    fn feedback_de(&self, conta_id: &str) -> Vec<Feedback> {
        let mut lista = self.feedback.get(conta_id).cloned().unwrap_or_default();
        lista.sort_by(|a, b| b.criado_em.cmp(&a.criado_em));
        lista
    }

    fn mudar_status_feedback(&mut self, id: &str, status: &str) -> Option<Feedback> {
        let item = self.feedback.values_mut().flatten().find(|f| f.id == id)?;
        item.status = status.to_string();
        item.atualizado_em = agora_ms();
        let atualizado = item.clone();
        self.salvar_feedback();
        Some(atualizado)
    }
}

/* ─── Backend Postgres ────────────────────────────────────────────────── */

#[cfg(feature = "banco")]
mod postgres {
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;
    use std::path::Path;

    use super::{Atalho, Conta, Feedback, PedidoAmigo, PreferenciaSom, Recusa, SomPessoal};
    use crate::modelo::{agora_ms, novo_id};

    /// (id, email, senha, google, apelido, avatar, bio, criada_em,
    ///  som_entrada_origem, som_entrada_grupo, som_entrada_id)
    type LinhaConta = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn montar(linha: LinhaConta, atalhos: Vec<Atalho>, amigos: Vec<String>, pedidos_amigo: Vec<PedidoAmigo>) -> Conta {
        let (id, email, senha, google, apelido, avatar, bio, criada_em, som_origem, som_grupo, som_id) = linha;
        let som_entrada = som_origem.zip(som_id).map(|(origem, id)| PreferenciaSom {
            origem,
            grupo: som_grupo,
            id,
        });
        Conta {
            id,
            email,
            senha,
            google: google.unwrap_or_default(),
            apelido,
            avatar,
            bio,
            atalhos,
            som_entrada,
            amigos,
            pedidos_amigo,
            criada_em: criada_em as u64,
        }
    }

    async fn amigos_de(pool: &PgPool, conta_id: &str) -> Vec<String> {
        sqlx::query_as::<_, (String,)>("SELECT amigo_id FROM amigos WHERE conta_id = $1 ORDER BY amigo_id")
            .bind(conta_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(id,)| id)
            .collect()
    }

    async fn pedidos_amigo_de(pool: &PgPool, conta_id: &str) -> Vec<PedidoAmigo> {
        sqlx::query_as::<_, (String, String, String, i64)>(
            "SELECT de_id, apelido, avatar, em FROM pedidos_amigo WHERE conta_id = $1 ORDER BY em",
        )
        .bind(conta_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(de, apelido, avatar, em)| PedidoAmigo {
            de,
            apelido,
            avatar,
            em: em as u64,
        })
        .collect()
    }

    /// Manda um pedido de amizade, ou fecha direto se `para_id` ja tinha
    /// mandado um antes — mesma logica do backend de arquivo, so que aqui a
    /// checagem do reciproco e uma consulta em vez de um campo em memoria.
    pub async fn pedir_amizade(pool: &PgPool, de: &Conta, para_id: &str) -> Result<bool, &'static str> {
        let reciproco: Option<(String,)> =
            sqlx::query_as("SELECT de_id FROM pedidos_amigo WHERE conta_id = $1 AND de_id = $2")
                .bind(&de.id)
                .bind(para_id)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
        if reciproco.is_some() {
            responder_pedido_amigo(pool, &de.id, para_id, true).await?;
            return Ok(true);
        }

        let existe: (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM contas WHERE id = $1)")
            .bind(para_id)
            .fetch_one(pool)
            .await
            .unwrap_or((false,));
        if !existe.0 {
            return Err("Não existe conta com esse código.");
        }

        let ja_pedido: (bool,) =
            sqlx::query_as("SELECT EXISTS(SELECT 1 FROM pedidos_amigo WHERE conta_id = $1 AND de_id = $2)")
                .bind(para_id)
                .bind(&de.id)
                .fetch_one(pool)
                .await
                .unwrap_or((false,));
        if ja_pedido.0 {
            return Ok(false);
        }

        let contagem: (i64,) = sqlx::query_as("SELECT count(*) FROM pedidos_amigo WHERE conta_id = $1")
            .bind(para_id)
            .fetch_one(pool)
            .await
            .unwrap_or((0,));
        if contagem.0 as usize >= super::PEDIDOS_AMIGO_MAX {
            return Err("Essa pessoa tem pedidos demais pendentes.");
        }

        let _ = sqlx::query(
            "INSERT INTO pedidos_amigo (conta_id, de_id, apelido, avatar, em) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (conta_id, de_id) DO NOTHING",
        )
        .bind(para_id)
        .bind(&de.id)
        .bind(&de.apelido)
        .bind(&de.avatar)
        .bind(agora_ms() as i64)
        .execute(pool)
        .await;

        Ok(false)
    }

    pub async fn responder_pedido_amigo(
        pool: &PgPool,
        id: &str,
        de_id: &str,
        aceitar: bool,
    ) -> Result<(), &'static str> {
        let apagado = sqlx::query("DELETE FROM pedidos_amigo WHERE conta_id = $1 AND de_id = $2")
            .bind(id)
            .bind(de_id)
            .execute(pool)
            .await;
        let Ok(apagado) = apagado else {
            return Err("Não foi possível responder agora.");
        };
        if apagado.rows_affected() == 0 {
            return Err("Esse pedido não existe mais.");
        }
        if aceitar {
            let _ = sqlx::query(
                "INSERT INTO amigos (conta_id, amigo_id) VALUES ($1, $2), ($2, $1)
                 ON CONFLICT DO NOTHING",
            )
            .bind(id)
            .bind(de_id)
            .execute(pool)
            .await;
        }
        Ok(())
    }

    pub async fn remover_amigo(pool: &PgPool, id: &str, amigo_id: &str) -> bool {
        let resultado = sqlx::query(
            "DELETE FROM amigos WHERE (conta_id = $1 AND amigo_id = $2) OR (conta_id = $2 AND amigo_id = $1)",
        )
        .bind(id)
        .bind(amigo_id)
        .execute(pool)
        .await;
        matches!(resultado, Ok(r) if r.rows_affected() > 0)
    }

    const COLUNAS: &str = "id, email, senha, google, apelido, avatar, bio, criada_em, \
        som_entrada_origem, som_entrada_grupo, som_entrada_id";

    async fn atalhos_de(pool: &PgPool, conta_id: &str) -> Vec<Atalho> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT codigo, nome, foto FROM atalhos WHERE conta_id = $1 ORDER BY codigo",
        )
            .bind(conta_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(codigo, nome, foto)| Atalho { codigo, nome, foto })
            .collect()
    }

    /// Conecta, roda as migracoes embutidas e importa o par de arquivos
    /// antigo, se houver um. Chamado uma vez, na partida.
    pub async fn conectar(url: &str, pasta: Option<&Path>) -> Result<PgPool, sqlx::Error> {
        let pool = PgPoolOptions::new().max_connections(5).connect(url).await?;

        sqlx::migrate!("./migracoes").run(&pool).await?;
        importar_arquivo_antigo(&pool, pasta).await;

        println!("[contas] usando Postgres");
        Ok(pool)
    }

    /// Le `contas.json`/`sessoes.json`, se existirem no volume, e importa
    /// para o banco — uma vez so, e sem pisar em nada.
    ///
    /// A condicao de guarda e "a tabela esta vazia": e o que torna isto
    /// idempotente sem precisar de uma flag ou de uma tabela de controle a
    /// mais. Rodar de novo com contas ja cadastradas no Postgres nao faz
    /// nada — inclusive se o arquivo antigo ainda estiver la, esquecido.
    async fn importar_arquivo_antigo(pool: &PgPool, pasta: Option<&Path>) {
        let Some(pasta) = pasta else { return };

        let contagem: Result<(i64,), _> = sqlx::query_as("SELECT count(*) FROM contas").fetch_one(pool).await;
        match contagem {
            Ok((0,)) => {}
            Ok(_) => return, // ja tem gente cadastrada: nada a importar
            Err(e) => {
                eprintln!("[contas] nao foi possivel conferir a tabela antes de importar: {e}");
                return;
            }
        }

        let Ok(bruto) = std::fs::read_to_string(pasta.join("contas.json")) else {
            return;
        };
        let Ok(lista) = serde_json::from_str::<Vec<Conta>>(&bruto) else {
            return;
        };
        if lista.is_empty() {
            return;
        }

        println!("[contas] importando {} conta(s) do arquivo antigo para o Postgres", lista.len());
        for conta in &lista {
            let google = (!conta.google.is_empty()).then(|| conta.google.clone());
            let r = sqlx::query(
                "INSERT INTO contas (id, email, senha, google, apelido, avatar, bio, criada_em)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(&conta.id)
            .bind(&conta.email)
            .bind(&conta.senha)
            .bind(&google)
            .bind(&conta.apelido)
            .bind(&conta.avatar)
            .bind(&conta.bio)
            .bind(conta.criada_em as i64)
            .execute(pool)
            .await;

            if let Err(e) = r {
                eprintln!("[contas] falha ao importar {}: {e}", conta.email);
                continue;
            }
            for atalho in &conta.atalhos {
                let _ = sqlx::query(
                    "INSERT INTO atalhos (conta_id, codigo, nome, foto) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (conta_id, codigo) DO NOTHING",
                )
                .bind(&conta.id)
                .bind(&atalho.codigo)
                .bind(&atalho.nome)
                .bind(&atalho.foto)
                .execute(pool)
                .await;
            }
        }

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("sessoes.json")) {
            #[derive(serde::Deserialize)]
            struct SessaoArquivo {
                marca: String,
                conta: String,
                expira: u64,
            }
            if let Ok(lista) = serde_json::from_str::<Vec<SessaoArquivo>>(&bruto) {
                let agora = agora_ms();
                let mut importadas = 0;
                for s in lista {
                    if s.expira <= agora {
                        continue;
                    }
                    let r = sqlx::query(
                        "INSERT INTO sessoes (marca, conta_id, expira) VALUES ($1, $2, $3)
                         ON CONFLICT (marca) DO NOTHING",
                    )
                    .bind(&s.marca)
                    .bind(&s.conta)
                    .bind(s.expira as i64)
                    .execute(pool)
                    .await;
                    if r.is_ok() {
                        importadas += 1;
                    }
                }
                if importadas > 0 {
                    println!("[contas] {importadas} sessao(oes) viva(s) importada(s)");
                }
            }
        }

        println!("[contas] importacao concluida");
    }

    pub async fn por_id(pool: &PgPool, id: &str) -> Option<Conta> {
        let linha: LinhaConta = sqlx::query_as(&format!("SELECT {COLUNAS} FROM contas WHERE id = $1"))
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()??;
        let atalhos = atalhos_de(pool, id).await;
        let amigos = amigos_de(pool, id).await;
        let pedidos_amigo = pedidos_amigo_de(pool, id).await;
        Some(montar(linha, atalhos, amigos, pedidos_amigo))
    }

    pub async fn hash_de(pool: &PgPool, email: &str) -> Option<(String, String)> {
        sqlx::query_as::<_, (String, String)>("SELECT id, senha FROM contas WHERE email = $1")
            .bind(email)
            .fetch_optional(pool)
            .await
            .ok()?
    }

    pub async fn email_ocupado(pool: &PgPool, email: &str) -> bool {
        sqlx::query_as::<_, (bool,)>("SELECT EXISTS(SELECT 1 FROM contas WHERE email = $1)")
            .bind(email)
            .fetch_one(pool)
            .await
            .map(|(existe,)| existe)
            .unwrap_or(false)
    }

    pub async fn cadastrar(
        pool: &PgPool,
        email: String,
        hash: String,
        apelido: String,
        avatar: String,
        bio: String,
    ) -> Result<String, Recusa> {
        let id = format!("conta-{}", novo_id());
        let criada_em = agora_ms() as i64;

        // Um INSERT so: a UNIQUE do e-mail e quem decide a corrida entre duas
        // pessoas cadastrando o mesmo endereco ao mesmo tempo, sem o
        // checar-e-inserir em dois passos que o arquivo precisa.
        let resultado: Result<Option<(String,)>, _> = sqlx::query_as(
            "INSERT INTO contas (id, email, senha, apelido, avatar, bio, criada_em)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (email) DO NOTHING
             RETURNING id",
        )
        .bind(&id)
        .bind(&email)
        .bind(&hash)
        .bind(&apelido)
        .bind(&avatar)
        .bind(&bio)
        .bind(criada_em)
        .fetch_optional(pool)
        .await;

        match resultado {
            Ok(Some((id,))) => Ok(id),
            Ok(None) => Err(Recusa {
                campo: "email",
                motivo: "Já existe uma conta com este e-mail.".into(),
            }),
            Err(e) => {
                eprintln!("[contas] falha ao cadastrar: {e}");
                Err(Recusa {
                    campo: "email",
                    motivo: "Não foi possível criar a conta agora.".into(),
                })
            }
        }
    }

    pub async fn pelo_google(pool: &PgPool, sub: &str, email: &str, nome: &str, avatar_sugerido: &str) -> String {
        if let Ok(Some((id,))) = sqlx::query_as::<_, (String,)>("SELECT id FROM contas WHERE google = $1")
            .bind(sub)
            .fetch_optional(pool)
            .await
        {
            return id;
        }

        let novo = format!("conta-{}", novo_id());
        let criada_em = agora_ms() as i64;

        // Um upsert so: se o e-mail ja existe (conta criada com senha antes),
        // so o `google` dela e atualizado -- apelido, mascote e bio da conta
        // que ja existia continuam intocados, do jeito que o backend de
        // arquivo tambem faz.
        let resultado: Result<(String,), _> = sqlx::query_as(
            "INSERT INTO contas (id, email, google, apelido, avatar, bio, criada_em)
             VALUES ($1, $2, $3, $4, $5, '', $6)
             ON CONFLICT (email) DO UPDATE SET google = EXCLUDED.google
             RETURNING id",
        )
        .bind(&novo)
        .bind(email)
        .bind(sub)
        .bind(nome)
        .bind(avatar_sugerido)
        .bind(criada_em)
        .fetch_one(pool)
        .await;

        match resultado {
            Ok((id,)) => id,
            Err(e) => {
                eprintln!("[contas] falha ao vincular Google: {e}");
                novo
            }
        }
    }

    pub async fn guardar_perfil(
        pool: &PgPool,
        id: &str,
        apelido: Option<String>,
        avatar: Option<String>,
        bio: Option<String>,
        atalhos: Option<Vec<Atalho>>,
    ) -> bool {
        // Apelido vazio e "nao mudei o apelido", igual ao arquivo -- os
        // outros dois campos aceitam ate string vazia.
        let apelido = apelido.filter(|v| !v.is_empty());
        let resultado = sqlx::query(
            "UPDATE contas SET
                apelido = COALESCE($2, apelido),
                avatar  = COALESCE($3, avatar),
                bio     = COALESCE($4, bio)
             WHERE id = $1",
        )
        .bind(id)
        .bind(&apelido)
        .bind(&avatar)
        .bind(&bio)
        .execute(pool)
        .await;

        let Ok(resultado) = resultado else { return false };
        if resultado.rows_affected() == 0 {
            return false;
        }

        if let Some(lista) = atalhos {
            let _ = sqlx::query("DELETE FROM atalhos WHERE conta_id = $1").bind(id).execute(pool).await;
            for a in &lista {
                let _ = sqlx::query(
                    "INSERT INTO atalhos (conta_id, codigo, nome, foto) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (conta_id, codigo) DO UPDATE
                     SET nome = EXCLUDED.nome, foto = EXCLUDED.foto",
                )
                .bind(id)
                .bind(&a.codigo)
                .bind(&a.nome)
                .bind(&a.foto)
                .execute(pool)
                .await;
            }
        }
        true
    }

    pub async fn lembrar_grupo(pool: &PgPool, id: &str, codigo: &str, nome: &str, foto: &str) -> bool {
        let resultado = sqlx::query(
            "INSERT INTO atalhos (conta_id, codigo, nome, foto) VALUES ($1, $2, $3, $4)
             ON CONFLICT (conta_id, codigo) DO UPDATE
             SET nome = EXCLUDED.nome, foto = EXCLUDED.foto
             WHERE atalhos.nome IS DISTINCT FROM EXCLUDED.nome
                OR atalhos.foto IS DISTINCT FROM EXCLUDED.foto",
        )
        .bind(id)
        .bind(codigo)
        .bind(nome)
        .bind(foto)
        .execute(pool)
        .await;

        matches!(resultado, Ok(r) if r.rows_affected() > 0)
    }

    pub async fn sons_pessoais_de(pool: &PgPool, conta_id: &str) -> Vec<SomPessoal> {
        sqlx::query_as::<_, (String, String, String, i64, i64)>(
            "SELECT id, nome, mime, length(dados)::bigint, criado_em
             FROM sons_pessoais WHERE conta_id = $1 ORDER BY criado_em",
        )
        .bind(conta_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(id, nome, mime, bytes, criado_em)| SomPessoal {
            id,
            nome,
            mime,
            bytes: bytes as u64,
            criado_em: criado_em as u64,
        })
        .collect()
    }

    pub async fn bytes_de_som_pessoal(pool: &PgPool, conta_id: &str, id: &str) -> Option<Vec<u8>> {
        sqlx::query_as::<_, (Vec<u8>,)>("SELECT dados FROM sons_pessoais WHERE id = $1 AND conta_id = $2")
            .bind(id)
            .bind(conta_id)
            .fetch_optional(pool)
            .await
            .ok()?
            .map(|(dados,)| dados)
    }

    pub async fn adicionar_som_pessoal(
        pool: &PgPool,
        conta_id: &str,
        nome: String,
        mime: String,
        dados: Vec<u8>,
    ) -> Result<SomPessoal, &'static str> {
        if dados.len() > crate::modelo::SOM_BYTES_MAX {
            return Err("Esse som passa do tamanho máximo (300 KB).");
        }
        if dados.is_empty() {
            return Err("Som vazio.");
        }

        let contagem: (i64,) = sqlx::query_as("SELECT count(*) FROM sons_pessoais WHERE conta_id = $1")
            .bind(conta_id)
            .fetch_one(pool)
            .await
            .unwrap_or((0,));
        if contagem.0 as usize >= super::SONS_PESSOAIS_MAX {
            return Err("Sua biblioteca pessoal já tem sons demais (3).");
        }

        let id = novo_id();
        let nome: String = nome.chars().take(crate::modelo::SOM_NOME_MAX).collect();
        let criado_em = agora_ms() as i64;
        let bytes = dados.len() as u64;

        let resultado = sqlx::query(
            "INSERT INTO sons_pessoais (id, conta_id, nome, mime, dados, criado_em)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&id)
        .bind(conta_id)
        .bind(&nome)
        .bind(&mime)
        .bind(&dados)
        .bind(criado_em)
        .execute(pool)
        .await;

        match resultado {
            Ok(_) => Ok(SomPessoal {
                id,
                nome,
                mime,
                bytes,
                criado_em: criado_em as u64,
            }),
            Err(e) => {
                eprintln!("[contas] falha ao gravar som pessoal: {e}");
                Err("Não foi possível guardar o som agora.")
            }
        }
    }

    pub async fn remover_som_pessoal(pool: &PgPool, conta_id: &str, id: &str) -> bool {
        let resultado = sqlx::query("DELETE FROM sons_pessoais WHERE id = $1 AND conta_id = $2")
            .bind(id)
            .bind(conta_id)
            .execute(pool)
            .await;
        matches!(resultado, Ok(r) if r.rows_affected() > 0)
    }

    pub async fn enviar_feedback(
        pool: &PgPool,
        de: &Conta,
        categoria: String,
        titulo: String,
        descricao: String,
    ) -> Result<Feedback, &'static str> {
        let contagem: (i64,) = sqlx::query_as("SELECT count(*) FROM feedback WHERE conta_id = $1")
            .bind(&de.id)
            .fetch_one(pool)
            .await
            .unwrap_or((0,));
        if contagem.0 as usize >= super::FEEDBACK_POR_CONTA_MAX {
            return Err("Você já enviou relatos demais — tente reaproveitar um existente.");
        }

        let id = novo_id();
        let agora = agora_ms() as i64;
        let resultado = sqlx::query(
            "INSERT INTO feedback (id, conta_id, apelido, categoria, titulo, descricao, status, criado_em, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, $6, 'recebido', $7, $7)",
        )
        .bind(&id)
        .bind(&de.id)
        .bind(&de.apelido)
        .bind(&categoria)
        .bind(&titulo)
        .bind(&descricao)
        .bind(agora)
        .execute(pool)
        .await;

        match resultado {
            Ok(_) => Ok(Feedback {
                id,
                conta_id: de.id.clone(),
                apelido: de.apelido.clone(),
                categoria,
                titulo,
                descricao,
                status: "recebido".to_string(),
                criado_em: agora as u64,
                atualizado_em: agora as u64,
            }),
            Err(e) => {
                eprintln!("[contas] falha ao gravar feedback: {e}");
                Err("Não foi possível enviar agora.")
            }
        }
    }

    pub async fn feedback_de(pool: &PgPool, conta_id: &str) -> Vec<Feedback> {
        sqlx::query_as::<_, (String, String, String, String, String, String, String, i64, i64)>(
            "SELECT id, conta_id, apelido, categoria, titulo, descricao, status, criado_em, atualizado_em
             FROM feedback WHERE conta_id = $1 ORDER BY criado_em DESC",
        )
        .bind(conta_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(montar_feedback)
        .collect()
    }

    pub async fn todos_feedbacks(pool: &PgPool) -> Vec<Feedback> {
        sqlx::query_as::<_, (String, String, String, String, String, String, String, i64, i64)>(
            "SELECT id, conta_id, apelido, categoria, titulo, descricao, status, criado_em, atualizado_em
             FROM feedback ORDER BY criado_em DESC",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(montar_feedback)
        .collect()
    }

    pub async fn mudar_status_feedback(pool: &PgPool, id: &str, status: &str) -> Option<Feedback> {
        let agora = agora_ms() as i64;
        let linha = sqlx::query_as::<_, (String, String, String, String, String, String, String, i64, i64)>(
            "UPDATE feedback SET status = $1, atualizado_em = $2 WHERE id = $3
             RETURNING id, conta_id, apelido, categoria, titulo, descricao, status, criado_em, atualizado_em",
        )
        .bind(status)
        .bind(agora)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()??;
        Some(montar_feedback(linha))
    }

    fn montar_feedback(
        linha: (String, String, String, String, String, String, String, i64, i64),
    ) -> Feedback {
        let (id, conta_id, apelido, categoria, titulo, descricao, status, criado_em, atualizado_em) = linha;
        Feedback {
            id,
            conta_id,
            apelido,
            categoria,
            titulo,
            descricao,
            status,
            criado_em: criado_em as u64,
            atualizado_em: atualizado_em as u64,
        }
    }

    pub async fn guardar_som_entrada(pool: &PgPool, conta_id: &str, preferencia: Option<PreferenciaSom>) -> bool {
        let (origem, grupo, id) = match preferencia {
            Some(p) => (Some(p.origem), p.grupo, Some(p.id)),
            None => (None, None, None),
        };
        let resultado = sqlx::query(
            "UPDATE contas SET som_entrada_origem = $2, som_entrada_grupo = $3, som_entrada_id = $4
             WHERE id = $1",
        )
        .bind(conta_id)
        .bind(&origem)
        .bind(&grupo)
        .bind(&id)
        .execute(pool)
        .await;
        matches!(resultado, Ok(r) if r.rows_affected() > 0)
    }

    pub async fn abrir_sessao(pool: &PgPool, marca: &str, conta: &str, expira: u64) {
        let _ = sqlx::query("INSERT INTO sessoes (marca, conta_id, expira) VALUES ($1, $2, $3)")
            .bind(marca)
            .bind(conta)
            .bind(expira as i64)
            .execute(pool)
            .await;
    }

    pub async fn fechar_sessao(pool: &PgPool, marca: &str) {
        let _ = sqlx::query("DELETE FROM sessoes WHERE marca = $1").bind(marca).execute(pool).await;
    }

    pub async fn conta_do_token(pool: &PgPool, marca: &str) -> Option<Conta> {
        let colunas_com_prefixo = "c.id, c.email, c.senha, c.google, c.apelido, c.avatar, c.bio, c.criada_em, \
            c.som_entrada_origem, c.som_entrada_grupo, c.som_entrada_id";
        let agora = agora_ms() as i64;
        let linha: LinhaConta = sqlx::query_as(&format!(
            "SELECT {colunas_com_prefixo} FROM sessoes s
             JOIN contas c ON c.id = s.conta_id
             WHERE s.marca = $1 AND s.expira > $2"
        ))
        .bind(marca)
        .bind(agora)
        .fetch_optional(pool)
        .await
        .ok()??;

        let atalhos = atalhos_de(pool, &linha.0).await;
        let amigos = amigos_de(pool, &linha.0).await;
        let pedidos_amigo = pedidos_amigo_de(pool, &linha.0).await;
        Some(montar(linha, atalhos, amigos, pedidos_amigo))
    }
}

/* ─── Senha ───────────────────────────────────────────────────────────── */

/// Hash de senha. Custa dezenas de milissegundos por chamada, o que e o
/// ponto: e o que separa "vazaram os hashes" de "vazaram as senhas".
///
/// Roda fora da tranca do estado, numa tarefa bloqueante — segurar o mutex
/// por 50 ms a cada login pararia o encaminhamento de voz de todo mundo.
pub fn cifrar(senha: &str) -> Result<String, String> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    use argon2::Argon2;

    let sal = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(senha.as_bytes(), &sal)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Confere a senha contra o hash guardado.
///
/// Um hash vazio — conta que so entra pelo Google, ou e-mail que nao existe —
/// sempre recusa, e ainda assim gasta o mesmo tempo de um hash de verdade:
/// sem isso, o relogio diria a quem tentasse quais e-mails tem conta.
pub fn conferir(senha: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;

    let alvo = if hash.is_empty() { hash_falso() } else { hash };
    let Ok(analisado) = PasswordHash::new(alvo) else {
        return false;
    };
    let confere = Argon2::default()
        .verify_password(senha.as_bytes(), &analisado)
        .is_ok();
    confere && !hash.is_empty()
}

/// Hash de uma senha que ninguem tem — nem quem escreveu isto, porque ela e
/// sorteada na primeira vez que alguem erra um e-mail. Serve so para gastar o
/// mesmo tempo de uma verificacao de verdade.
///
/// Calculado em vez de escrito a mao: uma string PHC digitada errada seria
/// recusada pelo analisador e devolveria em microssegundos, que e exatamente
/// o vazamento de tempo que ela existe para tapar.
fn hash_falso() -> &'static str {
    static FALSO: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FALSO.get_or_init(|| cifrar(&sortear(32)).unwrap_or_default())
}

/* ─── Token ───────────────────────────────────────────────────────────── */

fn marca_do_token(token: &str) -> String {
    use blake2::{Blake2s256, Digest};

    let mut digestor = Blake2s256::new();
    digestor.update(token.as_bytes());
    digestor.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/* ─── Validacao ───────────────────────────────────────────────────────── */

/// Normaliza e confere o e-mail.
///
/// Nao e a gramatica do RFC 5322 — ela aceita coisas que nenhum provedor
/// entrega e recusar aqui o que e claramente errado poupa a pessoa de
/// descobrir o engano so na hora de recuperar a senha.
pub fn normalizar_email(bruto: &str) -> Result<String, Recusa> {
    let limpo = bruto.trim().to_lowercase();

    if limpo.is_empty() {
        return Err(recusar("email", "Informe seu e-mail."));
    }
    if limpo.chars().count() > EMAIL_MAX {
        return Err(recusar("email", "E-mail longo demais."));
    }
    if limpo.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(recusar("email", "E-mail não pode conter espaços."));
    }

    let mut partes = limpo.split('@');
    let usuario = partes.next().unwrap_or_default();
    let dominio = partes.next().unwrap_or_default();
    let sobrou = partes.next().is_some();

    let dominio_valido = dominio.contains('.')
        && !dominio.starts_with('.')
        && !dominio.ends_with('.')
        && !dominio.contains("..")
        && dominio.split('.').all(|p| !p.is_empty());

    if sobrou || usuario.is_empty() || !dominio_valido {
        return Err(recusar("email", "Esse e-mail não parece completo."));
    }

    Ok(limpo)
}

pub fn conferir_senha_nova(senha: &str) -> Result<(), Recusa> {
    let tamanho = senha.chars().count();
    if tamanho < SENHA_MIN {
        return Err(recusar(
            "senha",
            &format!("A senha precisa de pelo menos {SENHA_MIN} caracteres."),
        ));
    }
    if tamanho > SENHA_MAX {
        return Err(recusar("senha", "Senha longa demais."));
    }
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn aceita_os_enderecos_que_as_pessoas_tem() {
        assert_eq!(normalizar_email(" Ana@Exemplo.COM ").unwrap(), "ana@exemplo.com");
        assert!(normalizar_email("ana.paula+call@mail.exemplo.com.br").is_ok());
    }

    #[test]
    fn recusa_o_que_nao_chega_a_lugar_nenhum() {
        for ruim in [
            "",
            "ana",
            "ana@",
            "@exemplo.com",
            "ana@exemplo",
            "ana@.com",
            "ana@exemplo..com",
            "ana@exemplo.com.",
            "a n a@exemplo.com",
            "ana@a@exemplo.com",
        ] {
            assert!(normalizar_email(ruim).is_err(), "deveria recusar: {ruim:?}");
        }
    }

    #[test]
    fn a_senha_curta_nao_passa_e_a_de_oito_passa() {
        assert!(conferir_senha_nova("1234567").is_err());
        assert!(conferir_senha_nova("12345678").is_ok());
        assert!(conferir_senha_nova(&"a".repeat(SENHA_MAX + 1)).is_err());
    }

    #[test]
    fn o_hash_confere_a_senha_certa_e_recusa_o_resto() {
        let hash = cifrar("segredo-bom-1").unwrap();
        assert!(conferir("segredo-bom-1", &hash));
        assert!(!conferir("segredo-bom-2", &hash));
        // Conta so-Google: nao ha senha que abra.
        assert!(!conferir("", ""));
        assert!(!conferir("qualquer", ""));
    }

    async fn cofre_de_arquivo() -> Cofre {
        Cofre::carregar(None).await
    }

    #[tokio::test]
    async fn a_sessao_vale_ate_ser_fechada() {
        let cofre = cofre_de_arquivo().await;
        let id = cofre
            .cadastrar(
                "ana@exemplo.com".into(),
                cifrar("segredo-bom-1").unwrap(),
                "Ana".into(),
                "coruja".into(),
                String::new(),
            )
            .await
            .unwrap();

        let token = cofre.abrir_sessao(&id).await;
        assert_eq!(cofre.conta_do_token(&token).await.map(|c| c.id), Some(id));
        cofre.fechar_sessao(&token).await;
        assert!(cofre.conta_do_token(&token).await.is_none());
        assert!(cofre.conta_do_token("token-inventado").await.is_none());
    }

    #[test]
    fn o_castigo_chega_depois_das_falhas_seguidas() {
        let cofre = Cofre {
            armazem: Armazem::Arquivo(Mutex::new(EstadoArquivo::carregar(None))),
            castigo: Mutex::new(HashMap::new()),
        };
        assert_eq!(cofre.castigo_restante("ana@exemplo.com"), 0);
        for _ in 0..FALHAS_ATE_CASTIGO {
            cofre.anotar_falha("ana@exemplo.com");
        }
        assert!(cofre.castigo_restante("ana@exemplo.com") > 0);
        cofre.perdoar("ana@exemplo.com");
        assert_eq!(cofre.castigo_restante("ana@exemplo.com"), 0);
    }

    #[tokio::test]
    async fn o_google_acha_a_conta_que_ja_existia_pelo_email() {
        let cofre = cofre_de_arquivo().await;
        let id = cofre
            .cadastrar(
                "ana@exemplo.com".into(),
                cifrar("segredo-bom-1").unwrap(),
                "Ana".into(),
                String::new(),
                String::new(),
            )
            .await
            .unwrap();

        let achada = cofre.pelo_google("google-123", "ana@exemplo.com", "Ana", "coruja").await;
        assert_eq!(achada, id, "vincular, e nao criar uma segunda conta");
        // Na segunda vez ela vem pelo `sub`, mesmo com outro e-mail.
        assert_eq!(
            cofre.pelo_google("google-123", "outro@exemplo.com", "Ana", "").await,
            id
        );
        // A senha continua valendo depois do vinculo.
        let (_, hash) = cofre.hash_de("ana@exemplo.com").await.unwrap();
        assert!(conferir("segredo-bom-1", &hash));
    }

    #[tokio::test]
    async fn guardar_perfil_ignora_apelido_vazio_mas_aceita_bio_vazia() {
        let cofre = cofre_de_arquivo().await;
        let id = cofre
            .cadastrar(
                "ana@exemplo.com".into(),
                cifrar("segredo-bom-1").unwrap(),
                "Ana".into(),
                "coruja".into(),
                "bio original".into(),
            )
            .await
            .unwrap();

        cofre
            .guardar_perfil(&id, Some(String::new()), None, Some(String::new()), None)
            .await;

        let conta = cofre.por_id(&id).await.unwrap();
        assert_eq!(conta.apelido, "Ana", "apelido vazio nao apaga o que ja existia");
        assert_eq!(conta.avatar, "coruja", "avatar ausente nao muda");
        assert_eq!(conta.bio, "", "bio pode ser esvaziada de proposito");
    }
}

#[cfg(test)]
mod medida {
    /// Quanto custa uma verificacao de senha, em milissegundos.
    ///
    /// Nao e teste: nao ha o que aprovar ou reprovar num numero que depende da
    /// maquina. Fica marcado como ignorado e existe para ser rodado de
    /// proposito, quando alguem quiser rever os parametros do Argon2 ou o
    /// perfil de compilacao:
    ///
    /// ```text
    /// cargo test --release -p sinalizacao -- --ignored --nocapture
    /// ```
    ///
    /// Medido em 07/08/2026, com os parametros padrao (19 MiB, t=2, p=1):
    /// **19 ms por verificacao**. E o custo por tentativa de quem ataca, e a
    /// espera de quem entra. Abaixo de ~10 ms vale subir os parametros; acima
    /// de ~250 ms, a fila de logins comeca a doer antes do atacante.
    #[test]
    #[ignore]
    fn quanto_custa_conferir_uma_senha() {
        const VEZES: u32 = 20;
        let hash = super::cifrar("segredo-bom-1").unwrap();

        let inicio = std::time::Instant::now();
        for _ in 0..VEZES {
            assert!(super::conferir("segredo-bom-1", &hash));
        }
        let media = inicio.elapsed().as_secs_f64() * 1000.0 / f64::from(VEZES);

        println!("Argon2id: {media:.1} ms por verificacao");
    }
}
