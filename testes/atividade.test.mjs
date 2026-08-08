/**
 * Testes da política de atividade.
 *
 *   node testes/atividade.test.mjs
 *
 * O Rust relata o que está em primeiro plano; o que se testa aqui é o que se
 * decide fazer com esse relato — que é onde moram as regras que podem
 * envergonhar alguém se estiverem erradas.
 */

import { nomeVisivel, Vigia, OCULTOS, ATIVIDADE_MAX } from "../src/atividade.js";

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

/* ─── O que se mostra ────────────────────────────────────────────── */

console.log("\nO que vira atividade visível");

igual(
  nomeVisivel({ exe: "rocketleague", nome: "Rocket League" }),
  "Rocket League",
  "um jogo aparece pelo nome"
);

// O caso que obriga a lista de ocultos a existir: o `explorer` é o dono da
// área de trabalho, então está em foco toda vez que nada mais está.
igual(
  nomeVisivel({ exe: "explorer", nome: "Windows Explorer" }),
  null,
  "a área de trabalho não é uma atividade"
);
igual(
  nomeVisivel({ exe: "applicationframehost", nome: "Application Frame Host" }),
  null,
  "as cascas do Windows não aparecem"
);
igual(nomeVisivel({ exe: "call", nome: "CALL" }), null, "o próprio CALL não aparece");

igual(nomeVisivel(null), null, "nada em foco não quebra");
igual(nomeVisivel({ exe: "", nome: "" }), null, "leitura vazia não vira linha em branco");
igual(nomeVisivel({ exe: "jogo", nome: "   " }), null, "nome só de espaço não vira atividade");

// A comparação com a lista é feita em minúsculas: o Rust já entrega assim,
// mas a regra não pode depender disso para valer.
igual(nomeVisivel({ exe: "EXPLORER", nome: "x" }), null, "a lista não depende de maiúsculas");

// Este texto vai para a tela de todo mundo do grupo. Um nome com quebra de
// linha ou caractere de controle estragaria a lista de participantes.
igual(
  nomeVisivel({ exe: "jogo", nome: "Meu\nJogo\tEstranho" }),
  "Meu Jogo Estranho",
  "controles viram espaço e não quebram a lista"
);
igual(
  nomeVisivel({ exe: "jogo", nome: "  Muitos    espaços  " }),
  "Muitos espaços",
  "espaço repetido é colapsado"
);

const gigante = nomeVisivel({ exe: "jogo", nome: "N".repeat(200) });
conferir(
  gigante.length === ATIVIDADE_MAX,
  "um nome absurdo é cortado no teto",
  `${gigante.length} caracteres`
);

conferir(OCULTOS.has("explorer"), "a lista de ocultos está montada");

/* ─── Programas cadastrados a mão ────────────────────────────────── */

console.log("\nQuando a pessoa cadastrou o programa a mão");

const cadastrados = new Map([["meujogo", { nome: "Meu Jogo Preferido" }]]);

igual(
  nomeVisivel({ exe: "meujogo", nome: "MeuJogo" }, cadastrados),
  "Meu Jogo Preferido",
  "o nome cadastrado substitui o nome bruto"
);
igual(
  nomeVisivel({ exe: "outrojogo", nome: "Outro" }, cadastrados),
  "Outro",
  "um exe sem cadastro segue a política normal"
);
igual(
  nomeVisivel({ exe: "explorer", nome: "Windows Explorer" }, new Map([["explorer", { nome: "Área de trabalho" }]])),
  "Área de trabalho",
  "um cadastro vale mesmo para um exe da lista de ocultos"
);
igual(
  nomeVisivel({ exe: "jogo", nome: "x" }, new Map([["jogo", { nome: "N".repeat(200) }]])).length,
  ATIVIDADE_MAX,
  "o nome cadastrado também é cortado no teto"
);

/* ─── A calma do anúncio ─────────────────────────────────────────── */

console.log("\nQuando o anúncio acontece");

/** Vigia com leitura controlada pelo teste e registro do que foi anunciado. */
function comLeitura(sequencia) {
  const anunciado = [];
  let i = 0;
  const vigia = new Vigia({
    ler: async () => sequencia[Math.min(i++, sequencia.length - 1)],
    aoMudar: (v) => anunciado.push(v),
  });
  return { vigia, anunciado };
}

const jogo = { exe: "jogo", nome: "Meu Jogo" };
const nave = { exe: "nave", nome: "Navegador" };

{
  // A regra central: um programa precisa aparecer duas vezes seguidas.
  // Alt-Tab de dois segundos não vira anúncio para o grupo inteiro.
  const { vigia, anunciado } = comLeitura([jogo, jogo, jogo]);
  igual(await vigia.olhar(), false, "a primeira leitura não anuncia nada");
  igual(await vigia.olhar(), true, "a segunda leitura seguida anuncia");
  igual(await vigia.olhar(), false, "e a terceira não repete o anúncio");
  igual(anunciado.join(","), "Meu Jogo", "só houve um anúncio");
}

{
  // Alt-Tab: o navegador aparece uma vez no meio do jogo e some.
  const { vigia, anunciado } = comLeitura([jogo, jogo, nave, jogo, jogo]);
  await vigia.olhar();
  await vigia.olhar(); // anuncia o jogo
  await vigia.olhar(); // navegador: candidato, ainda não
  await vigia.olhar(); // voltou ao jogo, que já era o anunciado
  await vigia.olhar();
  igual(anunciado.length, 1, "uma passada rápida por outro programa não vira anúncio");
  igual(vigia.atual, "Meu Jogo", "e o que estava no ar continua no ar");
}

{
  // Trocar de verdade: o novo programa fica e é anunciado.
  const { vigia, anunciado } = comLeitura([jogo, jogo, nave, nave]);
  await vigia.olhar();
  await vigia.olhar();
  await vigia.olhar();
  await vigia.olhar();
  igual(anunciado.join(" → "), "Meu Jogo → Navegador", "trocar de programa anuncia a troca");
}

{
  // Sair é imediato, e de propósito: deixar o nome velho na tela por até dois
  // intervalos seria afirmar algo que já não é verdade.
  const { vigia, anunciado } = comLeitura([jogo, jogo, null]);
  await vigia.olhar();
  await vigia.olhar();
  igual(await vigia.olhar(), true, "fechar tudo é anunciado na hora");
  igual(anunciado[1], null, "e o que se anuncia é a ausência");
}

{
  const { vigia, anunciado } = comLeitura([null, null]);
  await vigia.olhar();
  await vigia.olhar();
  igual(anunciado.length, 0, "sem nada em foco, nada é anunciado");
}

{
  // Fora do aplicativo o comando não existe. Uma falha de leitura não pode
  // derrubar nada nem apagar o que já estava anunciado.
  const anunciado = [];
  let falhar = false;
  const vigia = new Vigia({
    ler: async () => {
      if (falhar) throw new Error("comando indisponível");
      return jogo;
    },
    aoMudar: (v) => anunciado.push(v),
  });
  await vigia.olhar();
  await vigia.olhar();
  falhar = true;
  igual(await vigia.olhar(), false, "uma leitura que falha não anuncia");
  igual(vigia.atual, "Meu Jogo", "e não apaga o que já estava no ar");
}

{
  // Desligar o recurso tem de limpar a linha dos outros, e não congelar nela
  // o último programa usado.
  const { vigia, anunciado } = comLeitura([jogo, jogo]);
  await vigia.olhar();
  await vigia.olhar();
  vigia.desligar();
  igual(anunciado[1], null, "desligar anuncia a ausência");
  igual(vigia.atual, null, "e esquece o que estava no ar");

  // Desligar de novo não pode anunciar de novo.
  vigia.desligar();
  igual(anunciado.length, 2, "desligar duas vezes não anuncia duas vezes");
}

{
  // Ao cair a conexão não há a quem anunciar, e o socket já está indo embora.
  const { vigia, anunciado } = comLeitura([jogo, jogo]);
  await vigia.olhar();
  await vigia.olhar();
  vigia.desligar(false);
  igual(anunciado.length, 1, "desligar sem anunciar não fala na rede");
}

/* ─── O que alimenta o cadastro manual ───────────────────────────── */

console.log("\nO que a Vigia expõe para o cadastro manual");

{
  // O mapa de cadastrados é lido de novo a cada leitura: cadastrar um
  // programa novo com a Vigia já ligada tem efeito na próxima leitura, sem
  // precisar religar nada.
  const cadastrados = new Map();
  const anunciado = [];
  const vigia = new Vigia({
    ler: async () => ({ exe: "explorer", nome: "Windows Explorer" }),
    aoMudar: (v) => anunciado.push(v),
    personalizados: () => cadastrados,
  });
  await vigia.olhar();
  await vigia.olhar();
  igual(anunciado.length, 0, "sem cadastro, a área de trabalho continua oculta");

  cadastrados.set("explorer", { nome: "Área de trabalho" });
  await vigia.olhar(); // candidato
  await vigia.olhar(); // confirma, como qualquer outro programa
  igual(anunciado.join(""), "Área de trabalho", "o cadastro feito depois já vale, seguindo a mesma calma de sempre");
}

console.log("");
if (falhas === 0) {
  console.log("Atividade: todos os testes passaram.");
  process.exit(0);
}
console.log(`Atividade: ${falhas} falha(s).`);
process.exit(1);
