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
//! Dois arquivos, pelo mesmo motivo que os grupos e as mensagens sao dois:
//!
//! * `contas.json` — as contas. Muda quando alguem se cadastra ou edita o
//!   perfil, e e reescrito inteiro, por temporario e rename.
//! * `sessoes.json` — os tokens vivos. Muda a cada entrada e a cada saida.
//!   Fica separado para que perde-lo custe uma tela de login, e nao as contas.

use std::collections::HashMap;
use std::path::PathBuf;

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

#[derive(Clone, Serialize, Deserialize)]
struct Sessao {
    /// Impressao do token, e nao o token. Quem le `sessoes.json` num backup
    /// esquecido nao entra na conta de ninguem com o que encontra ali.
    marca: String,
    conta: String,
    expira: u64,
}

/// Quantas senhas erradas seguidas, e ate quando o e-mail esta de castigo.
/// Vive so em memoria: reiniciar o servidor perdoa, e tudo bem — reiniciar o
/// servidor nao e algo que um atacante consiga pedir.
#[derive(Default)]
struct Tentativas {
    falhas: u32,
    ate: u64,
}

#[derive(Default)]
pub struct Cofre {
    contas: HashMap<String, Conta>, // id -> conta
    por_email: HashMap<String, String>,
    por_google: HashMap<String, String>,
    sessoes: HashMap<String, Sessao>, // marca -> sessao
    castigo: HashMap<String, Tentativas>,
    pasta: Option<PathBuf>,
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

impl Cofre {
    pub fn carregar(pasta: Option<PathBuf>) -> Self {
        let mut cofre = Cofre {
            pasta: pasta.clone(),
            ..Default::default()
        };

        let Some(pasta) = pasta else {
            return cofre;
        };

        if let Ok(bruto) = std::fs::read_to_string(pasta.join("contas.json")) {
            match serde_json::from_str::<Vec<Conta>>(&bruto) {
                Ok(lista) => {
                    for conta in lista {
                        cofre.indexar(conta);
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
                    if s.expira > agora && cofre.contas.contains_key(&s.conta) {
                        cofre.sessoes.insert(s.marca.clone(), s);
                    }
                }
            }
        }

        println!(
            "[contas] {} conta(s), {} sessao(oes) viva(s)",
            cofre.contas.len(),
            cofre.sessoes.len()
        );
        cofre
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

    pub fn por_id(&self, id: &str) -> Option<&Conta> {
        self.contas.get(id)
    }

    /// Hash guardado para um e-mail, ou `None` se ninguem usa esse e-mail.
    /// Devolvido por copia de proposito: verificar a senha leva dezenas de
    /// milissegundos e nao pode acontecer com o estado do servidor trancado.
    pub fn hash_de(&self, email: &str) -> Option<(String, String)> {
        let id = self.por_email.get(email)?;
        let conta = self.contas.get(id)?;
        Some((conta.id.clone(), conta.senha.clone()))
    }

    pub fn email_ocupado(&self, email: &str) -> bool {
        self.por_email.contains_key(email)
    }

    /// Quanto falta do castigo, em milissegundos. Zero quando o e-mail esta
    /// livre para tentar.
    pub fn castigo_restante(&self, email: &str) -> u64 {
        self.castigo
            .get(email)
            .map(|t| t.ate.saturating_sub(agora_ms()))
            .unwrap_or(0)
    }

    pub fn anotar_falha(&mut self, email: &str) {
        let agora = agora_ms();
        let t = self.castigo.entry(email.to_string()).or_default();
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

    pub fn perdoar(&mut self, email: &str) {
        self.castigo.remove(email);
    }

    /// Cria a conta. O hash ja vem pronto de fora, calculado longe da tranca.
    pub fn cadastrar(
        &mut self,
        email: String,
        hash: String,
        apelido: String,
        avatar: String,
        bio: String,
    ) -> Result<String, Recusa> {
        // Reconferido aqui, e nao so antes de calcular o hash: duas pessoas
        // podem ter pedido o mesmo e-mail enquanto o Argon2 rodava.
        if self.email_ocupado(&email) {
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
        self.indexar(conta);
        self.salvar_contas();
        Ok(id)
    }

    /// Encontra ou cria a conta correspondente a uma identidade do Google.
    ///
    /// Vincular pelo e-mail quando o `sub` e novo e deliberado: quem se
    /// cadastrou com senha e depois clicou em "Entrar com o Google" espera
    /// achar a propria conta, e nao uma segunda vazia. So e seguro porque o
    /// Google so devolve o e-mail depois de verifica-lo — por isso a checagem
    /// de `verificado` acontece antes de chegar aqui.
    pub fn pelo_google(
        &mut self,
        sub: &str,
        email: &str,
        nome: &str,
        avatar_sugerido: &str,
    ) -> String {
        if let Some(id) = self.por_google.get(sub) {
            return id.clone();
        }

        if let Some(id) = self.por_email.get(email).cloned() {
            if let Some(conta) = self.contas.get_mut(&id) {
                conta.google = sub.to_string();
            }
            self.por_google.insert(sub.to_string(), id.clone());
            self.salvar_contas();
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
        self.indexar(conta);
        self.salvar_contas();
        id
    }

    /// Perfil trocado pela pessoa. Campos ausentes ficam como estavam: o
    /// cliente manda o que mudou, e nunca um perfil pela metade.
    pub fn guardar_perfil(
        &mut self,
        id: &str,
        apelido: Option<String>,
        avatar: Option<String>,
        bio: Option<String>,
        atalhos: Option<Vec<Atalho>>,
    ) -> bool {
        let Some(conta) = self.contas.get_mut(id) else {
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
        self.salvar_contas();
        true
    }

    /// Anota o grupo na conta de quem acabou de entrar nele. Devolve `true`
    /// quando algo mudou, para nao regravar o arquivo a cada reconexao.
    pub fn lembrar_grupo(&mut self, id: &str, codigo: &str, nome: &str) -> bool {
        let Some(conta) = self.contas.get_mut(id) else {
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
        self.salvar_contas();
        true
    }

    /// Abre uma sessao e devolve o token em claro — a unica vez em que ele
    /// existe fora do cliente.
    pub fn abrir_sessao(&mut self, conta: &str) -> String {
        let token = sortear(40);
        self.sessoes.insert(
            marca_do_token(&token),
            Sessao {
                marca: marca_do_token(&token),
                conta: conta.to_string(),
                expira: agora_ms() + SESSAO_MS,
            },
        );
        self.limpar_sessoes_vencidas();
        self.salvar_sessoes();
        token
    }

    pub fn fechar_sessao(&mut self, token: &str) {
        if self.sessoes.remove(&marca_do_token(token)).is_some() {
            self.salvar_sessoes();
        }
    }

    /// Conta dona do token, quando ele existe e ainda vale.
    pub fn conta_do_token(&self, token: &str) -> Option<&Conta> {
        let sessao = self.sessoes.get(&marca_do_token(token))?;
        if sessao.expira <= agora_ms() {
            return None;
        }
        self.contas.get(&sessao.conta)
    }

    fn limpar_sessoes_vencidas(&mut self) {
        let agora = agora_ms();
        self.sessoes.retain(|_, s| s.expira > agora);
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
    digestor
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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

    #[test]
    fn a_sessao_vale_ate_ser_fechada() {
        let mut cofre = Cofre::default();
        let id = cofre
            .cadastrar(
                "ana@exemplo.com".into(),
                cifrar("segredo-bom-1").unwrap(),
                "Ana".into(),
                "coruja".into(),
                String::new(),
            )
            .unwrap();

        let token = cofre.abrir_sessao(&id);
        assert_eq!(cofre.conta_do_token(&token).map(|c| c.id.clone()), Some(id));
        cofre.fechar_sessao(&token);
        assert!(cofre.conta_do_token(&token).is_none());
        assert!(cofre.conta_do_token("token-inventado").is_none());
    }

    #[test]
    fn o_castigo_chega_depois_das_falhas_seguidas() {
        let mut cofre = Cofre::default();
        assert_eq!(cofre.castigo_restante("ana@exemplo.com"), 0);
        for _ in 0..FALHAS_ATE_CASTIGO {
            cofre.anotar_falha("ana@exemplo.com");
        }
        assert!(cofre.castigo_restante("ana@exemplo.com") > 0);
        cofre.perdoar("ana@exemplo.com");
        assert_eq!(cofre.castigo_restante("ana@exemplo.com"), 0);
    }

    #[test]
    fn o_google_acha_a_conta_que_ja_existia_pelo_email() {
        let mut cofre = Cofre::default();
        let id = cofre
            .cadastrar(
                "ana@exemplo.com".into(),
                cifrar("segredo-bom-1").unwrap(),
                "Ana".into(),
                String::new(),
                String::new(),
            )
            .unwrap();

        let achada = cofre.pelo_google("google-123", "ana@exemplo.com", "Ana", "coruja");
        assert_eq!(achada, id, "vincular, e nao criar uma segunda conta");
        // Na segunda vez ela vem pelo `sub`, mesmo com outro e-mail.
        assert_eq!(
            cofre.pelo_google("google-123", "outro@exemplo.com", "Ana", ""),
            id
        );
        // A senha continua valendo depois do vinculo.
        let (_, hash) = cofre.hash_de("ana@exemplo.com").unwrap();
        assert!(conferir("segredo-bom-1", &hash));
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
