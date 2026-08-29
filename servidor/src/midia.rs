//! O plano de mídia do CALL, como uma **escada** — e não como um interruptor.
//!
//! Antes deste arquivo ter degraus, mídia era uma pergunta de sim ou não: ou
//! havia credencial LiveKit no ambiente e toda call ia para o SFU, ou não
//! havia e toda call ia para a malha P2P. O defeito dessa forma só aparece no
//! dia em que o LiveKit existe mas **não atende** — plano esgotado, projeto
//! suspenso, região fora do ar. O servidor continuava emitindo tokens com
//! confiança, o cliente continuava batendo numa porta fechada, e ninguém
//! entrava em call nenhuma. Foi o que aconteceu, e é o que esta escada
//! existe para impedir.
//!
//! Os degraus, do melhor para o que sempre funciona:
//!
//!   1. **`nuvem`** — LiveKit Cloud. Qualidade e alcance, com um teto mensal.
//!   2. **`proprio`** — um LiveKit nosso, auto-hospedado. Sem quota; custa
//!      uma máquina. Ver a receita de implantação no README.
//!   3. **`malha`** — a malha P2P de sempre, que não depende de servidor de
//!      mídia nenhum. Não é equivalente: cada pessoa envia o próprio áudio
//!      para todas as outras, então grupos grandes sofrem. É a rede de
//!      segurança, e não o plano.
//!
//! Um degrau sai da escada por três motivos, e cada um tem seu tempo:
//!
//!   * **Não está configurado.** Nunca entra. É o caso de quem sobe o CALL
//!     sem nenhuma variável de LiveKit: a escada tem um degrau só, a malha.
//!   * **Estourou o teto.** O servidor mede o próprio consumo do ciclo e
//!     para de emitir token **antes** de a fatura recusar — nenhuma call
//!     precisa falhar para o degrau seguinte assumir. É a diferença entre
//!     uma degradação que ninguém percebe e um apagão.
//!   * **Falhou de verdade.** O cliente que não conseguiu entrar avisa, e um
//!     disjuntor conta essas falhas. Passou do limite na janela, o degrau
//!     fica fora por um tempo e volta sozinho — mas volta em observação: a
//!     primeira falha depois de reabrir derruba de novo, sem precisar de
//!     duas. Um SFU doente não deve ser testado com a call das pessoas a
//!     cada dez minutos.
//!
//! Este arquivo não conhece socket, banco nem `Estado`. Ele recebe consumo
//! e falhas de fora e responde uma pergunta só: *qual degrau atende esta
//! sala agora?*

use serde_json::{json, Value};

#[cfg(feature = "livekit")]
use std::time::Duration;

#[cfg(feature = "livekit")]
use blake2::{Blake2s256, Digest};
#[cfg(feature = "livekit")]
use livekit_api::access_token::{AccessToken, VideoGrants};

/* ─── Nomes dos degraus ───────────────────────────────────────────────── */

/// Os degraus viajam no protocolo e ficam gravados no evento de telemetria,
/// então são texto estável, e não um enum que uma versão nova possa
/// renumerar por acidente.
pub mod degrau {
    pub const NUVEM: &str = "nuvem";
    pub const PROPRIO: &str = "proprio";
    pub const MALHA: &str = "malha";
}

/// Um degrau de LiveKit é qualquer um que não seja a malha. O cliente só
/// precisa saber disto para escolher entre `SalaLiveKit` e `Malha`.
pub fn e_livekit(nome: &str) -> bool {
    nome == degrau::NUVEM || nome == degrau::PROPRIO
}

/* ─── Ajustes do disjuntor ────────────────────────────────────────────── */

/// Quantas falhas seguidas, dentro da janela, derrubam um degrau. Duas, e
/// não uma: um cliente com rede ruim não deve tirar o SFU do ar para todo
/// mundo, mas três já seriam três salas de gente sem call.
const FALHAS_PARA_ABRIR: u32 = 2;
/// Falhas mais velhas que isto não contam juntas — são episódios separados.
const JANELA_DE_FALHAS_MS: u64 = 3 * 60 * 1000;
/// Quanto tempo um degrau derrubado fica fora antes de ser tentado de novo.
const DESCANSO_MS: u64 = 10 * 60 * 1000;
/// Fração do teto em que o servidor para de emitir token por conta própria.
/// Noventa por cento deixa margem para as calls que já estão de pé
/// terminarem sem estourar a fatura.
const MARGEM_PADRAO: u32 = 90;

/* ─── Credenciais ─────────────────────────────────────────────────────── */

#[derive(Clone)]
struct Credenciais {
    url: String,
    chave: String,
    segredo: String,
}

/* ─── O degrau ────────────────────────────────────────────────────────── */

#[derive(Clone)]
struct Degrau {
    nome: &'static str,
    credenciais: Credenciais,
    /// Teto de minutos-participante no ciclo, ou `None` para "sem teto" — o
    /// caso normal do LiveKit próprio, que não tem quota, só conta de luz.
    teto_minutos: Option<u64>,
    /// Teto de banda no ciclo, em gigabytes. O LiveKit cobra os dois, e numa
    /// transmissão de tela costuma ser a banda que acaba primeiro.
    teto_gb: Option<f64>,
    /// Em que porcentagem do teto o degrau se aposenta sozinho.
    margem: u32,

    /* consumo do ciclo, alimentado de fora */
    segundos_usados: u64,
    bytes_usados: u64,

    /* saúde */
    falhas: u32,
    primeira_falha_em: u64,
    /// Instante em que o disjuntor volta a deixar passar. `0` é fechado.
    fora_ate: u64,
    /// Voltou de um descanso e ainda não provou que funciona. Neste estado
    /// uma única falha derruba de novo.
    em_observacao: bool,
    /// Quantas vezes este degrau caiu no ciclo — o painel mostra.
    quedas: u32,
    ultima_queda_em: u64,
    ultimo_motivo: String,
}

impl Degrau {
    fn minutos_usados(&self) -> u64 {
        self.segundos_usados / 60
    }

    fn gb_usados(&self) -> f64 {
        self.bytes_usados as f64 / 1_000_000_000.0
    }

    /// Quanto do teto já foi gasto, de 0 a 1 — o maior entre minutos e
    /// banda, porque é o primeiro dos dois a acabar que desliga o degrau.
    /// `None` quando não há teto nenhum declarado.
    fn fracao_do_teto(&self) -> Option<f64> {
        let por_minuto = self
            .teto_minutos
            .filter(|teto| *teto > 0)
            .map(|teto| self.minutos_usados() as f64 / teto as f64);
        let por_banda = self
            .teto_gb
            .filter(|teto| *teto > 0.0)
            .map(|teto| self.gb_usados() / teto);
        match (por_minuto, por_banda) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    }

    fn estourou(&self) -> bool {
        self.fracao_do_teto()
            .map(|fracao| fracao * 100.0 >= self.margem as f64)
            .unwrap_or(false)
    }

    fn descansando(&self, agora: u64) -> bool {
        agora < self.fora_ate
    }

    fn disponivel(&self, agora: u64) -> bool {
        !self.descansando(agora) && !self.estourou()
    }

    /// Por que este degrau não está atendendo. Texto para o painel, não para
    /// o protocolo.
    fn impedimento(&self, agora: u64) -> Option<String> {
        if self.descansando(agora) {
            let faltam = (self.fora_ate - agora) / 1000;
            return Some(format!("fora do ar; volta a ser tentado em {faltam}s"));
        }
        if self.estourou() {
            let usado = self
                .fracao_do_teto()
                .map(|f| (f * 100.0).round() as i64)
                .unwrap_or(0);
            return Some(format!(
                "teto do ciclo atingido: {usado}% de um limite que se aposenta em {}%",
                self.margem
            ));
        }
        None
    }

    fn anotar_falha(&mut self, agora: u64, motivo: &str) -> bool {
        if agora.saturating_sub(self.primeira_falha_em) > JANELA_DE_FALHAS_MS {
            self.falhas = 0;
            self.primeira_falha_em = agora;
        }
        self.falhas += 1;
        self.ultimo_motivo = motivo.to_string();

        // Em observação, a paciência é zero: este degrau acabou de voltar de
        // um descanso e a primeira coisa que fez foi falhar de novo.
        let limite = if self.em_observacao { 1 } else { FALHAS_PARA_ABRIR };
        if self.falhas >= limite {
            self.fora_ate = agora + DESCANSO_MS;
            self.falhas = 0;
            self.em_observacao = false;
            self.quedas += 1;
            self.ultima_queda_em = agora;
            return true;
        }
        false
    }

    fn anotar_sucesso(&mut self) {
        self.falhas = 0;
        self.em_observacao = false;
    }

    /// Chamado quando o descanso termina: o degrau volta à escada, mas sob
    /// suspeita.
    fn talvez_reabrir(&mut self, agora: u64) {
        if self.fora_ate > 0 && agora >= self.fora_ate {
            self.fora_ate = 0;
            self.em_observacao = true;
            self.falhas = 0;
        }
    }
}

/* ─── A escada ────────────────────────────────────────────────────────── */

#[derive(Clone, Default)]
pub struct Midia {
    #[cfg(feature = "livekit")]
    degraus: Vec<Degrau>,
    /// Desligado à mão pelo dono, no painel. Vale mais que qualquer degrau
    /// saudável: é o freio de mão de quem paga a conta.
    malha_forcada: bool,
    /// Início do ciclo de cobrança vigente, em ms. Serve para o painel dizer
    /// "desde quando" e para o consumo saber quando zerar.
    ciclo_desde: u64,
    /// Dia do mês em que o ciclo vira.
    dia_do_ciclo: u32,
}

impl Midia {
    pub fn do_ambiente() -> Self {
        let dia_do_ciclo = std::env::var("LIVEKIT_DIA_DO_CICLO")
            .ok()
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|d| (1..=28).contains(d))
            .unwrap_or(1);
        let mut midia = Self {
            dia_do_ciclo,
            ciclo_desde: inicio_do_ciclo(agora_ms(), dia_do_ciclo),
            ..Default::default()
        };

        #[cfg(feature = "livekit")]
        {
            let margem = std::env::var("LIVEKIT_MARGEM")
                .ok()
                .and_then(|v| v.trim().parse::<u32>().ok())
                .filter(|m| (1..=100).contains(m))
                .unwrap_or(MARGEM_PADRAO);

            if let Some(credenciais) = credenciais_de("LIVEKIT") {
                midia.degraus.push(Degrau::novo(
                    degrau::NUVEM,
                    credenciais,
                    teto_u64("LIVEKIT_MINUTOS_MES"),
                    teto_f64("LIVEKIT_GB_MES"),
                    margem,
                ));
            }

            if let Some(credenciais) = credenciais_de("LIVEKIT_RESERVA") {
                midia.degraus.push(Degrau::novo(
                    degrau::PROPRIO,
                    credenciais,
                    teto_u64("LIVEKIT_RESERVA_MINUTOS_MES"),
                    teto_f64("LIVEKIT_RESERVA_GB_MES"),
                    margem,
                ));
            }

            let nomes: Vec<&str> = midia.degraus.iter().map(|d| d.nome).collect();
            if nomes.is_empty() {
                println!("[midia] sem LiveKit configurado; a escada tem um degrau só: malha P2P.");
            } else {
                println!("[midia] escada de mídia: {} → malha P2P.", nomes.join(" → "));
            }
        }

        #[cfg(not(feature = "livekit"))]
        if std::env::var("LIVEKIT_URL").is_ok() {
            eprintln!("[midia] este binário não inclui a feature livekit; usando malha P2P.");
        }

        midia
    }

    /// Existe algum servidor de mídia configurado neste servidor?
    ///
    /// É o que distingue as duas malhas que se parecem por fora: a de um
    /// servidor que nunca teve SFU (e para quem P2P é o funcionamento
    /// normal) e a de um servidor que tem SFU mas está sem ele agora — que é
    /// contingência, e quem está na call merece saber.
    pub fn tem_sfu(&self) -> bool {
        #[cfg(feature = "livekit")]
        {
            !self.degraus.is_empty()
        }
        #[cfg(not(feature = "livekit"))]
        {
            false
        }
    }

    /// O degrau que deve atender uma sala nova. Nunca devolve a malha: a
    /// ausência de degrau **é** a malha, e quem chama sabe disso.
    pub fn degrau_para_sala_nova(&mut self) -> Option<&'static str> {
        self.melhor_degrau()
    }

    fn melhor_degrau(&mut self) -> Option<&'static str> {
        if self.malha_forcada {
            return None;
        }
        #[cfg(feature = "livekit")]
        {
            let agora = agora_ms();
            for degrau in &mut self.degraus {
                degrau.talvez_reabrir(agora);
            }
            return self
                .degraus
                .iter()
                .find(|d| d.disponivel(agora))
                .map(|d| d.nome);
        }
        #[cfg(not(feature = "livekit"))]
        None
    }

    /// O degrau seguinte a `atual` que ainda atende — o que uma sala usa
    /// quando o degrau dela cai com gente dentro. `None` significa malha.
    pub fn degrau_seguinte(&mut self, atual: &str) -> Option<&'static str> {
        if self.malha_forcada {
            return None;
        }
        #[cfg(feature = "livekit")]
        {
            let agora = agora_ms();
            for degrau in &mut self.degraus {
                degrau.talvez_reabrir(agora);
            }
            let posicao = self.degraus.iter().position(|d| d.nome == atual);
            let inicio = posicao.map(|p| p + 1).unwrap_or(0);
            return self
                .degraus
                .iter()
                .skip(inicio)
                .find(|d| d.disponivel(agora))
                .map(|d| d.nome);
        }
        #[cfg(not(feature = "livekit"))]
        {
            let _ = atual;
            None
        }
    }

    /// Um degrau ainda pode atender esta sala? Usado pela regra de coesão:
    /// uma sala não troca de transporte só porque alguém novo chegou.
    pub fn degrau_atende(&mut self, nome: &str) -> bool {
        if self.malha_forcada {
            return false;
        }
        #[cfg(feature = "livekit")]
        {
            let agora = agora_ms();
            for degrau in &mut self.degraus {
                degrau.talvez_reabrir(agora);
            }
            return self
                .degraus
                .iter()
                .any(|d| d.nome == nome && d.disponivel(agora));
        }
        #[cfg(not(feature = "livekit"))]
        {
            let _ = nome;
            false
        }
    }

    /// Emite uma credencial que só entra nesta sala e só publica as fontes
    /// que o CALL conhece. `None` quando o degrau não existe — quem chama
    /// cai para o degrau seguinte.
    pub fn credencial(
        &self,
        nome_do_degrau: &str,
        codigo_grupo: &str,
        canal: &str,
        identidade: &str,
        nome: &str,
    ) -> Option<Value> {
        #[cfg(feature = "livekit")]
        {
            let degrau = self.degraus.iter().find(|d| d.nome == nome_do_degrau)?;
            let sala = nome_da_sala(codigo_grupo, canal);
            let token =
                AccessToken::with_api_key(&degrau.credenciais.chave, &degrau.credenciais.segredo)
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
                "degrau": degrau.nome,
                "url": degrau.credenciais.url,
                "token": token
            }));
        }

        #[cfg(not(feature = "livekit"))]
        {
            let _ = (nome_do_degrau, codigo_grupo, canal, identidade, nome);
            None
        }
    }

    /* ── Saúde ─────────────────────────────────────────────────────── */

    /// Um cliente não conseguiu entrar (ou foi derrubado) neste degrau.
    /// Devolve `true` quando esta foi a falha que derrubou o degrau.
    pub fn anotar_falha(&mut self, nome: &str, motivo: &str) -> bool {
        #[cfg(feature = "livekit")]
        {
            let agora = agora_ms();
            if let Some(degrau) = self.degraus.iter_mut().find(|d| d.nome == nome) {
                let caiu = degrau.anotar_falha(agora, motivo);
                if caiu {
                    eprintln!(
                        "[midia] degrau '{nome}' fora por {}min — {motivo}",
                        DESCANSO_MS / 60_000
                    );
                }
                return caiu;
            }
        }
        #[cfg(not(feature = "livekit"))]
        {
            let _ = (nome, motivo);
        }
        false
    }

    /// Alguém entrou de verdade. Zera a contagem de falhas e tira o degrau
    /// da observação — é a única prova de que ele voltou.
    pub fn anotar_sucesso(&mut self, nome: &str) {
        #[cfg(feature = "livekit")]
        if let Some(degrau) = self.degraus.iter_mut().find(|d| d.nome == nome) {
            degrau.anotar_sucesso();
        }
        #[cfg(not(feature = "livekit"))]
        {
            let _ = nome;
        }
    }

    /* ── Consumo ───────────────────────────────────────────────────── */

    /// Soma uma passagem pela call ao consumo do ciclo. `bytes` é o que o
    /// cliente mediu de verdade ter recebido do SFU — zero quando ele não
    /// soube dizer.
    pub fn somar_consumo(&mut self, nome: &str, segundos: i64, bytes: u64) {
        self.virar_ciclo_se_preciso();
        #[cfg(feature = "livekit")]
        if let Some(degrau) = self.degraus.iter_mut().find(|d| d.nome == nome) {
            degrau.segundos_usados += segundos.max(0) as u64;
            degrau.bytes_usados += bytes;
        }
        #[cfg(not(feature = "livekit"))]
        {
            let _ = (nome, segundos, bytes);
        }
    }

    /// Zera o consumo quando o ciclo de cobrança vira. Chamado de dentro de
    /// `somar_consumo` e do retrato: não há tarefa de relógio para isto, e
    /// não precisa haver — nenhuma das duas respostas fica errada por um
    /// ciclo que virou entre uma leitura e outra.
    fn virar_ciclo_se_preciso(&mut self) {
        let inicio = inicio_do_ciclo(agora_ms(), self.dia_do_ciclo);
        if inicio > self.ciclo_desde {
            self.ciclo_desde = inicio;
            #[cfg(feature = "livekit")]
            for degrau in &mut self.degraus {
                degrau.segundos_usados = 0;
                degrau.bytes_usados = 0;
                degrau.quedas = 0;
            }
        }
    }

    pub fn ciclo_desde(&self) -> u64 {
        self.ciclo_desde
    }

    pub fn forcar_malha(&mut self, forcar: bool) {
        self.malha_forcada = forcar;
        println!(
            "[midia] chave do dono: {}",
            if forcar {
                "malha P2P forçada para todas as calls novas"
            } else {
                "escada de mídia normal"
            }
        );
    }

    /// O retrato da escada para o painel: cada degrau, o que consumiu, o que
    /// lhe resta e por que está (ou não está) atendendo.
    pub fn retrato(&mut self) -> Value {
        self.virar_ciclo_se_preciso();
        let ativo = self.melhor_degrau();
        let agora = agora_ms();

        #[cfg(feature = "livekit")]
        let degraus: Vec<Value> = self
            .degraus
            .iter()
            .map(|d| {
                json!({
                    "nome": d.nome,
                    "url": mascarar_url(&d.credenciais.url),
                    "atende": d.disponivel(agora),
                    "ativo": Some(d.nome) == ativo,
                    "impedimento": d.impedimento(agora),
                    "minutos": d.minutos_usados(),
                    "tetoMinutos": d.teto_minutos,
                    "gb": (d.gb_usados() * 100.0).round() / 100.0,
                    "tetoGb": d.teto_gb,
                    "fracao": d.fracao_do_teto(),
                    "margem": d.margem,
                    "quedas": d.quedas,
                    "ultimaQuedaEm": (d.ultima_queda_em > 0).then_some(d.ultima_queda_em),
                    "ultimoMotivo": (!d.ultimo_motivo.is_empty()).then(|| d.ultimo_motivo.clone()),
                    "emObservacao": d.em_observacao,
                    "foraAte": (d.fora_ate > agora).then_some(d.fora_ate)
                })
            })
            .collect();
        #[cfg(not(feature = "livekit"))]
        let degraus: Vec<Value> = Vec::new();

        json!({
            "degraus": degraus,
            "ativo": ativo.unwrap_or(degrau::MALHA),
            "malhaForcada": self.malha_forcada,
            "cicloDesde": self.ciclo_desde,
            "diaDoCiclo": self.dia_do_ciclo
        })
    }
}

#[cfg(feature = "livekit")]
impl Degrau {
    fn novo(
        nome: &'static str,
        credenciais: Credenciais,
        teto_minutos: Option<u64>,
        teto_gb: Option<f64>,
        margem: u32,
    ) -> Self {
        Self {
            nome,
            credenciais,
            teto_minutos,
            teto_gb,
            margem,
            segundos_usados: 0,
            bytes_usados: 0,
            falhas: 0,
            primeira_falha_em: 0,
            fora_ate: 0,
            em_observacao: false,
            quedas: 0,
            ultima_queda_em: 0,
            ultimo_motivo: String::new(),
        }
    }
}

/* ─── Leitura do ambiente ─────────────────────────────────────────────── */

#[cfg(feature = "livekit")]
fn credenciais_de(prefixo: &str) -> Option<Credenciais> {
    let url = std::env::var(format!("{prefixo}_URL"))
        .ok()
        .and_then(normalizar_variavel);
    let chave = std::env::var(format!("{prefixo}_API_KEY"))
        .ok()
        .and_then(normalizar_variavel);
    let segredo = std::env::var(format!("{prefixo}_API_SECRET"))
        .ok()
        .and_then(normalizar_variavel);
    let alguma = url.is_some() || chave.is_some() || segredo.is_some();

    match (url, chave, segredo) {
        (Some(url), Some(chave), Some(segredo))
            if url.starts_with("wss://") || url.starts_with("ws://") =>
        {
            Some(Credenciais {
                url,
                chave,
                segredo,
            })
        }
        (Some(_), Some(_), Some(_)) => {
            eprintln!("[midia] {prefixo}_URL deve começar com wss:// ou ws://; degrau ignorado.");
            None
        }
        _ if alguma => {
            eprintln!("[midia] configuração {prefixo} incompleta; degrau ignorado.");
            None
        }
        _ => None,
    }
}

#[cfg(feature = "livekit")]
fn teto_u64(chave: &str) -> Option<u64> {
    std::env::var(chave)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
}

#[cfg(feature = "livekit")]
fn teto_f64(chave: &str) -> Option<f64> {
    std::env::var(chave)
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| *v > 0.0)
}

#[cfg(feature = "livekit")]
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

/// O painel mostra em qual servidor de mídia o degrau fala, mas o endereço
/// completo de um LiveKit próprio é meio caminho para bater nele.
#[cfg(feature = "livekit")]
fn mascarar_url(url: &str) -> String {
    match url.split_once("://") {
        Some((_, resto)) => resto.split('/').next().unwrap_or(resto).to_string(),
        None => url.to_string(),
    }
}

fn agora_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// O começo do ciclo de cobrança a que `agora` pertence. Contas mensais
/// viram num dia do mês, e não a cada trinta dias: um ciclo que começa dia 7
/// e outro que começa dia 1 medem meses diferentes do mesmo calendário.
fn inicio_do_ciclo(agora: u64, dia: u32) -> u64 {
    const DIA_MS: u64 = 86_400_000;
    let dias_desde_epoca = (agora / DIA_MS) as i64;
    let (mut ano, mut mes, dia_atual) = civil_de(dias_desde_epoca);
    let dia = dia.clamp(1, 28) as i64;
    if dia_atual < dia {
        // Ainda não chegou a virada deste mês: o ciclo em curso começou no
        // mês passado.
        if mes == 1 {
            mes = 12;
            ano -= 1;
        } else {
            mes -= 1;
        }
    }
    (dias_civis(ano, mes, dia).max(0) as u64) * DIA_MS
}

/// Dias desde a época Unix -> (ano, mês, dia). Algoritmo de Howard Hinnant,
/// o mesmo que a `<chrono>` do C++20 usa — aritmética inteira pura, sem
/// depender de uma biblioteca de calendário só para saber em que mês estamos.
fn civil_de(dias: i64) -> (i64, i64, i64) {
    let z = dias + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn dias_civis(ano: i64, mes: i64, dia: i64) -> i64 {
    let y = if mes <= 2 { ano - 1 } else { ano };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if mes > 2 { mes - 3 } else { mes + 9 };
    let doy = (153 * mp + 2) / 5 + dia - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

/* ─── Testes ──────────────────────────────────────────────────────────── */

#[cfg(test)]
mod testes_do_ciclo {
    use super::*;

    const DIA_MS: u64 = 86_400_000;

    fn em(ano: i64, mes: i64, dia: i64) -> u64 {
        (dias_civis(ano, mes, dia) as u64) * DIA_MS
    }

    #[test]
    fn calendario_ida_e_volta() {
        for dias in [0i64, 1, 19_000, 20_321, 25_000] {
            let (ano, mes, dia) = civil_de(dias);
            assert_eq!(dias_civis(ano, mes, dia), dias);
        }
        assert_eq!(civil_de(0), (1970, 1, 1));
    }

    #[test]
    fn ciclo_do_dia_primeiro_comeca_no_mes_corrente() {
        let meio_do_mes = em(2026, 8, 21) + 13 * 3_600_000;
        assert_eq!(inicio_do_ciclo(meio_do_mes, 1), em(2026, 8, 1));
    }

    #[test]
    fn ciclo_que_ainda_nao_virou_pertence_ao_mes_passado() {
        // Ciclo que vira dia 7; hoje é dia 3, então o ciclo em curso começou
        // no dia 7 do mês anterior.
        assert_eq!(inicio_do_ciclo(em(2026, 8, 3), 7), em(2026, 7, 7));
        // E a virada de ano volta para dezembro, não para o mês zero.
        assert_eq!(inicio_do_ciclo(em(2026, 1, 3), 7), em(2025, 12, 7));
    }
}

#[cfg(all(test, feature = "livekit"))]
mod testes {
    use super::*;
    use livekit_api::access_token::TokenVerifier;

    fn escada(teto_minutos: Option<u64>) -> Midia {
        Midia {
            degraus: vec![
                Degrau::novo(
                    degrau::NUVEM,
                    Credenciais {
                        url: "wss://exemplo.livekit.cloud".to_string(),
                        chave: "chave-de-teste".to_string(),
                        segredo: "segredo-de-teste-com-tamanho-suficiente".to_string(),
                    },
                    teto_minutos,
                    None,
                    90,
                ),
                Degrau::novo(
                    degrau::PROPRIO,
                    Credenciais {
                        url: "wss://midia.exemplo.com".to_string(),
                        chave: "chave-propria".to_string(),
                        segredo: "segredo-proprio-com-tamanho-suficiente".to_string(),
                    },
                    None,
                    None,
                    90,
                ),
            ],
            malha_forcada: false,
            ciclo_desde: inicio_do_ciclo(agora_ms(), 1),
            dia_do_ciclo: 1,
        }
    }

    #[test]
    fn token_so_entra_na_sala_e_publica_fontes_do_call() {
        let midia = escada(None);
        let resposta = midia
            .credencial(degrau::NUVEM, "convite-secreto", "canal-1", "42", "Ana")
            .expect("credencial");
        assert_eq!(resposta["degrau"], degrau::NUVEM);
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
        assert_eq!(claims.video.room, nome_da_sala("convite-secreto", "canal-1"));
        assert!(!claims.video.room.contains("convite-secreto"));
        assert_eq!(
            claims.video.can_publish_sources,
            vec!["microphone", "screen_share", "screen_share_audio"]
        );
    }

    #[test]
    fn cada_degrau_assina_com_a_propria_chave() {
        let midia = escada(None);
        let resposta = midia
            .credencial(degrau::PROPRIO, "grupo", "voz", "7", "Bia")
            .expect("credencial");
        assert_eq!(resposta["url"], "wss://midia.exemplo.com");
        TokenVerifier::with_api_key("chave-propria", "segredo-proprio-com-tamanho-suficiente")
            .verify(resposta["token"].as_str().unwrap())
            .expect("o token do degrau próprio é assinado pelo segredo dele");
    }

    #[test]
    fn a_sala_nova_pega_o_melhor_degrau() {
        let mut midia = escada(None);
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::NUVEM));
    }

    #[test]
    fn duas_falhas_derrubam_a_nuvem_e_a_escada_desce_para_o_proprio() {
        let mut midia = escada(None);
        assert!(!midia.anotar_falha(degrau::NUVEM, "recusado"));
        assert!(midia.anotar_falha(degrau::NUVEM, "recusado"));
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::PROPRIO));
        assert!(!midia.degrau_atende(degrau::NUVEM));
    }

    #[test]
    fn com_tudo_derrubado_a_escada_termina_na_malha() {
        let mut midia = escada(None);
        midia.anotar_falha(degrau::NUVEM, "x");
        midia.anotar_falha(degrau::NUVEM, "x");
        midia.anotar_falha(degrau::PROPRIO, "x");
        midia.anotar_falha(degrau::PROPRIO, "x");
        assert_eq!(midia.degrau_para_sala_nova(), None);
    }

    #[test]
    fn um_sucesso_apaga_a_falha_solta() {
        let mut midia = escada(None);
        midia.anotar_falha(degrau::NUVEM, "x");
        midia.anotar_sucesso(degrau::NUVEM);
        // A segunda falha volta a ser a primeira: sozinha, não derruba.
        assert!(!midia.anotar_falha(degrau::NUVEM, "x"));
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::NUVEM));
    }

    #[test]
    fn o_teto_aposenta_o_degrau_sem_precisar_de_falha() {
        let mut midia = escada(Some(100));
        // 90 minutos de 100 é exatamente a margem: já não emite mais.
        midia.somar_consumo(degrau::NUVEM, 90 * 60, 0);
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::PROPRIO));
        let retrato = midia.retrato();
        assert_eq!(retrato["degraus"][0]["atende"], false);
        assert_eq!(retrato["degraus"][0]["minutos"], 90);
        assert!(retrato["degraus"][0]["impedimento"].is_string());
    }

    #[test]
    fn abaixo_da_margem_o_degrau_continua_atendendo() {
        let mut midia = escada(Some(100));
        midia.somar_consumo(degrau::NUVEM, 89 * 60, 0);
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::NUVEM));
    }

    #[test]
    fn a_banda_estoura_antes_dos_minutos_quando_e_ela_que_acaba() {
        let mut midia = escada(None);
        midia.degraus[0].teto_gb = Some(10.0);
        midia.somar_consumo(degrau::NUVEM, 60, 9_500_000_000);
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::PROPRIO));
    }

    #[test]
    fn a_chave_do_dono_vale_mais_que_degrau_saudavel() {
        let mut midia = escada(None);
        midia.forcar_malha(true);
        assert_eq!(midia.degrau_para_sala_nova(), None);
        assert!(!midia.degrau_atende(degrau::NUVEM));
        midia.forcar_malha(false);
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::NUVEM));
    }

    #[test]
    fn degrau_seguinte_pula_o_atual_mesmo_saudavel() {
        let mut midia = escada(None);
        assert_eq!(midia.degrau_seguinte(degrau::NUVEM), Some(degrau::PROPRIO));
        assert_eq!(midia.degrau_seguinte(degrau::PROPRIO), None);
        // Um degrau que não existe mais (versão antiga) recomeça do topo.
        assert_eq!(midia.degrau_seguinte("inventado"), Some(degrau::NUVEM));
    }

    #[test]
    fn volta_do_descanso_em_observacao_e_uma_falha_derruba_de_novo() {
        let mut midia = escada(None);
        midia.anotar_falha(degrau::NUVEM, "x");
        midia.anotar_falha(degrau::NUVEM, "x");
        // Encurta o descanso à mão em vez de esperar dez minutos de relógio.
        midia.degraus[0].fora_ate = agora_ms() - 1;
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::NUVEM));
        assert!(midia.degraus[0].em_observacao);
        assert!(midia.anotar_falha(degrau::NUVEM, "de novo"));
        assert_eq!(midia.degrau_para_sala_nova(), Some(degrau::PROPRIO));
    }

    #[test]
    fn o_endereco_do_servidor_proprio_nao_vaza_inteiro_no_painel() {
        let mut midia = escada(None);
        let retrato = midia.retrato();
        assert_eq!(retrato["degraus"][1]["url"], "midia.exemplo.com");
        assert_eq!(retrato["ativo"], degrau::NUVEM);
    }
}
