//! Credenciais curtas para o plano de mídia LiveKit.
//!
//! A chave secreta vive somente no processo do servidor. O cliente recebe um
//! JWT que vale por poucos minutos, para uma única sala, e sem permissão para
//! administrar salas ou publicar dados arbitrários.

use serde_json::Value;

#[cfg(feature = "livekit")]
use serde_json::json;

#[cfg(feature = "livekit")]
use std::time::Duration;

#[cfg(feature = "livekit")]
use blake2::{Blake2s256, Digest};
#[cfg(feature = "livekit")]
use livekit_api::access_token::{AccessToken, VideoGrants};

#[cfg(feature = "livekit")]
#[derive(Clone)]
struct Credenciais {
    url: String,
    chave: String,
    segredo: String,
}

#[derive(Clone, Default)]
pub struct Midia {
    #[cfg(feature = "livekit")]
    livekit: Option<Credenciais>,
}

impl Midia {
    pub fn do_ambiente() -> Self {
        let url = std::env::var("LIVEKIT_URL")
            .ok()
            .and_then(normalizar_variavel);
        let chave = std::env::var("LIVEKIT_API_KEY")
            .ok()
            .and_then(normalizar_variavel);
        let segredo = std::env::var("LIVEKIT_API_SECRET")
            .ok()
            .and_then(normalizar_variavel);
        let alguma = url.is_some() || chave.is_some() || segredo.is_some();

        #[cfg(feature = "livekit")]
        {
            match (url, chave, segredo) {
                (Some(url), Some(chave), Some(segredo))
                    if url.starts_with("wss://") || url.starts_with("ws://") =>
                {
                    println!("[midia] LiveKit habilitado; tokens restritos por sala.");
                    return Self {
                        livekit: Some(Credenciais {
                            url,
                            chave,
                            segredo,
                        }),
                    };
                }
                (Some(_), Some(_), Some(_)) => {
                    eprintln!(
                        "[midia] LIVEKIT_URL deve começar com wss:// ou ws://; usando malha P2P."
                    );
                }
                _ if alguma => {
                    eprintln!("[midia] configuração LiveKit incompleta; usando malha P2P.");
                }
                _ => {}
            }
        }

        #[cfg(not(feature = "livekit"))]
        if alguma {
            eprintln!("[midia] este binário não inclui a feature livekit; usando malha P2P.");
        }

        Self::default()
    }

    pub fn disponivel(&self) -> bool {
        #[cfg(feature = "livekit")]
        {
            self.livekit.is_some()
        }
        #[cfg(not(feature = "livekit"))]
        {
            false
        }
    }

    /// Emite uma credencial que só entra nesta sala e só publica as fontes que
    /// o CALL conhece. `None` mantém compatibilidade com o transporte P2P.
    pub fn credencial(
        &self,
        codigo_grupo: &str,
        canal: &str,
        identidade: &str,
        nome: &str,
    ) -> Option<Value> {
        #[cfg(feature = "livekit")]
        {
            let credenciais = self.livekit.as_ref()?;
            let sala = nome_da_sala(codigo_grupo, canal);
            let token = AccessToken::with_api_key(&credenciais.chave, &credenciais.segredo)
                .with_ttl(Duration::from_secs(10 * 60))
                .with_identity(identidade)
                .with_name(nome)
                .with_grants(VideoGrants {
                    room_join: true,
                    room: sala,
                    can_publish: true,
                    can_subscribe: true,
                    can_publish_data: false,
                    can_publish_sources: vec![
                        "microphone".to_string(),
                        "screen_share".to_string(),
                        "screen_share_audio".to_string(),
                    ],
                    ..Default::default()
                })
                .to_jwt()
                .map_err(|erro| eprintln!("[midia] falha ao assinar token LiveKit: {erro}"))
                .ok()?;

            return Some(json!({
                "provedor": "livekit",
                "url": credenciais.url,
                "token": token
            }));
        }

        #[cfg(not(feature = "livekit"))]
        {
            let _ = (codigo_grupo, canal, identidade, nome);
            None
        }
    }
}

fn normalizar_variavel(valor: String) -> Option<String> {
    // O PowerShell pode escrever UTF-8 com BOM ao alimentar `--stdin`. O BOM
    // não é whitespace para `str::trim`, mas também não faz parte da URL/chave.
    let limpo = valor
        .trim()
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string();
    (!limpo.is_empty()).then_some(limpo)
}

#[cfg(feature = "livekit")]
fn nome_da_sala(codigo_grupo: &str, canal: &str) -> String {
    // O nome da sala aparece dentro do JWT. Um hash estável evita expor o
    // código de convite e produz apenas caracteres seguros para qualquer SFU.
    let mut hash = Blake2s256::new();
    hash.update(codigo_grupo.as_bytes());
    hash.update([0]);
    hash.update(canal.as_bytes());
    let resumo = hash.finalize();
    let hexadecimal: String = resumo[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("call-{hexadecimal}")
}

#[cfg(all(test, feature = "livekit"))]
mod testes {
    use super::*;
    use livekit_api::access_token::TokenVerifier;

    #[test]
    fn normaliza_bom_e_quebra_de_linha_de_variavel() {
        assert_eq!(
            normalizar_variavel("\u{feff}wss://exemplo.livekit.cloud\r\n".to_string()),
            Some("wss://exemplo.livekit.cloud".to_string())
        );
    }

    #[test]
    fn token_so_entra_na_sala_e_publica_fontes_do_call() {
        let midia = Midia {
            livekit: Some(Credenciais {
                url: "wss://exemplo.livekit.cloud".to_string(),
                chave: "chave-de-teste".to_string(),
                segredo: "segredo-de-teste-com-tamanho-suficiente".to_string(),
            }),
        };
        let resposta = midia
            .credencial("convite-secreto", "canal-1", "42", "Ana")
            .expect("credencial");
        let token = resposta["token"].as_str().expect("jwt");
        let claims = TokenVerifier::with_api_key(
            "chave-de-teste",
            "segredo-de-teste-com-tamanho-suficiente",
        )
        .verify(token)
        .expect("assinatura válida");

        assert_eq!(claims.sub, "42");
        assert_eq!(claims.name, "Ana");
        assert!(claims.video.room_join);
        assert!(claims.video.can_publish);
        assert!(claims.video.can_subscribe);
        assert!(!claims.video.can_publish_data);
        assert_eq!(
            claims.video.room,
            nome_da_sala("convite-secreto", "canal-1")
        );
        assert!(!claims.video.room.contains("convite-secreto"));
        assert_eq!(
            claims.video.can_publish_sources,
            vec!["microphone", "screen_share", "screen_share_audio"]
        );
    }

    #[test]
    fn sala_e_estavel_e_separa_canais() {
        assert_eq!(nome_da_sala("grupo", "voz"), nome_da_sala("grupo", "voz"));
        assert_ne!(nome_da_sala("grupo", "voz"), nome_da_sala("grupo", "jogos"));
        assert_ne!(nome_da_sala("grupo", "voz"), nome_da_sala("outro", "voz"));
    }
}
