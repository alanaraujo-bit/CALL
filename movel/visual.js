/**
 * Peças visuais compartilhadas: retratos, texto com emoji, seletor de emoji e
 * as pílulas de reação.
 *
 * Existe para que "um avatar do CALL" seja uma coisa só no aplicativo inteiro.
 * O desenho dos mascotes e das marcas de grupo vem de `avatares.js`, o mesmo
 * arquivo que o CALL de mesa usa — os seis bichos são os mesmos, no mesmo
 * traço, nas duas telas.
 */

import { pintarAvatar, pintarMarcaDeGrupo } from "../src/avatares.js";
import {
  CATEGORIAS_EMOJI,
  TODOS_EMOJIS,
  TOKEN_EMOJI,
  elementoDeEmoji,
} from "../src/emojis.js";
import { el, limpar, vibrar, abrirFolha } from "./interacao.js";

/* ═══ Retratos ══════════════════════════════════════════════════ */

/** O retrato de uma pessoa: foto, mascote ou iniciais, nesta ordem. */
export function avatar(pessoa, classe = "avatar") {
  const no = el("span", { class: classe });
  pintarAvatar(no, pessoa ?? {});
  return no;
}

/** O mesmo retrato com a bolinha de presença embaixo. */
export function avatarComPresenca(pessoa, estadoDaPresenca, classe = "avatar") {
  const no = avatar(pessoa, classe);
  no.append(el("span", { class: "presenca", dataset: { estado: estadoDaPresenca } }));
  return no;
}

/** A marca de um grupo: foto quadrada de canto macio, ou as iniciais. */
export function marcaDeGrupo(grupo, classe = "marca-grupo") {
  const no = el("span", { class: classe });
  pintarMarcaDeGrupo(no, grupo ?? { nome: "", foto: "" });
  return no;
}

/* ═══ Texto com emoji ═══════════════════════════════════════════ */

/**
 * Troca todo `:id:` de emoji próprio do CALL pelo desenho, e deixa o resto
 * como texto puro.
 *
 * Nunca `innerHTML`: o que a outra pessoa escreveu entra por `append` de
 * string, que cria nó de texto. É a diferença entre um chat e um vetor de
 * injeção.
 */
export function textoComEmoji(elemento, texto) {
  limpar(elemento);
  TOKEN_EMOJI.lastIndex = 0;

  // Uma mensagem que é só emoji vira desenho grande — como em qualquer app de
  // conversa, e pela mesma razão: ali o emoji é a mensagem, não um tempero.
  const soEmoji = /^\s*(:[a-z0-9_-]+:\s*){1,3}$/i.test(texto) && TOKEN_EMOJI.test(texto);
  TOKEN_EMOJI.lastIndex = 0;

  let ultimo = 0;
  let achado;
  while ((achado = TOKEN_EMOJI.exec(texto))) {
    if (achado.index > ultimo) elemento.append(texto.slice(ultimo, achado.index));
    elemento.append(elementoDeEmoji(achado[1], soEmoji ? "emoji emoji--so" : "emoji"));
    ultimo = TOKEN_EMOJI.lastIndex;
  }
  if (ultimo < texto.length) elemento.append(texto.slice(ultimo));
  return elemento;
}

/* ═══ Seletor de emoji ══════════════════════════════════════════ */

/**
 * A folha de emoji.
 *
 * As categorias viram uma fita horizontal, e não abas fixas: são nove, e nove
 * abas numa tela de 360 px viram nove alvos de 40 px que ninguém acerta. A
 * fita rola, e a categoria escolhida se centraliza sozinha.
 */
export function abrirEmojis(aoEscolher, { titulo = "Emoji" } = {}) {
  let categoriaAtual = CATEGORIAS_EMOJI[0].id ?? 0;

  const grade = el("div", { class: "emojis__grade" });
  const fita = el("div", { class: "emojis__categorias" });

  const desenharGrade = () => {
    limpar(grade);
    const categoria =
      CATEGORIAS_EMOJI.find((c) => (c.id ?? CATEGORIAS_EMOJI.indexOf(c)) === categoriaAtual) ??
      CATEGORIAS_EMOJI[0];
    const fragmento = document.createDocumentFragment();
    for (const emoji of categoria.emojis) {
      fragmento.append(
        el(
          "button",
          {
            class: "emojis__item",
            type: "button",
            "aria-label": emoji.nome ?? emoji.id,
            onclick: () => {
              vibrar("leve");
              aoEscolher(emoji.id);
              folha.fechar();
            },
          },
          elementoDeEmoji(emoji.id, "emoji")
        )
      );
    }
    grade.append(fragmento);
  };

  CATEGORIAS_EMOJI.forEach((categoria, indice) => {
    const id = categoria.id ?? indice;
    const botao = el(
      "button",
      {
        class: "emojis__categoria",
        type: "button",
        role: "tab",
        "aria-selected": String(id === categoriaAtual),
        onclick: () => {
          categoriaAtual = id;
          for (const outro of fita.children) outro.setAttribute("aria-selected", "false");
          botao.setAttribute("aria-selected", "true");
          botao.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
          desenharGrade();
        },
      },
      `${categoria.icone ?? ""} ${categoria.nome}`.trim()
    );
    fita.append(botao);
  });

  desenharGrade();

  const folha = abrirFolha({
    titulo,
    conteudo: el("div", { class: "emojis" }, fita, grade),
    corpoLiso: true,
  });
  return folha;
}

/* ═══ Reações ═══════════════════════════════════════════════════ */

/**
 * A fileira de pílulas de uma mensagem, sempre na ordem de `TODOS_EMOJIS` —
 * e não na do JSON. O `HashMap` do Rust não promete ordem nenhuma, e sem um
 * critério fixo as pílulas trocariam de lugar a cada reação de qualquer um.
 */
export function desenharReacoes(area, mensagemId, reacoes, meuUsuario, aoReagir) {
  limpar(area);
  let alguma = false;

  const conhecidos = new Set(TODOS_EMOJIS.map((e) => e.id));
  const lista = [
    ...TODOS_EMOJIS,
    ...Object.keys(reacoes ?? {})
      .filter((id) => !conhecidos.has(id))
      .map((id) => ({ id })),
  ];

  for (const emoji of lista) {
    const usuarios = reacoes?.[emoji.id];
    if (!usuarios?.length) continue;
    alguma = true;
    area.append(
      el(
        "button",
        {
          class: "reacao",
          type: "button",
          dataset: { minha: usuarios.includes(meuUsuario) },
          "aria-label": `${usuarios.length} ${usuarios.length === 1 ? "reação" : "reações"}`,
          onclick: () => {
            vibrar("leve");
            aoReagir(emoji.id);
          },
        },
        elementoDeEmoji(emoji.id, "emoji"),
        el("span", null, String(usuarios.length))
      )
    );
  }

  area.hidden = !alguma;
  return alguma;
}

export { CATEGORIAS_EMOJI, TODOS_EMOJIS, TOKEN_EMOJI, elementoDeEmoji };
