//! Que aplicativo esta na frente, agora.
//!
//! O que sai daqui e **o nome do programa, e nunca o titulo da janela**. A
//! distincao e a decisao de privacidade inteira deste recurso: o titulo diz
//! "Contrato de rescisao - Word", "consulta oncologista - Google Chrome",
//! "namorada (2) - WhatsApp". O nome do programa diz "Word". Um se conta aos
//! amigos sem pensar; o outro nao se conta a ninguem sem querer.
//!
//! O nome bonito vem do `FileDescription` do proprio executavel — o mesmo
//! campo que o Gerenciador de Tarefas mostra na coluna "Descricao". E de onde
//! saem "Google Chrome" em vez de `chrome.exe` e "Rocket League" em vez de
//! `RocketLeague.exe`, sem lista curada nenhuma e sem consultar servico
//! algum. Quando o executavel nao traz descricao, sobra arrumar o nome do
//! arquivo, que e o que este modulo faz por ultimo.
//!
//! Nao ha dependencia nova: as meia duzia de funcoes do Windows usadas aqui
//! sao declaradas na mao. Uma caixa inteira para chamar `GetForegroundWindow`
//! custaria mais ao instalador do que o recurso vale.

use serde::Serialize;

/// O que este computador esta usando agora.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Atividade {
    /// Nome do executavel sem extensao, em minusculas — `chrome`, `code`.
    /// E por ele que a interface decide o que nao vale a pena mostrar.
    pub exe: String,
    /// Nome de exibicao — `Google Chrome`, `Visual Studio Code`.
    pub nome: String,
}

/// Transforma o nome de um executavel em algo legivel, para quando o programa
/// nao traz descricao nenhuma: `RocketLeague` vira `Rocket League`, `vlc` vira
/// `Vlc`, `my_game-launcher` vira `My Game Launcher`.
///
/// Nao tenta adivinhar mais do que isso. Errar para menos aqui e mostrar um
/// nome sem graca; errar para mais seria inventar o que a pessoa esta usando.
pub fn arrumar_nome(arquivo: &str) -> String {
    let mut palavras: Vec<String> = Vec::new();
    let mut atual = String::new();

    let mut anterior_minuscula = false;
    for c in arquivo.chars() {
        if c == '_' || c == '-' || c == '.' || c == ' ' {
            if !atual.is_empty() {
                palavras.push(std::mem::take(&mut atual));
            }
            anterior_minuscula = false;
            continue;
        }
        // Uma maiuscula depois de uma minuscula abre palavra nova: e o que
        // separa `RocketLeague`. Duas maiusculas seguidas nao, senao `VLC`
        // viraria `V L C`.
        if c.is_uppercase() && anterior_minuscula && !atual.is_empty() {
            palavras.push(std::mem::take(&mut atual));
        }
        anterior_minuscula = c.is_lowercase() || c.is_numeric();
        atual.push(c);
    }
    if !atual.is_empty() {
        palavras.push(atual);
    }

    palavras
        .iter()
        .map(|p| {
            let mut letras = p.chars();
            match letras.next() {
                Some(primeira) => primeira.to_uppercase().collect::<String>() + letras.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
mod janelas {
    use super::{arrumar_nome, Atividade};
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStringExt;

    type Alca = *mut c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    extern "system" {
        fn GetForegroundWindow() -> Alca;
        fn GetWindowThreadProcessId(janela: Alca, processo: *mut u32) -> u32;
        fn OpenProcess(acesso: u32, herdar: i32, processo: u32) -> Alca;
        fn QueryFullProcessImageNameW(
            processo: Alca,
            estilo: u32,
            destino: *mut u16,
            tamanho: *mut u32,
        ) -> i32;
        fn CloseHandle(alca: Alca) -> i32;
        fn GetCurrentProcessId() -> u32;
    }

    #[link(name = "version")]
    extern "system" {
        fn GetFileVersionInfoSizeW(arquivo: *const u16, ignorado: *mut u32) -> u32;
        fn GetFileVersionInfoW(
            arquivo: *const u16,
            ignorado: u32,
            tamanho: u32,
            destino: *mut c_void,
        ) -> i32;
        fn VerQueryValueW(
            bloco: *const c_void,
            consulta: *const u16,
            valor: *mut *mut c_void,
            tamanho: *mut u32,
        ) -> i32;
    }

    /// Converte para o UTF-16 terminado em zero que as APIs do Windows pedem.
    fn largo(texto: &str) -> Vec<u16> {
        texto.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Caminho completo do executavel do processo em primeiro plano.
    fn caminho_em_foco() -> Option<String> {
        unsafe {
            let janela = GetForegroundWindow();
            if janela.is_null() {
                return None;
            }

            let mut processo = 0u32;
            GetWindowThreadProcessId(janela, &mut processo);
            if processo == 0 || processo == GetCurrentProcessId() {
                // O proprio CALL em foco nao e atividade: ninguem precisa
                // anunciar aos amigos que esta usando o CALL para falar com
                // eles.
                return None;
            }

            // `QUERY_LIMITED_INFORMATION` e o acesso minimo que ainda permite
            // ler o caminho, e o unico que funciona sem privilegio elevado
            // contra processos de outra sessao.
            let alca = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, processo);
            if alca.is_null() {
                return None;
            }

            let mut destino = [0u16; 512];
            let mut tamanho = destino.len() as u32;
            let deu_certo = QueryFullProcessImageNameW(alca, 0, destino.as_mut_ptr(), &mut tamanho);
            CloseHandle(alca);

            if deu_certo == 0 || tamanho == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&destino[..tamanho as usize]))
        }
    }

    /// O `FileDescription` do executavel, na primeira tradução que ele
    /// declara. E o mesmo texto que o Gerenciador de Tarefas mostra.
    fn descricao(caminho: &str) -> Option<String> {
        unsafe {
            let arquivo = largo(caminho);
            let mut ignorado = 0u32;
            let tamanho = GetFileVersionInfoSizeW(arquivo.as_ptr(), &mut ignorado);
            if tamanho == 0 {
                return None;
            }

            let mut bloco = vec![0u8; tamanho as usize];
            if GetFileVersionInfoW(
                arquivo.as_ptr(),
                0,
                tamanho,
                bloco.as_mut_ptr() as *mut c_void,
            ) == 0
            {
                return None;
            }

            // Um executavel pode trazer o texto em varios idiomas. A tabela de
            // traducoes diz quais existem; pegamos a primeira, que e a que o
            // proprio Windows usa quando nao ha correspondencia melhor.
            let consulta = largo("\\VarFileInfo\\Translation");
            let mut valor: *mut c_void = std::ptr::null_mut();
            let mut bytes = 0u32;
            if VerQueryValueW(
                bloco.as_ptr() as *const c_void,
                consulta.as_ptr(),
                &mut valor,
                &mut bytes,
            ) == 0
                || bytes < 4
                || valor.is_null()
            {
                return None;
            }

            let idioma = *(valor as *const u16);
            let pagina = *(valor as *const u16).add(1);
            let consulta = largo(&format!(
                "\\StringFileInfo\\{idioma:04x}{pagina:04x}\\FileDescription"
            ));

            let mut valor: *mut c_void = std::ptr::null_mut();
            let mut caracteres = 0u32;
            if VerQueryValueW(
                bloco.as_ptr() as *const c_void,
                consulta.as_ptr(),
                &mut valor,
                &mut caracteres,
            ) == 0
                || caracteres == 0
                || valor.is_null()
            {
                return None;
            }

            let bruto = std::slice::from_raw_parts(valor as *const u16, caracteres as usize);
            // O comprimento devolvido inclui o zero terminador.
            let fim = bruto.iter().position(|c| *c == 0).unwrap_or(bruto.len());
            let texto = std::ffi::OsString::from_wide(&bruto[..fim])
                .to_string_lossy()
                .trim()
                .to_string();

            (!texto.is_empty()).then_some(texto)
        }
    }

    pub fn atual() -> Option<Atividade> {
        let caminho = caminho_em_foco()?;
        let arquivo = caminho.rsplit(['\\', '/']).next()?;
        let base = arquivo.strip_suffix(".exe").unwrap_or(arquivo);
        if base.is_empty() {
            return None;
        }

        Some(Atividade {
            exe: base.to_lowercase(),
            nome: descricao(&caminho).unwrap_or_else(|| arrumar_nome(base)),
        })
    }
}

#[cfg(not(windows))]
mod janelas {
    use super::Atividade;
    pub fn atual() -> Option<Atividade> {
        None
    }
}

/// Quem esta em primeiro plano nesta maquina. `None` quando nao da para saber,
/// quando o proprio CALL esta em foco, ou fora do Windows.
#[tauri::command]
pub fn atividade_em_foco() -> Option<Atividade> {
    janelas::atual()
}

#[cfg(test)]
mod testes {
    use super::arrumar_nome;

    #[test]
    fn separa_as_palavras_grudadas_do_nome_do_arquivo() {
        assert_eq!(arrumar_nome("RocketLeague"), "Rocket League");
        assert_eq!(arrumar_nome("factorio"), "Factorio");
        assert_eq!(arrumar_nome("my_game-launcher"), "My Game Launcher");
        assert_eq!(arrumar_nome("HollowKnightSilksong"), "Hollow Knight Silksong");
    }

    #[test]
    fn nao_quebra_siglas() {
        // O corte so acontece na passagem de minuscula para maiuscula, entao
        // uma sigla continua inteira em vez de virar "V L C".
        assert_eq!(arrumar_nome("VLC"), "VLC");
        assert_eq!(arrumar_nome("OBS"), "OBS");
        // E uma sigla seguida de palavra continua legivel.
        assert_eq!(arrumar_nome("VLCPlayer"), "VLCPlayer");
    }

    #[test]
    fn aguenta_o_que_nao_e_nome_de_programa() {
        assert_eq!(arrumar_nome(""), "");
        assert_eq!(arrumar_nome("___"), "");
        assert_eq!(arrumar_nome("jogo2"), "Jogo2");
    }
}
