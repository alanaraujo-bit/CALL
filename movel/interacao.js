/**
 * As peças de interação que todo o resto do aplicativo usa.
 *
 * Reúne quatro coisas que, num app de celular, aparecem em toda tela e
 * precisam se comportar igual em todas elas:
 *
 * 1. **Montar DOM** (`el`) — sem framework, mas também sem `innerHTML +=`
 *    espalhado, que é como uma interface pequena vira uma interface lenta.
 * 2. **Resposta ao toque** (`vibrar`) — o retorno tátil que separa "cliquei"
 *    de "será que cliquei?". No Android é `navigator.vibrate`; no iOS não
 *    existe API nenhuma, e a chamada simplesmente não faz nada.
 * 3. **Camadas** — folhas de baixo para cima, menus, confirmações e avisos.
 *    Todas ancoradas no mesmo `#camadas`, todas dispensáveis pelo botão
 *    "voltar" do Android (ver `historia`), todas arrastáveis com o dedo.
 * 4. **Teclado** — a `visualViewport` avisa quanto da tela sumiu, e o valor
 *    vira a variável CSS `--teclado`, que o compositor de mensagem usa.
 */

import { icone, svgDe } from "./icones.js";

/* ═══ Montagem de DOM ═══════════════════════════════════════════ */

/**
 * `el("div", { class: "x", onclick })` — e filhos como texto, nó ou lista.
 *
 * Chaves que começam com "on" viram ouvintes; `dataset` e `style` aceitam
 * objeto; o resto vira atributo. `null`/`undefined`/`false` entre os filhos
 * somem, o que deixa `condicao && el(...)` escrever bem.
 */
export function el(tag, props = null, ...filhos) {
  const no = document.createElement(tag);

  for (const [chave, valor] of Object.entries(props ?? {})) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (chave.startsWith("on") && typeof valor === "function") {
      no.addEventListener(chave.slice(2), valor, { passive: chave === "ontouchstart" });
    } else if (chave === "dataset") {
      for (const [d, v] of Object.entries(valor)) {
        if (v !== null && v !== undefined && v !== false) no.dataset[d] = v === true ? "" : v;
      }
    } else if (chave === "style" && typeof valor === "object") {
      Object.assign(no.style, valor);
    } else if (chave === "html") {
      no.innerHTML = valor;
    } else if (chave === "texto") {
      no.textContent = valor;
    } else if (valor === true) {
      no.setAttribute(chave, "");
    } else {
      no.setAttribute(chave, valor);
    }
  }

  adicionar(no, filhos);
  return no;
}

function adicionar(pai, filhos) {
  for (const filho of filhos) {
    if (filho === null || filho === undefined || filho === false) continue;
    if (Array.isArray(filho)) adicionar(pai, filho);
    else pai.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
  }
}

/**
 * `pai.append(x)` com `x` nulo escreve o texto "null" na tela — o DOM
 * converte para string em vez de ignorar. Esta função é o `append` que a
 * interface quer: o que for nulo, falso ou indefinido simplesmente não entra.
 */
export function anexar(pai, ...filhos) {
  adicionar(pai, filhos);
  return pai;
}

export const limpar = (no) => {
  while (no.firstChild) no.firstChild.remove();
  return no;
};

/* ═══ Toque ═════════════════════════════════════════════════════ */

/**
 * Retorno tátil.
 *
 * Os padrões são curtos de propósito: um telefone que treme meio segundo a
 * cada toque é um telefone que a pessoa desliga. `leve` é confirmação de
 * toque, `medio` é mudança de estado, `pesado` é começo ou fim de call, e
 * `erro` é o único com duas batidas — a assinatura de que algo não deu certo.
 */
const PADROES = { leve: 8, medio: 14, pesado: 24, erro: [12, 60, 12], sucesso: [10, 40, 18] };
let taticoLigado = true;

export function definirTatico(ligado) {
  taticoLigado = Boolean(ligado);
}

export function vibrar(tipo = "leve") {
  if (!taticoLigado) return;
  try {
    navigator.vibrate?.(PADROES[tipo] ?? PADROES.leve);
  } catch {
    /* aparelho sem vibração, ou usuário sem permissão — segue sem */
  }
}

/**
 * Pressão longa, com o cancelamento que a versão ingênua esquece: se o dedo
 * anda mais de 10 px, era rolagem, e não pressão. Sem isso, rolar a conversa
 * abriria o menu da mensagem embaixo do polegar a cada dois arrastos.
 */
export function pressaoLonga(alvo, acao, { ms = 480, tolerancia = 10 } = {}) {
  let relogio = null;
  let inicio = null;
  let disparou = false;

  const cancelar = () => {
    clearTimeout(relogio);
    relogio = null;
    inicio = null;
  };

  alvo.addEventListener(
    "pointerdown",
    (evento) => {
      if (evento.pointerType === "mouse" && evento.button !== 0) return;
      disparou = false;
      inicio = { x: evento.clientX, y: evento.clientY };
      relogio = setTimeout(() => {
        disparou = true;
        vibrar("medio");
        acao(evento);
      }, ms);
    },
    { passive: true }
  );

  alvo.addEventListener(
    "pointermove",
    (evento) => {
      if (!inicio) return;
      if (Math.hypot(evento.clientX - inicio.x, evento.clientY - inicio.y) > tolerancia) cancelar();
    },
    { passive: true }
  );

  for (const nome of ["pointerup", "pointercancel", "pointerleave"]) {
    alvo.addEventListener(nome, cancelar, { passive: true });
  }

  // Depois de uma pressão longa, o toque que a encerra não deve também
  // "clicar" no que estava embaixo.
  alvo.addEventListener("click", (evento) => {
    if (!disparou) return;
    disparou = false;
    evento.preventDefault();
    evento.stopPropagation();
  });
}

/* ═══ História: o botão "voltar" do Android ═════════════════════ */

/**
 * Um degrau só, e não um por tela.
 *
 * A tentação é empurrar uma entrada de `history` por folha aberta e por tela
 * empilhada, contando para desfazer. Não funciona: fechar uma folha pede
 * `history.back()`, que é **assíncrono**, e no intervalo entre pedir e o
 * `popstate` chegar já houve tempo de empilhar outra tela — o `back` atrasado
 * derruba a tela errada. Foi exatamente esse embaralhamento que fez a volta
 * parar de desempilhar durante o desenvolvimento.
 *
 * O que se faz aqui é manter **um único degrau de guarda** enquanto existir
 * qualquer coisa para voltar. O `history` deixa de ser a memória da navegação
 * e vira só a campainha do botão do sistema: quando ela toca, o aplicativo
 * decide sozinho o que fechar — a camada de cima, ou a tela de cima.
 *
 * A guarda **só é posta, nunca retirada**. Retirá-la exigiria um
 * `history.back()` nosso, assíncrono, que voltaria a embaralhar tudo — e o
 * preço de não retirar é pequeno e conhecido: depois de fechar a última folha
 * com o dedo, o primeiro toque no "voltar" do sistema gasta a guarda vazia
 * sem fazer nada visível, e o segundo sai do aplicativo. Numa tela de raiz
 * isso não é defeito: é a proteção contra sair do app sem querer que o
 * Android já espera.
 */
const camadasAbertas = [];
let guardaPosta = false;
let historiaPreparada = false;

/** Quem sabe desempilhar tela, e quem sabe dizer se ainda dá para voltar. */
let voltarTela = null;
let podeVoltarTela = () => false;

function prepararHistoria() {
  if (historiaPreparada) return;
  historiaPreparada = true;
  history.replaceState({ call: "raiz" }, "");

  window.addEventListener("popstate", () => {
    guardaPosta = false;
    const camada = camadasAbertas[camadasAbertas.length - 1];
    if (camada) camada.fechar();
    else voltarTela?.();
    sincronizarGuarda();
  });
}

function precisaDeGuarda() {
  return camadasAbertas.length > 0 || podeVoltarTela();
}

/** Garante a guarda quando passa a haver aonde voltar. */
export function sincronizarGuarda() {
  prepararHistoria();
  if (!guardaPosta && precisaDeGuarda()) {
    guardaPosta = true;
    history.pushState({ call: "guarda" }, "");
  }
}

/** A navegação em telas se apresenta uma vez, na partida. */
export function registrarNavegacao({ voltar, podeVoltar }) {
  prepararHistoria();
  voltarTela = voltar;
  podeVoltarTela = podeVoltar;
  sincronizarGuarda();
}

/* ═══ Avisos ════════════════════════════════════════════════════ */

const camadas = () => document.getElementById("camadas");
let pilhaDeAvisos = null;

/**
 * O aviso curto. Nasce embaixo da barra de status, e não no rodapé: o rodapé
 * de um app de celular é onde ficam o polegar e os controles da call, e um
 * aviso ali some debaixo da mão de quem está usando.
 */
export function avisar(texto, tom = "neutro", ms = 3000) {
  if (!pilhaDeAvisos) {
    pilhaDeAvisos = el("div", { class: "avisos", role: "status", "aria-live": "polite" });
    camadas().append(pilhaDeAvisos);
  }

  const glifo = tom === "erro" ? "alerta" : tom === "bom" ? "check" : "informacao";
  const no = el("div", { class: `aviso aviso--${tom}` }, icone(glifo), el("span", null, texto));
  pilhaDeAvisos.append(no);
  if (tom === "erro") vibrar("erro");

  // Mais de três avisos empilhados é ruído: o mais antigo sai na hora.
  while (pilhaDeAvisos.children.length > 3) pilhaDeAvisos.firstElementChild.remove();

  const sair = () => {
    if (!no.isConnected) return;
    no.dataset.saindo = "";
    setTimeout(() => no.remove(), 240);
  };
  const relogio = setTimeout(sair, ms);
  no.addEventListener("pointerdown", () => {
    clearTimeout(relogio);
    sair();
  });
  return sair;
}

/* ═══ Folhas ════════════════════════════════════════════════════ */

/**
 * A folha que sobe de baixo — a caixa de diálogo do celular.
 *
 * Fecha de quatro maneiras, e todas passam por `fechar`: toque na cortina,
 * arrasto para baixo, botão do sistema e `.fechar()` de quem abriu.
 *
 * O arrasto tem freio de borracha para cima (`raiz` de 0,35) porque uma folha
 * que sobe além do topo ao ser puxada parece quebrada; e só compromete o
 * fechamento por distância *ou* por velocidade, que é como o iOS decide — um
 * peteleco curto e rápido fecha, um arrasto longo e lento também.
 */
export function abrirFolha({
  titulo = "",
  texto = "",
  conteudo = null,
  acoes = null,
  acoesEmPar = false,
  corpoLiso = false,
  punho = true,
  fecharPorFora = true,
  aoFechar = null,
} = {}) {
  const cortina = el("div", { class: "cortina" });
  const folha = el("div", { class: "folha", role: "dialog", "aria-modal": "true" });

  const corpo = el("div", {
    class: `folha__corpo${corpoLiso ? " folha__corpo--liso" : ""}`,
  });
  if (conteudo) adicionar(corpo, [conteudo]);

  folha.append(
    ...[
      punho ? el("div", { class: "folha__punho" }) : null,
      titulo ? el("div", { class: "folha__cabecalho" }, el("h2", { class: "folha__titulo" }, titulo)) : null,
      texto ? el("p", { class: "folha__texto" }, texto) : null,
      corpo,
      acoes
        ? el("div", { class: `folha__acoes${acoesEmPar ? " folha__acoes--par" : ""}` }, acoes)
        : null,
    ].filter(Boolean)
  );

  camadas().append(cortina, folha);

  let fechada = false;
  const registro = { fechar: () => fechar() };

  function fechar() {
    if (fechada) return;
    fechada = true;
    const indice = camadasAbertas.indexOf(registro);
    if (indice >= 0) camadasAbertas.splice(indice, 1);
    sincronizarGuarda();

    folha.dataset.animando = "";
    folha.style.removeProperty("--arrasto");
    delete folha.dataset.aberta;
    cortina.removeAttribute("data-visivel");
    setTimeout(() => {
      folha.remove();
      cortina.remove();
      aoFechar?.();
    }, 340);
  }

  camadasAbertas.push(registro);
  sincronizarGuarda();

  if (fecharPorFora) cortina.addEventListener("click", () => fechar());

  // Dois quadros: o primeiro insere, o segundo anima. Sem isso o navegador
  // agrupa inserção e mudança de estado, e a folha aparece já aberta.
  requestAnimationFrame(() => {
    folha.dataset.animando = "";
    requestAnimationFrame(() => {
      folha.dataset.aberta = "";
      cortina.dataset.visivel = "";
    });
  });

  arrastarParaFechar(folha, corpo, () => fechar());

  return registro;
}

/**
 * Liga o arrasto vertical de uma superfície modal ao seu fechamento.
 *
 * `rolavel` é o que pode ter rolagem própria: enquanto ele não estiver no
 * topo, puxar para baixo é rolar, e não fechar. É a mesma regra do iOS, e é
 * o que evita que a folha fuja quando alguém tenta ler uma lista longa.
 */
export function arrastarParaFechar(superficie, rolavel, fechar, { limite = 110 } = {}) {
  let ativo = false;
  let y0 = 0;
  let t0 = 0;
  let y = 0;

  const alcaAlta = () => superficie.querySelector(".folha__punho");

  superficie.addEventListener(
    "pointerdown",
    (evento) => {
      if (evento.pointerType === "mouse" && evento.button !== 0) return;
      const noPunho = alcaAlta()?.contains(evento.target);
      const noTopo = !rolavel || rolavel.scrollTop <= 0;
      if (!noPunho && !noTopo) return;
      // Campos de texto e controles deslizantes têm gesto próprio.
      if (evento.target.closest("input, textarea, [contenteditable], .escala")) return;
      ativo = true;
      y0 = evento.clientY;
      t0 = performance.now();
      y = 0;
      delete superficie.dataset.animando;
    },
    { passive: true }
  );

  superficie.addEventListener(
    "pointermove",
    (evento) => {
      if (!ativo) return;
      const bruto = evento.clientY - y0;
      // Puxar para cima quase não anda: a folha já está no lugar dela.
      y = bruto > 0 ? bruto : bruto * 0.28;
      if (bruto > 0 && rolavel && rolavel.scrollTop > 0) {
        ativo = false;
        superficie.style.removeProperty("--arrasto");
        return;
      }
      superficie.style.setProperty("--arrasto", `${y}px`);
    },
    { passive: true }
  );

  const soltar = () => {
    if (!ativo) return;
    ativo = false;
    const velocidade = y / Math.max(1, performance.now() - t0); // px por ms
    superficie.dataset.animando = "";
    if (y > limite || velocidade > 0.7) {
      vibrar("leve");
      fechar();
    } else {
      superficie.style.removeProperty("--arrasto");
    }
  };

  superficie.addEventListener("pointerup", soltar, { passive: true });
  superficie.addEventListener("pointercancel", soltar, { passive: true });
}

/* ═══ Menu, confirmação e formulário ════════════════════════════ */

/**
 * Menu de ações em folha. Resolve com o `valor` do item escolhido, ou `null`
 * se a pessoa desistiu — o que deixa `if (!escolha) return;` bastar.
 *
 * Cada item: `{ valor, rotulo, legenda, icone, perigo }`.
 */
export function menu(titulo, itens, { texto = "" } = {}) {
  return new Promise((resolver) => {
    let escolhido = null;
    const lista = el(
      "div",
      null,
      itens
        .filter(Boolean)
        .map((item) =>
          el(
            "button",
            {
              class: `menu-item${item.perigo ? " menu-item--perigo" : ""}`,
              type: "button",
              onclick: () => {
                vibrar("leve");
                escolhido = item.valor;
                folha.fechar();
              },
            },
            item.icone ? icone(item.icone) : el("span", { style: { width: "21px" } }),
            el(
              "span",
              { class: "menu-item__dizeres" },
              item.rotulo,
              item.legenda ? el("span", { class: "menu-item__legenda" }, item.legenda) : null
            )
          )
        )
    );

    const folha = abrirFolha({
      titulo,
      texto,
      conteudo: lista,
      corpoLiso: true,
      aoFechar: () => resolver(escolhido),
    });
  });
}

/** Confirmação de duas saídas. Resolve `true` só se a pessoa confirmou. */
export function confirmar({
  titulo,
  texto = "",
  confirmar: rotulo = "Confirmar",
  cancelar = "Cancelar",
  perigo = false,
} = {}) {
  return new Promise((resolver) => {
    let resposta = false;
    const folha = abrirFolha({
      titulo,
      texto,
      acoes: [
        el(
          "button",
          {
            class: `botao ${perigo ? "botao--perigo" : "botao--primario"}`,
            type: "button",
            onclick: () => {
              resposta = true;
              vibrar("medio");
              folha.fechar();
            },
          },
          rotulo
        ),
        el(
          "button",
          { class: "botao botao--fantasma", type: "button", onclick: () => folha.fechar() },
          cancelar
        ),
      ],
      aoFechar: () => resolver(resposta),
    });
  });
}

/**
 * Formulário curto em folha — nome de canal, código de convite, e por aí.
 *
 * `campos`: `[{ nome, rotulo, valor, placeholder, tipo, maximo, obrigatorio,
 * inputmode, autocapitalize, area }]`. Resolve com um objeto de valores, ou
 * `null` se desistiu.
 */
export function perguntar({
  titulo,
  texto = "",
  campos = [],
  confirmar: rotulo = "Confirmar",
  perigo = false,
} = {}) {
  return new Promise((resolver) => {
    let resposta = null;
    const entradas = new Map();

    const corpo = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "14px" } },
      campos.map((campo) => {
        const entrada = campo.area
          ? el("textarea", {
              class: "campo__area",
              maxlength: campo.maximo ?? 500,
              placeholder: campo.placeholder ?? "",
              rows: 3,
            })
          : el("input", {
              class: "campo__entrada",
              type: campo.tipo ?? "text",
              maxlength: campo.maximo ?? 200,
              placeholder: campo.placeholder ?? "",
              inputmode: campo.inputmode,
              autocapitalize: campo.autocapitalize ?? "sentences",
              autocomplete: campo.autocomplete ?? "off",
              autocorrect: "off",
              spellcheck: "false",
            });
        entrada.value = campo.valor ?? "";
        entradas.set(campo.nome, entrada);

        if (!campo.area) {
          entrada.addEventListener("keydown", (evento) => {
            if (evento.key === "Enter") {
              evento.preventDefault();
              enviar();
            }
          });
        }

        return el(
          "label",
          { class: "campo" },
          campo.rotulo ? el("span", { class: "campo__rotulo" }, campo.rotulo) : null,
          campo.area ? entrada : el("div", { class: "campo__caixa" }, entrada)
        );
      })
    );

    function enviar() {
      const valores = {};
      for (const [nome, entrada] of entradas) valores[nome] = entrada.value.trim();
      const faltando = campos.find((c) => c.obrigatorio && !valores[c.nome]);
      if (faltando) {
        entradas.get(faltando.nome).focus();
        vibrar("erro");
        return;
      }
      resposta = valores;
      folha.fechar();
    }

    const folha = abrirFolha({
      titulo,
      texto,
      conteudo: corpo,
      acoes: [
        el(
          "button",
          {
            class: `botao ${perigo ? "botao--perigo" : "botao--primario"}`,
            type: "button",
            onclick: enviar,
          },
          rotulo
        ),
        el(
          "button",
          { class: "botao botao--fantasma", type: "button", onclick: () => folha.fechar() },
          "Cancelar"
        ),
      ],
      aoFechar: () => resolver(resposta),
    });

    // O foco vem depois da animação: focar durante a subida faz o teclado
    // abrir no meio do movimento e a folha chegar torta.
    setTimeout(() => {
      const primeiro = entradas.values().next().value;
      primeiro?.focus();
    }, 360);
  });
}

/* ═══ Teclado ═══════════════════════════════════════════════════ */

/** Tipos de `<input>` que não chamam teclado nenhum na tela. */
const TIPOS_SEM_TECLADO = new Set(["checkbox", "radio", "button", "submit", "range", "color", "file"]);

/** Se o elemento em foco é o tipo de campo que abre teclado (ou seletor). */
export function chamaTeclado(alvo) {
  if (!alvo) return false;
  if (alvo.tagName === "TEXTAREA" || alvo.tagName === "SELECT" || alvo.isContentEditable) return true;
  return alvo.tagName === "INPUT" && !TIPOS_SEM_TECLADO.has(alvo.type);
}

/**
 * Quanto da tela o teclado está ocupando, a partir das três medidas da
 * `visualViewport` — pura, sem tocar em `window`, pra caber num teste.
 *
 * A `visualViewport` é a única fonte honesta disso: no iOS a janela não
 * encolhe quando o teclado sobe, ela só rola por baixo — e um app que confia
 * em `window.innerHeight` acaba com o campo de texto escondido atrás do
 * teclado, que é o defeito clássico de PWA no iPhone.
 *
 * Mas a mesma conta também dá positivo quando quem sumiu foi a barra do
 * Safari, não o teclado — rolar a tela basta. Sem essa guarda, o rodapé
 * (`.app`, `.folha`, `.portal`) sobe achando que há teclado, e sobra um vão
 * embaixo onde a barra costumava estar. Só confiamos na medida com um campo
 * de fato em foco — daí o `temFoco`.
 */
export function medirTeclado({ innerHeight, alturaVisivel, topoVisivel, temFoco }) {
  if (!temFoco) return 0;
  return Math.max(0, Math.round(innerHeight - alturaVisivel - topoVisivel));
}

export function acompanharTeclado(aoMudar = null) {
  const vv = window.visualViewport;
  if (!vv) return;

  let ultimo = -1;
  const medir = () => {
    const valor = medirTeclado({
      innerHeight: window.innerHeight,
      alturaVisivel: vv.height,
      topoVisivel: vv.offsetTop,
      temFoco: chamaTeclado(document.activeElement),
    });
    if (Math.abs(valor - ultimo) < 2) return;
    ultimo = valor;
    document.documentElement.style.setProperty("--teclado", `${valor}px`);
    document.documentElement.dataset.teclado = valor > 90 ? "aberto" : "fechado";
    aoMudar?.(valor);
  };

  vv.addEventListener("resize", medir);
  vv.addEventListener("scroll", medir);
  document.addEventListener("focusin", medir);
  document.addEventListener("focusout", medir);
  medir();
}

/* ═══ Utilidades pequenas ═══════════════════════════════════════ */

/** Botão de ação do cabeçalho. */
export const acao = (nomeIcone, rotulo, aoTocar, extras = {}) =>
  el(
    "button",
    {
      class: `acao${extras.classe ? ` ${extras.classe}` : ""}`,
      type: "button",
      "aria-label": rotulo,
      title: rotulo,
      onclick: (evento) => {
        vibrar("leve");
        aoTocar(evento);
      },
      ...(extras.atributos ?? {}),
    },
    icone(nomeIcone)
  );

/** Linha de lista com seta — o item de menu de tela cheia. */
export function linha({
  titulo,
  legenda = "",
  valor = "",
  icone: nomeIcone = "",
  tintaIcone = "",
  seta = false,
  perigo = false,
  aoTocar = null,
  direita = null,
  legendaQuebra = false,
}) {
  const conteudo = [
    nomeIcone
      ? el("span", { class: `linha__icone${tintaIcone ? ` linha__icone--${tintaIcone}` : ""}` }, icone(nomeIcone))
      : null,
    el(
      "span",
      { class: "linha__dizeres" },
      el("span", { class: "linha__titulo" }, titulo),
      legenda ? el("span", { class: `linha__legenda${legendaQuebra ? " linha__legenda--quebra" : ""}` }, legenda) : null
    ),
    valor ? el("span", { class: "linha__valor" }, valor) : null,
    direita,
    seta ? icone("avancar", "linha__seta") : null,
  ];

  return el(
    aoTocar ? "button" : "div",
    {
      class: `linha${perigo ? " linha--perigo" : ""}`,
      type: aoTocar ? "button" : null,
      onclick: aoTocar
        ? () => {
            vibrar("leve");
            aoTocar();
          }
        : null,
    },
    conteudo
  );
}

/** A chave de liga/desliga, já ligada ao toque. */
export function chave(ligada, aoMudar) {
  const botao = el("button", {
    class: "chave",
    type: "button",
    role: "switch",
    "aria-checked": ligada ? "true" : "false",
    onclick: () => {
      const novo = botao.getAttribute("aria-checked") !== "true";
      botao.setAttribute("aria-checked", novo ? "true" : "false");
      vibrar("medio");
      aoMudar(novo);
    },
  });
  return botao;
}

/** Grupo de linhas, com título de seção opcional. */
export const grupo = (titulo, ...filhos) =>
  el(
    "div",
    null,
    titulo ? el("div", { class: "secao" }, titulo) : null,
    el("div", { class: "grupo" }, filhos)
  );

/** Estado vazio ilustrado. */
export const vazio = (nomeIcone, titulo, texto, acaoNo = null) =>
  el(
    "div",
    { class: "vazio" },
    el("span", { class: "vazio__selo" }, icone(nomeIcone)),
    el("p", { class: "vazio__titulo" }, titulo),
    texto ? el("p", { class: "vazio__texto" }, texto) : null,
    acaoNo
  );

export { icone, svgDe };
