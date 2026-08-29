//! O painel: de eventos crus a números que significam alguma coisa.
//!
//! Este arquivo não fala com banco, não fala com socket e não conhece
//! `Estado`. Ele recebe duas listas — os eventos de uma janela de dias e as
//! contas que existem — e devolve o retrato inteiro pronto para desenhar.
//! Isso é deliberado, e é o que torna cada número aqui **verificável**: as
//! coortes de retenção, o funil e as séries diárias são funções puras, e os
//! testes do fim do arquivo montam um histórico de mentira e conferem que a
//! conta bate. Um painel administrativo que ninguém consegue testar é um
//! painel que ninguém deveria acreditar.
//!
//! ## O dia de quem lê, não o dia do servidor
//!
//! Todo agrupamento por dia recebe um deslocamento de fuso em minutos — o
//! mesmo que `Date.prototype.getTimezoneOffset()` dá no navegador de quem
//! abriu o painel. Sem ele, "hoje" no servidor (UTC, numa máquina em
//! qualquer lugar) começaria às 21h de ontem no Brasil, e o painel mostraria
//! um "hoje" que não é o dia de ninguém.
//!
//! ## O que é e o que não é uma pessoa ativa
//!
//! Uma pessoa está **ativa num dia** quando existe pelo menos um evento dela
//! naquele dia — abrir o aplicativo já conta, porque abrir o aplicativo é o
//! que uma pessoa faz quando o aplicativo lhe serve para alguma coisa. Não é
//! "mandou mensagem": exigir produção para contar presença esconderia
//! exatamente quem entra, olha e sai — que é o grupo mais importante de
//! entender enquanto o produto ainda está crescendo.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/* ─── O evento ────────────────────────────────────────────────────────── */

/// Uma linha do histórico. Deliberadamente pequena — ver o cabeçalho de
/// `migracoes/0006_eventos.sql` para o que **não** entra aqui.
#[derive(Clone, Serialize, Deserialize)]
pub struct Evento {
    pub em: u64,
    pub tipo: String,
    /// `None` para quem usa o CALL sem conta: continua sendo um acesso, e
    /// continua não sendo uma pessoa identificada.
    #[serde(default)]
    pub conta: Option<String>,
    /// Código do grupo ou id do canal, conforme o tipo. Vazio quando não se
    /// aplica.
    #[serde(default)]
    pub alvo: String,
    /// Único número livre: segundos de voz, por enquanto.
    #[serde(default)]
    pub valor: i64,
    #[serde(default)]
    pub plataforma: String,
    /// Por qual degrau da escada de mídia esta passagem pela voz aconteceu —
    /// `nuvem`, `proprio` ou `malha`. Vazio para todo evento que não é de
    /// voz, e vazio também nos eventos gravados antes de a escada existir:
    /// o painel mostra esses como "não medido" em vez de atribuí-los a um
    /// degrau que ninguém registrou.
    #[serde(default)]
    pub meio: String,
    /// Bytes de mídia que o cliente recebeu do servidor de mídia nesta
    /// passagem pela call. Só o navegador sabe este número — o servidor de
    /// sinalização não vê um byte de mídia passar —, e ele fica gravado no
    /// evento por um motivo prático: sem isso, reiniciar o servidor
    /// esqueceria a banda já gasta no ciclo, e o teto que existe para
    /// proteger a fatura protegeria a fatura errada.
    #[serde(default)]
    pub bytes: u64,
}

/// Os tipos que o servidor grava. Ficam como constantes, e não como um enum,
/// pelo mesmo motivo que o servidor não conhece a lista de mascotes: o painel
/// desenha o que não reconhece com o próprio nome cru, em vez de sumir com o
/// evento — uma versão nova do servidor não pode depender de o painel
/// aprender o vocabulário primeiro.
pub mod tipo {
    /// Conta nova. Um por pessoa, para sempre — é a base de toda coorte.
    pub const CONTA_CRIADA: &str = "conta-criada";
    /// Entrou com e-mail e senha, ou pelo Google. É login deliberado.
    pub const SESSAO_ABERTA: &str = "sessao-aberta";
    /// Abriu o CALL e a sessão guardada ainda valia. É o sinal de *acesso*
    /// mais fiel que existe: acontece uma vez por abertura do aplicativo.
    pub const SESSAO_RETOMADA: &str = "sessao-retomada";
    pub const SESSAO_FECHADA: &str = "sessao-fechada";
    pub const GRUPO_CRIADO: &str = "grupo-criado";
    pub const GRUPO_ENTROU: &str = "grupo-entrou";
    pub const VOZ_ENTROU: &str = "voz-entrou";
    /// `valor` traz os segundos que a pessoa ficou na call.
    pub const VOZ_SAIU: &str = "voz-saiu";
    pub const TRANSMISSAO: &str = "transmissao";
    pub const MENSAGEM: &str = "mensagem";
    pub const FEEDBACK: &str = "feedback";
    /// Alguém não conseguiu entrar no degrau de mídia que recebeu. `meio`
    /// diz qual degrau falhou — é a série que mostra, no painel, se a queda
    /// de ontem foi um episódio ou um padrão.
    pub const MIDIA_FALHOU: &str = "midia-falhou";
}

/* ─── Dias ────────────────────────────────────────────────────────────── */

const DIA_MS: i64 = 86_400_000;

/// Número do dia local a que um instante pertence. Dias contam desde a época
/// Unix; só a diferença entre dois deles importa.
pub fn dia_de(em: u64, fuso_min: i64) -> i64 {
    (em as i64 - fuso_min * 60_000).div_euclid(DIA_MS)
}

/// O instante em que o dia local `dia` começou, em milissegundos UTC — é o
/// que o navegador recebe para escrever a data no eixo do gráfico.
fn inicio_do_dia(dia: i64, fuso_min: i64) -> i64 {
    dia * DIA_MS + fuso_min * 60_000
}

/* ─── A conta, do ponto de vista do painel ────────────────────────────── */

/// O recorte de uma conta que o painel usa. Um espelho enxuto de
/// `contas::Conta` de propósito: o painel não tem por que carregar hash de
/// senha nem `sub` do Google para desenhar uma linha de tabela.
pub struct ContaNoPainel {
    pub id: String,
    pub email: String,
    pub apelido: String,
    pub avatar: String,
    pub criada_em: u64,
    /// Se a conta tem o Google vinculado — a única coisa que o painel diz
    /// sobre "como essa pessoa entra".
    pub google: bool,
    pub grupos: usize,
    pub amigos: usize,
}

/* ─── O retrato ───────────────────────────────────────────────────────── */

/// Quantos dias de série o painel desenha. Trinta cabe numa tela e cobre o
/// ciclo mensal; noventa é a janela que o servidor guarda.
pub const DIAS_DE_SERIE: i64 = 30;
/// Quantas coortes diárias a grade de retenção mostra, e até que dia.
pub const COORTES: i64 = 21;
pub const RETENCAO_DIAS: i64 = 8;

/// Monta o retrato inteiro. `eventos` pode vir em qualquer ordem.
pub fn montar(
    eventos: &[Evento],
    contas: &[ContaNoPainel],
    agora: u64,
    fuso_min: i64,
) -> Value {
    let hoje = dia_de(agora, fuso_min);

    // ── Desde quando dá para medir ───────────────────────────────────────
    //
    // Retenção e funil só sabem o que os eventos contam, e os eventos
    // começam no dia em que este servidor passou a anotá-los. Uma conta
    // criada **antes** disso não tem como provar que voltou — e contá-la
    // como "não voltou" seria a mentira mais cara deste arquivo: no primeiro
    // mês depois de ligar a telemetria, todo o cadastro anterior entraria no
    // denominador com zero, e o painel anunciaria uma retenção de 3% que
    // nunca existiu.
    //
    // Então ela fica de fora das coortes e do funil, e continua inteira em
    // "pessoas" e no total. O painel diz desde quando mede, em vez de fingir
    // que sempre mediu.
    let medido_desde = eventos.iter().map(|e| e.em).min().unwrap_or(agora);
    let dia_inicial = dia_de(medido_desde, fuso_min);
    let mensuravel = |c: &ContaNoPainel| dia_de(c.criada_em, fuso_min) >= dia_inicial;
    let medidas: Vec<&ContaNoPainel> = contas.iter().filter(|c| mensuravel(c)).collect();

    // ── Índices que quase tudo abaixo reusa ──────────────────────────────
    // dia -> contas ativas naquele dia. `BTreeMap` para a série sair em
    // ordem sem uma passada de ordenação depois.
    let mut ativos_por_dia: BTreeMap<i64, HashSet<&str>> = BTreeMap::new();
    // dia -> acessos (inclui quem não tem conta), mensagens, segundos de voz.
    let mut acessos_por_dia: HashMap<i64, u64> = HashMap::new();
    let mut mensagens_por_dia: HashMap<i64, u64> = HashMap::new();
    let mut segundos_por_dia: HashMap<i64, i64> = HashMap::new();
    let mut grupos_por_dia: HashMap<i64, HashSet<&str>> = HashMap::new();
    // (dia da semana, hora) -> eventos, para o mapa de horários.
    let mut horarios = vec![0u32; 7 * 24];
    let mut plataformas: HashMap<String, HashSet<String>> = HashMap::new();

    // Por conta: último instante visto, dias distintos ativos, e o que ela
    // já fez alguma vez (o funil de ativação).
    #[derive(Default)]
    struct PorConta<'a> {
        ultimo_em: u64,
        dias: HashSet<i64>,
        acessos: u64,
        mensagens: u64,
        segundos: i64,
        entrou_em_grupo: bool,
        entrou_na_voz: bool,
        plataformas: HashSet<&'a str>,
    }
    let mut por_conta: HashMap<&str, PorConta> = HashMap::new();

    for evento in eventos {
        let dia = dia_de(evento.em, fuso_min);
        let acesso = matches!(
            evento.tipo.as_str(),
            tipo::SESSAO_ABERTA | tipo::SESSAO_RETOMADA | tipo::CONTA_CRIADA
        );

        if acesso {
            *acessos_por_dia.entry(dia).or_default() += 1;
        }
        if evento.tipo == tipo::MENSAGEM {
            *mensagens_por_dia.entry(dia).or_default() += 1;
        }
        if evento.tipo == tipo::VOZ_SAIU {
            *segundos_por_dia.entry(dia).or_default() += evento.valor.max(0);
        }
        if !evento.alvo.is_empty()
            && matches!(
                evento.tipo.as_str(),
                tipo::GRUPO_ENTROU | tipo::GRUPO_CRIADO | tipo::MENSAGEM | tipo::VOZ_ENTROU
            )
        {
            grupos_por_dia.entry(dia).or_default().insert(&evento.alvo);
        }

        // O mapa de horários usa o dia da semana local. 1970-01-01 foi uma
        // quinta-feira, e a grade do painel começa no domingo — daí o +4.
        let local = evento.em as i64 - fuso_min * 60_000;
        let dia_da_semana = ((local.div_euclid(DIA_MS) + 4).rem_euclid(7)) as usize;
        let hora = (local.rem_euclid(DIA_MS) / 3_600_000) as usize;
        horarios[dia_da_semana * 24 + hora.min(23)] += 1;

        let Some(conta) = evento.conta.as_deref() else {
            continue;
        };
        ativos_por_dia.entry(dia).or_default().insert(conta);

        let registro = por_conta.entry(conta).or_default();
        registro.ultimo_em = registro.ultimo_em.max(evento.em);
        registro.dias.insert(dia);
        match evento.tipo.as_str() {
            tipo::MENSAGEM => registro.mensagens += 1,
            tipo::VOZ_SAIU => registro.segundos += evento.valor.max(0),
            tipo::VOZ_ENTROU => registro.entrou_na_voz = true,
            tipo::GRUPO_ENTROU | tipo::GRUPO_CRIADO => registro.entrou_em_grupo = true,
            _ => {}
        }
        if acesso {
            registro.acessos += 1;
        }
        if !evento.plataforma.is_empty() {
            registro.plataformas.insert(&evento.plataforma);
            plataformas
                .entry(evento.plataforma.clone())
                .or_default()
                .insert(conta.to_string());
        }
    }

    // ── Contas por dia de nascimento, para novos e para as coortes ───────
    let mut nascimentos: HashMap<i64, Vec<&ContaNoPainel>> = HashMap::new();
    for conta in contas {
        nascimentos
            .entry(dia_de(conta.criada_em, fuso_min))
            .or_default()
            .push(conta);
    }

    let ativos_em = |dia: i64| ativos_por_dia.get(&dia).map(HashSet::len).unwrap_or(0) as u64;
    let novos_em = |dia: i64| nascimentos.get(&dia).map(Vec::len).unwrap_or(0) as u64;

    // ── Série diária ────────────────────────────────────────────────────
    let serie: Vec<Value> = (hoje - DIAS_DE_SERIE + 1..=hoje)
        .map(|dia| {
            json!({
                "em": inicio_do_dia(dia, fuso_min),
                "ativos": ativos_em(dia),
                "novos": novos_em(dia),
                "acessos": acessos_por_dia.get(&dia).copied().unwrap_or(0),
                "mensagens": mensagens_por_dia.get(&dia).copied().unwrap_or(0),
                "minutosVoz": segundos_por_dia.get(&dia).copied().unwrap_or(0) / 60,
                "grupos": grupos_por_dia.get(&dia).map(HashSet::len).unwrap_or(0),
            })
        })
        .collect();

    // ── Janelas móveis ──────────────────────────────────────────────────
    let unicos_em = |desde: i64| -> u64 {
        let mut conjunto: HashSet<&str> = HashSet::new();
        for (dia, pessoas) in ativos_por_dia.range(desde..=hoje) {
            let _ = dia;
            conjunto.extend(pessoas.iter());
        }
        conjunto.len() as u64
    };
    let dau = ativos_em(hoje);
    let wau = unicos_em(hoje - 6);
    let mau = unicos_em(hoje - 29);

    let soma = |mapa: &HashMap<i64, u64>, desde: i64| -> u64 {
        (desde..=hoje).map(|d| mapa.get(&d).copied().unwrap_or(0)).sum()
    };
    let novos_desde = |desde: i64| -> u64 { (desde..=hoje).map(novos_em).sum() };

    // ── Retenção ────────────────────────────────────────────────────────
    let esteve_ativa = |conta: &str, dia: i64| -> bool {
        ativos_por_dia
            .get(&dia)
            .map(|pessoas| pessoas.contains(conta))
            .unwrap_or(false)
    };

    let mut coortes = Vec::new();
    for nascimento in (hoje - COORTES + 1).max(dia_inicial)..=hoje {
        let turma = nascimentos.get(&nascimento).cloned().unwrap_or_default();
        // Uma coorte vazia continua na grade: um dia sem ninguém novo é uma
        // informação, e apagá-lo faria a grade mentir sobre o calendário.
        let valores: Vec<Value> = (0..RETENCAO_DIAS)
            .map(|passo| {
                if nascimento + passo > hoje {
                    return Value::Null; // esse dia ainda não aconteceu
                }
                let voltaram = turma
                    .iter()
                    .filter(|c| esteve_ativa(&c.id, nascimento + passo))
                    .count();
                json!(voltaram)
            })
            .collect();
        coortes.push(json!({
            "em": inicio_do_dia(nascimento, fuso_min),
            "tamanho": turma.len(),
            "voltaram": valores,
        }));
    }

    // Manchete: sobre todas as contas cujo dia N já passou. Contar só quem
    // teve a chance de voltar é o que impede a coorte de ontem — que ainda
    // não pôde ter um D7 — de derrubar a média para perto de zero.
    let retencao_de = |passo: i64| -> Value {
        let mut elegiveis = 0u64;
        let mut voltaram = 0u64;
        for conta in &medidas {
            let nascimento = dia_de(conta.criada_em, fuso_min);
            if nascimento + passo > hoje {
                continue;
            }
            elegiveis += 1;
            if esteve_ativa(&conta.id, nascimento + passo) {
                voltaram += 1;
            }
        }
        json!({ "elegiveis": elegiveis, "voltaram": voltaram })
    };

    // ── Funil de ativação ───────────────────────────────────────────────
    let vazio = PorConta::default();
    let com = |f: fn(&PorConta) -> bool| -> u64 {
        medidas
            .iter()
            .filter(|c| f(por_conta.get(c.id.as_str()).unwrap_or(&vazio)))
            .count() as u64
    };

    // ── Pessoas ─────────────────────────────────────────────────────────
    let mut pessoas: Vec<Value> = contas
        .iter()
        .map(|c| {
            let r = por_conta.get(c.id.as_str()).unwrap_or(&vazio);
            let mut lista: Vec<&str> = r.plataformas.iter().copied().collect();
            lista.sort_unstable();
            json!({
                "id": c.id,
                "email": c.email,
                "apelido": c.apelido,
                "avatar": c.avatar,
                "criadaEm": c.criada_em,
                "google": c.google,
                "grupos": c.grupos,
                "amigos": c.amigos,
                "ultimoEm": r.ultimo_em,
                "diasAtivos": r.dias.len(),
                "acessos": r.acessos,
                "mensagens": r.mensagens,
                "minutosVoz": r.segundos / 60,
                "plataformas": lista,
            })
        })
        .collect();
    // Mais recente primeiro; quem nunca voltou desde o cadastro cai para o
    // fim com o próprio cadastro como data.
    pessoas.sort_by(|a, b| {
        let chave = |v: &Value| {
            v["ultimoEm"]
                .as_u64()
                .filter(|x| *x > 0)
                .unwrap_or_else(|| v["criadaEm"].as_u64().unwrap_or(0))
        };
        chave(b).cmp(&chave(a))
    });

    let mut plataformas: Vec<Value> = plataformas
        .into_iter()
        .map(|(nome, pessoas)| json!({ "nome": nome, "pessoas": pessoas.len() }))
        .collect();
    plataformas.sort_by(|a, b| b["pessoas"].as_u64().cmp(&a["pessoas"].as_u64()));

    json!({
        "geradoEm": agora,
        "fuso": fuso_min,
        "totais": {
            "contas": contas.len(),
            "comGoogle": contas.iter().filter(|c| c.google).count(),
            "eventos": eventos.len(),
        },
        "janelas": {
            "dau": dau,
            "wau": wau,
            "mau": mau,
            "ontem": ativos_em(hoje - 1),
            "novosHoje": novos_em(hoje),
            "novosOntem": novos_em(hoje - 1),
            "novos7": novos_desde(hoje - 6),
            "novos30": novos_desde(hoje - 29),
            "acessosHoje": acessos_por_dia.get(&hoje).copied().unwrap_or(0),
            "acessosOntem": acessos_por_dia.get(&(hoje - 1)).copied().unwrap_or(0),
            "acessos7": soma(&acessos_por_dia, hoje - 6),
            "mensagensHoje": mensagens_por_dia.get(&hoje).copied().unwrap_or(0),
            "mensagens7": soma(&mensagens_por_dia, hoje - 6),
            "minutosVozHoje": segundos_por_dia.get(&hoje).copied().unwrap_or(0) / 60,
            "minutosVoz7": (hoje - 6..=hoje)
                .map(|d| segundos_por_dia.get(&d).copied().unwrap_or(0))
                .sum::<i64>() / 60,
            "gruposAtivosHoje": grupos_por_dia.get(&hoje).map(HashSet::len).unwrap_or(0),
        },
        "serie": serie,
        "retencao": {
            "d1": retencao_de(1),
            "d7": retencao_de(7),
            "d30": retencao_de(30),
            "coortes": coortes,
        },
        "medidoDesde": medido_desde,
        "funil": {
            // A base do funil são as contas mensuráveis, e não todas: um
            // degrau só pode estreitar em relação ao de cima se os dois
            // contarem as mesmas pessoas.
            "criaram": medidas.len(),
            "voltaram": com(|r| r.dias.len() > 1),
            "entraramEmGrupo": com(|r| r.entrou_em_grupo),
            "mandaramMensagem": com(|r| r.mensagens > 0),
            "entraramNaVoz": com(|r| r.entrou_na_voz),
        },
        "horarios": horarios,
        "plataformas": plataformas,
        "pessoas": pessoas,
    })
}

/* ─── Consumo de mídia ────────────────────────────────────────────────── */

/// O que a escada de mídia gastou no ciclo de cobrança em curso.
///
/// Fica separado de `montar` porque responde a outro relógio: todo o resto
/// do painel mede **dias**, e este mede o **ciclo da fatura**, que começa no
/// dia do mês em que a cobrança vira. Misturar os dois faria "consumido este
/// mês" querer dizer "nos últimos 30 dias", que é uma resposta parecida e
/// errada — e errada justamente perto do fim do ciclo, quando a pergunta
/// importa.
///
/// A projeção é uma regra de três sobre o que já passou do ciclo: se em 40%
/// do tempo foram gastos 40% do teto, ela projeta o teto redondo. Não tenta
/// prever crescimento, e não deve: um número que a gente não consegue
/// explicar não serve para decidir desligar um degrau.
pub fn consumo(eventos: &[Evento], ciclo_desde: u64, fuso_min: i64, agora: u64) -> Value {
    let hoje = dia_de(agora, fuso_min);
    let no_ciclo = |e: &&Evento| e.em >= ciclo_desde;

    // meio -> (segundos, passagens pela call, bytes)
    let mut por_meio: BTreeMap<String, (i64, u64, u64)> = BTreeMap::new();
    let mut falhas: BTreeMap<String, u64> = BTreeMap::new();
    // (dia, meio) -> segundos, para a série que o painel desenha.
    let mut por_dia: BTreeMap<(i64, String), i64> = BTreeMap::new();
    let mut meios: HashSet<String> = HashSet::new();

    for evento in eventos.iter().filter(no_ciclo) {
        // O evento antigo, sem degrau anotado, não vira "malha" por
        // conveniência: ele é o que é, um consumo que ninguém atribuiu.
        let meio = if evento.meio.is_empty() {
            "nao-medido"
        } else {
            evento.meio.as_str()
        };
        match evento.tipo.as_str() {
            tipo::VOZ_SAIU => {
                let entrada = por_meio.entry(meio.to_string()).or_default();
                entrada.0 += evento.valor.max(0);
                entrada.1 += 1;
                entrada.2 += evento.bytes;
                meios.insert(meio.to_string());
            }
            tipo::MIDIA_FALHOU => {
                *falhas.entry(meio.to_string()).or_default() += 1;
                meios.insert(meio.to_string());
            }
            _ => continue,
        }
    }

    // A série cobre os mesmos dias do resto do painel, para os dois gráficos
    // poderem ser lidos lado a lado.
    for evento in eventos.iter().filter(|e| e.tipo == tipo::VOZ_SAIU) {
        let dia = dia_de(evento.em, fuso_min);
        if dia < hoje - DIAS_DE_SERIE + 1 {
            continue;
        }
        let meio = if evento.meio.is_empty() {
            "nao-medido"
        } else {
            evento.meio.as_str()
        };
        *por_dia.entry((dia, meio.to_string())).or_default() += evento.valor.max(0);
        meios.insert(meio.to_string());
    }

    let mut serie: Vec<Value> = Vec::new();
    for dia in (hoje - DIAS_DE_SERIE + 1)..=hoje {
        let mut ponto = serde_json::Map::new();
        ponto.insert("em".into(), json!(inicio_do_dia(dia, fuso_min)));
        for meio in &meios {
            let segundos = por_dia.get(&(dia, meio.clone())).copied().unwrap_or(0);
            ponto.insert(meio.clone(), json!(segundos / 60));
        }
        serie.push(Value::Object(ponto));
    }

    let decorrido = agora.saturating_sub(ciclo_desde).max(1);
    // Trinta dias é o comprimento nominal de um ciclo. A projeção não
    // precisa saber quantos dias tem este mês: ela é uma ordem de grandeza,
    // e o painel a apresenta como tal.
    const CICLO_MS: u64 = 30 * 86_400_000;
    let fracao_decorrida = (decorrido as f64 / CICLO_MS as f64).clamp(0.01, 1.0);

    let degraus: Vec<Value> = por_meio
        .iter()
        .map(|(meio, (segundos, sessoes, bytes))| {
            let minutos = segundos / 60;
            let gb = *bytes as f64 / 1_000_000_000.0;
            json!({
                "meio": meio,
                "minutos": minutos,
                "sessoes": sessoes,
                "gb": (gb * 100.0).round() / 100.0,
                "projecao": (minutos as f64 / fracao_decorrida).round() as i64,
                "projecaoGb": ((gb / fracao_decorrida) * 100.0).round() / 100.0,
                "falhas": falhas.get(meio).copied().unwrap_or(0),
            })
        })
        .collect();

    // Ordem fixa, e não a de um `HashSet`: é ela que decide qual caminho o
    // painel desenha como barra e quais como linha. Sem isto, dois retratos
    // seguidos poderiam trocar o desenho entre si sem nada ter mudado — e um
    // gráfico que muda de forma sozinho é um gráfico em que não se confia.
    let mut ordenados: Vec<String> = meios.iter().cloned().collect();
    ordenados.sort_by_key(|meio| {
        let posicao = match meio.as_str() {
            "nuvem" => 0,
            "proprio" => 1,
            "malha" => 2,
            "nao-medido" => 3,
            _ => 4,
        };
        (posicao, meio.clone())
    });

    json!({
        "cicloDesde": ciclo_desde,
        "fracaoDecorrida": fracao_decorrida,
        "degraus": degraus,
        "serie": serie,
        "meios": ordenados,
        "totalMinutos": por_meio.values().map(|(s, _, _)| s / 60).sum::<i64>(),
        "totalFalhas": falhas.values().sum::<u64>(),
    })
}

#[cfg(test)]
mod testes {
    use super::*;

    const FUSO: i64 = 180; // Brasil, UTC-3 — o fuso de quem vai ler o painel.

    fn instante(dia: i64, hora: i64) -> u64 {
        (inicio_do_dia(dia, FUSO) + hora * 3_600_000) as u64
    }

    fn conta(id: &str, nascimento: i64) -> ContaNoPainel {
        ContaNoPainel {
            id: id.into(),
            email: format!("{id}@exemplo.com"),
            apelido: id.into(),
            avatar: String::new(),
            criada_em: instante(nascimento, 10),
            google: false,
            grupos: 1,
            amigos: 0,
        }
    }

    fn evento(conta: &str, tipo: &str, dia: i64, hora: i64) -> Evento {
        Evento {
            em: instante(dia, hora),
            tipo: tipo.into(),
            conta: Some(conta.into()),
            alvo: "GRUPO12345".into(),
            valor: 0,
            plataforma: "windows".into(),
            meio: String::new(),
            bytes: 0,
        }
    }

    /// Uma passagem pela voz que durou `segundos`, por um degrau conhecido —
    /// o insumo dos testes de consumo.
    fn passagem(conta: &str, dia: i64, hora: i64, segundos: i64, meio: &str) -> Evento {
        Evento {
            valor: segundos,
            meio: meio.into(),
            ..evento(conta, tipo::VOZ_SAIU, dia, hora)
        }
    }

    /// O dia local vira de madrugada no Brasil, e não às 21h — que é o que
    /// aconteceria se o painel contasse dias em UTC.
    #[test]
    fn o_dia_e_o_de_quem_le_o_painel() {
        let hoje = 20_000;
        // 23h no horário de Brasília ainda é hoje.
        assert_eq!(dia_de(instante(hoje, 23), FUSO), hoje);
        // 00h30 do dia seguinte já é amanhã.
        assert_eq!(dia_de(instante(hoje + 1, 0) + 1_800_000, FUSO), hoje + 1);
    }

    #[test]
    fn o_dau_conta_pessoas_e_nao_eventos() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let contas = vec![conta("ana", hoje), conta("bia", hoje)];
        let eventos = vec![
            evento("ana", tipo::SESSAO_RETOMADA, hoje, 9),
            evento("ana", tipo::MENSAGEM, hoje, 10),
            evento("ana", tipo::MENSAGEM, hoje, 11),
            evento("bia", tipo::SESSAO_RETOMADA, hoje, 12),
        ];

        let painel = montar(&eventos, &contas, agora_de_teste(), FUSO);
        assert_eq!(painel["janelas"]["dau"], 2, "duas pessoas, quatro eventos");
        assert_eq!(painel["janelas"]["mensagensHoje"], 2);
    }

    /// A prova de fogo da retenção: quem voltou no dia seguinte conta, quem
    /// nunca voltou não conta, e quem se cadastrou ontem **não** entra no
    /// denominador do D7 — porque o sétimo dia dela ainda não chegou.
    #[test]
    fn a_retencao_so_cobra_de_quem_teve_a_chance_de_voltar() {
        let agora = agora_de_teste();
        let hoje = dia_de(agora, FUSO);

        let contas = vec![
            conta("volta", hoje - 10),  // cadastrou há 10 dias
            conta("sumiu", hoje - 10),  // idem, e nunca mais apareceu
            conta("recente", hoje - 1), // cadastrou ontem
        ];
        let eventos = vec![
            evento("volta", tipo::CONTA_CRIADA, hoje - 10, 10),
            evento("volta", tipo::SESSAO_RETOMADA, hoje - 9, 10), // D1 ✓
            evento("volta", tipo::SESSAO_RETOMADA, hoje - 3, 10), // D7 ✓
            evento("sumiu", tipo::CONTA_CRIADA, hoje - 10, 10),
            evento("recente", tipo::CONTA_CRIADA, hoje - 1, 10),
            evento("recente", tipo::SESSAO_RETOMADA, hoje, 10), // D1 ✓
        ];

        let painel = montar(&eventos, &contas, agora, FUSO);

        assert_eq!(painel["retencao"]["d1"]["elegiveis"], 3, "as três já viveram um D1");
        assert_eq!(painel["retencao"]["d1"]["voltaram"], 2);

        assert_eq!(
            painel["retencao"]["d7"]["elegiveis"], 2,
            "quem cadastrou ontem não pode reprovar num D7 que não chegou"
        );
        assert_eq!(painel["retencao"]["d7"]["voltaram"], 1);
    }

    /// Cada degrau do funil é um subconjunto do anterior — se a contagem
    /// subir descendo a escada, o funil está contando outra coisa.
    #[test]
    fn o_funil_so_estreita() {
        let agora = agora_de_teste();
        let hoje = dia_de(agora, FUSO);
        let contas = vec![conta("ana", hoje), conta("bia", hoje), conta("cid", hoje)];
        let eventos = vec![
            evento("ana", tipo::GRUPO_ENTROU, hoje, 9),
            evento("ana", tipo::MENSAGEM, hoje, 9),
            evento("ana", tipo::VOZ_ENTROU, hoje, 9),
            evento("bia", tipo::GRUPO_ENTROU, hoje, 9),
            evento("bia", tipo::MENSAGEM, hoje, 9),
            evento("cid", tipo::GRUPO_ENTROU, hoje, 9),
        ];

        let f = &montar(&eventos, &contas, agora, FUSO)["funil"];
        let degraus = ["criaram", "entraramEmGrupo", "mandaramMensagem", "entraramNaVoz"];
        let valores: Vec<u64> = degraus.iter().map(|d| f[d].as_u64().unwrap()).collect();
        assert_eq!(valores, vec![3, 3, 2, 1]);
        for par in valores.windows(2) {
            assert!(par[0] >= par[1], "um degrau do funil ficou maior que o de cima");
        }
    }

    /// O dia em que a telemetria foi ligada é o dia em que a retenção passa
    /// a existir. Quem já tinha conta antes disso não pode reprovar num
    /// exame que ninguém aplicou — e este é o teste que impede o painel de
    /// anunciar uma retenção terrível na semana em que ele estreia.
    #[test]
    fn quem_veio_antes_dos_eventos_nao_entra_na_conta() {
        let agora = agora_de_teste();
        let hoje = dia_de(agora, FUSO);

        let contas = vec![
            conta("antiga", hoje - 20), // já existia quando a telemetria nasceu
            conta("nova", hoje - 3),    // criada depois, e voltou
        ];
        // O primeiro evento de todos é de cinco dias atrás: antes disso, o
        // servidor não anotava nada.
        let eventos = vec![
            evento("nova", tipo::CONTA_CRIADA, hoje - 3, 10),
            evento("nova", tipo::SESSAO_RETOMADA, hoje - 2, 10),
            evento("antiga", tipo::SESSAO_RETOMADA, hoje - 5, 10),
        ];

        let painel = montar(&eventos, &contas, agora, FUSO);

        assert_eq!(painel["totais"]["contas"], 2, "as duas contas continuam existindo");
        assert_eq!(
            painel["retencao"]["d1"]["elegiveis"], 1,
            "só a conta que nasceu depois do primeiro evento pode ser cobrada"
        );
        assert_eq!(painel["retencao"]["d1"]["voltaram"], 1);
        assert_eq!(painel["funil"]["criaram"], 1, "e o funil parte da mesma base");

        // A grade não inventa linhas para dias anteriores à medição.
        let coortes = painel["retencao"]["coortes"].as_array().unwrap();
        let mais_antiga = coortes.first().unwrap()["em"].as_i64().unwrap();
        assert!(
            mais_antiga >= (hoje - 5) * 86_400_000 + FUSO * 60_000,
            "a grade começa no primeiro dia medido, e não antes dele"
        );
    }

    #[test]
    fn os_minutos_de_voz_vem_da_saida_e_nao_da_entrada() {
        let agora = agora_de_teste();
        let hoje = dia_de(agora, FUSO);
        let mut saida = evento("ana", tipo::VOZ_SAIU, hoje, 14);
        saida.valor = 25 * 60 + 40; // 25min40 numa call só

        let painel = montar(
            &[evento("ana", tipo::VOZ_ENTROU, hoje, 13), saida],
            &[conta("ana", hoje)],
            agora,
            FUSO,
        );
        assert_eq!(painel["janelas"]["minutosVozHoje"], 25, "trunca, não arredonda para cima");
    }

    /// A série tem sempre o mesmo comprimento e termina hoje, mesmo sem
    /// nenhum evento — um gráfico com buracos seria um gráfico que mente
    /// sobre o eixo do tempo.
    #[test]
    fn a_serie_cobre_a_janela_inteira_mesmo_nos_dias_mortos() {
        let painel = montar(&[], &[], agora_de_teste(), FUSO);
        let serie = painel["serie"].as_array().unwrap();
        assert_eq!(serie.len() as i64, DIAS_DE_SERIE);
        assert!(serie.iter().all(|d| d["ativos"] == 0));
    }

    /* ── Consumo de mídia ─────────────────────────────────────────── */

    /// O caso que motivou o medidor inteiro: saber quantos minutos foram
    /// para o LiveKit da nuvem, separados dos que a malha carregou de graça.
    #[test]
    fn o_consumo_separa_os_minutos_por_degrau() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let ciclo = instante(hoje - 10, 0);
        let eventos = vec![
            passagem("ana", hoje, 10, 600, "nuvem"),   // 10 min
            passagem("bia", hoje, 11, 300, "nuvem"),   //  5 min
            passagem("caio", hoje - 1, 12, 1_800, "malha"), // 30 min
        ];

        let c = consumo(&eventos, ciclo, FUSO, agora_de_teste());
        let degraus = c["degraus"].as_array().unwrap();
        let nuvem = degraus.iter().find(|d| d["meio"] == "nuvem").unwrap();
        let malha = degraus.iter().find(|d| d["meio"] == "malha").unwrap();

        assert_eq!(nuvem["minutos"], 15);
        assert_eq!(nuvem["sessoes"], 2);
        assert_eq!(malha["minutos"], 30);
        assert_eq!(c["totalMinutos"], 45);
    }

    /// Um evento anterior à escada não vira "malha" nem "nuvem" por
    /// conveniência: ele não foi medido, e o painel diz isso.
    #[test]
    fn o_que_ninguem_anotou_aparece_como_nao_medido() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let eventos = vec![passagem("ana", hoje, 10, 600, "")];
        let c = consumo(&eventos, instante(hoje - 5, 0), FUSO, agora_de_teste());
        let degraus = c["degraus"].as_array().unwrap();
        assert_eq!(degraus.len(), 1);
        assert_eq!(degraus[0]["meio"], "nao-medido");
    }

    /// O ciclo de cobrança, e não os últimos trinta dias: um minuto gasto
    /// antes da virada da fatura já foi pago e não conta contra o teto atual.
    #[test]
    fn o_consumo_ignora_o_que_ficou_no_ciclo_anterior() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let ciclo = instante(hoje - 3, 0);
        let eventos = vec![
            passagem("ana", hoje - 10, 10, 6_000, "nuvem"), // ciclo passado
            passagem("ana", hoje - 1, 10, 600, "nuvem"),    // este ciclo
        ];
        let c = consumo(&eventos, ciclo, FUSO, agora_de_teste());
        assert_eq!(c["totalMinutos"], 10, "só o que caiu dentro do ciclo");
    }

    /// A projeção é uma regra de três sobre a fração do ciclo já decorrida —
    /// nada além disso, e é por isso que dá para conferir na mão.
    #[test]
    fn a_projecao_e_uma_regra_de_tres_sobre_o_ciclo() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        // Quinze dias de ciclo decorridos: metade dos trinta nominais.
        let ciclo = agora_de_teste() - 15 * 86_400_000;
        let eventos = vec![passagem("ana", hoje, 10, 6_000, "nuvem")]; // 100 min
        let c = consumo(&eventos, ciclo, FUSO, agora_de_teste());
        let nuvem = &c["degraus"].as_array().unwrap()[0];
        assert_eq!(nuvem["minutos"], 100);
        assert_eq!(nuvem["projecao"], 200, "metade do ciclo, o dobro no fim");
    }

    /// As falhas de mídia entram no mesmo retrato: é o número que responde
    /// "aquilo de ontem foi um episódio ou virou rotina?".
    #[test]
    fn as_falhas_de_midia_contam_por_degrau() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let ciclo = instante(hoje - 5, 0);
        let mut falha = evento("ana", tipo::MIDIA_FALHOU, hoje, 9);
        falha.meio = "nuvem".into();
        let eventos = vec![
            passagem("ana", hoje, 10, 600, "nuvem"),
            falha.clone(),
            falha,
        ];
        let c = consumo(&eventos, ciclo, FUSO, agora_de_teste());
        let nuvem = c["degraus"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["meio"] == "nuvem")
            .unwrap()
            .clone();
        assert_eq!(nuvem["falhas"], 2);
        assert_eq!(c["totalFalhas"], 2);
    }

    /// A ordem dos caminhos é a da escada, e não a de um conjunto sem ordem:
    /// é ela que decide o desenho do gráfico, e um desenho que muda sozinho
    /// entre dois retratos iguais não se lê.
    #[test]
    fn os_caminhos_saem_na_ordem_da_escada() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let eventos = vec![
            passagem("ana", hoje, 10, 60, "malha"),
            passagem("bia", hoje, 10, 60, ""),
            passagem("caio", hoje, 10, 60, "proprio"),
            passagem("duda", hoje, 10, 60, "nuvem"),
        ];
        let c = consumo(&eventos, instante(hoje - 2, 0), FUSO, agora_de_teste());
        let meios: Vec<&str> = c["meios"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap())
            .collect();
        assert_eq!(meios, vec!["nuvem", "proprio", "malha", "nao-medido"]);
    }

    /// A série do consumo tem o mesmo comprimento da série do resto do
    /// painel — os dois gráficos são lidos um debaixo do outro.
    #[test]
    fn a_serie_de_consumo_acompanha_a_janela_do_painel() {
        let hoje = dia_de(agora_de_teste(), FUSO);
        let eventos = vec![passagem("ana", hoje, 10, 600, "nuvem")];
        let c = consumo(&eventos, instante(hoje - 2, 0), FUSO, agora_de_teste());
        let serie = c["serie"].as_array().unwrap();
        assert_eq!(serie.len() as i64, DIAS_DE_SERIE);
        assert_eq!(serie.last().unwrap()["nuvem"], 10);
        assert_eq!(serie[0]["nuvem"], 0);
    }

    fn agora_de_teste() -> u64 {
        // Um instante fixo, para o teste não depender do relógio da máquina:
        // 2026-06-15, 18:00 UTC.
        1_781_200_800_000
    }
}
