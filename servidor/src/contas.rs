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

use crate::modelo::{agora_ms, gravar_atomico, novo_id, sortear};

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
    pub async fn lembrar_grupo(&self, id: &str, codigo: &str, nome: &str) -> bool {
        match &self.armazem {
            Armazem::Arquivo(estado) => {
                let mut e = estado.lock().unwrap();
                let Some(conta) = e.contas.get_mut(id) else {
                    return false;
                };
                match conta.atalhos.iter_mut().find(|a| a.codigo == codigo) {
                    Some(existente) if existente.nome == nome => return false,
                    Some(existente) => existente.nome = nome.to_string(),
                    None => conta.atalhos.push(Atalho {
                        codigo: codigo.to_string(),
                        nome: nome.to_string(),
                    }),
                }
                e.salvar_contas();
                true
            }
            #[cfg(feature = "banco")]
            Armazem::Postgres(pool) => postgres::lembrar_grupo(pool, id, codigo, nome).await,
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

        println!(
            "[contas] arquivo local: {} conta(s), {} sessao(oes) viva(s)",
            estado.contas.len(),
            estado.sessoes.len()
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
}

/* ─── Backend Postgres ────────────────────────────────────────────────── */

#[cfg(feature = "banco")]
mod postgres {
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;
    use std::path::Path;

    use super::{Atalho, Conta, Recusa};
    use crate::modelo::{agora_ms, novo_id};

    /// (id, email, senha, google, apelido, avatar, bio, criada_em)
    type LinhaConta = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        i64,
    );

    fn montar(linha: LinhaConta, atalhos: Vec<Atalho>) -> Conta {
        let (id, email, senha, google, apelido, avatar, bio, criada_em) = linha;
        Conta {
            id,
            email,
            senha,
            google: google.unwrap_or_default(),
            apelido,
            avatar,
            bio,
            atalhos,
            criada_em: criada_em as u64,
        }
    }

    const COLUNAS: &str = "id, email, senha, google, apelido, avatar, bio, criada_em";

    async fn atalhos_de(pool: &PgPool, conta_id: &str) -> Vec<Atalho> {
        sqlx::query_as::<_, (String, String)>("SELECT codigo, nome FROM atalhos WHERE conta_id = $1 ORDER BY codigo")
            .bind(conta_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(codigo, nome)| Atalho { codigo, nome })
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
                    "INSERT INTO atalhos (conta_id, codigo, nome) VALUES ($1, $2, $3)
                     ON CONFLICT (conta_id, codigo) DO NOTHING",
                )
                .bind(&conta.id)
                .bind(&atalho.codigo)
                .bind(&atalho.nome)
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
        Some(montar(linha, atalhos))
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
                    "INSERT INTO atalhos (conta_id, codigo, nome) VALUES ($1, $2, $3)
                     ON CONFLICT (conta_id, codigo) DO UPDATE SET nome = EXCLUDED.nome",
                )
                .bind(id)
                .bind(&a.codigo)
                .bind(&a.nome)
                .execute(pool)
                .await;
            }
        }
        true
    }

    pub async fn lembrar_grupo(pool: &PgPool, id: &str, codigo: &str, nome: &str) -> bool {
        let resultado = sqlx::query(
            "INSERT INTO atalhos (conta_id, codigo, nome) VALUES ($1, $2, $3)
             ON CONFLICT (conta_id, codigo) DO UPDATE SET nome = EXCLUDED.nome
             WHERE atalhos.nome IS DISTINCT FROM EXCLUDED.nome",
        )
        .bind(id)
        .bind(codigo)
        .bind(nome)
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
        let colunas_com_prefixo = "c.id, c.email, c.senha, c.google, c.apelido, c.avatar, c.bio, c.criada_em";
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
        Some(montar(linha, atalhos))
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
