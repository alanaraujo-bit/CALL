/**
 * Os cinco emoji do CALL.
 *
 * Mesma construção dos mascotes em `avatares.js` — SVG desenhado à mão, sem
 * arquivo de imagem, disco de fundo cheio, luz vinda de cima e da esquerda —
 * mas resolvida para um tamanho bem menor: um emoji aparece a 18-20 px numa
 * mensagem ou numa pílula de reação, então só olho e boca sobrevivem a esse
 * tamanho. Nada de orelha, chifre ou textura; a identidade aqui é a cor do
 * disco e a curva da boca, só isso.
 *
 * Não tenta imitar o emoji do sistema operacional — é o ponto de ter um
 * conjunto próprio. As cinco reações cobrem a mesma necessidade que o
 * "like/amei/haha/uau/triste" de qualquer chat, com a nossa cara.
 */

const LUZ = '<circle cx="21" cy="18" r="25" fill="#fff" opacity=".06"/>';
const disco = (cor) => `<circle cx="32" cy="32" r="32" fill="${cor}"/>${LUZ}`;

const FELIZ = `
<circle cx="23" cy="29" r="4.6" fill="#1c1f33"/>
<circle cx="41" cy="29" r="4.6" fill="#1c1f33"/>
<circle cx="24.8" cy="27" r="1.6" fill="#fff"/>
<circle cx="42.8" cy="27" r="1.6" fill="#fff"/>
<circle cx="17" cy="39" r="4.2" fill="#3f2c55" opacity=".4"/>
<circle cx="47" cy="39" r="4.2" fill="#3f2c55" opacity=".4"/>
<path d="M20 37Q32 51 44 37" stroke="#1c1f33" stroke-width="3.6" fill="none" stroke-linecap="round"/>
`;

const CORACAO = `
<path
  d="M32 49C14 37 10 26 10 18.5 10 12 15 7 21.5 7c4.3 0 8 2.3 10.5 6 2.5-3.7 6.2-6 10.5-6C49 7 54 12 54 18.5 54 26 50 37 32 49z"
  fill="#ff5f83"
/>
<ellipse cx="20.5" cy="16.5" rx="5.4" ry="3.3" fill="#ffa9bd" opacity=".7" transform="rotate(-28 20.5 16.5)"/>
`;

const RISADA = `
<path d="M17 27c1.8-2.8 4.6-2.8 6.4 0M40.6 27c1.8-2.8 4.6-2.8 6.4 0" stroke="#3a2405" stroke-width="3.6" fill="none" stroke-linecap="round"/>
<ellipse cx="32" cy="41" rx="11" ry="8.6" fill="#3a2405"/>
<ellipse cx="32" cy="43.8" rx="6.2" ry="4.4" fill="#ff5f6b"/>
<path d="M12.5 33c-2.6 1.7-3.7 4.3-3.2 7.2M51.5 33c2.6 1.7 3.7 4.3 3.2 7.2" stroke="#eafaff" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".85"/>
`;

const UAU = `
<circle cx="22.5" cy="31" r="7.4" fill="#eafaff"/>
<circle cx="41.5" cy="31" r="7.4" fill="#eafaff"/>
<circle cx="22.5" cy="31" r="3.7" fill="#123a45"/>
<circle cx="41.5" cy="31" r="3.7" fill="#123a45"/>
<circle cx="24.2" cy="28.8" r="1.4" fill="#fff"/>
<circle cx="43.2" cy="28.8" r="1.4" fill="#fff"/>
<path d="M13.5 19.5c2.8-2.3 6.6-2.7 9.6-1.1M50.5 19.5c-2.8-2.3-6.6-2.7-9.6-1.1" stroke="#123a45" stroke-width="2.6" fill="none" stroke-linecap="round"/>
<ellipse cx="32" cy="45.5" rx="5.6" ry="6.8" fill="#123a45"/>
`;

const CHORO = `
<circle cx="23" cy="29" r="4.2" fill="#1c2b45"/>
<circle cx="41" cy="29" r="4.2" fill="#1c2b45"/>
<circle cx="24.6" cy="27.2" r="1.4" fill="#fff"/>
<circle cx="42.6" cy="27.2" r="1.4" fill="#fff"/>
<path d="M20 46Q32 36 44 46" stroke="#1c2b45" stroke-width="3.4" fill="none" stroke-linecap="round"/>
<path d="M18.5 33c-2.6 3.4-2.8 7.6-.6 10.6 3.6-1 5.4-4.4 4.8-8.2-1.6-.6-3-1.4-4.2-2.4z" fill="#8ec8ff"/>
<ellipse cx="19.6" cy="38" rx="1.6" ry="2.2" fill="#eafaff" opacity=".7"/>
`;

/**
 * A ordem aqui é a ordem em toda parte — o seletor de composição, o de
 * reação, a leitura de um `:nome:` no meio de uma mensagem.
 */
export const EMOJIS = [
  { id: "feliz", nome: "Feliz", cor: "#5f6ad9", arte: FELIZ },
  { id: "coracao", nome: "Amei", cor: "#d43d6b", arte: CORACAO },
  { id: "risada", nome: "Risada", cor: "#e69a2e", arte: RISADA },
  { id: "uau", nome: "Uau", cor: "#2fb0c9", arte: UAU },
  { id: "choro", nome: "Choro", cor: "#3f5f96", arte: CHORO },
];

export function acharEmoji(id) {
  return EMOJIS.find((e) => e.id === id) ?? null;
}

/** Um `<span>` com o SVG do emoji dentro, do tamanho que o CSS mandar. */
export function elementoDeEmoji(id, classe = "emoji") {
  const encontrado = acharEmoji(id);
  const elemento = document.createElement("span");
  elemento.className = classe;
  if (!encontrado) return elemento;

  elemento.title = encontrado.nome;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  // O `innerHTML` aqui é seguro por construção: `encontrado.arte` é sempre
  // uma das cinco constantes deste arquivo, nunca texto vindo da rede.
  svg.innerHTML = disco(encontrado.cor) + encontrado.arte;
  elemento.append(svg);
  return elemento;
}

/** `:nome:` de um emoji válido, em qualquer lugar do texto — é o token que
 *  o campo de mensagem escreve e que a mensagem renderizada troca por
 *  desenho. Compilado uma vez: a lista de emoji não muda em tempo de
 *  execução. */
export const TOKEN_EMOJI = new RegExp(`:(${EMOJIS.map((e) => e.id).join("|")}):`, "g");
