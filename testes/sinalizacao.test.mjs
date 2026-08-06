/**
 * Testes do servidor de sinalização.
 * Sobe o binário em uma porta livre e exercita o protocolo com clientes reais.
 *
 *   node testes/sinalizacao.test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";

const PORTA = 8899;
const BINARIO = "target/release/sinalizacao.exe";

let falhas = 0;
function conferir(condicao, descricao) {
  if (condicao) {
    console.log(`  ok   ${descricao}`);
  } else {
    falhas++;
    console.log(`  FALHA ${descricao}`);
  }
}

/** Cliente de teste que guarda tudo que recebe. */
function cliente(sala, apelido) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORTA}`);
  const recebidas = [];
  ws.addEventListener("message", (e) => recebidas.push(JSON.parse(e.data)));
  const pronto = new Promise((resolver) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ tipo: "entrar", sala, apelido }));
      resolver();
    });
  });
  return {
    ws,
    recebidas,
    pronto,
    enviar: (o) => ws.send(JSON.stringify(o)),
    do: (tipo) => recebidas.filter((m) => m.tipo === tipo),
    fechar: () => ws.close(),
  };
}

const servidor = spawn(BINARIO, [String(PORTA)], { stdio: "ignore" });
await esperar(600);

try {
  console.log("\nProtocolo de sala");
  const ana = cliente("equipe", "Ana");
  await ana.pronto;
  await esperar(200);

  const bemVindoAna = ana.do("bem-vindo")[0];
  conferir(!!bemVindoAna, "primeiro participante recebe bem-vindo");
  conferir(bemVindoAna?.pares.length === 0, "sala nova chega vazia");
  conferir(bemVindoAna?.sala === "equipe", "sala é devolvida normalizada");

  const bruno = cliente("equipe", "Bruno");
  await bruno.pronto;
  await esperar(250);

  const bemVindoBruno = bruno.do("bem-vindo")[0];
  conferir(bemVindoBruno?.pares.length === 1, "segundo participante vê quem já estava");
  conferir(bemVindoBruno?.pares[0].apelido === "Ana", "apelido do par vem correto");
  conferir(ana.do("entrou")[0]?.apelido === "Bruno", "quem já estava é avisado da entrada");

  console.log("\nEncaminhamento de sinais");
  ana.enviar({ tipo: "sinal", para: bemVindoBruno.id, dados: { descricao: "oferta" } });
  await esperar(200);
  const sinalRecebido = bruno.do("sinal")[0];
  conferir(sinalRecebido?.dados?.descricao === "oferta", "sinal chega ao destinatário");
  conferir(sinalRecebido?.de === bemVindoAna.id, "sinal identifica o remetente");

  console.log("\nEstado de microfone e transmissão");
  bruno.enviar({ tipo: "estado", mudo: true, transmitindo: true });
  await esperar(200);
  const estado = ana.do("estado")[0];
  conferir(estado?.mudo === true && estado?.transmitindo === true, "estado é propagado");
  conferir(bruno.do("estado").length === 0, "quem mudou não recebe o próprio eco");

  console.log("\nIsolamento entre salas");
  const carla = cliente("outra-equipe", "Carla");
  await carla.pronto;
  await esperar(250);
  conferir(carla.do("bem-vindo")[0]?.pares.length === 0, "sala diferente não enxerga a outra");
  conferir(ana.do("entrou").length === 1, "entrada em outra sala não vaza");

  const idCarla = carla.do("bem-vindo")[0].id;
  const antes = carla.do("sinal").length;
  ana.enviar({ tipo: "sinal", para: idCarla, dados: { descricao: "vazamento" } });
  await esperar(200);
  conferir(carla.do("sinal").length === antes, "sinal entre salas é descartado");

  console.log("\nSaída");
  bruno.fechar();
  await esperar(300);
  conferir(ana.do("saiu")[0]?.id === bemVindoBruno.id, "saída é anunciada aos demais");

  console.log("\nEstado tardio de quem chega");
  const diego = cliente("equipe", "Diego");
  await diego.pronto;
  await esperar(200);
  ana.enviar({ tipo: "estado", mudo: true, transmitindo: false });
  await esperar(200);
  const visaoDiego = diego.do("estado")[0];
  conferir(visaoDiego?.mudo === true, "novo participante recebe mudanças de estado");

  ana.fechar();
  carla.fechar();
  diego.fechar();
  await esperar(200);
} finally {
  servidor.kill();
}

console.log(falhas === 0 ? "\nTodos os testes passaram.\n" : `\n${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
