/**
 * Os seis mascotes do CALL.
 *
 * Cada um é um SVG desenhado à mão, sem dependência nenhuma e sem arquivo de
 * imagem: o projeto inteiro é medido em quilobytes, e seis PNG decentes
 * custariam mais do que todo o restante da interface. Vetor também é o único
 * jeito de a mesma arte servir a 28 px na lista de participantes e a 88 px no
 * cartão de perfil sem borrar.
 *
 * Regras de construção — é o que faz os seis parecerem uma família e não seis
 * desenhos avulsos:
 *
 * * Caixa de 64×64, disco de fundo ocupando tudo, arte inteira dentro do
 *   disco (nada é cortado, então não é preciso `clipPath` — e `clipPath`
 *   exigiria `id`, que colidiria a cada cópia inserida na página).
 * * Luz vinda de cima e da esquerda, sempre o mesmo círculo claro a 6%.
 * * Olhos grandes com brilho no mesmo canto. Aos 28 px é o olho que sobra;
 *   quando ele é pequeno demais, o bicho vira uma mancha colorida.
 * * Uma cor dominante por mascote, bem separada das outras na roda: índigo,
 *   laranja, rosa, castanho, ciano e verde. O teste real não é a arte grande,
 *   é reconhecer quem é quem numa coluna de 212 px.
 * * Nada de gradiente: profundidade vem de camadas chapadas. Gradiente pede
 *   `id`, e o mesmo `id` repetido dezenas de vezes na mesma página é lixo.
 *
 * As formas trazem `fill` como atributo e o `<svg>` zera `stroke` pela classe
 * `.mascote` — a folha global declara `svg { stroke: currentColor }`, que os
 * filhos herdariam e riscariam o desenho inteiro. Quem precisa de traço
 * (bocas, tentáculos) declara `stroke` no próprio elemento, e atributo vence
 * herança.
 */

/** Luz comum a todos: um sol difuso no alto à esquerda. */
const LUZ = '<circle cx="21" cy="18" r="25" fill="#fff" opacity=".06"/>';

const disco = (cor) => `<circle cx="32" cy="32" r="32" fill="${cor}"/>${LUZ}`;

const CORUJA = `
<circle cx="14.5" cy="26" r="0" fill="none"/>
<path d="M14 25 11.5 8.5 27.5 17.5Z" fill="#5560c4"/>
<path d="M50 25 52.5 8.5 36.5 17.5Z" fill="#5560c4"/>
<path d="M14.5 33c-4 5.5-4.5 13-1.5 18.5 4-4 6.5-10.5 6.5-16.5z" fill="#5560c4"/>
<path d="M49.5 33c4 5.5 4.5 13 1.5 18.5-4-4-6.5-10.5-6.5-16.5z" fill="#5560c4"/>
<ellipse cx="32" cy="32.5" rx="19" ry="20.5" fill="#6f7ae0"/>
<ellipse cx="32" cy="43.5" rx="12.5" ry="9.5" fill="#8b95ec"/>
<circle cx="23.8" cy="29.5" r="10.4" fill="#eef0fd"/>
<circle cx="40.2" cy="29.5" r="10.4" fill="#eef0fd"/>
<circle cx="23.8" cy="29.5" r="5.6" fill="#1c1f33"/>
<circle cx="40.2" cy="29.5" r="5.6" fill="#1c1f33"/>
<circle cx="25.7" cy="27.6" r="1.9" fill="#fff"/>
<circle cx="42.1" cy="27.6" r="1.9" fill="#fff"/>
<path d="M32 30.5c2.7 2.1 4.1 5.1 4.1 7.7 0 2.5-1.8 4.2-4.1 4.2s-4.1-1.7-4.1-4.2c0-2.6 1.4-5.6 4.1-7.7z" fill="#f3b459"/>
<path d="M26.5 50.5c-1.2 1.6-1 3.2.4 4M37.5 50.5c1.2 1.6 1 3.2-.4 4" stroke="#f3b459" stroke-width="2" fill="none" stroke-linecap="round"/>
`;

const RAPOSA = `
<path d="M13 28 10.5 8 28.5 17.5Z" fill="#d3752b"/>
<path d="M51 28 53.5 8 35.5 17.5Z" fill="#d3752b"/>
<path d="M15.2 24.6 13.9 12.9 24.8 18.4Z" fill="#43210f"/>
<path d="M48.8 24.6 50.1 12.9 39.2 18.4Z" fill="#43210f"/>
<path d="M32 13.5c11 0 18.5 7 18.5 16.5 0 10.5-8 18.5-18.5 23.5-10.5-5-18.5-13-18.5-23.5 0-9.5 7.5-16.5 18.5-16.5z" fill="#ef8f3f"/>
<path d="M15 29.5c-3.6 1.4-7 4-9.2 7.4 2.6.2 5-.4 7-1.6-1 2.4-1.4 5-1 7.6 2.6-2.6 4.4-5.6 5.4-8.8z" fill="#ffe9d6"/>
<path d="M49 29.5c3.6 1.4 7 4 9.2 7.4-2.6.2-5-.4-7-1.6 1 2.4 1.4 5 1 7.6-2.6-2.6-4.4-5.6-5.4-8.8z" fill="#ffe9d6"/>
<path d="M32 16.5c2.9 3.2 4.4 7.3 4.4 11.5 0 2.9-1.8 4.6-4.4 4.6s-4.4-1.7-4.4-4.6c0-4.2 1.5-8.3 4.4-11.5z" fill="#ffd9b8" opacity=".55"/>
<path d="M32 33c6.6 0 11.2 3.6 11.2 8.2 0 5.1-5.6 9.6-11.2 12.6-5.6-3-11.2-7.5-11.2-12.6 0-4.6 4.6-8.2 11.2-8.2z" fill="#ffe9d6"/>
<ellipse cx="23.4" cy="29.8" rx="3.6" ry="4" fill="#2b1a10"/>
<ellipse cx="40.6" cy="29.8" rx="3.6" ry="4" fill="#2b1a10"/>
<circle cx="24.8" cy="28.2" r="1.4" fill="#fff"/>
<circle cx="42" cy="28.2" r="1.4" fill="#fff"/>
<path d="M32 38.8c2.7 0 4.6 1.5 4.6 3.3 0 1.9-2.1 3.3-4.6 3.3s-4.6-1.4-4.6-3.3c0-1.8 1.9-3.3 4.6-3.3z" fill="#2b1a10"/>
<path d="M32 45.4v2.4M32 47.8c-1.7 1.9-4.4 1.8-5.8.2M32 47.8c1.7 1.9 4.4 1.8 5.8.2" stroke="#2b1a10" stroke-width="1.7" fill="none" stroke-linecap="round"/>
`;

/* As guelras são o axolote. Na primeira versão elas eram três folhinhas
   coladas na cabeça e sumiam aos 28 px — sobrava um borrão rosa. Agora são
   três hastes com tufos nas pontas, saindo bem para fora: é a silhueta, e não
   a cor, que distingue um mascote do outro na lista. */
const GUELRAS = `
<path d="M16.5 26 8.5 19.5M14.5 33 4.8 31.5M16.5 40 8.5 45.5" stroke="#f277a8" stroke-width="4" fill="none" stroke-linecap="round"/>
<g fill="#ff9cc4">
  <circle cx="8.5" cy="19.5" r="3.8"/><circle cx="11.5" cy="15.5" r="2.6"/><circle cx="5.5" cy="22.5" r="2.6"/>
  <circle cx="4.8" cy="31.5" r="4.2"/><circle cx="3.4" cy="26.5" r="2.6"/><circle cx="3.8" cy="36.8" r="2.6"/>
  <circle cx="8.5" cy="45.5" r="3.8"/><circle cx="5.6" cy="41.5" r="2.6"/><circle cx="12" cy="50.5" r="2.6"/>
</g>`;

const AXOLOTE = `
${GUELRAS}
<g transform="translate(64 0) scale(-1 1)">${GUELRAS}</g>
<path d="M32 17c10.8 0 18.8 7.2 18.8 16.4S42.8 50.5 32 50.5 13.2 42.6 13.2 33.4 21.2 17 32 17z" fill="#f8a3c8"/>
<path d="M32 17c8.6 0 15.4 4.5 18 11.2-4-3.1-10.5-5-18-5s-14 1.9-18 5c2.6-6.7 9.4-11.2 18-11.2z" fill="#ffc0da"/>
<circle cx="19.4" cy="39.6" r="3.8" fill="#ff5f9e" opacity=".45"/>
<circle cx="44.6" cy="39.6" r="3.8" fill="#ff5f9e" opacity=".45"/>
<circle cx="23.4" cy="32" r="3.1" fill="#3b1230"/>
<circle cx="40.6" cy="32" r="3.1" fill="#3b1230"/>
<circle cx="24.5" cy="30.8" r="1.1" fill="#fff"/>
<circle cx="41.7" cy="30.8" r="1.1" fill="#fff"/>
<path d="M26 39.4c2.8 3.6 9.2 3.6 12 0" stroke="#cf5b8e" stroke-width="2.3" fill="none" stroke-linecap="round"/>
`;

/* Capivara é focinho: cabeça de topo achatado que alarga para baixo, orelhas
   pequenas nos cantos de cima. Com orelhas redondas grandes e cabeça oval —
   como na primeira versão — sai um urso. A laranja na cabeça é piada nossa e
   fica: é o detalhe que faz alguém escolher esta e não outra. */
const CAPIVARA = `
<ellipse cx="16.4" cy="20.5" rx="4" ry="3.2" transform="rotate(-22 16.4 20.5)" fill="#8b5f37"/>
<ellipse cx="47.6" cy="20.5" rx="4" ry="3.2" transform="rotate(22 47.6 20.5)" fill="#8b5f37"/>
<ellipse cx="16.6" cy="21" rx="1.8" ry="1.4" transform="rotate(-22 16.6 21)" fill="#4a2f1c"/>
<ellipse cx="47.4" cy="21" rx="1.8" ry="1.4" transform="rotate(22 47.4 21)" fill="#4a2f1c"/>
<path d="M13 30c0-7.4 8.5-12.8 19-12.8s19 5.4 19 12.8v12.6c0 5.6-8.5 9.4-19 9.4s-19-3.8-19-9.4z" fill="#a97748"/>
<path d="M14 37.6h36v5c0 5.6-8.5 9.4-18 9.4s-18-3.8-18-9.4z" fill="#c99263"/>
<circle cx="20.8" cy="27.4" r="2.5" fill="#3a2418"/>
<circle cx="43.2" cy="27.4" r="2.5" fill="#3a2418"/>
<circle cx="21.8" cy="26.4" r="1" fill="#fff"/>
<circle cx="44.2" cy="26.4" r="1" fill="#fff"/>
<rect x="23.6" y="40.4" width="16.8" height="6.8" rx="3.4" fill="#4a2f1c"/>
<path d="M32 47.6v1.8M32 49.4c-1.6 1.8-4.4 1.6-5.6 0M32 49.4c1.6 1.8 4.4 1.6 5.6 0" stroke="#4a2f1c" stroke-width="1.7" fill="none" stroke-linecap="round"/>
<circle cx="32" cy="15.5" r="5.6" fill="#ef8f3f"/>
<path d="M28.6 12.2c2-1.4 4.8-1.4 6.8 0-2 .8-4.8.8-6.8 0z" fill="#ffb469"/>
<path d="M32.8 10.8c1.8-2.4 4.8-3.2 7.2-2.3-.8 3.2-3.2 4.8-6 4.8z" fill="#4fc98c"/>
`;

const POLVO = `
<path d="M17.5 41c-3.6 3.6-5 6.8-5.2 9.4" stroke="#1f8fa8" stroke-width="7" fill="none" stroke-linecap="round"/>
<path d="M24.5 45.5c-2.2 4-2.6 7.6-1.8 10.6" stroke="#1f8fa8" stroke-width="6.4" fill="none" stroke-linecap="round"/>
<path d="M39.5 45.5c2.2 4 2.6 7.6 1.8 10.6" stroke="#1f8fa8" stroke-width="6.4" fill="none" stroke-linecap="round"/>
<path d="M46.5 41c3.6 3.6 5 6.8 5.2 9.4" stroke="#1f8fa8" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="13.2" cy="48.4" r="1.6" fill="#a9ecf6" opacity=".65"/>
<circle cx="15" cy="43.8" r="1.5" fill="#a9ecf6" opacity=".65"/>
<circle cx="50.8" cy="48.4" r="1.6" fill="#a9ecf6" opacity=".65"/>
<circle cx="49" cy="43.8" r="1.5" fill="#a9ecf6" opacity=".65"/>
<path d="M32 11c10.6 0 18.6 8 18.6 18.6 0 10.1-6 17.7-14.1 19.7-3 .8-6 .8-9 0-8.1-2-14.1-9.6-14.1-19.7C13.4 19 21.4 11 32 11z" fill="#2fb0c9"/>
<path d="M32 15c-7.2 0-13.4 5-15 11.8 4.2-4.6 9.2-7 15-7s10.8 2.4 15 7C45.4 20 39.2 15 32 15z" fill="#63d3e6" opacity=".85"/>
<circle cx="24.4" cy="31.2" r="6.7" fill="#eafaff"/>
<circle cx="39.6" cy="31.2" r="6.7" fill="#eafaff"/>
<circle cx="25.6" cy="31.8" r="3.2" fill="#123a45"/>
<circle cx="40.8" cy="31.8" r="3.2" fill="#123a45"/>
<circle cx="27" cy="29.6" r="1.5" fill="#fff"/>
<circle cx="42.2" cy="29.6" r="1.5" fill="#fff"/>
<path d="M28.6 41.4c2 2.3 4.8 2.3 6.8 0" stroke="#146378" stroke-width="2.1" fill="none" stroke-linecap="round"/>
`;

/* Chifres finos e focinho largo e claro davam um sapo. Agora os chifres são
   cunhas grossas varridas para trás, há crista serrilhada entre eles e
   barbatanas na linha da mandíbula — três coisas que sapo nenhum tem. */
const DRAGAO = `
<path d="M22.4 22.6C17 20.6 10.8 15.6 7.6 9.4c8.6-.2 15 4.6 17.8 11.4z" fill="#ead6a3"/>
<path d="M41.6 22.6c5.4-2 11.6-7 14.8-13.2-8.6-.2-15 4.6-17.8 11.4z" fill="#ead6a3"/>
<path d="M22.4 22.6C17 20.6 10.8 15.6 7.6 9.4c1.6 6.2 7.4 11.4 15 13.6z" fill="#cdb684"/>
<path d="M41.6 22.6c5.4-2 11.6-7 14.8-13.2-1.6 6.2-7.4 11.4-15 13.6z" fill="#cdb684"/>
<path d="M26.6 16.8 28.8 12.2l3.2 3.8 3.2-3.8 2.2 4.6z" fill="#ead6a3"/>
<path d="M14.4 35.4 3.6 31.2l10.2-4.6zM49.6 35.4l10.8-4.2-10.2-4.6z" fill="#2f9a6c"/>
<path d="M32 13.5c11 0 19 7.5 19 17.2C51 41.8 43 49.9 32 53 21 49.9 13 41.8 13 30.7c0-9.7 8-17.2 19-17.2z" fill="#4fc98c"/>
<path d="M32 13.5c8.6 0 15.4 4.6 18 11.4-4.6-3.4-11-5.4-18-5.4s-13.4 2-18 5.4c2.6-6.8 9.4-11.4 18-11.4z" fill="#66d9a1"/>
<path d="M16.8 25.4c3.6-3 8.4-4 12-3.2l-1.2 4.2c-3.6-.6-7.2.2-10.8 2z" fill="#2f9a6c"/>
<path d="M47.2 25.4c-3.6-3-8.4-4-12-3.2l1.2 4.2c3.6-.6 7.2.2 10.8 2z" fill="#2f9a6c"/>
<ellipse cx="23.6" cy="30" rx="4.8" ry="5.2" fill="#f2fff7"/>
<ellipse cx="40.4" cy="30" rx="4.8" ry="5.2" fill="#f2fff7"/>
<ellipse cx="24.2" cy="30" rx="1.8" ry="4.1" fill="#10331f"/>
<ellipse cx="41" cy="30" rx="1.8" ry="4.1" fill="#10331f"/>
<path d="M32 35c6 0 10.4 3.2 10.4 7.6S37.2 50.4 32 50.4s-10.4-3.4-10.4-7.8S26 35 32 35z" fill="#7ddfae"/>
<circle cx="28.4" cy="40.8" r="1.7" fill="#2a6b4a"/>
<circle cx="35.6" cy="40.8" r="1.7" fill="#2a6b4a"/>
<path d="M26.6 45c3.2 3 8.6 3 11.8 0" stroke="#2a6b4a" stroke-width="2.1" fill="none" stroke-linecap="round"/>
<path d="M27.4 46.4l1.4 3 1.4-3zM33.8 46.4l1.4 3 1.4-3z" fill="#fff"/>
`;

/**
 * Os seis. O `lema` não é enfeite: sem ele a escolha vira "qual bicho é mais
 * bonito", e com ele vira "qual sou eu numa call" — que é a pergunta que a
 * pessoa realmente responde ao escolher um avatar.
 */
export const AVATARES = [
  {
    id: "coruja",
    nome: "Coruja",
    lema: "De quem fica até tarde",
    cor: "#6f7ae0",
    fundo: "#262b52",
    arte: CORUJA,
  },
  {
    id: "raposa",
    nome: "Raposa",
    lema: "De quem tem a ideia primeiro",
    cor: "#ef8f3f",
    fundo: "#3a2216",
    arte: RAPOSA,
  },
  {
    id: "axolote",
    nome: "Axolote",
    lema: "De quem escuta antes de falar",
    cor: "#f8a3c8",
    fundo: "#3d1f38",
    arte: AXOLOTE,
  },
  {
    id: "capivara",
    nome: "Capivara",
    lema: "De quem mantém a paz",
    cor: "#a97748",
    fundo: "#33291b",
    arte: CAPIVARA,
  },
  {
    id: "polvo",
    nome: "Polvo",
    lema: "De quem faz seis coisas ao mesmo tempo",
    cor: "#2fb0c9",
    fundo: "#10333f",
    arte: POLVO,
  },
  {
    id: "dragao",
    nome: "Dragão",
    lema: "De quem vem para ganhar",
    cor: "#4fc98c",
    fundo: "#16331f",
    arte: DRAGAO,
  },
];

export function acharAvatar(id) {
  return AVATARES.find((a) => a.id === id) ?? null;
}

/**
 * Avatar de quem nunca escolheu um. Sorteado a partir do identificador da
 * pessoa, e não fixo: sem isto todo grupo novo começaria com seis corujas
 * idênticas na lista, e o avatar deixaria de distinguir alguém justamente
 * quando ninguém ainda mexeu nos ajustes.
 */
export function avatarSugerido(semente) {
  let acumulado = 2166136261;
  for (const caractere of String(semente)) {
    acumulado ^= caractere.codePointAt(0);
    acumulado = Math.imul(acumulado, 16777619);
  }
  return AVATARES[Math.abs(acumulado) % AVATARES.length].id;
}

/** As iniciais continuam existindo: são o retrato de quem ainda não tem um. */
export function iniciais(nome) {
  return (
    String(nome ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((parte) => [...parte][0])
      .join("") || "?"
  );
}

const FOTO_ENQUADRADA_VERSAO = 1;

const limitarNumero = (valor, minimo, maximo, padrao) => {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.min(maximo, Math.max(minimo, numero)) : padrao;
};

export function lerFotoEnquadrada(foto) {
  if (typeof foto !== "string" || !foto) return null;
  if (foto.startsWith("data:image/")) {
    return { src: foto, w: 0, h: 0, panX: 0, panY: 0, zoom: 1, antiga: true };
  }

  try {
    const bruto = JSON.parse(foto);
    const dados =
      typeof bruto === "string"
        ? JSON.parse(bruto)
        : bruto;
    if (
      dados?.tipo !== "foto-enquadrada" ||
      dados?.versao !== FOTO_ENQUADRADA_VERSAO ||
      typeof dados.src !== "string" ||
      !dados.src.startsWith("data:image/")
    ) {
      return null;
    }
    return {
      src: dados.src,
      w: limitarNumero(dados.w, 1, 10_000, 0),
      h: limitarNumero(dados.h, 1, 10_000, 0),
      panX: limitarNumero(dados.panX, -1, 1, 0),
      panY: limitarNumero(dados.panY, -1, 1, 0),
      zoom: limitarNumero(dados.zoom, 1, 4, 1),
      antiga: false,
    };
  } catch {
    return null;
  }
}

export function gravarFotoEnquadrada({ src, w, h, panX = 0, panY = 0, zoom = 1 }) {
  return JSON.stringify({
    tipo: "foto-enquadrada",
    versao: FOTO_ENQUADRADA_VERSAO,
    src,
    w: limitarNumero(w, 1, 10_000, 0),
    h: limitarNumero(h, 1, 10_000, 0),
    panX: limitarNumero(panX, -1, 1, 0),
    panY: limitarNumero(panY, -1, 1, 0),
    zoom: limitarNumero(zoom, 1, 4, 1),
  });
}

function pintarImagemEnquadrada(elemento, foto) {
  const dados = lerFotoEnquadrada(foto);
  if (!dados?.src) return false;

  elemento.textContent = "";
  const imagem = document.createElement("img");
  imagem.src = dados.src;
  imagem.alt = "";

  if (!dados.antiga && dados.w > 0 && dados.h > 0) {
    const proporcao = dados.w / dados.h;
    const baseLargura = proporcao >= 1 ? proporcao * 100 : 100;
    const baseAltura = proporcao >= 1 ? 100 : (100 / proporcao);
    const largura = baseLargura * dados.zoom;
    const altura = baseAltura * dados.zoom;
    const extraX = Math.max(0, largura - 100);
    const extraY = Math.max(0, altura - 100);

    imagem.style.position = "absolute";
    imagem.style.left = `${50 + (dados.panX * extraX) / 2}%`;
    imagem.style.top = `${50 + (dados.panY * extraY) / 2}%`;
    imagem.style.width = `${largura}%`;
    imagem.style.height = `${altura}%`;
    imagem.style.maxWidth = "none";
    imagem.style.maxHeight = "none";
    imagem.style.transform = "translate(-50%, -50%)";
    imagem.style.objectFit = "fill";
  }

  elemento.append(imagem);
  return true;
}

function aplicarFundoEnquadrado(elemento, foto) {
  const dados = lerFotoEnquadrada(foto);
  if (!dados?.src) return false;

  elemento.textContent = "";
  elemento.replaceChildren();
  elemento.style.backgroundImage = `url("${dados.src}")`;
  elemento.style.backgroundRepeat = "no-repeat";

  if (!dados.antiga && dados.w > 0 && dados.h > 0) {
    const proporcao = dados.w / dados.h;
    const baseLargura = proporcao >= 1 ? proporcao * 100 : 100;
    const baseAltura = proporcao >= 1 ? 100 : (100 / proporcao);
    const largura = baseLargura * dados.zoom;
    const altura = baseAltura * dados.zoom;
    const extraX = Math.max(0, largura - 100);
    const extraY = Math.max(0, altura - 100);

    elemento.style.backgroundSize = `${largura}% ${altura}%`;
    elemento.style.backgroundPosition = `${50 + (dados.panX * extraX) / 2}% ${50 + (dados.panY * extraY) / 2}%`;
  } else {
    elemento.style.backgroundSize = "cover";
    elemento.style.backgroundPosition = "center";
  }

  return true;
}

export function pintarMarcaDeGrupo(elemento, { nome, foto } = {}) {
  elemento.classList.toggle("retrato-de-foto", Boolean(foto));
  elemento.style.backgroundImage = "";
  elemento.style.backgroundPosition = "";
  elemento.style.backgroundRepeat = "";
  elemento.style.backgroundSize = "";

  if (foto) {
    if (aplicarFundoEnquadrado(elemento, foto)) return;
  }

  elemento.textContent = iniciais(nome);
}

/**
 * Desenha o avatar de alguém dentro de um elemento `.avatar`.
 *
 * O `innerHTML` aqui é seguro por construção e não por confiança: o que entra
 * é sempre uma das seis constantes deste arquivo, achada por `acharAvatar`.
 * Um identificador vindo da rede que não esteja na lista — cliente adulterado,
 * ou versão mais nova com um sétimo mascote — cai nas iniciais, que vão por
 * `textContent`. Em nenhum caminho um texto de outra pessoa vira marcação.
 */
/**
 * `foto` é sempre local — a conta de outra pessoa nunca traz esse campo,
 * porque o servidor não guarda foto nenhuma ainda, só o mascote. Por isso ela
 * só aparece pintada em avatares que representam a própria pessoa usando o
 * CALL neste computador — o rodapé, a linha dela na lista e as mensagens que
 * ela mesma escreveu —, nunca em quem está do outro lado do grupo.
 */
export function pintarAvatar(elemento, { avatar, apelido, foto } = {}) {
  elemento.classList.toggle("avatar--foto", Boolean(foto));

  if (foto) {
    elemento.classList.remove("avatar--mascote");
    if (pintarImagemEnquadrada(elemento, foto)) return;
  }

  const escolhido = acharAvatar(avatar);
  elemento.classList.toggle("avatar--mascote", Boolean(escolhido));

  if (!escolhido) {
    elemento.textContent = iniciais(apelido);
    return;
  }

  elemento.textContent = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "mascote");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = disco(escolhido.fundo) + escolhido.arte;
  elemento.append(svg);
}

/** Um `.avatar` pronto, para quem só quer o elemento. */
export function elementoDeAvatar(pessoa, classe = "avatar") {
  const elemento = document.createElement("span");
  elemento.className = classe;
  pintarAvatar(elemento, pessoa);
  return elemento;
}
