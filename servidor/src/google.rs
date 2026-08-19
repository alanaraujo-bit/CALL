//! Entrar com o Google, do lado que guarda o segredo.
//!
//! O aplicativo abre o navegador do sistema, a pessoa escolhe a conta no site
//! do proprio Google e o navegador volta com um *codigo de autorizacao* — que
//! sozinho nao serve para nada. Quem troca esse codigo pelos dados da pessoa
//! e o servidor, porque so ele tem o `GOOGLE_CLIENT_SECRET`.
//!
//! Poderia ser o contrario: o Google permite que aplicativos instalados facam
//! a troca com o segredo embutido, justamente porque um segredo dentro de um
//! `.exe` que qualquer um baixa nao e segredo nenhum. Recusamos esse caminho.
//! Se a troca fosse no cliente, o servidor receberia um `id_token` pronto e
//! teria de conferir a assinatura RS256 dele contra as chaves publicas do
//! Google — mais codigo, mais coisa para errar, e um `id_token` de *outro*
//! aplicativo passaria por qualquer descuido nessa conferencia.
//!
//! Aqui a resposta vem por TLS direto do `oauth2.googleapis.com`, em resposta
//! a um pedido que carrega o nosso segredo. Por isso o `id_token` pode ser
//! lido sem conferir assinatura — e a propria documentacao do Google diz que
//! esse e o unico caso em que isso vale. Nao ha canal por onde um token
//! forjado chegue ate aqui.
//!
//! ## O recorte da compilacao
//!
//! Falar HTTPS custa caro em binario: cliente HTTP, TLS e raizes de
//! certificado levaram o servidor de **599 KB a 1,93 MB** (medido no
//! Windows/MSVC, release). Este mesmo binario viaja dentro do instalador do
//! CALL como sidecar, para quem hospeda uma conversa na rede local — e ali
//! esse 1,3 MB pagaria por um recurso que nem existe: um servidor caseiro nao
//! tem `client_secret`, nem endereco publico para o Google devolver ninguem.
//!
//! Entao o Google fica atras da opcao de compilacao `google`, que so a imagem
//! da nuvem liga. Sem ela o servidor continua compilando e rodando igual, e a
//! interface simplesmente nao oferece o botao — ver `disponivel`.

//! ## Dois clientes OAuth, e nao um
//!
//! O Google separa tipos de cliente, e o CALL usa os dois:
//!
//! * **Aplicativo para computador**, para o CALL de Windows. Ele volta em
//!   `http://127.0.0.1:{porta}` com uma porta *sorteada* a cada login, e so
//!   esse tipo de cliente aceita loopback com porta livre.
//! * **Aplicativo da Web**, para o CALL de celular. Ele volta na propria
//!   pagina, `https://call.aionixdev.com/app/`, e esse endereco so pode ser
//!   cadastrado num cliente Web.
//!
//! Nao da para atender os dois com um cliente so: um cliente de computador
//! recusa URI `https`, e um cliente Web exige porta fixa no loopback. Por
//! isso ha dois pares de variaveis, e `trocar_codigo` escolhe o par pelo
//! formato do endereco de retorno — que e a unica coisa que distingue, de
//! fora, de qual casca veio o codigo.

/// Quem a pessoa e, na versao do Google.
pub struct Identidade {
    pub sub: String,
    pub email: String,
    pub nome: String,
}

/// Identificador publico do cliente de computador, que o CALL de Windows usa
/// para montar a URL de autorizacao. Publico mesmo: ele aparece na barra de
/// endereco do navegador de quem entra.
pub fn cliente_id() -> Option<String> {
    std::env::var("GOOGLE_CLIENT_ID").ok().filter(|s| !s.is_empty())
}

fn segredo() -> Option<String> {
    std::env::var("GOOGLE_CLIENT_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Identificador publico do cliente Web, usado pelo CALL de celular.
///
/// Sem `GOOGLE_CLIENT_ID_WEB` no ambiente isto devolve `None`, e o celular
/// simplesmente nao oferece o botao do Google — a mesma regra de `disponivel`,
/// pela mesma razao: prometer o botao e falhar depois e pior do que nao o
/// oferecer. Quem hospeda com um unico cliente Web (sem o app de Windows)
/// pode apontar as duas variaveis para ele.
pub fn cliente_id_web() -> Option<String> {
    std::env::var("GOOGLE_CLIENT_ID_WEB")
        .ok()
        .filter(|s| !s.is_empty())
}

#[cfg(feature = "google")]
fn segredo_web() -> Option<String> {
    std::env::var("GOOGLE_CLIENT_SECRET_WEB")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Verdadeiro quando o retorno e a porta local que o aplicativo instalado
/// abre. E o unico sinal disponivel de qual casca pediu o login: o codigo de
/// autorizacao em si nao carrega essa informacao.
#[cfg(feature = "google")]
fn e_retorno_de_computador(redirecionamento: &str) -> bool {
    redirecionamento.starts_with("http://127.0.0.1")
        || redirecionamento.starts_with("http://localhost")
        || redirecionamento.starts_with("http://[::1]")
}

/// O par de credenciais que corresponde ao endereco de retorno.
#[cfg(feature = "google")]
fn credenciais(redirecionamento: &str) -> Option<(String, String)> {
    if e_retorno_de_computador(redirecionamento) {
        return Some((cliente_id()?, segredo()?));
    }
    // Sem par Web configurado, cai para o de computador: um servidor que use
    // um cliente Web unico funciona sem variavel nova nenhuma.
    match (cliente_id_web(), segredo_web()) {
        (Some(id), Some(chave)) => Some((id, chave)),
        _ => Some((cliente_id()?, segredo()?)),
    }
}

/// Verdadeiro so quando o botao pode existir: binario compilado com a opcao
/// `google` **e** as duas variaveis no ambiente. Prometer o botao e falhar
/// depois seria pior do que nao o oferecer.
pub fn disponivel() -> bool {
    cfg!(feature = "google") && cliente_id().is_some() && segredo().is_some()
}

#[cfg(not(feature = "google"))]
pub async fn trocar_codigo(
    _codigo: &str,
    _verificador: &str,
    _redirecionamento: &str,
) -> Result<Identidade, String> {
    Err("Este servidor não foi compilado com o login do Google.".into())
}

#[cfg(feature = "google")]
pub async fn trocar_codigo(
    codigo: &str,
    verificador: &str,
    redirecionamento: &str,
) -> Result<Identidade, String> {
    // Qual cliente OAuth atende este login sai do endereco de retorno: a
    // porta local e o aplicativo instalado, o resto e o celular. Trocar o
    // codigo com o par errado e recusa certa do Google.
    let Some((id, segredo)) = credenciais(redirecionamento) else {
        return Err("Este servidor não está configurado para o login do Google.".into());
    };

    // O `redirect_uri` viaja de novo, identico ao usado no pedido de
    // autorizacao: e assim que o Google confere que o codigo esta voltando
    // pela mesma porta por onde saiu.
    let resposta = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", codigo),
            ("client_id", id.as_str()),
            ("client_secret", segredo.as_str()),
            ("redirect_uri", redirecionamento),
            ("grant_type", "authorization_code"),
            ("code_verifier", verificador),
        ])
        .send()
        .await
        .map_err(|e| format!("Não foi possível falar com o Google: {e}"))?;

    if !resposta.status().is_success() {
        // O corpo do erro do Google e uma pista de configuracao (segredo
        // errado, redirect nao cadastrado) e nao interessa a quem esta
        // entrando; vai para o log de quem hospeda.
        let detalhe = resposta.text().await.unwrap_or_default();
        eprintln!("[google] troca recusada: {detalhe}");
        return Err("O Google recusou este acesso. Tente de novo.".into());
    }

    #[derive(serde::Deserialize)]
    struct Troca {
        id_token: Option<String>,
    }

    let troca: Troca = resposta
        .json()
        .await
        .map_err(|_| "Resposta inesperada do Google.".to_string())?;
    let jwt = troca
        .id_token
        .ok_or("O Google não devolveu a identidade.".to_string())?;

    ler_identidade(&jwt)
}

/// Le o miolo do `id_token` sem conferir assinatura — ver a nota do topo:
/// ele acabou de chegar por TLS do proprio Google, em resposta a um pedido
/// assinado com o nosso segredo.
#[cfg(feature = "google")]
fn ler_identidade(jwt: &str) -> Result<Identidade, String> {
    #[derive(serde::Deserialize)]
    struct Miolo {
        sub: String,
        email: Option<String>,
        #[serde(default)]
        email_verified: bool,
        name: Option<String>,
    }

    let corpo = jwt
        .split('.')
        .nth(1)
        .ok_or("Identidade do Google malformada.".to_string())?;
    let bruto = base64url(corpo).ok_or("Identidade do Google malformada.".to_string())?;
    let miolo: Miolo =
        serde_json::from_slice(&bruto).map_err(|_| "Identidade do Google ilegível.".to_string())?;

    // Sem e-mail verificado nao ha como saber que a pessoa e dona dele — e o
    // e-mail e justamente o que liga esta entrada a uma conta que talvez ja
    // exista com senha.
    let email = miolo.email.unwrap_or_default();
    if email.is_empty() || !miolo.email_verified {
        return Err("Sua conta Google não tem um e-mail verificado.".into());
    }

    Ok(Identidade {
        nome: miolo.name.unwrap_or_default(),
        sub: miolo.sub,
        email,
    })
}

/// Base64 na variante URL e sem enchimento, que e como o JWT viaja.
/// Vinte linhas no lugar de uma dependencia que so isto usaria.
#[cfg(feature = "google")]
fn base64url(texto: &str) -> Option<Vec<u8>> {
    let valor = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        })
    };

    let mut saida = Vec::with_capacity(texto.len() * 3 / 4);
    let mut acumulado = 0u32;
    let mut bits = 0u32;

    for byte in texto.bytes() {
        if byte == b'=' {
            break;
        }
        acumulado = (acumulado << 6) | valor(byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            saida.push((acumulado >> bits) as u8);
        }
    }

    Some(saida)
}

#[cfg(all(test, feature = "google"))]
mod testes {
    use super::*;

    /// Monta um `id_token` de mentira: so o miolo importa, e e ele que a
    /// funcao le.
    fn jwt(miolo: &str) -> String {
        let cru = |texto: &str| {
            let mut saida = String::new();
            let alfabeto = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let bytes = texto.as_bytes();
            for pedaco in bytes.chunks(3) {
                let mut bloco = 0u32;
                for (i, b) in pedaco.iter().enumerate() {
                    bloco |= u32::from(*b) << (16 - 8 * i);
                }
                let letras = pedaco.len() + 1;
                for i in 0..letras {
                    saida.push(alfabeto[((bloco >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            saida
        };
        format!("cabecalho.{}.assinatura", cru(miolo))
    }

    #[test]
    fn le_a_identidade_de_um_token_bem_formado() {
        let token = jwt(r#"{"sub":"117","email":"ana@exemplo.com","email_verified":true,"name":"Ana"}"#);
        let identidade = ler_identidade(&token).unwrap();
        assert_eq!(identidade.sub, "117");
        assert_eq!(identidade.email, "ana@exemplo.com");
        assert_eq!(identidade.nome, "Ana");
    }

    #[test]
    fn recusa_email_nao_verificado_e_token_quebrado() {
        let sem_prova = jwt(r#"{"sub":"117","email":"ana@exemplo.com","email_verified":false}"#);
        assert!(ler_identidade(&sem_prova).is_err());
        assert!(ler_identidade("nada").is_err());
        assert!(ler_identidade("a.!!!.c").is_err());
    }
}
