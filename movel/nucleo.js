/**
 * O núcleo do CALL no celular: estado, protocolo, conta, voz.
 *
 * Este arquivo não desenha nada. Ele é a metade do aplicativo que fala com o
 * servidor, guarda o que está acontecendo e avisa quem estiver olhando —
 * as telas se inscrevem em `eventos` e redesenham só o que mudou.
 *
 * ## O que é reaproveitado do CALL de mesa
 *
 * Tudo que não desenha: `sinal.js` (o protocolo), `livekit.js` e `rtc.js`
 * (os dois transportes de mídia), `audio.js` (o motor de captura, com a porta
 * de ruído e o soundboard), `conta.js` (cadastro, login e sessão),
 * `avatares.js`, `emojis.js` e `tempo.js`. Dois clientes, um protocolo — e
 * nenhuma chance de o celular e o computador discordarem sobre o que uma
 * mensagem é.
 *
 * ## O que muda no celular
 *
 * **A voz dos outros toca em `<audio>`, e não no grafo de áudio.** No CALL de
 * mesa cada participante entra num `GainNode` para haver volume por pessoa e
 * escolha de dispositivo de saída. No celular não há escolha de saída (o
 * sistema decide, e faz isso melhor do que nós), e mandar fluxo remoto para
 * dentro do Web Audio é o caminho conhecido de áudio mudo no Safari do iOS.
 * Um `<audio playsinline>` por pessoa resolve as duas coisas: toca em
 * qualquer aparelho e ainda dá volume por pessoa, pelo `.volume`.
 *
 * **O filtro neural de ruído não é carregado.** São 6 MB de modelo para um
 * aparelho que provavelmente está no 4G. O supressor do sistema, que o
 * `getUserMedia` liga sem custo nenhum, atende.
 *
 * **Não há transmissão de tela partindo daqui.** `getDisplayMedia` não existe
 * em navegador de celular. Assistir à tela de quem transmite do computador,
 * sim — e é o caso que interessa.
 */

import { Sinal } from "../src/sinal.js";
import { SalaLiveKit } from "../src/livekit.js";
import { Malha } from "../src/rtc.js";
import { MotorDeAudio, AUDIO_PADRAO, GANHO_ENTRADA_MAX } from "../src/audio.js";
import { Supressao } from "../src/supressao.js";
import { HistoricoDaCall, relogio } from "../src/tempo.js";
import { avatarSugerido } from "../src/avatares.js";
// De `perfil.js` vem só o que valida dado — os limites de apelido, bio e foto
// que o servidor também aplica. As telas dele são do CALL de mesa e ficam lá.
import { saneado, saneadoGrupo } from "../src/perfil.js";
import * as conta from "../src/conta.js";

/* ═══ Constantes ════════════════════════════════════════════════ */

export const VERSAO = "1.0.0";

/** Servidor oficial do CALL. O mesmo do aplicativo de mesa: é o mesmo CALL. */
const SERVIDOR_PADRAO = "wss://sinalizacao-production.up.railway.app";

/** A página do projeto, que hospeda o convite compartilhável. */
export const SITE = "https://call.aionixdev.com";

const CHAVE = "call.preferencias";

/** Mensagens seguidas da mesma pessoa dentro desta janela viram um bloco só. */
export const AGRUPAR_MS = 5 * 60 * 1000;

export const HORA = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
export const DIA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" });
export const DIA_COM_ANO = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
});

/** Um servidor passado por `?servidor=` vence o gravado — é como os testes
 *  apontam o aplicativo para um backend efêmero sem sujar as preferências. */
const SERVIDOR_DA_PAGINA = (() => {
  const endereco = new URLSearchParams(location.search).get("servidor")?.trim() ?? "";
  return /^wss?:\/\//i.test(endereco) ? endereco : "";
})();

/* ═══ Estado ════════════════════════════════════════════════════ */

export const estado = {
  apelido: "",
  servidor: SERVIDOR_PADRAO,
  usuario: "",
  avatar: "",
  bio: "",
  foto: "",

  conta: null,
  token: "",
  ultimoEmail: "",

  /** Grupos que este aparelho conhece — `[{ codigo, nome, foto }]`. */
  atalhos: [],
  /** codigo do grupo -> quantas conexões o servidor vê nele agora. */
  presencasGrupos: new Map(),

  grupo: null,
  meuId: null,
  membros: new Map(),

  sons: [],

  canalTexto: null,
  canalVoz: null,
  /** id do canal (ou da conta amiga, na PV) -> lista de mensagens. */
  mensagens: new Map(),
  naoLidos: new Map(),

  amigos: [],
  pedidosAmigo: [],
  conversaPrivada: null,

  fluxoMicrofone: null,
  mudo: false,
  /** Silenciar tudo: continua na call, mas não ouve ninguém. */
  surdo: false,
  ocupado: false,
  /** `false`, `true` ou `"reconectando"`. */
  conexao: false,

  audio: { ...AUDIO_PADRAO },
  /** Retorno tátil nos toques. */
  tatico: true,
  /** Avisos sonoros de entrada e saída da call. */
  volumes: new Map(),
  /** Última versão cujas novidades já foram lidas. */
  ultimaVersaoNotasVista: null,
};

/** Quem está falando agora — ids. */
export const falando = new Set();
/** id -> MediaStream de tela que alguém está transmitindo. */
export const telasRecebidas = new Map();
/** id da transmissão -> ids de quem está assistindo. */
export const espectadores = new Map();

/* ═══ Eventos ═══════════════════════════════════════════════════ */

/**
 * O barramento entre o núcleo e as telas.
 *
 * Nomes usados: `atalhos`, `grupo`, `estrutura`, `membros`, `conversa`,
 * `mensagem`, `reacao`, `voz`, `fala`, `tela`, `conexao`, `conta`, `perfil`,
 * `amigos`, `sons`, `naolidos`, `presencas`, `feedback`.
 */
export const eventos = new EventTarget();

export function emitir(nome, detalhe = null) {
  eventos.dispatchEvent(new CustomEvent(nome, { detail: detalhe }));
}

export function ouvir(nome, acao) {
  eventos.addEventListener(nome, (evento) => acao(evento.detail));
}

/**
 * Assina vários eventos de uma vez e devolve como cancelar.
 *
 * Cada tela chama isto ao montar e guarda o retorno no `aoDestruir`. Sem esse
 * par, uma tela desempilhada continuaria redesenhando a si mesma fora do DOM
 * a cada mensagem que chega — o vazamento clássico de uma interface sem
 * framework.
 */
export function assinar(nomes, acao) {
  const atender = (evento) => acao(evento.detail, evento.type);
  for (const nome of nomes) eventos.addEventListener(nome, atender);
  return () => {
    for (const nome of nomes) eventos.removeEventListener(nome, atender);
  };
}

/* ═══ Preferências ══════════════════════════════════════════════ */

const saneadoAtalho = (atalho) => ({
  codigo: String(atalho?.codigo ?? ""),
  nome: saneadoGrupo({ nome: atalho?.nome }).nome,
  foto: saneadoGrupo({ foto: atalho?.foto }).foto,
});

export function carregarPreferencias() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
    estado.apelido = typeof bruto.apelido === "string" ? bruto.apelido : "";
    estado.servidor = SERVIDOR_DA_PAGINA || bruto.servidor || SERVIDOR_PADRAO;
    estado.usuario = bruto.usuario || "";
    estado.ultimoEmail = typeof bruto.ultimoEmail === "string" ? bruto.ultimoEmail : "";

    const perfil = saneado({ avatar: bruto.avatar, bio: bruto.bio, foto: bruto.foto });
    estado.avatar = perfil.avatar;
    estado.bio = perfil.bio;
    estado.foto = perfil.foto;

    estado.atalhos = Array.isArray(bruto.atalhos)
      ? bruto.atalhos.filter((a) => a && typeof a.codigo === "string").map(saneadoAtalho)
      : [];

    for (const chave of Object.keys(AUDIO_PADRAO)) {
      if (bruto.audio && chave in bruto.audio) estado.audio[chave] = bruto.audio[chave];
    }
    estado.audio.ganhoEntrada = Math.min(GANHO_ENTRADA_MAX, Math.max(0, estado.audio.ganhoEntrada));
    // O celular não escolhe dispositivo de saída: quem escolhe é o sistema,
    // e um `deviceId` herdado do computador aqui só quebraria a captura.
    estado.audio.saida = "";

    if (typeof bruto.tatico === "boolean") estado.tatico = bruto.tatico;
    if (typeof bruto.ultimaVersaoNotasVista === "string") {
      estado.ultimaVersaoNotasVista = bruto.ultimaVersaoNotasVista;
    }
    estado.volumes = new Map(Array.isArray(bruto.volumes) ? bruto.volumes : []);
  } catch {
    /* preferências ilegíveis: segue com os padrões */
  }

  if (!estado.usuario) {
    estado.usuario = crypto.randomUUID().replace(/-/g, "");
    salvarPreferencias();
  }
  if (!estado.avatar) estado.avatar = avatarSugerido(estado.usuario);
}

export function salvarPreferencias() {
  try {
    localStorage.setItem(
      CHAVE,
      JSON.stringify({
        apelido: estado.apelido,
        servidor: estado.servidor,
        usuario: estado.usuario,
        ultimoEmail: estado.ultimoEmail,
        avatar: estado.avatar,
        bio: estado.bio,
        foto: estado.foto,
        atalhos: estado.atalhos,
        audio: estado.audio,
        tatico: estado.tatico,
        ultimaVersaoNotasVista: estado.ultimaVersaoNotasVista,
        volumes: [...estado.volumes],
      })
    );
    return true;
  } catch (erro) {
    console.warn("[preferencias] falha ao salvar", erro);
    return false;
  }
}

/* ═══ Motores ═══════════════════════════════════════════════════ */

/**
 * O motor de áudio, sem o filtro neural.
 *
 * `carregarKrisp` que sempre falha é o jeito declarado de dizer "não neste
 * aparelho": `Supressao` já sabe cair para o supressor do sistema, e o
 * caminho de degradação dele é o mesmo que roda quando a licença é negada no
 * computador. Não há código novo, só uma porta fechada.
 */
export const motor = new MotorDeAudio({
  supressao: new Supressao({
    carregarKrisp: () => Promise.reject(new Error("filtro neural não roda no celular")),
  }),
});

export const historicoDaCall = new HistoricoDaCall();

export const sinal = new Sinal();
export const social = new Sinal();

/** id -> HTMLAudioElement que toca a voz daquela pessoa. */
const vozesRemotas = new Map();
/** id -> HTMLAudioElement que toca o som da tela transmitida por alguém. */
const somDeTelas = new Map();

let provedorDeMidia = "malha";
const midiaAtual = () => (provedorDeMidia === "livekit" ? livekit : malha);

export const malha = new Malha({
  enviarSinal: (para, dados) => sinal.enviar({ tipo: "sinal", para, dados }),
  aoTrilha: receberTrilha,
  aoFimDeTrilha: (id, trilha) => {
    if (trilha.kind === "video") removerTela(id);
    else pararSomDeTela(id);
  },
  aoEstado: () => {},
});

export const livekit = new SalaLiveKit({
  aoTrilha: receberTrilha,
  aoFimDeTrilha: (id, trilha, origem) => {
    if (trilha.kind === "video") removerTela(id);
    else if (origem === "screen_share_audio") pararSomDeTela(id);
  },
  aoEstado: () => {},
  aoFala: (id, esta) => {
    if (id !== estado.meuId) marcarFala(id, esta);
  },
  aoEntrar: (sala) => motor.supressao.aoPublicar(sala),
});

/* ═══ Perfil e conta ════════════════════════════════════════════ */

export const souDono = () => Boolean(estado.grupo && estado.grupo.dono === estado.usuario);

export const meuCartao = () => ({
  id: estado.meuId,
  usuario: estado.usuario,
  apelido: estado.apelido,
  avatar: estado.avatar,
  bio: estado.bio,
  foto: estado.foto,
});

/** Manda ao servidor o que a conta guarda. Sem conta, não faz nada. */
export function sincronizarConta(campos) {
  if (!estado.token) return;
  const enviar = sinal.conectado ? (pedido) => sinal.enviar(pedido) : null;
  conta.guardar(estado.servidor, estado.token, campos, enviar).catch(() => {});
}

/** Adota a identidade confirmada pelo servidor depois de entrar na conta. */
export function assumirConta(sessao) {
  estado.conta = sessao.conta;
  estado.token = sessao.token;
  estado.usuario = sessao.conta.id;
  estado.apelido = sessao.conta.apelido || estado.apelido;
  if (sessao.conta.avatar) estado.avatar = sessao.conta.avatar;
  if (typeof sessao.conta.bio === "string") estado.bio = sessao.conta.bio;
  if (typeof sessao.conta.foto === "string" && sessao.conta.foto) estado.foto = sessao.conta.foto;
  conta.guardarSessao(sessao.token, estado.servidor);
  fundirAtalhos(sessao.conta.atalhos);
  salvarPreferencias();
  emitir("conta");
  emitir("perfil");
  conectarSocial();
}

/**
 * Junta o que veio da conta com o que este aparelho já conhecia.
 *
 * A conta manda no nome e na foto de cada grupo (é ela que viu a versão mais
 * recente em qualquer aparelho), mas não apaga um grupo que só existe aqui —
 * quem entrou por convite neste celular e ainda não sincronizou não pode
 * perder o atalho por ter feito login.
 */
export function fundirAtalhos(daConta) {
  if (!Array.isArray(daConta)) return;
  const porCodigo = new Map(estado.atalhos.map((a) => [a.codigo, a]));
  for (const bruto of daConta) {
    const atalho = saneadoAtalho(bruto);
    if (!atalho.codigo) continue;
    porCodigo.set(atalho.codigo, { ...porCodigo.get(atalho.codigo), ...atalho });
  }
  estado.atalhos = [...porCodigo.values()];
  salvarPreferencias();
  emitir("atalhos");
}

export async function sairDaConta() {
  const token = estado.token;
  desligarGrupo();
  desligarSocial();
  estado.conta = null;
  estado.token = "";
  conta.esquecerSessao();
  // A identidade volta a ser deste aparelho: sem isto, quem sai da conta
  // continuaria escrevendo como ela e sendo dono dos grupos dela.
  estado.usuario = crypto.randomUUID().replace(/-/g, "");
  estado.atalhos = [];
  salvarPreferencias();
  emitir("conta");
  emitir("atalhos");
  if (token) await conta.sair(estado.servidor, token).catch(() => {});
}

/* ═══ Grupo ═════════════════════════════════════════════════════ */

const ATRASOS_RECONEXAO = [0, 1000, 2000, 5000, 10000, 20000, 30000];
let temporizadorReconexao = null;
let tentativaReconexao = 0;
let sessaoParaReconectar = null;
let geracaoReconexao = 0;

const saudacaoComPerfil = (saudacao) => ({
  ...saudacao,
  apelido: estado.apelido,
  token: estado.token,
  usuario: estado.usuario,
  avatar: estado.avatar,
  bio: estado.bio,
  foto: estado.foto,
});

/**
 * Uma conexão atende a um grupo só — é assim que o servidor separa quem vê o
 * quê. Trocar de grupo é, portanto, trocar de socket.
 */
export async function conectarGrupo(saudacao) {
  if (estado.ocupado) throw new Error("Um momento…");
  if (saudacao?.tipo === "entrar" && saudacao.codigo !== estado.grupo?.codigo && estado.canalVoz) {
    throw new Error("Você está em uma call. Saia dela antes de trocar de grupo.");
  }

  estado.ocupado = true;
  desligarGrupo();
  emitir("conexao", "conectando");

  try {
    const boasVindas = await sinal.conectar(estado.servidor, saudacaoComPerfil(saudacao));
    assumirGrupo(boasVindas);
    return boasVindas;
  } catch (erro) {
    desligarGrupo();
    throw erro;
  } finally {
    estado.ocupado = false;
  }
}

function cancelarReconexao() {
  clearTimeout(temporizadorReconexao);
  temporizadorReconexao = null;
  tentativaReconexao = 0;
  sessaoParaReconectar = null;
  geracaoReconexao++;
}

function agendarReconexao() {
  if (!estado.grupo) return;

  if (!sessaoParaReconectar) {
    sessaoParaReconectar = {
      codigo: estado.grupo.codigo,
      canalTexto: estado.canalTexto,
      canalVoz: estado.canalVoz,
    };
    tentativaReconexao = 0;
    estado.conexao = "reconectando";
    emitir("conexao", "reconectando");
  }

  if (temporizadorReconexao) return;
  const geracao = geracaoReconexao;
  const atraso = ATRASOS_RECONEXAO[Math.min(tentativaReconexao, ATRASOS_RECONEXAO.length - 1)];
  tentativaReconexao++;
  temporizadorReconexao = setTimeout(() => {
    temporizadorReconexao = null;
    reconectar(geracao);
  }, atraso);
}

async function reconectar(geracao) {
  const sessao = sessaoParaReconectar;
  if (!sessao || geracao !== geracaoReconexao || estado.grupo?.codigo !== sessao.codigo) return;

  try {
    const boasVindas = await sinal.conectar(
      estado.servidor,
      saudacaoComPerfil({ tipo: "entrar", codigo: sessao.codigo })
    );
    if (geracao !== geracaoReconexao || sessao !== sessaoParaReconectar) return;

    // O socket novo recebe outro id de sessão, e no LiveKit outra identidade:
    // os transportes antigos não valem mais, mas o microfone continua aberto.
    if (sessao.canalVoz && estado.fluxoMicrofone) {
      await desmontarMidia(false);
      estado.canalVoz = null;
    }
    if (geracao !== geracaoReconexao || sessao !== sessaoParaReconectar) return;

    assumirGrupo(boasVindas);

    if (sessao.canalTexto && acharCanal(sessao.canalTexto)?.tipo === "texto") {
      estado.canalTexto = sessao.canalTexto;
      sinal.enviar({ tipo: "historico", canal: sessao.canalTexto });
    }
    if (sessao.canalVoz && estado.fluxoMicrofone && acharCanal(sessao.canalVoz)?.tipo === "voz") {
      sinal.enviar({ tipo: "entrar-voz", canal: sessao.canalVoz, transportes: ["livekit", "malha"] });
    } else {
      anunciarEstado();
    }

    clearTimeout(temporizadorReconexao);
    temporizadorReconexao = null;
    tentativaReconexao = 0;
    sessaoParaReconectar = null;
    estado.conexao = true;
    emitir("conexao", true);
  } catch (erro) {
    if (geracao !== geracaoReconexao) return;
    if (/convite inválido|grupo removido/i.test(erro?.message ?? "")) {
      desligarGrupo();
      emitir("erro", "O grupo não existe mais no servidor.");
      return;
    }
    agendarReconexao();
  }
}

function assumirGrupo({ eu, grupo, presentes, conta: daConta, sons }) {
  estado.grupo = grupo;
  estado.meuId = eu.id;

  if (typeof eu.usuario === "string" && eu.usuario && estado.usuario !== eu.usuario) {
    estado.usuario = eu.usuario;
    salvarPreferencias();
  }

  malha.definirIdentidade(eu.id);

  if (daConta) {
    estado.conta = daConta;
    fundirAtalhos(daConta.atalhos);
    emitir("conta");
  }

  estado.membros.clear();
  estado.membros.set(eu.id, {
    ...eu,
    apelido: estado.apelido,
    avatar: estado.avatar,
    bio: estado.bio,
    foto: estado.foto,
  });
  for (const membro of presentes) estado.membros.set(membro.id, membro);
  estado.presencasGrupos.set(grupo.codigo, estado.membros.size);

  estado.sons = sons ?? [];

  lembrarGrupo(grupo.codigo, grupo.nome, grupo.foto);
  sincronizarConta({ atalhos: estado.atalhos });

  estado.conexao = true;
  emitir("conexao", true);
  emitir("grupo");
  emitir("membros");
  emitir("sons");
}

/** Sai do grupo sem mexer na lista de atalhos. */
export function desligarGrupo() {
  cancelarReconexao();
  sairDaVoz(false);
  sinal.desconectar();

  const anterior = estado.grupo?.codigo;
  if (anterior) estado.presencasGrupos.set(anterior, 0);
  estado.grupo = null;
  estado.meuId = null;
  estado.membros.clear();
  estado.canalTexto = null;
  for (const chave of [...estado.mensagens.keys()]) {
    if (!chave.startsWith("conta-")) estado.mensagens.delete(chave);
  }
  estado.naoLidos.clear();
  estado.sons = [];
  estado.conexao = false;

  emitir("conexao", false);
  emitir("grupo");
  emitir("membros");
  emitir("naolidos");
}

export function esquecerGrupo(codigo) {
  if (codigo === estado.grupo?.codigo) desligarGrupo();
  estado.atalhos = estado.atalhos.filter((a) => a.codigo !== codigo);
  salvarPreferencias();
  sincronizarConta({ atalhos: estado.atalhos });
  emitir("atalhos");
}

export function lembrarGrupo(codigo, nome, foto = "") {
  const existente = estado.atalhos.find((a) => a.codigo === codigo);
  const novo = saneadoAtalho({ codigo, nome, foto });
  if (existente) Object.assign(existente, novo);
  else estado.atalhos.push(novo);
  salvarPreferencias();
  emitir("atalhos");
  if (social.conectado) pedirPresencas();
  else conectarSocial();
}

export const canaisDoGrupo = () =>
  estado.grupo?.categorias?.flatMap((categoria) => categoria.canais) ?? [];

export const acharCanal = (id) => canaisDoGrupo().find((canal) => canal.id === id) ?? null;

export const membrosNaVoz = (canal) =>
  [...estado.membros.values()].filter((membro) => membro.canalVoz === canal);

/** Link de convite compartilhável — o mesmo que o aplicativo de mesa gera. */
export function linkDoConvite(codigo, nome = "") {
  const url = new URL(`${SITE}/entrar`);
  url.searchParams.set("c", codigo);
  if (nome) url.searchParams.set("g", nome);
  if (estado.apelido) url.searchParams.set("a", estado.apelido);
  return url.toString();
}

/* ═══ Conversa ══════════════════════════════════════════════════ */

/** O alvo corrente: canal de texto aberto, ou o amigo da PV. */
export const alvoDaConversa = () => estado.conversaPrivada ?? estado.canalTexto;

export function abrirCanalTexto(id) {
  estado.conversaPrivada = null;
  estado.canalTexto = id;
  estado.naoLidos.delete(id);
  if (!estado.mensagens.has(id)) sinal.enviar({ tipo: "historico", canal: id });
  emitir("naolidos");
  emitir("conversa");
}

export function abrirConversaPrivada(amigoId) {
  if (!estado.conta || !amigoId) return;
  estado.canalTexto = null;
  estado.conversaPrivada = amigoId;
  estado.naoLidos.delete(amigoId);
  if (!estado.mensagens.has(amigoId)) {
    social.enviar({ tipo: "historico-privado", token: estado.token, com: amigoId });
  }
  emitir("naolidos");
  emitir("conversa");
}

export function fecharConversa() {
  estado.canalTexto = null;
  estado.conversaPrivada = null;
}

export function enviarMensagem(texto) {
  const limpo = texto.trim().slice(0, 2000);
  if (!limpo) return false;
  if (estado.conversaPrivada) {
    social.enviar({
      tipo: "mensagem-privada",
      token: estado.token,
      para: estado.conversaPrivada,
      texto: limpo,
    });
  } else if (estado.canalTexto) {
    sinal.enviar({ tipo: "mensagem", canal: estado.canalTexto, texto: limpo });
  } else {
    return false;
  }
  return true;
}

export function alterarMensagem(acao, mensagemId, texto = "") {
  if (estado.conversaPrivada) {
    social.enviar({
      tipo: `${acao}-mensagem-privada`,
      token: estado.token,
      para: estado.conversaPrivada,
      mensagem: mensagemId,
      texto,
    });
  } else if (estado.canalTexto) {
    sinal.enviar({ tipo: `${acao}-mensagem`, canal: estado.canalTexto, mensagem: mensagemId, texto });
  }
}

export function reagir(mensagemId, emoji) {
  if (estado.conversaPrivada) {
    social.enviar({
      tipo: "reagir-privado",
      token: estado.token,
      para: estado.conversaPrivada,
      mensagem: mensagemId,
      emoji,
    });
  } else if (estado.canalTexto) {
    sinal.enviar({ tipo: "reagir", canal: estado.canalTexto, mensagem: mensagemId, emoji });
  }
}

function contarNaoLido(chave) {
  estado.naoLidos.set(chave, (estado.naoLidos.get(chave) ?? 0) + 1);
  emitir("naolidos");
}

/* ═══ Sinal do grupo ════════════════════════════════════════════ */

sinal.addEventListener("entrou", (e) => {
  const membro = e.detail.membro;
  estado.membros.set(membro.id, membro);
  if (estado.grupo) estado.presencasGrupos.set(estado.grupo.codigo, estado.membros.size);
  emitir("membros");
});

sinal.addEventListener("saiu", (e) => {
  const id = e.detail.id;
  const membro = estado.membros.get(id);
  if (membro?.canalVoz && membro.canalVoz === estado.canalVoz) {
    historicoDaCall.saiu(id, membro);
    derrubarPar(id);
  }
  estado.membros.delete(id);
  if (estado.grupo) estado.presencasGrupos.set(estado.grupo.codigo, estado.membros.size);
  emitir("membros");
});

sinal.addEventListener("grupo", (e) => {
  estado.grupo = e.detail.grupo;
  if (estado.canalTexto && !acharCanal(estado.canalTexto)) estado.canalTexto = null;
  if (estado.canalVoz && !acharCanal(estado.canalVoz)) sairDaVoz(true);
  lembrarGrupo(estado.grupo.codigo, estado.grupo.nome, estado.grupo.foto);
  emitir("estrutura");
  emitir("grupo");
});

sinal.addEventListener("voz", (e) => {
  aoEntrarNaVoz(e.detail).catch((erro) => {
    console.error("[midia] entrada falhou", erro);
    emitir("erro", "Não foi possível conectar a mídia da call.");
  });
});

sinal.addEventListener("entrou-voz", (e) => {
  const { membro, canal } = e.detail;
  estado.membros.set(membro.id, { ...estado.membros.get(membro.id), ...membro });
  if (canal === estado.canalVoz && membro.id !== estado.meuId) {
    if (provedorDeMidia === "malha") malha.abrir(membro.id, false);
    motor.tocarAviso("entrou");
    historicoDaCall.entrou(membro.id, true);
  }
  emitir("membros");
});

sinal.addEventListener("saiu-voz", (e) => {
  const { id, canal } = e.detail;
  const membro = estado.membros.get(id);
  if (membro) membro.canalVoz = null;
  if (canal === estado.canalVoz) {
    if (membro) historicoDaCall.saiu(id, membro);
    derrubarPar(id);
    motor.tocarAviso("saiu");
  }
  emitir("membros");
});

sinal.addEventListener("sinal", (e) => {
  if (provedorDeMidia === "malha") malha.receberSinal(e.detail.de, e.detail.dados);
});

sinal.addEventListener("estado", (e) => {
  const { de, mudo, transmitindo, atividade, atividadeIcone } = e.detail;
  const membro = estado.membros.get(de);
  if (!membro) return;
  Object.assign(membro, { mudo, transmitindo, atividade, atividadeIcone });
  emitir("membros");
});

sinal.addEventListener("espectadores", (e) => {
  const { transmissao, de, assistindo } = e.detail;
  const lista = espectadores.get(String(transmissao)) ?? new Set();
  if (assistindo) lista.add(String(de));
  else lista.delete(String(de));
  espectadores.set(String(transmissao), lista);
  emitir("tela");
});

sinal.addEventListener("perfil", (e) => {
  const { de, apelido, avatar, bio, foto } = e.detail;
  const membro = estado.membros.get(de);
  if (!membro) return;
  Object.assign(membro, { apelido, avatar, bio, foto });
  emitir("membros");
});

sinal.addEventListener("mensagem", (e) => aoMensagem(e.detail.mensagem));
sinal.addEventListener("mensagem-atualizada", (e) =>
  aoMensagemAtualizada(e.detail.mensagem, e.detail.canal)
);
sinal.addEventListener("reacao", (e) => {
  const { canal, mensagem, reacoes } = e.detail;
  const alvo = estado.mensagens.get(canal)?.find((m) => m.id === mensagem);
  if (alvo) alvo.reacoes = reacoes;
  emitir("reacao", { chave: canal, mensagem, reacoes });
});
sinal.addEventListener("historico", (e) => {
  estado.mensagens.set(e.detail.canal, e.detail.mensagens);
  emitir("conversa", { chave: e.detail.canal });
});

sinal.addEventListener("som", (e) => aoReceberBytesDeSom(e.detail));
sinal.addEventListener("som-adicionado", (e) => {
  estado.sons.push(e.detail.som);
  emitir("sons");
});
sinal.addEventListener("som-removido", (e) => {
  estado.sons = estado.sons.filter((s) => s.id !== e.detail.id);
  emitir("sons");
});
sinal.addEventListener("som-tocado", (e) => {
  const quem = estado.membros.get(e.detail.de);
  const som = estado.sons.find((s) => s.id === e.detail.id);
  if (quem && som) emitir("aviso", `${quem.apelido} tocou "${som.nome}"`);
});

sinal.addEventListener("erro", (e) => emitir("erro", e.detail.motivo));
sinal.addEventListener("queda", () => agendarReconexao());

function aoMensagem(mensagem) {
  const lista = estado.mensagens.get(mensagem.canal);
  if (lista) lista.push(mensagem);
  else estado.mensagens.set(mensagem.canal, [mensagem]);

  const minha = mensagem.autor === estado.usuario;
  if (!minha && mensagem.canal !== estado.canalTexto) contarNaoLido(mensagem.canal);
  if (!minha) motor.ouvirAviso("mensagem").catch(() => {});

  emitir("mensagem", { chave: mensagem.canal, mensagem });
}

function aoMensagemAtualizada(mensagem, canal = mensagem.canal) {
  const lista = estado.mensagens.get(canal);
  const indice = lista?.findIndex((item) => item.id === mensagem.id) ?? -1;
  if (indice >= 0) lista[indice] = mensagem;
  emitir("conversa", { chave: canal });
}

/* ═══ Socket social: amigos, PV e feedback ══════════════════════ */

const ESPERA_SOCIAL = [1000, 2000, 5000, 10000, 20000, 30000];
let tentativasSocial = 0;
let reconexaoSocial = null;
let presencasPendentes = null;
const INTERVALO_PRESENCAS = 30_000;

const socialDeveEstarLigada = () =>
  Boolean((estado.conta && estado.token) || estado.atalhos.length);

export function conectarSocial() {
  clearTimeout(reconexaoSocial);
  if (!socialDeveEstarLigada()) return;
  if (!social.conectarLivre(estado.servidor)) agendarReconexaoSocial();
}

function agendarReconexaoSocial() {
  if (!socialDeveEstarLigada()) return;
  clearTimeout(reconexaoSocial);
  const espera = ESPERA_SOCIAL[Math.min(tentativasSocial, ESPERA_SOCIAL.length - 1)];
  tentativasSocial++;
  reconexaoSocial = setTimeout(conectarSocial, espera);
}

export function desligarSocial() {
  clearTimeout(reconexaoSocial);
  clearTimeout(presencasPendentes);
  presencasPendentes = null;
  tentativasSocial = 0;
  social.desconectar();
  estado.amigos = [];
  estado.pedidosAmigo = [];
  estado.conversaPrivada = null;
  estado.presencasGrupos.clear();
  emitir("amigos");
  emitir("presencas");
}

social.addEventListener("aberto", () => {
  tentativasSocial = 0;
  if (estado.token) social.enviar({ tipo: "amigos", token: estado.token });
  pedirPresencas();
});
social.addEventListener("queda", () => agendarReconexaoSocial());
social.addEventListener("amigo-atualizado", () => pedirAmigos());
social.addEventListener("amigo-pedido", (e) => {
  emitir("aviso", `${e.detail.de.apelido} quer ser seu amigo.`);
  pedirAmigos();
});
social.addEventListener("amigos", (e) => {
  estado.amigos = e.detail.amigos ?? [];
  estado.pedidosAmigo = e.detail.pedidos ?? [];
  emitir("amigos");
});
social.addEventListener("presencas-grupos", (e) => {
  estado.presencasGrupos = new Map(
    (e.detail.presencas ?? [])
      .filter((item) => item?.codigo)
      .map((item) => [item.codigo, Math.max(0, Number(item.quantidade) || 0)])
  );
  emitir("presencas");
});
social.addEventListener("mensagem-privada", (e) => {
  const { mensagem, para } = e.detail;
  const outraParte = mensagem.autor === estado.usuario ? para : mensagem.autor;
  const lista = estado.mensagens.get(outraParte);
  if (lista) lista.push(mensagem);
  else estado.mensagens.set(outraParte, [mensagem]);

  const minha = mensagem.autor === estado.usuario;
  if (!minha) {
    motor.ouvirAviso("mensagem").catch(() => {});
    if (outraParte !== estado.conversaPrivada) contarNaoLido(outraParte);
  }
  emitir("mensagem", { chave: outraParte, mensagem });
});
social.addEventListener("mensagem-privada-atualizada", (e) => {
  const { mensagem, para } = e.detail;
  const outraParte = mensagem.autor === estado.usuario ? para : mensagem.autor;
  aoMensagemAtualizada(mensagem, outraParte);
});
social.addEventListener("reacao-privada", (e) => {
  const { de, para, mensagem, reacoes } = e.detail;
  const outraParte = de === estado.usuario ? para : de;
  const alvo = estado.mensagens.get(outraParte)?.find((m) => m.id === mensagem);
  if (alvo) alvo.reacoes = reacoes;
  emitir("reacao", { chave: outraParte, mensagem, reacoes });
});
social.addEventListener("historico-privado", (e) => {
  estado.mensagens.set(e.detail.com, e.detail.mensagens);
  emitir("conversa", { chave: e.detail.com });
});
social.addEventListener("feedback-enviado", () => emitir("feedback", { enviado: true }));
social.addEventListener("feedback-lista", (e) => emitir("feedback", { lista: e.detail.feedback }));
social.addEventListener("feedback-atualizado", (e) =>
  emitir("feedback", { atualizado: e.detail.feedback })
);
social.addEventListener("sem-sessao", () => emitir("erro", "Sua sessão expirou. Entre de novo."));

export const souAmigoDe = (contaId) => estado.amigos.some((a) => a.id === contaId);

export function pedirAmigos() {
  if (estado.conta && estado.token) social.enviar({ tipo: "amigos", token: estado.token });
}

export function pedirAmizade(paraId) {
  if (!estado.conta || !paraId) return;
  social.enviar({ tipo: "amigo-pedido", token: estado.token, para: paraId });
}

export function responderAmizade(deId, aceitar) {
  social.enviar({ tipo: "amigo-responder", token: estado.token, de: deId, aceitar });
}

export function removerAmizade(amigoId) {
  social.enviar({ tipo: "amigo-remover", token: estado.token, id: amigoId });
  if (estado.conversaPrivada === amigoId) estado.conversaPrivada = null;
}

export function pedirPresencas() {
  if (!estado.atalhos.length || !social.conectado) return;
  social.enviar({
    tipo: "presencas-grupos",
    token: estado.token,
    codigos: estado.atalhos.map((a) => a.codigo),
  });
  clearTimeout(presencasPendentes);
  presencasPendentes = setTimeout(pedirPresencas, INTERVALO_PRESENCAS);
}

export function enviarFeedback({ categoria, titulo, texto }) {
  social.enviar({
    tipo: "feedback-enviar",
    token: estado.token,
    categoria,
    titulo,
    texto,
    versao: `movel ${VERSAO}`,
  });
}

export function pedirMeuFeedback() {
  if (estado.token) social.enviar({ tipo: "feedback-meu", token: estado.token });
}

/* ═══ Voz ═══════════════════════════════════════════════════════ */

const JANELA_TENTATIVAS = 10_000;
const LIMITE_TENTATIVAS = 5;
const BLOQUEIO_TENTATIVAS = 10_000;
let inicioJanelaVoz = 0;
let tentativasVoz = 0;
let bloqueadaVozAte = 0;

let inicioDaCall = 0;
let relogioDaCall = null;
let pararIndicadorLocal = null;

export const tempoDeCall = () => (inicioDaCall ? Date.now() - inicioDaCall : 0);
export const tempoDeCallEmTexto = () => relogio(tempoDeCall());

/**
 * Quem está esperando a entrada na voz terminar.
 *
 * `entrar-voz` é um pedido: quem responde é o servidor, com a lista de quem
 * já está na sala e a credencial de mídia. Sem esta promessa, `entrarNaVoz`
 * resolveria assim que a mensagem saísse pelo socket — e quem chamasse iria
 * abrir a tela da call num instante em que `estado.canalVoz` ainda é `null`.
 * Foi exatamente esse descompasso que fez o toque num canal de voz entrar na
 * chamada sem abrir a tela dela.
 */
let entradaNaVozPendente = null;

/** Uma desistência nossa, e não uma falha — a interface não avisa sobre ela. */
function desistencia(motivo) {
  const erro = new Error(motivo);
  erro.silencioso = true;
  return erro;
}

function encerrarEsperaDaVoz(erro = null) {
  const pendente = entradaNaVozPendente;
  if (!pendente) return;
  entradaNaVozPendente = null;
  clearTimeout(pendente.relogio);
  if (erro) pendente.rejeitar(erro);
  else pendente.resolver();
}

export async function entrarNaVoz(canal) {
  if (estado.canalVoz === canal || estado.ocupado) return;

  const agora = Date.now();
  if (agora < bloqueadaVozAte) {
    throw new Error("Espere um pouco antes de entrar de novo.");
  }
  if (agora - inicioJanelaVoz > JANELA_TENTATIVAS) {
    inicioJanelaVoz = agora;
    tentativasVoz = 0;
  }
  tentativasVoz++;
  if (tentativasVoz > LIMITE_TENTATIVAS) {
    bloqueadaVozAte = agora + BLOQUEIO_TENTATIVAS;
    throw new Error("Espere um pouco antes de entrar de novo.");
  }

  estado.ocupado = true;
  try {
    await pedirMicrofone();
    const entrou = new Promise((resolver, rejeitar) => {
      encerrarEsperaDaVoz(desistencia("Entrada substituída."));
      entradaNaVozPendente = {
        resolver,
        rejeitar,
        relogio: setTimeout(
          () => encerrarEsperaDaVoz(new Error("O servidor não respondeu a tempo.")),
          15000
        ),
      };
    });
    sinal.enviar({ tipo: "entrar-voz", canal, transportes: ["livekit", "malha"] });
    await entrou;
  } finally {
    estado.ocupado = false;
  }
}

export async function pedirMicrofone() {
  if (estado.fluxoMicrofone) return estado.fluxoMicrofone;
  try {
    await motor.aplicar(estado.audio);
    estado.fluxoMicrofone = await motor.abrirMicrofone();
    await Promise.all([
      malha.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
      livekit.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
    ]);
    return estado.fluxoMicrofone;
  } catch (erro) {
    console.error("[audio] captura falhou", erro);
    throw new Error(
      erro?.name === "NotAllowedError"
        ? "O microfone está bloqueado. Libere o acesso nas permissões do navegador."
        : "Não foi possível acessar o microfone."
    );
  }
}

async function aoEntrarNaVoz({ canal, pares, midia }) {
  if (!estado.fluxoMicrofone) {
    sinal.enviar({ tipo: "sair-voz" });
    encerrarEsperaDaVoz(new Error("O microfone não estava pronto."));
    return;
  }

  if (estado.canalVoz && estado.canalVoz !== canal) await desmontarMidia(false);
  estado.canalVoz = canal;

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.canalVoz = canal;

  const [trilha] = estado.fluxoMicrofone.getAudioTracks();
  provedorDeMidia = midia?.provedor === "livekit" ? "livekit" : "malha";
  midiaAtual().definirAudioLocal(trilha, estado.fluxoMicrofone);

  for (const par of pares) {
    estado.membros.set(par.id, { ...estado.membros.get(par.id), ...par });
  }

  if (provedorDeMidia === "livekit") {
    try {
      await livekit.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga });
      await livekit.entrar(midia);
    } catch (erro) {
      console.error("[livekit] conexão falhou", erro);
      sinal.enviar({ tipo: "sair-voz" });
      await desmontarMidia();
      estado.canalVoz = null;
      if (eu) eu.canalVoz = null;
      emitir("voz");
      encerrarEsperaDaVoz(erro);
      throw erro;
    }
  }

  observarVozLocal();
  comecarCall();

  for (const par of pares) {
    if (provedorDeMidia === "malha") malha.abrir(par.id, true);
    historicoDaCall.entrou(par.id, false);
  }

  motor.tocarAviso("entrei");
  anunciarSessaoDeMidia();
  emitir("voz");
  emitir("membros");
  anunciarEstado();
  encerrarEsperaDaVoz();
}

export function sairDaVoz(anunciar = true) {
  encerrarEsperaDaVoz(desistencia("Saiu da call antes de entrar."));
  if (!estado.canalVoz) return;
  if (anunciar) sinal.enviar({ tipo: "sair-voz" });

  motor.tocarAviso("sai");
  encerrarCall();
  desmontarMidia();
  estado.canalVoz = null;
  estado.mudo = false;
  estado.surdo = false;

  const eu = estado.membros.get(estado.meuId);
  if (eu) {
    eu.canalVoz = null;
    eu.mudo = false;
    eu.transmitindo = false;
  }

  limparSessaoDeMidia();
  emitir("voz");
  emitir("membros");
}

function desmontarMidia(soltarMicrofone = true) {
  malha.fecharTudo();
  const fechamento = livekit.fecharTudo();
  provedorDeMidia = "malha";

  pararIndicadorLocal?.();
  pararIndicadorLocal = null;

  for (const id of [...vozesRemotas.keys()]) derrubarPar(id);
  for (const id of [...telasRecebidas.keys()]) removerTela(id);
  for (const id of [...somDeTelas.keys()]) pararSomDeTela(id);
  falando.clear();
  emitir("fala");

  if (!soltarMicrofone) return fechamento;

  motor.soltarMicrofone();
  estado.fluxoMicrofone = null;
  estado.mudo = false;
  motor.encerrar().catch(() => {});
  return fechamento;
}

function comecarCall() {
  historicoDaCall.comecar();
  inicioDaCall = Date.now();
  relogioDaCall ??= setInterval(() => emitir("relogio"), 1000);
}

function encerrarCall() {
  clearInterval(relogioDaCall);
  relogioDaCall = null;
  inicioDaCall = 0;
  historicoDaCall.comecar();
}

export function alternarMudo() {
  if (!estado.fluxoMicrofone) return;
  estado.mudo = !estado.mudo;
  for (const trilha of estado.fluxoMicrofone.getAudioTracks()) trilha.enabled = !estado.mudo;

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.mudo = estado.mudo;
  if (estado.mudo) marcarFala(estado.meuId, false);

  emitir("voz");
  emitir("membros");
  anunciarEstado();
}

/**
 * Silenciar tudo — o "fone cortado" que existe em todo app de call.
 *
 * Mudo é sobre o que sai; surdo é sobre o que entra. Estar surdo implica
 * estar mudo, porque falar sem ouvir é falar por cima dos outros; sair do
 * surdo devolve o microfone ao estado em que ele estava.
 */
export function alternarSurdo() {
  estado.surdo = !estado.surdo;
  for (const audio of vozesRemotas.values()) audio.muted = estado.surdo;
  for (const audio of somDeTelas.values()) audio.muted = estado.surdo;

  if (estado.surdo && !estado.mudo) alternarMudo();
  emitir("voz");
  anunciarEstado();
}

export function anunciarEstado() {
  sinal.enviar({
    tipo: "estado",
    mudo: estado.mudo,
    transmitindo: false,
    atividade: null,
    atividadeIcone: null,
  });
}

/* ── Trilhas recebidas ────────────────────────────────────────── */

/** id -> id do MediaStream que carrega a voz daquela pessoa. */
const fluxosDeVoz = new Map();

function receberTrilha(id, trilha, fluxo, origem = null) {
  if (trilha.kind === "audio") {
    const audioDeTela = origem === "screen_share_audio";
    if (!audioDeTela && !fluxosDeVoz.has(id)) fluxosDeVoz.set(id, fluxo.id);

    if (audioDeTela || fluxosDeVoz.get(id) !== fluxo.id) {
      tocarSomDeTela(id, fluxo);
      return;
    }
    tocarVozDe(id, fluxo);
    return;
  }

  telasRecebidas.set(String(id), fluxo);
  const membro = estado.membros.get(id);
  if (membro) membro.transmitindo = true;
  if (id !== estado.meuId) {
    sinal.enviar({ tipo: "assistindo", transmissao: String(id), assistindo: true });
  }
  emitir("tela");
  emitir("membros");
}

/**
 * Um elemento de áudio por pessoa.
 *
 * `playsinline` é obrigatório no iOS: sem ele o Safari tenta abrir o
 * reprodutor em tela cheia mesmo para uma trilha sem vídeo. E `play()` pode
 * ser recusado até o primeiro toque — mas quem entra numa call já tocou na
 * tela para entrar, então o gesto sempre existe quando isto roda.
 */
function tocarVozDe(id, fluxo) {
  let audio = vozesRemotas.get(id);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.append(audio);
    vozesRemotas.set(id, audio);
  }
  const membro = estado.membros.get(id);
  audio.volume = Math.min(1, estado.volumes.get(membro?.usuario) ?? 1);
  audio.muted = estado.surdo;
  audio.srcObject = fluxo;
  audio.play().catch(() => {});
}

function tocarSomDeTela(id, fluxo) {
  let audio = somDeTelas.get(id);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.append(audio);
    somDeTelas.set(id, audio);
  }
  const membro = estado.membros.get(id);
  audio.volume = Math.min(1, estado.volumes.get(membro?.usuario) ?? 1);
  audio.muted = estado.surdo;
  audio.srcObject = fluxo;
  audio.play().catch(() => {});
}

function pararSomDeTela(id) {
  const audio = somDeTelas.get(id);
  if (!audio) return;
  audio.pause();
  audio.srcObject = null;
  audio.remove();
  somDeTelas.delete(id);
}

function removerTela(id) {
  const chave = String(id);
  if (!telasRecebidas.has(chave)) return;
  telasRecebidas.delete(chave);
  espectadores.delete(chave);
  const membro = estado.membros.get(id);
  if (membro) membro.transmitindo = false;
  if (id !== estado.meuId) {
    sinal.enviar({ tipo: "assistindo", transmissao: chave, assistindo: false });
  }
  emitir("tela");
  emitir("membros");
}

function derrubarPar(id) {
  malha.fechar(id);
  removerTela(id);
  pararSomDeTela(id);
  fluxosDeVoz.delete(id);
  marcarFala(id, false);

  const audio = vozesRemotas.get(id);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    vozesRemotas.delete(id);
  }
}

/** Volume de uma pessoa, de 0 a 1,5 — lembrado entre sessões. */
export function definirVolumeDe(usuario, valor) {
  const volume = Math.min(1.5, Math.max(0, valor));
  if (volume === 1) estado.volumes.delete(usuario);
  else estado.volumes.set(usuario, volume);
  salvarPreferencias();

  for (const [id, audio] of vozesRemotas) {
    if (estado.membros.get(id)?.usuario === usuario) audio.volume = Math.min(1, volume);
  }
  for (const [id, audio] of somDeTelas) {
    if (estado.membros.get(id)?.usuario === usuario) audio.volume = Math.min(1, volume);
  }
  emitir("membros");
}

export const volumeDe = (usuario) => estado.volumes.get(usuario) ?? 1;

/* ── Quem está falando ────────────────────────────────────────── */

function observarVozLocal() {
  pararIndicadorLocal?.();
  marcarFala(estado.meuId, false);
  pararIndicadorLocal = motor.assinarNivel((dados) => {
    marcarFala(estado.meuId, Boolean(dados.falando) && !estado.mudo);
  });
}

function marcarFala(id, esta) {
  const chave = String(id);
  if (esta === falando.has(chave)) return;
  if (esta) falando.add(chave);
  else falando.delete(chave);
  emitir("fala", { id: chave, falando: esta });
}

/* ── Sessão de mídia do sistema ───────────────────────────────── */

/**
 * A tarjeta de mídia do sistema — a que aparece na tela de bloqueio.
 *
 * Não é enfeite: sem ela, o Android mostra "call.aionixdev.com reproduzindo
 * áudio" numa notificação genérica, e o iOS mostra nada. Com ela, quem está
 * numa call vê o nome do canal e um botão de mudo no lugar onde já procura
 * controle de áudio.
 */
function anunciarSessaoDeMidia() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: acharCanal(estado.canalVoz)?.nome ?? "Canal de voz",
      artist: estado.grupo?.nome ?? "CALL",
      album: "CALL",
      artwork: [
        { src: "icones/icone-192.png", sizes: "192x192", type: "image/png" },
        { src: "icones/icone-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
    navigator.mediaSession.playbackState = "playing";
    navigator.mediaSession.setActionHandler("pause", () => alternarMudo());
    navigator.mediaSession.setActionHandler("play", () => alternarMudo());
    navigator.mediaSession.setActionHandler("stop", () => sairDaVoz(true));
  } catch {
    /* aparelho sem suporte — a call funciona igual */
  }
}

function limparSessaoDeMidia() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = "none";
    navigator.mediaSession.metadata = null;
  } catch {
    /* idem */
  }
}

/* ═══ Soundboard ════════════════════════════════════════════════ */

export const SOM_BYTES_MAX = 300 * 1024;

const pedidosDeSom = new Map();

function aoReceberBytesDeSom({ id, dados }) {
  const fila = pedidosDeSom.get(id);
  if (!fila) return;
  pedidosDeSom.delete(id);
  const bytes = decodificarBase64(dados);
  for (const resolver of fila) resolver(bytes);
}

function pedirBytesDoSom(id) {
  return new Promise((resolver) => {
    if (!pedidosDeSom.has(id)) pedidosDeSom.set(id, []);
    pedidosDeSom.get(id).push(resolver);
    sinal.enviar({ tipo: "pedir-som", id });
    setTimeout(() => {
      const fila = pedidosDeSom.get(id);
      if (!fila) return;
      pedidosDeSom.delete(id);
      for (const r of fila) r(null);
    }, 8000);
  });
}

export async function tocarSomDoGrupo(som) {
  const bytes = await pedirBytesDoSom(som.id);
  if (!bytes) throw new Error("Não deu para baixar este som.");
  await motor.tocarClipe(bytes, som.id);
  sinal.enviar({ tipo: "som-tocado", id: som.id });
}

export function removerSomDoGrupo(som) {
  sinal.enviar({ tipo: "remover-som", id: som.id });
}

export async function adicionarSomAoGrupo(arquivo) {
  if (!arquivo) return;
  if (arquivo.size > SOM_BYTES_MAX) {
    throw new Error("O arquivo passa de 300 KB. Escolha um clipe mais curto.");
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  sinal.enviar({
    tipo: "adicionar-som",
    nome: arquivo.name.replace(/\.[^.]+$/, "").slice(0, 40),
    mime: arquivo.type || "audio/mpeg",
    dados: codificarBase64(bytes),
  });
}

export function decodificarBase64(base64) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export function codificarBase64(bytes) {
  let binario = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(binario);
}

/* ═══ Estrutura do grupo ════════════════════════════════════════ */

export const criarCategoria = (nome) => sinal.enviar({ tipo: "criar-categoria", nome });
export const criarCanal = (categoria, nome, tipo) =>
  sinal.enviar({ tipo: "criar-canal", categoria, nome, canal: tipo });
export const renomear = (alvo, id, nome) => sinal.enviar({ tipo: "renomear", alvo, id, nome });
export const remover = (alvo, id) => sinal.enviar({ tipo: "remover", alvo, id });
export const editarGrupoNoServidor = (campos) => sinal.enviar({ tipo: "editar-grupo", ...campos });

/* ═══ Conta: reexportado para as telas ══════════════════════════ */

export { conta };
