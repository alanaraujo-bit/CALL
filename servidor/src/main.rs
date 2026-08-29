// Roda sem janela de console: o servidor e iniciado pelo proprio aplicativo.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Servidor do CALL.
//!
//! Faz tres coisas, e nenhuma delas e tocar em midia:
//!
//! 1. Guarda a estrutura dos grupos (categorias, canais) e o historico dos
//!    canais de texto.
//! 2. Autoriza a mídia da sala. Na nuvem emite tokens curtos para o LiveKit;
//!    no sidecar e em servidores antigos, encaminha a sinalização da malha P2P.
//! 3. Guarda contas — e-mail, senha, perfil e a lista de grupos —, para que
//!    trocar de computador nao signifique virar outra pessoa. Ver `contas.rs`.
//!
//! O mesmo binario atende os dois modos de uso: hospedado na internet, com
//! uma pasta de dados, ou como sidecar na maquina de quem hospeda uma
//! conversa na rede local, sem pasta nenhuma e sem memoria entre execucoes.

mod contas;
mod google;
mod midia;
mod modelo;
mod telemetria;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use contas::Cofre;
use midia::Midia;
use telemetria::Evento;
use modelo::{agora_ms, novo_codigo, novo_id, Acervo, Canal, Categoria, Grupo, TipoCanal};

type Fila = UnboundedSender<Message>;

const APELIDO_MAX: usize = 24;
const NOME_MAX: usize = 40;
const TEXTO_MAX: usize = 2000;
/// Uma linha sobre a pessoa. O servidor nao le isto, so repassa — o teto e o
/// que impede um cliente adulterado de empurrar um romance para dentro do
/// cartao de perfil de todo mundo no grupo.
const BIO_MAX: usize = 160;
/// Foto de perfil enquadrada pelo cliente. O teto acompanha `perfil.js`: a
/// imagem comum, comprimida, fica muito abaixo dele; a folga maior preserva
/// GIFs curtos sem deixar um cliente empurrar uma mensagem sem limite para o
/// grupo inteiro.
const FOTO_PERFIL_MAX_CARACTERES: usize = 2_200_000;
/// Identificador do mascote. O servidor de proposito **nao** conhece a lista:
/// mascote e assunto da interface, e uma versao nova do aplicativo com um
/// setimo desenho nao pode depender de o servidor hospedado ser atualizado
/// junto. Quem nao reconhece o identificador desenha as iniciais.
const AVATAR_MAX: usize = 24;
/// Nome do aplicativo em uso. O servidor nao interpreta este texto — ele so o
/// repassa —, entao o teto e o que impede um cliente adulterado de empurrar
/// um romance para dentro da lista de participantes de todo mundo.
const ATIVIDADE_MAX: usize = 40;
/// Icone da atividade, como data URL — pequeno de proposito. E um icone de
/// 96x96 comprimido, nao uma capa de jogo: o teto e o que impede um cliente
/// adulterado de empurrar uma imagem grande para a rede de todo mundo no
/// grupo a cada troca de programa.
const ATIVIDADE_ICONE_MAX: usize = 40_000;
const FOTO_GRUPO_MAX_CARACTERES: usize = 900_000;
const DESCRICAO_GRUPO_MAX: usize = 160;
/// Id do emoji de uma reacao — "feliz", "coracao"... O servidor de proposito
/// **nao** conhece a lista dos cinco, pelo mesmo motivo do mascote: emoji e
/// assunto da interface, e uma sexta reacao no aplicativo nao pode depender
/// de o servidor hospedado ser atualizado junto. So garante a forma
/// (minusculas, sem separador) e um teto de tamanho.
const REACAO_MAX: usize = 24;

/// Teto de mensagens por janela. Nao e defesa contra um atacante dedicado —
/// e o que impede um cliente com defeito de encher o disco de quem hospeda.
const MENSAGENS_POR_JANELA: u32 = 20;
const JANELA_MS: u64 = 10_000;

/// O que a pessoa apresenta ao grupo. Viaja na saudacao, vive enquanto a
/// conexao viver, e some com ela.
///
/// Quem entra **sem conta** continua como sempre foi: o `usuario` e um numero
/// que o proprio cliente sorteou e guarda, e o perfil e o que ele disser que
/// e — o servidor nao tem como conferir, e nao finge que tem.
///
/// Quem entra **com conta** traz um token, e ai o `usuario` deixa de ser
/// palavra do cliente: e o identificador da conta, resolvido pelo servidor.
/// E a diferenca entre "eu digo que sou a Ana" e "eu provei que sou a Ana".
#[derive(Clone)]
struct Cartao {
    usuario: String,
    apelido: String,
    avatar: String,
    bio: String,
    /// Data URL (ou enquadramento serializado que contém uma data URL) da foto.
    /// Diferente do perfil da conta, isto vive só durante a presença no grupo.
    foto: String,
    /// Conta a que esta conexao pertence, quando o token da saudacao valeu.
    conta: Option<String>,
    /// De qual casca do CALL esta conexao veio. Nao autentica nada e nao muda
    /// o que a pessoa pode fazer — e so o que o painel usa para responder
    /// "onde o CALL esta sendo usado", que e a pergunta que decide onde vale
    /// a pena investir tempo.
    plataforma: String,
}

impl Cartao {
    /// Le e recorta o cartao de uma mensagem do cliente. Recortar aqui, e nao
    /// so na interface, e o que vale: a interface e do outro lado da rede.
    ///
    /// O cofre entra para resolver o token. Com o backend de arquivo isso e
    /// so leitura de tabela; com Postgres e uma ida ao banco — por isso o
    /// metodo e assincrono, e por isso quem chama nao pode estar com nenhuma
    /// tranca de `Estado` na mao neste instante.
    async fn ler(v: &Value, cofre: &Cofre) -> Self {
        let token = texto_de(v, "token");
        let conta = if token.is_empty() {
            None
        } else {
            cofre.conta_do_token(&token).await.map(|c| c.id)
        };

        Cartao {
            usuario: match &conta {
                Some(id) => id.clone(),
                None => identidade(v),
            },
            apelido: limitar(texto_de(v, "apelido"), APELIDO_MAX, "Convidado"),
            avatar: texto_de(v, "avatar")
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
                .take(AVATAR_MAX)
                .collect(),
            bio: texto_de(v, "bio").trim().chars().take(BIO_MAX).collect(),
            foto: foto_serializada_aceita(texto_de(v, "foto"), FOTO_PERFIL_MAX_CARACTERES),
            conta,
            plataforma: plataforma_de(v),
        }
    }
}

/// Nome curto e sem surpresa da casca do cliente. Recortado aqui, e nao so
/// no cliente: o painel agrupa por este texto, e um cliente adulterado nao
/// deve conseguir inventar mil plataformas para poluir a legenda.
fn plataforma_de(v: &Value) -> String {
    texto_de(v, "plataforma")
        .chars()
        .filter(|c| c.is_ascii_lowercase())
        .take(12)
        .collect()
}

#[derive(Clone)]
struct Conexao {
    id: u64,
    usuario: String,
    apelido: String,
    /// Identificador do mascote escolhido, ou vazio para as iniciais.
    avatar: String,
    /// Uma linha sobre a pessoa, mostrada no cartao de perfil dela.
    bio: String,
    /// Foto atual anunciada ao grupo. Não é persistida pelo servidor.
    foto: String,
    /// Conta que esta conexao provou ser, ou `None` para quem entrou sem
    /// conta. E o que autoriza gravar o perfil e a lista de grupos.
    conta: Option<String>,
    grupo: Option<String>,
    canal_voz: Option<String>,
    /// Fica fixo durante a entrada para nunca formar uma call mista em que
    /// metade usa SFU e metade usa a malha antiga.
    provedor_midia: Option<String>,
    fila: Fila,
    mudo: bool,
    transmitindo: bool,
    /// Aplicativo em primeiro plano na maquina da pessoa, quando ela escolhe
    /// mostrar. Fica na conexao, e nao no acervo: e estado do momento e nao
    /// deve sobreviver a quem o produziu.
    atividade: Option<String>,
    /// Icone de uma atividade cadastrada a mao, quando a pessoa deu um nome e
    /// uma imagem para um programa que o CALL nao reconheceu sozinho. So faz
    /// sentido junto de `atividade`; sem nome nao ha o que ilustrar.
    atividade_icone: Option<String>,
    plataforma: String,
    /// Quando esta conexao entrou no canal de voz atual. E daqui que sai a
    /// duracao de uma passagem pela call, anotada na saida — o servidor nao
    /// tem cronometro proprio, e nao precisa de um.
    voz_desde: Option<u64>,
}

impl Conexao {
    fn resumo(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "usuario": self.usuario,
            "apelido": self.apelido,
            "avatar": self.avatar,
            "bio": self.bio,
            "foto": self.foto,
            "canalVoz": self.canal_voz,
            "mudo": self.mudo,
            "transmitindo": self.transmitindo,
            "atividade": self.atividade,
            "atividadeIcone": self.atividade_icone
        })
    }
}

/// Grupos, mensagens e quem esta conectado agora. As contas moram fora
/// daqui, em `Cofre` — ver a nota em `main()` sobre o porque dos dois
/// trancados separadamente.
struct Estado {
    conexoes: HashMap<u64, Conexao>,
    acervo: Acervo,
    /// Plano de mídia. Sem configuração (ou no sidecar), responde com a malha
    /// P2P antiga; na nuvem, emite credenciais curtas para o LiveKit.
    midia: Midia,
    /// conta_id -> (id de conexao -> fila), so para quem esta logado. Mais de
    /// uma conexao por conta e o caso normal, e nao a excecao: o socket de
    /// grupo (voz e canais) e o socket social (amigos e PV) da mesma pessoa
    /// costumam estar vivos ao mesmo tempo, e cada um deve receber o que
    /// chegar — nenhum dos dois e "mais dono" da presenca da conta que o
    /// outro. E o que permite entregar pedido de amizade e mensagem privada
    /// pra alguem que nao esta no mesmo grupo, em grupo nenhum, ou nem
    /// conectado a um grupo — so logado.
    online: HashMap<String, HashMap<u64, Fila>>,
    /// Conexoes com o painel administrativo aberto agora. Fica separado de
    /// `online` de proposito: ser administrador nao e uma presenca social, e
    /// o pulso ao vivo nao deve viajar para as outras abas da mesma conta que
    /// nao estao olhando o painel.
    admins: HashMap<u64, Fila>,
    /// Todo socket aberto, esteja ele em um grupo ou não.
    ///
    /// `conexoes` só conhece quem já entrou num grupo — é ela que responde
    /// "quem está neste canal". Mas o socket social existe antes disso e vive
    /// sem grupo nenhum: quem abriu o CALL e está olhando a lista de grupos
    /// está usando o CALL, e um painel que o conta como zero está mentindo
    /// sobre o presente. Este conjunto é a resposta a "quantas janelas do
    /// CALL estão abertas agora".
    sockets: std::collections::HashSet<u64>,
    /// Por onde os acontecimentos saem para serem gravados. E um canal, e nao
    /// uma chamada ao cofre, porque quase tudo que vale anotar acontece
    /// dentro de uma funcao sincrona com a tranca de `Estado` na mao —
    /// esperar o banco ali pararia o encaminhamento de voz de todo mundo.
    diario: UnboundedSender<Evento>,
}

impl Estado {
    fn do_grupo(&self, codigo: &str) -> Vec<Conexao> {
        self.conexoes
            .values()
            .filter(|c| c.grupo.as_deref() == Some(codigo))
            .cloned()
            .collect()
    }

    /// Quem esta no mesmo canal de voz — a malha WebRTC e formada aqui, e nao
    /// no grupo inteiro: estar no mesmo servidor nao e estar na mesma conversa.
    fn na_voz(&self, canal: &str) -> Vec<Conexao> {
        self.conexoes
            .values()
            .filter(|c| c.canal_voz.as_deref() == Some(canal))
            .cloned()
            .collect()
    }

    fn difundir(&self, codigo: &str, aviso: &Value, exceto: Option<u64>) {
        for c in self.do_grupo(codigo) {
            if Some(c.id) != exceto {
                let _ = c.fila.send(texto_json(aviso));
            }
        }
    }

    /// Entrega ponto a ponto pela conta, e não pelo grupo — o par de
    /// `difundir` para tudo que é amizade/PV, que por definição pode
    /// atravessar grupos diferentes ou não estar em grupo nenhum. Manda para
    /// **todas** as conexões vivas da conta (grupo e social podem coexistir),
    /// e não faz nada quando nenhuma está conectada agora — quem chama não
    /// precisa checar isso antes.
    fn enviar_a_conta(&self, conta_id: &str, aviso: &Value) {
        if let Some(conexoes) = self.online.get(conta_id) {
            for fila in conexoes.values() {
                let _ = fila.send(texto_json(aviso));
            }
        }
    }

    /// Registra esta conexão como presença de `conta_id` — chamado tanto por
    /// quem entra num grupo quanto por qualquer pedido do socket social
    /// (amigos, PV) autenticado por token: os dois são formas igualmente
    /// válidas de "estar por aqui", e nenhuma delas exige a outra.
    fn registrar_online(&mut self, conta_id: &str, id: u64, fila: &Fila) {
        self.online.entry(conta_id.to_string()).or_default().insert(id, fila.clone());
    }

    /// Anota um acontecimento. Nunca falha e nunca espera: se o canal
    /// estiver fechado (o servidor desligando), o evento se perde em
    /// silencio, que e exatamente o que se quer de telemetria.
    fn anotar(&self, tipo: &str, conta: Option<String>, alvo: &str, valor: i64, plataforma: &str) {
        self.anotar_meio(tipo, conta, alvo, valor, plataforma, "", 0);
    }

    /// A mesma anotacao, dizendo tambem **por onde** a midia passou e quanta
    /// banda custou. So os acontecimentos de voz tem transporte; para o
    /// resto, `meio` e vazio e o painel nao inventa um.
    fn anotar_meio(
        &self,
        tipo: &str,
        conta: Option<String>,
        alvo: &str,
        valor: i64,
        plataforma: &str,
        meio: &str,
        bytes: u64,
    ) {
        let _ = self.diario.send(Evento {
            em: agora_ms(),
            tipo: tipo.to_string(),
            conta,
            alvo: alvo.to_string(),
            valor,
            plataforma: plataforma.to_string(),
            meio: meio.to_string(),
            bytes,
        });
    }

    fn avisar_admins(&self, aviso: &Value) {
        for fila in self.admins.values() {
            let _ = fila.send(texto_json(aviso));
        }
    }

    /// O retrato do instante: o que esta acontecendo agora, sem passar por
    /// banco nenhum. Sai daqui porque so a memoria deste processo sabe disso
    /// — nenhuma tabela guarda "quem esta conectado".
    fn pulso(&self) -> Value {
        let mut em_voz = 0usize;
        let mut transmitindo = 0usize;
        let mut com_conta = 0usize;
        let mut grupos: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut canais: std::collections::HashSet<&str> = std::collections::HashSet::new();

        for c in self.conexoes.values() {
            if c.canal_voz.is_some() {
                em_voz += 1;
            }
            if c.transmitindo {
                transmitindo += 1;
            }
            if c.conta.is_some() {
                com_conta += 1;
            }
            if let Some(g) = &c.grupo {
                grupos.insert(g);
            }
            if let Some(v) = &c.canal_voz {
                canais.insert(v);
            }
        }

        // Uma janela recém-aberta no portal não é conexão de grupo nem
        // presença de conta: ela existe, e some do painel se ninguém a
        // contar. Some-la seria fazer "quem está conectado" contradizer
        // "quantas janelas estão abertas", que é o pior defeito que um painel
        // ao vivo pode ter — dois números na mesma tela discordando.
        let mut identificados: std::collections::HashSet<u64> = self.conexoes.keys().copied().collect();
        for filas in self.online.values() {
            identificados.extend(filas.keys().copied());
        }
        let sem_identificacao = self.sockets.difference(&identificados).count();

        json!({
            "em": agora_ms(),
            "sockets": self.sockets.len(),
            "semIdentificacao": sem_identificacao,
            "conexoes": self.conexoes.len(),
            "contasOnline": self.online.len(),
            "comConta": com_conta,
            "semConta": self.conexoes.len().saturating_sub(com_conta),
            "emVoz": em_voz,
            "transmitindo": transmitindo,
            "gruposAtivos": grupos.len(),
            "canaisDeVozAtivos": canais.len(),
        })
    }

    /// Quem esta conectado agora, um por linha, para a aba "Ao vivo". Traz o
    /// nome do grupo e do canal resolvidos, porque um codigo de dez letras
    /// nao diz nada a quem esta lendo.
    fn presentes_para_painel(&self) -> Vec<Value> {
        let mut lista: Vec<Value> = self
            .conexoes
            .values()
            .map(|c| {
                let grupo = c.grupo.as_ref().and_then(|g| self.acervo.grupos.get(g));
                let canal = c.canal_voz.as_ref().and_then(|id| {
                    self.acervo
                        .grupos
                        .values()
                        .find_map(|g| g.canal(id))
                        .map(|c| c.nome.clone())
                });
                json!({
                    "id": c.id.to_string(),
                    "usuario": c.usuario,
                    "apelido": c.apelido,
                    "avatar": c.avatar,
                    "conta": c.conta,
                    "plataforma": c.plataforma,
                    "grupo": grupo.map(|g| g.nome.clone()),
                    "grupoCodigo": c.grupo,
                    "canalVoz": canal,
                    "mudo": c.mudo,
                    "transmitindo": c.transmitindo,
                    "atividade": c.atividade,
                    "desdeVoz": c.voz_desde,
                })
            })
            .collect();
        // Quem está logado sem ter entrado em grupo nenhum. Desta conexao o
        // servidor so sabe a conta — apelido e mascote nao viajam pelo socket
        // social —, e por isso a linha vai sem nome: quem o resolve e o
        // painel, que ja tem a lista de pessoas em maos.
        let em_grupo: std::collections::HashSet<&str> =
            self.conexoes.values().filter_map(|c| c.conta.as_deref()).collect();
        for conta in self.online.keys() {
            if em_grupo.contains(conta.as_str()) {
                continue;
            }
            lista.push(json!({
                "id": conta,
                "conta": conta,
                "apelido": Value::Null,
                "avatar": "",
                "plataforma": "",
                "grupo": Value::Null,
                "canalVoz": Value::Null,
                "mudo": false,
                "transmitindo": false,
                "noPortal": true,
            }));
        }

        lista.sort_by(|a, b| a["apelido"].as_str().cmp(&b["apelido"].as_str()));
        lista
    }

    /// Os grupos que existem, com o que se sabe deles sem sair da memoria: a
    /// estrutura vem do acervo, a presenca vem das conexoes.
    fn grupos_para_painel(&self, membros: &HashMap<String, u64>) -> Vec<Value> {
        let mut lista: Vec<Value> = self
            .acervo
            .grupos
            .values()
            .map(|g| {
                let canais = g.ids_de_canal();
                let mensagens: usize = canais.iter().map(|c| self.acervo.historico(c).len()).sum();
                let ultima = canais
                    .iter()
                    .filter_map(|c| self.acervo.historico(c).last().map(|m| m.em))
                    .max();
                json!({
                    "codigo": g.codigo,
                    "nome": g.nome,
                    "descricao": g.descricao,
                    "dono": g.dono,
                    "categorias": g.categorias.len(),
                    "canais": canais.len(),
                    "canaisDeVoz": g.categorias.iter()
                        .flat_map(|c| c.canais.iter())
                        .filter(|c| c.tipo == TipoCanal::Voz)
                        .count(),
                    "mensagens": mensagens,
                    "ultimaMensagemEm": ultima,
                    "membros": membros.get(&g.codigo).copied().unwrap_or(0),
                    "online": self.do_grupo(&g.codigo).len(),
                    "sons": self.acervo.sons_do_grupo(&g.codigo).len(),
                })
            })
            .collect();
        lista.sort_by(|a, b| {
            b["online"]
                .as_u64()
                .cmp(&a["online"].as_u64())
                .then_with(|| b["ultimaMensagemEm"].as_u64().cmp(&a["ultimaMensagemEm"].as_u64()))
                .then_with(|| b["membros"].as_u64().cmp(&a["membros"].as_u64()))
        });
        lista
    }
}

static PROXIMO_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() {
    // A porta vem do argumento (sidecar) ou de PORT (servicos de hospedagem
    // atribuem a porta ao processo, nao o contrario).
    let porta = std::env::args()
        .nth(1)
        .and_then(|a| a.parse::<u16>().ok())
        .or_else(|| std::env::var("PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(8787);

    let pasta = std::env::var("DADOS").ok().map(PathBuf::from);

    let escuta = match TcpListener::bind(("0.0.0.0", porta)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sinalizacao] falha ao abrir a porta {porta}: {e}");
            std::process::exit(1);
        }
    };

    println!("[sinalizacao] pronto em ws://0.0.0.0:{porta}");

    if google::disponivel() {
        println!("[contas] entrar com o Google: ligado");
    }

    // Duas trancas, e nao uma, de proposito. `Estado` (grupos, mensagens,
    // quem esta conectado) muda a cada mensagem de voz e precisa de acesso
    // sincrono e barato. `Cofre` (contas) pode, com Postgres, esperar a rede
    // — e segurar `Estado` durante essa espera pararia o encaminhamento de
    // voz de todo mundo por causa de um cadastro de outra pessoa.
    let cofre = Arc::new(Cofre::carregar(pasta.clone()).await);

    // O diario e uma fila, e nao uma chamada direta ao cofre: quem anota um
    // acontecimento (entrar na voz, mandar uma mensagem) esta quase sempre
    // com a tranca de `Estado` na mao, e nao pode esperar disco nem rede.
    let (diario, mut recebidos) = unbounded_channel::<Evento>();

    let estado = Arc::new(Mutex::new(Estado {
        conexoes: HashMap::new(),
        acervo: Acervo::carregar(pasta),
        midia: Midia::do_ambiente(),
        online: HashMap::new(),
        admins: HashMap::new(),
        sockets: std::collections::HashSet::new(),
        diario,
    }));

    // O consumo do ciclo, relido do historico.
    //
    // A escada de midia conta minutos e banda na memoria deste processo,
    // porque e ali que a decisao de emitir ou nao um token acontece — mas a
    // memoria de um processo termina no proximo redeploy, e numa hospedagem
    // gerenciada isso acontece toda vez que se publica. Sem esta releitura,
    // o teto que existe para proteger a fatura zeraria varias vezes por mes
    // e nunca chegaria a proteger nada.
    {
        let ciclo_desde = estado.lock().unwrap().midia.ciclo_desde();
        let passado = cofre.eventos_desde(ciclo_desde).await;
        let mut e = estado.lock().unwrap();
        let mut recuperados = 0usize;
        for evento in &passado {
            if evento.tipo != telemetria::tipo::VOZ_SAIU || evento.meio.is_empty() {
                continue;
            }
            e.midia.somar_consumo(&evento.meio, evento.valor, evento.bytes);
            recuperados += 1;
        }
        if recuperados > 0 {
            println!("[midia] consumo do ciclo recuperado de {recuperados} passagens pela call.");
        }
    }

    // O escriba: grava cada acontecimento e, so quando ha alguem com o painel
    // aberto, o repassa ao vivo. Uma tarefa so, em serie de proposito — a
    // ordem de gravacao e a ordem em que aconteceu.
    {
        let cofre = cofre.clone();
        let estado = estado.clone();
        tokio::spawn(async move {
            while let Some(evento) = recebidos.recv().await {
                let copia = evento.clone();
                cofre.registrar_evento(evento).await;

                // A tranca so e tomada depois da escrita, nunca durante: um
                // Postgres lento nao pode parar o resto do servidor.
                let e = estado.lock().unwrap();
                if !e.admins.is_empty() {
                    e.avisar_admins(&json!({
                        "tipo": "admin-evento",
                        "evento": copia,
                        "pulso": e.pulso()
                    }));
                }
            }
        });
    }

    // O pulso: o retrato do instante, de cinco em cinco segundos, e so para
    // quem esta olhando. Sem ninguem no painel, isto e um `if` e um `continue`
    // a cada cinco segundos — o custo de nao ter que perguntar.
    {
        let estado = estado.clone();
        tokio::spawn(async move {
            let mut relogio = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                relogio.tick().await;
                let e = estado.lock().unwrap();
                if e.admins.is_empty() {
                    continue;
                }
                e.avisar_admins(&json!({
                    "tipo": "admin-pulso",
                    "pulso": e.pulso(),
                    "presentes": e.presentes_para_painel()
                }));
            }
        });
    }

    loop {
        // Um erro de accept costuma ser transitorio (descritor esgotado, par
        // que desistiu antes do handshake). Derrubar o laco mataria o servidor
        // em silencio, ja que ele roda sem console.
        let fluxo = match escuta.accept().await {
            Ok((fluxo, _)) => fluxo,
            Err(e) => {
                eprintln!("[sinalizacao] accept falhou: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };

        let estado = estado.clone();
        let cofre = cofre.clone();
        tokio::spawn(async move {
            if let Err(e) = atender(fluxo, estado, cofre).await {
                eprintln!("[sinalizacao] conexao encerrada: {e}");
            }
        });
    }
}

/// Cabecalho HTTP maior que isto e recusado. Um aperto de mao de WebSocket de
/// navegador, ja acrescido dos `X-Forwarded-*` que um proxy de hospedagem
/// insere, fica na casa de 1 KB; 8 KB e o limite usual dos servidores HTTP.
const CABECALHO_MAX: usize = 8192;

/// Servicos de hospedagem verificam a saude do processo com um GET comum.
/// O aperto de mao do WebSocket recusaria esse GET, e o servico concluiria
/// que o servidor esta morto. Respondemos a ele antes de entregar o fluxo ao
/// WebSocket — sem consumir nada, para o aperto de mao seguir intacto.
///
/// A decisao so pode ser tomada com o bloco de cabecalhos inteiro em maos.
/// Espiar uma janela curta parece equivalente e nao e: `Upgrade` nao tem
/// posicao fixa, vem depois do `User-Agent` (que num navegador e longo), e um
/// proxy ainda empurra tudo para baixo com os cabecalhos que acrescenta. Um
/// aperto de mao de navegador atras de proxy passava de 512 bytes sem que o
/// `Upgrade` aparecesse na janela — e era servido como se fosse um GET comum,
/// fechando a conexao com o codigo 1006 do lado do cliente.
async fn responder_se_for_http(fluxo: &TcpStream) -> Result<bool, String> {
    let mut espiada = vec![0u8; CABECALHO_MAX];

    for _ in 0..200 {
        // `peek` nao consome: o aperto de mao do WebSocket relera os mesmos
        // bytes logo em seguida.
        let lidos = match fluxo.peek(&mut espiada).await {
            Ok(0) => return Err("conexao fechada antes do pedido".into()),
            Ok(n) => n,
            Err(e) => return Err(e.to_string()),
        };

        let visto = String::from_utf8_lossy(&espiada[..lidos]).to_lowercase();

        // Com o bloco inteiro em maos a resposta e definitiva.
        if let Some(fim) = visto.find("\r\n\r\n") {
            return Ok(!visto[..fim].contains("upgrade: websocket"));
        }

        // Sem o fim do bloco, so uma resposta e segura: achar o Upgrade prova
        // que e WebSocket. Nao acha-lo ainda nao prova nada.
        if visto.contains("upgrade: websocket") {
            return Ok(false);
        }

        if lidos >= CABECALHO_MAX {
            return Ok(true);
        }

        // O cabecalho chegou pela metade. `peek` devolveria os mesmos bytes na
        // hora, entao esperar um instante e o que evita girar em falso.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    Ok(true)
}

// ------------------------------------------------------------- painel admin

/// A página do painel, embutida no binário em tempo de compilação — o
/// mesmo motivo de `capabilities/default.json` não ser lido do disco em
/// produção: o servidor é um único artefato implantável, sem pasta de
/// assets ao lado para se perder.
const PAGINA_ADMIN: &str = include_str!("../admin.html");

/// Tamanho máximo do corpo de um pedido HTTP — generoso o bastante para o
/// maior corpo que o painel manda (uma mudança de status, poucos bytes de
/// JSON), apertado o bastante para não virar uma porta de upload disfarçada.
const HTTP_CORPO_MAX: usize = 16 * 1024;

struct PedidoHttp {
    metodo: String,
    caminho: String,
    cabecalhos: HashMap<String, String>,
    corpo: Vec<u8>,
}

impl PedidoHttp {
    fn cabecalho(&self, nome: &str) -> Option<&str> {
        self.cabecalhos.get(nome).map(String::as_str)
    }
}

/// Lê um pedido HTTP simples do socket — linha de pedido, cabeçalhos e corpo
/// por `Content-Length`. De propósito não entende `chunked` nem `multipart`:
/// o único cliente é a própria página em `admin.html`, que nunca manda nada
/// disso. Um parser HTTP completo compraria correção que ninguém aqui usa —
/// mesmo raciocínio que já vale para o corpo de um som do soundboard, que
/// viaja em base64 dentro do WebSocket em vez de multipart (ver `Cargo.toml`).
async fn ler_pedido_http(fluxo: &mut TcpStream) -> Result<PedidoHttp, String> {
    use tokio::io::AsyncReadExt;

    let mut bruto = Vec::new();
    let mut buf = [0u8; 2048];
    let fim_cabecalho = loop {
        let n = fluxo.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("conexão fechada antes do pedido".into());
        }
        bruto.extend_from_slice(&buf[..n]);
        if let Some(pos) = bruto.windows(4).position(|j| j == b"\r\n\r\n") {
            break pos;
        }
        if bruto.len() > CABECALHO_MAX {
            return Err("cabeçalho grande demais".into());
        }
    };

    let texto_cabecalho = String::from_utf8_lossy(&bruto[..fim_cabecalho]).to_string();
    let mut linhas = texto_cabecalho.split("\r\n");
    let primeira = linhas.next().unwrap_or_default();
    let mut partes = primeira.split_whitespace();
    let metodo = partes.next().unwrap_or_default().to_string();
    let caminho = partes.next().unwrap_or_default().to_string();

    let mut cabecalhos = HashMap::new();
    for linha in linhas {
        if let Some((chave, valor)) = linha.split_once(':') {
            cabecalhos.insert(chave.trim().to_lowercase(), valor.trim().to_string());
        }
    }

    let tamanho: usize = cabecalhos
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(HTTP_CORPO_MAX);

    let mut corpo = bruto[fim_cabecalho + 4..].to_vec();
    while corpo.len() < tamanho {
        let n = fluxo.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        corpo.extend_from_slice(&buf[..n]);
    }
    corpo.truncate(tamanho);

    Ok(PedidoHttp { metodo, caminho, cabecalhos, corpo })
}

fn resposta_http(status: u16, motivo: &str, tipo: &str, corpo: &[u8]) -> Vec<u8> {
    let cabecalho = format!(
        "HTTP/1.1 {status} {motivo}\r\nContent-Type: {tipo}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        corpo.len()
    );
    let mut resposta = cabecalho.into_bytes();
    resposta.extend_from_slice(corpo);
    resposta
}

fn resposta_texto(status: u16, motivo: &str, corpo: &str) -> Vec<u8> {
    resposta_http(status, motivo, "text/plain; charset=utf-8", corpo.as_bytes())
}

fn resposta_json(status: u16, motivo: &str, valor: &Value) -> Vec<u8> {
    resposta_http(status, motivo, "application/json", valor.to_string().as_bytes())
}

/// O único jeito de entrar no painel: uma variável de ambiente, sem cadastro
/// nem papéis — é uma pessoa só usando. Sem `ADMIN_TOKEN` no ambiente, toda
/// rota de dado recusa; a comparação byte a byte (e não `==` cedo demais)
/// evita que o tempo de resposta vaze quantos caracteres já bateram.
async fn admin_autorizado(pedido: &PedidoHttp, cofre: &Cofre) -> bool {
    let Some(cabecalho) = pedido.cabecalho("authorization") else { return false };
    let Some(recebido) = cabecalho.strip_prefix("Bearer ") else { return false };

    // O mesmo token de sessão que o aplicativo já guarda abre a porta, desde
    // que a conta dele seja a do dono. É o que faz o painel de dentro do CALL
    // e esta página serem a mesma coisa autenticada do mesmo jeito, em vez de
    // duas senhas para a mesma sala.
    if let Some(conta) = cofre.conta_do_token(recebido).await {
        if contas::e_admin(&conta.email) {
            return true;
        }
    }

    let Ok(esperado) = std::env::var("ADMIN_TOKEN") else { return false };
    if esperado.is_empty() {
        return false;
    }

    let e = esperado.as_bytes();
    let r = recebido.as_bytes();
    if e.len() != r.len() {
        return false;
    }
    let mut diferenca = 0u8;
    for (a, b) in e.iter().zip(r.iter()) {
        diferenca |= a ^ b;
    }
    diferenca == 0
}

async fn atender_http(mut fluxo: TcpStream, estado: Arc<Mutex<Estado>>, cofre: Arc<Cofre>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let pedido = match ler_pedido_http(&mut fluxo).await {
        Ok(p) => p,
        Err(_) => {
            let _ = fluxo.shutdown().await;
            return Ok(());
        }
    };

    let resposta = rotear_http(&pedido, &estado, &cofre).await;
    let _ = fluxo.write_all(&resposta).await;
    let _ = fluxo.shutdown().await;
    Ok(())
}

async fn rotear_http(pedido: &PedidoHttp, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) -> Vec<u8> {
    let caminho = pedido.caminho.split('?').next().unwrap_or("");

    match (pedido.metodo.as_str(), caminho) {
        ("GET", "/") => resposta_texto(200, "OK", "CALL: servidor de sinalizacao no ar."),

        ("GET", "/admin" | "/admin/") => {
            resposta_http(200, "OK", "text/html; charset=utf-8", PAGINA_ADMIN.as_bytes())
        }

        ("GET", "/admin/api/feedback") => {
            if !admin_autorizado(pedido, cofre).await {
                return resposta_json(401, "Unauthorized", &json!({ "erro": "token inválido" }));
            }
            let lista = cofre.todos_feedbacks().await;
            resposta_json(200, "OK", &json!({ "feedback": lista }))
        }

        ("POST", caminho) if caminho.starts_with("/admin/api/feedback/") && caminho.ends_with("/status") => {
            if !admin_autorizado(pedido, cofre).await {
                return resposta_json(401, "Unauthorized", &json!({ "erro": "token inválido" }));
            }
            let id = caminho
                .trim_start_matches("/admin/api/feedback/")
                .trim_end_matches("/status");
            let Ok(corpo) = serde_json::from_slice::<Value>(&pedido.corpo) else {
                return resposta_json(400, "Bad Request", &json!({ "erro": "corpo inválido" }));
            };
            let status = corpo.get("status").and_then(Value::as_str).unwrap_or("");

            match cofre.mudar_status_feedback(id, status).await {
                Some(feedback) => {
                    // O autor sabe na hora, se estiver online — o mesmo canal
                    // ponto-a-ponto que já entrega mensagem privada.
                    let aviso = json!({ "tipo": "feedback-atualizado", "feedback": feedback });
                    estado.lock().unwrap().enviar_a_conta(&feedback.conta_id, &aviso);
                    resposta_json(200, "OK", &json!({ "feedback": feedback }))
                }
                None => resposta_json(404, "Not Found", &json!({ "erro": "feedback ou status inválido" })),
            }
        }

        _ => resposta_texto(404, "Not Found", "Não encontrado."),
    }
}

async fn atender(fluxo: TcpStream, estado: Arc<Mutex<Estado>>, cofre: Arc<Cofre>) -> Result<(), String> {
    let _ = fluxo.set_nodelay(true);

    if responder_se_for_http(&fluxo).await? {
        return atender_http(fluxo, estado, cofre).await;
    }

    let ws = tokio_tungstenite::accept_async(fluxo)
        .await
        .map_err(|e| e.to_string())?;
    let (mut escritor, mut leitor) = ws.split();

    let (fila, mut receptor) = unbounded_channel::<Message>();

    // Bombeia a fila de saida em uma tarefa propria para que o relay
    // entre participantes nunca bloqueie o laco de leitura.
    let envio = tokio::spawn(async move {
        while let Some(msg) = receptor.recv().await {
            if escritor.send(msg).await.is_err() {
                break;
            }
        }
    });

    let id = PROXIMO_ID.fetch_add(1, Ordering::Relaxed);
    estado.lock().unwrap().sockets.insert(id);
    let mut janela_inicio = agora_ms();
    let mut enviadas_na_janela = 0u32;
    let mut pedidos_de_conta = 0u32;

    while let Some(Ok(msg)) = leitor.next().await {
        let texto = match msg {
            Message::Text(t) => t,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };

        let Ok(v) = serde_json::from_str::<Value>(&texto) else {
            continue;
        };

        let agora = agora_ms();
        if agora.saturating_sub(janela_inicio) > JANELA_MS {
            janela_inicio = agora;
            enviadas_na_janela = 0;
        }

        let tipo = v.get("tipo").and_then(Value::as_str).unwrap_or("");
        // Envio de som reusa o mesmo contador de "mensagem": os dois sao acao
        // repetitiva de quem esta no grupo, e o teto existe para o mesmo
        // motivo — um cliente com defeito nao deve conseguir encher o disco
        // de quem hospeda.
        if matches!(tipo, "mensagem" | "mensagem-privada" | "adicionar-som" | "adicionar-som-pessoal" | "feedback-enviar") {
            enviadas_na_janela += 1;
            if enviadas_na_janela > MENSAGENS_POR_JANELA {
                let _ = fila.send(erro("Muitas mensagens em pouco tempo."));
                continue;
            }
        }

        // Cadastro e login precisam de Argon2 (e, com Postgres, de rede), e
        // nao podem acontecer com `Estado` trancado nem dentro deste laco
        // sem controle de repeticao. Por isso saem daqui, e nao de `tratar`.
        if e_pedido_de_conta(tipo) {
            pedidos_de_conta += 1;
            // Um cliente honesto faz um punhado destes por conexao. Passar
            // muito disso e alguem varrendo senhas — e cada tentativa custa
            // Argon2 do lado de ca.
            if pedidos_de_conta > PEDIDOS_DE_CONTA_MAX {
                let _ = fila.send(recusa("senha", "Tentativas demais nesta conexão."));
                continue;
            }
            atender_conta(tipo, &v, &fila, &estado, &cofre).await;
            continue;
        }

        tratar(tipo, &v, id, &fila, &estado, &cofre).await;
    }

    despedir(id, &estado);
    envio.abort();
    Ok(())
}

async fn tratar(tipo: &str, v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    match tipo {
        "criar-grupo" => criar_grupo(v, id, fila, estado, cofre).await,
        "entrar" => entrar(v, id, fila, estado, cofre).await,
        "entrar-voz" => entrar_voz(v, id, fila, estado),
        "sair-voz" => sair_voz(v, id, estado),
        "midia-falhou" => midia_falhou(v, id, fila, estado),
        "midia-entrou" => midia_entrou(v, id, estado),
        "sinal" => sinal(v, id, estado),
        "estado" => estado_de_midia(v, id, estado),
        "assistindo" => estado_de_assistencia(v, id, estado),
        "perfil" => perfil(v, id, estado, cofre).await,
        "mensagem" => mensagem(v, id, fila, estado),
        "editar-mensagem" => alterar_mensagem(v, id, fila, estado, false),
        "excluir-mensagem" => alterar_mensagem(v, id, fila, estado, true),
        "reagir" => reagir(v, id, estado),
        "historico" => historico(v, id, fila, estado),
        "criar-categoria" => criar_categoria(v, id, fila, estado),
        "criar-canal" => criar_canal(v, id, fila, estado),
        "editar-grupo" => editar_grupo(v, id, fila, estado),
        "renomear" => renomear(v, id, fila, estado),
        "remover" => remover(v, id, fila, estado),
        "guardar" => guardar(v, fila, cofre).await,
        "adicionar-som" => adicionar_som(v, id, fila, estado),
        "remover-som" => remover_som(v, id, fila, estado),
        "pedir-som" => pedir_som(v, id, fila, estado),
        "som-tocado" => som_tocado(v, id, estado),
        "adicionar-som-pessoal" => adicionar_som_pessoal(v, fila, cofre).await,
        "remover-som-pessoal" => remover_som_pessoal(v, fila, cofre).await,
        "pedir-som-pessoal" => pedir_som_pessoal(v, fila, cofre).await,
        "listar-sons-pessoais" => listar_sons_pessoais(v, fila, cofre).await,
        "escolher-som-entrada" => escolher_som_entrada(v, fila, cofre).await,
        "amigo-pedido" => amigo_pedido(v, id, fila, estado, cofre).await,
        "amigo-responder" => amigo_responder(v, id, fila, estado, cofre).await,
        "amigo-remover" => amigo_remover(v, id, fila, estado, cofre).await,
        "amigos" => listar_amigos(v, id, fila, estado, cofre).await,
        "presencas-grupos" => listar_presencas_grupos(v, fila, estado, cofre).await,
        "mensagem-privada" => mensagem_privada(v, id, fila, estado, cofre).await,
        "editar-mensagem-privada" => alterar_mensagem_privada(v, id, fila, estado, cofre, false).await,
        "excluir-mensagem-privada" => alterar_mensagem_privada(v, id, fila, estado, cofre, true).await,
        "reagir-privado" => reagir_privado(v, id, fila, estado, cofre).await,
        "historico-privado" => historico_privado(v, id, fila, estado, cofre).await,
        "feedback-enviar" => feedback_enviar(v, id, fila, estado, cofre).await,
        "feedback-meu" => feedback_meu(v, id, fila, estado, cofre).await,
        "admin-painel" => admin_painel(v, id, fila, estado, cofre).await,
        "admin-largar" => {
            estado.lock().unwrap().admins.remove(&id);
        }
        "admin-feedback" => admin_mudar_feedback(v, fila, estado, cofre).await,
        "admin-midia" => admin_midia(v, fila, estado, cofre).await,
        _ => {}
    }
}

// ----------------------------------------------------------------- contas

/// Teto de pedidos de conta por conexao. Generoso para quem erra a senha e
/// tenta de novo, apertado para quem esta varrendo.
const PEDIDOS_DE_CONTA_MAX: u32 = 30;

fn e_pedido_de_conta(tipo: &str) -> bool {
    matches!(
        tipo,
        "cadastrar" | "entrar-conta" | "retomar" | "sair-conta" | "google-config" | "google-entrar"
    )
}

async fn atender_conta(
    tipo: &str,
    v: &Value,
    fila: &Fila,
    estado: &Arc<Mutex<Estado>>,
    cofre: &Arc<Cofre>,
) {
    match tipo {
        "cadastrar" => cadastrar(v, fila, estado, cofre).await,
        "entrar-conta" => entrar_conta(v, fila, estado, cofre).await,
        "retomar" => retomar(v, fila, estado, cofre).await,
        "sair-conta" => sair_conta(v, fila, estado, cofre).await,
        "google-config" => {
            // Dois identificadores, um por casca: o CALL de Windows volta numa
            // porta local (cliente de computador) e o de celular volta na
            // propria pagina (cliente Web). Cada um pega o seu; ver a nota em
            // `google.rs` sobre por que nao da para ser um so.
            let _ = fila.send(texto_json(&json!({
                "tipo": "google",
                "disponivel": google::disponivel(),
                "clienteId": google::cliente_id().unwrap_or_default(),
                "clienteIdWeb": google::cliente_id_web().unwrap_or_default()
            })));
        }
        "google-entrar" => google_entrar(v, fila, estado, cofre).await,
        _ => {}
    }
}

/// Calcula o hash longe do laco de eventos. Argon2 gasta 19 MB e dezenas de
/// milissegundos de CPU: feito aqui dentro, cada login pararia o
/// encaminhamento de voz de todo mundo pelo tempo da conta.
async fn em_paralelo<F, T>(trabalho: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(trabalho).await.ok()
}

async fn cadastrar(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let email = match contas::normalizar_email(&texto_de(v, "email")) {
        Ok(e) => e,
        Err(r) => return recusar(fila, r),
    };
    let senha = texto_de(v, "senha");
    if let Err(r) = contas::conferir_senha_nova(&senha) {
        return recusar(fila, r);
    }

    let apelido = limitar(texto_de(v, "apelido"), APELIDO_MAX, "");
    if apelido.is_empty() {
        return recusar(
            fila,
            contas::Recusa {
                campo: "apelido",
                motivo: "Escolha como querem te chamar.".into(),
            },
        );
    }

    // Conferido antes de gastar o Argon2 — poupa a CPU de um pedido que ja se
    // sabe recusado. O cofre confere de novo por dentro, na hora de gravar:
    // duas pessoas podem pedir o mesmo e-mail enquanto o hash rodava, e so
    // ali a resposta e definitiva.
    if cofre.email_ocupado(&email).await {
        return recusar(
            fila,
            contas::Recusa {
                campo: "email",
                motivo: "Já existe uma conta com este e-mail.".into(),
            },
        );
    }

    let Some(Ok(hash)) = em_paralelo(move || contas::cifrar(&senha)).await else {
        let _ = fila.send(erro("Não foi possível criar a conta agora."));
        return;
    };

    // O mascote e a bio ja vem escolhidos: o cadastro e uma tela so, e nao
    // um formulario seguido de "agora monte seu perfil".
    let avatar: String = texto_de(v, "avatar").chars().take(AVATAR_MAX).collect();
    let bio: String = texto_de(v, "bio").trim().chars().take(BIO_MAX).collect();

    match cofre.cadastrar(email, hash, apelido, avatar, bio).await {
        Ok(id) => {
            // A conta nasce aqui, e este e o unico evento que so acontece uma
            // vez por pessoa: e dele que toda coorte de retencao parte.
            estado.lock().unwrap().anotar(
                telemetria::tipo::CONTA_CRIADA,
                Some(id.clone()),
                "",
                0,
                &plataforma_de(v),
            );
            responder_sessao(cofre, &id, fila).await;
        }
        Err(r) => recusar(fila, r),
    }
}

async fn entrar_conta(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    // O e-mail e normalizado, mas um erro de forma aqui nao merece a licao de
    // gramatica do cadastro: quem esta entrando ou acerta a conta que tem, ou
    // nao tem conta — e as duas respostas sao a mesma.
    let email = contas::normalizar_email(&texto_de(v, "email")).unwrap_or_default();
    let senha = texto_de(v, "senha");

    let restante = cofre.castigo_restante(&email);
    if restante > 0 {
        let minutos = (restante / 60_000) + 1;
        return recusar(
            fila,
            contas::Recusa {
                campo: "senha",
                motivo: format!("Muitas tentativas. Tente de novo em {minutos} minuto(s)."),
            },
        );
    }

    // Um e-mail sem conta segue o mesmo caminho, com hash vazio: e
    // `contas::conferir` quem gasta o mesmo tempo dos outros, para que o
    // relogio nao conte a ninguem quais e-mails existem aqui.
    let (id, hash) = cofre.hash_de(&email).await.unwrap_or((String::new(), String::new()));

    let confere = em_paralelo(move || contas::conferir(&senha, &hash)).await.unwrap_or(false);

    if !confere || id.is_empty() {
        cofre.anotar_falha(&email);
        return recusar(
            fila,
            contas::Recusa {
                campo: "senha",
                motivo: "E-mail ou senha incorretos.".into(),
            },
        );
    }

    cofre.perdoar(&email);
    estado.lock().unwrap().anotar(
        telemetria::tipo::SESSAO_ABERTA,
        Some(id.clone()),
        "senha",
        0,
        &plataforma_de(v),
    );
    responder_sessao(cofre, &id, fila).await;
}

/// Token guardado no computador de quem volta. E o que faz o CALL abrir
/// direto na lista de grupos em vez de pedir a senha toda manha.
async fn retomar(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let token = texto_de(v, "token");

    let Some(conta) = cofre.conta_do_token(&token).await else {
        // Nao e erro: e a resposta honesta a "esta sessao ainda vale?".
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    // O acesso mais fiel que existe: acontece uma vez por abertura do CALL,
    // e nao depende de a pessoa fazer nada depois. E daqui que sai a curva de
    // pessoas ativas por dia.
    estado.lock().unwrap().anotar(
        telemetria::tipo::SESSAO_RETOMADA,
        Some(conta.id.clone()),
        "",
        0,
        &plataforma_de(v),
    );

    let _ = fila.send(texto_json(&json!({
        "tipo": "sessao",
        "token": token,
        "conta": conta.resumo()
    })));
}

async fn sair_conta(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let token = texto_de(v, "token");
    let quem = cofre.conta_do_token(&token).await.map(|c| c.id);
    cofre.fechar_sessao(&token).await;
    if quem.is_some() {
        estado.lock().unwrap().anotar(
            telemetria::tipo::SESSAO_FECHADA,
            quem,
            "",
            0,
            &plataforma_de(v),
        );
    }
    let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
}

async fn google_entrar(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let identidade = google::trocar_codigo(
        &texto_de(v, "codigo"),
        &texto_de(v, "verificador"),
        &texto_de(v, "redirecionamento"),
    )
    .await;

    let identidade = match identidade {
        Ok(i) => i,
        Err(motivo) => {
            return recusar(
                fila,
                contas::Recusa {
                    campo: "google",
                    motivo,
                },
            )
        }
    };

    // O Google devolve o nome completo; o CALL mostra um apelido de 24
    // caracteres numa coluna estreita. "Maria Fernanda Albuquerque" vira
    // "Maria" — trocavel no perfil, e melhor que truncado.
    let apelido = limitar(
        identidade.nome.split_whitespace().next().unwrap_or_default().to_string(),
        APELIDO_MAX,
        "Convidado",
    );
    let email = contas::normalizar_email(&identidade.email).unwrap_or(identidade.email);

    let id = cofre.pelo_google(&identidade.sub, &email, &apelido, "").await;

    // Conta nova ou pessoa voltando? `pelo_google` resolve os dois casos no
    // mesmo caminho e nao diz qual foi. A idade da conta diz: ela ou nasceu
    // dentro desta mesma chamada, ou ja existia antes dela. Sem esta
    // distincao, quem so entra pelo Google nunca apareceria em coorte
    // nenhuma — e a curva de contas novas mentiria por omissao.
    let recem_criada = cofre
        .por_id(&id)
        .await
        .is_some_and(|c| agora_ms().saturating_sub(c.criada_em) < 10_000);

    estado.lock().unwrap().anotar(
        if recem_criada {
            telemetria::tipo::CONTA_CRIADA
        } else {
            telemetria::tipo::SESSAO_ABERTA
        },
        Some(id.clone()),
        "google",
        0,
        &plataforma_de(v),
    );
    responder_sessao(cofre, &id, fila).await;
}

/// Perfil e lista de grupos gravados na conta. E o que a conta promete: o
/// mesmo apelido, o mesmo mascote e os mesmos grupos num computador novo.
async fn guardar(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let token = texto_de(v, "token");

    let Some(id) = cofre.conta_do_token(&token).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    let campo_opcional = |nome: &str| v.get(nome).and_then(Value::as_str);
    let atalhos = v.get("atalhos").and_then(Value::as_array).map(|lista| {
        lista
            .iter()
            .filter_map(|a| {
                let codigo = texto_de(a, "codigo");
                // Um codigo tem dez caracteres do alfabeto do convite. Filtrar
                // aqui evita que um cliente com defeito encha a conta de lixo
                // que ninguem consegue abrir depois.
                (codigo.len() == 10 && codigo.chars().all(|c| c.is_ascii_alphanumeric())).then(
                    || contas::Atalho {
                        codigo,
                        nome: limitar(texto_de(a, "nome"), NOME_MAX, "Grupo"),
                        foto: foto_serializada_aceita(texto_de(a, "foto"), FOTO_GRUPO_MAX_CARACTERES),
                    },
                )
            })
            .take(ATALHOS_MAX)
            .collect()
    });

    cofre
        .guardar_perfil(
            &id,
            campo_opcional("apelido").map(|t| limitar(t.to_string(), APELIDO_MAX, "")),
            campo_opcional("avatar").map(|t| t.chars().take(AVATAR_MAX).collect()),
            campo_opcional("bio").map(|t| t.trim().chars().take(BIO_MAX).collect()),
            atalhos,
        )
        .await;

    if let Some(conta) = cofre.por_id(&id).await {
        let _ = fila.send(texto_json(&json!({ "tipo": "conta", "conta": conta.resumo() })));
    }
}

/// Quantos grupos cabem numa conta. A coluna da esquerda nao rola bem alem
/// disso, e o teto e o que impede um cliente adulterado de crescer a conta
/// sem limite.
const ATALHOS_MAX: usize = 60;

async fn responder_sessao(cofre: &Cofre, id: &str, fila: &Fila) {
    let token = cofre.abrir_sessao(id).await;
    let Some(conta) = cofre.por_id(id).await else {
        let _ = fila.send(erro("Conta não encontrada."));
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "sessao",
        "token": token,
        "conta": conta.resumo()
    })));
}

fn recusar(fila: &Fila, r: contas::Recusa) {
    let _ = fila.send(recusa(r.campo, &r.motivo));
}

/// Diferente de `erro`: leva o campo em que a interface deve pintar o
/// problema. Um "senha incorreta" mostrado como aviso passageiro no canto da
/// tela e um aviso; mostrado embaixo do campo da senha, e uma resposta.
fn recusa(campo: &str, motivo: &str) -> Message {
    texto_json(&json!({ "tipo": "recusa", "campo": campo, "motivo": motivo }))
}

fn foto_serializada_aceita(foto: String, maximo: usize) -> String {
    if foto.is_empty() || foto.len() > maximo {
        return String::new();
    }
    if foto.starts_with("data:image/") {
        return foto;
    }
    let Ok(v) = serde_json::from_str::<Value>(&foto) else {
        return String::new();
    };
    let Some(src) = v.get("src").and_then(Value::as_str) else {
        return String::new();
    };
    if !src.starts_with("data:image/") {
        return String::new();
    }
    foto
}

fn foto_de_grupo(v: &Value) -> String {
    foto_serializada_aceita(texto_de(v, "foto"), FOTO_GRUPO_MAX_CARACTERES)
}

fn descricao_de_grupo(v: &Value) -> String {
    texto_de(v, "descricao")
        .trim()
        .chars()
        .take(DESCRICAO_GRUPO_MAX)
        .collect()
}

// ---------------------------------------------------------------- entrada

async fn criar_grupo(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "Meu grupo");
    let foto = foto_de_grupo(v);
    let descricao = descricao_de_grupo(v);

    // O token e resolvido antes de tocar em `Estado`: com Postgres isto pode
    // esperar a rede, e essa espera nao pode acontecer com a tranca de todo
    // mundo na mao.
    let cartao = Cartao::ler(v, cofre).await;

    // Confere duplicata cedo, antes de gastar as idas ao cofre — poupa
    // trabalho no caso comum. A checagem que vale, porque so ela acontece
    // sem intervalo, e a de dentro do lock final, mais abaixo.
    if estado.lock().unwrap().conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }

    // O codigo nasce aqui, antes do grupo existir em `Estado`: e o que
    // permite gravar o grupo na conta e ja ter o resumo atualizado em maos
    // quando o "bem-vindo" for montado, sem uma segunda volta ao cofre.
    let codigo = novo_codigo();
    let conta_resumo = sincronizar_conta_e_buscar_resumo(cofre, &cartao, &codigo, &nome, &foto).await;

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }

    let grupo = Grupo::novo(codigo.clone(), nome, foto, descricao, cartao.usuario.clone());
    e.acervo.grupos.insert(codigo.clone(), grupo);
    e.acervo.salvar_grupos();

    admitir(&mut e, id, cartao, &codigo, fila, conta_resumo, telemetria::tipo::GRUPO_CRIADO);
}

async fn entrar(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let codigo = texto_de(v, "codigo").trim().to_uppercase();
    let cartao = Cartao::ler(v, cofre).await;

    // Primeira olhada: confirma que da para entrar e pega o nome do grupo,
    // sem alterar nada ainda. A checagem que vale acontece de novo depois,
    // ja com a conta atualizada — o grupo poderia, em tese, ter sido
    // removido nesse meio tempo.
    let (nome_do_grupo, foto_do_grupo) = {
        let e = estado.lock().unwrap();
        if e.conexoes.contains_key(&id) {
            let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
            return;
        }
        match e.acervo.grupos.get(&codigo) {
            Some(g) => (g.nome.clone(), g.foto.clone()),
            None => {
                let _ = fila.send(erro("Convite invalido ou grupo removido."));
                return;
            }
        }
    };

    let conta_resumo =
        sincronizar_conta_e_buscar_resumo(cofre, &cartao, &codigo, &nome_do_grupo, &foto_do_grupo).await;

    let mut e = estado.lock().unwrap();
    if e.conexoes.contains_key(&id) {
        let _ = fila.send(erro("Esta conexao ja esta em um grupo."));
        return;
    }
    if !e.acervo.grupos.contains_key(&codigo) {
        let _ = fila.send(erro("Convite invalido ou grupo removido."));
        return;
    }

    admitir(&mut e, id, cartao, &codigo, fila, conta_resumo, telemetria::tipo::GRUPO_ENTROU);
}

/// Grava o grupo e o perfil atuais na conta (quando ha conta) e devolve o
/// resumo ja atualizado, pronto para embutir no "bem-vindo".
///
/// Espera terminar de proposito, em vez de rodar em segundo plano: a
/// resposta a pessoa precisa trazer o grupo que ela acabou de entrar — sem
/// isso, a coluna da esquerda so mostraria o grupo novo depois de uma
/// reconexao, e "entrar num grupo" pareceria ter falhado pela metade.
async fn sincronizar_conta_e_buscar_resumo(
    cofre: &Cofre,
    cartao: &Cartao,
    codigo: &str,
    nome_do_grupo: &str,
    foto_do_grupo: &str,
) -> Option<Value> {
    let conta = cartao.conta.as_ref()?;
    cofre.lembrar_grupo(conta, codigo, nome_do_grupo, foto_do_grupo).await;
    cofre
        .guardar_perfil(
            conta,
            Some(cartao.apelido.clone()),
            Some(cartao.avatar.clone()),
            Some(cartao.bio.clone()),
            None,
        )
        .await;
    cofre.por_id(conta).await.map(|c| c.resumo())
}

/// Registra a conexao no grupo, entrega o estado inteiro a ela e anuncia a
/// chegada aos demais.
///
/// So mexe em `Estado` — nenhuma chamada ao cofre aqui dentro, de proposito:
/// esta funcao roda com a tranca de `Estado` na mao, e o cofre pode precisar
/// de rede. `conta_resumo` chega ja pronto, buscado por quem chamou antes de
/// trancar.
fn admitir(
    e: &mut Estado,
    id: u64,
    cartao: Cartao,
    codigo: &str,
    fila: &Fila,
    conta_resumo: Option<Value>,
    evento: &str,
) {
    let nova = Conexao {
        id,
        usuario: cartao.usuario,
        apelido: cartao.apelido,
        avatar: cartao.avatar,
        bio: cartao.bio,
        foto: cartao.foto,
        conta: cartao.conta,
        grupo: Some(codigo.to_string()),
        canal_voz: None,
        provedor_midia: None,
        fila: fila.clone(),
        mudo: false,
        transmitindo: false,
        atividade: None,
        atividade_icone: None,
        plataforma: cartao.plataforma,
        voz_desde: None,
    };

    // O socket social da mesma conta pode ja estar registrado, ou registrar
    // depois — os dois convivem em `online`, ver a nota do campo.
    if let Some(conta_id) = &nova.conta {
        e.registrar_online(conta_id, id, fila);
    }

    let presentes: Vec<Value> = e.do_grupo(codigo).iter().map(Conexao::resumo).collect();
    let grupo = e.acervo.grupos.get(codigo).cloned();
    let sons = e.acervo.sons_do_grupo(codigo);

    let aviso = json!({ "tipo": "entrou", "membro": nova.resumo() });
    e.difundir(codigo, &aviso, None);

    let _ = fila.send(texto_json(&json!({
        "tipo": "bem-vindo",
        "eu": nova.resumo(),
        "grupo": grupo,
        "presentes": presentes,
        "conta": conta_resumo,
        "sons": sons
    })));

    e.anotar(evento, nova.conta.clone(), codigo, 0, &nova.plataforma);
    e.conexoes.insert(id, nova);
}

fn despedir(id: u64, estado: &Arc<Mutex<Estado>>) {
    let mut e = estado.lock().unwrap();

    // Fechar a janela e fechar o painel: sem isto, o pulso continuaria sendo
    // montado para uma fila que ninguem le mais.
    e.admins.remove(&id);
    e.sockets.remove(&id);

    // Tira esta conexao de qualquer conta que a tenha registrado como
    // presenca — social ou de grupo, tanto faz: nenhuma das duas passa por
    // `e.conexoes`, entao isto tem que rodar antes (e independente) do
    // `conexoes.remove` logo abaixo, ou uma conexao so-social nunca seria
    // limpa daqui.
    e.online.retain(|_, conexoes| {
        conexoes.remove(&id);
        !conexoes.is_empty()
    });

    let Some(saindo) = e.conexoes.remove(&id) else {
        return;
    };

    let Some(codigo) = saindo.grupo.clone() else {
        return;
    };

    // Quem estava na mesma voz precisa desmontar o elo WebRTC; o resto do
    // grupo so precisa parar de ver a pessoa na lista.
    if let Some(canal) = &saindo.canal_voz {
        // Fechar a janela tambem encerra a passagem pela call: sem isto, toda
        // sessao de voz que termina por queda ficaria de fora dos minutos.
        let segundos = saindo
            .voz_desde
            .map(|desde| (agora_ms().saturating_sub(desde) / 1000) as i64)
            .unwrap_or(0);
        let meio = saindo.provedor_midia.clone().unwrap_or_default();
        e.anotar_meio(
            telemetria::tipo::VOZ_SAIU,
            saindo.conta.clone(),
            canal,
            segundos,
            &saindo.plataforma,
            &meio,
            0,
        );
        // Uma janela fechada não teve como dizer quantos bytes recebeu; os
        // minutos, que são o teto que costuma acabar primeiro, contam igual.
        e.midia.somar_consumo(&meio, segundos, 0);
        for c in e.na_voz(canal) {
            if c.id != id && c.transmitindo {
                let _ = c.fila.send(texto_json(&json!({
                    "tipo": "espectadores",
                    "transmissao": c.id.to_string(),
                    "de": id.to_string(),
                    "assistindo": false
                })));
            }
        }
        let aviso = json!({ "tipo": "saiu-voz", "id": id.to_string(), "canal": canal });
        for c in e.na_voz(canal) {
            let _ = c.fila.send(texto_json(&aviso));
        }
    }

    let aviso = json!({ "tipo": "saiu", "id": id.to_string() });
    e.difundir(&codigo, &aviso, None);
}

// -------------------------------------------------------------------- voz

/// Qual degrau da escada atende esta entrada.
///
/// Duas regras disputam aqui, e a ordem entre elas é a decisão inteira:
///
///   1. **Coesão.** Uma sala com gente dentro não troca de transporte porque
///      alguém novo chegou — metade no SFU e metade na malha é uma sala em
///      que as pessoas não se ouvem. Quem chega entra por onde a sala já
///      está.
///   2. **Saúde.** Mas se o degrau da sala **caiu**, coesão viraria manter
///      todo mundo numa porta fechada. Aí a sala inteira desce um degrau, e
///      quem já estava dentro é avisado para descer junto.
///
/// `Err(())` significa que a versão do cliente não consegue entrar com
/// segurança no transporte fixado para a sala — só acontece com um cliente
/// antigo demais chegando numa sala de LiveKit.
fn escolher_degrau_midia(
    degrau_da_sala: Option<&str>,
    aceita_livekit: bool,
    melhor_agora: Option<&'static str>,
    degrau_da_sala_atende: bool,
) -> Result<&'static str, ()> {
    match degrau_da_sala {
        // A sala já está na malha: ninguém sobe de degrau no meio de uma
        // call, nem que o SFU tenha voltado. Sobe na próxima.
        Some(midia::degrau::MALHA) => Ok(midia::degrau::MALHA),
        Some(atual) if midia::e_livekit(atual) => {
            if !aceita_livekit {
                return Err(());
            }
            if degrau_da_sala_atende {
                // O `find` devolve o mesmo texto estático que a sala guardou.
                return Ok(match atual {
                    midia::degrau::PROPRIO => midia::degrau::PROPRIO,
                    _ => midia::degrau::NUVEM,
                });
            }
            Ok(melhor_agora.unwrap_or(midia::degrau::MALHA))
        }
        // Sala vazia, ou um degrau que esta versão do servidor não conhece.
        _ if aceita_livekit => Ok(melhor_agora.unwrap_or(midia::degrau::MALHA)),
        _ => Ok(midia::degrau::MALHA),
    }
}

fn entrar_voz(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let mut e = estado.lock().unwrap();

    let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) else {
        return;
    };
    let valido = e
        .acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Voz)
        .unwrap_or(false);
    if !valido {
        let _ = fila.send(erro("Canal de voz inexistente."));
        return;
    }

    let aceita_livekit = v
        .get("transportes")
        .and_then(Value::as_array)
        .map(|lista| lista.iter().any(|item| item.as_str() == Some("livekit")))
        .unwrap_or(false);
    let degrau_da_sala = e
        .na_voz(&canal)
        .iter()
        .find_map(|conexao| conexao.provedor_midia.clone());
    let melhor_agora = e.midia.degrau_para_sala_nova();
    let sala_atende = degrau_da_sala
        .as_deref()
        .map(|atual| e.midia.degrau_atende(atual))
        .unwrap_or(false);
    let Ok(degrau) = escolher_degrau_midia(
        degrau_da_sala.as_deref(),
        aceita_livekit,
        melhor_agora,
        sala_atende,
    ) else {
        let _ = fila.send(erro(
            "Esta call usa a nova mídia. Atualize o CALL para entrar.",
        ));
        return;
    };

    // A sala inteira desce junto quando o degrau dela caiu. Sem isto, quem
    // chegasse depois da queda entraria na malha enquanto os antigos
    // continuariam esperando um SFU que já não responde — e os dois lados se
    // veriam na lista sem se ouvir.
    let migrou = degrau_da_sala
        .as_deref()
        .map(|antigo| antigo != degrau)
        .unwrap_or(false);

    // Sair da voz anterior antes de entrar na nova: ninguem fala em duas
    // salas ao mesmo tempo, e o elo antigo precisa ser desfeito dos dois lados.
    largar_voz(&mut e, id);

    let pares: Vec<Value> = e.na_voz(&canal).iter().map(Conexao::resumo).collect();
    if let Some(c) = e.conexoes.get_mut(&id) {
        c.canal_voz = Some(canal.clone());
        c.provedor_midia = Some(degrau.to_string());
        c.voz_desde = Some(agora_ms());
    }

    let Some(eu) = e.conexoes.get(&id).cloned() else {
        return;
    };

    let midia = if midia::e_livekit(degrau) {
        e.midia
            .credencial(degrau, &codigo, &canal, &id.to_string(), &eu.apelido)
    } else {
        None
    };
    // Um degrau de LiveKit que não conseguiu assinar o token não tem por que
    // ser anunciado ao cliente: sem credencial, "livekit" é uma promessa que
    // ninguém pode cumprir. A malha assume, aqui mesmo.
    let degrau = if midia::e_livekit(degrau) && midia.is_none() {
        e.midia.anotar_falha(degrau, "o servidor não conseguiu assinar o token");
        if let Some(c) = e.conexoes.get_mut(&id) {
            c.provedor_midia = Some(midia::degrau::MALHA.to_string());
        }
        midia::degrau::MALHA
    } else {
        degrau
    };

    let mut resposta = json!({
        "tipo": "voz",
        "canal": canal,
        "degrau": degrau,
        // Uma malha num servidor que tem SFU é contingência, e o rodapé de
        // quem entra precisa dizer isso. Num servidor sem SFU nenhum, a
        // mesma malha é o funcionamento normal — e anunciá-la como
        // contingência seria alarme sobre nada.
        "contingencia": degrau == midia::degrau::MALHA && e.midia.tem_sfu(),
        "pares": pares
    });
    if let Some(midia) = midia {
        resposta["midia"] = midia;
    }
    let _ = fila.send(texto_json(&resposta));

    if migrou {
        migrar_sala(&mut e, &codigo, &canal, degrau, id);
    }

    e.anotar_meio(
        telemetria::tipo::VOZ_ENTROU,
        eu.conta.clone(),
        &canal,
        0,
        &eu.plataforma,
        degrau,
        0,
    );

    let aviso = json!({ "tipo": "entrou-voz", "membro": eu.resumo(), "canal": canal });
    e.difundir(&codigo, &aviso, Some(id));
}

/// Desce a sala inteira um degrau, para quem já estava dentro.
///
/// Cada pessoa recebe uma credencial própria — um token de LiveKit vale para
/// uma identidade só, então não há como difundir uma credencial coletiva. Ao
/// cair para a malha não há credencial nenhuma, e a mensagem é só a ordem de
/// trocar de transporte.
fn migrar_sala(e: &mut Estado, codigo: &str, canal: &str, degrau: &str, exceto: u64) {
    let alvos: Vec<(u64, String, Fila)> = e
        .na_voz(canal)
        .into_iter()
        .filter(|c| c.id != exceto)
        .map(|c| (c.id, c.apelido.clone(), c.fila.clone()))
        .collect();
    if alvos.is_empty() {
        return;
    }

    println!(
        "[midia] sala {canal} de {codigo}: {} pessoas migrando para '{degrau}'",
        alvos.len()
    );

    for (id, apelido, fila) in alvos {
        if let Some(c) = e.conexoes.get_mut(&id) {
            c.provedor_midia = Some(degrau.to_string());
        }
        let mut aviso = json!({ "tipo": "voz-migrar", "canal": canal, "degrau": degrau });
        if midia::e_livekit(degrau) {
            match e.midia.credencial(degrau, codigo, canal, &id.to_string(), &apelido) {
                Some(credencial) => aviso["midia"] = credencial,
                // Sem token não há para onde migrar a não ser para a malha.
                None => {
                    aviso["degrau"] = json!(midia::degrau::MALHA);
                    if let Some(c) = e.conexoes.get_mut(&id) {
                        c.provedor_midia = Some(midia::degrau::MALHA.to_string());
                    }
                }
            }
        }
        let _ = fila.send(texto_json(&aviso));
    }
}

/// O cliente não conseguiu entrar (ou foi derrubado) no degrau que recebeu.
///
/// É o relato que fecha o circuito: sem ele o servidor continuaria emitindo
/// tokens para um SFU morto, porque **o servidor nunca vê essa falha** — ela
/// acontece entre o navegador e o LiveKit, numa conexão da qual ele não
/// participa. Quem avisa não precisa provar nada: o disjuntor já exige mais
/// de uma falha para derrubar um degrau, então um cliente sozinho com rede
/// ruim não tira o SFU do ar para os outros.
fn midia_falhou(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let degrau_relatado = texto_de(v, "degrau");
    if !midia::e_livekit(&degrau_relatado) {
        return;
    }
    let motivo = {
        let bruto = texto_de(v, "motivo");
        let recortado: String = bruto.chars().take(160).collect();
        if recortado.is_empty() {
            "o cliente não conseguiu entrar".to_string()
        } else {
            recortado
        }
    };

    let mut e = estado.lock().unwrap();

    // Só quem estava mesmo naquele degrau relata sobre ele. Sem esta guarda,
    // uma mensagem forjada derrubaria o SFU de todo mundo.
    let Some(conexao) = e.conexoes.get(&id) else { return };
    if conexao.provedor_midia.as_deref() != Some(degrau_relatado.as_str()) {
        return;
    }
    let Some(canal) = conexao.canal_voz.clone() else { return };
    let Some(codigo) = conexao.grupo.clone() else { return };
    let conta = conexao.conta.clone();
    let plataforma = conexao.plataforma.clone();
    let apelido = conexao.apelido.clone();

    let caiu = e.midia.anotar_falha(&degrau_relatado, &motivo);
    e.anotar_meio(
        telemetria::tipo::MIDIA_FALHOU,
        conta,
        &canal,
        0,
        &plataforma,
        &degrau_relatado,
        0,
    );

    // Para onde esta pessoa vai agora. Enquanto o degrau não caiu de vez, o
    // seguinte da escada já é melhor resposta do que insistir no mesmo.
    let destino = e
        .midia
        .degrau_seguinte(&degrau_relatado)
        .unwrap_or(midia::degrau::MALHA);

    if let Some(c) = e.conexoes.get_mut(&id) {
        c.provedor_midia = Some(destino.to_string());
    }

    let mut resposta = json!({ "tipo": "voz-migrar", "canal": canal, "degrau": destino });
    if midia::e_livekit(destino) {
        match e.midia.credencial(destino, &codigo, &canal, &id.to_string(), &apelido) {
            Some(credencial) => resposta["midia"] = credencial,
            None => {
                resposta["degrau"] = json!(midia::degrau::MALHA);
                if let Some(c) = e.conexoes.get_mut(&id) {
                    c.provedor_midia = Some(midia::degrau::MALHA.to_string());
                }
            }
        }
    }
    let _ = fila.send(texto_json(&resposta));

    // O degrau caiu de vez: os outros da sala estão prestes a descobrir o
    // mesmo, um a um. Melhor descê-los agora do que esperar cada um falhar.
    if caiu {
        let destino_da_sala = resposta["degrau"].as_str().unwrap_or(midia::degrau::MALHA);
        let destino_da_sala = match destino_da_sala {
            midia::degrau::NUVEM => midia::degrau::NUVEM,
            midia::degrau::PROPRIO => midia::degrau::PROPRIO,
            _ => midia::degrau::MALHA,
        };
        migrar_sala(&mut e, &codigo, &canal, destino_da_sala, id);
        let retrato = e.midia.retrato();
        e.avisar_admins(&json!({ "tipo": "admin-midia", "midia": retrato }));
    }
}

/// O cliente entrou de verdade no degrau — a única prova de que ele funciona.
fn midia_entrou(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let degrau = texto_de(v, "degrau");
    if !midia::e_livekit(&degrau) {
        return;
    }
    let mut e = estado.lock().unwrap();
    if e.conexoes.get(&id).and_then(|c| c.provedor_midia.as_deref()) == Some(degrau.as_str()) {
        e.midia.anotar_sucesso(&degrau);
    }
}

fn sair_voz(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    // Os bytes que o cliente mediu ter recebido do SFU. É o número que o
    // LiveKit cobra como banda, e é o próprio navegador quem o sabe — o
    // servidor de sinalização não vê um byte de mídia passar.
    let bytes = v
        .get("bytes")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        // Um teto generoso, mas teto: 50 GB numa passagem só seria um cliente
        // adulterado tentando aposentar um degrau na marra.
        .min(50_000_000_000);
    let mut e = estado.lock().unwrap();
    largar_voz_medido(&mut e, id, bytes);
}

fn largar_voz(e: &mut Estado, id: u64) {
    largar_voz_medido(e, id, 0);
}

fn largar_voz_medido(e: &mut Estado, id: u64, bytes: u64) {
    let Some(anterior) = e.conexoes.get(&id).and_then(|c| c.canal_voz.clone()) else {
        return;
    };
    for c in e.na_voz(&anterior) {
        if c.id != id && c.transmitindo {
            let _ = c.fila.send(texto_json(&json!({
                "tipo": "espectadores",
                "transmissao": c.id.to_string(),
                "de": id.to_string(),
                "assistindo": false
            })));
        }
    }
    // Anotado na saida, e nao na entrada: e a unica hora em que a duracao
    // existe. Uma conexao que cai sem avisar tambem passa por aqui, via
    // `despedir` — nenhuma passagem pela call fica sem fim.
    let (conta, plataforma, segundos, meio) = match e.conexoes.get(&id) {
        Some(c) => (
            c.conta.clone(),
            c.plataforma.clone(),
            c.voz_desde
                .map(|desde| (agora_ms().saturating_sub(desde) / 1000) as i64)
                .unwrap_or(0),
            c.provedor_midia.clone().unwrap_or_default(),
        ),
        None => (None, String::new(), 0, String::new()),
    };
    e.anotar_meio(
        telemetria::tipo::VOZ_SAIU,
        conta,
        &anterior,
        segundos,
        &plataforma,
        &meio,
        bytes,
    );
    // O consumo do ciclo é somado aqui, e não na entrada, pelo mesmo motivo
    // que a duração: é a saída que sabe quanto durou.
    e.midia.somar_consumo(&meio, segundos, bytes);

    if let Some(c) = e.conexoes.get_mut(&id) {
        c.canal_voz = None;
        c.provedor_midia = None;
        c.transmitindo = false;
        c.voz_desde = None;
    }

    let aviso = json!({ "tipo": "saiu-voz", "id": id.to_string(), "canal": anterior });
    if let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) {
        e.difundir(&codigo, &aviso, Some(id));
    }
}

fn sinal(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let Some(destino) = v
        .get("para")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u64>().ok())
    else {
        return;
    };

    let e = estado.lock().unwrap();
    // So encaminha entre quem esta no mesmo canal de voz. Sem esta checagem,
    // qualquer conexao poderia negociar midia com qualquer outra.
    let alvo = match (e.conexoes.get(&destino), e.conexoes.get(&id)) {
        (Some(a), Some(eu))
            if a.canal_voz.is_some() && a.canal_voz == eu.canal_voz =>
        {
            Some(a.fila.clone())
        }
        _ => None,
    };

    if let Some(f) = alvo {
        let _ = f.send(texto_json(&json!({
            "tipo": "sinal",
            "de": id.to_string(),
            "dados": v.get("dados").cloned().unwrap_or(Value::Null)
        })));
    }
}

fn estado_de_midia(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let mudo = v.get("mudo").and_then(Value::as_bool).unwrap_or(false);
    let transmitindo = v
        .get("transmitindo")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Ausente e "nao mostro nada", que e diferente de uma cadeia vazia vinda
    // de um cliente com defeito — os dois viram `None` e ninguem ve nada.
    let atividade = v
        .get("atividade")
        .and_then(Value::as_str)
        .map(|texto| texto.trim().chars().take(ATIVIDADE_MAX).collect::<String>())
        .filter(|texto| !texto.is_empty());

    // Um icone sem nome nao tem o que ilustrar: cai junto se `atividade` nao
    // veio, em vez de sobreviver sozinho na lista de todo mundo.
    let atividade_icone = atividade.as_ref().and_then(|_| {
        v.get("atividadeIcone")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|texto| texto.starts_with("data:image/") && texto.len() <= ATIVIDADE_ICONE_MAX)
            .map(str::to_string)
    });

    let mut e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get_mut(&id) else {
        return;
    };
    // Só a borda de subida vira evento. O cliente reanuncia o proprio estado
    // a cada troca de mudo, e contar isso como "transmitiu" faria uma
    // transmissao de uma hora virar vinte no painel.
    let comecou_a_transmitir = transmitindo && !eu.transmitindo;
    let quem = eu.conta.clone();
    let de_onde = eu.plataforma.clone();
    let canal = eu.canal_voz.clone().unwrap_or_default();
    eu.mudo = mudo;
    eu.transmitindo = transmitindo;
    eu.atividade = atividade.clone();
    eu.atividade_icone = atividade_icone.clone();
    let Some(codigo) = eu.grupo.clone() else {
        return;
    };

    if comecou_a_transmitir {
        e.anotar(telemetria::tipo::TRANSMISSAO, quem, &canal, 0, &de_onde);
    }

    let aviso = json!({
        "tipo": "estado",
        "de": id.to_string(),
        "mudo": mudo,
        "transmitindo": transmitindo,
        "atividade": atividade,
        "atividadeIcone": atividade_icone
    });
    e.difundir(&codigo, &aviso, Some(id));
}

/// Informa somente ao dono da transmissão que uma pessoa passou a receber
/// (ou deixou de receber) a tela. O vídeo continua indo pelo transporte de
/// mídia; este evento carrega apenas a presença do espectador.
fn estado_de_assistencia(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let Some(transmissao) = v
        .get("transmissao")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u64>().ok())
    else {
        return;
    };
    let assistindo = v.get("assistindo").and_then(Value::as_bool).unwrap_or(false);

    let e = estado.lock().unwrap();
    let Some(espectador) = e.conexoes.get(&id) else { return };
    let Some(dono) = e.conexoes.get(&transmissao) else { return };
    if espectador.canal_voz.is_none()
        || espectador.canal_voz != dono.canal_voz
    {
        return;
    }

    let _ = dono.fila.send(texto_json(&json!({
        "tipo": "espectadores",
        "transmissao": transmissao.to_string(),
        "de": id.to_string(),
        "assistindo": assistindo
    })));
}

/// Perfil trocado com o grupo ja em andamento. Sem isto, mudar o apelido, o
/// mascote ou a bio so valeria na proxima entrada, e os outros continuariam
/// vendo o perfil antigo pelo resto da sessao.
///
/// O `usuario` **nao** e relido aqui de proposito. Ele e o que atribui autoria
/// as mensagens e o que decide quem e o dono do grupo: aceitar uma troca dele
/// no meio da sessao seria deixar qualquer um se apresentar como outra pessoa
/// depois de ja ter sido admitido.
async fn perfil(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let cartao = Cartao::ler(v, cofre).await;

    let conta = {
        let mut e = estado.lock().unwrap();
        let Some(eu) = e.conexoes.get_mut(&id) else {
            return;
        };
        eu.apelido = cartao.apelido.clone();
        eu.avatar = cartao.avatar.clone();
        eu.bio = cartao.bio.clone();
        eu.foto = cartao.foto.clone();
        let conta = eu.conta.clone();
        let Some(codigo) = eu.grupo.clone() else {
            return;
        };

        let aviso = json!({
            "tipo": "perfil",
            "de": id.to_string(),
            "apelido": cartao.apelido.clone(),
            "avatar": cartao.avatar.clone(),
            "bio": cartao.bio.clone(),
            "foto": cartao.foto.clone()
        });
        e.difundir(&codigo, &aviso, Some(id));
        conta
    };

    // Numa conexao com conta, mudar o perfil no meio da conversa e mudar o
    // perfil, e nao so o cracha desta sessao.
    if let Some(conta) = conta {
        cofre
            .guardar_perfil(&conta, Some(cartao.apelido), Some(cartao.avatar), Some(cartao.bio), None)
            .await;
    }
}

// ------------------------------------------------------------------ texto

fn mensagem(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let texto: String = texto_de(v, "texto").trim().chars().take(TEXTO_MAX).collect();
    if texto.is_empty() {
        return;
    }

    let mut e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get(&id).cloned() else {
        return;
    };
    let Some(codigo) = eu.grupo.clone() else { return };

    let valido = e
        .acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Texto)
        .unwrap_or(false);
    if !valido {
        let _ = fila.send(erro("Canal de texto inexistente."));
        return;
    }

    // Apelido e avatar sao gravados na mensagem, e nao buscados na hora de
    // ler: o historico e de quem escreveu naquele dia. Quem trocou de mascote
    // depois nao reescreve o passado, e quem nem esta no grupo agora continua
    // aparecendo como apareceu.
    let m = modelo::Mensagem {
        id: novo_id(),
        canal: canal.clone(),
        autor: eu.usuario.clone(),
        apelido: eu.apelido.clone(),
        avatar: eu.avatar.clone(),
        texto,
        em: agora_ms(),
        editada_em: None,
        excluida: false,
        reacoes: HashMap::new(),
    };

    e.acervo.registrar_mensagem(m.clone());
    e.anotar(telemetria::tipo::MENSAGEM, eu.conta.clone(), &codigo, 0, &eu.plataforma);

    // Inclusive de volta para quem escreveu: a mensagem so aparece na tela
    // depois de aceita pelo servidor, entao ninguem ve algo que nao foi
    // guardado.
    let aviso = json!({ "tipo": "mensagem", "mensagem": m });
    e.difundir(&codigo, &aviso, None);
}

fn alterar_mensagem(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, excluir: bool) {
    let canal = texto_de(v, "canal");
    let mensagem_id = texto_de(v, "mensagem");
    let texto: String = texto_de(v, "texto").trim().chars().take(TEXTO_MAX).collect();
    if mensagem_id.is_empty() || (!excluir && texto.is_empty()) { return; }

    let mut e = estado.lock().unwrap();
    let Some(conexao) = e.conexoes.get(&id) else { return; };
    let Some(codigo) = conexao.grupo.clone() else { return; };
    let usuario = conexao.usuario.clone();
    let valido = e.acervo.grupos.get(&codigo).and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Texto).unwrap_or(false);
    if !valido { return; }

    let resultado = if excluir {
        e.acervo.excluir_mensagem(&canal, &mensagem_id, &usuario)
    } else {
        e.acervo.editar_mensagem(&canal, &mensagem_id, &usuario, texto, agora_ms())
    };
    match resultado {
        Ok(mensagem) => {
            let aviso = json!({ "tipo": "mensagem-atualizada", "canal": canal, "mensagem": mensagem });
            e.difundir(&codigo, &aviso, None);
        }
        Err(motivo) => { let _ = fila.send(erro(motivo)); }
    }
}

/// Poe ou tira a reacao de quem chamou numa mensagem — um clique alterna,
/// como o "curtir" de qualquer chat. Difunde para o grupo inteiro, e nao so
/// para quem reagiu: e assim que todo mundo ve a pilula de contagem mudar.
fn reagir(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let mensagem_id = texto_de(v, "mensagem");
    let emoji: String = texto_de(v, "emoji").trim()
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .take(REACAO_MAX)
        .collect();
    if emoji.is_empty() {
        return;
    }

    let mut e = estado.lock().unwrap();
    let Some(conexao) = e.conexoes.get(&id) else {
        return;
    };
    let Some(codigo) = conexao.grupo.clone() else {
        return;
    };
    let usuario = conexao.usuario.clone();

    let valido = e
        .acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .map(|c| c.tipo == TipoCanal::Texto)
        .unwrap_or(false);
    if !valido {
        return;
    }

    let Some(reacoes) = e.acervo.reagir(&canal, &mensagem_id, &usuario, &emoji) else {
        return;
    };

    let aviso = json!({
        "tipo": "reacao",
        "canal": canal,
        "mensagem": mensagem_id,
        "reacoes": reacoes
    });
    e.difundir(&codigo, &aviso, None);
}

fn historico(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let canal = texto_de(v, "canal");
    let e = estado.lock().unwrap();
    let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) else {
        return;
    };
    if e.acervo
        .grupos
        .get(&codigo)
        .and_then(|g| g.canal(&canal))
        .is_none()
    {
        return;
    }

    let _ = fila.send(texto_json(&json!({
        "tipo": "historico",
        "canal": canal,
        "mensagens": e.acervo.historico(&canal)
    })));
}

// ------------------------------------------------------------ soundboard
//
// Sons de grupo vivem em `Acervo` (arquivo), igual a estrutura e ao
// historico. A entrega a quem ouve nao passa por aqui: quem toca decodifica
// o clipe e mistura no proprio audio de saida do WebRTC, e o servidor nunca
// ve nem encaminha um byte de audio para alguem alem de quem pediu o clipe
// para tocar. `som-tocado` e so um aviso de interface — "fulano tocou
// buzina" — para quem nao esta ouvindo notar o que aconteceu.

fn adicionar_som(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let nome = limitar(texto_de(v, "nome"), modelo::SOM_NOME_MAX, "Som");
    let mime = texto_de(v, "mime");
    let Ok(dados) = base64::engine::general_purpose::STANDARD.decode(texto_de(v, "dados")) else {
        let _ = fila.send(erro("Som malformado."));
        return;
    };

    let mut e = estado.lock().unwrap();
    let Some((codigo, usuario)) = e
        .conexoes
        .get(&id)
        .and_then(|c| c.grupo.clone().map(|g| (g, c.usuario.clone())))
    else {
        return;
    };

    match e.acervo.adicionar_som(&codigo, &usuario, nome, mime, dados) {
        Ok(som) => {
            e.difundir(&codigo, &json!({ "tipo": "som-adicionado", "som": som }), None);
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

fn remover_som(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let som_id = texto_de(v, "id");

    let mut e = estado.lock().unwrap();
    let Some((codigo, usuario)) = e
        .conexoes
        .get(&id)
        .and_then(|c| c.grupo.clone().map(|g| (g, c.usuario.clone())))
    else {
        return;
    };

    match e.acervo.remover_som(&codigo, &som_id, &usuario) {
        Ok(_) => {
            e.difundir(&codigo, &json!({ "tipo": "som-removido", "id": som_id }), None);
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

/// Busca sob demanda, so para quem pediu — nao ha motivo para mandar os
/// bytes de todo som para todo mundo assim que a biblioteca muda.
fn pedir_som(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let som_id = texto_de(v, "id");

    let e = estado.lock().unwrap();
    let Some(codigo) = e.conexoes.get(&id).and_then(|c| c.grupo.clone()) else {
        return;
    };
    if !e.acervo.sons_do_grupo(&codigo).iter().any(|s| s.id == som_id) {
        return;
    }
    let Some(dados) = e.acervo.bytes_do_som(&som_id) else {
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "som",
        "id": som_id,
        "dados": base64::engine::general_purpose::STANDARD.encode(dados)
    })));
}

/// So o aviso — "fulano tocou este som" — para a interface de quem esta no
/// mesmo canal de voz. O audio em si ja chegou (ou esta chegando) pela
/// trilha WebRTC de quem tocou; isto nao entrega nenhum byte de audio.
fn som_tocado(v: &Value, id: u64, estado: &Arc<Mutex<Estado>>) {
    let som_id = texto_de(v, "id");

    let e = estado.lock().unwrap();
    let Some(eu) = e.conexoes.get(&id) else { return };
    let Some(canal) = eu.canal_voz.clone() else { return };

    let aviso = json!({
        "tipo": "som-tocado",
        "de": id.to_string(),
        "canal": canal,
        "id": som_id
    });
    for c in e.na_voz(&canal) {
        if c.id != id {
            let _ = c.fila.send(texto_json(&aviso));
        }
    }
}

// -------------------------------------------------------- sons pessoais
//
// Presos a conta, e nao ao grupo — ver a nota de `contas.rs`. So quem tem
// conta ve estes tipos fazerem algo; sem token valido, cada handler devolve
// "sem-sessao" (o mesmo caminho que `guardar` ja usa) e nao mexe em nada.

async fn adicionar_som_pessoal(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let Some(id) = cofre.conta_do_token(&texto_de(v, "token")).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    let nome = limitar(texto_de(v, "nome"), modelo::SOM_NOME_MAX, "Som");
    let mime = texto_de(v, "mime");
    let Ok(dados) = base64::engine::general_purpose::STANDARD.decode(texto_de(v, "dados")) else {
        let _ = fila.send(erro("Som malformado."));
        return;
    };

    match cofre.adicionar_som_pessoal(&id, nome, mime, dados).await {
        Ok(som) => {
            let _ = fila.send(texto_json(&json!({ "tipo": "som-pessoal-adicionado", "som": som })));
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

async fn remover_som_pessoal(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let Some(id) = cofre.conta_do_token(&texto_de(v, "token")).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    let som_id = texto_de(v, "id");
    if cofre.remover_som_pessoal(&id, &som_id).await {
        let _ = fila.send(texto_json(&json!({ "tipo": "som-pessoal-removido", "id": som_id })));
    }
}

async fn listar_sons_pessoais(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let Some(id) = cofre.conta_do_token(&texto_de(v, "token")).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    let sons = cofre.sons_pessoais_de(&id).await;
    let _ = fila.send(texto_json(&json!({ "tipo": "sons-pessoais", "sons": sons })));
}

async fn pedir_som_pessoal(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let Some(id) = cofre.conta_do_token(&texto_de(v, "token")).await.map(|c| c.id) else {
        let _ = fila.send(erro("Sessão inválida."));
        return;
    };
    let som_id = texto_de(v, "id");
    let Some(dados) = cofre.bytes_de_som_pessoal(&id, &som_id).await else {
        let _ = fila.send(erro("Som não encontrado."));
        return;
    };

    let _ = fila.send(texto_json(&json!({
        "tipo": "som",
        "id": som_id,
        "dados": base64::engine::general_purpose::STANDARD.encode(dados)
    })));
}

/// Grava o que toca quando a pessoa entra num canal de voz. `preferencia`
/// ausente ou nula volta ao sino sintetizado padrao.
async fn escolher_som_entrada(v: &Value, fila: &Fila, cofre: &Arc<Cofre>) {
    let Some(id) = cofre.conta_do_token(&texto_de(v, "token")).await.map(|c| c.id) else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };

    let preferencia = v
        .get("preferencia")
        .filter(|p| !p.is_null())
        .map(|p| contas::PreferenciaSom {
            origem: texto_de(p, "origem"),
            grupo: p.get("grupo").and_then(Value::as_str).map(String::from),
            id: texto_de(p, "id"),
        });

    cofre.guardar_som_entrada(&id, preferencia).await;
    if let Some(conta) = cofre.por_id(&id).await {
        let _ = fila.send(texto_json(&json!({ "tipo": "conta", "conta": conta.resumo() })));
    }
}

// -------------------------------------------------------------- estrutura

/// Toda mudanca de estrutura passa por aqui: confere que quem pediu e o dono
/// do grupo, aplica a mudanca, salva e difunde a estrutura nova inteira.
/// Difundir o todo em vez de um delta custa alguns bytes numa acao rara e
/// elimina a chance de duas telas divergirem.
fn alterar_estrutura<F>(id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, mutacao: F)
where
    F: FnOnce(&mut Grupo) -> Result<Vec<String>, String>,
{
    let mut e = estado.lock().unwrap();
    let Some((codigo, usuario)) = e
        .conexoes
        .get(&id)
        .and_then(|c| c.grupo.clone().map(|g| (g, c.usuario.clone())))
    else {
        return;
    };
    let Some(grupo) = e.acervo.grupos.get_mut(&codigo) else {
        return;
    };

    // O convite abre a porta para conversar, nao para desmontar o grupo. Sem
    // esta checagem, qualquer pessoa com o codigo apagaria canais e historico.
    if grupo.dono != usuario {
        let _ = fila.send(erro("Só quem criou o grupo pode alterar seus canais."));
        return;
    }

    let canais_removidos = match mutacao(grupo) {
        Ok(removidos) => removidos,
        Err(motivo) => {
            let _ = fila.send(erro(&motivo));
            return;
        }
    };

    let copia = grupo.clone();
    e.acervo.esquecer_canais(&canais_removidos);
    e.acervo.salvar_grupos();

    // Quem estava numa voz que deixou de existir precisa ser retirado dela.
    if !canais_removidos.is_empty() {
        let orfaos: Vec<u64> = e
            .conexoes
            .values()
            .filter(|c| {
                c.canal_voz
                    .as_ref()
                    .is_some_and(|v| canais_removidos.contains(v))
            })
            .map(|c| c.id)
            .collect();
        for orfao in orfaos {
            largar_voz(&mut e, orfao);
        }
    }

    e.difundir(&codigo, &json!({ "tipo": "grupo", "grupo": copia }), None);
}

fn criar_categoria(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "Nova categoria");
    alterar_estrutura(id, fila, estado, |g| {
        g.categorias.push(Categoria {
            id: novo_id(),
            nome,
            canais: Vec::new(),
        });
        Ok(Vec::new())
    });
}

fn criar_canal(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let categoria = texto_de(v, "categoria");
    let nome = limitar(texto_de(v, "nome"), NOME_MAX, "novo-canal");
    let tipo = if texto_de(v, "tipoCanal") == "voz" {
        TipoCanal::Voz
    } else {
        TipoCanal::Texto
    };

    alterar_estrutura(id, fila, estado, move |g| {
        let Some(cat) = g.categoria_mut(&categoria) else {
            return Err("Categoria inexistente.".into());
        };
        cat.canais.push(Canal {
            id: novo_id(),
            nome,
            tipo,
        });
        Ok(Vec::new())
    });
}

fn editar_grupo(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let nome = texto_de(v, "nome").trim().chars().take(NOME_MAX).collect::<String>();
    let foto = foto_de_grupo(v);
    let descricao = descricao_de_grupo(v);
    if nome.is_empty() {
        let _ = fila.send(recusa("nome", "Dê um nome ao grupo."));
        return;
    }

    alterar_estrutura(id, fila, estado, move |g| {
        g.nome = nome;
        g.foto = foto;
        g.descricao = descricao;
        Ok(Vec::new())
    });
}

fn renomear(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let alvo = texto_de(v, "alvo");
    let referencia = texto_de(v, "id");
    let nome = texto_de(v, "nome").trim().chars().take(NOME_MAX).collect::<String>();
    if nome.is_empty() {
        return;
    }

    alterar_estrutura(id, fila, estado, move |g| {
        match alvo.as_str() {
            "grupo" => g.nome = nome,
            "categoria" => {
                let Some(c) = g.categoria_mut(&referencia) else {
                    return Err("Categoria inexistente.".into());
                };
                c.nome = nome;
            }
            "canal" => {
                let canal = g
                    .categorias
                    .iter_mut()
                    .flat_map(|c| c.canais.iter_mut())
                    .find(|c| c.id == referencia);
                let Some(canal) = canal else {
                    return Err("Canal inexistente.".into());
                };
                canal.nome = nome;
            }
            _ => return Err("Alvo desconhecido.".into()),
        }
        Ok(Vec::new())
    });
}

fn remover(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>) {
    let alvo = texto_de(v, "alvo");
    let referencia = texto_de(v, "id");

    alterar_estrutura(id, fila, estado, move |g| match alvo.as_str() {
        "categoria" => {
            let Some(pos) = g.categorias.iter().position(|c| c.id == referencia) else {
                return Err("Categoria inexistente.".into());
            };
            if g.categorias.len() == 1 {
                return Err("O grupo precisa de pelo menos uma categoria.".into());
            }
            let fora = g.categorias.remove(pos);
            Ok(fora.canais.into_iter().map(|c| c.id).collect())
        }
        "canal" => {
            if g.ids_de_canal().len() == 1 {
                return Err("O grupo precisa de pelo menos um canal.".into());
            }
            for cat in g.categorias.iter_mut() {
                if let Some(pos) = cat.canais.iter().position(|c| c.id == referencia) {
                    cat.canais.remove(pos);
                    return Ok(vec![referencia]);
                }
            }
            Err("Canal inexistente.".into())
        }
        _ => Err("Alvo desconhecido.".into()),
    });
}

// ---------------------------------------------------------------- amigos
//
// Amizade e mensagem privada vivem na conta, nao na conexao — ao contrario
// de voz e canal de texto, nao exigem estar no mesmo grupo, nem em grupo
// nenhum, nem sequer numa conexao "de grupo": o socket social (ver
// `Sinal.conectarLivre` no cliente) manda os mesmos tipos aqui, e cada um
// destes handlers se registra em `Estado.online` assim que resolve o token —
// e assim que fica alcancavel para o resto desta secao, e para `admitir`.

async fn amigo_pedido(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let para = texto_de(v, "para").trim().to_string();
    if para.is_empty() {
        return;
    }

    match cofre.pedir_amizade(&minha, &para).await {
        Ok(ja_amigos) => {
            let _ = fila.send(texto_json(&json!({ "tipo": "amigo-atualizado" })));
            let e = estado.lock().unwrap();
            if ja_amigos {
                e.enviar_a_conta(&para, &json!({ "tipo": "amigo-atualizado" }));
            } else {
                e.enviar_a_conta(
                    &para,
                    &json!({
                        "tipo": "amigo-pedido",
                        "de": { "id": minha.id, "apelido": minha.apelido, "avatar": minha.avatar }
                    }),
                );
            }
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

async fn amigo_responder(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let de = texto_de(v, "de");
    let aceitar = v.get("aceitar").and_then(Value::as_bool).unwrap_or(false);

    match cofre.responder_pedido_amigo(&minha.id, &de, aceitar).await {
        Ok(()) => {
            let _ = fila.send(texto_json(&json!({ "tipo": "amigo-atualizado" })));
            let e = estado.lock().unwrap();
            e.enviar_a_conta(&de, &json!({ "tipo": "amigo-atualizado" }));
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

async fn amigo_remover(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let amigo_id = texto_de(v, "id");
    if cofre.remover_amigo(&minha.id, &amigo_id).await {
        let _ = fila.send(texto_json(&json!({ "tipo": "amigo-atualizado" })));
        let e = estado.lock().unwrap();
        e.enviar_a_conta(&amigo_id, &json!({ "tipo": "amigo-atualizado" }));
    }
}

/// Lista completa — amigos (com apelido/avatar resolvidos na hora, e nao
/// numa copia que envelheceria) e pedidos pendentes. Chamada ao abrir a
/// view de Amigos e sempre que um `"amigo-atualizado"`/`"amigo-pedido"`
/// chega, em vez de o servidor tentar montar o delta exato de cada aviso.
async fn listar_amigos(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(conta) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    // O socket social manda isto assim que abre — e o "alo" que registra a
    // presenca da conta, do mesmo jeito que `admitir` registra a do socket
    // de grupo.
    estado.lock().unwrap().registrar_online(&conta.id, id, fila);

    let mut amigos = Vec::new();
    for amigo_id in &conta.amigos {
        if let Some(c) = cofre.por_id(amigo_id).await {
            amigos.push(json!({ "id": c.id, "apelido": c.apelido, "avatar": c.avatar }));
        }
    }

    let _ = fila.send(texto_json(&json!({
        "tipo": "amigos",
        "amigos": amigos,
        "pedidos": conta.pedidos_amigo
    })));
}

/// Retorna apenas a quantidade de conexões dos atalhos da própria conta.
///
/// O cliente usa isto para desenhar o pequeno ponto de presença nos grupos
/// sem precisar entrar em cada um deles. Não devolvemos perfis nem ids — só o
/// código que já pertence à conta e a contagem atual naquele grupo.
async fn listar_presencas_grupos(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let codigos: Vec<String> = if let Some(conta) = cofre.conta_do_token(&texto_de(v, "token")).await {
        conta.atalhos.into_iter().map(|atalho| atalho.codigo).collect()
    } else {
        // Visitantes também podem ter atalhos locais. O código já é uma chave
        // de convite conhecida pelo navegador; limitar o formato aqui impede
        // que este pedido vire uma consulta arbitrária ao acervo.
        v.get("codigos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|codigo| codigo.len() == 10 && codigo.chars().all(|c| c.is_ascii_alphanumeric()))
            .map(str::to_uppercase)
            .collect()
    };
    let e = estado.lock().unwrap();
    let presencas: Vec<Value> = codigos
        .iter()
        .map(|codigo| {
            json!({
                "codigo": codigo,
                "quantidade": e.do_grupo(codigo).len(),
            })
        })
        .collect();
    let _ = fila.send(texto_json(&json!({
        "tipo": "presencas-grupos",
        "presencas": presencas,
    })));
}

/// Id sintetico da conversa entre duas contas: os dois ids em ordem fixa,
/// para que a conversa entre A e B seja sempre a mesma chave dos dois lados,
/// nao importa quem escreveu primeiro. Entra no lugar do id de canal em
/// `Acervo.mensagens` — a mesma `HashMap<String, _>` guarda os dois sem
/// precisar mudar `Mensagem` nem `Acervo`.
fn id_da_conversa(a: &str, b: &str) -> String {
    if a < b {
        format!("pv:{a}:{b}")
    } else {
        format!("pv:{b}:{a}")
    }
}

async fn mensagem_privada(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let para = texto_de(v, "para");
    let texto: String = texto_de(v, "texto").trim().chars().take(TEXTO_MAX).collect();
    if texto.is_empty() || para.is_empty() {
        return;
    }
    if !minha.amigos.iter().any(|a| a == &para) {
        let _ = fila.send(erro("Vocês precisam ser amigos para conversar."));
        return;
    }

    let conversa = id_da_conversa(&minha.id, &para);
    let m = modelo::Mensagem {
        id: novo_id(),
        canal: conversa.clone(),
        autor: minha.id.clone(),
        apelido: minha.apelido.clone(),
        avatar: minha.avatar.clone(),
        texto,
        em: agora_ms(),
        editada_em: None,
        excluida: false,
        reacoes: HashMap::new(),
    };

    let mut e = estado.lock().unwrap();
    e.acervo.registrar_mensagem(m.clone());

    // `para` viaja explicito porque `m.autor` sozinho nao basta: quem recebe
    // o eco da propria mensagem enviada precisa saber com quem estava
    // falando, e `autor` ali e a propria pessoa, nao a outra ponta.
    let aviso = json!({ "tipo": "mensagem-privada", "conversa": conversa, "para": para, "mensagem": m });
    // Direto pra quem escreveu, e nao via `online`: e a mesma garantia que
    // `mensagem` (de grupo) ja da — a propria mensagem so aparece depois de
    // aceita pelo servidor, entregue de volta pela conexao que a mandou.
    let _ = fila.send(texto_json(&aviso));
    e.enviar_a_conta(&para, &aviso);
}

async fn alterar_mensagem_privada(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>, excluir: bool) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let para = texto_de(v, "para");
    if !minha.amigos.iter().any(|a| a == &para) { return; }
    let mensagem_id = texto_de(v, "mensagem");
    let texto: String = texto_de(v, "texto").trim().chars().take(TEXTO_MAX).collect();
    if mensagem_id.is_empty() || (!excluir && texto.is_empty()) { return; }
    let conversa = id_da_conversa(&minha.id, &para);
    let mut e = estado.lock().unwrap();
    let resultado = if excluir {
        e.acervo.excluir_mensagem(&conversa, &mensagem_id, &minha.id)
    } else {
        e.acervo.editar_mensagem(&conversa, &mensagem_id, &minha.id, texto, agora_ms())
    };
    match resultado {
        Ok(mensagem) => {
            let aviso = json!({ "tipo": "mensagem-privada-atualizada", "para": para, "mensagem": mensagem });
            let _ = fila.send(texto_json(&aviso));
            e.enviar_a_conta(&para, &aviso);
        }
        Err(motivo) => { let _ = fila.send(erro(motivo)); }
    }
}

async fn reagir_privado(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else { return; };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let para = texto_de(v, "para");
    if !minha.amigos.iter().any(|a| a == &para) { return; }
    let mensagem_id = texto_de(v, "mensagem");
    let emoji: String = texto_de(v, "emoji").trim().chars()
        .filter(|c| !c.is_control() && !c.is_whitespace()).take(REACAO_MAX).collect();
    if mensagem_id.is_empty() || emoji.is_empty() { return; }
    let conversa = id_da_conversa(&minha.id, &para);
    let mut e = estado.lock().unwrap();
    let Some(reacoes) = e.acervo.reagir(&conversa, &mensagem_id, &minha.id, &emoji) else { return; };
    let aviso = json!({ "tipo": "reacao-privada", "de": minha.id, "para": para, "mensagem": mensagem_id, "reacoes": reacoes });
    let _ = fila.send(texto_json(&aviso));
    e.enviar_a_conta(&para, &aviso);
}

async fn historico_privado(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    let com = texto_de(v, "com");
    if !minha.amigos.iter().any(|a| a == &com) {
        return;
    }

    let conversa = id_da_conversa(&minha.id, &com);
    let mut e = estado.lock().unwrap();
    e.registrar_online(&minha.id, id, fila);
    let _ = fila.send(texto_json(&json!({
        "tipo": "historico-privado",
        "com": com,
        "mensagens": e.acervo.historico(&conversa)
    })));
}

async fn feedback_enviar(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let categoria = texto_de(v, "categoria");
    let titulo = texto_de(v, "titulo");
    let descricao = texto_de(v, "descricao");
    match cofre.enviar_feedback(&minha, categoria, titulo, descricao).await {
        Ok(feedback) => {
            {
                let e = estado.lock().unwrap();
                e.anotar(
                    telemetria::tipo::FEEDBACK,
                    Some(minha.id.clone()),
                    &feedback.categoria,
                    0,
                    &plataforma_de(v),
                );
                // Quem esta com o painel aberto ve o relato chegar sem
                // recarregar nada — e o mesmo canal do pulso.
                e.avisar_admins(&json!({ "tipo": "admin-feedback-novo", "feedback": feedback }));
            }
            let _ = fila.send(texto_json(&json!({ "tipo": "feedback-enviado", "feedback": feedback })));
        }
        Err(motivo) => {
            let _ = fila.send(erro(motivo));
        }
    }
}

// ---------------------------------------------------------------- painel
//
// O painel administrativo mora dentro do proprio CALL, e viaja pelo mesmo
// socket social que amizade, PV e feedback ja usam. Nao ha senha nova, nao ha
// segunda porta: o token que abre a conta e o mesmo que abre o painel, e o
// que decide se ele abre e o **e-mail** da conta — ver `contas::e_admin`.
//
// Isto e deliberado. Um painel administrativo com uma senha propria e uma
// senha a mais para vazar, e uma pergunta a mais ("qual era mesmo?") entre o
// dono e o proprio produto.

/// A conta de quem pediu, se ela for a do dono. `None` em todo o resto —
/// e a mesma resposta para "token invalido" e para "voce nao e o dono",
/// porque distinguir os dois so ensinaria quem esta tentando.
async fn conta_admin(v: &Value, cofre: &Arc<Cofre>) -> Option<contas::Conta> {
    let conta = cofre.conta_do_token(&texto_de(v, "token")).await?;
    contas::e_admin(&conta.email).then_some(conta)
}

fn recusar_painel(fila: &Fila) {
    let _ = fila.send(texto_json(&json!({
        "tipo": "admin-negado",
        "motivo": "Este painel é do dono do serviço."
    })));
}

/// Quantos acontecimentos recentes o painel recebe para a lista ao vivo. O
/// resto da janela ja esta agregado nos numeros; a lista e para *ver*
/// acontecendo, e uma lista que nao cabe na tela nao serve para isso.
const ULTIMOS_EVENTOS: usize = 120;

/// Monta o retrato inteiro e devolve numa mensagem so.
///
/// Uma resposta grande e um pedido raro, e nao o contrario: quem abre o
/// painel quer tudo de uma vez, e a alternativa (uma consulta por aba) faria
/// cada clique custar uma ida ao banco. Depois desta resposta o painel se
/// mantem vivo sozinho, pelo pulso e pelos eventos empurrados.
async fn admin_painel(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(conta) = conta_admin(v, cofre).await else {
        return recusar_painel(fila);
    };

    // O fuso vem de quem esta lendo — ver a nota de `telemetria` sobre por
    // que "hoje" nao pode ser o dia do servidor. O teto de 14 horas cobre o
    // planeta inteiro e impede que um numero absurdo desloque a serie.
    let fuso = v.get("fuso").and_then(Value::as_i64).unwrap_or(0).clamp(-840, 840);

    let desde = agora_ms().saturating_sub(contas::EVENTOS_DIAS * 24 * 60 * 60 * 1000);
    let eventos = cofre.eventos_desde(desde).await;
    let pessoas = cofre.contas_para_painel().await;
    let sessoes = cofre.sessoes_vivas().await;
    let feedback = cofre.todos_feedbacks().await;
    let membros = cofre.membros_por_grupo().await;

    let mut painel = telemetria::montar(&eventos, &pessoas, agora_ms(), fuso);
    let ciclo_desde = estado.lock().unwrap().midia.ciclo_desde();
    painel["consumo"] = telemetria::consumo(&eventos, ciclo_desde, fuso, agora_ms());

    let mut ultimos: Vec<&Evento> = eventos.iter().collect();
    ultimos.sort_by(|a, b| b.em.cmp(&a.em));
    ultimos.truncate(ULTIMOS_EVENTOS);
    painel["ultimos"] = json!(ultimos);
    painel["sessoesVivas"] = json!(sessoes);
    painel["feedback"] = json!(feedback);
    painel["dono"] = json!({ "id": conta.id, "email": conta.email, "apelido": conta.apelido });

    {
        // Abrir o painel ja assina o pulso: nao ha um segundo pedido para
        // "agora me mande as atualizacoes", porque nao existe motivo para
        // abrir o painel e nao querer ve-lo ao vivo.
        let mut e = estado.lock().unwrap();
        e.admins.insert(id, fila.clone());
        painel["agora"] = e.pulso();
        painel["presentes"] = json!(e.presentes_para_painel());
        painel["grupos"] = json!(e.grupos_para_painel(&membros));
        // A escada de mídia vive na memória deste processo, e não nos
        // eventos: quanto cada degrau já consumiu no ciclo, quem está
        // atendendo agora, e quem está de castigo.
        painel["midia"] = e.midia.retrato();
    }

    let _ = fila.send(texto_json(&json!({ "tipo": "admin-painel", "painel": painel })));
}

/// Muda o status de um relato pelo painel de dentro do aplicativo — o mesmo
/// que a pagina `/admin` faz por HTTP, e com o mesmo aviso ao autor.
/// O freio de mão do dono: forçar a malha P2P mesmo com o SFU saudável.
///
/// Existe para o dia em que o painel do LiveKit conta uma história diferente
/// da nossa — a nossa medição é do lado de cá, e do lado de lá pode haver
/// cobrança que este servidor não vê. Poder desligar sem redeploy é a
/// diferença entre uma decisão de trinta segundos e uma de meia hora.
async fn admin_midia(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    if conta_admin(v, cofre).await.is_none() {
        return recusar_painel(fila);
    }
    let forcar = v
        .get("malhaForcada")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut e = estado.lock().unwrap();
    e.midia.forcar_malha(forcar);
    let retrato = e.midia.retrato();
    // Vai para todos os painéis abertos, e não só para quem clicou: dois
    // administradores olhando a mesma tela devem ver o mesmo estado.
    e.avisar_admins(&json!({ "tipo": "admin-midia", "midia": retrato }));
}

async fn admin_mudar_feedback(v: &Value, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    if conta_admin(v, cofre).await.is_none() {
        return recusar_painel(fila);
    }
    let alvo = texto_de(v, "id");
    let status = texto_de(v, "status");

    match cofre.mudar_status_feedback(&alvo, &status).await {
        Some(feedback) => {
            let e = estado.lock().unwrap();
            e.enviar_a_conta(
                &feedback.conta_id,
                &json!({ "tipo": "feedback-atualizado", "feedback": feedback }),
            );
            e.avisar_admins(&json!({ "tipo": "admin-feedback-novo", "feedback": feedback }));
        }
        None => {
            let _ = fila.send(erro("Relato ou status inválido."));
        }
    }
}

async fn feedback_meu(v: &Value, id: u64, fila: &Fila, estado: &Arc<Mutex<Estado>>, cofre: &Arc<Cofre>) {
    let Some(minha) = cofre.conta_do_token(&texto_de(v, "token")).await else {
        let _ = fila.send(texto_json(&json!({ "tipo": "sem-sessao" })));
        return;
    };
    estado.lock().unwrap().registrar_online(&minha.id, id, fila);
    let lista = cofre.meu_feedback(&minha.id).await;
    let _ = fila.send(texto_json(&json!({ "tipo": "feedback-lista", "feedback": lista })));
}

// ------------------------------------------------------------------ apoio

fn texto_de(v: &Value, campo: &str) -> String {
    v.get(campo)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn limitar(bruto: String, maximo: usize, padrao: &str) -> String {
    let cortado: String = bruto.trim().chars().take(maximo).collect();
    if cortado.is_empty() {
        padrao.to_string()
    } else {
        cortado
    }
}

/// Identidade que o cliente guarda e reapresenta. Nao autentica ninguem: serve
/// para reconhecer a mesma pessoa entre reconexoes e atribuir autoria. Quem
/// tem o codigo do convite entra, e isso e deliberado.
///
/// O prefixo `conta-` e reservado: ele so pode sair de um token conferido, em
/// `Cartao::ler`. Sem esta recusa, dizer-se `conta-ABC` na saudacao seria
/// suficiente para assinar mensagens como a pessoa dona daquela conta — e
/// para virar dono de um grupo que nao e seu.
fn identidade(v: &Value) -> String {
    let bruto = texto_de(v, "usuario");
    let limpo: String = bruto
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    if limpo.is_empty() || limpo.starts_with("conta-") {
        novo_id()
    } else {
        limpo
    }
}

fn erro(motivo: &str) -> Message {
    texto_json(&json!({ "tipo": "erro", "motivo": motivo }))
}

fn texto_json(v: &Value) -> Message {
    Message::Text(v.to_string())
}

#[cfg(test)]
mod testes {
    use super::*;

    use midia::degrau::{MALHA, NUVEM, PROPRIO};

    #[test]
    fn sala_nova_pega_o_melhor_degrau_que_a_escada_oferece() {
        assert_eq!(
            escolher_degrau_midia(None, true, Some(NUVEM), false),
            Ok(NUVEM)
        );
        // Sem escada de SFU disponível, a malha — e não um erro.
        assert_eq!(escolher_degrau_midia(None, true, None, false), Ok(MALHA));
        // Cliente antigo, que não sabe LiveKit, entra na malha sem drama.
        assert_eq!(
            escolher_degrau_midia(None, false, Some(NUVEM), false),
            Ok(MALHA)
        );
    }

    #[test]
    fn sala_com_gente_dentro_nao_troca_de_transporte_por_causa_de_quem_chega() {
        // A sala está no degrau próprio e ele atende: quem chega entra ali,
        // mesmo que a nuvem tenha voltado a ser o melhor degrau da escada.
        assert_eq!(
            escolher_degrau_midia(Some(PROPRIO), true, Some(NUVEM), true),
            Ok(PROPRIO)
        );
        // E ninguém sobe de volta para um SFU no meio de uma call de malha.
        assert_eq!(
            escolher_degrau_midia(Some(MALHA), true, Some(NUVEM), false),
            Ok(MALHA)
        );
    }

    #[test]
    fn sala_cujo_degrau_caiu_desce_inteira() {
        assert_eq!(
            escolher_degrau_midia(Some(NUVEM), true, Some(PROPRIO), false),
            Ok(PROPRIO)
        );
        // E se não sobrou degrau nenhum, a malha.
        assert_eq!(
            escolher_degrau_midia(Some(NUVEM), true, None, false),
            Ok(MALHA)
        );
    }

    #[test]
    fn cliente_antigo_nao_entra_numa_sala_de_livekit() {
        assert_eq!(escolher_degrau_midia(Some(NUVEM), false, None, true), Err(()));
    }

    #[test]
    fn degrau_desconhecido_de_uma_versao_mais_nova_recomeca_a_escada() {
        assert_eq!(
            escolher_degrau_midia(Some("degrau-do-futuro"), true, Some(NUVEM), false),
            Ok(NUVEM)
        );
    }

    /// A recusa de um `usuario` alegando ser conta e a linha `identidade()`
    /// verifica sozinha, sem servidor nenhum de pe — direto na funcao pura.
    #[test]
    fn recusa_quem_se_diz_dono_de_uma_conta_sem_prova() {
        let v = json!({ "usuario": "conta-XYZ123456789" });
        assert!(!identidade(&v).starts_with("conta-"));

        let v = json!({ "usuario": "identidade-legitima" });
        assert_eq!(identidade(&v), "identidade-legitima");
    }
}
