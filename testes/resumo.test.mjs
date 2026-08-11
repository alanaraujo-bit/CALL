/**
 * Testes do cache de resumo de atividade.
 *
 *   node testes/resumo.test.mjs
 *
 * A busca de verdade é do Rust; o que se testa aqui é só a política de
 * quando perguntar de novo — o mesmo espírito de `atividade.test.mjs`.
 */

import { buscarResumoDeAtividade } from "../src/resumo.js";

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
  conferir(obtido === esperado, descricao, JSON.stringify(obtido));

console.log("\nQuando a busca acha algo");

{
  let chamadas = 0;
  const resumo = { titulo: "Rocket League", texto: "Um jogo de futebol com carros.", foto: null };
  const invocar = async () => {
    chamadas++;
    return resumo;
  };

  const primeira = await buscarResumoDeAtividade("Rocket League", invocar);
  igual(primeira, resumo, "a primeira busca devolve o que o Rust achou");
  igual(chamadas, 1, "e chamou o Rust uma vez");

  const segunda = await buscarResumoDeAtividade("Rocket League", invocar);
  igual(segunda, resumo, "a segunda busca devolve o mesmo resumo");
  igual(chamadas, 1, "sem perguntar ao Rust de novo — veio do cache");

  const maiuscula = await buscarResumoDeAtividade("ROCKET LEAGUE", invocar);
  igual(maiuscula, resumo, "maiúsculas e minúsculas acham o mesmo cache");
  igual(chamadas, 1, "ainda sem uma segunda chamada");
}

console.log("\nQuando a busca não acha nada");

{
  let chamadas = 0;
  const invocar = async () => {
    chamadas++;
    return null;
  };

  await buscarResumoDeAtividade("Programa Obscuro", invocar);
  igual(chamadas, 1, "a primeira tentativa pergunta ao Rust");

  await buscarResumoDeAtividade("Programa Obscuro", invocar);
  igual(chamadas, 2, "um resultado vazio não fica preso no cache — tenta de novo");
}

console.log("\nQuando a busca falha");

{
  let chamadas = 0;
  const invocar = async () => {
    chamadas++;
    throw new Error("comando indisponível");
  };

  const resultado = await buscarResumoDeAtividade("Qualquer Coisa Aqui", invocar);
  igual(resultado, null, "uma falha vira null, não uma exceção pra interface tratar");
  igual(chamadas, 1, "a tentativa aconteceu");

  await buscarResumoDeAtividade("Qualquer Coisa Aqui", invocar);
  igual(chamadas, 2, "e uma falha também não fica presa no cache");
}

console.log("\nCasos de borda");

{
  let chamadas = 0;
  const invocar = async () => {
    chamadas++;
    return { titulo: "x", texto: "x", foto: null };
  };

  igual(await buscarResumoDeAtividade("", invocar), null, "nome vazio não busca nada");
  igual(await buscarResumoDeAtividade("   ", invocar), null, "nome só de espaço também não");
  igual(chamadas, 0, "e o Rust nunca chegou a ser chamado");
}

{
  // Duas chamadas para o mesmo nome antes da primeira resolver não podem virar
  // duas buscas na rede — a segunda deve esperar a mesma promessa da primeira.
  let chamadas = 0;
  let liberar;
  const travada = new Promise((resolve) => {
    liberar = resolve;
  });
  const invocar = async () => {
    chamadas++;
    await travada;
    return { titulo: "Factorio", texto: "Uma fábrica que cresce sozinha.", foto: null };
  };

  const p1 = buscarResumoDeAtividade("Factorio", invocar);
  const p2 = buscarResumoDeAtividade("Factorio", invocar);
  liberar();
  const [r1, r2] = await Promise.all([p1, p2]);
  igual(chamadas, 1, "duas buscas simultâneas do mesmo nome viram uma chamada só");
  igual(r1.titulo, "Factorio", "e as duas recebem o mesmo resultado");
  igual(r2.titulo, "Factorio", "as duas, mesmo a que só esperou");
}

console.log("");
if (falhas === 0) {
  console.log("Resumo: todos os testes passaram.");
  process.exit(0);
}
console.log(`Resumo: ${falhas} falha(s).`);
process.exit(1);
