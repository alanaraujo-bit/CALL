/**
 * Navegação em pilha, uma pilha por aba.
 *
 * É a peça que mais separa "site aberto no celular" de "aplicativo": telas
 * entram pela direita empurrando a anterior, a anterior continua viva atrás
 * (com o conteúdo, a rolagem e os vídeos onde estavam), e arrastar da borda
 * esquerda traz de volta seguindo o dedo — não uma animação disparada depois
 * do gesto, o dedo mesmo, quadro a quadro.
 *
 * ## Por que uma pilha por aba
 *
 * Sair de "Grupos → Estúdio → #geral" para ver Amigos e voltar tem que
 * devolver #geral, e não a lista de grupos. Uma pilha só faria a troca de aba
 * apagar o caminho, que é o erro clássico de navegação por abas na web.
 *
 * ## Sobre o botão "voltar" do sistema
 *
 * A pilha é desta classe; o histórico do navegador guarda **um degrau só**,
 * como campainha (ver `sincronizarGuarda`, em `interacao.js`). A seta do
 * cabeçalho, o gesto da borda e o botão do Android chamam todos o mesmo
 * `#desempilharDeFato` — nenhum deles passa por `history.back()`, que é
 * assíncrono e por isso não pode ser o mecanismo de uma navegação que aceita
 * toques em sequência.
 */

import { el, vibrar, registrarNavegacao, sincronizarGuarda } from "./interacao.js";
import { icone } from "./icones.js";

/** Quanto a tela de trás recua enquanto a da frente cobre. */
const RECUO = 0.22;
/** Escuridão máxima sobre a tela de trás. */
const VEU = 0.3;
/** Faixa da borda esquerda que começa o gesto de voltar. */
const BORDA = 26;

export class Navegacao {
  #hospede;
  #pilhas = new Map(); // nome da aba -> [tela]
  #aba = null;
  #ordemDeAbas = [];
  #animando = false;
  #gestoAtivo = null;
  #popPorGesto = false;
  #aoTrocarAba = null;

  /**
   * @param hospede elemento que recebe as telas (`#pilha`)
   * @param abas nomes das abas, na ordem em que aparecem
   */
  constructor(hospede, abas, { aoTrocarAba = null } = {}) {
    this.#hospede = hospede;
    this.#ordemDeAbas = [...abas];
    for (const nome of abas) this.#pilhas.set(nome, []);
    this.#aba = abas[0];
    this.#aoTrocarAba = aoTrocarAba;

    registrarNavegacao({
      voltar: () => this.#desempilharDeFato(),
      podeVoltar: () => this.profundidade > 1,
    });
    this.#ligarGesto();
  }

  get aba() {
    return this.#aba;
  }

  get profundidade() {
    return this.#pilhas.get(this.#aba).length;
  }

  /** A tela no topo da aba corrente. */
  get topo() {
    const pilha = this.#pilhas.get(this.#aba);
    return pilha[pilha.length - 1] ?? null;
  }

  /** Todas as telas vivas, de todas as abas — para redesenhos globais. */
  *todas() {
    for (const pilha of this.#pilhas.values()) yield* pilha;
  }

  /* ── Montagem ─────────────────────────────────────────────── */

  /** Define (ou troca) a tela de base de uma aba. */
  definirRaiz(nomeDaAba, tela) {
    const pilha = this.#pilhas.get(nomeDaAba);
    if (!pilha) throw new Error(`Aba desconhecida: ${nomeDaAba}`);

    for (const antiga of pilha.splice(0)) this.#destruir(antiga);
    tela.elemento.dataset.pilha = nomeDaAba;
    pilha.push(tela);
    this.#hospede.append(tela.elemento);
    this.#refletir();
    if (nomeDaAba === this.#aba) tela.aoEntrar?.();
    return tela;
  }

  /** Empurra uma tela por cima da atual. */
  empilhar(tela) {
    // Um toque que chega no meio da animação anterior não pode ser perdido:
    // do lado de quem usa, o botão simplesmente não teria funcionado. A tela
    // espera a pista ficar livre e entra logo em seguida.
    if (this.#animando) {
      setTimeout(() => this.empilhar(tela), 60);
      return tela;
    }
    const pilha = this.#pilhas.get(this.#aba);
    const anterior = pilha[pilha.length - 1];

    tela.elemento.dataset.pilha = this.#aba;
    tela.elemento.style.transform = "translate3d(100%,0,0)";
    this.#garantirVeu(tela.elemento);
    this.#hospede.append(tela.elemento);
    pilha.push(tela);
    sincronizarGuarda();

    // Um quadro para o navegador aceitar a posição inicial antes de animar.
    requestAnimationFrame(() => {
      this.#animando = true;
      this.#animar(tela.elemento, 0, 0);
      if (anterior) this.#animar(anterior.elemento, -RECUO * 100, VEU);
      setTimeout(() => {
        this.#animando = false;
        this.#refletir();
        anterior?.aoSair?.();
        tela.aoEntrar?.();
      }, 350);
    });

    return tela;
  }

  /** Volta uma tela. Mesmo caminho da seta, do gesto e do botão do sistema. */
  voltar() {
    if (this.profundidade <= 1) {
      // Na raiz de uma aba que não é a primeira, voltar é ir para a primeira.
      if (this.#aba !== this.#ordemDeAbas[0]) this.trocarAba(this.#ordemDeAbas[0]);
      return false;
    }
    this.#desempilharDeFato();
    return true;
  }

  /**
   * Volta até a raiz da aba corrente.
   *
   * As telas do meio saem sem animação — animar quatro saídas em sequência
   * seria um segundo inteiro de tela voando. Só a última anima, que é a única
   * que alguém vê.
   */
  voltarAoInicio() {
    const pilha = this.#pilhas.get(this.#aba);
    while (pilha.length > 2) this.#destruir(pilha.pop());
    if (pilha.length > 1) this.#desempilharDeFato();
    else this.#refletir();
  }

  #desempilharDeFato() {
    const pilha = this.#pilhas.get(this.#aba);
    if (pilha.length <= 1) return;

    const saindo = pilha.pop();
    const voltando = pilha[pilha.length - 1];
    const doGesto = this.#popPorGesto;
    this.#popPorGesto = false;
    sincronizarGuarda();

    this.#animando = true;
    voltando.aoEntrar?.();
    this.#animar(saindo.elemento, 100, 0);
    this.#animar(voltando.elemento, 0, 0);

    setTimeout(
      () => {
        this.#animando = false;
        saindo.aoSair?.();
        this.#destruir(saindo);
        this.#refletir();
      },
      doGesto ? 300 : 350
    );
  }

  #destruir(tela) {
    tela.aoDestruir?.();
    tela.elemento.remove();
  }

  /* ── Abas ─────────────────────────────────────────────────── */

  trocarAba(nome) {
    if (nome === this.#aba || !this.#pilhas.has(nome)) return;
    const anterior = this.topo;
    this.#aba = nome;
    this.#refletir();
    anterior?.aoSair?.();
    this.topo?.aoEntrar?.();
    // A aba nova pode ter uma pilha funda (ou nenhuma): a guarda do botão
    // "voltar" acompanha o que passou a estar na frente.
    sincronizarGuarda();
    this.#aoTrocarAba?.(nome);
  }

  /* ── Desenho ──────────────────────────────────────────────── */

  #garantirVeu(elemento) {
    if (!elemento.querySelector(":scope > .tela__veu")) {
      elemento.prepend(el("div", { class: "tela__veu", "aria-hidden": "true" }));
    }
  }

  /**
   * Põe cada tela no lugar sem animação — depois de empilhar, desempilhar ou
   * trocar de aba. Só as duas do topo de cada pilha ficam visíveis: a
   * terceira para trás está coberta por duas camadas opacas e só custaria
   * pintura.
   */
  #refletir() {
    // Telas fundas — conversa, call, ajustes com formulário — pedem a altura
    // inteira. A barra de abas volta sozinha ao desempilhar.
    document
      .getElementById("abas")
      ?.toggleAttribute("data-recolhida", Boolean(this.topo?.semAbas));

    for (const [nome, pilha] of this.#pilhas) {
      const ativa = nome === this.#aba;
      pilha.forEach((tela, indice) => {
        const doTopo = pilha.length - 1 - indice;
        const visivel = ativa && doTopo <= 1;
        tela.elemento.toggleAttribute("data-aba-oculta", !visivel);
        delete tela.elemento.dataset.animando;
        if (!visivel) return;
        this.#garantirVeu(tela.elemento);
        tela.elemento.style.transform =
          doTopo === 0 ? "translate3d(0,0,0)" : `translate3d(${-RECUO * 100}%,0,0)`;
        const veu = tela.elemento.querySelector(":scope > .tela__veu");
        if (veu) veu.style.opacity = doTopo === 0 ? "0" : String(VEU);
      });
    }
  }

  #animar(elemento, porcentagem, veuOpacidade) {
    this.#garantirVeu(elemento);
    elemento.dataset.animando = "";
    elemento.style.transform = `translate3d(${porcentagem}%,0,0)`;
    const veu = elemento.querySelector(":scope > .tela__veu");
    if (veu) veu.style.opacity = String(veuOpacidade);
  }

  #posicionar(elemento, porcentagem, veuOpacidade) {
    delete elemento.dataset.animando;
    elemento.style.transform = `translate3d(${porcentagem}%,0,0)`;
    const veu = elemento.querySelector(":scope > .tela__veu");
    if (veu) veu.style.opacity = String(veuOpacidade);
  }

  /* ── Gesto de voltar ──────────────────────────────────────── */

  /**
   * Arrastar da borda esquerda.
   *
   * Três detalhes que fazem o gesto parecer nativo em vez de parecer um
   * `swipe` genérico:
   *
   * - **Ele acompanha o dedo**, sem transição CSS ligada durante o arrasto.
   * - **Ele desiste**: se o movimento for mais vertical que horizontal nos
   *   primeiros pixels, era rolagem, e o gesto se cancela sem piscar nada.
   * - **Ele conclui por velocidade**, não só por distância: um peteleco curto
   *   e rápido volta, do mesmo jeito que um arrasto lento até o meio da tela.
   */
  #ligarGesto() {
    const hospede = this.#hospede;

    hospede.addEventListener(
      "pointerdown",
      (evento) => {
        if (this.#animando || this.#gestoAtivo) return;
        if (evento.pointerType === "mouse" && evento.button !== 0) return;
        if (this.profundidade <= 1) return;
        if (evento.clientX > BORDA) return;

        const pilha = this.#pilhas.get(this.#aba);
        this.#gestoAtivo = {
          x0: evento.clientX,
          y0: evento.clientY,
          t0: performance.now(),
          largura: hospede.clientWidth || window.innerWidth,
          decidido: false,
          valendo: false,
          topo: pilha[pilha.length - 1].elemento,
          fundo: pilha[pilha.length - 2].elemento,
          dx: 0,
        };
      },
      { passive: true }
    );

    hospede.addEventListener(
      "pointermove",
      (evento) => {
        const g = this.#gestoAtivo;
        if (!g) return;
        const dx = evento.clientX - g.x0;
        const dy = evento.clientY - g.y0;

        if (!g.decidido) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          g.decidido = true;
          g.valendo = Math.abs(dx) > Math.abs(dy);
          if (!g.valendo) {
            this.#gestoAtivo = null;
            return;
          }
          // A tela de trás precisa estar pintada antes do primeiro quadro do
          // arrasto, senão o gesto começa mostrando o fundo do aplicativo.
          g.fundo.removeAttribute("data-aba-oculta");
        }
        if (!g.valendo) return;

        g.dx = Math.max(0, Math.min(dx, g.largura));
        const razao = g.dx / g.largura;
        this.#posicionar(g.topo, razao * 100, 0);
        this.#posicionar(g.fundo, -RECUO * 100 * (1 - razao), VEU * (1 - razao));
      },
      { passive: true }
    );

    const soltar = () => {
      const g = this.#gestoAtivo;
      if (!g) return;
      this.#gestoAtivo = null;
      if (!g.valendo) return;

      const velocidade = g.dx / Math.max(1, performance.now() - g.t0);
      if (g.dx > g.largura * 0.36 || velocidade > 0.55) {
        this.#popPorGesto = true;
        vibrar("leve");
        this.#desempilharDeFato();
      } else {
        this.#animar(g.topo, 0, 0);
        this.#animar(g.fundo, -RECUO * 100, VEU);
        setTimeout(() => this.#refletir(), 350);
      }
    };

    hospede.addEventListener("pointerup", soltar, { passive: true });
    hospede.addEventListener("pointercancel", soltar, { passive: true });
  }
}

/* ═══ Construção de telas ═══════════════════════════════════════ */

/**
 * Monta o esqueleto padrão de uma tela: cabeçalho fixo translúcido e corpo
 * rolável por baixo dele.
 *
 * Devolve `{ elemento, cabecalho, corpo, titulo, legenda, definirTitulo,
 * definirLegenda }` — quem chama preenche o corpo e mexe nos títulos sem
 * precisar conhecer as classes.
 */
export function montarTela({
  titulo = "",
  legenda = "",
  voltar = null,
  acoes = [],
  aoEsquerda = null,
  centrado = false,
  semCabecalho = false,
  corpoProprio = null,
} = {}) {
  const noTitulo = el("span", { class: "cabecalho__titulo" }, titulo);
  const noLegenda = el("span", { class: "cabecalho__legenda" }, legenda);
  noLegenda.hidden = !legenda;

  const cabecalho = semCabecalho
    ? null
    : el(
        "header",
        { class: `cabecalho${centrado ? " cabecalho--centrado" : ""}` },
        voltar
          ? el(
              "button",
              {
                class: "acao",
                type: "button",
                "aria-label": "Voltar",
                onclick: () => {
                  vibrar("leve");
                  voltar();
                },
              },
              icone("voltar")
            )
          : aoEsquerda,
        el("div", { class: "cabecalho__titulos" }, noTitulo, noLegenda),
        ...acoes
      );

  const corpo =
    corpoProprio ?? el("div", { class: `corpo${semCabecalho ? " corpo--sem-cabecalho" : ""}` });

  const elemento = el(
    "section",
    { class: "tela" },
    el("div", { class: "tela__veu", "aria-hidden": "true" }),
    cabecalho,
    corpo
  );

  // A borda do cabeçalho só aparece quando há conteúdo passando por baixo —
  // é o sinal de que existe mais coisa acima do que a tela mostra.
  if (cabecalho) {
    const alvo = corpo;
    alvo.addEventListener(
      "scroll",
      () => {
        cabecalho.toggleAttribute("data-rolado", alvo.scrollTop > 4);
      },
      { passive: true }
    );
  }

  return {
    elemento,
    cabecalho,
    corpo,
    definirTitulo(texto) {
      noTitulo.textContent = texto;
    },
    definirLegenda(texto, viva = false) {
      noLegenda.textContent = texto ?? "";
      noLegenda.hidden = !texto;
      noLegenda.classList.toggle("cabecalho__legenda--viva", Boolean(viva));
    },
  };
}
