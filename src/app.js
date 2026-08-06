import { Sinal } from "./sinal.js";
import { Malha } from "./rtc.js";

/* ═══ Atalhos ═══════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const invocar = (comando, args) =>
  window.__TAURI__?.core?.invoke
    ? window.__TAURI__.core.invoke(comando, args)
    : Promise.reject(new Error("Recurso disponível apenas no aplicativo."));

const CHAVE = "call.preferencias";
const SERVIDOR_PADRAO = "ws://127.0.0.1:8787";

/* ═══ Estado ════════════════════════════════════════════════════ */

const estado = {
  apelido: "",
  servidor: SERVIDOR_PADRAO,
  grupos: [],
  grupoAtivo: null,
  meuId: null,
  participantes: new Map(), // id -> { apelido, mudo, transmitindo }
  fluxoMicrofone: null,
  fluxoTela: null,
  mudo: false,
  transmitindo: false,
  hospedando: false,
  entrando: false,
};

const audiosRemotos = new Map(); // id -> HTMLAudioElement
const telasRemotas = new Map(); // id -> HTMLElement
const linhas = new Map(); // id -> HTMLElement da lista de participantes
const medidores = new Map(); // id -> { fonte, analisador, dados, ateQuando, falando }

let contexto = null; // AudioContext, criado só durante a chamada
let cronometroVoz = null;

const sinal = new Sinal();
const malha = new Malha({
  enviarSinal: (para, dados) => sinal.enviar({ tipo: "sinal", para, dados }),
  aoTrilha: receberTrilha,
  aoFimDeTrilha: (id, trilha) => {
    if (trilha.kind === "video") removerTela(id);
  },
  aoEstado: aoEstadoDaConexao,
});

/* ═══ Preferências ══════════════════════════════════════════════ */

function carregarPreferencias() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
    estado.apelido = bruto.apelido ?? "";
    estado.servidor = bruto.servidor || SERVIDOR_PADRAO;
    estado.grupos = Array.isArray(bruto.grupos) ? bruto.grupos : [];
  } catch {
    /* preferências ilegíveis: segue com os padrões */
  }
}

function salvarPreferencias() {
  localStorage.setItem(
    CHAVE,
    JSON.stringify({
      apelido: estado.apelido,
      servidor: estado.servidor,
      grupos: estado.grupos,
    })
  );
}

/* ═══ Avisos ════════════════════════════════════════════════════ */

function avisar(texto, tom = "neutro") {
  const caixa = document.createElement("div");
  caixa.className = "aviso";
  caixa.dataset.tom = tom;
  caixa.textContent = texto;
  $("avisos").append(caixa);

  setTimeout(() => {
    caixa.classList.add("aviso--saindo");
    setTimeout(() => caixa.remove(), 200);
  }, 4200);
}

// Falhas de política de segurança são silenciosas por padrão; sem isso, um
// endereço bloqueado apareceria apenas como "não foi possível conectar".
document.addEventListener("securitypolicyviolation", (evento) => {
  avisar(`Bloqueado pela política de segurança: ${evento.violatedDirective}`, "erro");
  console.error("[csp]", evento.violatedDirective, evento.blockedURI);
});

/* ═══ Tela de entrada ═══════════════════════════════════════════ */

function prepararEntrada() {
  $("campo-apelido").value = estado.apelido;
  $("campo-servidor").value = estado.servidor;

  $("botao-hospedar").addEventListener("click", hospedar);

  $("formulario-entrada").addEventListener("submit", (evento) => {
    evento.preventDefault();
    const apelido = $("campo-apelido").value.trim();
    const servidor = $("campo-servidor").value.trim();
    if (!apelido || !servidor) return;

    if (!/^wss?:\/\//i.test(servidor)) {
      avisar("O endereço precisa começar com ws:// ou wss://", "erro");
      return;
    }

    estado.apelido = apelido;
    estado.servidor = servidor;
    salvarPreferencias();

    $("tela-entrada").classList.add("oculto");
    $("tela-aplicacao").classList.remove("oculto");
    prepararAplicacao();
  });
}

async function hospedar() {
  const botao = $("botao-hospedar");
  botao.disabled = true;
  try {
    const endereco = await invocar("hospedar", { porta: 8787 });
    estado.hospedando = true;
    $("campo-servidor").value = endereco;
    $("dica-servidor").textContent =
      "Servidor ativo nesta máquina. Compartilhe seu IP na porta 8787 com o grupo.";
    botao.textContent = "Hospedando";
    avisar("Servidor de sinalização iniciado.", "bom");
  } catch (erro) {
    botao.disabled = false;
    avisar(String(erro), "erro");
  }
}

/* ═══ Aplicação ═════════════════════════════════════════════════ */

function prepararAplicacao() {
  $("rotulo-usuario").textContent = estado.apelido;
  $("avatar-usuario").textContent = iniciais(estado.apelido);

  $("botao-novo-grupo").addEventListener("click", abrirDialogoGrupo);
  $("botao-cancelar-grupo").addEventListener("click", fecharDialogoGrupo);
  $("cortina-grupo").addEventListener("click", (evento) => {
    if (evento.target === $("cortina-grupo")) fecharDialogoGrupo();
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") fecharDialogoGrupo();
  });

  $("formulario-grupo").addEventListener("submit", (evento) => {
    evento.preventDefault();
    const nome = $("campo-grupo").value.trim().toLowerCase();
    if (!nome) return;
    if (!estado.grupos.includes(nome)) {
      estado.grupos.push(nome);
      salvarPreferencias();
      desenharGrupos();
    }
    fecharDialogoGrupo();
    entrarNoGrupo(nome);
  });

  $("botao-microfone").addEventListener("click", alternarMicrofone);
  $("botao-transmitir").addEventListener("click", alternarTransmissao);
  $("botao-sair").addEventListener("click", () => sairDoGrupo(true));

  sinal.addEventListener("entrou", (e) => aoEntrarParticipante(e.detail));
  sinal.addEventListener("saiu", (e) => aoSairParticipante(e.detail.id));
  sinal.addEventListener("sinal", (e) =>
    malha.receberSinal(e.detail.de, e.detail.dados)
  );
  sinal.addEventListener("estado", (e) => aoEstadoParticipante(e.detail));
  sinal.addEventListener("queda", () => {
    if (!estado.grupoAtivo) return;
    avisar("A conexão com o servidor caiu.", "erro");
    sairDoGrupo(false);
  });

  desenharGrupos();
  desenharParticipantes();
}

function iniciais(nome) {
  return (
    nome
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("") || "?"
  );
}

/* ═══ Grupos ════════════════════════════════════════════════════ */

function abrirDialogoGrupo() {
  $("cortina-grupo").classList.remove("oculto");
  $("campo-grupo").value = "";
  $("campo-grupo").focus();
}

function fecharDialogoGrupo() {
  $("cortina-grupo").classList.add("oculto");
}

function desenharGrupos() {
  const lista = $("lista-grupos");
  lista.textContent = "";

  if (estado.grupos.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "grupos__vazio";
    vazio.textContent = "Nenhum grupo ainda. Crie o primeiro no “+”.";
    lista.append(vazio);
    return;
  }

  for (const nome of estado.grupos) {
    const item = document.createElement("button");
    item.className = "grupo";
    item.type = "button";
    if (nome === estado.grupoAtivo) item.classList.add("grupo--ativo");

    const marca = document.createElement("span");
    marca.className = "grupo__marca";

    const rotulo = document.createElement("span");
    rotulo.className = "grupo__nome";
    rotulo.textContent = nome;

    const remover = document.createElement("span");
    remover.className = "grupo__remover";
    remover.title = "Remover grupo";
    remover.innerHTML = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
    remover.addEventListener("click", (evento) => {
      evento.stopPropagation();
      removerGrupo(nome);
    });

    item.append(marca, rotulo, remover);
    item.addEventListener("click", () => entrarNoGrupo(nome));
    lista.append(item);
  }
}

function removerGrupo(nome) {
  if (nome === estado.grupoAtivo) sairDoGrupo(true);
  estado.grupos = estado.grupos.filter((g) => g !== nome);
  salvarPreferencias();
  desenharGrupos();
}

async function entrarNoGrupo(nome) {
  if (estado.entrando || nome === estado.grupoAtivo) return;
  estado.entrando = true;

  if (estado.grupoAtivo) sairDoGrupo(false);

  $("titulo-sala").textContent = nome;
  $("subtitulo-sala").textContent = "Conectando…";

  try {
    const microfone = await pedirMicrofone();
    const boasVindas = await sinal.conectar(estado.servidor, nome, estado.apelido);

    estado.grupoAtivo = nome;
    estado.meuId = boasVindas.id;
    estado.mudo = false;

    const [trilha] = microfone.getAudioTracks();
    malha.definirAudioLocal(trilha, microfone);
    observarVoz("eu", microfone);

    // Quem já estava na sala: eu ofereço a conexão.
    for (const par of boasVindas.pares) {
      estado.participantes.set(par.id, {
        apelido: par.apelido,
        mudo: par.mudo,
        transmitindo: par.transmitindo,
      });
      malha.abrir(par.id, true);
    }

    atualizarConexao(true);
    desenharGrupos();
    desenharParticipantes();
    habilitarControles(true);
    anunciarEstado();
  } catch (erro) {
    limparChamada();
    $("titulo-sala").textContent = estado.grupoAtivo ?? "Nenhum grupo";
    $("subtitulo-sala").textContent = "Selecione ou crie um grupo para começar";
    avisar(erro.message ?? String(erro), "erro");
  } finally {
    estado.entrando = false;
  }
}

async function pedirMicrofone() {
  if (estado.fluxoMicrofone) return estado.fluxoMicrofone;
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    estado.fluxoMicrofone = fluxo;
    return fluxo;
  } catch {
    throw new Error("Não foi possível acessar o microfone. Verifique as permissões.");
  }
}

function sairDoGrupo(avisarUsuario) {
  if (!estado.grupoAtivo) return;
  const nome = estado.grupoAtivo;
  limparChamada();
  desenharGrupos();
  desenharParticipantes();
  if (avisarUsuario) avisar(`Você saiu de “${nome}”.`);
}

function limparChamada() {
  sinal.desconectar();
  malha.fecharTudo();

  for (const [, elemento] of audiosRemotos) {
    elemento.pause();
    elemento.srcObject = null;
    elemento.remove();
  }
  audiosRemotos.clear();

  for (const [, elemento] of telasRemotas) elemento.remove();
  telasRemotas.clear();
  linhas.clear();

  for (const id of [...medidores.keys()]) esquecerVoz(id);

  estado.fluxoMicrofone?.getTracks().forEach((t) => t.stop());
  estado.fluxoMicrofone = null;
  estado.fluxoTela?.getTracks().forEach((t) => t.stop());
  estado.fluxoTela = null;

  contexto?.close().catch(() => {});
  contexto = null;

  estado.participantes.clear();
  estado.grupoAtivo = null;
  estado.meuId = null;
  estado.mudo = false;
  estado.transmitindo = false;

  habilitarControles(false);
  atualizarBotaoMicrofone();
  atualizarBotaoTransmissao();
  atualizarConexao(false);
  atualizarPalco();

  $("titulo-sala").textContent = "Nenhum grupo";
  $("subtitulo-sala").textContent = "Selecione ou crie um grupo para começar";
}

function habilitarControles(ligado) {
  $("botao-microfone").disabled = !ligado;
  $("botao-transmitir").disabled = !ligado;
  $("botao-sair").disabled = !ligado;
}

function atualizarConexao(ligado) {
  const rotulo = $("rotulo-conexao");
  rotulo.textContent = ligado ? "Conectado" : "Desconectado";
  rotulo.dataset.ligado = ligado ? "sim" : "nao";
}

/* ═══ Participantes ═════════════════════════════════════════════ */

function aoEntrarParticipante({ id, apelido }) {
  estado.participantes.set(id, { apelido, mudo: false, transmitindo: false });
  // Quem chega oferta; eu apenas respondo.
  malha.abrir(id, false);
  desenharParticipantes();
  avisar(`${apelido} entrou.`);
}

function aoSairParticipante(id) {
  const p = estado.participantes.get(id);
  estado.participantes.delete(id);
  malha.fechar(id);
  removerTela(id);
  esquecerVoz(id);

  const audio = audiosRemotos.get(id);
  if (audio) {
    // Zerar a fonte antes de descartar o elemento: um <audio> solto com fluxo
    // atribuído continua decodificando o que ainda chegar por ele.
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    audiosRemotos.delete(id);
  }

  desenharParticipantes();
  if (p) avisar(`${p.apelido} saiu.`);
}

/**
 * Um par pode sumir sem que o servidor perceba (rede caiu, máquina hibernou).
 * Sem isto ele continuaria listado como presente, mudo para sempre.
 */
function aoEstadoDaConexao(id, situacao) {
  if (situacao !== "failed" && situacao !== "closed") return;
  const p = estado.participantes.get(id);
  if (!p) return;
  avisar(`Perdemos a conexão com ${p.apelido}.`, "erro");
  aoSairParticipante(id);
}

function aoEstadoParticipante({ de, mudo, transmitindo }) {
  const p = estado.participantes.get(de);
  if (!p) return;
  p.mudo = mudo;
  p.transmitindo = transmitindo;
  if (!transmitindo) removerTela(de);
  desenharParticipantes();
}

function anunciarEstado() {
  sinal.enviar({
    tipo: "estado",
    mudo: estado.mudo,
    transmitindo: estado.transmitindo,
  });
}

const SVG_MUDO =
  '<svg viewBox="0 0 24 24" class="sinal--mudo"><path d="M4 4l16 16"/><path d="M9 5a3 3 0 0 1 6 1v5m-1.5 3.5A3 3 0 0 1 9 12v-2"/><path d="M5 11a7 7 0 0 0 10.6 6M19 11a6.9 6.9 0 0 1-.4 2.3"/></svg>';
const SVG_TRANSMITINDO =
  '<svg viewBox="0 0 24 24" class="sinal--transmitindo"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 21h4"/></svg>';

function desenharParticipantes() {
  const lista = $("lista-participantes");
  lista.textContent = "";
  linhas.clear();

  const todos = [
    { id: "eu", apelido: `${estado.apelido} (você)`, mudo: estado.mudo, transmitindo: estado.transmitindo },
    ...[...estado.participantes].map(([id, p]) => ({ id, ...p })),
  ];

  $("contador-participantes").textContent = estado.grupoAtivo ? todos.length : "0";

  if (!estado.grupoAtivo) {
    const vazio = document.createElement("p");
    vazio.className = "participantes__vazio";
    vazio.textContent = "Você não está em nenhum grupo.";
    lista.append(vazio);
    $("subtitulo-sala").textContent = "Selecione ou crie um grupo para começar";
    return;
  }

  for (const p of todos) {
    const linha = document.createElement("div");
    linha.className = "participante";
    linha.dataset.id = p.id;
    // A lista é redesenhada a cada mudança de estado; sem reaplicar a marca,
    // quem estivesse falando apagaria a cada silenciar de outra pessoa.
    linha.dataset.falando = medidores.get(p.id)?.falando ? "sim" : "nao";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = iniciais(p.apelido);

    const nome = document.createElement("span");
    nome.className = "participante__nome";
    nome.textContent = p.apelido;

    const sinais = document.createElement("span");
    sinais.className = "participante__sinais";
    if (p.transmitindo) sinais.innerHTML += SVG_TRANSMITINDO;
    if (p.mudo) sinais.innerHTML += SVG_MUDO;

    linha.append(avatar, nome, sinais);
    lista.append(linha);
    linhas.set(p.id, linha);
  }

  const quantidade = todos.length;
  $("subtitulo-sala").textContent =
    quantidade === 1
      ? "Você é a única pessoa aqui"
      : `${quantidade} pessoas conectadas`;
}

/* ═══ Microfone ═════════════════════════════════════════════════ */

function alternarMicrofone() {
  if (!estado.fluxoMicrofone) return;
  estado.mudo = !estado.mudo;
  estado.fluxoMicrofone.getAudioTracks().forEach((t) => (t.enabled = !estado.mudo));
  atualizarBotaoMicrofone();
  desenharParticipantes();
  anunciarEstado();
}

function atualizarBotaoMicrofone() {
  const botao = $("botao-microfone");
  botao.dataset.mudo = estado.mudo ? "sim" : "nao";
  $("rotulo-microfone").textContent = estado.mudo ? "Microfone mudo" : "Microfone";
}

/* ═══ Transmissão de tela ═══════════════════════════════════════ */

async function alternarTransmissao() {
  if (estado.transmitindo) {
    pararTransmissao();
    return;
  }

  let fluxo;
  try {
    fluxo = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch (erro) {
    if (erro?.name !== "NotAllowedError") {
      avisar("Não foi possível capturar a tela.", "erro");
    }
    return;
  }

  estado.fluxoTela = fluxo;
  estado.transmitindo = true;

  const [trilha] = fluxo.getVideoTracks();
  // Quem encerra pelo botão do próprio Windows não passa pelo nosso botão.
  trilha.addEventListener("ended", pararTransmissao);
  // O que se compartilha aqui é texto e interface: nitidez importa mais que
  // fluidez. "detail" faz o codificador sacrificar quadros para manter a
  // legibilidade, o oposto do padrão de vídeo em movimento.
  trilha.contentHint = "detail";

  malha.publicarTela(trilha, fluxo);
  mostrarTela("eu", fluxo, `${estado.apelido} (você)`);

  atualizarBotaoTransmissao();
  desenharParticipantes();
  anunciarEstado();
}

function pararTransmissao() {
  if (!estado.transmitindo) return;
  estado.transmitindo = false;
  malha.retirarTela();
  estado.fluxoTela?.getTracks().forEach((t) => t.stop());
  estado.fluxoTela = null;
  removerTela("eu");
  atualizarBotaoTransmissao();
  desenharParticipantes();
  anunciarEstado();
}

function atualizarBotaoTransmissao() {
  const botao = $("botao-transmitir");
  botao.dataset.ativo = estado.transmitindo ? "sim" : "nao";
  $("rotulo-transmitir").textContent = estado.transmitindo
    ? "Parar transmissão"
    : "Transmitir tela";
}

/* ═══ Palco ═════════════════════════════════════════════════════ */

function mostrarTela(id, fluxo, rotulo) {
  removerTela(id);

  const quadro = document.createElement("div");
  quadro.className = "transmissao";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = fluxo;

  const etiqueta = document.createElement("span");
  etiqueta.className = "transmissao__etiqueta";
  etiqueta.textContent = rotulo;

  quadro.append(video, etiqueta);
  $("palco-grade").append(quadro);
  telasRemotas.set(id, quadro);
  atualizarPalco();
}

function removerTela(id) {
  const quadro = telasRemotas.get(id);
  if (!quadro) return;
  quadro.querySelector("video").srcObject = null;
  quadro.remove();
  telasRemotas.delete(id);
  atualizarPalco();
}

function atualizarPalco() {
  const total = telasRemotas.size;
  $("palco-grade").dataset.quantidade = String(total);
  $("palco-vazio").classList.toggle("oculto", total > 0);
}

/* ═══ Mídia recebida ════════════════════════════════════════════ */

function receberTrilha(id, trilha, fluxo) {
  if (trilha.kind === "audio") {
    let audio = audiosRemotos.get(id);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.style.display = "none";
      document.body.append(audio);
      audiosRemotos.set(id, audio);
    }
    audio.srcObject = fluxo;
    audio.play().catch(() => {});
    observarVoz(id, fluxo);
    return;
  }

  const p = estado.participantes.get(id);
  mostrarTela(id, fluxo, p?.apelido ?? "Participante");
  if (p) {
    p.transmitindo = true;
    desenharParticipantes();
  }
}

/* ═══ Detecção de fala ══════════════════════════════════════════ */

/** Volume que acende a marca e volume, mais baixo, que a apaga. A folga entre
 *  os dois evita a piscada constante nas pausas entre sílabas. */
const LIMIAR_ENTRADA = 0.022;
const LIMIAR_SAIDA = 0.012;
/** Quanto a marca permanece acesa depois do último trecho acima do limiar. */
const PERMANENCIA = 420;

function observarVoz(id, fluxo) {
  if (fluxo.getAudioTracks().length === 0) return;

  // Uma renegociação reentrega a mesma trilha. Sem soltar o medidor anterior,
  // cada rodada deixaria para trás um nó vivo no grafo do AudioContext.
  esquecerVoz(id);

  contexto ??= new AudioContext();
  contexto.resume().catch(() => {});

  const analisador = contexto.createAnalyser();
  analisador.fftSize = 512;
  const fonte = contexto.createMediaStreamSource(fluxo);
  fonte.connect(analisador);

  medidores.set(id, {
    fonte,
    analisador,
    dados: new Uint8Array(analisador.fftSize),
    ateQuando: 0,
    falando: false,
  });

  // Um único cronômetro atende a todos os participantes.
  cronometroVoz ??= setInterval(medirVozes, 120);
}

function esquecerVoz(id) {
  const medidor = medidores.get(id);
  if (!medidor) return;
  medidor.fonte.disconnect();
  medidor.analisador.disconnect();
  medidores.delete(id);

  if (medidores.size === 0 && cronometroVoz) {
    clearInterval(cronometroVoz);
    cronometroVoz = null;
  }
}

function medirVozes() {
  const agora = performance.now();

  for (const [id, medidor] of medidores) {
    medidor.analisador.getByteTimeDomainData(medidor.dados);

    // Valor eficaz da onda: mede a energia realmente audível, ao contrário da
    // média do espectro, que qualquer chiado de fundo já mantém elevada.
    let soma = 0;
    for (const amostra of medidor.dados) {
      const desvio = (amostra - 128) / 128;
      soma += desvio * desvio;
    }
    const volume = Math.sqrt(soma / medidor.dados.length);

    if (volume > LIMIAR_ENTRADA) medidor.ateQuando = agora + PERMANENCIA;
    else if (volume > LIMIAR_SAIDA && medidor.falando)
      medidor.ateQuando = Math.max(medidor.ateQuando, agora + 120);

    const falando =
      agora < medidor.ateQuando && !(id === "eu" && estado.mudo);
    if (falando === medidor.falando) continue;

    medidor.falando = falando;
    marcarFala(id, falando);
  }
}

function marcarFala(id, falando) {
  const linha = linhas.get(id);
  if (linha) linha.dataset.falando = falando ? "sim" : "nao";
}

/* ═══ Atualização automática ════════════════════════════════════ */

/** De quanto em quanto tempo se pergunta ao servidor. Meia hora é frequente
 *  o bastante para uma correção chegar no mesmo dia e raro o bastante para
 *  não pesar em nada. */
const INTERVALO_ATUALIZACAO = 30 * 60 * 1000;

/** Versão que o usuário já dispensou nesta sessão. */
let atualizacaoAdiada = null;
let instalando = false;

async function procurarAtualizacao() {
  if (instalando) return;
  try {
    const versao = await invocar("procurar_atualizacao");
    if (versao && versao !== atualizacaoAdiada) anunciarAtualizacao(versao);
  } catch {
    // Sem rede, servidor fora do ar ou rodando fora do aplicativo. Nada disso
    // é problema do usuário: a próxima rodada tenta de novo, em silêncio.
  }
}

function anunciarAtualizacao(versao) {
  $("atualizacao-detalhe").textContent = `CALL ${versao} — instala em segundos`;
  $("atualizacao").classList.remove("oculto");

  $("botao-adiar").onclick = () => {
    atualizacaoAdiada = versao;
    $("atualizacao").classList.add("oculto");
  };

  $("botao-atualizar").onclick = () => instalarAtualizacao();
}

async function instalarAtualizacao() {
  if (instalando) return;

  // O instalador encerra o aplicativo. Quem está em uma chamada precisa saber
  // disso antes, e um segundo clique é confirmação suficiente — sem diálogo
  // nativo, que no WebView2 pode simplesmente não aparecer.
  const botao = $("botao-atualizar");
  if (estado.grupoAtivo && botao.dataset.confirmado !== "sim") {
    botao.dataset.confirmado = "sim";
    botao.textContent = "Sair do grupo e atualizar";
    $("atualizacao-detalhe").textContent =
      "O CALL fecha para instalar e reabre em seguida.";
    return;
  }

  // Devolve o microfone e avisa os outros, em vez de deixar um fantasma na sala.
  if (estado.grupoAtivo) sairDoGrupo(false);

  instalando = true;
  $("botao-adiar").disabled = true;
  botao.disabled = true;
  botao.textContent = "Baixando…";

  try {
    await invocar("instalar_atualizacao");
  } catch (erro) {
    instalando = false;
    $("botao-adiar").disabled = false;
    botao.disabled = false;
    botao.dataset.confirmado = "nao";
    botao.textContent = "Atualizar";
    avisar(`Não foi possível atualizar: ${erro}`, "erro");
  }
}

/* ═══ Início ════════════════════════════════════════════════════ */

window.addEventListener("beforeunload", () => {
  limparChamada();
  if (estado.hospedando) invocar("encerrar_hospedagem").catch(() => {});
});

carregarPreferencias();
prepararEntrada();

procurarAtualizacao();
setInterval(procurarAtualizacao, INTERVALO_ATUALIZACAO);
