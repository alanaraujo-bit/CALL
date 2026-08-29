/**
 * Testes da central de comando — o painel do dono.
 *
 * Sobe o binário de verdade e conversa com ele pelo mesmo socket que o
 * aplicativo usa. Não há simulação de servidor nem de banco: o que passa
 * aqui é o que o painel vai encontrar em produção.
 *
 * O que estes testes existem para provar, em ordem de importância:
 *
 *   1. **A porta é fechada.** Uma conta comum não abre o painel, um token
 *      inventado não abre o painel, e ninguém vira administrador se
 *      cadastrando. Um painel administrativo que vaza é pior do que não
 *      existir.
 *   2. **Os números vêm de acontecimentos reais.** Criar conta, mandar
 *      mensagem e passar pela voz têm que aparecer no retrato — e a
 *      duração da call tem que ser medida, não inventada.
 *   3. **É ao vivo de verdade.** O acontecimento chega empurrado a quem
 *      está com o painel aberto, sem ninguém pedir de novo.
 *
 *   node testes/painel.test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARIO = "target/release/sinalizacao.exe";
const PASTA = mkdtempSync(join(tmpdir(), "call-painel-"));
const DONO = "dona@exemplo.com";
const SENHA = "segredo-bom-1";

let falhas = 0;
function conferir(condicao, descricao) {
  if (condicao) {
    console.log(`  ok   ${descricao}`);
  } else {
    falhas++;
    console.log(`  FALHA ${descricao}`);
  }
}

/* ─── Apoio ─────────────────────────────────────────────────────── */

const porta = 8931;

async function subirServidor() {
  const processo = spawn(BINARIO, [String(porta)], {
    stdio: "ignore",
    // É aqui que se diz quem manda. O binário não tem administrador algum
    // costurado por dentro para o teste: ele lê o ambiente, igual em
    // produção.
    env: { ...process.env, DADOS: PASTA, ADMIN_EMAILS: DONO },
  });

  for (let tentativa = 0; tentativa < 60; tentativa++) {
    try {
      const sonda = new WebSocket(`ws://127.0.0.1:${porta}`);
      await new Promise((ok, falhou) => {
        sonda.addEventListener("open", ok, { once: true });
        sonda.addEventListener("error", falhou, { once: true });
      });
      sonda.close();
      return processo;
    } catch {
      await esperar(50);
    }
  }
  throw new Error("o servidor não abriu a porta");
}

async function cliente(saudacao) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}`);
  const recebidas = [];
  const ouvintes = [];
  const consumidas = new Set();

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    recebidas.push(msg);
    const ouvinte = ouvintes.find((o) => o.tipo === msg.tipo);
    if (ouvinte) {
      ouvintes.splice(ouvintes.indexOf(ouvinte), 1);
      consumidas.add(msg);
      ouvinte.resolver(msg);
    }
  });

  await new Promise((ok, falhou) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", falhou, { once: true });
  });

  const eu = {
    enviar: (o) => ws.send(JSON.stringify(o)),
    do: (tipo) => recebidas.filter((m) => m.tipo === tipo),
    fechar: () => ws.close(),

    aguardar(tipo, limite = 2500) {
      const pronta = recebidas.find((m) => m.tipo === tipo && !consumidas.has(m));
      if (pronta) {
        consumidas.add(pronta);
        return Promise.resolve(pronta);
      }
      return new Promise((resolver) => {
        const relogio = setTimeout(() => {
          const i = ouvintes.findIndex((o) => o.resolver === entregar);
          if (i >= 0) ouvintes.splice(i, 1);
          resolver(null);
        }, limite);
        const entregar = (msg) => {
          clearTimeout(relogio);
          resolver(msg);
        };
        ouvintes.push({ tipo, resolver: entregar });
      });
    },
  };

  if (saudacao) eu.enviar(saudacao);
  return eu;
}

/** Cria uma conta e devolve o token e o resumo dela. */
async function cadastrar(email, apelido) {
  const c = await cliente(null);
  c.enviar({ tipo: "cadastrar", email, senha: SENHA, apelido, avatar: "coruja", plataforma: "windows" });
  const sessao = await c.aguardar("sessao", 6000);
  c.fechar();
  return sessao;
}

/** Pede o retrato pelo socket dado e devolve o painel (ou `null`). */
async function pedirPainel(quem, token) {
  quem.enviar({ tipo: "admin-painel", token, fuso: new Date().getTimezoneOffset() });
  const resposta = await quem.aguardar("admin-painel", 6000);
  return resposta?.painel ?? null;
}

/* ─── Os testes ─────────────────────────────────────────────────── */

const servidor = await subirServidor();

try {
  console.log("\nA porta");

  const dona = await cadastrar(DONO, "Dona");
  const alheia = await cadastrar("outra@exemplo.com", "Outra");
  conferir(dona?.conta?.admin === true, "a conta do e-mail configurado se anuncia como dona");
  conferir(alheia?.conta?.admin === false, "e qualquer outra conta, não");

  const intruso = await cliente(null);
  intruso.enviar({ tipo: "admin-painel", token: alheia.token, fuso: 180 });
  conferir(
    (await intruso.aguardar("admin-negado"))?.motivo?.length > 0,
    "uma conta comum é recusada, com uma resposta e não um silêncio"
  );
  conferir(intruso.do("admin-painel").length === 0, "e não recebe retrato nenhum junto");

  intruso.enviar({ tipo: "admin-painel", token: "token-inventado-do-nada", fuso: 180 });
  await intruso.aguardar("admin-negado");
  conferir(intruso.do("admin-painel").length === 0, "um token inventado também não abre o painel");

  intruso.enviar({ tipo: "admin-feedback", token: alheia.token, id: "qualquer", status: "finalizado" });
  conferir(
    (await intruso.aguardar("admin-negado"))?.motivo?.length > 0,
    "e mexer no status de um relato pede a mesma prova"
  );
  intruso.fechar();

  console.log("\nO retrato");

  const painelAberto = await cliente(null);
  const retrato = await pedirPainel(painelAberto, dona.token);
  conferir(retrato !== null, "a conta dona recebe o retrato");
  conferir(retrato?.dono?.email === DONO, "que diz de quem ele é");
  conferir(retrato?.serie?.length === 30, "com trinta dias de série, mesmo num servidor recém-nascido");
  conferir(retrato?.janelas?.novosHoje === 2, "as duas contas criadas contam como novas de hoje");
  conferir(retrato?.janelas?.dau === 2, "e as duas como ativas hoje");
  conferir(retrato?.totais?.contas === 2, "o total de contas bate");
  conferir(
    retrato?.pessoas?.some((p) => p.email === DONO) && retrato?.pessoas?.some((p) => p.email === "outra@exemplo.com"),
    "as duas aparecem na lista de pessoas"
  );
  conferir(retrato?.funil?.criaram === 2, "o funil parte de quem criou conta");
  conferir(retrato?.funil?.entraramEmGrupo === 0, "e ninguém entrou em grupo nenhum ainda");
  conferir(Array.isArray(retrato?.horarios) && retrato.horarios.length === 168, "o mapa de horários tem 7×24 casas");
  conferir(typeof retrato?.agora?.conexoes === "number", "e o instante vem junto, direto da memória do servidor");

  console.log("\nOs números saem de acontecimentos reais");

  // Alguém entra num grupo, escreve, e passa pela voz.
  const ana = await cliente({
    tipo: "criar-grupo",
    nome: "Time",
    apelido: "Outra",
    token: alheia.token,
    plataforma: "movel",
  });
  const bemVindo = await ana.aguardar("bem-vindo", 6000);
  const grupo = bemVindo?.grupo;
  const canalTexto = grupo?.categorias?.flatMap((c) => c.canais).find((c) => c.tipo === "texto");
  const canalVoz = grupo?.categorias?.flatMap((c) => c.canais).find((c) => c.tipo === "voz");
  conferir(!!canalTexto && !!canalVoz, "o grupo nasce com um canal de texto e um de voz");

  ana.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "primeira" });
  await ana.aguardar("mensagem", 3000);

  ana.enviar({ tipo: "entrar-voz", canal: canalVoz.id, transportes: [] });
  await ana.aguardar("voz", 3000);
  // Uma passagem curta pela call, mas com duração medida de verdade: é o
  // relógio do servidor entre a entrada e a saída, e não um número fixo.
  await esperar(1200);
  ana.enviar({ tipo: "sair-voz" });
  await esperar(400);

  const depois = await pedirPainel(painelAberto, dona.token);
  conferir(depois?.funil?.entraramEmGrupo === 1, "entrar num grupo move o funil");
  conferir(depois?.funil?.mandaramMensagem === 1, "escrever move o degrau seguinte");
  conferir(depois?.funil?.entraramNaVoz === 1, "e a voz move o último");
  conferir(depois?.janelas?.mensagensHoje === 1, "a mensagem entra na contagem do dia");
  conferir(
    depois?.grupos?.some((g) => g.codigo === grupo.codigo && g.mensagens === 1),
    "e o grupo aparece com a mensagem que recebeu"
  );
  conferir(
    depois?.plataformas?.some((p) => p.nome === "movel") && depois?.plataformas?.some((p) => p.nome === "windows"),
    "as duas cascas usadas aparecem separadas"
  );

  const passagem = (depois?.ultimos ?? []).find((e) => e.tipo === "voz-saiu");
  conferir(!!passagem, "a saída da call vira acontecimento");
  conferir(passagem?.valor >= 1, `com a duração medida (${passagem?.valor}s), e não zero`);

  const quemEscreveu = depois?.pessoas?.find((p) => p.email === "outra@exemplo.com");
  conferir(quemEscreveu?.mensagens === 1, "a linha da pessoa mostra a mensagem dela");
  conferir(quemEscreveu?.diasAtivos === 1, "e um dia ativo");

  console.log("\nAo vivo");

  // O painel continua aberto desde o pedido anterior — nenhuma assinatura
  // extra foi feita, de propósito: abrir o painel já é assinar.
// A fila já tem os acontecimentos empurrados desde que o painel abriu —
  // `aguardar` entregaria o primeiro deles, e não o que este teste provocou.
  // Procurar pelo que se espera é o que separa "chegou algo" de "chegou isto".
  const antes = painelAberto.do("admin-evento").length;
  ana.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "segunda" });

  let empurrado = null;
  const ateQuando = Date.now() + 3000;
  while (Date.now() < ateQuando && !empurrado) {
    empurrado = painelAberto
      .do("admin-evento")
      .slice(antes)
      .find((m) => m.evento?.tipo === "mensagem");
    if (!empurrado) await esperar(25);
  }
  conferir(!!empurrado, "o acontecimento chega sozinho a quem está com o painel aberto");
  conferir(typeof empurrado?.pulso?.conexoes === "number", "junto do retrato do instante");

  const pulso = await painelAberto.aguardar("admin-pulso", 8000);
  conferir(!!pulso, "e o pulso chega sozinho, sem ninguém pedir");
  conferir(
    pulso?.presentes?.some((p) => p.grupo === "Time"),
    "com quem está conectado, no grupo em que está"
  );

  console.log("\nFeedback pelo painel");

  const relator = await cliente(null);
  relator.enviar({
    tipo: "feedback-enviar",
    token: alheia.token,
    categoria: "bug",
    titulo: "Um problema",
    descricao: "Descrição do problema.",
  });
  const enviado = await relator.aguardar("feedback-enviado", 3000);
  conferir(!!enviado?.feedback?.id, "o relato é aceito");
  conferir(
    (await painelAberto.aguardar("admin-feedback-novo", 3000))?.feedback?.id === enviado.feedback.id,
    "e aparece no painel aberto sem recarregar"
  );

  painelAberto.enviar({
    tipo: "admin-feedback",
    token: dona.token,
    id: enviado.feedback.id,
    status: "em_andamento",
  });
  const avisado = await relator.aguardar("feedback-atualizado", 3000);
  conferir(avisado?.feedback?.status === "em_andamento", "mudar o status pelo painel avisa o autor na hora");
  relator.fechar();

  console.log("\nO histórico sobrevive ao servidor");

  ana.fechar();
  painelAberto.fechar();
  await esperar(300);
  servidor.kill();
  await esperar(500);

  const denovo = await subirServidor();
  try {
    const voltou = await cliente(null);
    const retomado = await pedirPainel(voltou, dona.token);
    conferir(retomado?.totais?.contas === 2, "as contas voltam depois do reinício");
    conferir(retomado?.funil?.mandaramMensagem === 1, "e o funil também — os eventos não vivem só na memória");
    conferir(
      (retomado?.ultimos ?? []).some((e) => e.tipo === "voz-saiu" && e.valor >= 1),
      "inclusive a duração da call que aconteceu antes de o servidor cair"
    );
    voltou.fechar();
    await esperar(200);
  } finally {
    denovo.kill();
  }
} finally {
  servidor.kill();
  await esperar(200);
  rmSync(PASTA, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nTodos os testes passaram.\n" : `\n${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
