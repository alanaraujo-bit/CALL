/**
 * Testes do tempo em call e do histórico de quem passou por ela.
 *
 *   node testes/tempo.test.mjs
 *
 * O relógio é injetado, então uma call de duas horas custa o mesmo que uma de
 * dois segundos e o resultado não depende da máquina estar ocupada.
 */

import { relogio, tempoCurto, HistoricoDaCall } from "../src/tempo.js";

let falhas = 0;
function conferir(condicao, descricao, medida) {
  if (condicao) {
    console.log(`  ok    ${descricao}${medida ? `  [${medida}]` : ""}`);
  } else {
    falhas++;
    console.log(`  FALHA ${descricao}${medida ? `  [${medida}]` : ""}`);
  }
}
const igual = (obtido, esperado, descricao) =>
  conferir(obtido === esperado, descricao, `${JSON.stringify(obtido)}`);

const s = 1000;
const min = 60 * s;
const h = 60 * min;

/* ─── O relógio do rodapé ────────────────────────────────────────── */

console.log("\nRelógio do rodapé");

igual(relogio(0), "00:00", "a call começa em 00:00");
igual(relogio(9 * s), "00:09", "os segundos têm dois dígitos");
igual(relogio(59 * s), "00:59", "o último segundo antes do minuto");
igual(relogio(min), "01:00", "vira o minuto");
igual(relogio(59 * min + 59 * s), "59:59", "o último segundo antes da hora");
igual(relogio(h), "1:00:00", "a hora aparece só quando existe");
igual(relogio(2 * h + 3 * min + 4 * s), "2:03:04", "horas, minutos e segundos");

// Truncar, e não arredondar: aos 1,9 s o rodapé mostra 1, como um cronômetro.
// Arredondar mostraria 2 antes de os dois segundos terem passado.
igual(relogio(1900), "00:01", "trunca os milissegundos em vez de arredondar");

// O relógio do sistema pode andar para trás — sincronização de horário, ou a
// máquina saindo de suspensão. Um tempo negativo não pode virar "-1:-1".
igual(relogio(-5000), "00:00", "tempo negativo não vira lixo na tela");

/* ─── A duração no histórico ─────────────────────────────────────── */

console.log("\nDuração no histórico");

igual(tempoCurto(0), "0 s", "zero é zero");
igual(tempoCurto(45 * s), "45 s", "abaixo de um minuto, segundos");
igual(tempoCurto(90 * s), "2 min", "um minuto e meio arredonda para 2 min");
igual(tempoCurto(45 * min), "45 min", "abaixo de uma hora, minutos");
igual(tempoCurto(h), "1 h 00", "uma hora certa");
igual(tempoCurto(2 * h + 5 * min), "2 h 05", "os minutos da hora têm dois dígitos");

/* ─── O histórico ────────────────────────────────────────────────── */

console.log("\nHistórico de quem esteve na call");

/** Relógio de mentira: o teste diz que horas são. */
function comRelogio() {
  let agora = 0;
  const historico = new HistoricoDaCall(() => agora);
  return { historico, avancar: (ms) => (agora += ms), quando: () => agora };
}

{
  const { historico, avancar } = comRelogio();
  historico.comecar();
  conferir(historico.lista().length === 0, "uma call nova não tem histórico");

  historico.entrou("a", true);
  avancar(5 * min);
  conferir(historico.lista().length === 0, "quem está presente não está no histórico");

  historico.saiu("a", { usuario: "u-ana", apelido: "Ana" });
  const [ana] = historico.lista();
  conferir(historico.lista().length === 1, "quem sai entra no histórico");
  igual(ana.apelido, "Ana", "o apelido é guardado");
  igual(tempoCurto(ana.tempo), "5 min", "o tempo é o que a pessoa ficou");
  conferir(ana.exato, "quem chegou na sua frente tem tempo exato");
}

{
  // O caso que o desenho existe para não mentir: quem já estava na call.
  const { historico, avancar } = comRelogio();
  historico.comecar();
  historico.entrou("b", false);
  avancar(3 * min);
  historico.saiu("b", { usuario: "u-bruno", apelido: "Bruno" });

  const [bruno] = historico.lista();
  conferir(!bruno.exato, "quem já estava na call fica marcado como inexato");
  igual(tempoCurto(bruno.tempo), "3 min", "e o tempo dele é o que se observou");
}

{
  // Sair e voltar não pode virar duas linhas para a mesma pessoa.
  const { historico, avancar } = comRelogio();
  historico.comecar();
  historico.entrou("c1", true);
  avancar(4 * min);
  historico.saiu("c1", { usuario: "u-caio", apelido: "Caio" });
  avancar(min);
  // Voltar dá outro `id` de sessão, mas é o mesmo `usuario`.
  historico.entrou("c2", true);
  avancar(6 * min);
  historico.saiu("c2", { usuario: "u-caio", apelido: "Caio" });

  const lista = historico.lista();
  igual(lista.length, 1, "quem sai e volta ocupa uma linha só");
  igual(tempoCurto(lista[0].tempo), "10 min", "e os tempos das duas passagens somam");
}

{
  // Somar um piso com um valor certo dá outro piso, e não um total.
  const { historico, avancar } = comRelogio();
  historico.comecar();
  historico.entrou("d1", false);
  avancar(2 * min);
  historico.saiu("d1", { usuario: "u-duda", apelido: "Duda" });
  historico.entrou("d2", true);
  avancar(2 * min);
  historico.saiu("d2", { usuario: "u-duda", apelido: "Duda" });

  conferir(!historico.lista()[0].exato, "uma passagem inexata contamina o total");
}

{
  const { historico, avancar } = comRelogio();
  historico.comecar();
  historico.entrou("e", true);
  avancar(min);
  historico.entrou("f", true);
  avancar(min);
  historico.saiu("e", { usuario: "u-eva", apelido: "Eva" });
  avancar(min);
  historico.saiu("f", { usuario: "u-fabio", apelido: "Fábio" });

  igual(
    historico.lista().map((p) => p.apelido).join(", "),
    "Fábio, Eva",
    "a lista vem do mais recente para o mais antigo"
  );
}

{
  // Um `saiu-voz` de quem nunca foi anunciado — de outro canal, ou repetido
  // — não pode inventar uma linha de zero segundo na coluna.
  const { historico } = comRelogio();
  historico.comecar();
  historico.saiu("fantasma", { usuario: "u-x", apelido: "Ninguém" });
  igual(historico.lista().length, 0, "sair sem ter entrado não cria linha");

  historico.entrou("g", true);
  historico.saiu("g", { usuario: "u-gil", apelido: "Gil" });
  historico.saiu("g", { usuario: "u-gil", apelido: "Gil" });
  igual(historico.lista().length, 1, "um aviso de saída repetido não duplica");
}

{
  // Trocar de canal de voz é entrar em outra call: o histórico não vaza.
  const { historico, avancar } = comRelogio();
  historico.comecar();
  historico.entrou("h", true);
  avancar(min);
  historico.saiu("h", { usuario: "u-hugo", apelido: "Hugo" });
  igual(historico.lista().length, 1, "há histórico na primeira call");

  historico.comecar();
  igual(historico.lista().length, 0, "trocar de call limpa o histórico");
}

console.log("");
if (falhas === 0) {
  console.log("Tempo em call: todos os testes passaram.");
  process.exit(0);
}
console.log(`Tempo em call: ${falhas} falha(s).`);
process.exit(1);
