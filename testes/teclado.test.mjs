/**
 * Testes do rastreador de teclado do celular (`movel/interacao.js`).
 *
 *   node testes/teclado.test.mjs
 *
 * O bug que isso pega: a barra do Safari entrando/saindo de cena encolhe a
 * `visualViewport` do mesmo jeito que o teclado — sem a guarda de foco, o
 * rodapé (`.app`, `.folha`, `.portal`) sobe achando que há teclado, e sobra
 * um vão embaixo onde a barra costumava estar. Foi o que apareceu no
 * cadastro, no iPhone 16, sem teclado nenhum na tela.
 */

import { medirTeclado, chamaTeclado } from "../movel/interacao.js";

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
  conferir(obtido === esperado, descricao, `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

/* ─── A barra do Safari não é teclado ────────────────────────────── */

console.log("\nBarra do navegador some, mas ninguém digita");

igual(
  medirTeclado({ innerHeight: 844, alturaVisivel: 761, topoVisivel: 0, temFoco: false }),
  0,
  "83px de barra escondida sem campo em foco não vira --teclado"
);

igual(
  medirTeclado({ innerHeight: 844, alturaVisivel: 800, topoVisivel: 44, temFoco: false }),
  0,
  "offsetTop de rolagem também não conta sem foco"
);

/* ─── O teclado de verdade continua funcionando ──────────────────── */

console.log("\nTeclado de verdade, com um campo em foco");

igual(
  medirTeclado({ innerHeight: 844, alturaVisivel: 484, topoVisivel: 0, temFoco: true }),
  360,
  "teclado de 360px é medido igual quando há foco"
);

igual(
  medirTeclado({ innerHeight: 844, alturaVisivel: 844, topoVisivel: 0, temFoco: true }),
  0,
  "campo em foco mas teclado fechado ainda dá zero"
);

igual(
  medirTeclado({ innerHeight: 844, alturaVisivel: 900, topoVisivel: 0, temFoco: true }),
  0,
  "nunca fica negativo mesmo com medida ruidosa"
);

/* ─── Quais elementos chamam teclado ─────────────────────────────── */

console.log("\nQuem chama teclado e quem não chama");

igual(chamaTeclado(null), false, "nada em foco não chama teclado");
igual(chamaTeclado({ tagName: "INPUT", type: "email" }), true, "input de e-mail chama teclado");
igual(chamaTeclado({ tagName: "INPUT", type: "password" }), true, "input de senha chama teclado");
igual(chamaTeclado({ tagName: "TEXTAREA" }), true, "textarea chama teclado");
igual(chamaTeclado({ tagName: "INPUT", type: "checkbox" }), false, "checkbox não chama teclado");
igual(chamaTeclado({ tagName: "INPUT", type: "radio" }), false, "radio (mascote) não chama teclado");
igual(chamaTeclado({ tagName: "BUTTON" }), false, "botão (Criar conta, abas) não chama teclado");
igual(chamaTeclado({ tagName: "BODY" }), false, "nada focado de propósito (body) não chama teclado");

console.log(falhas === 0 ? "\nTudo certo.\n" : `\n${falhas} falha(s).\n`);
process.exit(falhas === 0 ? 0 : 1);
