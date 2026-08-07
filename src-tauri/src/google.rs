//! Entrar com o Google, do lado que abre o navegador.
//!
//! O CALL nao pede a senha do Google. Nem poderia: uma tela de login dentro
//! de um aplicativo qualquer e exatamente o que um golpe faz, e o proprio
//! Google recusa a autenticacao quando ela vem de um navegador embutido
//! (`disallowed_useragent`). O caminho certo e o navegador do sistema, com a
//! barra de endereco a vista, mostrando `accounts.google.com`.
//!
//! O passeio inteiro:
//!
//! 1. Sorteamos um segredo de uso unico, o *verificador*, e abrimos uma porta
//!    em `127.0.0.1` — porta que o sistema escolhe, para nao brigar com nada.
//! 2. Abrimos o navegador em `accounts.google.com`, levando o desafio (o
//!    resumo SHA-256 do verificador) e o endereco de volta.
//! 3. A pessoa escolhe a conta. O Google devolve o navegador para a nossa
//!    porta, com um *codigo* na consulta.
//! 4. Respondemos com uma pagina dizendo que deu certo, fechamos a porta e
//!    devolvemos codigo e verificador a interface.
//!
//! A interface entrega os dois ao servidor do CALL, que e quem tem o
//! `client_secret` e faz a troca com o Google — ver `servidor/src/google.rs`.
//! Nada aqui e segredo: o codigo sozinho nao abre conta nenhuma, e sem o
//! verificador (que nunca sai desta maquina a nao ser para o nosso servidor)
//! ele nao vale nem para quem o interceptar.
//!
//! ## Por que a porta local, e nao o `call://`
//!
//! O CALL ja registra o esquema `call://` para os convites, e seria tentador
//! reaproveita-lo. O Google trata redirecionamento para esquema proprio como
//! coisa de aplicativo de celular e recusa em cliente de computador; o
//! endereco de laco local e o que ele documenta para aplicativos instalados.
//! De quebra, a porta so existe durante o login e so aceita `127.0.0.1`.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Quanto tempo a porta espera pela volta do navegador. Dois minutos cobrem
/// escolher a conta, digitar a senha e resolver a verificacao em duas etapas;
/// alem disso a pessoa desistiu, e uma porta aberta para sempre nao serve a
/// ninguem.
const ESPERA: Duration = Duration::from_secs(120);

#[derive(Serialize)]
pub struct Passagem {
    codigo: String,
    verificador: String,
    redirecionamento: String,
}

/// Conduz o login e devolve o que o servidor precisa para trocar pelo
/// perfil. Bloqueia enquanto a pessoa resolve a vida dela no navegador, por
/// isso roda numa tarefa propria.
#[tauri::command]
pub async fn google_autenticar(cliente_id: String) -> Result<Passagem, String> {
    if cliente_id.trim().is_empty() {
        return Err("Este servidor não oferece o login do Google.".into());
    }

    tauri::async_runtime::spawn_blocking(move || passear(&cliente_id))
        .await
        .map_err(|_| "O login do Google foi interrompido.".to_string())?
}

fn passear(cliente_id: &str) -> Result<Passagem, String> {
    let escuta = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "Não foi possível abrir uma porta local para o login.".to_string())?;
    let porta = escuta
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let redirecionamento = format!("http://127.0.0.1:{porta}");

    let verificador = sortear(64);
    let desafio = resumo_url(&verificador);

    // `prompt=select_account` e o que torna possivel trocar de conta: sem
    // ele, quem ja esta logado no navegador entra sempre com a mesma, e nao
    // ha como sair de dentro do CALL.
    //
    // Nao pedimos `access_type=offline`. Ele traria um *refresh token*, que o
    // CALL nao tem o que fazer com: a identidade do Google e lida uma vez, no
    // momento da entrada, e dali em diante quem sustenta a sessao e o token do
    // proprio CALL. Pedir acesso continuado a uma conta Google para nunca
    // usa-lo e pedir mais do que se precisa — e a tela de consentimento diria
    // isso a pessoa, com razao.
    let endereco = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
         ?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={desafio}&code_challenge_method=S256\
         &prompt=select_account",
        cifrar_url(cliente_id),
        cifrar_url(&redirecionamento),
        cifrar_url("openid email profile"),
    );

    abrir_no_navegador(&endereco)?;

    // Sem prazo, `accept` esperaria para sempre por um navegador que a pessoa
    // fechou. Com prazo, o laco tem chance de desistir sozinho.
    escuta
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    let limite = Instant::now() + ESPERA;
    loop {
        if Instant::now() > limite {
            return Err("O login do Google demorou demais e foi cancelado.".into());
        }

        match escuta.accept() {
            Ok((fluxo, _)) => match atender(fluxo) {
                // O navegador pede o favicon logo depois da pagina de volta,
                // e ha extensoes que sondam a porta. Uma visita sem codigo
                // nem erro nao encerra o login: continuamos ouvindo.
                Resultado::Nada => continue,
                Resultado::Codigo(codigo) => {
                    return Ok(Passagem {
                        codigo,
                        verificador,
                        redirecionamento,
                    })
                }
                Resultado::Recusa(motivo) => return Err(motivo),
            },
            Err(erro) if erro.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(erro) => return Err(erro.to_string()),
        }
    }
}

enum Resultado {
    Codigo(String),
    Recusa(String),
    Nada,
}

/// Le a primeira linha do pedido HTTP, responde uma pagina e classifica a
/// visita. Nao ha servidor HTTP aqui — e uma linha de texto e uma resposta
/// fixa, que e tudo que este endereco existe para fazer.
fn atender(mut fluxo: TcpStream) -> Resultado {
    let _ = fluxo.set_read_timeout(Some(Duration::from_secs(5)));

    let mut linha = String::new();
    if BufReader::new(&fluxo).read_line(&mut linha).is_err() {
        return Resultado::Nada;
    }

    let alvo = linha.split_whitespace().nth(1).unwrap_or("");
    let consulta = alvo.split_once('?').map(|(_, c)| c).unwrap_or("");

    let mut codigo = None;
    let mut erro = None;
    for par in consulta.split('&') {
        let Some((chave, valor)) = par.split_once('=') else {
            continue;
        };
        match chave {
            "code" => codigo = Some(decifrar_url(valor)),
            "error" => erro = Some(decifrar_url(valor)),
            _ => {}
        }
    }

    let sucesso = codigo.is_some();
    if codigo.is_some() || erro.is_some() {
        responder(&mut fluxo, sucesso);
    } else if alvo == "/favicon.ico" || alvo.is_empty() {
        let _ = fluxo.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    }
    let _ = fluxo.flush();

    match (codigo, erro) {
        (Some(c), _) => Resultado::Codigo(c),
        // `access_denied` e a pessoa clicando em "Cancelar" na tela do
        // Google. E uma decisao dela, nao um defeito, e o texto diz isso.
        (None, Some(motivo)) if motivo == "access_denied" => {
            Resultado::Recusa("Login do Google cancelado.".into())
        }
        (None, Some(motivo)) => Resultado::Recusa(format!("O Google recusou: {motivo}")),
        _ => Resultado::Nada,
    }
}

/// A pagina que a pessoa ve no navegador ao voltar. Escrita a mao, com as
/// cores do aplicativo, porque a alternativa e o navegador ficar aberto num
/// "OK" branco de servidor — e a pessoa nao saber se deu certo.
fn responder(fluxo: &mut TcpStream, sucesso: bool) {
    let (titulo, recado) = if sucesso {
        ("Tudo certo.", "Pode voltar para o CALL — já está tudo pronto por lá.")
    } else {
        ("Login cancelado.", "Nada foi alterado. Você pode fechar esta aba.")
    };

    let corpo = format!(
        "<!doctype html><html lang=pt-BR><meta charset=utf-8>\
         <title>CALL</title>\
         <style>\
         :root{{color-scheme:dark}}\
         body{{margin:0;height:100vh;display:grid;place-items:center;background:#0e0f11;\
         color:#e9ebee;font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;\
         background-image:radial-gradient(60% 50% at 20% 20%,rgba(95,106,217,.16),transparent 60%)}}\
         .cartao{{text-align:center;padding:40px 44px;background:#141619;border:1px solid rgba(255,255,255,.06);\
         border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28)}}\
         .glifo{{display:flex;gap:4px;height:30px;align-items:center;justify-content:center;margin-bottom:22px}}\
         .glifo i{{width:4px;border-radius:999px;background:#5f6ad9}}\
         .glifo i:nth-child(1),.glifo i:nth-child(5){{height:11px;background:#6a7079}}\
         .glifo i:nth-child(2),.glifo i:nth-child(4){{height:19px;background:#a8b0f2}}\
         .glifo i:nth-child(3){{height:29px}}\
         h1{{margin:0 0 8px;font-size:19px;font-weight:600}}\
         p{{margin:0;color:#9ba1a9;font-size:13.5px}}\
         </style>\
         <div class=cartao><div class=glifo><i></i><i></i><i></i><i></i><i></i></div>\
         <h1>{titulo}</h1><p>{recado}</p></div>"
    );

    let resposta = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
        corpo.len()
    );
    let _ = fluxo.write_all(resposta.as_bytes());
}

/* ─── Navegador ───────────────────────────────────────────────────────── */

/// Abre o endereco no navegador padrao. `ShellExecuteW` e a mesma coisa que o
/// Windows faz quando alguem clica num link — e, diferente de `cmd /C start`,
/// nao passa a URL por um interpretador que trata `%` e `&` como sintaxe.
#[cfg(windows)]
fn abrir_no_navegador(endereco: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let largo = |texto: &str| -> Vec<u16> {
        std::ffi::OsStr::new(texto)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };

    let acao = largo("open");
    let alvo = largo(endereco);

    // O valor de retorno e um HINSTANCE historico: acima de 32 significa que
    // deu certo, e e assim que a documentacao manda ler.
    let resultado = unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::PCWSTR(acao.as_ptr()),
            windows::core::PCWSTR(alvo.as_ptr()),
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };

    if resultado.0 as isize > 32 {
        Ok(())
    } else {
        Err("Não foi possível abrir o navegador.".into())
    }
}

#[cfg(not(windows))]
fn abrir_no_navegador(_endereco: &str) -> Result<(), String> {
    Err("O login do Google só está disponível no Windows.".into())
}

/* ─── PKCE e codificacao ──────────────────────────────────────────────── */

/// Alfabeto do `code_verifier` conforme a RFC 7636: nada que precise ser
/// escapado numa URL.
const ALFABETO: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

fn sortear(tamanho: usize) -> String {
    let mut bytes = vec![0u8; tamanho];
    // Sem entropia do sistema o verificador seria adivinhavel, e um
    // verificador adivinhavel nao protege de nada. Cair para um valor fixo
    // seria pior que falhar.
    if getrandom::getrandom(&mut bytes).is_err() {
        return String::new();
    }
    bytes
        .iter()
        .map(|b| ALFABETO[*b as usize % ALFABETO.len()] as char)
        .collect()
}

/// Base64 na variante URL, sem enchimento — o formato do `code_challenge`.
fn resumo_url(verificador: &str) -> String {
    use sha2::{Digest, Sha256};

    const TABELA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let resumo = Sha256::digest(verificador.as_bytes());

    let mut saida = String::new();
    for pedaco in resumo.chunks(3) {
        let mut bloco = 0u32;
        for (i, b) in pedaco.iter().enumerate() {
            bloco |= u32::from(*b) << (16 - 8 * i);
        }
        for i in 0..pedaco.len() + 1 {
            saida.push(TABELA[((bloco >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    saida
}

fn cifrar_url(texto: &str) -> String {
    let mut saida = String::with_capacity(texto.len());
    for b in texto.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                saida.push(b as char)
            }
            _ => saida.push_str(&format!("%{b:02X}")),
        }
    }
    saida
}

fn decifrar_url(texto: &str) -> String {
    let bytes = texto.as_bytes();
    let mut saida = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let alto = (bytes[i + 1] as char).to_digit(16);
                let baixo = (bytes[i + 2] as char).to_digit(16);
                match (alto, baixo) {
                    (Some(a), Some(b)) => {
                        saida.push((a * 16 + b) as u8);
                        i += 3;
                    }
                    _ => {
                        saida.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                saida.push(b' ');
                i += 1;
            }
            outro => {
                saida.push(outro);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&saida).into_owned()
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn o_desafio_bate_com_o_exemplo_da_rfc_7636() {
        // Apendice B da RFC: verificador conhecido, desafio conhecido. Se o
        // base64url ou o SHA-256 sairem errados, o Google recusa com uma
        // mensagem que nao explica nada — este teste explica.
        assert_eq!(
            resumo_url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn o_verificador_tem_o_tamanho_e_o_alfabeto_da_rfc() {
        let v = sortear(64);
        assert_eq!(v.chars().count(), 64);
        assert!(v.bytes().all(|b| ALFABETO.contains(&b)));
        assert_ne!(sortear(64), v, "dois sorteios iguais seriam um gerador quebrado");
    }

    #[test]
    fn a_url_vai_e_volta_inteira() {
        assert_eq!(cifrar_url("openid email profile"), "openid%20email%20profile");
        assert_eq!(cifrar_url("http://127.0.0.1:9"), "http%3A%2F%2F127.0.0.1%3A9");
        assert_eq!(decifrar_url("4%2F0AY0e-g7%20a+b"), "4/0AY0e-g7 a b");
        // Um `%` solto no fim nao pode derrubar a leitura do codigo.
        assert_eq!(decifrar_url("abc%"), "abc%");
        assert_eq!(decifrar_url("ab%zz"), "ab%zz");
    }
}
