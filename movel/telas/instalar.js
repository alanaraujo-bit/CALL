/**
 * Instalar o CALL na tela de início.
 *
 * Um PWA aberto na aba do navegador é um site; instalado, é um aplicativo —
 * abre em tela cheia, sem barra de endereço, com ícone próprio e mantendo a
 * sessão. A diferença é grande o bastante para valer um convite, e pequena o
 * bastante para o convite não poder atrapalhar quem já entendeu.
 *
 * Por isso o convite aparece uma vez, some quando dispensado, e nunca volta
 * depois de instalado.
 *
 * ## Os dois caminhos
 *
 * **Android e desktop** disparam `beforeinstallprompt`; guardamos o evento e
 * chamamos `prompt()` no toque — o sistema desenha a caixa de instalação.
 *
 * **iOS não tem esse evento.** Lá o caminho é Compartilhar → "Adicionar à
 * Tela de Início", e a única coisa honesta a fazer é ensinar, com o desenho
 * do botão que a pessoa vai procurar.
 */

import { el, icone, vibrar, abrirFolha, avisar } from "../interacao.js";

const CHAVE_DISPENSADO = "call.instalar.dispensado";

let convitePendente = null;

/** Já está instalado — rodando fora do navegador. */
export const instalado = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.matchMedia("(display-mode: fullscreen)").matches ||
  window.navigator.standalone === true;

export const ehIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ se apresenta como Mac; o toque é o que o entrega.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const ehSafari = () =>
  /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);

window.addEventListener("beforeinstallprompt", (evento) => {
  // Sem isto, o Chrome desenha a própria barrinha por cima do aplicativo.
  evento.preventDefault();
  convitePendente = evento;
  // O evento costuma chegar depois de a primeira tela já estar pintada; quem
  // mostra o convite precisa saber que ele passou a existir.
  window.dispatchEvent(new CustomEvent("call:instalavel"));
});

window.addEventListener("appinstalled", () => {
  convitePendente = null;
  localStorage.setItem(CHAVE_DISPENSADO, "instalado");
});

/** Pode oferecer instalação neste aparelho, agora? */
export function podeInstalar() {
  if (instalado()) return false;
  if (convitePendente) return true;
  // No iOS não há como saber se dá; dá, desde que seja o Safari.
  return ehIOS() && ehSafari();
}

/**
 * O cartão que aparece no alto da lista de grupos. Devolve `null` quando não
 * há nada a oferecer — quem chama simplesmente insere o retorno.
 */
export function blocoDeInstalacao() {
  if (!podeInstalar() || localStorage.getItem(CHAVE_DISPENSADO)) return null;

  const cartao = el(
    "div",
    { class: "instalar" },
    el(
      "span",
      { class: "vazio__selo", style: { width: "44px", height: "44px", borderRadius: "14px", margin: "0" } },
      icone("adicionar-inicio")
    ),
    el(
      "div",
      { class: "instalar__dizeres" },
      el("p", { class: "instalar__titulo" }, "Instalar o CALL"),
      el(
        "p",
        { class: "instalar__texto" },
        "Tela cheia, ícone próprio e abertura direta — sem barra de endereço no meio."
      )
    ),
    el(
      "button",
      {
        class: "acao",
        type: "button",
        "aria-label": "Agora não",
        onclick: () => {
          localStorage.setItem(CHAVE_DISPENSADO, "1");
          cartao.style.transition = "opacity 200ms, transform 200ms";
          cartao.style.opacity = "0";
          cartao.style.transform = "scale(0.96)";
          setTimeout(() => cartao.remove(), 220);
        },
      },
      icone("fechar")
    )
  );

  cartao.addEventListener("click", (evento) => {
    if (evento.target.closest(".acao")) return;
    vibrar("leve");
    convidarAInstalar();
  });

  return cartao;
}

/** Abre o caminho de instalação certo para este aparelho. */
export async function convidarAInstalar() {
  if (instalado()) {
    avisar("O CALL já está instalado neste aparelho.", "bom");
    return;
  }

  if (convitePendente) {
    const evento = convitePendente;
    convitePendente = null;
    evento.prompt();
    const { outcome } = await evento.userChoice;
    if (outcome === "accepted") {
      vibrar("sucesso");
      localStorage.setItem(CHAVE_DISPENSADO, "instalado");
    } else {
      // Recusar uma vez não deve queimar a oferta para sempre.
      convitePendente = evento;
    }
    return;
  }

  ensinarNoIOS();
}

function ensinarNoIOS() {
  const passo = (numero, ...conteudo) =>
    el(
      "div",
      { class: "instalar__passo" },
      el("span", { class: "instalar__numero" }, String(numero)),
      el("p", null, ...conteudo)
    );

  const folha = abrirFolha({
    titulo: "Adicionar à Tela de Início",
    texto: "Três toques, e o CALL vira um aplicativo de verdade neste iPhone.",
    conteudo: el(
      "div",
      { class: "instalar__passos" },
      passo(
        1,
        "Toque em ",
        el("strong", null, "Compartilhar"),
        " — o quadrado com a seta para cima, na barra do Safari."
      ),
      passo(2, "Role e escolha ", el("strong", null, "Adicionar à Tela de Início"), "."),
      passo(3, "Confirme em ", el("strong", null, "Adicionar"), ". Pronto: o ícone do CALL fica na sua tela."),
      el(
        "p",
        { style: { fontSize: "13px", color: "var(--texto-3)", lineHeight: "1.5", marginTop: "4px" } },
        "Precisa ser o Safari. No Chrome do iPhone o botão de adicionar à tela de início não existe — é limitação do sistema, não do CALL."
      )
    ),
    acoes: [
      el(
        "button",
        {
          class: "botao botao--primario",
          type: "button",
          onclick: () => folha.fechar(),
        },
        "Entendi"
      ),
    ],
  });
  return folha;
}
