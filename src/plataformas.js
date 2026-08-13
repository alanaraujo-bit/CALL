/**
 * Selos de atividade: quando o nome que a Vigia reconheceu bate com uma
 * marca conhecida, mostra um ícone dela; senão, um monograma colorido pela
 * primeira letra do nome. Nunca mais a caixa cinza genérica de antes, que
 * não dizia nada sobre o que a pessoa está usando — todo mundo ganha um selo
 * que parece de verdade, mesmo quando o CALL nunca ouviu falar do programa.
 *
 * Casa por *nome* (o que já viaja para o grupo inteiro), e não por exe: o
 * exe só existe no computador de quem está usando o programa, e abrir um
 * segundo canal de rede só para ele custaria mais do que vale. Quem cadastrou
 * um ícone próprio a mão (`app.js` › `cadastrarPrograma`) continua tendo
 * prioridade sobre tudo isto — é escolha explícita da pessoa, e não a
 * política padrão decidindo por ela.
 *
 * Os traços das marcas abaixo são desenhos simplificados, no mesmo espírito
 * dos mascotes de `avatares.js`: lembram a marca de longe, não são a arte
 * oficial pixel a pixel.
 */

function marca(nomes, cor, svg) {
  return { nomes, cor, svg };
}

const MARCAS = [
  marca(
    ["spotify"],
    "#1ed760",
    '<svg viewBox="0 0 20 20" fill="none"><path d="M5 7.8c3.2-1.3 6.8-1.3 10 0" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><path d="M5.8 10.6c2.6-1 5.8-1 8.4 0" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M6.6 13.3c2-.7 4.8-.7 6.8 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>'
  ),
  marca(
    ["discord"],
    "#5865f2",
    '<svg viewBox="0 0 20 20" fill="none"><path d="M6 8c0-2.2 1.8-4 4-4s4 1.8 4 4v3.4c0 2.8-1.8 5.1-4 5.1s-4-2.3-4-5.1V8z" fill="#fff"/><circle cx="8.4" cy="9.3" r="1" fill="#5865f2"/><circle cx="11.6" cy="9.3" r="1" fill="#5865f2"/></svg>'
  ),
  marca(
    ["steam"],
    "#171a21",
    '<svg viewBox="0 0 20 20" fill="none"><circle cx="10.5" cy="7" r="2.6" stroke="#66c0f4" stroke-width="1.5"/><circle cx="10.5" cy="7" r="0.9" fill="#66c0f4"/><path d="M4.5 14.2a5 5 0 0 0 9-3.4" stroke="#66c0f4" stroke-width="1.5" stroke-linecap="round"/></svg>'
  ),
  marca(
    ["whatsapp"],
    "#25d366",
    '<svg viewBox="0 0 20 20" fill="none"><path d="M10 4a6 6 0 0 0-5.2 9L4 16.2l3.3-.9A6 6 0 1 0 10 4z" fill="#fff"/><path d="M7.7 8.4c.3-.6.6-.6.9-.6h.3c.2 0 .4 0 .5.4.2.5.6 1.4.6 1.5.1.1.1.3 0 .4-.1.2-.2.3-.3.4-.1.1-.3.3-.1.6.2.4.9 1.4 1.9 1.8.3.1.5.1.7-.1.2-.2.5-.6.7-.8.1-.2.3-.2.5-.1l1.3.6c.2.1.4.2.4.3.1.2.1.9-.2 1.3-.3.5-1.1.9-1.6.9-.4 0-1.9-.2-3.5-1.7-1.9-1.7-2.2-3-2.3-3.3 0-.2-.4-.7-.4-1.3 0-.5.2-.9.4-1.2z" fill="#25d366"/></svg>'
  ),
  marca(
    ["telegram", "telegram desktop"],
    "#26a5e4",
    '<svg viewBox="0 0 20 20" fill="none"><path d="M4 10.6l12.4-5.4c.6-.3 1.2.2 1 .8l-2.1 10.4c-.1.6-.8.9-1.3.5l-3-2.3-1.7 1.7c-.3.3-.8.2-.9-.2l-.6-2.9-3.4-1.4c-.6-.2-.6-1 0-1.2z" fill="#fff"/><path d="M8.6 15.1l.4-3 6.6-6-7.9 5.6z" fill="#bfe4fb"/></svg>'
  ),
  marca(
    ["visual studio code", "vs code", "code"],
    "#0078d4",
    '<svg viewBox="0 0 20 20" fill="none"><path d="M14.4 3.4L7.2 9.2 4 6.8 2.6 7.7l4 3.3-4 3.3 1.4.9L7.2 12l7.2 5.6 2.2-1V4.4l-2.2-1z" fill="#fff"/></svg>'
  ),
  marca(
    ["obs", "obs studio"],
    "#302e31",
    '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6" stroke="#fff" stroke-width="1.6"/><circle cx="10" cy="10" r="2.3" fill="#fff"/></svg>'
  ),
];

/**
 * A marca reconhecida para este nome, ou `null`. Casa a palavra toda ou o
 * começo do nome ("OBS Studio 30.1" continua sendo OBS), nunca um pedaço
 * solto no meio — "Adobe Premiere Pro" não pode virar Discord por acidente.
 */
export function marcaDeAtividade(nome) {
  const chave = String(nome ?? "").trim().toLowerCase();
  if (!chave) return null;
  for (const item of MARCAS) {
    if (item.nomes.some((candidato) => chave === candidato || chave.startsWith(`${candidato} `))) {
      return item;
    }
  }
  return null;
}

/** Paleta própria do monograma — deliberadamente longe das cores das marcas
 *  acima, para não nascer parecendo uma marca errada. */
const CORES_MONOGRAMA = [
  "#5b6bd6",
  "#c2477f",
  "#3fa796",
  "#d9863f",
  "#5e8bd9",
  "#a35bc2",
  "#4fae6b",
  "#c2604a",
];

/**
 * O selo de quem não tem marca reconhecida: um quadrado colorido com a
 * primeira letra do nome. A cor vem de um hash simples do texto inteiro —
 * não só da letra —, para que "Call of Duty" e "Chrome" não caiam na mesma
 * cor só por começarem igual.
 */
export function monogramaDeAtividade(nome) {
  const texto = String(nome ?? "").trim();
  if (!texto) return null;

  let hash = 0;
  for (const ponto of texto) hash = (hash * 31 + ponto.codePointAt(0)) >>> 0;

  return {
    cor: CORES_MONOGRAMA[hash % CORES_MONOGRAMA.length],
    letra: [...texto][0].toUpperCase(),
  };
}

/**
 * Preenche um `<span>` já criado com o selo certo para uma atividade —
 * cadastro a mão primeiro, depois marca reconhecida, depois monograma.
 * `baseClasse` é a classe do módulo que chama (`cartao__atividade-icone`,
 * `participante__atividade-icone`...); as variantes de marca e monograma
 * penduram um sufixo nela, do jeito que `--generico` fazia antes.
 */
export function preencherIconeDeAtividade(elemento, { atividade, atividadeIcone }, baseClasse) {
  elemento.className = baseClasse;
  elemento.textContent = "";
  elemento.style.background = "";

  if (atividadeIcone) {
    const imagem = document.createElement("img");
    imagem.src = atividadeIcone;
    imagem.alt = "";
    elemento.append(imagem);
    return;
  }

  const encontrada = marcaDeAtividade(atividade);
  if (encontrada) {
    elemento.classList.add(`${baseClasse}--marca`);
    elemento.style.background = encontrada.cor;
    elemento.innerHTML = encontrada.svg;
    return;
  }

  const mono = monogramaDeAtividade(atividade);
  if (mono) {
    elemento.classList.add(`${baseClasse}--monograma`);
    elemento.style.background = mono.cor;
    elemento.textContent = mono.letra;
  }
}
