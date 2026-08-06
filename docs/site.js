/**
 * Página de apresentação do CALL.
 * Sem dependências: tudo abaixo é DOM, canvas 2D e um fetch à API do GitHub.
 */

const REPOSITORIO = "alanaraujo-bit/CALL";
const $ = (seletor) => document.querySelector(seletor);
const $$ = (seletor) => [...document.querySelectorAll(seletor)];

/** Quem pediu menos movimento recebe a página inteira, parada. */
const paradoPorPreferencia = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

/* ═══ Botão de download ═════════════════════════════════════════ */

/**
 * O nome do instalador carrega a versão, então um link fixo apontaria para um
 * arquivo que deixa de existir na próxima publicação. Aqui se pergunta ao
 * GitHub qual é o arquivo da versão mais recente; se a pergunta falhar, os
 * links continuam valendo — apontam para a página de versões.
 */
async function prepararDownload() {
  try {
    const resposta = await fetch(
      `https://api.github.com/repos/${REPOSITORIO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!resposta.ok) return;

    const versao = await resposta.json();
    const instalador = versao.assets?.find((a) => /-setup\.exe$/i.test(a.name));
    if (!instalador) return;

    for (const alvo of $$("[data-baixar]")) {
      alvo.href = instalador.browser_download_url;
    }

    const mb = (instalador.size / 1048576).toFixed(2).replace(".", ",");
    const texto = `${versao.tag_name} · ${mb} MB · Windows x64`;
    for (const meta of $$("#meta-download, #meta-download-2")) {
      meta.textContent = texto;
    }
  } catch {
    // Sem rede ou limite da API atingido: o link de reserva já está no HTML.
  }
}

/* ═══ Halo do ponteiro e cabeçalho ══════════════════════════════ */

function prepararAmbiente() {
  const brilho = $("#brilho");
  const cabecalho = $("#cabecalho");

  if (!paradoPorPreferencia) {
    window.addEventListener(
      "pointermove",
      (evento) => {
        brilho.style.setProperty("--mx", `${evento.clientX}px`);
        brilho.style.setProperty("--my", `${evento.clientY}px`);
      },
      { passive: true }
    );
  }

  const aoRolar = () => {
    cabecalho.dataset.preso = window.scrollY > 30 ? "sim" : "nao";
  };
  window.addEventListener("scroll", aoRolar, { passive: true });
  aoRolar();
}

/* ═══ Revelação ao rolar ════════════════════════════════════════ */

function prepararRevelacao() {
  const observador = new IntersectionObserver(
    (entradas) => {
      for (const entrada of entradas) {
        if (!entrada.isIntersecting) continue;
        entrada.target.classList.add("visivel");
        observador.unobserve(entrada.target);
        animarConteudo(entrada.target);
      }
    },
    { threshold: 0.18, rootMargin: "0px 0px -60px 0px" }
  );

  for (const alvo of $$("[data-revelar]")) observador.observe(alvo);
}

/** Contadores e barras só começam quando entram em cena. */
function animarConteudo(raiz) {
  const contadores = raiz.matches("[data-contar]")
    ? [raiz]
    : [...raiz.querySelectorAll("[data-contar]")];
  for (const alvo of contadores) contar(alvo);

  for (const barra of raiz.querySelectorAll("[data-largura]")) {
    const preenchimento = barra.querySelector(".barra__preenchimento");
    if (preenchimento) preenchimento.style.width = `${barra.dataset.largura}%`;
  }
}

function contar(alvo) {
  const destino = Number(alvo.dataset.contar);
  const casas = Number(alvo.dataset.casas ?? 0);
  const sufixo = alvo.dataset.sufixo ?? "";
  const formatar = (n) => n.toFixed(casas).replace(".", ",") + sufixo;

  if (paradoPorPreferencia || destino === 0) {
    alvo.textContent = formatar(destino);
    return;
  }

  const duracao = 1200;
  const inicio = performance.now();

  const passo = (agora) => {
    const t = Math.min((agora - inicio) / duracao, 1);
    // Desaceleração cúbica: o número chega e assenta, em vez de parar seco.
    const suave = 1 - Math.pow(1 - t, 3);
    alvo.textContent = formatar(destino * suave);
    if (t < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/* ═══ Inclinação 3D ═════════════════════════════════════════════ */

/** A maquete acompanha o ponteiro pela página inteira; os cartões, só o
 *  ponteiro dentro deles. */
function prepararInclinacao() {
  if (paradoPorPreferencia || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  const janela = $("#janela");
  if (janela) {
    window.addEventListener(
      "pointermove",
      (evento) => {
        const x = evento.clientX / window.innerWidth - 0.5;
        const y = evento.clientY / window.innerHeight - 0.5;
        janela.style.setProperty("--ry", `${-13 + x * 12}deg`);
        janela.style.setProperty("--rx", `${6 - y * 9}deg`);
      },
      { passive: true }
    );
  }

  for (const cartao of $$("[data-inclinar]")) {
    cartao.addEventListener(
      "pointermove",
      (evento) => {
        const area = cartao.getBoundingClientRect();
        const x = (evento.clientX - area.left) / area.width;
        const y = (evento.clientY - area.top) / area.height;
        cartao.style.setProperty("--cy", `${(x - 0.5) * 9}deg`);
        cartao.style.setProperty("--cx", `${(0.5 - y) * 9}deg`);
        cartao.style.setProperty("--px", `${x * 100}%`);
        cartao.style.setProperty("--py", `${y * 100}%`);
      },
      { passive: true }
    );

    cartao.addEventListener("pointerleave", () => {
      cartao.style.setProperty("--cy", "0deg");
      cartao.style.setProperty("--cx", "0deg");
    });
  }
}

/* ═══ Malha 3D do fundo ═════════════════════════════════════════ */

/**
 * Pontos distribuídos sobre uma esfera, girando e projetados em perspectiva.
 * Não é enfeite arbitrário: é a topologia do aplicativo — cada participante
 * ligado a todos os outros, que é exatamente o que o CALL faz com a rede.
 */
function prepararMalha() {
  const tela = document.getElementById("malha3d");
  if (!tela || paradoPorPreferencia) return;

  const ctx = tela.getContext("2d", { alpha: true });
  const QUANTIDADE = window.matchMedia("(max-width: 700px)").matches ? 26 : 46;
  const DISTANCIA_FIO = 0.72; // fração do raio abaixo da qual dois nós se ligam
  const RAIO = 1;

  // Espiral de Fibonacci: pontos bem espalhados na esfera, sem aglomerar nos polos.
  const nos = Array.from({ length: QUANTIDADE }, (_, i) => {
    const y = 1 - (i / (QUANTIDADE - 1)) * 2;
    const raioFatia = Math.sqrt(Math.max(0, 1 - y * y));
    const angulo = i * Math.PI * (3 - Math.sqrt(5));
    return {
      x: Math.cos(angulo) * raioFatia * RAIO,
      y: y * RAIO,
      z: Math.sin(angulo) * raioFatia * RAIO,
      fase: Math.random() * Math.PI * 2,
    };
  });

  let largura = 0;
  let altura = 0;
  let densidade = 1;

  const redimensionar = () => {
    densidade = Math.min(window.devicePixelRatio || 1, 2);
    largura = tela.clientWidth;
    altura = tela.clientHeight;
    tela.width = Math.round(largura * densidade);
    tela.height = Math.round(altura * densidade);
    ctx.setTransform(densidade, 0, 0, densidade, 0, 0);
  };
  redimensionar();
  window.addEventListener("resize", redimensionar, { passive: true });

  let visivel = true;
  new IntersectionObserver((e) => (visivel = e[0].isIntersecting)).observe(tela);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ultimo = performance.now();
  });

  let giro = 0;
  let ultimo = performance.now();

  const quadro = (agora) => {
    requestAnimationFrame(quadro);

    const passo = Math.min((agora - ultimo) / 1000, 0.05);
    ultimo = agora;
    if (!visivel || document.hidden) return;

    giro += passo * 0.11;

    const escala = Math.min(largura, altura) * 0.42;
    const cx = largura * 0.5;
    const cy = altura * 0.46;
    const cosG = Math.cos(giro);
    const senG = Math.sin(giro);
    const inclinacao = 0.42;
    const cosI = Math.cos(inclinacao);
    const senI = Math.sin(inclinacao);

    const projetados = nos.map((no) => {
      // Respiração leve para a malha não parecer um sólido rígido.
      const pulso = 1 + Math.sin(agora / 1400 + no.fase) * 0.035;

      const x1 = no.x * cosG - no.z * senG;
      const z1 = no.x * senG + no.z * cosG;
      const y2 = no.y * cosI - z1 * senI;
      const z2 = no.y * senI + z1 * cosI;

      const profundidade = 3.1 / (3.1 - z2 * pulso);
      return {
        x: cx + x1 * pulso * escala * profundidade,
        y: cy + y2 * pulso * escala * profundidade,
        z: z2,
        p: profundidade,
      };
    });

    ctx.clearRect(0, 0, largura, altura);

    // Fios primeiro: eles são o assunto, os nós só marcam as pontas.
    for (let i = 0; i < projetados.length; i++) {
      for (let j = i + 1; j < projetados.length; j++) {
        const a = nos[i];
        const b = nos[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d > DISTANCIA_FIO) continue;

        const pa = projetados[i];
        const pb = projetados[j];
        const proximidade = 1 - d / DISTANCIA_FIO;
        const frente = Math.max(0, (pa.z + pb.z) / 2 + 1) / 2;

        ctx.strokeStyle = `rgba(95, 106, 217, ${(
          proximidade * frente * 0.5
        ).toFixed(3)})`;
        ctx.lineWidth = 0.6 + frente * 0.7;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }

    for (const ponto of projetados) {
      const frente = Math.max(0, ponto.z + 1) / 2;
      ctx.fillStyle = `rgba(150, 158, 240, ${(0.18 + frente * 0.62).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ponto.x, ponto.y, 1.1 + frente * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  requestAnimationFrame(quadro);
}

/* ═══ Maquete viva ══════════════════════════════════════════════ */

/**
 * A janela do hero não é uma captura de tela: é a interface em HTML. Como ela
 * é de verdade, pode se comportar como o aplicativo — alguém fala, alguém
 * transmite, alguém silencia.
 */
function prepararMaquete() {
  if (paradoPorPreferencia) return;

  const pessoas = $$(".mini-pessoa");
  const transmissao = $("#mini-transmissao");
  const vazio = $("#mini-vazio");
  const microfone = $("#mini-microfone");
  const transmitir = $("#mini-transmitir");
  if (!pessoas.length || !transmissao) return;

  const roteiro = [
    () => falar(0, 2600),
    () => falar(1, 1900),
    () => {
      transmissao.dataset.ativo = "sim";
      vazio.style.opacity = "0";
      transmitir.dataset.ativo = "sim";
    },
    () => falar(2, 2400),
    () => falar(1, 3000),
    () => {
      microfone.dataset.mudo = "sim";
      microfone.textContent = "";
      microfone.append(criarPonto(), document.createTextNode("Microfone mudo"));
    },
    () => falar(2, 2200),
    () => {
      microfone.dataset.mudo = "nao";
      microfone.textContent = "";
      microfone.append(criarPonto(), document.createTextNode("Microfone"));
    },
    () => falar(0, 2000),
    () => {
      transmissao.dataset.ativo = "nao";
      vazio.style.opacity = "1";
      transmitir.dataset.ativo = "nao";
    },
  ];

  function criarPonto() {
    const ponto = document.createElement("i");
    ponto.className = "ponto";
    return ponto;
  }

  function falar(indice, duracao) {
    const pessoa = pessoas[indice];
    if (!pessoa) return;
    pessoa.dataset.falando = "sim";
    setTimeout(() => (pessoa.dataset.falando = "nao"), duracao);
  }

  let passo = 0;
  setInterval(() => {
    roteiro[passo % roteiro.length]();
    passo += 1;
  }, 2800);
}

/* ═══ Início ════════════════════════════════════════════════════ */

prepararAmbiente();
prepararRevelacao();
prepararInclinacao();
prepararMalha();
prepararMaquete();
prepararDownload();
