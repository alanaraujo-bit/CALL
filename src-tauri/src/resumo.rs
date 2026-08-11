//! Resumo e foto de "o que é isso" — Google/Wikipedia da atividade de alguém,
//! só quando a própria pessoa clica para saber mais no cartão de um amigo.
//!
//! É a única chamada deste aplicativo a um servidor que não é o de
//! sinalização escolhido pela pessoa nem o LiveKit, e por isso mora inteira
//! do lado do Tauri, e não do `fetch` da página: as `capabilities` do app
//! escopam exatamente os três hosts da Wikipedia que este módulo usa, sem
//! abrir a CSP da janela para a internet inteira. A imagem também viaja para
//! a interface já em `data:`, e não como um link — o `img-src` da janela
//! nunca precisou aceitar `upload.wikimedia.org`.
//!
//! Duas chamadas por busca: a de pesquisa acha o título certo a partir de um
//! nome de programa que raramente bate exato com o título do artigo
//! ("Adobe Premiere Pro 2025" contra "Adobe Premiere Pro"); a de resumo
//! busca o texto e a foto daquele título. Primeiro em português; se não achar
//! nada lá, tenta de novo em inglês — a maioria dos programas e jogos tem
//! artigo em inglês, mesmo quando não tem em português.

use serde::{Deserialize, Serialize};
use tauri_plugin_http::reqwest;

const HOSTS: [&str; 2] = ["pt.wikipedia.org", "en.wikipedia.org"];

/// O que a interface mostra sobre uma atividade.
#[derive(Serialize, Clone)]
pub struct Resumo {
    titulo: String,
    texto: String,
    /// `data:image/...;base64,...`, já pronta para um `<img src>` — nunca a
    /// URL da Wikimedia, que a janela não tem permissão de carregar.
    foto: Option<String>,
}

#[derive(Deserialize)]
struct PaginaDaBusca {
    title: String,
}

#[derive(Deserialize)]
struct RespostaDaBusca {
    pages: Vec<PaginaDaBusca>,
}

#[derive(Deserialize)]
struct Miniatura {
    source: String,
}

#[derive(Deserialize)]
struct RespostaDoResumo {
    title: String,
    extract: String,
    thumbnail: Option<Miniatura>,
}

async fn titulo_mais_proximo(cliente: &reqwest::Client, host: &str, nome: &str) -> Option<String> {
    let url = format!("https://{host}/w/rest.php/v1/search/page");
    let resposta = cliente
        .get(url)
        .query(&[("q", nome), ("limit", "1")])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;

    let achado: RespostaDaBusca = serde_json::from_str(&resposta).ok()?;
    achado.pages.into_iter().next().map(|p| p.title)
}

async fn resumo_do_titulo(cliente: &reqwest::Client, host: &str, titulo: &str) -> Option<RespostaDoResumo> {
    // O título vem da própria Wikipedia, mas pode trazer espaço e acento — a
    // URL do resumo não aceita nenhum dos dois sem escapar.
    let url = format!(
        "https://{host}/api/rest_v1/page/summary/{}",
        urlencoding_simples(titulo)
    );
    let resposta = cliente
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;

    serde_json::from_str(&resposta).ok()
}

/// Não é a codificação completa de uma URL — só o suficiente para um título
/// de artigo da Wikipedia, que nunca traz `&`, `?` ou `#`. Uma crate inteira
/// para isto custaria mais ao instalador do que a diferença vale.
fn urlencoding_simples(texto: &str) -> String {
    texto
        .chars()
        .map(|c| match c {
            ' ' => "_".to_string(),
            c if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') => c.to_string(),
            c => c
                .to_string()
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}

async fn baixar_foto_como_dados(cliente: &reqwest::Client, url: &str) -> Option<String> {
    let resposta = cliente.get(url).send().await.ok()?.error_for_status().ok()?;
    let tipo = resposta
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resposta.bytes().await.ok()?;
    Some(format!(
        "data:{tipo};base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    ))
}

async fn buscar_em(cliente: &reqwest::Client, host: &str, nome: &str) -> Option<Resumo> {
    let titulo = titulo_mais_proximo(cliente, host, nome).await?;
    let achado = resumo_do_titulo(cliente, host, &titulo).await?;
    if achado.extract.trim().is_empty() {
        return None;
    }

    let foto = match achado.thumbnail {
        Some(miniatura) => baixar_foto_como_dados(cliente, &miniatura.source).await,
        None => None,
    };

    Some(Resumo {
        titulo: achado.title,
        texto: achado.extract,
        foto,
    })
}

/// Resumo e foto de um programa ou jogo, pela Wikipedia. `None` quando não
/// se achou nada — nome obscuro, executável genérico, ou a rede caiu —, e a
/// interface trata isso como "sem informação", nunca como erro.
#[tauri::command]
pub async fn resumo_de_atividade(nome: String) -> Option<Resumo> {
    let nome = nome.trim();
    if nome.is_empty() {
        return None;
    }

    let cliente = reqwest::Client::builder()
        .user_agent("CALL/0.10 (https://call.aionixdev.com)")
        .build()
        .ok()?;

    for host in HOSTS {
        if let Some(resumo) = buscar_em(&cliente, host, nome).await {
            return Some(resumo);
        }
    }
    None
}
