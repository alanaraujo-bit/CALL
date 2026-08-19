/**
 * A call.
 *
 * Não é uma tela empilhada: é uma superfície apresentada por cima de tudo,
 * que desce arrastando e vira a tira do rodapé. Essa distinção não é
 * estética — é o que permite ler uma mensagem, trocar de grupo e olhar o
 * perfil de alguém **sem sair da chamada**, que é a coisa que mais se faz num
 * celular durante uma call.
 *
 * O palco tem duas metades e uma regra:
 *
 * 1. Se alguém está transmitindo a tela, ela vem primeiro e ocupa a largura
 *    inteira — é o conteúdo, e os retratos viram acompanhamento.
 * 2. Senão, a grade de participantes ocupa tudo, com o número de colunas
 *    acompanhando quantas pessoas há.
 *
 * Tocar numa transmissão abre o holofote: preto, tela cheia, com pinça para
 * ampliar. É onde o celular finalmente vira uma segunda tela de quem está
 * jogando no computador.
 */

import { el, limpar, vibrar, avisar, icone, menu, confirmar, arrastarParaFechar } from "../interacao.js";
import { avatar } from "../visual.js";
import {
  estado,
  assinar,
  acharCanal,
  membrosNaVoz,
  sairDaVoz,
  alternarMudo,
  alternarSurdo,
  tempoDeCallEmTexto,
  falando,
  telasRecebidas,
  espectadores,
  historicoDaCall,
  emitir,
} from "../nucleo.js";
import { abrirSoundboard } from "./soundboard.js";
import { mostrarCartao } from "./pessoas.js";
import { abrirConversa } from "./conversa.js";

let superficie = null;
let desmontar = null;
let navegacao = null;

/* ═══ Abertura e fechamento ═════════════════════════════════════ */

export function abrirCall(nav) {
  navegacao = nav ?? navegacao;
  if (!estado.canalVoz) return;
  if (superficie) {
    mostrar();
    return;
  }
  montar();
  mostrar();
}

/** Desce a superfície sem sair da call — ela continua na tira do rodapé. */
export function recolherCall() {
  if (!superficie) return;
  superficie.dataset.animando = "";
  superficie.style.removeProperty("--arrasto");
  delete superficie.dataset.aberta;
  document.getElementById("abas")?.removeAttribute("data-na-call");
  emitir("call", { aberta: false });
}

export function fecharCall() {
  if (!superficie) return;
  const alvo = superficie;
  superficie = null;
  desmontar?.();
  desmontar = null;
  alvo.dataset.animando = "";
  alvo.style.removeProperty("--arrasto");
  delete alvo.dataset.aberta;
  document.getElementById("abas")?.removeAttribute("data-na-call");
  setTimeout(() => alvo.remove(), 420);
  emitir("call", { aberta: false });
}

export const callAberta = () => Boolean(superficie?.hasAttribute("data-aberta"));

function mostrar() {
  requestAnimationFrame(() => {
    superficie.dataset.animando = "";
    requestAnimationFrame(() => {
      superficie.dataset.aberta = "";
      document.getElementById("abas")?.setAttribute("data-na-call", "");
      emitir("call", { aberta: true });
    });
  });
}

/* ═══ A superfície ══════════════════════════════════════════════ */

function montar() {
  const palco = el("div", { class: "call__palco" });

  const titulo = el("span", { class: "cabecalho__titulo" });
  const legenda = el("span", { class: "cabecalho__legenda cabecalho__legenda--viva" });

  const cabecalho = el(
    "header",
    { class: "call__cabecalho" },
    el(
      "button",
      {
        class: "acao",
        type: "button",
        "aria-label": "Recolher a call",
        onclick: () => {
          vibrar("leve");
          recolherCall();
        },
      },
      icone("descer")
    ),
    el("div", { class: "cabecalho__titulos" }, titulo, legenda),
    el(
      "button",
      {
        class: "acao",
        type: "button",
        "aria-label": "Opções da call",
        onclick: () => menuDaCall(),
      },
      icone("reticencias")
    )
  );

  /* ── Controles ───────────────────────────────────────────────── */

  const botaoMudo = controle("microfone", "Microfone", () => {
    vibrar("medio");
    alternarMudo();
  });
  const botaoSurdo = controle("fone", "Som", () => {
    vibrar("medio");
    alternarSurdo();
  });
  const botaoSons = controle("soundboard", "Sons", () => {
    vibrar("leve");
    abrirSoundboard();
  });
  const botaoChat = controle("responder", "Conversa", () => {
    vibrar("leve");
    irParaAConversa();
  });
  const botaoSair = controle("desligar", "", async () => {
    vibrar("pesado");
    const certeza = await confirmar({
      titulo: "Sair da call?",
      texto: `Você está há ${tempoDeCallEmTexto()} nesta chamada.`,
      confirmar: "Sair da call",
      perigo: true,
    });
    if (!certeza) return;
    sairDaVoz(true);
  });
  botaoSair.classList.add("controle--sair");

  const controles = el(
    "div",
    { class: "call__controles" },
    botaoSons,
    botaoMudo,
    botaoSair,
    botaoSurdo,
    botaoChat
  );

  superficie = el(
    "section",
    { class: "call", role: "dialog", "aria-label": "Chamada em andamento" },
    el("div", { class: "call__fundo", "aria-hidden": "true" }),
    cabecalho,
    palco,
    controles
  );

  document.getElementById("camadas").append(superficie);
  arrastarParaFechar(superficie, palco, () => recolherCall(), { limite: 130 });

  /* ── Desenho ─────────────────────────────────────────────────── */

  /** id -> `<video>` já montado. Um vídeo nunca pode ser recriado num
   *  redesenho: remontar o elemento derruba o fluxo e pisca a imagem. */
  const videos = new Map();
  /** id -> quadro de participante, para acender a borda de quem fala sem
   *  refazer a grade inteira. */
  const quadros = new Map();

  function desenhar() {
    const canal = acharCanal(estado.canalVoz);
    titulo.textContent = canal?.nome ?? "Canal de voz";

    const pessoas = membrosNaVoz(estado.canalVoz);
    limpar(palco);
    quadros.clear();

    // Transmissões primeiro: quem abriu a call para ver a tela de alguém não
    // deveria precisar rolar para achá-la.
    for (const [id, fluxo] of telasRecebidas) {
      palco.append(molduraDeTransmissao(id, fluxo));
    }

    const grade = el("div", {
      class: "grade-voz",
      dataset: { quantos: Math.min(pessoas.length, 3), muitos: pessoas.length > 4 },
    });
    for (const pessoa of pessoas) grade.append(quadroDe(pessoa));
    palco.append(grade);

    const passaram = historicoDaCall.lista();
    if (passaram.length) {
      palco.append(
        el("div", { class: "secao" }, "Já saíram"),
        el(
          "div",
          { class: "grupo" },
          passaram.map((linha) =>
            el(
              "div",
              { class: "linha" },
              el(
                "span",
                { class: "linha__dizeres" },
                el("span", { class: "linha__titulo" }, linha.apelido),
                el(
                  "span",
                  { class: "linha__legenda" },
                  `${linha.exato ? "" : "+"}${Math.round(linha.tempo / 60000)} min na call`
                )
              )
            )
          )
        )
      );
    }

    refletirControles();
    marcarRelogio();
  }

  function quadroDe(pessoa) {
    const quadro = el(
      "div",
      {
        class: "quadro",
        dataset: { falando: falando.has(String(pessoa.id)) },
        onclick: () => {
          vibrar("leve");
          mostrarCartao(pessoa);
        },
      },
      avatar(pessoa, "avatar avatar--gg"),
      pessoa.atividade
        ? el(
            "div",
            { class: "quadro__atividade" },
            icone("raio"),
            el("span", null, pessoa.atividade)
          )
        : null,
      el(
        "div",
        { class: "quadro__nome" },
        pessoa.mudo ? icone("microfone-mudo", "quadro__mudo") : null,
        el("span", null, pessoa.apelido)
      )
    );
    quadros.set(String(pessoa.id), quadro);
    return quadro;
  }

  function molduraDeTransmissao(id, fluxo) {
    let video = videos.get(id);
    if (!video) {
      video = el("video", { autoplay: true, muted: true, playsinline: true });
      video.muted = true;
      video.playsInline = true;
      videos.set(id, video);
    }
    if (video.srcObject !== fluxo) video.srcObject = fluxo;
    video.play().catch(() => {});

    const membro = estado.membros.get(id) ?? estado.membros.get(Number(id));
    const quantos = espectadores.get(String(id))?.size ?? 0;

    return el(
      "div",
      {
        class: "tela-transmitida",
        onclick: () => {
          vibrar("leve");
          abrirHolofote(fluxo, membro?.apelido ?? "Transmissão");
        },
      },
      video,
      el(
        "div",
        { class: "tela-transmitida__faixa" },
        icone("transmitir"),
        el("span", null, `${membro?.apelido ?? "Alguém"} está transmitindo`),
        quantos ? el("span", null, `${quantos} 👀`) : null,
        el("span", { class: "tela-transmitida__botao" }, icone("expandir"))
      )
    );
  }

  function refletirControles() {
    botaoMudo.toggleAttribute("data-ligado", estado.mudo);
    limpar(botaoMudo.querySelector(".controle__icone")).append(
      icone(estado.mudo ? "microfone-mudo" : "microfone")
    );
    botaoMudo.querySelector(".controle__rotulo").textContent = estado.mudo ? "Mudo" : "Falando";

    botaoSurdo.toggleAttribute("data-ligado", estado.surdo);
    limpar(botaoSurdo.querySelector(".controle__icone")).append(
      icone(estado.surdo ? "fone-mudo" : "fone")
    );
    botaoSurdo.querySelector(".controle__rotulo").textContent = estado.surdo ? "Sem som" : "Som";

    const marcaSons = botaoSons.querySelector(".controle__marca");
    if (marcaSons) {
      marcaSons.textContent = String(estado.sons.length);
      marcaSons.hidden = estado.sons.length === 0;
    }
  }

  function marcarRelogio() {
    legenda.textContent = `${estado.grupo?.nome ?? "CALL"} · ${tempoDeCallEmTexto()}`;
  }

  function pintarFala() {
    for (const [id, quadro] of quadros) {
      quadro.toggleAttribute("data-falando", falando.has(id));
    }
  }

  async function irParaAConversa() {
    const canalDeTexto = estado.grupo?.categorias
      ?.flatMap((categoria) => categoria.canais)
      .find((c) => c.tipo === "texto");
    if (!canalDeTexto || !navegacao) {
      avisar("Este grupo não tem canal de texto.");
      return;
    }
    recolherCall();
    setTimeout(() => navegacao.empilhar(abrirConversa(navegacao, { canal: canalDeTexto.id })), 260);
  }

  async function menuDaCall() {
    const escolha = await menu(acharCanal(estado.canalVoz)?.nome ?? "Call", [
      { valor: "pessoas", rotulo: "Quem está na call", legenda: `${membrosNaVoz(estado.canalVoz).length} pessoas`, icone: "amigos" },
      { valor: "sons", rotulo: "Soundboard do grupo", icone: "soundboard" },
      { valor: "recolher", rotulo: "Continuar em segundo plano", icone: "descer" },
      { valor: "sair", rotulo: "Sair da call", icone: "desligar", perigo: true },
    ]);

    if (escolha === "pessoas") {
      recolherCall();
      setTimeout(() => {
        import("./grupos.js").then((modulo) => navegacao?.empilhar(modulo.telaDePresentes(navegacao)));
      }, 260);
    } else if (escolha === "sons") abrirSoundboard();
    else if (escolha === "recolher") recolherCall();
    else if (escolha === "sair") sairDaVoz(true);
  }

  desenhar();

  const cancelarEventos = assinar(["membros", "voz", "tela", "sons", "grupo"], desenhar);
  const cancelarFala = assinar(["fala"], pintarFala);
  const cancelarRelogio = assinar(["relogio"], marcarRelogio);

  desmontar = () => {
    cancelarEventos();
    cancelarFala();
    cancelarRelogio();
    for (const video of videos.values()) {
      video.srcObject = null;
      video.remove();
    }
    videos.clear();
  };
}

function controle(nomeIcone, rotulo, aoTocar) {
  const botao = el(
    "button",
    { class: "controle", type: "button", "aria-label": rotulo || "Sair", onclick: aoTocar },
    el("span", { class: "controle__icone", style: { display: "grid", placeItems: "center" } }, icone(nomeIcone)),
    rotulo ? el("span", { class: "controle__rotulo" }, rotulo) : null,
    nomeIcone === "soundboard" ? el("span", { class: "controle__marca", hidden: true }) : null
  );
  return botao;
}

/* ═══ Holofote: uma transmissão em tela cheia ═══════════════════ */

/**
 * Preto, sem cromo e com pinça para ampliar.
 *
 * A pinça é feita à mão em vez de deixar para o navegador porque o zoom da
 * página inteira arrastaria o cabeçalho e as barras junto — aqui só o vídeo
 * se mexe, e um toque duplo devolve o enquadramento.
 */
export function abrirHolofote(fluxo, rotulo = "") {
  const video = el("video", { autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  video.playsInline = true;
  video.srcObject = fluxo;
  video.play().catch(() => {});

  const camada = el(
    "div",
    { class: "holofote" },
    video,
    el(
      "button",
      {
        class: "holofote__sair",
        type: "button",
        "aria-label": "Fechar",
        onclick: () => fechar(),
      },
      icone("fechar")
    ),
    el("p", { class: "holofote__dica" }, rotulo ? `${rotulo} · pince para ampliar` : "Pince para ampliar")
  );

  document.getElementById("camadas").append(camada);
  document.getElementById("abas")?.setAttribute("data-na-call", "");

  let escala = 1;
  let x = 0;
  let y = 0;
  const dedos = new Map();
  let distanciaInicial = 0;
  let escalaInicial = 1;
  let ultimoToque = 0;

  const aplicar = () => {
    video.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${escala})`;
  };

  video.addEventListener("pointerdown", (evento) => {
    dedos.set(evento.pointerId, { x: evento.clientX, y: evento.clientY });
    if (dedos.size === 2) {
      const [a, b] = [...dedos.values()];
      distanciaInicial = Math.hypot(a.x - b.x, a.y - b.y);
      escalaInicial = escala;
    }
    if (dedos.size === 1) {
      const agora = performance.now();
      if (agora - ultimoToque < 300) {
        escala = escala > 1.05 ? 1 : 2.4;
        x = 0;
        y = 0;
        video.style.transition = "transform 220ms cubic-bezier(0.32,0.72,0,1)";
        aplicar();
        setTimeout(() => (video.style.transition = ""), 240);
      }
      ultimoToque = agora;
    }
  });

  video.addEventListener("pointermove", (evento) => {
    const anterior = dedos.get(evento.pointerId);
    if (!anterior) return;
    const atual = { x: evento.clientX, y: evento.clientY };

    if (dedos.size === 2) {
      dedos.set(evento.pointerId, atual);
      const [a, b] = [...dedos.values()];
      const distancia = Math.hypot(a.x - b.x, a.y - b.y);
      if (distanciaInicial > 0) {
        escala = Math.min(5, Math.max(1, (escalaInicial * distancia) / distanciaInicial));
      }
    } else if (escala > 1.02) {
      x += atual.x - anterior.x;
      y += atual.y - anterior.y;
      dedos.set(evento.pointerId, atual);
    } else {
      dedos.set(evento.pointerId, atual);
    }
    aplicar();
  });

  const soltar = (evento) => {
    dedos.delete(evento.pointerId);
    if (dedos.size < 2) distanciaInicial = 0;
    if (escala <= 1.02) {
      escala = 1;
      x = 0;
      y = 0;
      video.style.transition = "transform 200ms ease";
      aplicar();
      setTimeout(() => (video.style.transition = ""), 220);
    }
  };
  video.addEventListener("pointerup", soltar);
  video.addEventListener("pointercancel", soltar);

  function fechar() {
    vibrar("leve");
    video.srcObject = null;
    camada.remove();
    if (callAberta()) document.getElementById("abas")?.setAttribute("data-na-call", "");
    else document.getElementById("abas")?.removeAttribute("data-na-call");
  }

  return { fechar };
}
