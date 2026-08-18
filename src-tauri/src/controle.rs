//! Canal de controle local: como outro programa desta máquina aperta o mudo do
//! CALL, e fica sabendo se ele está mudo.
//!
//! Existe para o SLATE — o painel de controle que roda no celular —, mas nada
//! aqui é específico dele: é uma porta em `127.0.0.1` que aceita verbos de uma
//! lista fechada e devolve estado.
//!
//! **Por que não simular a tecla do atalho global.** O CALL já tem um atalho de
//! mudo, mas ele é uma combinação que a pessoa escolhe e troca em
//! `definir_atalho_mudo`. Quem quisesse mutar de fora estaria chutando um acorde
//! que não é dele, e que muda sem aviso. Aqui o verbo é o verbo.
//!
//! **Por que não `call://mudo`.** O esquema já existe e teria sido mais barato,
//! mas ele é de mão única: o painel do celular ficaria com um botão de mudo sem
//! saber se você está mudo, o que é cara ou coroa a cada toque. E quem trata a
//! segunda instância chama `mostrar_janela_principal` — cada aperto arrancaria a
//! janela do CALL para a frente de tudo. Uma conexão que fica aberta resolve os
//! dois: o estado é empurrado a cada mudança, e nada rouba o foco.
//!
//! **Por que ainda assim existe um segredo.** `127.0.0.1` não é uma credencial:
//! qualquer processo da máquina alcança a porta. O segredo fica num arquivo sob
//! `%LOCALAPPDATA%`, que no Windows já é por usuário, e é o que separa "roda
//! neste computador" de "pode mexer no seu microfone".

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Teto por linha recebida.
///
/// Nenhuma mensagem legítima chega perto disso; o limite existe para um cliente
/// que abra a conexão e despeje bytes sem nunca mandar `\n` não conseguir
/// crescer um buffer sem fim deste lado.
const LIMITE_DE_LINHA: u64 = 4 * 1024;

/// O que o CALL está fazendo agora, do ponto de vista de quem controla de fora.
///
/// `em_chamada` é campo próprio, e não algo deduzido de `mudo`, porque é ele que
/// decide se a tecla do outro lado deve existir: fora de um canal de voz
/// `alternarMicrofone` volta na primeira linha sem fazer nada, e um botão que
/// não faz nada é pior do que um botão ausente.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EstadoDeControle {
    pub em_chamada: bool,
    pub mudo: bool,
    pub transmitindo: bool,
}

/// O verbo pedido por quem está do outro lado da conexão.
///
/// `mudo` carrega o valor desejado em vez de alternar. Alternar por um canal que
/// pode perder ou repetir uma mensagem deixa as duas pontas discordando sem
/// ninguém perceber; dizer "fique mudo" é idempotente e converge sozinho.
#[derive(Debug, Deserialize)]
#[serde(tag = "tipo", rename_all = "kebab-case")]
enum Pedido {
    Mudo { valor: bool },
}

#[derive(Serialize)]
#[serde(tag = "tipo", rename_all = "kebab-case")]
enum Resposta<'a> {
    Estado {
        #[serde(flatten)]
        estado: &'a EstadoDeControle,
    },
}

/// O canal aberto: o estado atual e quem está escutando.
///
/// As conexões vivas ficam guardadas para o estado poder ser **empurrado**. Sem
/// isso o outro lado teria de perguntar de tempos em tempos, e o botão do
/// celular ficaria sempre um instante atrás do que aconteceu no computador.
#[derive(Default)]
pub struct Controle {
    estado: Mutex<EstadoDeControle>,
    ouvintes: Mutex<Vec<TcpStream>>,
}

impl Controle {
    fn instantaneo(&self) -> EstadoDeControle {
        self.estado.lock().map(|e| *e).unwrap_or_default()
    }

    /// Guarda o estado novo e o entrega a quem está ligado.
    ///
    /// Devolve sem escrever nada quando nada mudou: a interface chama isto a
    /// cada redesenho dos botões, e repetir a mesma linha seria ruído puro no
    /// canal.
    fn publicar(&self, novo: EstadoDeControle) {
        {
            let Ok(mut atual) = self.estado.lock() else {
                return;
            };
            if *atual == novo {
                return;
            }
            *atual = novo;
        }
        self.difundir(&novo);
    }

    fn difundir(&self, estado: &EstadoDeControle) {
        let Ok(mut ouvintes) = self.ouvintes.lock() else {
            return;
        };
        // Quem não aceita mais escrita saiu, e sai da lista aqui. Guardar
        // conexões mortas faria a lista crescer por toda a sessão.
        ouvintes.retain_mut(|fluxo| escrever_estado(fluxo, estado).is_ok());
    }

    fn registrar(&self, fluxo: TcpStream) {
        if let Ok(mut ouvintes) = self.ouvintes.lock() {
            ouvintes.push(fluxo);
        }
    }
}

fn escrever_estado(fluxo: &mut TcpStream, estado: &EstadoDeControle) -> std::io::Result<()> {
    let linha = serde_json::to_string(&Resposta::Estado { estado })
        .map_err(|erro| std::io::Error::new(std::io::ErrorKind::InvalidData, erro))?;
    fluxo.write_all(linha.as_bytes())?;
    fluxo.write_all(b"\n")?;
    fluxo.flush()
}

/// O que o CALL grava em disco para quem quiser encontrá-lo.
#[derive(Serialize)]
struct Descoberta<'a> {
    porta: u16,
    segredo: &'a str,
}

/// O que fazer quando chega um pedido de mudo.
///
/// Fica atrás de um `Fn` em vez de um `AppHandle` porque emitir o evento é a
/// única coisa que este módulo precisa do Tauri — e é justamente a peça que
/// nenhum teste consegue montar. Com a dependência reduzida a uma função, o
/// laço do socket passa a ser exercitável de verdade: conexão, credencial,
/// estado empurrado e pedido de volta, tudo sem uma janela em volta.
type AplicarMudo = Arc<dyn Fn(bool) + Send + Sync>;

/// Abre a porta e passa a atender. Silenciosamente não faz nada se falhar.
///
/// **Falhar aqui não pode atrapalhar o CALL.** Este é um recurso a mais para
/// quem tem o SLATE instalado; se a porta não subir, ou o disco não aceitar o
/// arquivo, o aplicativo de conversa continua inteiro. Por isso nada aqui
/// devolve erro para cima — o pior caso é o painel do celular não achar o CALL,
/// e é o mesmo caso de quem não tem o SLATE.
pub fn iniciar(app: &AppHandle, controle: Arc<Controle>) {
    let Some(segredo) = sortear_segredo() else {
        return;
    };
    let Ok(ouvinte) = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)) else {
        return;
    };
    let Ok(endereco) = ouvinte.local_addr() else {
        return;
    };
    if !anotar_descoberta(endereco.port(), &segredo) {
        return;
    }

    let app = app.clone();
    let aplicar: AplicarMudo = Arc::new(move |valor| {
        // Quem aplica é a interface, e de propósito: `alternarMicrofone` desliga
        // a trilha, atualiza o membro local, redesenha e avisa a sala. Mexer no
        // áudio a partir daqui deixaria a sala achando que você continua
        // falando.
        let _ = app.emit("controle-mudo", valor);
    });
    thread::spawn(move || servir(ouvinte, controle, segredo, aplicar));
}

/// O laço que aceita conexões, uma thread por conexão.
fn servir(ouvinte: TcpListener, controle: Arc<Controle>, segredo: String, aplicar: AplicarMudo) {
    for conexao in ouvinte.incoming() {
        let Ok(fluxo) = conexao else {
            continue;
        };
        let controle = controle.clone();
        let segredo = segredo.clone();
        let aplicar = aplicar.clone();
        thread::spawn(move || atender(fluxo, &aplicar, &controle, &segredo));
    }
}

/// Uma conexão, do primeiro byte ao fim.
fn atender(fluxo: TcpStream, aplicar: &AplicarMudo, controle: &Controle, segredo: &str) {
    let Ok(escrita) = fluxo.try_clone() else {
        return;
    };
    let mut leitura = BufReader::new(fluxo);

    // Primeira linha é sempre a credencial. Nada é respondido antes dela — nem
    // o estado, que já contaria se você está numa chamada agora.
    let mut primeira = String::new();
    if leitura
        .by_ref()
        .take(LIMITE_DE_LINHA)
        .read_line(&mut primeira)
        .is_err()
    {
        return;
    }
    if !credencial_confere(&primeira, segredo) {
        return;
    }

    let mut escrita = escrita;
    if escrever_estado(&mut escrita, &controle.instantaneo()).is_err() {
        return;
    }
    controle.registrar(escrita);

    let mut linha = String::new();
    loop {
        linha.clear();
        match leitura.by_ref().take(LIMITE_DE_LINHA).read_line(&mut linha) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // Linha que não vira pedido conhecido é ignorada, e a conexão continua.
        // Derrubar por causa dela transformaria "cliente mais novo que este
        // CALL" em queda de conexão, quando o certo é seguir com o que os dois
        // lados entendem.
        let Ok(pedido) = serde_json::from_str::<Pedido>(linha.trim()) else {
            continue;
        };
        match pedido {
            Pedido::Mudo { valor } => aplicar(valor),
        }
    }
}

/// Se a primeira linha traz o segredo certo.
///
/// A comparação percorre o comprimento inteiro em vez de parar no primeiro byte
/// diferente. É barato e tira do caminho a versão do ataque em que o tempo de
/// resposta entrega o segredo caractere a caractere.
fn credencial_confere(linha: &str, segredo: &str) -> bool {
    #[derive(Deserialize)]
    struct Credencial {
        segredo: String,
    }
    let Ok(credencial) = serde_json::from_str::<Credencial>(linha.trim()) else {
        return false;
    };
    let recebido = credencial.segredo.as_bytes();
    let esperado = segredo.as_bytes();
    if recebido.len() != esperado.len() {
        return false;
    }
    let mut diferenca = 0u8;
    for (a, b) in recebido.iter().zip(esperado) {
        diferenca |= a ^ b;
    }
    diferenca == 0
}

fn sortear_segredo() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Grava porta e segredo onde o SLATE sabe procurar.
///
/// `%LOCALAPPDATA%` e não a pasta do programa: no Windows ele já é por usuário,
/// então dois usuários na mesma máquina não enxergam o segredo um do outro — o
/// que importa, porque o segredo é justamente o que separa "processo desta
/// máquina" de "autorizado a mexer no seu microfone".
fn anotar_descoberta(porta: u16, segredo: &str) -> bool {
    let Ok(base) = std::env::var("LOCALAPPDATA") else {
        return false;
    };
    let pasta = std::path::Path::new(&base).join("CALL");
    if std::fs::create_dir_all(&pasta).is_err() {
        return false;
    }
    let Ok(conteudo) = serde_json::to_string(&Descoberta { porta, segredo }) else {
        return false;
    };
    std::fs::write(pasta.join("controle.json"), conteudo).is_ok()
}

/// Apaga o arquivo de descoberta.
///
/// Chamado quando o CALL encerra de verdade. Sem isto ficaria em disco uma porta
/// que não existe mais, e quem tentasse usá-la levaria uma recusa de conexão em
/// vez de entender que o CALL está fechado — os dois acabam no mesmo lugar, mas
/// o segundo é o que a pessoa consegue explicar.
pub fn esquecer_descoberta() {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        let _ = std::fs::remove_file(std::path::Path::new(&base).join("CALL").join("controle.json"));
    }
}

/// A interface conta o que mudou. Chamada a cada atualização dos botões de
/// microfone e de transmissão, que juntos cobrem as três coisas que este canal
/// publica.
#[tauri::command]
pub fn anotar_estado_de_controle(
    controle: tauri::State<'_, Arc<Controle>>,
    em_chamada: bool,
    mudo: bool,
    transmitindo: bool,
) {
    controle.publicar(EstadoDeControle {
        em_chamada,
        mudo,
        transmitindo,
    });
}

#[cfg(test)]
mod testes {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    /// Sobe o laço de verdade numa porta efêmera e devolve por onde falar com
    /// ele. Nada é simulado: é o mesmo `servir` que a partida do CALL usa.
    fn servidor_de_teste(
        controle: Arc<Controle>,
    ) -> (u16, std::sync::mpsc::Receiver<bool>) {
        let ouvinte = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let porta = ouvinte.local_addr().unwrap().port();
        let (aplicados, recebidos) = channel();
        let aplicar: AplicarMudo = Arc::new(move |valor| {
            let _ = aplicados.send(valor);
        });
        thread::spawn(move || servir(ouvinte, controle, "segredo-de-teste".into(), aplicar));
        (porta, recebidos)
    }

    #[test]
    fn a_conexao_recebe_o_estado_agora_e_as_mudancas_depois() {
        let controle = Arc::new(Controle::default());
        controle.publicar(EstadoDeControle {
            em_chamada: true,
            mudo: false,
            transmitindo: false,
        });
        let (porta, recebidos) = servidor_de_teste(controle.clone());

        let mut cliente = TcpStream::connect(("127.0.0.1", porta)).unwrap();
        writeln!(cliente, r#"{{"segredo":"segredo-de-teste"}}"#).unwrap();
        let mut leitura = BufReader::new(cliente.try_clone().unwrap());

        // O estado de agora chega sem ninguém perguntar: quem conecta no meio
        // de uma chamada precisa desenhar a tecla certa de primeira.
        let mut linha = String::new();
        leitura.read_line(&mut linha).unwrap();
        assert_eq!(
            linha.trim(),
            r#"{"tipo":"estado","emChamada":true,"mudo":false,"transmitindo":false}"#
        );

        // E o pedido chega à interface com o valor que veio, não invertido.
        writeln!(cliente, r#"{{"tipo":"mudo","valor":true}}"#).unwrap();
        assert!(recebidos.recv_timeout(Duration::from_secs(5)).unwrap());

        // Mudança acontecida no PC — pelo atalho do teclado, por exemplo — é
        // **empurrada**. É isto que impede o botão do celular de ficar mentindo
        // até alguém tocar nele.
        controle.publicar(EstadoDeControle {
            em_chamada: true,
            mudo: true,
            transmitindo: false,
        });
        linha.clear();
        leitura.read_line(&mut linha).unwrap();
        assert_eq!(
            linha.trim(),
            r#"{"tipo":"estado","emChamada":true,"mudo":true,"transmitindo":false}"#
        );
    }

    #[test]
    fn sem_o_segredo_a_conexao_nao_ve_nem_o_estado() {
        // `127.0.0.1` não é credencial: qualquer processo da máquina alcança a
        // porta. Quem erra o segredo não pode nem descobrir se há chamada
        // aberta — a conexão fecha antes de qualquer resposta.
        let controle = Arc::new(Controle::default());
        controle.publicar(EstadoDeControle {
            em_chamada: true,
            mudo: false,
            transmitindo: false,
        });
        let (porta, recebidos) = servidor_de_teste(controle);

        let mut cliente = TcpStream::connect(("127.0.0.1", porta)).unwrap();
        writeln!(cliente, r#"{{"segredo":"chute"}}"#).unwrap();
        writeln!(cliente, r#"{{"tipo":"mudo","valor":true}}"#).unwrap_or_default();

        let mut linha = String::new();
        let lidos = BufReader::new(cliente).read_line(&mut linha).unwrap_or(0);
        assert_eq!(lidos, 0, "não deveria ter respondido nada: {linha}");
        assert!(recebidos.recv_timeout(Duration::from_millis(500)).is_err());
    }


    #[test]
    fn o_arquivo_de_descoberta_sai_na_forma_que_o_slate_espera() {
        /*
         * O outro lado deste contrato é `interpretar_descoberta`, em
         * `apps/desktop/src-tauri/src/call.rs` do SLATE, e o teste
         * `o_arquivo_que_o_call_escreve_e_aceito_como_ele_escreve` fixa a mesma
         * linha de lá. Os dois precisam andar juntos.
         *
         * São instaladores separados: um campo renomeado aqui não quebraria
         * compilação nem teste nenhum no SLATE. O sintoma seria o painel do
         * celular nunca achar o CALL — sem erro, sem log, sem pista.
         */
        let escrito = serde_json::to_string(&Descoberta {
            porta: 54_321,
            segredo: "abc123",
        })
        .unwrap();
        assert_eq!(escrito, r#"{"porta":54321,"segredo":"abc123"}"#);
    }

    #[test]
    fn a_credencial_errada_nao_passa() {
        assert!(credencial_confere(r#"{"segredo":"abc"}"#, "abc"));
        assert!(!credencial_confere(r#"{"segredo":"abd"}"#, "abc"));
        // Comprimento diferente sai antes da comparação, e precisa sair como
        // recusa — não como pânico de índice.
        assert!(!credencial_confere(r#"{"segredo":"ab"}"#, "abc"));
        assert!(!credencial_confere(r#"{"segredo":"abcd"}"#, "abc"));
        // Linha que não é nem JSON, e linha sem o campo: as duas são recusa, e
        // nenhuma delas pode custar a conexão de quem mandou certo depois.
        assert!(!credencial_confere("olá", "abc"));
        assert!(!credencial_confere(r#"{"outro":"abc"}"#, "abc"));
    }

    #[test]
    fn o_pedido_de_mudo_carrega_o_valor_e_nao_alterna() {
        let Ok(Pedido::Mudo { valor }) = serde_json::from_str::<Pedido>(r#"{"tipo":"mudo","valor":true}"#)
        else {
            panic!("o pedido de mudo deveria ser reconhecido");
        };
        assert!(valor);

        // Sem valor não é pedido: aceitar isso como "alterne" traria de volta
        // exatamente a ambiguidade que o campo existe para eliminar.
        assert!(serde_json::from_str::<Pedido>(r#"{"tipo":"mudo"}"#).is_err());
        assert!(serde_json::from_str::<Pedido>(r#"{"tipo":"desligar"}"#).is_err());
    }

    #[test]
    fn o_estado_so_e_difundido_quando_muda() {
        let controle = Controle::default();
        assert_eq!(controle.instantaneo(), EstadoDeControle::default());

        let novo = EstadoDeControle {
            em_chamada: true,
            mudo: true,
            transmitindo: false,
        };
        controle.publicar(novo);
        assert_eq!(controle.instantaneo(), novo);

        // Republicar o mesmo estado não pode mexer em nada — é o que segura o
        // ruído quando a interface redesenha os botões sem nada ter mudado.
        controle.publicar(novo);
        assert_eq!(controle.instantaneo(), novo);
    }

    #[test]
    fn o_estado_sai_como_uma_linha_de_json_com_os_tres_campos() {
        let estado = EstadoDeControle {
            em_chamada: true,
            mudo: false,
            transmitindo: true,
        };
        let linha = serde_json::to_string(&Resposta::Estado { estado: &estado }).unwrap();
        assert_eq!(
            linha,
            r#"{"tipo":"estado","emChamada":true,"mudo":false,"transmitindo":true}"#
        );
    }
}
