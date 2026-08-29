/**
 * Central de comando — o painel do dono, dentro do próprio CALL.
 *
 * Este arquivo desenha, e só desenha. Nenhum número aqui é calculado a
 * partir de outro: retenção, coortes, funil e séries chegam prontos do
 * servidor (`servidor/src/telemetria.rs`, com testes), e a tela é uma vista
 * deles. Isso é deliberado — um painel que faz a própria conta no navegador
 * é um painel em que a mesma pergunta tem duas respostas possíveis, e a
 * errada é sempre a que está na tela.
 *
 * ## O que ele mostra, e por que estes números
 *
 * Um painel bonito e inútil mostra totais. Total de contas sobe todo dia e
 * nunca desce; ele faz qualquer produto parecer saudável, inclusive um que
 * ninguém abre há um mês. Os números daqui foram escolhidos para poderem
 * dar má notícia:
 *
 * * **Ativos por dia** — pessoas, não eventos, e não acumulado. Cai quando
 *   as pessoas param de voltar, que é exatamente quando se precisa saber.
 * * **Retenção por coorte** — de quem entrou naquele dia, quantos voltaram
 *   no dia seguinte, no sétimo, no trigésimo. É a única métrica que separa
 *   "muita gente entrou" de "o produto serve pra alguma coisa".
 * * **Funil de ativação** — quantos passaram de criar conta a entrar num
 *   grupo, escrever, e entrar na voz. Cada degrau perdido é um lugar
 *   concreto onde o CALL está falhando com alguém.
 * * **Ao vivo** — quem está conectado neste instante, em qual grupo, em qual
 *   canal, e o que acabou de acontecer. É o único painel que não vem de
 *   banco nenhum: sai da memória do processo do servidor.
 *
 * ## Ao vivo de verdade
 *
 * A tela não recarrega em laço. O servidor empurra: um pulso a cada cinco
 * segundos (quem está conectado agora) e cada acontecimento na hora em que
 * acontece. O retrato inteiro é refeito de tempos em tempos, e é ele quem
 * reconcilia — os contadores que sobem sozinhos entre um retrato e outro
 * são estimativas honestas, e o retrato seguinte corrige qualquer desvio.
 */

import { elementoDeAvatar } from "./avatares.js";
import { ROTULOS_CATEGORIA, ROTULOS_STATUS } from "./feedback.js";

/* ═══ Formatação ════════════════════════════════════════════════ */

const NUMERO = new Intl.NumberFormat("pt-BR");
const num = (valor) => NUMERO.format(Math.round(Number(valor) || 0));

/** Porcentagem inteira; `null` quando não há denominador — e "0%" seria uma
 *  afirmação que ninguém pode fazer sobre um conjunto vazio. */
function porcento(parte, total) {
  if (!total) return null;
  return Math.round((parte / total) * 100);
}

const DIA_MS = 86_400_000;

function dataCurta(ms) {
  return new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function dataHora(ms) {
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** "agora", "há 4 min", "há 3 d" — o suficiente para saber se é recente. */
function haQuantoTempo(ms) {
  if (!ms) return "nunca";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `há ${d} d` : dataCurta(ms);
}

function duracao(minutos) {
  const m = Math.round(minutos || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}

/* ═══ DOM ═══════════════════════════════════════════════════════ */

function el(tag, classe = "", texto = "") {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== "") e.textContent = texto;
  return e;
}

function svgEl(tag, atributos = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(atributos)) e.setAttribute(k, String(v));
  return e;
}

/** Ícone de traço, no mesmo desenho do resto da barra de ferramentas. */
function icone(d, tamanho = 18) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", width: tamanho, height: tamanho, "aria-hidden": "true" });
  for (const traco of [].concat(d)) svg.append(svgEl("path", { d: traco }));
  return svg;
}

/* ═══ Peças ═════════════════════════════════════════════════════ */

/**
 * Uma métrica com o número grande, o que ele significa e como está em
 * relação a ontem.
 *
 * A comparação vai junto de propósito: "12 pessoas ativas" não é notícia
 * nenhuma sem saber que ontem foram 30.
 */
function cartaoMetrica({ rotulo, valor, sufixo = "", nota = "", delta = null, serie = null, tom = "" }) {
  const cartao = el("article", `pnl-metrica${tom ? ` pnl-metrica--${tom}` : ""}`);

  // O rótulo fica sozinho na primeira linha e a variação desce para junto
  // do número. Dividir a primeira linha entre os dois espremia o rótulo em
  // duas alturas diferentes de cartão para cartão, e uma fileira de cartões
  // com o número em alturas diferentes é uma fileira que não se lê de
  // relance — que é a única coisa que uma fileira de números precisa fazer.
  cartao.append(el("span", "pnl-metrica__rotulo", rotulo));

  const linha = el("div", "pnl-metrica__valor");
  linha.append(el("span", "pnl-metrica__numero", valor));
  if (sufixo) linha.append(el("span", "pnl-metrica__sufixo", sufixo));
  if (delta !== null && delta !== undefined) linha.append(pilulaDelta(delta));
  cartao.append(linha);

  if (serie?.length) cartao.append(minigrafico(serie));
  if (nota) cartao.append(el("p", "pnl-metrica__nota", nota));
  return cartao;
}

/** Variação contra o período anterior. Sem sinal quando não houve
 *  período anterior — inventar "+100%" a partir de zero é ruído. */
function pilulaDelta(delta) {
  const { atual = 0, anterior = 0, invertido = false } = delta;
  const diferenca = atual - anterior;
  const p = el("span", "pnl-delta");

  if (!anterior && !atual) {
    p.classList.add("pnl-delta--neutro");
    p.textContent = "—";
    return p;
  }
  if (diferenca === 0) {
    p.classList.add("pnl-delta--neutro");
    p.textContent = "igual";
    return p;
  }

  const bom = invertido ? diferenca < 0 : diferenca > 0;
  p.classList.add(bom ? "pnl-delta--bom" : "pnl-delta--ruim");
  const relativo = anterior ? ` (${Math.abs(Math.round((diferenca / anterior) * 100))}%)` : "";
  p.textContent = `${diferenca > 0 ? "+" : "−"}${num(Math.abs(diferenca))}${relativo}`;
  p.title = `Ontem: ${num(anterior)}`;
  return p;
}

/** A linha fininha dentro do cartão. Sem eixo e sem número: ela responde
 *  "está subindo ou caindo?", e nada além disso. */
function minigrafico(valores) {
  const L = 120;
  const A = 30;
  const maximo = Math.max(1, ...valores);
  const passo = valores.length > 1 ? L / (valores.length - 1) : 0;
  const pontos = valores.map((v, i) => [i * passo, A - (v / maximo) * (A - 3) - 1.5]);

  const svg = svgEl("svg", {
    class: "pnl-mini",
    viewBox: `0 0 ${L} ${A}`,
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  const linha = pontos.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  svg.append(svgEl("path", { class: "pnl-mini__area", d: `M${linha} L${L},${A} L0,${A} Z` }));
  svg.append(svgEl("path", { class: "pnl-mini__linha", d: `M${linha}` }));
  return svg;
}

function secao(titulo, subtitulo = "") {
  const s = el("section", "pnl-secao");
  const cabecalho = el("header", "pnl-secao__topo");
  cabecalho.append(el("h3", "pnl-secao__titulo", titulo));
  if (subtitulo) cabecalho.append(el("p", "pnl-secao__sub", subtitulo));
  s.append(cabecalho);
  return s;
}

function vazio(texto) {
  return el("p", "pnl-vazio", texto);
}

/* ═══ Gráfico temporal ══════════════════════════════════════════ */

const LARGURA = 1000;
const ALTURA = 240;
const MARGEM = { cima: 16, direita: 8, baixo: 24, esquerda: 42 };

/**
 * A série do tempo, com uma faixa preenchida por linha e, opcionalmente,
 * barras atrás. O eixo Y começa sempre em zero — um gráfico cortado embaixo
 * transforma uma variação de 3% num despenhadeiro, e essa é a mentira mais
 * comum de painel.
 */
function graficoTemporal(serie, camadas) {
  const caixa = el("div", "pnl-grafico");
  if (!serie?.length) {
    caixa.append(vazio("Sem dados nesta janela."));
    return caixa;
  }

  const largura = LARGURA - MARGEM.esquerda - MARGEM.direita;
  const altura = ALTURA - MARGEM.cima - MARGEM.baixo;
  const n = serie.length;
  const maximo = Math.max(1, ...camadas.flatMap((c) => serie.map((d) => Number(d[c.chave]) || 0)));
  // O passo é que precisa ser redondo, e não o teto: arredondar só o teto
  // dava eixos como "0, 13, 25, 38, 50" — quatro divisões de 12,5. Redondo é
  // o intervalo entre duas linhas, e o teto é quatro deles.
  const passo = arredondarParaCima(maximo / 4);
  const teto = passo * 4;
  const x = (i) => MARGEM.esquerda + (n === 1 ? largura / 2 : (i / (n - 1)) * largura);
  const y = (v) => MARGEM.cima + altura - (v / teto) * altura;

  const svg = svgEl("svg", { class: "pnl-grafico__svg", viewBox: `0 0 ${LARGURA} ${ALTURA}`, role: "img" });
  svg.setAttribute("aria-label", camadas.map((c) => c.nome).join(", "));

  // Grade horizontal e eixo Y
  for (let i = 0; i <= 4; i++) {
    const valor = passo * i;
    const linhaY = y(valor);
    svg.append(svgEl("line", {
      class: "pnl-grafico__grade",
      x1: MARGEM.esquerda, x2: LARGURA - MARGEM.direita, y1: linhaY, y2: linhaY,
    }));
    const rotulo = svgEl("text", { class: "pnl-grafico__eixo", x: MARGEM.esquerda - 8, y: linhaY + 4, "text-anchor": "end" });
    rotulo.textContent = num(valor);
    svg.append(rotulo);
  }

  // Barras primeiro, para as linhas ficarem por cima
  const larguraBarra = Math.max(2, (largura / n) * 0.5);
  for (const camada of camadas.filter((c) => c.tipo === "barra")) {
    const grupo = svgEl("g", { class: "pnl-grafico__barras", style: `--cor:${camada.cor}` });
    serie.forEach((ponto, i) => {
      const valor = Number(ponto[camada.chave]) || 0;
      if (!valor) return;
      grupo.append(svgEl("rect", {
        x: x(i) - larguraBarra / 2,
        y: y(valor),
        width: larguraBarra,
        height: Math.max(1, MARGEM.cima + altura - y(valor)),
        rx: 2,
      }));
    });
    svg.append(grupo);
  }

  for (const camada of camadas.filter((c) => c.tipo !== "barra")) {
    const caminho = serie.map((p, i) => `${x(i).toFixed(1)},${y(Number(p[camada.chave]) || 0).toFixed(1)}`).join(" L");
    const grupo = svgEl("g", { style: `--cor:${camada.cor}` });
    if (camada.area !== false) {
      grupo.append(svgEl("path", {
        class: "pnl-grafico__area",
        d: `M${caminho} L${x(n - 1)},${MARGEM.cima + altura} L${x(0)},${MARGEM.cima + altura} Z`,
      }));
    }
    grupo.append(svgEl("path", { class: "pnl-grafico__linha", d: `M${caminho}` }));
    svg.append(grupo);
  }

  // Eixo X: primeiro, meio e último — datas em cada um dos trinta dias
  // viram uma faixa cinza ilegível.
  for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
    const t = svgEl("text", {
      class: "pnl-grafico__eixo",
      x: x(i),
      y: ALTURA - 6,
      "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle",
    });
    t.textContent = dataCurta(serie[i].em);
    svg.append(t);
  }

  // Cursor de leitura
  const cursor = svgEl("line", { class: "pnl-grafico__cursor", y1: MARGEM.cima, y2: MARGEM.cima + altura, opacity: 0 });
  svg.append(cursor);
  const marcas = camadas.map((camada) => {
    const c = svgEl("circle", { class: "pnl-grafico__marca", r: 4, style: `--cor:${camada.cor}`, opacity: 0 });
    svg.append(c);
    return c;
  });

  caixa.append(legenda(camadas));
  caixa.append(svg);

  const dica = el("div", "pnl-dica");
  dica.hidden = true;
  caixa.append(dica);

  const mover = (evento) => {
    const caixaSvg = svg.getBoundingClientRect();
    const proporcao = (evento.clientX - caixaSvg.left) / caixaSvg.width;
    const posicaoX = proporcao * LARGURA;
    const i = Math.max(0, Math.min(n - 1, Math.round(((posicaoX - MARGEM.esquerda) / largura) * (n - 1))));
    const ponto = serie[i];

    cursor.setAttribute("x1", x(i));
    cursor.setAttribute("x2", x(i));
    cursor.setAttribute("opacity", 1);
    camadas.forEach((camada, k) => {
      marcas[k].setAttribute("cx", x(i));
      marcas[k].setAttribute("cy", y(Number(ponto[camada.chave]) || 0));
      marcas[k].setAttribute("opacity", 1);
    });

    dica.textContent = "";
    dica.append(el("strong", "", new Date(ponto.em).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" })));
    for (const camada of camadas) {
      const linha = el("span", "pnl-dica__linha");
      const ponta = el("i", "pnl-dica__cor");
      ponta.style.background = camada.cor;
      linha.append(ponta, el("span", "", camada.nome), el("b", "", num(ponto[camada.chave])));
      dica.append(linha);
    }
    dica.hidden = false;
    const dentro = (x(i) / LARGURA) * caixaSvg.width;
    dica.style.left = `${Math.min(Math.max(dentro, 70), caixaSvg.width - 70)}px`;
  };

  svg.addEventListener("pointermove", mover);
  svg.addEventListener("pointerleave", () => {
    dica.hidden = true;
    cursor.setAttribute("opacity", 0);
    for (const m of marcas) m.setAttribute("opacity", 0);
  });

  return caixa;
}

function legenda(camadas) {
  const l = el("div", "pnl-legenda");
  for (const camada of camadas) {
    const item = el("span", "pnl-legenda__item");
    const ponta = el("i", `pnl-legenda__cor${camada.tipo === "barra" ? " pnl-legenda__cor--barra" : ""}`);
    ponta.style.background = camada.cor;
    item.append(ponta, el("span", "", camada.nome));
    l.append(item);
  }
  return l;
}

/** 1, 2, 5, 10, 20, 50… — a escada de tetos que dá um eixo legível. */
function arredondarParaCima(valor) {
  if (valor <= 4) return Math.max(1, Math.ceil(valor));
  const magnitude = 10 ** Math.floor(Math.log10(valor));
  for (const passo of [1, 2, 2.5, 5, 10]) {
    const candidato = magnitude * passo;
    if (candidato >= valor) return candidato;
  }
  return magnitude * 10;
}

/* ═══ Abas ══════════════════════════════════════════════════════ */

const ABAS = [
  { id: "geral", nome: "Visão geral", icone: ["M4 19V9m5 10V5m5 14v-7m5 7V8"] },
  { id: "crescimento", nome: "Crescimento", icone: ["M3 17l5-6 4 3 5-7", "M14 7h4v4"] },
  { id: "retencao", nome: "Retenção", icone: ["M20 12a8 8 0 1 1-3-6.2", "M20 4v5h-5"] },
  { id: "pessoas", nome: "Pessoas", icone: ["M8 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 8 11z", "M2.5 20c.8-4 3.2-6 5.5-6s4.7 2 5.5 6", "M16 10.5a2.6 2.6 0 1 0 0-5.2", "M15 14.6c2.5.4 4.1 2.2 4.8 5.4"] },
  { id: "grupos", nome: "Grupos", icone: ["M4 6.5h16M4 12h16M4 17.5h10"] },
  { id: "midia", nome: "Mídia", icone: ["M3 12a9 9 0 0 1 9-9", "M7.5 12a4.5 4.5 0 0 1 4.5-4.5", "M12 12h9a9 9 0 0 1-9 9 9 9 0 0 1-6.4-2.6"] },
  { id: "vivo", nome: "Ao vivo", icone: ["M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9", "M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 19.5a10.6 10.6 0 0 0 0-15"] },
  { id: "feedback", nome: "Feedback", icone: ["M4 4.5h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"] },
];

/** Os degraus da escada de mídia têm nome técnico no protocolo e nome de
 *  gente na tela. "proprio" é o que o servidor grava; "nosso servidor" é o
 *  que quem lê o painel entende. */
const NOME_DO_DEGRAU = {
  nuvem: "LiveKit Cloud",
  proprio: "Nosso servidor",
  malha: "Rede direta (P2P)",
  livekit: "LiveKit",
  "nao-medido": "Não medido",
};

const COR_DO_DEGRAU = {
  nuvem: "#5f6ad9",
  proprio: "#c07de0",
  malha: "#4fc98c",
  livekit: "#5f6ad9",
};

const CORES = {
  ativos: "#5f6ad9",
  novos: "#4fc98c",
  acessos: "#7f8ae8",
  mensagens: "#d9a441",
  voz: "#4fc98c",
  grupos: "#c07de0",
};

/* ═══ O painel ══════════════════════════════════════════════════ */

/** De quanto em quanto tempo o retrato inteiro é refeito com o painel
 *  aberto. Os números entre um e outro sobem sozinhos pelo pulso; este é o
 *  intervalo em que a estimativa vira medição. */
const INTERVALO_RETRATO = 45_000;

export class Painel {
  #enviar;
  #token;
  #raiz = null;
  #corpo = null;
  #retrato = null;
  #aba = "geral";
  #aberto = false;
  #relogio = null;
  #pulsoRelogio = null;
  #recebidoEm = 0;
  #ultimosEventos = [];
  #aoTeclar = null;
  #filtroPessoas = "";

  constructor({ enviar, token }) {
    this.#enviar = enviar;
    this.#token = token;
  }

  get aberto() {
    return this.#aberto;
  }

  /* ── Abrir e fechar ─────────────────────────────────────────── */

  abrir() {
    if (!this.#raiz) this.#montar();
    this.#aberto = true;
    this.#raiz.classList.remove("oculto");

    this.#aoTeclar = (evento) => {
      if (evento.key === "Escape") this.fechar();
    };
    document.addEventListener("keydown", this.#aoTeclar);

    this.#pedirRetrato();
    clearInterval(this.#relogio);
    this.#relogio = setInterval(() => this.#pedirRetrato(), INTERVALO_RETRATO);
    clearInterval(this.#pulsoRelogio);
    this.#pulsoRelogio = setInterval(() => this.#marcarFrescor(), 1000);

    this.#raiz.querySelector(".pnl__fechar")?.focus();
  }

  fechar() {
    if (!this.#raiz) return;
    this.#aberto = false;
    this.#raiz.classList.add("oculto");
    clearInterval(this.#relogio);
    clearInterval(this.#pulsoRelogio);
    if (this.#aoTeclar) {
      document.removeEventListener("keydown", this.#aoTeclar);
      this.#aoTeclar = null;
    }
    // O servidor para de montar o pulso para quem não está olhando.
    this.#enviar({ tipo: "admin-largar", token: this.#token() });
  }

  #pedirRetrato() {
    this.#enviar({
      tipo: "admin-painel",
      token: this.#token(),
      // O painel conta os dias no fuso de quem está lendo — ver a nota do
      // topo de `telemetria.rs`.
      fuso: new Date().getTimezoneOffset(),
    });
  }

  /* ── O que chega do servidor ────────────────────────────────── */

  aoRetrato(retrato) {
    this.#retrato = retrato;
    this.#ultimosEventos = retrato.ultimos ?? [];
    this.#recebidoEm = Date.now();
    if (!this.#raiz) this.#montar();
    this.#desenharCabecalho();
    // O retrato chega sozinho a cada 45 segundos. Redesenhar a aba jogando a
    // rolagem para o topo e tirando o foco do campo de busca transformaria a
    // atualização automática num tapa na mão de quem está lendo — por isso
    // este redesenho preserva os dois, e só a troca de aba recomeça do alto.
    this.#desenharAba({ manterLugar: true });
  }

  /** O pulso mexe só no que é do instante — trocar a tela inteira a cada
   *  cinco segundos faria a rolagem pular embaixo do dedo de quem lê. */
  aoPulso({ pulso, presentes }) {
    if (!this.#retrato) return;
    this.#retrato.agora = pulso;
    if (presentes) this.#retrato.presentes = presentes;
    this.#recebidoEm = Date.now();
    this.#atualizarAoVivo();
  }

  aoEvento({ evento, pulso }) {
    if (!this.#retrato) return;
    if (pulso) this.#retrato.agora = pulso;
    this.#ultimosEventos.unshift(evento);
    this.#ultimosEventos.length = Math.min(this.#ultimosEventos.length, 120);
    this.#recebidoEm = Date.now();
    this.#estimar(evento);
    this.#atualizarAoVivo();
  }

  /** A escada de mídia mudou de estado — um degrau caiu, ou o dono virou a
   *  chave. Chega empurrado, e não no retrato de 45 em 45 segundos: é
   *  justamente no minuto em que um degrau cai que o painel precisa estar
   *  certo. */
  aoMidia(midia) {
    if (!this.#retrato) return;
    this.#retrato.midia = midia;
    this.#recebidoEm = Date.now();
    if (this.#aba === "midia") this.#desenharAba({ manterLugar: true });
  }

  aoFeedbackNovo(feedback) {
    if (!this.#retrato) return;
    const lista = this.#retrato.feedback ?? (this.#retrato.feedback = []);
    const i = lista.findIndex((f) => f.id === feedback.id);
    if (i >= 0) lista[i] = feedback;
    else lista.unshift(feedback);
    // Mudar o status de um relato redesenha a lista sem sair do lugar — a
    // pessoa acabou de clicar num botão no meio dela.
    if (this.#aba === "feedback") this.#desenharAba({ manterLugar: true });
  }

  aoNegado() {
    if (!this.#raiz) this.#montar();
    this.#corpo.textContent = "";
    const aviso = el("div", "pnl-negado");
    aviso.append(el("h3", "", "Este painel é do dono do serviço."));
    aviso.append(el("p", "", "Sua conta não está na lista de administradores deste servidor."));
    this.#corpo.append(aviso);
  }

  /**
   * Sobe os contadores de hoje na hora em que o acontecimento chega.
   *
   * É estimativa, e é assumido como tal: o retrato seguinte (no máximo 45
   * segundos depois) recalcula tudo do zero e corrige qualquer desvio. A
   * alternativa — esperar o retrato — faria o painel parecer congelado
   * justamente durante o uso que ele existe para mostrar.
   */
  #estimar(evento) {
    const j = this.#retrato.janelas;
    if (!j) return;
    if (evento.tipo === "mensagem") j.mensagensHoje++;
    if (evento.tipo === "conta-criada") {
      j.novosHoje++;
      this.#retrato.totais.contas++;
    }
    if (evento.tipo === "voz-saiu") j.minutosVozHoje += Math.floor((evento.valor || 0) / 60);
    if (["sessao-aberta", "sessao-retomada", "conta-criada"].includes(evento.tipo)) j.acessosHoje++;
  }

  /* ── Estrutura ──────────────────────────────────────────────── */

  #montar() {
    // Sem a classe `cortina` de nenhuma das duas cascas, de proposito: a do
    // celular nasce com `opacity: 0` e so acende com um atributo que quem a
    // criou sabe por, e o painel abria invisivel la. `pnl-cortina` se
    // sustenta sozinha, e por isso e a mesma nos dois lugares.
    const cortina = el("div", "pnl-cortina oculto");
    cortina.id = "painel-dialogo";
    cortina.addEventListener("click", (e) => {
      if (e.target === cortina) this.fechar();
    });

    const painel = el("div", "pnl");
    painel.setAttribute("role", "dialog");
    painel.setAttribute("aria-modal", "true");
    painel.setAttribute("aria-label", "Central de comando");

    /* Topo */
    const topo = el("header", "pnl__topo");
    const marca = el("div", "pnl__marca");
    marca.append(icone(["M6 4.5v15M10.5 7.5v9M15 3v18M19.5 9v6"], 20));
    const nomes = el("div", "pnl__nomes");
    nomes.append(el("strong", "pnl__titulo", "Central de comando"));
    nomes.append(el("span", "pnl__dono", ""));
    marca.append(nomes);
    topo.append(marca);

    const frescor = el("div", "pnl__frescor");
    frescor.append(el("i", "pnl__pulsa"));
    frescor.append(el("span", "pnl__frescor-texto", "conectando…"));
    topo.append(frescor);

    const fechar = el("button", "icone pnl__fechar");
    fechar.type = "button";
    fechar.title = "Fechar";
    fechar.setAttribute("aria-label", "Fechar");
    fechar.append(icone(["M6 6l12 12M18 6L6 18"]));
    fechar.addEventListener("click", () => this.fechar());
    topo.append(fechar);
    painel.append(topo);

    /* Corpo: trilha de abas + conteúdo */
    const meio = el("div", "pnl__meio");
    const trilha = el("nav", "pnl__trilha");
    trilha.setAttribute("role", "tablist");
    for (const aba of ABAS) {
      const botao = el("button", "pnl__aba");
      botao.type = "button";
      botao.dataset.aba = aba.id;
      botao.setAttribute("role", "tab");
      botao.setAttribute("aria-selected", String(aba.id === this.#aba));
      botao.append(icone(aba.icone));
      botao.append(el("span", "", aba.nome));
      botao.addEventListener("click", () => {
        if (this.#aba === aba.id) return;
        this.#aba = aba.id;
        this.#marcarAbaAtiva();
        this.#desenharAba();
      });
      trilha.append(botao);
    }
    meio.append(trilha);

    this.#corpo = el("div", "pnl__corpo");
    meio.append(this.#corpo);
    painel.append(meio);

    cortina.append(painel);
    document.body.append(cortina);
    this.#raiz = cortina;

    this.#corpo.append(el("p", "pnl-carregando", "Levantando os números…"));
  }

  #marcarAbaAtiva() {
    for (const b of this.#raiz.querySelectorAll(".pnl__aba")) {
      b.setAttribute("aria-selected", String(b.dataset.aba === this.#aba));
    }
  }

  #desenharCabecalho() {
    const dono = this.#retrato?.dono;
    const alvo = this.#raiz.querySelector(".pnl__dono");
    if (alvo) alvo.textContent = dono ? dono.email : "";
    this.#marcarFrescor();
  }

  /** "ao vivo · há 3 s" — a idade do que está na tela, sempre visível.
   *  Um painel que não diz quando foi atualizado é um painel em que não dá
   *  para confiar quando o servidor cai. */
  #marcarFrescor() {
    const texto = this.#raiz?.querySelector(".pnl__frescor-texto");
    const luz = this.#raiz?.querySelector(".pnl__pulsa");
    if (!texto || !this.#recebidoEm) return;
    const s = Math.round((Date.now() - this.#recebidoEm) / 1000);
    const velho = s > 20;
    texto.textContent = velho ? `sem resposta há ${s}s` : `ao vivo · há ${s}s`;
    luz.classList.toggle("pnl__pulsa--frio", velho);
  }

  #desenharAba({ manterLugar = false } = {}) {
    if (!this.#retrato) return;

    const rolagem = manterLugar ? this.#corpo.scrollTop : 0;
    const fluxo = manterLugar ? this.#raiz.querySelector(".pnl-fluxo")?.scrollTop ?? 0 : 0;
    const buscando =
      manterLugar && this.#raiz.contains(document.activeElement) && document.activeElement?.type === "search";
    const caret = buscando ? document.activeElement.selectionStart : 0;

    this.#corpo.textContent = "";
    const montar = {
      geral: () => this.#abaGeral(),
      crescimento: () => this.#abaCrescimento(),
      retencao: () => this.#abaRetencao(),
      pessoas: () => this.#abaPessoas(),
      grupos: () => this.#abaGrupos(),
      midia: () => this.#abaMidia(),
      vivo: () => this.#abaAoVivo(),
      feedback: () => this.#abaFeedback(),
    }[this.#aba];
    montar?.();

    this.#corpo.scrollTop = rolagem;
    const listaViva = this.#raiz.querySelector(".pnl-fluxo");
    if (listaViva) listaViva.scrollTop = fluxo;
    if (buscando) {
      const busca = this.#raiz.querySelector(".pnl-busca");
      busca?.focus();
      busca?.setSelectionRange(caret, caret);
    }
  }

  /** Redesenha só o que muda a cada pulso, sem tocar no resto da tela. */
  #atualizarAoVivo() {
    const r = this.#retrato;
    if (!r || !this.#raiz) return;
    this.#marcarFrescor();

    for (const alvo of this.#raiz.querySelectorAll("[data-vivo]")) {
      const caminho = alvo.dataset.vivo.split(".");
      let valor = r;
      for (const parte of caminho) valor = valor?.[parte];
      const texto = num(valor ?? 0);
      if (alvo.textContent !== texto) {
        alvo.textContent = texto;
        alvo.classList.remove("pnl-pisca");
        void alvo.offsetWidth; // reinicia a animação
        alvo.classList.add("pnl-pisca");
      }
    }

    if (this.#aba === "vivo") {
      this.#preencherPresentes();
      this.#preencherFluxo();
    }
  }

  /* ── Aba: visão geral ───────────────────────────────────────── */

  #abaGeral() {
    const r = this.#retrato;
    const j = r.janelas;
    const serie = r.serie ?? [];
    const ativos = serie.map((d) => d.ativos);

    const grade = el("div", "pnl-grade");
    grade.append(
      cartaoMetrica({
        rotulo: "CALL aberto agora",
        valor: num(r.agora?.sockets ?? 0),
        nota: `${num(r.agora?.conexoes ?? 0)} dentro de um grupo · ${num(r.agora?.emVoz ?? 0)} em voz`,
        tom: "vivo",
      })
    );
    grade.children[0].querySelector(".pnl-metrica__numero").dataset.vivo = "agora.sockets";

    grade.append(
      cartaoMetrica({
        rotulo: "Pessoas ativas hoje",
        valor: num(j.dau),
        delta: { atual: j.dau, anterior: j.ontem },
        serie: ativos,
        nota: "Contas distintas com qualquer atividade",
      }),
      cartaoMetrica({
        rotulo: "Contas novas hoje",
        valor: num(j.novosHoje),
        delta: { atual: j.novosHoje, anterior: j.novosOntem },
        serie: serie.map((d) => d.novos),
        nota: `${num(j.novos7)} nos últimos 7 dias`,
      }),
      cartaoMetrica({
        rotulo: "Ativos na semana",
        valor: num(j.wau),
        nota: `${num(j.mau)} nos últimos 30 dias`,
      }),
      cartaoMetrica({
        rotulo: "Aderência",
        valor: porcento(j.dau, j.mau) === null ? "—" : `${porcento(j.dau, j.mau)}`,
        sufixo: "%",
        nota: "Dos que usam no mês, quantos usam hoje",
      }),
      cartaoMetrica({
        rotulo: "Tempo em voz hoje",
        valor: duracao(j.minutosVozHoje),
        nota: `${duracao(j.minutosVoz7)} nos últimos 7 dias`,
      })
    );
    this.#corpo.append(grade);

    const grafico = secao("Pessoas ativas por dia", "Trinta dias. As barras verdes são contas novas.");
    grafico.append(
      graficoTemporal(serie, [
        { chave: "novos", nome: "Contas novas", cor: CORES.novos, tipo: "barra" },
        { chave: "ativos", nome: "Pessoas ativas", cor: CORES.ativos },
      ])
    );
    this.#corpo.append(grafico);

    const duas = el("div", "pnl-duas");
    duas.append(this.#blocoFunil(), this.#blocoRetencaoResumo());
    this.#corpo.append(duas);

    const tres = el("div", "pnl-duas");
    tres.append(this.#blocoPlataformas(), this.#blocoHorarios());
    this.#corpo.append(tres);
  }

  /**
   * "Medido desde …", quando a medição é recente.
   *
   * Retenção e funil só conhecem quem se cadastrou depois de o servidor
   * começar a anotar acontecimentos — quem já tinha conta antes disso fica de
   * fora, porque não teria como provar que voltou. Enquanto isso for uma
   * fatia relevante do histórico, dizer isso na tela é obrigação: um número
   * sem a data em que ele passou a existir convida à conclusão errada.
   */
  #notaDeMedicao() {
    const desde = this.#retrato.medidoDesde;
    if (!desde) return null;
    const dias = Math.floor((Date.now() - desde) / DIA_MS);
    if (dias >= 60) return null;
    return el(
      "p",
      "pnl-nota",
      `Medido desde ${dataCurta(desde)} (${dias} dia(s)). Quem já tinha conta antes disso fica de fora daqui — não dá para saber se voltou.`
    );
  }

  #blocoFunil() {
    const f = this.#retrato.funil ?? {};
    const bloco = secao("Funil de ativação", "De cada pessoa que criou conta, até onde ela chegou.");
    // "Voltou outro dia" ficava aqui e quebrava a leitura: 70% seguido de
    // 91% num funil faz o olho concluir que a conta está errada. E não está —
    // voltar não é um degrau de ativação, é retenção, e mora no bloco ao
    // lado. Um funil que sobe no meio é um funil que ninguém deveria acreditar.
    const degraus = [
      ["Criaram conta", f.criaram],
      ["Entraram num grupo", f.entraramEmGrupo],
      ["Escreveram uma mensagem", f.mandaramMensagem],
      ["Entraram na voz", f.entraramNaVoz],
    ];
    const base = Math.max(1, f.criaram ?? 1);

    const lista = el("div", "pnl-funil");
    for (const [nome, valor = 0] of degraus) {
      const linha = el("div", "pnl-funil__linha");
      const topo = el("div", "pnl-funil__topo");
      topo.append(el("span", "", nome));
      topo.append(el("b", "", `${num(valor)} · ${porcento(valor, base) ?? 0}%`));
      linha.append(topo);
      const trilho = el("div", "pnl-funil__trilho");
      const barra = el("i", "pnl-funil__barra");
      barra.style.width = `${(valor / base) * 100}%`;
      trilho.append(barra);
      linha.append(trilho);
      lista.append(linha);
    }
    bloco.append(lista);
    const desde = this.#notaDeMedicao();
    if (desde) bloco.append(desde);
    return bloco;
  }

  #blocoRetencaoResumo() {
    const r = this.#retrato.retencao ?? {};
    const bloco = secao("Retenção", "De quem criou conta, quantos voltaram depois de N dias.");
    const lista = el("div", "pnl-anel-lista");
    for (const [rotulo, dado] of [["D1", r.d1], ["D7", r.d7], ["D30", r.d30]]) {
      lista.append(anelDeRetencao(rotulo, dado));
    }
    // Quem voltou em *algum* outro dia. É o piso da retenção: mais frouxo
    // que D1, e por isso o número que menos dói e o que menos diz.
    const f = this.#retrato.funil ?? {};
    lista.append(
      anelDeRetencao("Voltaram", { elegiveis: f.criaram ?? 0, voltaram: f.voltaram ?? 0 })
    );
    bloco.append(lista);
    bloco.append(
      el(
        "p",
        "pnl-nota",
        "Só entra na conta quem já teve a chance: quem criou a conta ontem não reprova num D7 que ainda não chegou."
      )
    );
    const desde = this.#notaDeMedicao();
    if (desde) bloco.append(desde);
    return bloco;
  }

  #blocoPlataformas() {
    const lista = this.#retrato.plataformas ?? [];
    const bloco = secao("Onde o CALL é usado", "Contas distintas vistas em cada casca.");
    if (!lista.length) {
      bloco.append(vazio("Ninguém identificado ainda."));
      return bloco;
    }
    const NOMES = { windows: "Windows", movel: "Celular", navegador: "Navegador" };
    const total = lista.reduce((s, p) => s + p.pessoas, 0);
    const barras = el("div", "pnl-funil");
    for (const p of lista) {
      const linha = el("div", "pnl-funil__linha");
      const topo = el("div", "pnl-funil__topo");
      topo.append(el("span", "", NOMES[p.nome] ?? p.nome));
      topo.append(el("b", "", `${num(p.pessoas)} · ${porcento(p.pessoas, total) ?? 0}%`));
      linha.append(topo);
      const trilho = el("div", "pnl-funil__trilho");
      const barra = el("i", "pnl-funil__barra pnl-funil__barra--alt");
      barra.style.width = `${(p.pessoas / total) * 100}%`;
      trilho.append(barra);
      linha.append(trilho);
      barras.append(linha);
    }
    bloco.append(barras);
    return bloco;
  }

  #blocoHorarios() {
    const dados = this.#retrato.horarios ?? [];
    const bloco = secao("Quando as pessoas usam", "Dia da semana por hora, na janela inteira.");
    if (!dados.some((v) => v)) {
      bloco.append(vazio("Sem movimento registrado ainda."));
      return bloco;
    }
    const maximo = Math.max(...dados);
    const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

    const grade = el("div", "pnl-mapa");
    for (let d = 0; d < 7; d++) {
      grade.append(el("span", "pnl-mapa__dia", DIAS[d]));
      const faixa = el("div", "pnl-mapa__faixa");
      for (let h = 0; h < 24; h++) {
        const valor = dados[d * 24 + h] ?? 0;
        const celula = el("i", "pnl-mapa__celula");
        celula.style.setProperty("--intensidade", maximo ? (valor / maximo).toFixed(3) : 0);
        celula.title = `${DIAS[d]}, ${String(h).padStart(2, "0")}h — ${num(valor)} acontecimento(s)`;
        faixa.append(celula);
      }
      grade.append(faixa);
    }
    bloco.append(grade);

    const escala = el("div", "pnl-mapa__escala");
    escala.append(el("span", "", "0h"), el("span", "", "12h"), el("span", "", "23h"));
    bloco.append(escala);
    return bloco;
  }

  /* ── Aba: crescimento ───────────────────────────────────────── */

  #abaCrescimento() {
    const r = this.#retrato;
    const serie = r.serie ?? [];

    // A curva acumulada é montada aqui e não no servidor por um motivo só:
    // ela é uma soma da série que já veio, e mandar o mesmo número duas
    // vezes pela rede não compra nada.
    const totalHoje = r.totais?.contas ?? 0;
    const depois = serie.reduce((s, d) => s + d.novos, 0);
    let corrente = totalHoje - depois;
    const acumulado = serie.map((d) => {
      corrente += d.novos;
      return { em: d.em, contas: corrente };
    });

    const grade = el("div", "pnl-grade");
    grade.append(
      cartaoMetrica({ rotulo: "Contas no total", valor: num(r.totais?.contas), nota: `${num(r.totais?.comGoogle ?? 0)} entram pelo Google` }),
      cartaoMetrica({ rotulo: "Novas em 7 dias", valor: num(r.janelas?.novos7), nota: `${num(r.janelas?.novos30)} nos últimos 30` }),
      cartaoMetrica({ rotulo: "Sessões válidas", valor: num(r.sessoesVivas), nota: "Aparelhos com o CALL lembrado" }),
      cartaoMetrica({ rotulo: "Acessos hoje", valor: num(r.janelas?.acessosHoje), delta: { atual: r.janelas?.acessosHoje ?? 0, anterior: r.janelas?.acessosOntem ?? 0 }, nota: "Aberturas do aplicativo e logins" }),
      cartaoMetrica({ rotulo: "Mensagens hoje", valor: num(r.janelas?.mensagensHoje), nota: `${num(r.janelas?.mensagens7)} nos últimos 7 dias` }),
      cartaoMetrica({ rotulo: "Grupos ativos hoje", valor: num(r.janelas?.gruposAtivosHoje), nota: `${num((r.grupos ?? []).length)} grupos existem` })
    );
    grade.children[0].querySelector(".pnl-metrica__numero").dataset.vivo = "totais.contas";
    this.#corpo.append(grade);

    const totalizado = secao("Contas acumuladas", "A soma de todo mundo que já criou conta.");
    totalizado.append(graficoTemporal(acumulado, [{ chave: "contas", nome: "Contas", cor: CORES.ativos }]));
    this.#corpo.append(totalizado);

    const novas = secao("Contas novas e acessos por dia");
    novas.append(
      graficoTemporal(serie, [
        { chave: "novos", nome: "Contas novas", cor: CORES.novos, tipo: "barra" },
        { chave: "acessos", nome: "Acessos", cor: CORES.acessos, area: false },
      ])
    );
    this.#corpo.append(novas);

    const uso = secao("Uso: conversa e voz");
    uso.append(
      graficoTemporal(serie, [
        { chave: "mensagens", nome: "Mensagens", cor: CORES.mensagens, tipo: "barra" },
        { chave: "minutosVoz", nome: "Minutos em voz", cor: CORES.voz, area: false },
      ])
    );
    this.#corpo.append(uso);
  }

  /* ── Aba: retenção ──────────────────────────────────────────── */

  #abaRetencao() {
    const r = this.#retrato.retencao ?? {};

    const resumo = secao("A pergunta que importa", "Criar conta é fácil. Voltar no dia seguinte é o produto funcionando.");
    const lista = el("div", "pnl-anel-lista pnl-anel-lista--grande");
    for (const [rotulo, dado, legenda] of [
      ["D1", r.d1, "voltaram no dia seguinte"],
      ["D7", r.d7, "ainda estavam lá na semana seguinte"],
      ["D30", r.d30, "continuavam um mês depois"],
    ]) {
      lista.append(anelDeRetencao(rotulo, dado, legenda));
    }
    resumo.append(lista);
    const desde = this.#notaDeMedicao();
    if (desde) resumo.append(desde);
    this.#corpo.append(resumo);

    const grade = secao(
      "Coortes por dia de cadastro",
      "Cada linha é o grupo que criou conta naquele dia. As colunas são os dias seguintes."
    );
    const coortes = (r.coortes ?? []).filter((c) => c.tamanho > 0).reverse();
    if (!coortes.length) {
      grade.append(vazio("Nenhuma conta criada nesta janela."));
      this.#corpo.append(grade);
      return;
    }

    const tabela = el("table", "pnl-coortes");
    const cabecalho = el("tr");
    cabecalho.append(el("th", "pnl-coortes__canto", "Entraram em"));
    cabecalho.append(el("th", "", "Pessoas"));
    for (let d = 0; d < (coortes[0].voltaram?.length ?? 0); d++) cabecalho.append(el("th", "", `D${d}`));
    const topoTabela = el("thead");
    topoTabela.append(cabecalho);
    tabela.append(topoTabela);

    const corpo = el("tbody");
    for (const coorte of coortes) {
      const linha = el("tr");
      linha.append(el("th", "pnl-coortes__dia", dataCurta(coorte.em)));
      linha.append(el("td", "pnl-coortes__tamanho", num(coorte.tamanho)));
      for (const voltaram of coorte.voltaram ?? []) {
        const celula = el("td", "pnl-coortes__celula");
        if (voltaram === null || voltaram === undefined) {
          celula.classList.add("pnl-coortes__celula--futuro");
          celula.textContent = "";
        } else {
          const p = porcento(voltaram, coorte.tamanho) ?? 0;
          celula.textContent = `${p}%`;
          celula.style.setProperty("--intensidade", (p / 100).toFixed(3));
          celula.title = `${num(voltaram)} de ${num(coorte.tamanho)}`;
        }
        linha.append(celula);
      }
      corpo.append(linha);
    }
    tabela.append(corpo);

    const rolagem = el("div", "pnl-rolagem");
    rolagem.append(tabela);
    grade.append(rolagem);
    grade.append(
      el(
        "p",
        "pnl-nota",
        "D0 é o próprio dia do cadastro e será quase sempre 100% — ele está aqui como referência, não como notícia. As células vazias são dias que ainda não aconteceram."
      )
    );
    this.#corpo.append(grade);
  }

  /* ── Aba: pessoas ───────────────────────────────────────────── */

  #abaPessoas() {
    const pessoas = this.#retrato.pessoas ?? [];
    const online = new Set((this.#retrato.presentes ?? []).map((p) => p.conta).filter(Boolean));

    const bloco = secao("Pessoas", `${num(pessoas.length)} conta(s). Mais recentemente vistas primeiro.`);

    const busca = el("input", "pnl-busca");
    busca.type = "search";
    busca.placeholder = "Procurar por apelido ou e-mail…";
    busca.value = this.#filtroPessoas;
    busca.addEventListener("input", () => {
      this.#filtroPessoas = busca.value.trim().toLowerCase();
      preencher();
    });
    bloco.querySelector(".pnl-secao__topo").append(busca);

    const rolagem = el("div", "pnl-rolagem");
    const tabela = el("table", "pnl-tabela");
    const cabecalho = el("tr");
    for (const titulo of ["Pessoa", "Entrou em", "Vista", "Dias ativos", "Acessos", "Mensagens", "Voz", "Grupos", "Onde"]) {
      cabecalho.append(el("th", "", titulo));
    }
    const topoTabela = el("thead");
    topoTabela.append(cabecalho);
    tabela.append(topoTabela);
    const corpo = el("tbody");
    tabela.append(corpo);
    rolagem.append(tabela);
    bloco.append(rolagem);
    this.#corpo.append(bloco);

    const NOMES = { windows: "Windows", movel: "Celular", navegador: "Navegador" };
    const preencher = () => {
      corpo.textContent = "";
      const filtro = this.#filtroPessoas;
      const visiveis = pessoas.filter(
        (p) => !filtro || p.apelido.toLowerCase().includes(filtro) || p.email.toLowerCase().includes(filtro)
      );
      if (!visiveis.length) {
        const linha = el("tr");
        const celula = el("td", "pnl-tabela__vazio", "Ninguém com esse nome.");
        celula.colSpan = 9;
        linha.append(celula);
        corpo.append(linha);
        return;
      }
      for (const p of visiveis) {
        const linha = el("tr");

        const quem = el("td", "pnl-tabela__pessoa");
        quem.append(elementoDeAvatar({ apelido: p.apelido, avatar: p.avatar }, "avatar avatar--pequeno"));
        const nomes = el("div", "pnl-tabela__nomes");
        const alto = el("span", "pnl-tabela__nome");
        alto.textContent = p.apelido;
        if (online.has(p.id)) alto.append(el("i", "pnl-ponto-vivo"));
        nomes.append(alto);
        nomes.append(el("span", "pnl-tabela__email", p.email));
        quem.append(nomes);
        linha.append(quem);

        linha.append(el("td", "", dataCurta(p.criadaEm)));
        const visto = el("td", "", haQuantoTempo(p.ultimoEm));
        if (p.ultimoEm) visto.title = dataHora(p.ultimoEm);
        if (!p.ultimoEm) visto.classList.add("pnl-tabela__apagado");
        linha.append(visto);
        linha.append(el("td", "", num(p.diasAtivos)));
        linha.append(el("td", "", num(p.acessos)));
        linha.append(el("td", "", num(p.mensagens)));
        linha.append(el("td", "", duracao(p.minutosVoz)));
        linha.append(el("td", "", num(p.grupos)));
        linha.append(el("td", "pnl-tabela__apagado", (p.plataformas ?? []).map((x) => NOMES[x] ?? x).join(", ") || "—"));
        corpo.append(linha);
      }
    };
    preencher();
  }

  /* ── Aba: grupos ────────────────────────────────────────────── */

  #abaGrupos() {
    const grupos = this.#retrato.grupos ?? [];
    const bloco = secao("Grupos", `${num(grupos.length)} grupo(s). Com gente dentro primeiro.`);
    if (!grupos.length) {
      bloco.append(vazio("Nenhum grupo criado ainda."));
      this.#corpo.append(bloco);
      return;
    }

    const rolagem = el("div", "pnl-rolagem");
    const tabela = el("table", "pnl-tabela");
    const cabecalho = el("tr");
    for (const t of ["Grupo", "Código", "Membros", "Online", "Canais", "Mensagens", "Sons", "Última mensagem"]) {
      cabecalho.append(el("th", "", t));
    }
    const topoTabela = el("thead");
    topoTabela.append(cabecalho);
    tabela.append(topoTabela);
    const corpo = el("tbody");
    for (const g of grupos) {
      const linha = el("tr");
      const nome = el("td", "pnl-tabela__nome");
      nome.textContent = g.nome;
      if (g.descricao) {
        const sub = el("span", "pnl-tabela__email", g.descricao);
        nome.append(document.createElement("br"), sub);
      }
      linha.append(nome);
      const codigo = el("td", "pnl-tabela__codigo", g.codigo);
      linha.append(codigo);
      // Quantas contas guardam este grupo — o tamanho dele, e não quantos
      // estão conectados agora.
      linha.append(el("td", "", num(g.membros)));
      const vivos = el("td", "");
      vivos.textContent = num(g.online);
      if (g.online > 0) vivos.classList.add("pnl-tabela__vivo");
      linha.append(vivos);
      linha.append(el("td", "", `${num(g.canais)} (${num(g.canaisDeVoz)} de voz)`));
      linha.append(el("td", "", num(g.mensagens)));
      linha.append(el("td", "", num(g.sons)));
      const ultima = el("td", "", g.ultimaMensagemEm ? haQuantoTempo(g.ultimaMensagemEm) : "—");
      if (g.ultimaMensagemEm) ultima.title = dataHora(g.ultimaMensagemEm);
      linha.append(ultima);
      corpo.append(linha);
    }
    tabela.append(corpo);
    rolagem.append(tabela);
    bloco.append(rolagem);
    this.#corpo.append(bloco);
  }

  /* ── Aba: ao vivo ───────────────────────────────────────────── */

  /* ── Aba: mídia ─────────────────────────────────────────────── */

  /**
   * A escada de mídia: quem está atendendo, quanto já custou e o que
   * acontece se cair.
   *
   * Esta aba nasceu de um apagão. O plano do LiveKit acabou, o servidor
   * continuou emitindo tokens, e ninguém entrou em call nenhuma — sem que
   * houvesse, em lugar nenhum, um número que dissesse "está acabando". O que
   * está desenhado aqui é exatamente esse número, e o que ele controla.
   *
   * Duas medidas convivem, e a diferença entre elas é dita na tela em vez de
   * escondida: o **consumo do ciclo**, que este servidor mediu do lado de
   * cá, e o **teto**, que é o que o dono declarou no ambiente. O painel do
   * provedor é a fonte de verdade da fatura; este é o alarme que dispara
   * antes dela.
   */
  #abaMidia() {
    const midia = this.#retrato.midia ?? {};
    const consumo = this.#retrato.consumo ?? {};
    const degraus = midia.degraus ?? [];

    this.#corpo.append(this.#blocoEscada(midia, degraus));

    // ── O consumo medido, por degrau ──
    const porMeio = new Map((consumo.degraus ?? []).map((d) => [d.meio, d]));
    const grade = el("div", "pnl-grade");
    for (const degrau of degraus) {
      const medido = porMeio.get(degrau.nome);
      const teto = degrau.tetoMinutos;
      grade.append(
        cartaoMetrica({
          rotulo: `Minutos — ${NOME_DO_DEGRAU[degrau.nome] ?? degrau.nome}`,
          valor: num(degrau.minutos),
          sufixo: teto ? `/ ${num(teto)}` : "",
          nota: teto
            ? `Projeção do ciclo: ${num(medido?.projecao ?? 0)} min`
            : "Sem teto declarado neste degrau",
          tom: degrau.atende ? "" : "perigo",
        })
      );
    }
    // A malha não tem degrau na escada do servidor — ela é a ausência de
    // degrau — mas os minutos que ela carregou são a medida do quanto a
    // contingência foi usada, e isso é justamente o que se quer saber.
    const malha = porMeio.get("malha");
    if (malha) {
      grade.append(
        cartaoMetrica({
          rotulo: "Minutos — rede direta",
          valor: num(malha.minutos),
          nota: "Carregados pela malha P2P, sem custo de servidor",
          tom: "vivo",
        })
      );
    }
    const naoMedido = porMeio.get("nao-medido");
    if (naoMedido) {
      grade.append(
        cartaoMetrica({
          rotulo: "Minutos não medidos",
          valor: num(naoMedido.minutos),
          nota: "Anteriores à escada de mídia — sem degrau anotado",
        })
      );
    }
    if (grade.children.length) this.#corpo.append(grade);

    // ── A série ──
    const meios = (consumo.meios ?? []).filter((m) => m !== "nao-medido");
    const serie = secao(
      "Minutos por dia, por caminho",
      "Cada minuto é o de uma pessoa numa call. É a mesma unidade que o LiveKit cobra."
    );
    serie.append(
      graficoTemporal(
        consumo.serie ?? [],
        meios.map((meio, i) => ({
          chave: meio,
          nome: NOME_DO_DEGRAU[meio] ?? meio,
          cor: COR_DO_DEGRAU[meio] ?? CORES.acessos,
          tipo: i === 0 ? "barra" : undefined,
          area: i !== 0,
        }))
      )
    );
    this.#corpo.append(serie);

    // ── As quedas ──
    const falhas = secao(
      "Quedas",
      "Cada uma é alguém que não conseguiu entrar por um caminho e foi desviado para o seguinte."
    );
    if (!consumo.totalFalhas) {
      falhas.append(vazio("Nenhuma queda neste ciclo."));
    } else {
      const lista = el("div", "pnl-lista");
      for (const degrau of degraus) {
        const medido = porMeio.get(degrau.nome);
        if (!medido?.falhas) continue;
        const linha = el("div", "pnl-linha");
        linha.append(el("span", "pnl-linha__nome", NOME_DO_DEGRAU[degrau.nome] ?? degrau.nome));
        linha.append(
          el(
            "span",
            "pnl-linha__valor",
            `${num(medido.falhas)} ${medido.falhas === 1 ? "queda" : "quedas"}`
          )
        );
        if (degrau.ultimoMotivo) {
          linha.append(el("span", "pnl-linha__nota", degrau.ultimoMotivo));
        }
        lista.append(linha);
      }
      falhas.append(lista);
    }
    this.#corpo.append(falhas);
  }

  /** O desenho da escada, degrau a degrau, com a chave do dono embaixo. */
  #blocoEscada(midia, degraus) {
    const bloco = secao(
      "A escada de mídia",
      "De cima para baixo, o caminho que uma call tenta. Quando um degrau não atende, a call desce sozinha para o seguinte."
    );

    const escada = el("div", "pnl-escada");
    const ativo = midia.ativo ?? "malha";

    for (const degrau of degraus) {
      escada.append(this.#degrauDaEscada(degrau, degrau.nome === ativo));
    }
    // A malha fecha a escada sempre, e não é configurável: ela é o degrau
    // que existe por não depender de nada.
    escada.append(
      this.#degrauDaEscada(
        {
          nome: "malha",
          url: "sem servidor de mídia",
          atende: true,
          impedimento: null,
        },
        ativo === "malha"
      )
    );
    bloco.append(escada);

    // ── A chave do dono ──
    const chave = el("div", "pnl-chave");
    const rotulo = el("label", "pnl-chave__rotulo");
    const caixa = el("input");
    caixa.type = "checkbox";
    caixa.checked = Boolean(midia.malhaForcada);
    caixa.addEventListener("change", () => {
      this.#enviar({
        tipo: "admin-midia",
        token: this.#token(),
        malhaForcada: caixa.checked,
      });
    });
    rotulo.append(caixa);
    rotulo.append(
      el("span", "", "Forçar a rede direta em todas as calls novas")
    );
    chave.append(rotulo);
    chave.append(
      el(
        "p",
        "pnl-chave__nota",
        "Desliga os servidores de mídia sem precisar de redeploy. As calls que já estão de pé continuam onde estão; as próximas nascem na malha."
      )
    );
    bloco.append(chave);
    return bloco;
  }

  #degrauDaEscada(degrau, ativo) {
    const item = el(
      "article",
      `pnl-degrau${ativo ? " pnl-degrau--ativo" : ""}${degrau.atende ? "" : " pnl-degrau--fora"}`
    );

    const topo = el("div", "pnl-degrau__topo");
    topo.append(el("span", "pnl-degrau__nome", NOME_DO_DEGRAU[degrau.nome] ?? degrau.nome));
    const marca = el(
      "span",
      "pnl-degrau__marca",
      ativo ? "atendendo agora" : degrau.atende ? "de prontidão" : "fora"
    );
    topo.append(marca);
    item.append(topo);

    item.append(el("p", "pnl-degrau__onde", degrau.url ?? ""));

    // A barra do teto só existe onde há teto: um degrau sem limite declarado
    // não deve ganhar uma barra vazia que se parece com "zero por cento
    // usado".
    if (degrau.tetoMinutos || degrau.tetoGb) {
      const fracao = Math.min(1, Number(degrau.fracao) || 0);
      const barra = el("div", "pnl-barra");
      const cheio = el("div", "pnl-barra__cheio");
      cheio.style.width = `${(fracao * 100).toFixed(1)}%`;
      if (fracao * 100 >= (degrau.margem ?? 90)) cheio.classList.add("pnl-barra__cheio--estourado");
      barra.append(cheio);
      item.append(barra);

      const partes = [];
      if (degrau.tetoMinutos) {
        partes.push(`${num(degrau.minutos)} de ${num(degrau.tetoMinutos)} min`);
      }
      if (degrau.tetoGb) {
        partes.push(`${degrau.gb ?? 0} de ${degrau.tetoGb} GB`);
      }
      partes.push(`aposenta em ${degrau.margem ?? 90}%`);
      item.append(el("p", "pnl-degrau__nota", partes.join(" · ")));
    } else if (degrau.nome !== "malha") {
      item.append(
        el("p", "pnl-degrau__nota", `${num(degrau.minutos ?? 0)} min neste ciclo · sem teto declarado`)
      );
    }

    if (degrau.impedimento) {
      item.append(el("p", "pnl-degrau__impedimento", degrau.impedimento));
    }
    if (degrau.emObservacao) {
      item.append(
        el("p", "pnl-degrau__nota", "Voltou de uma queda: a próxima falha o derruba de novo.")
      );
    }
    if (degrau.nome === "malha") {
      item.append(
        el(
          "p",
          "pnl-degrau__nota",
          "Liga as pessoas direto umas às outras. Nunca falta — mas cada pessoa envia para todas, então grupos grandes sofrem."
        )
      );
    }
    return item;
  }

  #abaAoVivo() {
    const grade = el("div", "pnl-grade");
    for (const [rotulo, caminho, nota] of [
      ["Janelas abertas", "agora.sockets", "Aplicativos falando com o servidor agora"],
      ["Dentro de um grupo", "agora.conexoes", "O resto está no portal ou na lista"],
      ["Contas online", "agora.contasOnline", "Pessoas identificadas neste instante"],
      ["Em call", "agora.emVoz", "Microfone capturado agora"],
      ["Transmitindo", "agora.transmitindo", "Compartilhando a tela"],
      ["Grupos com gente", "agora.gruposAtivos", "Grupos com pelo menos uma pessoa dentro"],
    ]) {
      const cartao = cartaoMetrica({ rotulo, valor: "0", nota, tom: "vivo" });
      cartao.querySelector(".pnl-metrica__numero").dataset.vivo = caminho;
      grade.append(cartao);
    }
    this.#corpo.append(grade);

    const presentes = secao("Quem está conectado", "Direto da memória do servidor — isto não passa por banco nenhum.");
    presentes.id = "pnl-presentes";
    presentes.append(el("div", "pnl-presentes"));
    this.#corpo.append(presentes);

    const fluxo = secao("Acontecendo", "Os últimos acontecimentos, na hora em que chegam.");
    fluxo.append(el("div", "pnl-fluxo"));
    this.#corpo.append(fluxo);

    this.#preencherPresentes();
    this.#preencherFluxo();
  }

  #preencherPresentes() {
    const alvo = this.#raiz?.querySelector(".pnl-presentes");
    if (!alvo) return;
    const lista = this.#retrato.presentes ?? [];
    // Janelas abertas que ainda não disseram quem são: alguém no portal, no
    // login ou no cadastro. Não dá para desenhar uma linha com nome para
    // elas, e fingir que não existem faria este bloco contradizer o
    // contador logo acima.
    const anonimas = this.#retrato.agora?.semIdentificacao ?? 0;

    alvo.textContent = "";
    if (!lista.length && !anonimas) {
      alvo.append(vazio("Ninguém conectado neste instante."));
      return;
    }

    const nomes = new Map((this.#retrato.pessoas ?? []).map((p) => [p.id, p]));
    const NOMES = { windows: "Windows", movel: "Celular", navegador: "Navegador" };

    for (const p of lista) {
      // O socket social não carrega perfil — quem sabe o apelido e o mascote
      // desta conta é a lista de pessoas, que já veio no mesmo retrato.
      const conhecida = p.conta ? nomes.get(p.conta) : null;
      const apelido = p.apelido ?? conhecida?.apelido ?? "Alguém";
      const avatar = p.avatar || conhecida?.avatar || "";

      const cartao = el("article", "pnl-presente");
      cartao.append(elementoDeAvatar({ apelido, avatar }, "avatar"));

      const texto = el("div", "pnl-presente__texto");
      const alto = el("div", "pnl-presente__nome");
      alto.textContent = apelido;
      if (!p.conta) alto.append(el("span", "pnl-etiqueta", "sem conta"));
      texto.append(alto);

      const onde = [];
      if (p.grupo) onde.push(p.grupo);
      if (p.canalVoz) onde.push(`voz: ${p.canalVoz}`);
      if (p.atividade) onde.push(p.atividade);
      texto.append(el("span", "pnl-presente__onde", onde.join(" · ") || "fora de grupo"));
      cartao.append(texto);

      const marcas = el("div", "pnl-presente__marcas");
      if (p.canalVoz) marcas.append(el("span", "pnl-etiqueta pnl-etiqueta--vivo", p.mudo ? "mudo" : "em call"));
      if (p.transmitindo) marcas.append(el("span", "pnl-etiqueta pnl-etiqueta--alerta", "transmitindo"));
      if (p.plataforma) marcas.append(el("span", "pnl-etiqueta", NOMES[p.plataforma] ?? p.plataforma));
      cartao.append(marcas);

      alvo.append(cartao);
    }

    if (anonimas) {
      const cartao = el("article", "pnl-presente pnl-presente--anonimo");
      const texto = el("div", "pnl-presente__texto");
      texto.append(el("div", "pnl-presente__nome", `+${num(anonimas)} janela(s) sem identificação`));
      texto.append(el("span", "pnl-presente__onde", "no portal, no login ou no cadastro"));
      cartao.append(texto);
      alvo.append(cartao);
    }
  }

  #preencherFluxo() {
    const alvo = this.#raiz?.querySelector(".pnl-fluxo");
    if (!alvo) return;
    const onde = alvo.scrollTop;
    alvo.textContent = "";
    if (!this.#ultimosEventos.length) {
      alvo.append(vazio("Nada aconteceu ainda nesta janela."));
      return;
    }

    const nomes = new Map((this.#retrato.pessoas ?? []).map((p) => [p.id, p.apelido]));
    const RELATO = {
      "conta-criada": "criou uma conta",
      "sessao-aberta": "entrou na conta",
      "sessao-retomada": "abriu o CALL",
      "sessao-fechada": "saiu da conta",
      "grupo-criado": "criou um grupo",
      "grupo-entrou": "entrou num grupo",
      "voz-entrou": "entrou numa call",
      "voz-saiu": "saiu da call",
      transmissao: "começou a transmitir",
      mensagem: "escreveu uma mensagem",
      feedback: "mandou um feedback",
    };
    const TOM = {
      "conta-criada": "bom",
      "grupo-criado": "bom",
      "voz-entrou": "voz",
      "voz-saiu": "voz",
      transmissao: "alerta",
      feedback: "alerta",
    };

    for (const evento of this.#ultimosEventos.slice(0, 80)) {
      const linha = el("article", `pnl-evento${TOM[evento.tipo] ? ` pnl-evento--${TOM[evento.tipo]}` : ""}`);
      linha.append(el("time", "pnl-evento__hora", new Date(evento.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
      const corpo = el("span", "pnl-evento__texto");
      corpo.append(el("b", "", nomes.get(evento.conta) ?? (evento.conta ? "conta apagada" : "alguém sem conta")));
      corpo.append(el("span", "", ` ${RELATO[evento.tipo] ?? evento.tipo}`));
      if (evento.tipo === "voz-saiu" && evento.valor > 0) {
        corpo.append(el("span", "pnl-evento__extra", ` depois de ${duracao(evento.valor / 60)}`));
      }
      linha.append(corpo);
      alvo.append(linha);
    }

    alvo.scrollTop = onde;
  }

  /* ── Aba: feedback ──────────────────────────────────────────── */

  #abaFeedback() {
    const lista = this.#retrato.feedback ?? [];
    const ORDEM = ["recebido", "aceito", "em_andamento", "finalizado"];

    const resumo = el("div", "pnl-grade");
    for (const status of ORDEM) {
      resumo.append(
        cartaoMetrica({ rotulo: ROTULOS_STATUS[status], valor: num(lista.filter((f) => f.status === status).length) })
      );
    }
    this.#corpo.append(resumo);

    const bloco = secao("Relatos", "O que as pessoas mandaram. Mudar o status avisa o autor na hora.");
    if (!lista.length) {
      bloco.append(vazio("Ninguém mandou nada ainda."));
      this.#corpo.append(bloco);
      return;
    }

    for (const item of lista) {
      const artigo = el("article", "pnl-relato");
      const topo = el("header", "pnl-relato__topo");
      topo.append(el("span", `pnl-etiqueta pnl-etiqueta--${item.categoria}`, ROTULOS_CATEGORIA[item.categoria] ?? item.categoria));
      topo.append(el("span", `pnl-etiqueta pnl-etiqueta--status-${item.status}`, ROTULOS_STATUS[item.status] ?? item.status));
      topo.append(el("span", "pnl-relato__autor", `${item.apelido} · ${dataCurta(item.criado_em)}`));
      artigo.append(topo);

      artigo.append(el("h4", "pnl-relato__titulo", item.titulo));
      artigo.append(el("p", "pnl-relato__descricao", item.descricao));

      const acoes = el("footer", "pnl-relato__acoes");
      for (const status of ORDEM) {
        const botao = el("button", "pnl-relato__botao", ROTULOS_STATUS[status]);
        botao.type = "button";
        botao.disabled = status === item.status;
        botao.addEventListener("click", () => {
          this.#enviar({ tipo: "admin-feedback", token: this.#token(), id: item.id, status });
        });
        acoes.append(botao);
      }
      artigo.append(acoes);
      bloco.append(artigo);
    }
    this.#corpo.append(bloco);
  }
}

/** O anel de retenção: a fração desenhada, e embaixo dela o "de quantos" —
 *  sem o denominador, 100% de duas pessoas parece uma conquista. */
function anelDeRetencao(rotulo, dado, legenda = "") {
  const { elegiveis = 0, voltaram = 0 } = dado ?? {};
  const p = porcento(voltaram, elegiveis);

  const caixa = el("div", "pnl-anel");
  const R = 26;
  const perimetro = 2 * Math.PI * R;
  const svg = svgEl("svg", { class: "pnl-anel__svg", viewBox: "0 0 64 64" });
  svg.append(svgEl("circle", { class: "pnl-anel__trilho", cx: 32, cy: 32, r: R }));
  if (p !== null) {
    svg.append(svgEl("circle", {
      class: "pnl-anel__arco",
      cx: 32, cy: 32, r: R,
      "stroke-dasharray": `${((p / 100) * perimetro).toFixed(1)} ${perimetro.toFixed(1)}`,
      transform: "rotate(-90 32 32)",
    }));
  }
  const centro = svgEl("text", { class: "pnl-anel__texto", x: 32, y: 37, "text-anchor": "middle" });
  centro.textContent = p === null ? "—" : `${p}%`;
  svg.append(centro);
  caixa.append(svg);

  const texto = el("div", "pnl-anel__lado");
  texto.append(el("strong", "", rotulo));
  texto.append(el("span", "pnl-anel__base", elegiveis ? `${num(voltaram)} de ${num(elegiveis)}` : "ninguém elegível ainda"));
  if (legenda) texto.append(el("span", "pnl-anel__legenda", legenda));
  caixa.append(texto);
  return caixa;
}
