/**
 * Semeia uma pasta de dados com trinta dias de história inventada, para
 * poder *olhar* a central de comando com ela cheia.
 *
 * Isto não é teste — nada aqui aprova ou reprova nada. É uma bancada: um
 * painel de retenção com dois dias de uso não mostra se a grade de coortes
 * está legível, se o gráfico respira, nem se o mapa de horários diz alguma
 * coisa. Este arquivo produz o volume que só apareceria depois de um mês de
 * uso real.
 *
 *   node testes/painel-semente.mjs            # semeia e deixa o servidor de pé
 *   node testes/painel-semente.mjs --so-dados # só escreve a pasta e sai
 *
 * Com o servidor de pé, abra:
 *   node testes/ao-vivo.mjs
 *   http://127.0.0.1:8124/?servidor=ws://127.0.0.1:8788
 * e entre com o e-mail do dono e a senha abaixo.
 */

import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BINARIO = "target/release/sinalizacao.exe";
const PASTA = join(process.cwd(), "testes", "dados-painel");
const PORTA = 8788;

/** O dono. É o mesmo padrão embutido em `contas.rs`; com `ADMIN_EMAILS` no
 *  ambiente, quem manda é a variável. */
const DONO = "alanvitoraraujo1a@outlook.com";
/** A escada de mídia da bancada. As URLs não levam a lugar nenhum — o
 *  servidor assina tokens para elas e ninguém tenta usá-los aqui. O que
 *  interessa nesta bancada é a aba de mídia ter dois degraus, um teto e um
 *  consumo para desenhar. */
const AMBIENTE_DE_MIDIA = {
  LIVEKIT_URL: "wss://call-bancada.livekit.cloud",
  LIVEKIT_API_KEY: "chave-da-bancada",
  LIVEKIT_API_SECRET: "segredo-da-bancada-com-tamanho-suficiente",
  LIVEKIT_MINUTOS_MES: "5000",
  LIVEKIT_GB_MES: "50",
  LIVEKIT_RESERVA_URL: "wss://midia.aionixdev.com",
  LIVEKIT_RESERVA_API_KEY: "chave-reserva",
  LIVEKIT_RESERVA_API_SECRET: "segredo-reserva-com-tamanho-suficiente",
};

const SENHA = "painel-de-teste-1";

const DIA = 86_400_000;
const AGORA = Date.now();
/** Meia-noite local de hoje — os dias do painel são os dias de quem lê. */
const HOJE = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

/* ─── Sorteio reprodutível ──────────────────────────────────────── */
//
// Semente fixa de propósito: duas rodadas seguidas dão o mesmo painel, e é o
// que permite comparar uma captura de tela com a seguinte. `HOJE` continua
// andando com o relógio — a história é sempre a mesma, ancorada em hoje.

let semente = 20260819;
function sorte() {
  semente = (semente * 1103515245 + 12345) & 0x7fffffff;
  return semente / 0x7fffffff;
}
const entre = (a, b) => a + Math.floor(sorte() * (b - a + 1));
const escolher = (lista) => lista[entre(0, lista.length - 1)];

/* ─── Gente ─────────────────────────────────────────────────────── */

const NOMES = [
  "Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabi", "Heitor",
  "Iris", "João", "Karen", "Lucas", "Marina", "Nando", "Olívia", "Pedro",
  "Quésia", "Rafa", "Sofia", "Téo", "Ursula", "Vitor", "Wanda", "Yuri",
  "Zeca", "Bea", "Caio", "Duda", "Enzo", "Flávia", "Gustavo", "Helena",
];
const MASCOTES = ["coruja", "raposa", "axolote", "capivara", "polvo", "dragao"];
const PLATAFORMAS = ["windows", "windows", "windows", "movel", "movel", "navegador"];

const GRUPOS = [
  { nome: "Time do CALL", descricao: "onde tudo acontece" },
  { nome: "Sábado à noite", descricao: "" },
  { nome: "Faculdade", descricao: "trabalho de sistemas distribuídos" },
  { nome: "Família", descricao: "" },
];

const FRASES = [
  "bora?", "cheguei", "alguém aí?", "kkkkk", "acabei de instalar, ficou muito bom",
  "entra na call", "tô indo", "esse soundboard é hilário", "boa noite pessoal",
  "consegui compartilhar a tela agora", "vou dormir, até amanhã", "alguém sabe mexer nisso?",
];

function id() {
  return Array.from({ length: 22 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[entre(0, 35)]).join("");
}
function codigoDeGrupo() {
  return Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[entre(0, 31)]).join("");
}

/* ─── 1. Uma passada pelo servidor de verdade, só pelo hash ─────── */
//
// O Argon2 mora no Rust, e não vale reimplementá-lo aqui só para semear:
// o servidor sobe uma vez, cria a conta do dono, e o hash que ele gravou é
// reaproveitado por todo mundo. Todas as contas semeadas compartilham a
// mesma senha, e isso é aceitável exatamente porque nenhuma delas existe
// fora desta bancada.

async function nascerComHashDeVerdade() {
  rmSync(PASTA, { recursive: true, force: true });
  mkdirSync(PASTA, { recursive: true });

  const processo = spawn(BINARIO, [String(PORTA)], {
    stdio: "ignore",
    env: { ...process.env, DADOS: PASTA, ...AMBIENTE_DE_MIDIA },
  });

  for (let i = 0; i < 80; i++) {
    try {
      const sonda = new WebSocket(`ws://127.0.0.1:${PORTA}`);
      await new Promise((ok, nao) => {
        sonda.addEventListener("open", ok, { once: true });
        sonda.addEventListener("error", nao, { once: true });
      });
      sonda.close();
      break;
    } catch {
      await esperar(50);
    }
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORTA}`);
  await new Promise((ok, nao) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", nao, { once: true });
  });
  ws.send(JSON.stringify({
    tipo: "cadastrar",
    email: DONO,
    senha: SENHA,
    apelido: "Alan",
    avatar: "dragao",
    bio: "quem construiu isto aqui",
    plataforma: "windows",
  }));
  await new Promise((ok) => {
    ws.addEventListener("message", (e) => {
      if (JSON.parse(e.data).tipo === "sessao") ok();
    });
  });
  ws.close();
  await esperar(300);
  processo.kill();
  await esperar(400);

  const contas = JSON.parse(readFileSync(join(PASTA, "contas.json"), "utf8"));
  const dono = contas.find((c) => c.email === DONO);
  if (!dono) throw new Error("o servidor não gravou a conta do dono");
  return { dono, hash: dono.senha };
}

/* ─── 2. A história ─────────────────────────────────────────────── */

function semear({ dono, hash }) {
  const contas = [];
  const eventos = [];
  const mensagens = [];

  const anotar = (em, tipo, conta, alvo = "", valor = 0, plataforma = "", meio = "") =>
    eventos.push({ em: Math.round(em), tipo, conta, alvo, valor, plataforma, meio });

  /* Grupos, criados na primeira semana */
  const grupos = GRUPOS.map((g, i) => ({
    codigo: codigoDeGrupo(),
    nome: g.nome,
    foto: "",
    descricao: g.descricao,
    dono: dono.id,
    criado: HOJE - (29 - i * 2) * DIA,
    categorias: [
      {
        id: id(),
        nome: "Geral",
        canais: [
          { id: id(), nome: "conversa", tipo: "texto" },
          { id: id(), nome: "avisos", tipo: "texto" },
          { id: id(), nome: "Sala 1", tipo: "voz" },
          { id: id(), nome: "Sala 2", tipo: "voz" },
        ],
      },
    ],
  }));

  /* O dono: entrou há 30 dias e usa todo dia. */
  dono.criada_em = HOJE - 29 * DIA + 9 * 3_600_000;
  dono.atalhos = grupos.map((g) => ({ codigo: g.codigo, nome: g.nome, foto: "" }));
  contas.push(dono);

  /**
   * Cada pessoa ganha uma "aderência": a chance de ela voltar num dia
   * qualquer depois de entrar. É o que faz a grade de coortes ter relevo em
   * vez de ser um bloco uniforme — e é assim que a retenção se parece de
   * verdade: uma minoria fica, muita gente some no primeiro dia.
   */
  const pessoas = NOMES.map((nome, i) => {
    // Crescimento: poucas contas no começo, mais perto de hoje.
    const idade = Math.round(29 * (1 - (i / NOMES.length) ** 0.65));
    const aderencia = sorte() < 0.42 ? sorte() * 0.12 : 0.2 + sorte() * 0.6;
    return {
      id: `conta-${id()}`,
      email: `${nome.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}@exemplo.com`,
      senha: hash,
      google: sorte() < 0.3 ? `google-${id()}` : "",
      apelido: nome,
      avatar: escolher(MASCOTES),
      bio: "",
      atalhos: [],
      som_entrada: null,
      amigos: [],
      pedidos_amigo: [],
      criada_em: HOJE - idade * DIA + entre(8, 22) * 3_600_000,
      // não vai para o arquivo: só orienta a geração abaixo
      _idade: idade,
      _aderencia: aderencia,
      _plataforma: escolher(PLATAFORMAS),
    };
  });

  for (const p of pessoas) {
    const nascimento = p.criada_em;
    anotar(nascimento, "conta-criada", p.id, "", 0, p._plataforma);

    // Quase todo mundo entra num grupo no mesmo dia — é para isso que a
    // pessoa recebeu o convite.
    const meuGrupo = escolher(grupos);
    if (sorte() < 0.88) {
      anotar(nascimento + 120_000, "grupo-entrou", p.id, meuGrupo.codigo, 0, p._plataforma);
      p.atalhos.push({ codigo: meuGrupo.codigo, nome: meuGrupo.nome, foto: "" });
    }

    for (let d = 1; d <= p._idade; d++) {
      if (sorte() > p._aderencia) continue;
      const dia = HOJE - (p._idade - d) * DIA;
      // As pessoas usam o CALL à noite. A curva não é plana, e o mapa de
      // horários só diz alguma coisa se ela não for.
      const hora = sorte() < 0.68 ? entre(18, 23) : entre(9, 17);
      const quando = dia + hora * 3_600_000 + entre(0, 59) * 60_000;
      if (quando > AGORA) continue;

      anotar(quando, "sessao-retomada", p.id, "", 0, p._plataforma);

      const canais = meuGrupo.categorias[0].canais;
      const texto = canais.find((c) => c.tipo === "texto");
      const voz = canais.filter((c) => c.tipo === "voz");

      for (let m = 0; m < entre(0, 5); m++) {
        const em = quando + m * 90_000 + entre(0, 60_000);
        if (em > AGORA) break;
        anotar(em, "mensagem", p.id, meuGrupo.codigo, 0, p._plataforma);
        mensagens.push({
          id: id(),
          canal: texto.id,
          autor: p.id,
          apelido: p.apelido,
          avatar: p.avatar,
          texto: escolher(FRASES),
          em: Math.round(em),
          editada_em: null,
          excluida: false,
          reacoes: {},
        });
      }

      if (sorte() < 0.34) {
        const canal = escolher(voz);
        const entrada = quando + entre(2, 20) * 60_000;
        const segundos = entre(4, 130) * 60;
        if (entrada + segundos * 1000 < AGORA) {
          // Por onde essa call passou. A distribuição imita o que a escada
          // de mídia produz na vida real: quase tudo pela nuvem, um punhado
          // de calls no servidor reserva e na malha nos dias em que a nuvem
          // vacilou — sem isso, a aba de mídia teria uma barra só e não
          // mostraria se o gráfico empilhado se lê.
          const meio = sorte() < 0.86 ? "nuvem" : sorte() < 0.6 ? "proprio" : "malha";
          if (meio !== "nuvem") {
            // Ninguém sai da nuvem por vontade própria: quem foi parar noutro
            // degrau, foi desviado — e o desvio é um acontecimento.
            anotar(entrada, "midia-falhou", p.id, canal.id, 0, p._plataforma, "nuvem");
          }
          anotar(entrada, "voz-entrou", p.id, canal.id, 0, p._plataforma, meio);
          if (sorte() < 0.25) anotar(entrada + 60_000, "transmissao", p.id, canal.id, 0, p._plataforma);
          anotar(entrada + segundos * 1000, "voz-saiu", p.id, canal.id, segundos, p._plataforma, meio);
        }
      }

      if (sorte() < 0.04) anotar(quando + 300_000, "feedback", p.id, escolher(["bug", "sugestao", "elogio"]), 0, p._plataforma);
    }

    delete p._idade;
    delete p._aderencia;
    delete p._plataforma;
    contas.push(p);
  }

  /* O dono usa todo dia, e é ele quem cria os grupos. */
  for (const g of grupos) anotar(g.criado, "grupo-criado", dono.id, g.codigo, 0, "windows");
  for (let d = 29; d >= 0; d--) {
    const quando = HOJE - d * DIA + entre(10, 23) * 3_600_000;
    if (quando > AGORA) continue;
    anotar(quando, "sessao-retomada", dono.id, "", 0, "windows");
    anotar(quando + 200_000, "mensagem", dono.id, grupos[0].codigo, 0, "windows");
  }

  eventos.sort((a, b) => a.em - b.em);
  mensagens.sort((a, b) => a.em - b.em);

  /* Relatos, para a aba de feedback não ficar vazia */
  const RELATOS = [
    ["bug", "O som do sistema não vai junto", "Quando transmito o Chrome, o vídeo vai mas o áudio não.", "recebido"],
    ["sugestao", "Poder fixar um canal", "Seria bom marcar um canal como favorito no topo da lista.", "aceito"],
    ["elogio", "Ficou muito melhor que o Discord", "Sério, o áudio é bem mais limpo. Parabéns.", "finalizado"],
    ["bug", "No iPhone a call cai ao trocar de app", "Se eu saio do Safari por uns 30s a call cai.", "em_andamento"],
  ];
  const feedback = {};
  RELATOS.forEach(([categoria, titulo, descricao, status], i) => {
    const quem = pessoas[i * 3];
    const em = HOJE - (i + 1) * 2 * DIA + 15 * 3_600_000;
    (feedback[quem.id] ??= []).push({
      id: id(),
      conta_id: quem.id,
      apelido: quem.apelido,
      categoria,
      titulo,
      descricao,
      status,
      criado_em: em,
      atualizado_em: em,
    });
  });

  const gravar = (nome, conteudo) => writeFileSync(join(PASTA, nome), conteudo);
  gravar("contas.json", JSON.stringify(contas));
  gravar("grupos.json", JSON.stringify(grupos.map(({ criado, ...g }) => g)));
  gravar("eventos.jsonl", eventos.map((e) => JSON.stringify(e)).join("\n") + "\n");
  gravar("mensagens.jsonl", mensagens.map((m) => JSON.stringify(m)).join("\n") + "\n");
  gravar("feedback.json", JSON.stringify(feedback));

  return { contas: contas.length, eventos: eventos.length, mensagens: mensagens.length, grupos: grupos.length };
}

/* ─── Andar ─────────────────────────────────────────────────────── */

if (!existsSync(BINARIO)) {
  console.error(`Falta o binário: ${BINARIO}\nRode antes:  cargo build --release -p sinalizacao`);
  process.exit(1);
}

const base = await nascerComHashDeVerdade();
const resumo = semear(base);

console.log(`
Semeado em ${PASTA}
  ${resumo.contas} contas · ${resumo.grupos} grupos · ${resumo.mensagens} mensagens · ${resumo.eventos} eventos
`);

if (process.argv.includes("--so-dados")) process.exit(0);

const servidor = spawn(BINARIO, [String(PORTA)], {
  stdio: "inherit",
  env: { ...process.env, DADOS: PASTA, ...AMBIENTE_DE_MIDIA },
});

console.log(`Servidor de pé em ws://127.0.0.1:${PORTA}

  1. noutro terminal:  node testes/ao-vivo.mjs
  2. abra:             http://127.0.0.1:8124/?servidor=ws://127.0.0.1:${PORTA}
  3. entre com:        ${DONO} / ${SENHA}

Ctrl+C encerra.`);

process.on("SIGINT", () => {
  servidor.kill();
  process.exit(0);
});
