//! Credenciais do TURN, para a malha P2P.
//!
//! Sem LiveKit a call e uma malha: cada participante fala direto com os
//! outros. Isso falha justamente no 4G, onde a operadora coloca milhares de
//! aparelhos atras do mesmo endereco (CGNAT) e nenhum dos dois lados consegue
//! ser alcancado pelo outro. O TURN e o ponto de encontro para esse caso — ver
//! `turn/` na raiz do repositorio.
//!
//! Uma senha fixa dentro do aplicativo seria um repasse aberto para quem
//! abrisse o instalador. Em vez disso, o servidor assina uma credencial que
//! expira, no formato que o coturn entende com `--use-auth-secret` (o "TURN
//! REST API"):
//!
//! ```text
//! usuario = "<expira em, segundos unix>:<id da conexao>"
//! senha   = base64(HMAC-SHA1(TURN_SECRET, usuario))
//! ```
//!
//! O coturn confere a assinatura com o mesmo segredo e recusa o usuario
//! depois do horario embutido nele. Nenhuma lista de usuarios precisa ser
//! sincronizada entre os dois servidores.
//!
//! Sem `TURN_URLS` e `TURN_SECRET` no ambiente — o caso do sidecar que hospeda
//! uma conversa na rede local — nada e anunciado, e o cliente usa so o STUN de
//! sempre.

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;

/// Quanto tempo uma credencial vale. Longo de proposito: quem ja esta na call
/// abre o elo com quem chega depois usando a credencial que recebeu ao
/// entrar, e uma call de uma noite inteira nao pode perder o TURN no meio.
const VALIDADE_S: u64 = 24 * 60 * 60;

/// Os servidores ICE desta conexao, prontos para `RTCPeerConnection`, ou
/// `None` quando nao ha TURN configurado.
pub fn servidores_ice(conexao: &str) -> Option<Value> {
    let urls = urls()?;
    let segredo = std::env::var("TURN_SECRET").ok().filter(|s| !s.is_empty())?;
    let expira = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs()
        + VALIDADE_S;
    let (usuario, senha) = credencial(&segredo, expira, conexao);
    Some(json!([{ "urls": urls, "username": usuario, "credential": senha }]))
}

/// `TURN_URLS`, separados por virgula. Ex.:
/// `turn:altaria.proxy.rlwy.net:55027?transport=tcp`.
fn urls() -> Option<Vec<String>> {
    let lista: Vec<String> = std::env::var("TURN_URLS")
        .ok()?
        .split(',')
        .map(|u| u.trim().to_string())
        .filter(|u| u.starts_with("turn:") || u.starts_with("turns:"))
        .collect();
    (!lista.is_empty()).then_some(lista)
}

fn credencial(segredo: &str, expira: u64, conexao: &str) -> (String, String) {
    let usuario = format!("{expira}:{conexao}");
    let mut mac = Hmac::<Sha1>::new_from_slice(segredo.as_bytes())
        .expect("HMAC aceita chave de qualquer tamanho");
    mac.update(usuario.as_bytes());
    let senha = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    (usuario, senha)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn a_senha_e_o_hmac_sha1_do_usuario_que_o_coturn_espera() {
        // Vetor conferido contra o `crypto.createHmac("sha1", ...)` do Node,
        // o mesmo calculo que validou o repasse contra o coturn de producao.
        let (usuario, senha) = credencial("segredo-de-teste", 1_800_000_000, "42");
        assert_eq!(usuario, "1800000000:42");
        assert_eq!(senha, "Bn+m/Gm/wihczAYz8J4vPtZ55DA=");
    }
}
