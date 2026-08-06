/**
 * Testes do servidor de sinalização.
 * Sobe o binário de verdade e exercita o protocolo com clientes reais — nada
 * de simulação: o que passa aqui é o que o aplicativo vai encontrar.
 *
 *   node testes/sinalizacao.test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARIO = "target/release/sinalizacao.exe";
const PASTA = mkdtempSync(join(tmpdir(), "call-testes-"));

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

let porta = 8899;

async function subirServidor() {
  porta++;
  const processo = spawn(BINARIO, [String(porta)], {
    stdio: "ignore",
    env: { ...process.env, DADOS: PASTA },
  });

  // Esperar a porta abrir, e não um tempo fixo: numa máquina ocupada o tempo
  // fixo é curto demais, e numa ociosa é tempo jogado fora.
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

/** Cliente de teste: guarda tudo que recebe e sabe esperar por um tipo. */
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
    ws,
    recebidas,
    enviar: (o) => ws.send(JSON.stringify(o)),
    do: (tipo) => recebidas.filter((m) => m.tipo === tipo),
    fechar: () => ws.close(),

    /**
     * Resolve com a próxima mensagem do tipo, ou `null` se ela não vier.
     *
     * Olha primeiro o que já chegou: o servidor costuma anunciar um fato a
     * vários clientes de uma vez, e esperar só pelo futuro faria o teste
     * perder o anúncio que chegou enquanto se esperava por outro.
     */
    aguardar(tipo, limite = 1500) {
      const pronta = recebidas.find((m) => m.tipo === tipo && !consumidas.has(m));
      if (pronta) {
        consumidas.add(pronta);
        return Promise.resolve(pronta);
      }

      return new Promise((resolver) => {
        const relogio = setTimeout(() => {
          const indice = ouvintes.findIndex((o) => o.resolver === entregar);
          if (indice >= 0) ouvintes.splice(indice, 1);
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

const canalPorTipo = (grupo, tipo) =>
  grupo.categorias.flatMap((c) => c.canais).find((c) => c.tipo === tipo);

/* ─── Bateria ───────────────────────────────────────────────────── */

let servidor = await subirServidor();
let codigo;
let canalTexto;
let canalVoz;

try {
  console.log("\nCriação de grupo");
  const ana = await cliente({
    tipo: "criar-grupo",
    nome: "Equipe de produto",
    apelido: "Ana",
    usuario: "ana-001",
  });
  const bemVindoAna = await ana.aguardar("bem-vindo");

  conferir(!!bemVindoAna, "quem cria recebe bem-vindo");
  conferir(bemVindoAna?.grupo?.nome === "Equipe de produto", "o nome do grupo volta como veio");
  conferir(bemVindoAna?.grupo?.codigo?.length === 10, "o convite tem dez caracteres");
  conferir(
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(bemVindoAna?.grupo?.codigo ?? ""),
    "o convite evita caracteres que se confundem"
  );
  conferir(bemVindoAna?.grupo?.dono === "ana-001", "quem cria fica registrado como dono");
  conferir(bemVindoAna?.presentes?.length === 0, "grupo novo chega vazio");

  const grupo = bemVindoAna.grupo;
  codigo = grupo.codigo;
  canalTexto = canalPorTipo(grupo, "texto");
  canalVoz = canalPorTipo(grupo, "voz");
  conferir(!!canalTexto && !!canalVoz, "grupo novo já vem com um canal de cada tipo");

  console.log("\nEntrada por convite");
  const bruno = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Bruno",
    usuario: "bruno-002",
  });
  const bemVindoBruno = await bruno.aguardar("bem-vindo");
  conferir(bemVindoBruno?.presentes?.length === 1, "quem entra vê quem já estava");
  conferir(bemVindoBruno?.presentes?.[0]?.apelido === "Ana", "o apelido do presente vem correto");
  conferir(
    bemVindoBruno?.grupo?.codigo === codigo,
    "quem entra recebe a mesma estrutura de grupo"
  );
  conferir((await ana.aguardar("entrou"))?.membro?.apelido === "Bruno", "a entrada é anunciada");

  const intruso = await cliente({
    tipo: "entrar",
    codigo: "ZZZZZZZZZZ",
    apelido: "Ninguém",
    usuario: "zzz-003",
  });
  conferir(!!(await intruso.aguardar("erro")), "convite inexistente é recusado");
  conferir((await intruso.aguardar("bem-vindo", 300)) === null, "e não admite ninguém");
  intruso.fechar();

  console.log("\nVoz por canal");
  ana.enviar({ tipo: "entrar-voz", canal: canalVoz.id });
  const vozAna = await ana.aguardar("voz");
  conferir(vozAna?.pares?.length === 0, "primeiro a entrar na voz encontra a sala vazia");

  bruno.enviar({ tipo: "entrar-voz", canal: canalVoz.id });
  const vozBruno = await bruno.aguardar("voz");
  conferir(vozBruno?.pares?.length === 1, "segundo a entrar recebe a lista de pares");
  const entrouVoz = await ana.aguardar("entrou-voz");
  conferir(entrouVoz?.membro?.apelido === "Bruno", "a entrada na voz é anunciada ao grupo");
  conferir(entrouVoz?.membro?.canalVoz === canalVoz.id, "o anúncio diz em qual canal");

  const idBruno = bemVindoBruno.eu.id;
  const idAna = bemVindoAna.eu.id;

  console.log("\nEncaminhamento de sinais");
  ana.enviar({ tipo: "sinal", para: idBruno, dados: { descricao: "oferta" } });
  const sinal = await bruno.aguardar("sinal");
  conferir(sinal?.dados?.descricao === "oferta", "o sinal chega ao destinatário");
  conferir(sinal?.de === idAna, "o sinal identifica o remetente");

  console.log("\nEstado de microfone e transmissão");
  bruno.enviar({ tipo: "estado", mudo: true, transmitindo: true });
  const estado = await ana.aguardar("estado");
  conferir(estado?.mudo === true && estado?.transmitindo === true, "o estado é propagado");
  conferir((await bruno.aguardar("estado", 300)) === null, "quem mudou não recebe o próprio eco");

  console.log("\nIsolamento entre canais de voz");
  bruno.enviar({ tipo: "sair-voz" });
  conferir(!!(await ana.aguardar("saiu-voz")), "a saída da voz é anunciada");
  ana.enviar({ tipo: "sinal", para: idBruno, dados: { descricao: "vazamento" } });
  conferir(
    (await bruno.aguardar("sinal", 400)) === null,
    "sinal para quem não está na mesma voz é descartado"
  );

  console.log("\nMensagens de texto");
  bruno.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "  bom dia  " });
  const paraAna = await ana.aguardar("mensagem");
  const paraBruno = await bruno.aguardar("mensagem");
  conferir(paraAna?.mensagem?.texto === "bom dia", "a mensagem chega aos outros, sem sobras");
  conferir(paraBruno?.mensagem?.id === paraAna?.mensagem?.id, "e volta para quem escreveu");
  conferir(paraAna?.mensagem?.autor === "bruno-002", "a autoria acompanha a mensagem");
  conferir(typeof paraAna?.mensagem?.em === "number", "a mensagem carrega o instante");

  bruno.enviar({ tipo: "mensagem", canal: canalVoz.id, texto: "aqui não" });
  conferir(!!(await bruno.aguardar("erro")), "canal de voz não aceita mensagem de texto");

  bruno.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "   " });
  conferir(
    (await ana.aguardar("mensagem", 400)) === null,
    "mensagem só de espaços não é difundida"
  );

  console.log("\nHistórico");
  const carla = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Carla",
    usuario: "carla-004",
  });
  await carla.aguardar("bem-vindo");
  carla.enviar({ tipo: "historico", canal: canalTexto.id });
  const historico = await carla.aguardar("historico");
  conferir(historico?.mensagens?.length === 1, "quem chega depois recebe o que já foi dito");
  conferir(historico?.mensagens?.[0]?.texto === "bom dia", "o histórico vem íntegro");

  console.log("\nEstrutura: só o dono altera");
  carla.enviar({ tipo: "criar-categoria", nome: "Invasão" });
  conferir(!!(await carla.aguardar("erro")), "quem não é dono não cria categoria");
  conferir(
    (await ana.aguardar("grupo", 400)) === null,
    "e a tentativa não difunde estrutura nenhuma"
  );

  ana.enviar({ tipo: "criar-categoria", nome: "Projetos" });
  const comCategoria = await bruno.aguardar("grupo");
  conferir(comCategoria?.grupo?.categorias?.length === 2, "o dono cria categoria");
  const projetos = comCategoria.grupo.categorias.find((c) => c.nome === "Projetos");

  ana.enviar({
    tipo: "criar-canal",
    categoria: projetos.id,
    nome: "lançamento",
    tipoCanal: "voz",
  });
  const comCanal = await bruno.aguardar("grupo");
  const novoCanal = comCanal.grupo.categorias
    .find((c) => c.id === projetos.id)
    ?.canais?.find((c) => c.nome === "lançamento");
  conferir(novoCanal?.tipo === "voz", "o dono cria canal do tipo pedido");

  ana.enviar({ tipo: "renomear", alvo: "canal", id: novoCanal.id, nome: "estreia" });
  const renomeado = await bruno.aguardar("grupo");
  conferir(
    renomeado?.grupo?.categorias
      ?.flatMap((c) => c.canais)
      ?.some((c) => c.id === novoCanal.id && c.nome === "estreia"),
    "renomear canal difunde a estrutura nova"
  );

  console.log("\nRemoção tira quem estava na voz do canal");
  carla.enviar({ tipo: "entrar-voz", canal: novoCanal.id });
  await carla.aguardar("voz");
  ana.enviar({ tipo: "remover", alvo: "canal", id: novoCanal.id });
  const semCanal = await bruno.aguardar("grupo");
  conferir(
    !semCanal.grupo.categorias.flatMap((c) => c.canais).some((c) => c.id === novoCanal.id),
    "o canal removido some da estrutura"
  );
  conferir(
    !!(await bruno.aguardar("saiu-voz")),
    "quem estava na voz do canal removido é retirado dela"
  );

  console.log("\nO grupo não fica sem chão");
  ana.enviar({ tipo: "remover", alvo: "categoria", id: projetos.id });
  await bruno.aguardar("grupo");
  ana.enviar({ tipo: "remover", alvo: "categoria", id: grupo.categorias[0].id });
  conferir(!!(await ana.aguardar("erro")), "a última categoria não pode ser removida");
  ana.enviar({ tipo: "remover", alvo: "canal", id: canalVoz.id });
  await bruno.aguardar("grupo");
  ana.enviar({ tipo: "remover", alvo: "canal", id: canalTexto.id });
  conferir(!!(await ana.aguardar("erro")), "o último canal não pode ser removido");

  console.log("\nSaída");
  bruno.fechar();
  conferir((await ana.aguardar("saiu"))?.id === idBruno, "a saída é anunciada aos demais");

  ana.fechar();
  carla.fechar();
  await esperar(200);
} finally {
  servidor.kill();
  await esperar(300);
}

/* ─── Persistência ──────────────────────────────────────────────── */

console.log("\nPersistência entre execuções");
conferir(existsSync(join(PASTA, "grupos.json")), "a estrutura é gravada em grupos.json");
conferir(existsSync(join(PASTA, "mensagens.jsonl")), "as mensagens vão para mensagens.jsonl");
conferir(
  !readFileSync(join(PASTA, "grupos.json"), "utf8").startsWith("﻿"),
  "o arquivo de grupos não sai com marca de ordem de bytes"
);

servidor = await subirServidor();
try {
  const ana = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Ana",
    usuario: "ana-001",
  });
  const devolta = await ana.aguardar("bem-vindo");
  conferir(!!devolta, "o grupo sobrevive ao fechamento do servidor");
  conferir(devolta?.grupo?.nome === "Equipe de produto", "com o nome que tinha");
  conferir(devolta?.grupo?.dono === "ana-001", "e com o mesmo dono");

  ana.enviar({ tipo: "historico", canal: canalTexto.id });
  const historico = await ana.aguardar("historico");
  conferir(historico?.mensagens?.[0]?.texto === "bom dia", "o histórico também sobrevive");

  ana.fechar();
  await esperar(200);
} finally {
  servidor.kill();
  await esperar(200);
  rmSync(PASTA, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nTodos os testes passaram.\n" : `\n${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
