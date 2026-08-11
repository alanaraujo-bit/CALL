import { Sinal } from "./sinal.js";
import { SalaLiveKit } from "./livekit.js";
import {
  Malha,
  PERFIS_TELA,
  PERFIL_TELA_PADRAO,
  acharPerfilDeTela,
  restricoesDoPerfil,
} from "./rtc.js";
import { MotorDeAudio, AUDIO_PADRAO, BITRATES_AUDIO, listarDispositivos } from "./audio.js";
import { HistoricoDaCall, relogio, tempoCurto } from "./tempo.js";
import { Vigia } from "./atividade.js";
import { avatarSugerido, pintarAvatar, pintarMarcaDeGrupo } from "./avatares.js";
import { CATEGORIAS_EMOJI, TODOS_EMOJIS, TOKEN_EMOJI, acharEmoji, elementoDeEmoji } from "./emojis.js";
import {
  editarGrupo,
  editarPerfil,
  iniciarOnboarding,
  lerIconeDeArquivo,
  mostrarCartao,
  prepararEscolhaDeFoto,
  saneado,
  saneadoGrupo,
} from "./perfil.js";
import * as conta from "./conta.js";

/* ═══ Atalhos ═══════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const invocar = (comando, args) =>
  window.__TAURI__?.core?.invoke
    ? window.__TAURI__.core.invoke(comando, args)
    : Promise.reject(new Error("Recurso disponível apenas no aplicativo."));

const CHAVE = "call.preferencias";
const VERSAO_ATUAL = "0.10.3";
/** Servidor oficial do CALL, hospedado. É o padrão para que ninguém precise
 *  subir nada na própria máquina para conversar com os amigos. */
const SERVIDOR_PADRAO = "wss://sinalizacao-production.up.railway.app";

/** Padrão das versões anteriores. Quem já usou o CALL tem este endereço
 *  gravado, e sem a troca continuaria preso a um servidor local que na maioria
 *  das máquinas nem está de pé. */
const SERVIDOR_ANTIGO = "ws://127.0.0.1:8787";

/** No navegador de desenvolvimento, o endereço local pode ter sido escolhido
 *  de propósito. Migrá-lo de volta ao servidor hospedado a cada recarga fazia
 *  o teste local mudar de backend sem avisar. */
const PAGINA_LOCAL = ["127.0.0.1", "localhost"].includes(window.location.hostname);

/** Página do projeto, que hospeda a página de convite. */
const SITE = "https://call.aionixdev.com";

const HORA = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const DIA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

/** Mensagens seguidas da mesma pessoa dentro desta janela viram um bloco só. */
const AGRUPAR_MS = 5 * 60 * 1000;

/* ═══ Estado ════════════════════════════════════════════════════ */

const estado = {
  apelido: "",
  servidor: SERVIDOR_PADRAO,
  /** Identidade estável entre execuções. Não autentica ninguém: serve para o
   *  servidor reconhecer a mesma pessoa e atribuir autoria às mensagens. */
  usuario: "",
  /** Mascote escolhido — um identificador de `avatares.js`, ou vazio para
   *  aparecer com as iniciais. */
  avatar: "",
  /** Uma linha sobre você, mostrada no cartão para quem está no mesmo grupo.
   *  Viaja na saudação; quem tem conta a encontra de volta em outra máquina. */
  bio: "",
  /** Um data URL quadrado, escolhido no onboarding ou no perfil. Nunca viaja
   *  para o servidor — ele só entende o mascote de `avatar` —, e por isso só
   *  aparece para a própria pessoa, neste computador. */
  foto: "",

  /** A conta em que se entrou — `{ id, email, apelido, avatar, bio, atalhos,
   *  google }` —, ou `null` para quem entrou sem conta. Quem está aqui tem o
   *  `usuario` decidido pelo servidor, e não pelo próprio cliente. */
  conta: null,
  /** Token da sessão. Vive no `localStorage`, fora das preferências, porque
   *  sair da conta é apagar um item — e não editar um objeto. */
  token: "",
  /** Último e-mail usado neste computador. Não é sessão: é a diferença entre
   *  abrir o CALL na aba "Entrar" com o campo pronto, e abrir num formulário
   *  em branco perguntando quem você é. */
  ultimoEmail: "",
  /** Grupos que este computador conhece — [{ codigo, nome, foto }]. O servidor é a
   *  fonte da verdade; isto é só a lista de atalhos da coluna da esquerda. */
  atalhos: [],

  grupo: null, // { codigo, nome, foto, descricao, dono, categorias } vindo do servidor
  meuId: null,
  membros: new Map(), // id -> { id, usuario, apelido, canalVoz, mudo, transmitindo }

  /** Soundboard do grupo atual — [{ id, dono, nome, mime, bytes, criadoEm }],
   *  só metadado. Os bytes de cada um chegam sob demanda, na primeira vez
   *  que alguém pede para tocar. */
  sons: [],
  /** Biblioteca pessoal de quem tem conta — carregada sob demanda, ao abrir
   *  a aba "Sons" dos ajustes. */
  sonsPessoais: [],

  canalTexto: null,
  canalVoz: null,
  mensagens: new Map(), // idCanal -> [mensagem]; conversa privada usa o id da conta amiga como chave
  naoLidos: new Map(), // idCanal -> quantidade

  /** [{ id, apelido, avatar }] — só quem tem conta tem isto preenchido. */
  amigos: [],
  /** Pedidos de amizade recebidos e ainda não respondidos — [{ de, apelido, avatar, em }]. */
  pedidosAmigo: [],
  /** Id da conta amiga com quem a conversa privada está aberta, ou `null`. */
  conversaPrivada: null,
  /** A coluna de canais está mostrando a lista de amigos em vez da árvore
   *  do grupo — não fecha o grupo, só troca o que aparece ao lado dele. */
  vistaAmigos: false,

  fluxoMicrofone: null,
  fluxoTela: null,
  mudo: false,
  transmitindo: false,
  hospedando: false,
  ocupado: false,

  /** Preferências de áudio; a forma delas vive em `audio.js`. */
  audio: { ...AUDIO_PADRAO },
  /** Perfil de qualidade da transmissão de tela. */
  perfilTela: PERFIL_TELA_PADRAO,
  /** Compartilhar o som do sistema junto com a tela. */
  audioDaTela: true,
  /** Mostrar aos outros que aplicativo está em primeiro plano aqui. */
  mostrarAtividade: true,
  escalaInterface: 1,
  brilhoCursor: true,
  tamanhoBrilhoCursor: 460,
  intensidadeBrilhoCursor: 100,
  /** Primeiro cosmético do app; a chave já nasce plural para o dia em que
   *  boné/banner entrarem ao lado dele. */
  cursorPersonalizado: true,
  /** A busca periódica pode ser desligada; a verificação manual continua
   * sempre disponível no painel de Atualizações. */
  buscarAtualizacoesAutomaticamente: true,
  /** `{ versao, lembrarEm }`, ou `null`: o "Depois" não perde a versão, só
   * agenda uma nova lembrança sem virar uma interrupção a cada abertura. */
  lembreteAtualizacao: null,
  /** Última versão encontrada, mantida para o atalho de atualização continuar
   * visível mesmo se o aplicativo for fechado antes de ela ser instalada. */
  atualizacaoPendente: null,
  /** O que já foi anunciado ao grupo. Não é preferência: é o que está no ar. */
  minhaAtividade: null,
  /** Ícone da atividade no ar, quando ela veio de um programa cadastrado a
   *  mão com imagem. `null` para uma atividade sem ícone, ou nenhuma. */
  minhaAtividadeIcone: null,
  /** Programas cadastrados a mão porque o CALL não reconheceu sozinho, ou
   *  reconheceu com um nome feio: exe em minúsculas → `{ nome, icone }`.
   *  `icone` é um data URL pequeno, ou `null` para um cadastro só de nome. */
  programasPersonalizados: new Map(),
  /** Volume por pessoa, guardado pelo identificador estável e não pelo `id`
   *  da sessão — quem sobe o volume de alguém quer isso amanhã também. */
  volumes: new Map(), // usuario -> 0 a 2

  /** Atalho global de mutar/desmutar, como string de aceleração do Tauri
   *  (ex.: `"Ctrl+Shift+KeyM"`) — `null` quando nenhum está definido. Global
   *  de verdade: funciona com a janela sem foco ou escondida na bandeja. */
  atalhoMudo: null,
};

const audiosRemotos = new Map(); // id -> HTMLAudioElement de sustentação
const telas = new Map(); // id -> HTMLElement do palco
const linhas = new Map(); // id -> [HTMLElement] que recebem a marca de fala
const medidores = new Map(); // id -> { no, analisador, dados, ateQuando, falando }
const falas = new Map(); // id -> estado visual, preservado quando a lista é redesenhada
const saneadoAtalho = (atalho) => ({
  codigo: String(atalho?.codigo ?? ""),
  nome: saneadoGrupo({ nome: atalho?.nome }).nome,
  foto: saneadoGrupo({ foto: atalho?.foto }).foto,
});

const motor = new MotorDeAudio();
let cronometroVoz = null;
let pararIndicadorLocal = null;

/** Quem está na call e quem já passou por ela. A regra mora em `tempo.js`. */
const historicoDaCall = new HistoricoDaCall();

/**
 * O que este computador está usando. Só olha enquanto há grupo — fora dele
 * não há a quem contar — e só fala quando muda.
 */
const vigia = new Vigia({
  ler: () => invocar("atividade_em_foco"),
  personalizados: () => estado.programasPersonalizados,
  aoMudar: (nome) => {
    estado.minhaAtividade = nome;
    estado.minhaAtividadeIcone = nome ? iconeDoNomeAtivo(nome) : null;
    const eu = estado.membros.get(estado.meuId);
    if (eu) {
      eu.atividade = nome;
      eu.atividadeIcone = estado.minhaAtividadeIcone;
    }
    anunciarEstado();
    redesenhar();
    mostrarAtividadeAtual();
  },
});

/** Início da call atual e o relógio de um segundo que atualiza o rodapé. */
let inicioDaCall = 0;
let relogioDaCall = null;

const sinal = new Sinal();

/**
 * O socket social: amigos e mensagem privada, vivo por toda a sessão de
 * quem tem conta — não pelo tempo de um grupo. `sinal` nasce e morre a cada
 * troca de grupo (ver a nota em `conectar`); amizade não é assunto de
 * grupo nenhum, então não pode depender do socket que só existe enquanto
 * se está dentro de um. Ver `conectarSocial`/`desligarSocial`.
 */
const social = new Sinal();

const malha = new Malha({
  enviarSinal: (para, dados) => sinal.enviar({ tipo: "sinal", para, dados }),
  aoTrilha: receberTrilha,
  aoFimDeTrilha: (id, trilha) => {
    if (trilha.kind === "video") removerTela(id);
    // Quem parou de transmitir levou junto o som da transmissão; a voz
    // continua, e o nó dela não pode ser tocado aqui.
    else motor.desligarSaida(`tela:${id}`);
  },
  aoEstado: aoEstadoDaConexao,
});

const livekit = new SalaLiveKit({
  aoTrilha: receberTrilha,
  aoFimDeTrilha: (id, trilha, origem) => {
    if (trilha.kind === "video") removerTela(id);
    else if (origem === "screen_share_audio") motor.desligarSaida(`tela:${id}`);
  },
  aoEstado: aoEstadoDaConexao,
  // O detector local vem da porta de ruído, que representa melhor o que este
  // usuário está enviando. O LiveKit fica como fonte de verdade para os demais.
  aoFala: (id, falando) => {
    if (id !== estado.meuId) marcarFala(id, falando);
  },
});

/** O servidor escolhe o transporte por call. Servidores antigos não enviam
 * `midia` e continuam usando a malha sem precisar de atualização coordenada. */
let provedorDeMidia = "malha";
const midiaAtual = () => (provedorDeMidia === "livekit" ? livekit : malha);

/* ═══ Preferências ══════════════════════════════════════════════ */

function carregarPreferencias() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
    estado.apelido = bruto.apelido ?? "";
    // Quem escolheu um servidor próprio continua com ele; só o padrão antigo,
    // que a pessoa nunca escolheu de fato, é levado ao servidor hospedado.
    estado.servidor =
      !bruto.servidor || (bruto.servidor === SERVIDOR_ANTIGO && !PAGINA_LOCAL)
        ? SERVIDOR_PADRAO
        : bruto.servidor;
    estado.usuario = bruto.usuario || "";
    estado.ultimoEmail = typeof bruto.ultimoEmail === "string" ? bruto.ultimoEmail : "";
    const perfil = saneado({ avatar: bruto.avatar, bio: bruto.bio, foto: bruto.foto });
    estado.avatar = perfil.avatar;
    estado.bio = perfil.bio;
    estado.foto = perfil.foto;
    estado.atalhos = Array.isArray(bruto.atalhos)
      ? bruto.atalhos
          .filter((a) => a && typeof a.codigo === "string")
          .map(saneadoAtalho)
      : [];

    // Só as chaves conhecidas entram: uma preferência gravada por uma versão
    // futura, ou adulterada à mão, não deve virar constraint de captura.
    for (const chave of Object.keys(AUDIO_PADRAO)) {
      if (bruto.audio && chave in bruto.audio) estado.audio[chave] = bruto.audio[chave];
    }
    if (PERFIS_TELA.some((p) => p.id === bruto.perfilTela)) estado.perfilTela = bruto.perfilTela;
    if (typeof bruto.audioDaTela === "boolean") estado.audioDaTela = bruto.audioDaTela;
    if (typeof bruto.mostrarAtividade === "boolean") {
      estado.mostrarAtividade = bruto.mostrarAtividade;
    }
    if (Number.isFinite(bruto.escalaInterface)) {
      estado.escalaInterface = Math.min(1.4, Math.max(0.8, bruto.escalaInterface));
    }
    if (typeof bruto.brilhoCursor === "boolean") estado.brilhoCursor = bruto.brilhoCursor;
    if (Number.isFinite(bruto.tamanhoBrilhoCursor)) {
      estado.tamanhoBrilhoCursor = Math.min(700, Math.max(280, bruto.tamanhoBrilhoCursor));
    }
    if (Number.isFinite(bruto.intensidadeBrilhoCursor)) {
      estado.intensidadeBrilhoCursor = Math.min(160, Math.max(20, bruto.intensidadeBrilhoCursor));
    }
    if (typeof bruto.cursorPersonalizado === "boolean") {
      estado.cursorPersonalizado = bruto.cursorPersonalizado;
    }
    if (typeof bruto.buscarAtualizacoesAutomaticamente === "boolean") {
      estado.buscarAtualizacoesAutomaticamente = bruto.buscarAtualizacoesAutomaticamente;
    }
    if (
      bruto.lembreteAtualizacao &&
      typeof bruto.lembreteAtualizacao.versao === "string" &&
      Number.isFinite(bruto.lembreteAtualizacao.lembrarEm)
    ) {
      estado.lembreteAtualizacao = bruto.lembreteAtualizacao;
    }
    if (
      bruto.atualizacaoPendente &&
      typeof bruto.atualizacaoPendente.versao === "string" &&
      typeof bruto.atualizacaoPendente.notas === "string"
    ) {
      estado.atualizacaoPendente = bruto.atualizacaoPendente;
    }
    if (typeof bruto.atalhoMudo === "string") estado.atalhoMudo = bruto.atalhoMudo;
    estado.volumes = new Map(Array.isArray(bruto.volumes) ? bruto.volumes : []);
    estado.programasPersonalizados = new Map(
      Array.isArray(bruto.programasPersonalizados)
        ? bruto.programasPersonalizados.filter(
            ([exe, dados]) => typeof exe === "string" && exe && dados && typeof dados.nome === "string"
          )
        : []
    );
  } catch {
    /* preferências ilegíveis: segue com os padrões */
  }

  // O servidor aceita letras, números e hífen. Gerar aqui, e não lá, é o que
  // permite ser reconhecido como a mesma pessoa depois de reinstalar o app.
  if (!estado.usuario) {
    estado.usuario = crypto.randomUUID().replace(/-/g, "");
    salvarPreferencias();
  }

  // Quem nunca escolheu ganha um mascote sorteado do próprio identificador.
  // Sem isto, um grupo recém-criado teria seis avatares idênticos — e o avatar
  // deixaria de distinguir alguém justamente antes de qualquer ajuste.
  if (!estado.avatar) estado.avatar = avatarSugerido(estado.usuario);
  aplicarEscalaDaInterface();
  aplicarPreferenciasDoBrilho();
  aplicarCursorPersonalizado();
}

function salvarPreferencias() {
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
        perfilTela: estado.perfilTela,
        audioDaTela: estado.audioDaTela,
        mostrarAtividade: estado.mostrarAtividade,
        escalaInterface: estado.escalaInterface,
        brilhoCursor: estado.brilhoCursor,
        tamanhoBrilhoCursor: estado.tamanhoBrilhoCursor,
        intensidadeBrilhoCursor: estado.intensidadeBrilhoCursor,
        cursorPersonalizado: estado.cursorPersonalizado,
        buscarAtualizacoesAutomaticamente: estado.buscarAtualizacoesAutomaticamente,
        lembreteAtualizacao: estado.lembreteAtualizacao,
        atualizacaoPendente: estado.atualizacaoPendente,
        atalhoMudo: estado.atalhoMudo,
        volumes: [...estado.volumes],
        programasPersonalizados: [...estado.programasPersonalizados],
      })
    );
    return true;
  } catch (erro) {
    console.warn("[preferencias] falha ao salvar", erro);
    avisar("Não deu para salvar tudo neste navegador. Tente uma imagem menor.", "erro");
    return false;
  }
}

function lembrarGrupo(codigo, nome, foto = "") {
  const existente = estado.atalhos.find((a) => a.codigo === codigo);
  const saneado = saneadoAtalho({ codigo, nome, foto });
  if (existente) Object.assign(existente, saneado);
  else estado.atalhos.push(saneado);
  salvarPreferencias();
}

/**
 * Sobe para a conta o que a conta promete guardar. Sem conta não faz nada —
 * e é por isso que quem chama não precisa perguntar antes.
 *
 * Dentro de um grupo aproveita o socket que já está aberto; fora dele, abre
 * uma transação curta. Falhar em silêncio é deliberado: a próxima entrada em
 * grupo grava tudo de novo na saudação, e um aviso de rede para quem só
 * trocou de mascote seria ruído.
 */
function sincronizarConta(campos) {
  if (!estado.token) return;
  const enviar = sinal.conectado ? (pedido) => sinal.enviar(pedido) : null;
  conta.guardar(estado.servidor, estado.token, campos, enviar);
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

/* ═══ Diálogo genérico ══════════════════════════════════════════ */

/**
 * Um só diálogo para criar grupo, entrar por convite, renomear e confirmar
 * remoções. Meia dúzia de diálogos fixos no HTML seriam meia dúzia de lugares
 * para o foco, o Escape e o clique fora se comportarem de maneira diferente.
 *
 * Resolve com os valores dos campos, ou com `null` se a pessoa desistir.
 */
function perguntar({ titulo, texto = "", campos = [], confirmar = "Confirmar", perigo = false }) {
  return new Promise((resolver) => {
    const cortina = $("cortina");
    const formulario = $("dialogo-formulario");
    const area = $("dialogo-campos");

    $("dialogo-titulo").textContent = titulo;
    $("dialogo-texto").textContent = texto;
    $("dialogo-texto").hidden = !texto;
    area.textContent = "";

    const entradas = campos.map((campo) => {
      const rotulo = document.createElement("label");
      rotulo.className = "campo";

      const nome = document.createElement("span");
      nome.className = "campo__rotulo";
      nome.textContent = campo.rotulo;

      let entrada;
      if (campo.opcoes) {
        entrada = document.createElement("div");
        entrada.className = "escolhas";
        campo.opcoes.forEach((opcao, indice) => {
          const botao = document.createElement("button");
          botao.type = "button";
          botao.className = "escolha";
          botao.textContent = opcao.rotulo;
          botao.dataset.valor = opcao.valor;
          botao.dataset.ativa = indice === 0 ? "sim" : "nao";
          botao.addEventListener("click", () => {
            for (const irma of entrada.children) irma.dataset.ativa = "nao";
            botao.dataset.ativa = "sim";
          });
          entrada.append(botao);
        });
        entrada.valor = () =>
          [...entrada.children].find((b) => b.dataset.ativa === "sim")?.dataset.valor;
      } else if (campo.deslizante) {
        // Um deslizante que só valesse ao confirmar seria inútil para volume:
        // é preciso ouvir o efeito enquanto se arrasta. Ele aplica ao vivo, e
        // o cancelar do diálogo é que desfaz.
        entrada = document.createElement("input");
        entrada.type = "range";
        entrada.className = "deslizante";
        Object.assign(entrada, campo.deslizante);
        entrada.value = String(campo.valor);
        const mostrar = () => {
          nome.textContent = `${campo.rotulo} — ${campo.formatar(Number(entrada.value))}`;
        };
        entrada.addEventListener("input", () => {
          mostrar();
          campo.aoMudar?.(Number(entrada.value));
        });
        mostrar();
        entrada.valor = () => Number(entrada.value);
      } else {
        entrada = document.createElement("input");
        entrada.className = "campo__entrada";
        entrada.maxLength = campo.maximo ?? 40;
        entrada.placeholder = campo.dica ?? "";
        entrada.value = campo.valor ?? "";
        if (campo.maiusculas) entrada.style.textTransform = "uppercase";
        entrada.valor = () => entrada.value.trim();
      }

      rotulo.append(nome, entrada);
      area.append(rotulo);
      return entrada;
    });

    const confirmarBotao = $("dialogo-confirmar");
    confirmarBotao.textContent = confirmar;
    confirmarBotao.classList.toggle("botao--perigo", perigo);

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      formulario.onsubmit = null;
      $("dialogo-cancelar").onclick = null;
      cortina.onclick = null;
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const aoTeclar = (evento) => {
      if (evento.key === "Escape") fechar(null);
    };

    formulario.onsubmit = (evento) => {
      evento.preventDefault();
      const valores = entradas.map((e) => e.valor());
      if (campos.some((c, i) => c.obrigatorio !== false && !valores[i])) return;
      fechar(valores);
    };
    $("dialogo-cancelar").onclick = () => fechar(null);
    cortina.onclick = (evento) => {
      if (evento.target === cortina) fechar(null);
    };
    document.addEventListener("keydown", aoTeclar);

    cortina.classList.remove("oculto");
    entradas[0]?.focus?.();
  });
}

/* ═══ Menu suspenso ═════════════════════════════════════════════ */

function abrirMenu(ancora, itens) {
  const menu = $("menu");
  menu.textContent = "";

  for (const item of itens) {
    if (item === "-") {
      const risco = document.createElement("hr");
      risco.className = "menu__risco";
      menu.append(risco);
      continue;
    }
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "menu__item";
    botao.textContent = item.rotulo;
    if (item.perigo) botao.dataset.perigo = "sim";
    botao.addEventListener("click", () => {
      fecharMenu();
      item.acao();
    });
    menu.append(botao);
  }

  menu.classList.remove("oculto");

  // Posiciona só depois de visível: um elemento oculto não tem medidas, e sem
  // elas o menu escaparia da janela nas bordas de baixo e da direita.
  const caixa = ancora.getBoundingClientRect();
  const minha = menu.getBoundingClientRect();
  const x = Math.min(caixa.left, window.innerWidth - minha.width - 8);
  const y =
    caixa.bottom + minha.height + 8 > window.innerHeight
      ? caixa.top - minha.height - 4
      : caixa.bottom + 4;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  setTimeout(() => {
    document.addEventListener("click", fecharMenu, { once: true });
  }, 0);
}

function fecharMenu() {
  $("menu").classList.add("oculto");
}

/* ═══ Seletor de emoji ══════════════════════════════════════════ */

/** Mesmo padrão do menu suspenso — um só elemento reaproveitado, ancorado
 *  perto de quem o abriu — só que com os cinco emoji em vez de texto, tanto
 *  para escrever quanto para reagir. `aoEscolher` recebe o id do emoji. */
function abrirSeletorDeEmoji(ancora, aoEscolher) {
  const seletor = $("seletor-emoji");
  seletor.textContent = "";
  seletor.onclick = (evento) => evento.stopPropagation();

  const abas = document.createElement("div");
  abas.className = "seletor-emoji__abas";
  const titulo = document.createElement("div");
  titulo.className = "seletor-emoji__titulo";
  const grade = document.createElement("div");
  grade.className = "seletor-emoji__grade";
  const mostrar = (categoria, ativa) => {
    titulo.textContent = categoria.nome;
    grade.textContent = "";
    for (const aba of abas.children) aba.dataset.ativa = aba === ativa ? "sim" : "nao";
    for (const emoji of categoria.emojis) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "seletor-emoji__item";
      botao.title = emoji.nome;
      botao.setAttribute("aria-label", emoji.nome);
      botao.append(elementoDeEmoji(emoji.id));
      botao.addEventListener("click", () => {
        fecharSeletorDeEmoji();
        aoEscolher(emoji.id);
      });
      grade.append(botao);
    }
    grade.scrollTop = 0;
  };
  CATEGORIAS_EMOJI.forEach((categoria, indice) => {
    const aba = document.createElement("button");
    aba.type = "button";
    aba.className = "seletor-emoji__aba";
    aba.textContent = categoria.icone;
    aba.title = categoria.nome;
    aba.addEventListener("click", () => mostrar(categoria, aba));
    abas.append(aba);
  });
  seletor.append(abas, titulo, grade);
  const indiceInicial = Math.max(0, CATEGORIAS_EMOJI.findIndex((categoria) => categoria.id === "rostos"));
  mostrar(CATEGORIAS_EMOJI[indiceInicial], abas.children[indiceInicial]);

  seletor.classList.remove("oculto");

  // Acima da âncora por padrão — é onde a mão já está, no campo de escrever
  // ou no botão de reagir de uma mensagem — e só desce se não couber ali.
  const caixa = ancora.getBoundingClientRect();
  const minha = seletor.getBoundingClientRect();
  const x = Math.min(caixa.left, window.innerWidth - minha.width - 8);
  const y = caixa.top - minha.height - 8 < 0 ? caixa.bottom + 6 : caixa.top - minha.height - 6;
  seletor.style.left = `${Math.max(8, x)}px`;
  seletor.style.top = `${Math.max(8, y)}px`;

  setTimeout(() => {
    document.addEventListener("click", fecharSeletorDeEmoji, { once: true });
  }, 0);
}

function fecharSeletorDeEmoji() {
  $("seletor-emoji").classList.add("oculto");
}

/** Deixa `abrirMenu` ancorar num clique em vez de num elemento: um ponto sem
 *  área, exatamente onde o botão direito caiu. */
function pontoDoClique(evento) {
  return {
    getBoundingClientRect: () => ({
      left: evento.clientX,
      right: evento.clientX,
      top: evento.clientY,
      bottom: evento.clientY,
      width: 0,
      height: 0,
    }),
  };
}

/* ═══ Brilho do cursor ══════════════════════════════════════════ */

/**
 * O brilho não salta para debaixo do cursor — ele escorrega até lá. É esse
 * atraso curto, recalculado a cada quadro, que faz a mancha parecer líquida
 * em vez de amarrada ao ponteiro; sem ele seria só um círculo grudado no
 * mouse, e isso qualquer `background-position` faz.
 */
function prepararBrilhoDoCursor() {
  const brilho = $("brilho-cursor");
  if (!brilho || window.matchMedia("(pointer: coarse)").matches) return;

  let alvoX = window.innerWidth / 2;
  let alvoY = window.innerHeight / 2;
  let atualX = alvoX;
  let atualY = alvoY;
  let emQuadro = false;

  function passo() {
    atualX += (alvoX - atualX) * 0.16;
    atualY += (alvoY - atualY) * 0.16;
    brilho.style.setProperty("--brilho-x", `${atualX}px`);
    brilho.style.setProperty("--brilho-y", `${atualY}px`);

    if (Math.abs(alvoX - atualX) > 0.4 || Math.abs(alvoY - atualY) > 0.4) {
      requestAnimationFrame(passo);
    } else {
      emQuadro = false;
    }
  }

  window.addEventListener("pointermove", (evento) => {
    // `clientX/Y` vêm em pixels físicos da janela. Como a raiz pode estar com
    // zoom, a camada do brilho precisa receber a coordenada no espaço do layout
    // para continuar exatamente sob o ponteiro em qualquer escala.
    alvoX = evento.clientX / estado.escalaInterface;
    alvoY = evento.clientY / estado.escalaInterface;
    if (estado.brilhoCursor) brilho.classList.add("brilho-cursor--ativo");
    if (!emQuadro) {
      emQuadro = true;
      requestAnimationFrame(passo);
    }
  });

  // A mancha continuaria acesa no último ponto se ninguém dissesse que o
  // cursor foi embora — e "embora" aqui é sair da janela inteira, não de um
  // elemento dentro dela.
  document.addEventListener("mouseleave", () => brilho.classList.remove("brilho-cursor--ativo"));
}

function aplicarPreferenciasDoBrilho() {
  const brilho = $("brilho-cursor");
  if (!brilho) return;
  brilho.style.setProperty("--brilho-tamanho", `${estado.tamanhoBrilhoCursor}px`);
  brilho.style.setProperty("--brilho-intensidade", String(estado.intensidadeBrilhoCursor / 100));
  if (!estado.brilhoCursor) brilho.classList.remove("brilho-cursor--ativo");
}

/* ═══ Cosméticos ════════════════════════════════════════════════ */

function aplicarCursorPersonalizado() {
  document.body.classList.toggle("sem-cursor-personalizado", !estado.cursorPersonalizado);
}

/* ═══ Portal: entrar, criar conta, ou nenhum dos dois ═══════════ */

/**
 * A tela de entrada é boas-vindas, e boas-vindas se dá uma vez: quem já tem
 * sessão ou apelido guardado nunca mais a vê. Ela existe para decidir *quem
 * você é* — com conta, que atravessa computadores, ou sem, que é o CALL como
 * ele sempre foi e continua funcionando sem internet nenhuma.
 *
 * Apelido e mascote também vivem em "Meu perfil", e o endereço do servidor
 * nos ajustes: nada aqui é a única porta para nada.
 */

let modoDoPortal = "entrar";
let googleDoServidor = { disponivel: false, clienteId: "" };
let portalOcupado = false;

function prepararPortal() {
  $("campo-servidor").value = estado.servidor;
  $("botao-hospedar").addEventListener("click", hospedar);

  // Quem já usou uma conta aqui abre na aba de entrar, com o e-mail pronto.
  // Quem nunca usou não tem o que entrar, e a aba útil é a de criar.
  $("criar-apelido").value = estado.apelido;
  $("entrar-email").value = estado.ultimoEmail;
  $("criar-email").value = "";

  for (const aba of $("portal-abas").querySelectorAll(".segmentado__aba")) {
    aba.addEventListener("click", () => trocarModoDoPortal(aba.dataset.aba));
  }

  for (const olho of document.querySelectorAll(".olho")) {
    olho.setAttribute("aria-pressed", "false");
    olho.addEventListener("click", () => {
      const campo = $(olho.dataset.olho);
      const mostrando = campo.type === "text";
      campo.type = mostrando ? "password" : "text";
      olho.setAttribute("aria-pressed", String(!mostrando));
      olho.title = mostrando ? "Mostrar a senha" : "Esconder a senha";
      campo.focus();
    });
  }

  // Caps Lock é a causa mais comum de "minha senha está certa e não entra", e
  // a única que o próprio campo pode denunciar antes do erro acontecer.
  for (const [campo, aviso] of [
    ["entrar-senha", "entrar-caps"],
    ["criar-senha", "criar-caps"],
  ]) {
    const olhar = (evento) => {
      $(aviso).hidden = !evento.getModifierState?.("CapsLock");
    };
    $(campo).addEventListener("keyup", olhar);
    $(campo).addEventListener("keydown", olhar);
    $(campo).addEventListener("blur", () => ($(aviso).hidden = true));
  }

  for (const id of ["entrar-email", "criar-email"]) {
    $(id).addEventListener("input", () => {
      $(id).closest(".campo__caixa").dataset.valido = conta.pareceEmail($(id).value)
        ? "sim"
        : "nao";
      limparErro();
    });
  }

  $("criar-apelido").addEventListener("input", refletirPortal);
  $("criar-senha").addEventListener("input", () => {
    const { nivel, texto } = conta.forcaDaSenha($("criar-senha").value);
    $("forca").dataset.nivel = String(nivel);
    $("forca-texto").textContent = texto;
    limparErro();
  });
  $("entrar-senha").addEventListener("input", limparErro);

  $("form-entrar").addEventListener("submit", (evento) => {
    evento.preventDefault();
    entrarNaConta();
  });
  $("form-criar").addEventListener("submit", (evento) => {
    evento.preventDefault();
    criarConta();
  });
  $("botao-google").addEventListener("click", entrarPeloGoogle);
  $("botao-sem-conta").addEventListener("click", () => {
    // Sem conta o apelido é o que a pessoa digitou na aba de cadastro, ou o
    // que já estava guardado. Ninguém deve ser mandado de volta a um campo
    // para escolher um nome que já existe.
    const escolhido = $("criar-apelido").value.trim() || estado.apelido;
    estado.apelido = escolhido || "Convidado";
    salvarPreferencias();
    abrirAplicacao();
  });

  window.addEventListener("resize", medirPalcoDoPortal);
  // A altura da folha muda quando a fonte do sistema termina de carregar, e
  // a medida feita antes disso deixaria o cartão cortado por alguns pixels.
  document.fonts?.ready.then(medirPalcoDoPortal);

  $("entrar-email").closest(".campo__caixa").dataset.valido = conta.pareceEmail(
    estado.ultimoEmail
  )
    ? "sim"
    : "nao";

  trocarModoDoPortal(estado.ultimoEmail ? "entrar" : "criar", true);
}

function trocarModoDoPortal(modo, imediato = false) {
  modoDoPortal = modo;
  $("tela-entrada").dataset.modo = modo;
  limparErro();

  for (const aba of $("portal-abas").querySelectorAll(".segmentado__aba")) {
    aba.setAttribute("aria-selected", String(aba.dataset.aba === modo));
  }
  $("portal-abas").style.setProperty("--indice", modo === "criar" ? "1" : "0");

  for (const folha of $("portal-palco").querySelectorAll(".portal__folha")) {
    folha.classList.toggle("portal__folha--fora", folha.dataset.folha !== modo);
  }

  refletirPortal();
  medirPalcoDoPortal();

  // Foco no primeiro campo vazio da folha que entrou — e não no primeiro
  // campo: quem chega com o e-mail preenchido quer o cursor na senha.
  if (!imediato) {
    const campos = folhaDoPortal().querySelectorAll(".campo__entrada");
    const alvo = [...campos].find((c) => !c.value) ?? campos[0];
    alvo?.focus();
  }
}

const folhaDoPortal = () => $(modoDoPortal === "criar" ? "form-criar" : "form-entrar");

/** A altura do palco acompanha a folha à frente; as duas têm tamanhos bem
 *  diferentes, e um salto seco seria a única parte brusca da tela. */
function medirPalcoDoPortal() {
  $("portal-palco").style.height = `${folhaDoPortal().offsetHeight}px`;
}

/** A prévia: o mesmo desenho que os outros vão ver, e não uma promessa. */
function refletirPortal() {
  const criando = modoDoPortal === "criar";
  const apelido = criando ? $("criar-apelido").value.trim() : estado.apelido;

  pintarAvatar($("portal-avatar"), { avatar: estado.avatar, apelido });

  if (criando) {
    $("portal-titulo").textContent = apelido || "Quem é você aqui?";
    $("portal-legenda").textContent = "Seu nome no CALL";
  } else {
    $("portal-titulo").textContent = apelido ? `Olá de novo, ${apelido}` : "Bem-vindo de volta";
    $("portal-legenda").textContent =
      estado.ultimoEmail || "Entre na sua conta";
  }
}

function limparErro() {
  for (const id of ["erro-entrar", "erro-criar"]) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      $(id).textContent = "";
    }
  }
  medirPalcoDoPortal();
}

/**
 * Mostra a recusa dentro do cartão, e não como aviso passageiro no canto:
 * "senha incorreta" é resposta ao que a pessoa acabou de fazer, e some junto
 * com a próxima tecla que ela digitar.
 */
function mostrarErroDoPortal(erro) {
  const caixa = $(modoDoPortal === "criar" ? "erro-criar" : "erro-entrar");
  caixa.textContent = erro?.message ?? String(erro);
  caixa.hidden = false;
  medirPalcoDoPortal();

  const campo = {
    email: modoDoPortal === "criar" ? "criar-email" : "entrar-email",
    senha: modoDoPortal === "criar" ? "criar-senha" : "entrar-senha",
    apelido: "criar-apelido",
  }[erro?.campo];
  if (campo) $(campo)?.focus();
}

/** O botão vira relógio enquanto o servidor pensa. O rótulo não muda: um
 *  texto que troca de largura faria o cartão inteiro pular. */
function esperando(botao, ligado) {
  portalOcupado = ligado;
  botao.classList.toggle("botao--esperando", ligado);
  botao.disabled = ligado;
  $("botao-google").disabled = ligado || !googleDoServidor.disponivel;
}

async function entrarNaConta() {
  if (portalOcupado) return;
  const botao = $("botao-entrar-conta");
  limparErro();
  esperando(botao, true);

  try {
    const sessao = await conta.entrar(
      estado.servidor,
      $("entrar-email").value,
      $("entrar-senha").value
    );
    assumirConta(sessao);
  } catch (erro) {
    mostrarErroDoPortal(erro);
  } finally {
    esperando(botao, false);
  }
}

async function criarConta() {
  if (portalOcupado) return;
  const botao = $("botao-criar-conta");
  limparErro();
  esperando(botao, true);

  try {
    const sessao = await conta.cadastrar(estado.servidor, {
      email: $("criar-email").value,
      senha: $("criar-senha").value,
      apelido: $("criar-apelido").value,
      avatar: estado.avatar,
      bio: estado.bio,
    });
    // A conta já existe, mas a aplicação ainda não abre: mascote, foto e bio
    // ficam para o onboarding, que decide sozinho quando chamar
    // `abrirAplicacao`. Cadastro por convite ou Google não passam por aqui —
    // só quem preencheu o formulário do zero é recém-chegado de verdade.
    assumirConta(sessao, { abrir: false });
    const escolhas = await iniciarOnboarding(estado);
    Object.assign(estado, escolhas);
    salvarPreferencias();
    sincronizarConta({ avatar: escolhas.avatar, bio: escolhas.bio });
    abrirAplicacao();
  } catch (erro) {
    mostrarErroDoPortal(erro);
  } finally {
    esperando(botao, false);
  }
}

/** O botão do Google só existe quando o servidor tem como completá-lo: um
 *  botão que sempre falha é pior que botão nenhum. */
async function perguntarPeloGoogle() {
  googleDoServidor = await conta.configuracaoDoGoogle(estado.servidor);
  $("portal-google").classList.toggle("oculto", !googleDoServidor.disponivel);
  $("botao-google").disabled = !googleDoServidor.disponivel;
}

async function entrarPeloGoogle() {
  if (portalOcupado || !googleDoServidor.disponivel) return;
  const botao = $("botao-google");
  limparErro();
  portalOcupado = true;
  botao.disabled = true;
  $("botao-google-texto").textContent = "Esperando o navegador…";

  try {
    // O Rust abre o navegador do sistema e espera a volta numa porta local.
    // Nada de senha do Google dentro do CALL — ver `src-tauri/src/google.rs`.
    const passagem = await invocar("google_autenticar", {
      clienteId: googleDoServidor.clienteId,
    });
    const sessao = await conta.entrarComGoogle(estado.servidor, passagem);
    assumirConta(sessao);
  } catch (erro) {
    mostrarErroDoPortal(erro instanceof Error ? erro : new Error(String(erro)));
  } finally {
    portalOcupado = false;
    botao.disabled = false;
    $("botao-google-texto").textContent = "Continuar com o Google";
  }
}

/**
 * A conta assume o lugar da identidade sorteada: `usuario` passa a ser o
 * identificador dela, que é o mesmo em qualquer computador. É isso que faz o
 * histórico continuar reconhecendo quem escreveu, e o grupo continuar tendo
 * dono depois de uma reinstalação.
 */
function assumirConta(sessao, { abrir = true } = {}) {
  estado.token = sessao.token;
  estado.conta = sessao.conta;
  estado.usuario = sessao.conta.id;
  estado.ultimoEmail = sessao.conta.email;
  estado.apelido = sessao.conta.apelido || estado.apelido;
  if (sessao.conta.avatar) estado.avatar = sessao.conta.avatar;
  if (sessao.conta.bio) estado.bio = sessao.conta.bio;

  fundirAtalhos(sessao.conta.atalhos);
  conta.guardarSessao(sessao.token, estado.servidor);
  salvarPreferencias();

  // Amigos e PV não esperam grupo nenhum: a conta por si só já é o bastante
  // pra ligar o socket social, esteja a pessoa entrando num grupo agora,
  // ainda no onboarding, ou só reabrindo o CALL com a sessão de antes.
  conectarSocial();

  if (abrir) abrirAplicacao();
}

/**
 * Junta os grupos da conta com os que já estavam neste computador.
 *
 * Fundir, e não substituir: quem usou o CALL sem conta e depois criou uma
 * perderia a coluna inteira, e quem entrou num grupo com o computador
 * offline perderia esse grupo na primeira sincronização. O nome que vale é o
 * da conta, porque ele passou pelo servidor mais recentemente.
 */
function fundirAtalhos(daConta) {
  if (!Array.isArray(daConta)) return;

  const juntos = new Map(estado.atalhos.map((a) => [a.codigo, a]));
  for (const atalho of daConta) {
    if (atalho?.codigo) juntos.set(atalho.codigo, saneadoAtalho(atalho));
  }
  estado.atalhos = [...juntos.values()];
}

const inicioCarregamento = performance.now();
// Um pulso rápido demais parece um piscar de tela, não uma animação: quem
// entra direto pelo apelido do ambiente decidiria em poucos milissegundos, e
// o glifo sumiria antes de bater os olhos nele.
const TEMPO_MINIMO_CARREGANDO = 550;

function esconderTelaDeCarregando() {
  const tela = $("tela-carregando");
  if (!tela) return;
  const decorrido = performance.now() - inicioCarregamento;
  const espera = Math.max(0, TEMPO_MINIMO_CARREGANDO - decorrido);
  setTimeout(() => {
    tela.classList.add("carregando--saindo");
    setTimeout(() => tela.remove(), 400);
  }, espera);
}

function abrirAplicacao() {
  const portal = $("portal");
  const telaEntrada = $("tela-entrada");

  // Na partida, a tela de carregando ainda cobre o portal do primeiro pixel:
  // o recuo animado do cartão seria enfeite que ninguém vê — e, pior,
  // arriscado. Quando a confirmação da sessão demora (retomar uma conta
  // custa uma ida e volta ao servidor), os 220 ms do recuo coincidem com o
  // fade da tela de carregando, e o login chega a piscar no meio da troca.
  // Em partida o portal some já, sem animação, e a despedida do carregando
  // revela direto a aplicação. O recuo animado fica para quem entra pelo
  // portal — lá o cartão é visto de verdade.
  const naPartida = $("tela-carregando") !== null;
  if (naPartida) {
    telaEntrada.classList.add("oculto");
    portal.classList.remove("portal--indo");
  } else {
    portal.classList.add("portal--indo");
    setTimeout(() => {
      telaEntrada.classList.add("oculto");
      portal.classList.remove("portal--indo");
    }, 220);
  }

  // A aplicação é montada já, e a tela de entrada só sai depois: montar
  // depois faria a espera aparecer como uma tela preta.
  $("tela-aplicacao").classList.remove("oculto");
  mostrarMarcaDeAtualizacao();
  // Quem saiu da conta e entrou de novo já tem tudo ligado; repetir aqui
  // duplicaria cada ouvinte, e cada clique passaria a valer por dois.
  if (aplicacaoPronta) {
    mostrarMeuPerfil();
    desenharAtalhos();
    redesenhar();
  } else {
    prepararAplicacao();
  }
}

async function hospedar() {
  const botao = $("botao-hospedar");
  botao.disabled = true;
  try {
    const endereco = await invocar("hospedar", { porta: 8787 });
    estado.hospedando = true;
    $("campo-servidor").value = endereco;
    $("dica-servidor").textContent =
      "Servidor local ativo na porta 8787.";
    // Só o rótulo muda — o botão carrega um ícone antes do texto, e
    // `textContent` no elemento inteiro o apagaria junto.
    botao.querySelector("span").textContent = "Hospedando";
    avisar("Servidor iniciado nesta máquina.", "bom");
  } catch (erro) {
    botao.disabled = false;
    avisar(String(erro), "erro");
  }
}

/* ═══ Aplicação ═════════════════════════════════════════════════ */

function prepararAplicacao() {
  mostrarMeuPerfil();

  $("botao-perfil").addEventListener("click", abrirMeuPerfil);
  $("botao-amigos").addEventListener("click", abrirVistaAmigos);
  $("botao-adicionar-amigo").addEventListener("click", adicionarAmigoPorCodigo);
  $("perfil-codigo-amigo-copiar").addEventListener("click", async () => {
    if (estado.conta && (await copiar(estado.conta.id))) avisar("Código copiado.", "bom");
  });

  // Clicar num grupo abre; clicar fora de todos, no vazio da coluna, é onde
  // "criar" e "entrar com convite" moram agora — a coluna nunca tem um botão
  // parado nela.
  $("coluna-grupos").addEventListener("contextmenu", (evento) => {
    if (evento.target.closest(".grupo")) return;
    evento.preventDefault();
    abrirMenu(pontoDoClique(evento), itensDeNovoGrupo());
  });

  // O mesmo menu do ícone do grupo, agora em qualquer ponto da coluna dele —
  // o ícone é um alvo de 48px, e a coluna inteira é o espaço que a pessoa
  // reconhece como "este grupo". Registrado aqui, e não em `desenharArvore`:
  // a árvore é refeita a cada redesenho, e o ouvinte se empilharia.
  $("coluna-canais").addEventListener("contextmenu", (evento) => {
    // A vista de amigos mora dentro desta mesma coluna e só troca de
    // visibilidade — `estado.grupo` continua de pé atrás dela.
    if (!estado.grupo || estado.vistaAmigos) return;
    evento.preventDefault();
    const atalho = estado.atalhos.find((a) => a.codigo === estado.grupo.codigo) ?? estado.grupo;
    menuDoAtalho(pontoDoClique(evento), atalho);
  });

  $("botao-presentes").addEventListener("click", () => {
    presentesForcado = !presentesDeveAbrir();
    atualizarPresentes();
  });

  $("botao-microfone").addEventListener("click", alternarMicrofone);
  $("botao-transmitir").addEventListener("click", () => {
    if (estado.transmitindo) pararTransmissao();
    else iniciarCapturaOtimizada(acharPerfilDeTela(estado.perfilTela));
  });
  $("botao-sair-voz").addEventListener("click", () => sairDaVoz(true));

  $("botao-soundboard").addEventListener("click", alternarSoundboard);
  $("soundboard-adicionar").addEventListener("click", () => $("soundboard-arquivo").click());
  $("soundboard-arquivo").addEventListener("change", (e) => {
    adicionarSomAoGrupo(e.target.files[0]);
    e.target.value = "";
  });

  $("ajuste-som-entrada").addEventListener("change", (e) => {
    ouvirPreviaDoSomDeEntrada(e.target.value);
    aoEscolherSomDeEntrada(e.target.value);
  });
  $("sons-pessoais-adicionar").addEventListener("click", () => $("sons-pessoais-arquivo").click());
  $("sons-pessoais-arquivo").addEventListener("change", (e) => {
    adicionarSomPessoalArquivo(e.target.files[0]);
    e.target.value = "";
  });

  prepararAjustes();

  // O menu nativo da webview ("Atualizar", "Imprimir", "Salvar como") não tem
  // nada a ver com o app. Só os nossos menus respondem ao botão direito; em
  // campos de texto o nativo continua, senão o usuário perde colar.
  document.addEventListener("contextmenu", (evento) => {
    if (evento.target.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
    evento.preventDefault();
  });

  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape") return;
    // O perfil e o cartão fecham a si mesmos. Sem esta saída, o Escape deles
    // seguiria adiante e desmaximizaria uma transmissão atrás da cortina.
    if (
      !$("perfil-dialogo").classList.contains("oculto") ||
      !$("cartao-dialogo").classList.contains("oculto")
    ) {
      return;
    }
    // O cartão de novidades fecha sozinho pelo próprio Escape — registrado na
    // abertura, para valer também sobre o portal. Aqui ele nem aparece.
    if (!$("ajustes").classList.contains("oculto")) {
      fecharAjustes();
    } else if (telaMaximizada) {
      alternarMaximizarTela(telaMaximizada);
    }
  });

  prepararRedator();

  sinal.addEventListener("entrou", (e) => aoEntrar(e.detail.membro));
  sinal.addEventListener("saiu", (e) => aoSair(e.detail.id));
  sinal.addEventListener("grupo", (e) => aoEstrutura(e.detail.grupo));
  sinal.addEventListener("voz", (e) => {
    aoEntrarNaVoz(e.detail).catch((erro) => {
      console.error("[midia] entrada falhou", erro);
      avisar("Não foi possível conectar a mídia da call.", "erro");
    });
  });
  sinal.addEventListener("entrou-voz", (e) => aoParPorVoz(e.detail));
  sinal.addEventListener("saiu-voz", (e) => aoParDeixarVoz(e.detail));
  sinal.addEventListener("sinal", (e) => {
    if (provedorDeMidia === "malha") malha.receberSinal(e.detail.de, e.detail.dados);
  });
  sinal.addEventListener("estado", (e) => aoEstadoDeMidia(e.detail));
  sinal.addEventListener("perfil", (e) => aoPerfilDeOutro(e.detail));
  sinal.addEventListener("mensagem", (e) => aoMensagem(e.detail.mensagem));
  sinal.addEventListener("mensagem-atualizada", (e) => aoMensagemAtualizada(e.detail.mensagem, e.detail.canal));
  sinal.addEventListener("reacao", (e) => aoReacao(e.detail));
  sinal.addEventListener("historico", (e) => aoHistorico(e.detail));
  sinal.addEventListener("som", (e) => aoReceberBytesDeSom(e.detail));
  sinal.addEventListener("som-adicionado", (e) => {
    estado.sons.push(e.detail.som);
    desenharSoundboard();
    preencherSeletorSomEntrada();
  });
  sinal.addEventListener("som-removido", (e) => {
    estado.sons = estado.sons.filter((s) => s.id !== e.detail.id);
    desenharSoundboard();
    preencherSeletorSomEntrada();
  });
  sinal.addEventListener("som-tocado", (e) => {
    const quem = estado.membros.get(e.detail.de);
    const som = estado.sons.find((s) => s.id === e.detail.id);
    if (quem && som) avisar(`🔊 ${quem.apelido} tocou "${som.nome}"`);
  });
  // Amigos e PV são tratados pelo socket social (`social`, mais abaixo), não
  // por este — este é só o de grupo, que nasce e morre a cada troca.
  sinal.addEventListener("erro", (e) => avisar(e.detail.motivo, "erro"));
  sinal.addEventListener("queda", () => {
    if (!estado.grupo) return;
    avisar("A conexão com o servidor caiu.", "erro");
    desligar();
  });

  desenharAtalhos();
  redesenhar();

  aplicacaoPronta = true;
  aproveitarConvite();
}

/* ═══ Convite por link ══════════════════════════════════════════ */

/** Código trazido por `call://` que ainda não pôde ser usado. */
let convitePendente = null;
let aplicacaoPronta = false;

/**
 * O Rust guarda o convite e avisa que ele existe; o código vem por este
 * comando, que também o esquece. Um caminho só: se o aviso e a leitura da
 * partida se cruzarem, o segundo encontra a vaga vazia em vez de entrar no
 * grupo duas vezes.
 */
async function receberConvite() {
  try {
    const codigo = await invocar("convite_pendente");
    if (codigo) convitePendente = codigo;
  } catch {
    return; // fora do aplicativo — não há protocolo a atender
  }
  aproveitarConvite();
}

/**
 * O link pode chegar com o aplicativo ainda na tela de entrada, sem apelido
 * escolhido e sem servidor confirmado. Nesse caso o convite espera: entrar em
 * um grupo antes disso apareceria para os outros como alguém sem nome.
 */
function aproveitarConvite() {
  if (!convitePendente || !aplicacaoPronta) return;

  const codigo = convitePendente;
  convitePendente = null;

  if (codigo === estado.grupo?.codigo) {
    avisar("Você já está neste grupo.");
    return;
  }
  avisar("Entrando pelo convite…");
  conectar({ tipo: "entrar", codigo });
}

const souDono = () => estado.grupo?.dono === estado.usuario;

/* ═══ Perfil ════════════════════════════════════════════════════ */

/** O rodapé da coluna de grupos: é o retrato de quem está usando o CALL aqui. */
function mostrarMeuPerfil() {
  $("rotulo-usuario").textContent = estado.apelido;
  // O trilho estreito não tem onde escrever o nome — o `title` é a única
  // forma de dizer quem é sem abrir o perfil.
  $("botao-perfil").title = `${estado.apelido || "Meu perfil"} — meu perfil`;
  pintarAvatar($("avatar-usuario"), estado);
}

async function abrirMeuPerfil() {
  mostrarContaNoPerfil();
  const escolhido = await editarPerfil(estado);
  if (!escolhido) return;

  Object.assign(estado, escolhido);
  salvarPreferencias();
  // `foto` fica de fora: o servidor só entende o mascote de `avatar`, e
  // mandar um data URL de 24 caracteres de sobra seria só ser recusado.
  const { apelido, avatar, bio } = escolhido;
  sincronizarConta({ apelido, avatar, bio });
  mostrarMeuPerfil();

  // Dentro de um grupo a saudação já passou, e sem este aviso o perfil novo só
  // valeria na próxima entrada — os outros continuariam vendo o antigo.
  const eu = estado.membros.get(estado.meuId);
  if (eu) {
    // `eu` é a própria pessoa, do jeito que só ela se vê: a foto entra aqui,
    // e não no que se manda pela rede duas linhas abaixo.
    Object.assign(eu, escolhido);
    sinal.enviar({ tipo: "perfil", apelido, avatar, bio });
    redesenhar();
  }
  // `redesenhar` não alcança a linha do tempo, e as mensagens da própria
  // pessoa pintam a foto de agora: sem isto a conversa ficaria com a antiga
  // até trocar de canal. Fora de grupo também vale, por causa das PVs.
  desenharConversa();

  avisar("Perfil salvo.", "bom");
}

/**
 * A linha da conta dentro do painel de perfil.
 *
 * Ela mora aqui, e não numa tela própria, porque é o que sustenta tudo que
 * está acima dela: sem conta, o apelido, o mascote e a bio valem só nesta
 * máquina — e a linha diz isso em vez de deixar a pessoa descobrir sozinha
 * depois de formatar o computador.
 */
function mostrarContaNoPerfil() {
  const linha = $("perfil-conta");
  const acao = $("perfil-conta-acao");
  const ligada = Boolean(estado.conta);

  linha.dataset.ligada = ligada ? "sim" : "nao";
  $("perfil-conta-titulo").textContent = ligada
    ? estado.conta.google
      ? "Conta do Google"
      : "Conta do CALL"
    : "Você está sem conta";
  $("perfil-conta-detalhe").textContent = ligada
    ? estado.conta.email
    : "Somente neste computador";
  acao.textContent = ligada ? "Sair da conta" : "Criar conta";

  acao.onclick = () => (ligada ? sairDaConta() : voltarAoPortal());

  $("perfil-codigo-amigo").classList.toggle("oculto", !ligada);
  if (ligada) $("perfil-codigo-amigo-valor").textContent = estado.conta.id;
}

/**
 * Larga tudo que veio da conta: token, cadastro em memória e — o que importa
 * — a identidade.
 *
 * O `usuario` de quem entrou com conta é o identificador dela, e ele é o que
 * assina as mensagens e diz quem é o dono de um grupo. Continuar apresentando
 * esse identificador sem o token que o comprova seria dizer-se dono de uma
 * conta a que já não se pertence. O servidor recusa essa alegação de qualquer
 * jeito — `identidade`, em `main.rs` —, e o cliente não deve nem tentá-la.
 */
function largarIdentidadeDaConta() {
  desligarSocial();
  estado.token = "";
  estado.conta = null;
  conta.esquecerSessao();
  if (estado.usuario.startsWith("conta-")) {
    estado.usuario = crypto.randomUUID().replace(/-/g, "");
  }
  salvarPreferencias();
}

/**
 * Sair da conta derruba a sessão no servidor, e não só neste computador: um
 * token que continua valendo depois de "sair" não é uma saída.
 *
 * Depois disso o CALL volta ao portal. Não continuamos na aplicação com a
 * identidade da conta na mão — ela deixou de ser nossa.
 */
async function sairDaConta() {
  const token = estado.token;
  largarIdentidadeDaConta();

  $("perfil-dialogo").classList.add("oculto");
  desligar();
  voltarAoPortal();
  avisar("Você saiu da conta.", "bom");

  try {
    await conta.sair(estado.servidor, token);
  } catch {
    // O servidor pode estar fora do ar. Localmente já saímos, e a sessão
    // vence sozinha — insistir aqui só travaria a interface.
  }
}

/**
 * Volta para a tela de entrada. A aplicação é escondida, e não desmontada:
 * `prepararAplicacao` liga ouvintes uma vez só, e montá-la de novo os
 * duplicaria — cada clique passaria a valer por dois.
 */
function voltarAoPortal() {
  $("perfil-dialogo").classList.add("oculto");
  $("tela-aplicacao").classList.add("oculto");
  $("tela-entrada").classList.remove("oculto");
  $("portal").classList.remove("portal--indo");
  $("entrar-email").value = estado.ultimoEmail;
  $("entrar-senha").value = "";
  $("criar-senha").value = "";
  trocarModoDoPortal(estado.ultimoEmail ? "entrar" : "criar", true);
  medirPalcoDoPortal();
  perguntarPeloGoogle();
}

function aoPerfilDeOutro({ de, apelido, avatar, bio }) {
  const membro = estado.membros.get(de);
  if (!membro) return;

  const antes = membro.apelido;
  membro.apelido = apelido;
  membro.avatar = avatar;
  membro.bio = bio;
  redesenhar();

  // Um nome que muda sozinho na lista é confuso; dito uma vez, deixa de ser.
  if (apelido !== antes) avisar(`${antes} agora se chama ${apelido}.`);
}

/**
 * O cartão de alguém. Em si mesmo abre o editor — a pergunta "quem é essa
 * pessoa?" só tem resposta interessante quando a pessoa é outra.
 */
function abrirCartaoDe(membro) {
  if (membro.id === estado.meuId) {
    abrirMeuPerfil();
    return;
  }

  const etiquetas = [];
  if (membro.usuario === estado.grupo?.dono) etiquetas.push("dono");
  if (membro.canalVoz) etiquetas.push("na voz");

  const acoes = [{ rotulo: "Ajustar volume…", fazer: () => ajustarVolumeDe(membro) }];
  // Amizade e PV exigem conta dos dois lados: sem ela `membro.usuario` é só
  // um número sorteado que não sobrevive nem à própria sessão de quem o tem,
  // e a ação some em vez de aparecer desabilitada.
  if (estado.conta) {
    if (souAmigoDe(membro.usuario)) {
      acoes.push({ rotulo: "Mandar mensagem", fazer: () => abrirConversaPrivada(membro.usuario) });
      acoes.push({ rotulo: "Desfazer amizade", fazer: () => removerAmizade(membro.usuario) });
    } else if (membro.usuario !== estado.usuario) {
      acoes.push({ rotulo: "Adicionar amigo", fazer: () => pedirAmizade(membro.usuario) });
    }
  }

  mostrarCartao({
    apelido: membro.apelido,
    avatar: membro.avatar,
    bio: membro.bio,
    atividade: membro.atividade,
    atividadeIcone: membro.atividadeIcone,
    etiquetas,
    acoes,
  });
}

/* ═══ Grupos ════════════════════════════════════════════════════ */

/** Os dois jeitos de começar: pelo "+" do trilho, ou pelo botão direito no
 *  vazio da coluna — os mesmos dois itens, para não haver dois menus que
 *  divergem com o tempo. */
function itensDeNovoGrupo() {
  return [
    { rotulo: "Criar grupo", acao: criarGrupo },
    { rotulo: "Entrar com convite", acao: entrarPorConvite },
  ];
}

function desenharAtalhos() {
  const lista = $("lista-grupos");
  lista.textContent = "";

  // O botão de Amigos fica fixo acima da lista rolável, não dentro dela —
  // ele não é um grupo, é uma vista alternativa da mesma coluna.
  const botaoAmigos = $("botao-amigos");
  botaoAmigos.classList.toggle("grupo--ativo", estado.vistaAmigos);
  botaoAmigos.classList.toggle("grupo--amigos-pendente", estado.pedidosAmigo.length > 0);

  for (const atalho of estado.atalhos) {
    const item = document.createElement("button");
    item.className = "grupo";
    item.type = "button";
    item.title = atalho.nome;
    item.setAttribute("aria-label", atalho.nome);
    if (!estado.vistaAmigos && atalho.codigo === estado.grupo?.codigo) item.classList.add("grupo--ativo");

    const marca = document.createElement("span");
    marca.className = "grupo__marca";
    pintarMarcaDeGrupo(marca, atalho);

    item.append(marca);
    item.addEventListener("click", () => {
      // Clicar no grupo já ativo não reconecta — mas, se a vista de amigos
      // estiver aberta por cima dele, é o único jeito de voltar aos canais.
      if (atalho.codigo === estado.grupo?.codigo) {
        if (estado.vistaAmigos) fecharVistaAmigos();
        return;
      }
      abrirGrupo(atalho.codigo);
    });
    item.addEventListener("contextmenu", (evento) => {
      evento.preventDefault();
      menuDoAtalho(item, atalho);
    });
    lista.append(item);
  }

  // Sempre por último no trilho — é o "+" de sempre criar mais um, do mesmo
  // jeito que o Discord deixa o botão de novo servidor no fim da lista.
  const novo = document.createElement("button");
  novo.className = "grupo grupo--novo";
  novo.type = "button";
  novo.title = "Criar ou entrar num grupo";
  novo.setAttribute("aria-label", "Criar ou entrar num grupo");
  novo.innerHTML =
    '<span class="grupo__marca grupo__marca--novo" aria-hidden="true">' +
    '<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></span>';
  novo.addEventListener("click", (evento) => abrirMenu(pontoDoClique(evento), itensDeNovoGrupo()));
  lista.append(novo);
}

async function criarGrupo() {
  const grupo = await editarGrupo(
    { nome: "", foto: "", descricao: "" },
    {
      titulo: "Criar grupo",
      confirmar: "Criar",
    }
  );
  if (!grupo) return;
  await conectar({
    tipo: "criar-grupo",
    nome: grupo.nome,
    foto: grupo.foto,
    descricao: grupo.descricao,
  });
}

async function editarGrupoAtual() {
  if (!estado.grupo || !souDono()) return;
  const grupo = await editarGrupo(estado.grupo, {
    titulo: "Editar grupo",
    confirmar: "Salvar",
  });
  if (!grupo) return;

  // Reflete a edição imediatamente no grupo ativo e no atalho. A resposta
  // `grupo` do servidor ainda confirma a fonte de verdade logo depois, mas a
  // foto não desaparece da interface enquanto faz essa volta pela rede.
  aoEstrutura({ ...estado.grupo, ...grupo });

  sinal.enviar({
    tipo: "editar-grupo",
    nome: grupo.nome,
    foto: grupo.foto,
    descricao: grupo.descricao,
  });
}

async function editarGrupoDoAtalho(atalho) {
  if (atalho.codigo !== estado.grupo?.codigo) {
    await abrirGrupo(atalho.codigo);
  }
  if (!estado.grupo || estado.grupo.codigo !== atalho.codigo) return;
  if (!souDono()) {
    avisar("Só quem criou o grupo pode editá-lo.", "erro");
    return;
  }
  await editarGrupoAtual();
}

async function entrarPorConvite() {
  const valores = await perguntar({
    titulo: "Entrar com convite",
    texto: "Cole o código que alguém do grupo compartilhou.",
    campos: [{ rotulo: "Código", dica: "XXXXXXXXXX", maximo: 10, maiusculas: true }],
    confirmar: "Entrar",
  });
  if (!valores) return;
  await conectar({ tipo: "entrar", codigo: valores[0].toUpperCase() });
}

function abrirGrupo(codigo) {
  if (codigo === estado.grupo?.codigo) return;
  return conectar({ tipo: "entrar", codigo });
}

/**
 * Uma conexão atende a um grupo só — é assim que o servidor separa quem vê o
 * quê. Trocar de grupo, portanto, é trocar de socket.
 */
async function conectar(saudacao) {
  if (estado.ocupado) return;
  estado.ocupado = true;
  desligar();

  $("nome-grupo").textContent = "Conectando…";
  $("descricao-grupo").hidden = true;
  $("descricao-grupo").textContent = "";

  try {
    const boasVindas = await sinal.conectar(estado.servidor, {
      ...saudacao,
      apelido: estado.apelido,
      // Com token, o servidor ignora o `usuario` e usa o da conta: quem tem
      // conta não se apresenta, se identifica. Sem token, a saudação é
      // exatamente a que sempre foi.
      token: estado.token,
      usuario: estado.usuario,
      avatar: estado.avatar,
      bio: estado.bio,
    });
    assumirGrupo(boasVindas);
  } catch (erro) {
    desligar();
    avisar(erro.message ?? String(erro), "erro");
  } finally {
    estado.ocupado = false;
  }
}

function assumirGrupo({ eu, grupo, presentes, conta: daConta, sons }) {
  estado.grupo = grupo;
  estado.meuId = eu.id;

  // A identidade efetiva é a que o servidor confirmou na saudação. Isto
  // importa especialmente ao trocar de backend: um token que não existe no
  // servidor novo cai para uma identidade de visitante, e o cliente precisa
  // adotá-la para reconhecer que é dono do grupo que acabou de criar.
  if (typeof eu.usuario === "string" && eu.usuario && estado.usuario !== eu.usuario) {
    estado.usuario = eu.usuario;
    salvarPreferencias();
  }

  malha.definirIdentidade(eu.id);
  // Um grupo novo começa com a coluna decidindo sozinha de novo — a escolha
  // manual era sobre o grupo anterior, e não teria por que valer aqui.
  presentesForcado = null;

  // A saudação com token volta com a conta inteira. É aqui que os grupos de
  // outra máquina aparecem na coluna da esquerda, sem transação separada.
  if (daConta) {
    estado.conta = daConta;
    fundirAtalhos(daConta.atalhos);
    mostrarContaNoPerfil();
  }

  estado.membros.clear();
  // `foto` entra aqui — e só aqui, na própria entrada — porque este mapa é
  // que alimenta como cada um se desenha na tela, e é a própria pessoa vendo
  // a si mesma. A saudação que os outros recebem sobre "eu" não carrega isto.
  estado.membros.set(eu.id, {
    ...eu,
    apelido: estado.apelido,
    avatar: estado.avatar,
    bio: estado.bio,
    foto: estado.foto,
  });
  for (const membro of presentes) estado.membros.set(membro.id, membro);

  estado.sons = sons ?? [];
  desenharSoundboard();
  preencherSeletorSomEntrada();

  lembrarGrupo(grupo.codigo, grupo.nome, grupo.foto);
  sincronizarConta({ atalhos: estado.atalhos });
  ajustarVigia();
  atualizarConexao(true);

  // Trocar de grupo é sair de qualquer vista de Amigos que estivesse aberta
  // por cima dele — amizade continua valendo (o socket social nem percebeu a
  // troca), só a tela volta a mostrar os canais do grupo que se acabou de
  // entrar, que é o que se pediu ao clicar nele.
  estado.vistaAmigos = false;

  desenharAtalhos();
  desenharCabecalhoDoGrupo();
  redesenhar();

  // Sem um canal aberto a coluna central ficaria vazia logo depois de entrar,
  // e o primeiro canal de texto é o que quase sempre se quer ver.
  const primeiro = canaisDoGrupo().find((c) => c.tipo === "texto");
  if (primeiro) abrirCanalTexto(primeiro.id);
}

/** Encerra a participação no grupo sem tocar na lista de atalhos. */
function desligar() {
  sairDaVoz(false);
  // `false`: o socket está indo embora de qualquer jeito, e um anúncio de
  // saída numa conexão que já não existe não chega a ninguém.
  vigia.desligar(false);
  estado.minhaAtividade = null;
  sinal.desconectar();

  estado.grupo = null;
  estado.meuId = null;
  estado.membros.clear();
  presentesForcado = null;
  estado.canalTexto = null;
  // Só o histórico de canal sai daqui — o de PV é da conta, mora no socket
  // social, que nem percebe esta queda, e não deve desaparecer da tela só
  // porque o grupo caiu. Ids de conta começam sempre com "conta-"; ids de
  // canal nunca começam — é o que distingue as duas chaves neste mesmo mapa.
  for (const chave of estado.mensagens.keys()) {
    if (!chave.startsWith("conta-")) estado.mensagens.delete(chave);
  }
  estado.naoLidos.clear();
  estado.sons = [];
  fecharSoundboard();

  atualizarConexao(false);
  desenharAtalhos();
  desenharCabecalhoDoGrupo();
  redesenhar();
  desenharConversa();
}

function esquecerGrupo(codigo) {
  if (codigo === estado.grupo?.codigo) desligar();
  estado.atalhos = estado.atalhos.filter((a) => a.codigo !== codigo);
  salvarPreferencias();
  // Esquecer num computador é esquecer na conta: sem isto, o grupo voltaria
  // sozinho na próxima entrada, e "esquecer" não teria significado nenhum.
  sincronizarConta({ atalhos: estado.atalhos });
  desenharAtalhos();
}

function desenharCabecalhoDoGrupo() {
  $("nome-grupo").textContent = estado.grupo?.nome ?? "Nenhum grupo";
  pintarMarcaDeGrupo($("avatar-grupo"), estado.grupo ?? { nome: "Nenhum grupo", foto: "" });
  const descricao = (estado.grupo?.descricao ?? "").trim();
  $("descricao-grupo").textContent = descricao;
  $("descricao-grupo").hidden = !descricao;
}

/**
 * O link do convite aponta para a página do projeto, não direto para
 * `call://`: quem recebe pode não ter o CALL instalado, e um esquema que
 * ninguém registrou não abre nada nem explica por quê. A página abre o
 * aplicativo com um clique para quem tem, e oferece o instalador para quem
 * não tem.
 *
 * Recebe código e nome direto, e não `estado.grupo`: o convite de um grupo
 * precisa poder ser copiado a partir da lista, sem estar conectado a ele —
 * uma conexão atende a um grupo só, e não é por isso que os outros somem.
 */
function linkDoConvitePara(codigo, nome) {
  const endereco = new URL(`${SITE}/entrar/`);
  endereco.searchParams.set("c", codigo);
  if (nome) endereco.searchParams.set("g", nome);
  if (estado.apelido) endereco.searchParams.set("a", estado.apelido);
  return endereco.toString();
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    avisar("Não foi possível copiar. Selecione o código à mão.", "erro");
    return false;
  }
}

async function copiarLinkDoConvite(atalho) {
  if (await copiar(linkDoConvitePara(atalho.codigo, atalho.nome))) {
    avisar("Link do convite copiado.", "bom");
  }
}

/** O código continua tendo dono: quem vai ditar por voz ou digitar à mão. */
async function copiarCodigoDoConvite(atalho) {
  if (await copiar(atalho.codigo)) avisar("Código copiado.", "bom");
}

/**
 * O menu do botão direito sobre um grupo na lista. Renomear e nova categoria
 * só cabem no grupo em que a pessoa está de fato conectada — dono ou não, o
 * servidor só aceita esses comandos na conexão aberta com aquele grupo — e
 * por isso só aparecem quando o atalho é o grupo ativo.
 */
function menuDoAtalho(ancora, atalho) {
  const ehAtivo = atalho.codigo === estado.grupo?.codigo;

  const itens = [
    { rotulo: "Copiar link do convite", acao: () => copiarLinkDoConvite(atalho) },
    { rotulo: "Copiar código do convite", acao: () => copiarCodigoDoConvite(atalho) },
  ];

  if (ehAtivo ? souDono() : true) {
    itens.unshift("-", { rotulo: "Editar grupo", acao: () => editarGrupoDoAtalho(atalho) });
  }

  if (ehAtivo) itens.push({ rotulo: "Sair do grupo", acao: () => desligar() });

  itens.push("-", {
    rotulo: "Esquecer este grupo",
    perigo: true,
    acao: () => esquecerGrupo(atalho.codigo),
  });

  if (ehAtivo && souDono()) {
    itens.unshift(
      { rotulo: "Nova categoria", acao: criarCategoria },
      "-"
    );
  }

  abrirMenu(ancora, itens);
}

/* ═══ Estrutura ═════════════════════════════════════════════════ */

function canaisDoGrupo() {
  return estado.grupo?.categorias.flatMap((c) => c.canais) ?? [];
}

function acharCanal(id) {
  return canaisDoGrupo().find((c) => c.id === id) ?? null;
}

function aoEstrutura(grupo) {
  estado.grupo = grupo;
  lembrarGrupo(grupo.codigo, grupo.nome, grupo.foto);
  sincronizarConta({ atalhos: estado.atalhos });

  // O servidor tira da voz quem estava num canal removido, mas não avisa a
  // própria pessoa — para ela, o aviso é este.
  if (estado.canalVoz && !acharCanal(estado.canalVoz)) {
    sairDaVoz(false);
    avisar("O canal de voz em que você estava foi removido.", "erro");
  }
  if (estado.canalTexto && !acharCanal(estado.canalTexto)) {
    estado.canalTexto = null;
    const outro = canaisDoGrupo().find((c) => c.tipo === "texto");
    if (outro) abrirCanalTexto(outro.id);
    else desenharConversa();
  }

  desenharAtalhos();
  desenharCabecalhoDoGrupo();
  redesenhar();
  desenharConversa();
}

function criarCategoria() {
  pedirNome("Nova categoria", "", (nome) => sinal.enviar({ tipo: "criar-categoria", nome }), {
    confirmar: "Criar",
  });
}

async function criarCanal(categoria) {
  const valores = await perguntar({
    titulo: "Novo canal",
    campos: [
      { rotulo: "Nome", dica: "assuntos-gerais", maximo: 40 },
      {
        rotulo: "Tipo",
        opcoes: [
          { rotulo: "Texto", valor: "texto" },
          { rotulo: "Voz", valor: "voz" },
        ],
      },
    ],
    confirmar: "Criar",
  });
  if (!valores) return;
  sinal.enviar({
    tipo: "criar-canal",
    categoria,
    nome: valores[0],
    tipoCanal: valores[1],
  });
}

async function pedirNome(titulo, valor, aplicar, extras = {}) {
  const valores = await perguntar({
    titulo,
    campos: [{ rotulo: "Nome", valor, maximo: 40 }],
    confirmar: extras.confirmar ?? "Renomear",
  });
  if (valores) aplicar(valores[0]);
}

async function confirmarRemocao(alvo, id, nome) {
  const valores = await perguntar({
    titulo: `Remover ${alvo}`,
    texto:
      alvo === "categoria"
        ? `“${nome}” e todos os canais dentro dela saem do grupo, junto com o histórico deles.`
        : `“${nome}” sai do grupo, junto com o histórico dele.`,
    confirmar: "Remover",
    perigo: true,
  });
  if (valores) sinal.enviar({ tipo: "remover", alvo, id });
}

/* ═══ Árvore de canais ══════════════════════════════════════════ */

/**
 * A árvore e a lista de presentes mostram as mesmas pessoas, e as duas
 * recebem a marca de quem está falando. Redesenhar só uma deixaria no mapa
 * `linhas` elementos que já saíram da tela — e a marca iria para o vazio.
 */
function redesenhar() {
  atualizarVistaEsquerda();
  linhas.clear();
  desenharArvore();
  desenharParticipantes();
  desenharPassaram();
}

/** A coluna 2 mostra a árvore de canais do grupo ou a lista de amigos —
 *  nunca as duas. É só visibilidade: nenhum dos dois lados perde o que
 *  tinha desenhado ao ficar escondido. */
function atualizarVistaEsquerda() {
  const emAmigos = estado.vistaAmigos;
  $("canais-topo").classList.toggle("oculto", emAmigos);
  $("arvore-canais").classList.toggle("oculto", emAmigos);
  $("amigos-secao").classList.toggle("oculto", !emAmigos);
}

function desenharArvore() {
  const arvore = $("arvore-canais");
  arvore.textContent = "";

  if (!estado.grupo) {
    const vazio = document.createElement("p");
    vazio.className = "canais__vazio";
    vazio.textContent = "Entre em um grupo para ver os canais.";
    arvore.append(vazio);
    return;
  }

  const dono = souDono();

  for (const categoria of estado.grupo.categorias) {
    const bloco = document.createElement("section");
    bloco.className = "categoria";

    const cabecalho = document.createElement("div");
    cabecalho.className = "categoria__topo";

    const nome = document.createElement("span");
    nome.className = "categoria__nome";
    nome.textContent = categoria.nome;
    cabecalho.append(nome);

    if (dono) {
      const mais = botaoDeIcone("Novo canal", '<path d="M10 4.5v11M4.5 10h11"/>');
      mais.addEventListener("click", () => criarCanal(categoria.id));

      const opcoes = botaoDeIcone("Opções", '<circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/>');
      opcoes.addEventListener("click", () =>
        abrirMenu(opcoes, [
          {
            rotulo: "Renomear categoria",
            acao: () =>
              pedirNome("Renomear categoria", categoria.nome, (n) =>
                sinal.enviar({ tipo: "renomear", alvo: "categoria", id: categoria.id, nome: n })
              ),
          },
          { rotulo: "Novo canal", acao: () => criarCanal(categoria.id) },
          "-",
          {
            rotulo: "Remover categoria",
            perigo: true,
            acao: () => confirmarRemocao("categoria", categoria.id, categoria.nome),
          },
        ])
      );
      cabecalho.append(mais, opcoes);
    }

    bloco.append(cabecalho);

    for (const canal of categoria.canais) {
      bloco.append(desenharCanal(canal, dono));
      if (canal.tipo === "voz") {
        for (const membro of membrosNaVoz(canal.id)) {
          bloco.append(desenharMembroNaVoz(membro));
        }
      }
    }

    arvore.append(bloco);
  }
}

function botaoDeIcone(titulo, caminho) {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "icone icone--fino";
  botao.title = titulo;
  botao.setAttribute("aria-label", titulo);
  botao.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${caminho}</svg>`;
  return botao;
}

const GLIFO_TEXTO = '<path d="M7 3L5 17M15 3l-2 14M3.5 7.5h14M2.5 12.5h14"/>';
const GLIFO_VOZ = '<path d="M11 4L6.5 7.5H3v5h3.5L11 16z"/><path d="M14 7.5a4 4 0 0 1 0 5"/>';

function desenharCanal(canal, dono) {
  // A linha é uma div, e não um botão, porque o botão de opções mora dentro
  // dela: um botão aninhado em outro é marcação inválida, e o navegador
  // desmonta a estrutura para consertá-la.
  const item = document.createElement("div");
  item.className = "canal";
  item.dataset.tipo = canal.tipo;

  const ativo =
    canal.tipo === "texto" ? canal.id === estado.canalTexto : canal.id === estado.canalVoz;
  if (ativo) item.classList.add("canal--ativo");

  const alvo = document.createElement("button");
  alvo.type = "button";
  alvo.className = "canal__alvo";

  const glifo = document.createElement("span");
  glifo.className = "canal__glifo";
  glifo.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${
    canal.tipo === "texto" ? GLIFO_TEXTO : GLIFO_VOZ
  }</svg>`;

  const nome = document.createElement("span");
  nome.className = "canal__nome";
  nome.textContent = canal.nome;

  alvo.append(glifo, nome);

  if (canal.tipo === "texto" && estado.naoLidos.get(canal.id) > 0) {
    const marca = document.createElement("span");
    marca.className = "canal__novidade";
    alvo.append(marca);
  }

  alvo.addEventListener("click", () => {
    if (canal.tipo === "texto") abrirCanalTexto(canal.id);
    else entrarNaVoz(canal.id);
  });
  item.append(alvo);

  if (dono) {
    const opcoes = botaoDeIcone("Opções", '<circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/>');
    opcoes.addEventListener("click", (evento) => {
      evento.stopPropagation();
      abrirMenu(opcoes, [
        {
          rotulo: "Renomear canal",
          acao: () =>
            pedirNome("Renomear canal", canal.nome, (n) =>
              sinal.enviar({ tipo: "renomear", alvo: "canal", id: canal.id, nome: n })
            ),
        },
        "-",
        {
          rotulo: "Remover canal",
          perigo: true,
          acao: () => confirmarRemocao("canal", canal.id, canal.nome),
        },
      ]);
    });
    item.append(opcoes);
  }

  return item;
}

function membrosNaVoz(canal) {
  return [...estado.membros.values()].filter((m) => m.canalVoz === canal);
}

function desenharMembroNaVoz(membro) {
  // Botão, e não `div` com um ouvinte: a linha abre o cartão da pessoa, e uma
  // `div` clicável não é alcançável pelo teclado nem anunciada como acionável.
  const linha = document.createElement("button");
  linha.type = "button";
  linha.className = "vozinho";
  linha.dataset.falando = falas.get(membro.id) ? "sim" : "nao";

  const avatar = document.createElement("span");
  avatar.className = "avatar avatar--pequeno";
  pintarAvatar(avatar, membro);

  const nome = document.createElement("span");
  nome.className = "vozinho__nome";
  nome.textContent = membro.id === estado.meuId ? `${membro.apelido} (você)` : membro.apelido;

  const sinais = document.createElement("span");
  sinais.className = "vozinho__sinais";
  if (membro.transmitindo) sinais.innerHTML += SVG_TRANSMITINDO;
  if (membro.mudo) sinais.innerHTML += SVG_MUDO;

  linha.append(avatar, nome, sinais);
  // A árvore de canais é onde se vê quem está na voz — e é de lá que se quer
  // saber quem é a pessoa, sem ter que procurá-la na quarta coluna.
  linha.addEventListener("click", () => abrirCartaoDe(membro));
  registrarLinha(membro.id, linha);
  return linha;
}

/* ═══ Membros ═══════════════════════════════════════════════════ */

function aoEntrar(membro) {
  estado.membros.set(membro.id, membro);
  redesenhar();
  avisar(`${membro.apelido} entrou no grupo.`);
}

function aoSair(id) {
  const membro = estado.membros.get(id);
  estado.membros.delete(id);
  derrubarPar(id);
  redesenhar();
  if (membro) avisar(`${membro.apelido} saiu do grupo.`);
}

function aoEstadoDeMidia({ de, mudo, transmitindo, atividade, atividadeIcone }) {
  const membro = estado.membros.get(de);
  if (!membro) return;
  membro.mudo = mudo;
  membro.transmitindo = transmitindo;
  membro.atividade = atividade ?? null;
  membro.atividadeIcone = atividadeIcone ?? null;
  if (!transmitindo) removerTela(de);
  redesenhar();
}

/**
 * Um par pode sumir sem que o servidor perceba (rede caiu, máquina hibernou).
 * O WebSocket dele continuaria de pé, e ele seguiria listado na voz, mudo.
 */
function aoEstadoDaConexao(id, situacao) {
  if (situacao !== "failed" && situacao !== "closed") return;
  if (!estado.canalVoz) return;
  const membro = estado.membros.get(id);
  if (!membro || membro.canalVoz !== estado.canalVoz) return;
  avisar(`Perdemos a conexão de voz com ${membro.apelido}.`, "erro");
  membro.canalVoz = null;
  derrubarPar(id);
  redesenhar();
}

const SVG_MUDO =
  '<svg viewBox="0 0 24 24" class="sinal--mudo"><path d="M4 4l16 16"/><path d="M9 5a3 3 0 0 1 6 1v5m-1.5 3.5A3 3 0 0 1 9 12v-2"/><path d="M5 11a7 7 0 0 0 10.6 6M19 11a6.9 6.9 0 0 1-.4 2.3"/></svg>';
const SVG_TRANSMITINDO =
  '<svg viewBox="0 0 24 24" class="sinal--transmitindo"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 21h4"/></svg>';

function registrarLinha(id, elemento) {
  const existentes = linhas.get(id);
  if (existentes) existentes.push(elemento);
  else linhas.set(id, [elemento]);
}

/**
 * A coluna de presentes começa fechada e só abre sozinha quando alguém entra
 * numa call — é o "alguma ação" que justifica o espaço. `null` quer dizer
 * "decide sozinho"; `true`/`false` é a pessoa tendo mexido na mão, e essa
 * escolha vale até a próxima troca de grupo.
 */
let presentesForcado = null;

function presentesDeveAbrir() {
  if (presentesForcado !== null) return presentesForcado;
  return [...estado.membros.values()].some((m) => m.canalVoz);
}

function atualizarPresentes() {
  const aberto = presentesDeveAbrir();
  $("tela-aplicacao").dataset.presentes = aberto ? "aberto" : "fechado";

  const botao = $("botao-presentes");
  botao.setAttribute("aria-pressed", String(aberto));

  const quantos = estado.membros.size;
  const selo = $("badge-presentes");
  selo.textContent = String(quantos);
  selo.classList.toggle("oculto", quantos === 0);
}

function desenharParticipantes() {
  const lista = $("lista-participantes");
  lista.textContent = "";

  if (!estado.grupo) {
    const vazio = document.createElement("p");
    vazio.className = "participantes__vazio";
    vazio.textContent = "Você não está em nenhum grupo.";
    lista.append(vazio);
    $("contador-participantes").textContent = "0";
    atualizarPresentes();
    return;
  }

  const todos = [...estado.membros.values()].sort((a, b) =>
    a.id === estado.meuId ? -1 : b.id === estado.meuId ? 1 : a.apelido.localeCompare(b.apelido)
  );
  $("contador-participantes").textContent = String(todos.length);

  for (const membro of todos) {
    const linha = document.createElement("button");
    linha.type = "button";
    linha.className = "participante";
    // A lista é redesenhada a cada mudança de estado; sem reaplicar a marca,
    // quem estivesse falando apagaria a cada silenciar de outra pessoa.
    linha.dataset.falando = falas.get(membro.id) ? "sim" : "nao";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    pintarAvatar(avatar, membro);

    const nome = document.createElement("span");
    nome.className = "participante__nome";
    nome.textContent =
      membro.id === estado.meuId ? `${membro.apelido} (você)` : membro.apelido;

    // Nome e atividade viram uma coluna só quando há atividade. Sem ela, o
    // `span` do nome vai direto para a linha, como sempre foi: uma pessoa sem
    // nada em primeiro plano não deve ocupar dois andares na lista.
    let texto = nome;
    if (membro.atividade) {
      texto = document.createElement("span");
      texto.className = "participante__texto";
      const fazendo = document.createElement("span");
      fazendo.className = "participante__atividade";
      fazendo.title = membro.atividade;
      if (membro.atividadeIcone) {
        const icone = document.createElement("img");
        icone.className = "participante__atividade-icone";
        icone.src = membro.atividadeIcone;
        icone.alt = "";
        fazendo.append(icone);
      }
      const rotulo = document.createElement("span");
      rotulo.textContent = membro.atividade;
      fazendo.append(rotulo);
      texto.append(nome, fazendo);
    }

    const sinais = document.createElement("span");
    sinais.className = "participante__sinais";
    if (membro.usuario === estado.grupo.dono) {
      const coroa = document.createElement("span");
      coroa.className = "etiqueta";
      coroa.textContent = "dono";
      sinais.append(coroa);
    }
    if (membro.transmitindo) sinais.innerHTML += SVG_TRANSMITINDO;
    if (membro.mudo) sinais.innerHTML += SVG_MUDO;

    // Clicar abre o cartão da pessoa, que é onde o volume dela também mora. O
    // botão direito continua sendo o atalho direto: um controle permanente por
    // linha encheria uma coluna de 212 px de coisa que quase nunca se usa.
    linha.addEventListener("click", () => abrirCartaoDe(membro));
    if (membro.id !== estado.meuId) {
      linha.addEventListener("contextmenu", (evento) => {
        evento.preventDefault();
        abrirMenu(linha, [{ rotulo: "Ajustar volume…", acao: () => ajustarVolumeDe(membro) }]);
      });
    }

    linha.append(avatar, texto, sinais);
    lista.append(linha);
    registrarLinha(membro.id, linha);
  }

  atualizarPresentes();
}

/**
 * Quem esteve nesta call e já saiu — nome e quanto tempo ficou, nada mais.
 *
 * A seção some quando não há ninguém: numa coluna de 212 px, um título com
 * uma lista vazia embaixo custa o mesmo espaço de dois participantes.
 *
 * O tempo é o que este computador observou. De quem já estava na sala quando
 * você chegou não dá para saber o começo — o servidor não guarda isso —, e
 * essas linhas levam um `+` de "pelo menos". Mostrar o número redondo, como
 * se fosse o total, seria mais bonito e mentira.
 */
function desenharPassaram() {
  const secao = $("passaram");
  const lista = $("lista-passaram");
  lista.textContent = "";

  // Fora de uma call não há call de quem falar.
  const gente = estado.canalVoz ? historicoDaCall.lista() : [];
  secao.classList.toggle("oculto", gente.length === 0);
  if (gente.length === 0) return;

  for (const pessoa of gente) {
    const linha = document.createElement("div");
    linha.className = "passou";
    linha.title = pessoa.exato
      ? `Ficou ${tempoCurto(pessoa.tempo)} · saiu às ${HORA.format(pessoa.saiuEm)}`
      : `Ficou pelo menos ${tempoCurto(pessoa.tempo)} — já estava na call quando você entrou · saiu às ${HORA.format(pessoa.saiuEm)}`;

    const nome = document.createElement("span");
    nome.className = "passou__nome";
    nome.textContent = pessoa.apelido;

    const tempo = document.createElement("span");
    tempo.className = "passou__tempo";
    tempo.textContent = pessoa.exato ? tempoCurto(pessoa.tempo) : `${tempoCurto(pessoa.tempo)}+`;

    linha.append(nome, tempo);
    lista.append(linha);
  }
}

/**
 * Volume individual. Vale para a voz e para o som que a pessoa transmite, e é
 * guardado pelo identificador estável — quem abaixou alguém hoje quer isso
 * amanhã, mesmo com outro `id` de sessão.
 */
async function ajustarVolumeDe(membro) {
  const anterior = estado.volumes.get(membro.usuario) ?? 1;
  const aplicar = (valor) => {
    motor.definirVolumeDe(membro.id, valor);
    motor.definirVolumeDe(`tela:${membro.id}`, valor);
  };

  const resposta = await perguntar({
    titulo: `Volume de ${membro.apelido}`,
    campos: [
      {
        rotulo: "Volume",
        deslizante: { min: 0, max: 200, step: 5 },
        valor: Math.round(anterior * 100),
        formatar: (v) => `${v}%`,
        aoMudar: (v) => aplicar(v / 100),
        obrigatorio: false,
      },
    ],
    confirmar: "Guardar",
  });

  if (!resposta) {
    aplicar(anterior);
    return;
  }

  const escolhido = resposta[0] / 100;
  aplicar(escolhido);
  if (escolhido === 1) estado.volumes.delete(membro.usuario);
  else estado.volumes.set(membro.usuario, escolhido);
  salvarPreferencias();
}

function atualizarConexao(ligado) {
  const rotulo = $("rotulo-conexao");
  rotulo.textContent = ligado ? "Conectado" : "Desconectado";
  rotulo.dataset.ligado = ligado ? "sim" : "nao";
  // O pontinho no avatar do rodapé é quem carrega esse estado no trilho
  // estreito — `rotulo-conexao` continua existindo, só que sem espaço para
  // aparecer.
  $("avatar-usuario").dataset.ligado = ligado ? "sim" : "nao";
}

/* ═══ Conversa ══════════════════════════════════════════════════ */

function prepararRedator() {
  const campo = $("campo-mensagem");

  $("redator").addEventListener("submit", (evento) => {
    evento.preventDefault();
    enviarMensagem();
  });

  campo.addEventListener("keydown", (evento) => {
    // Enter envia; Shift+Enter quebra linha. É a convenção de todo aplicativo
    // de conversa, e contrariá-la faria a pessoa mandar mensagem sem querer.
    if (evento.key === "Enter" && !evento.shiftKey) {
      evento.preventDefault();
      enviarMensagem();
      return;
    }
    if (evento.key === "Enter" && evento.shiftKey) {
      // `insertLineBreak` (e não deixar o navegador decidir) é o que garante
      // um `<br>` em vez de um `<div>` novo — Chrome e Firefox discordam do
      // padrão, e só um dos dois lê certo em `textoDoCampo`.
      evento.preventDefault();
      document.execCommand("insertLineBreak");
      limitarCampoDeMensagem(campo);
    }
  });

  campo.addEventListener("input", () => limitarCampoDeMensagem(campo));

  // Colar sempre como texto puro — um campo editável aceita HTML colado por
  // padrão, e isso abriria espaço para marcação estranha vinda de fora.
  campo.addEventListener("paste", (evento) => {
    evento.preventDefault();
    const texto = evento.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, texto);
    limitarCampoDeMensagem(campo);
  });

  $("redator-emoji").addEventListener("click", (evento) => {
    evento.stopPropagation();
    abrirSeletorDeEmoji($("redator-emoji"), inserirEmojiNoCampo);
  });
}

/** Lê o campo de mensagem como texto puro, trocando cada emoji desenhado
 *  pelo `:id:` que ele representa — é o mesmo formato que trafega pela
 *  rede e que `preencherTextoComEmoji` sabe desenhar de volta. */
function textoDoCampo(campo) {
  let texto = "";
  for (const no of campo.childNodes) {
    if (no.nodeType === Node.TEXT_NODE) texto += no.textContent;
    else if (no.dataset?.emojiId) texto += `:${no.dataset.emojiId}:`;
    else if (no.nodeName === "BR") texto += "\n";
    else texto += no.textContent;
  }
  return texto;
}

/** O campo tem um teto de 2000 caracteres — o mesmo que o servidor aplica
 *  em `TEXTO_MAX`. Sem `maxlength` (que só existe em `<textarea>`), o corte
 *  precisa ser feito à mão sempre que o texto crescer além dele. */
function limitarCampoDeMensagem(campo) {
  const texto = textoDoCampo(campo);
  if (texto.length <= 2000) return;
  renderizarCampoComEmoji(campo, texto.slice(0, 2000));
  posicionarCursorNoFim(campo);
}

/** Um emoji dentro do campo é um bloco atômico: editável no sentido de que
 *  o backspace o apaga inteiro, mas não em texto — por isso `contentEditable
 *  = false` dentro de um campo que, no resto, é editável. */
function elementoDeEmojiNoCampo(id) {
  const elemento = elementoDeEmoji(id, "emoji emoji--linha");
  elemento.contentEditable = "false";
  elemento.dataset.emojiId = id;
  return elemento;
}

/** Reconstrói o conteúdo do campo a partir de um texto com tokens `:id:` —
 *  o inverso de `textoDoCampo`. Usado para truncar e para começar do zero. */
function renderizarCampoComEmoji(campo, texto) {
  campo.textContent = "";
  TOKEN_EMOJI.lastIndex = 0;
  let ultimo = 0;
  let m;
  while ((m = TOKEN_EMOJI.exec(texto))) {
    if (m.index > ultimo) campo.append(texto.slice(ultimo, m.index));
    campo.append(elementoDeEmojiNoCampo(m[1]));
    ultimo = TOKEN_EMOJI.lastIndex;
  }
  if (ultimo < texto.length) campo.append(texto.slice(ultimo));
}

function posicionarCursorNoFim(campo) {
  const selecao = window.getSelection();
  const alcance = document.createRange();
  alcance.selectNodeContents(campo);
  alcance.collapse(false);
  selecao?.removeAllRanges();
  selecao?.addRange(alcance);
}

/** Insere o desenho do emoji no ponto onde o cursor estava, e devolve o foco
 *  ao campo — escolher um emoji não deve tirar a pessoa do fluxo de escrever. */
function inserirEmojiNoCampo(id) {
  const campo = $("campo-mensagem");
  campo.focus();

  const selecao = window.getSelection();
  let alcance;
  if (selecao && selecao.rangeCount > 0 && campo.contains(selecao.anchorNode)) {
    alcance = selecao.getRangeAt(0);
  } else {
    alcance = document.createRange();
    alcance.selectNodeContents(campo);
    alcance.collapse(false);
  }

  alcance.deleteContents();
  const elemento = acharEmoji(id)?.nativo ? document.createTextNode(id) : elementoDeEmojiNoCampo(id);
  alcance.insertNode(elemento);
  alcance.setStartAfter(elemento);
  alcance.collapse(true);
  selecao?.removeAllRanges();
  selecao?.addRange(alcance);

  limitarCampoDeMensagem(campo);
}

function enviarMensagem() {
  const campo = $("campo-mensagem");
  const texto = textoDoCampo(campo).trim();
  if (!texto) return;

  if (estado.conversaPrivada) {
    social.enviar({ tipo: "mensagem-privada", token: estado.token, para: estado.conversaPrivada, texto });
  } else {
    if (!estado.canalTexto) return;
    sinal.enviar({ tipo: "mensagem", canal: estado.canalTexto, texto });
  }
  campo.textContent = "";
}

function abrirCanalTexto(id) {
  estado.canalTexto = id;
  estado.conversaPrivada = null;
  estado.naoLidos.delete(id);

  // O histórico é pedido uma vez por canal; daí em diante as mensagens novas
  // chegam sozinhas pela difusão do servidor.
  if (!estado.mensagens.has(id)) sinal.enviar({ tipo: "historico", canal: id });

  redesenhar();
  desenharConversa();
  $("campo-mensagem").focus();
}

function aoHistorico({ canal, mensagens }) {
  estado.mensagens.set(canal, mensagens);
  if (canal === estado.canalTexto) desenharConversa();
}

function aoMensagem(mensagem) {
  // Só entra na fila o canal cujo histórico já veio. Guardar esta mensagem
  // sozinha faria a conversa parecer começar aqui; quando o histórico for
  // pedido, ele já a trará. A marca de novidade, essa, vale de qualquer jeito.
  estado.mensagens.get(mensagem.canal)?.push(mensagem);

  if (mensagem.canal === estado.canalTexto) {
    desenharConversa();
  } else {
    estado.naoLidos.set(mensagem.canal, (estado.naoLidos.get(mensagem.canal) ?? 0) + 1);
    redesenhar();
  }
}

/** O canal de texto aberto, ou o amigo com quem a PV está aberta — a mesma
 *  coisa para `desenharConversa`, que não precisa saber qual dos dois é. */
function alvoDaConversa() {
  if (estado.conversaPrivada) {
    const amigo = estado.amigos.find((a) => a.id === estado.conversaPrivada);
    return amigo && { id: amigo.id, nome: amigo.apelido, privado: true };
  }
  if (estado.canalTexto) {
    const canal = acharCanal(estado.canalTexto);
    return canal && { id: canal.id, nome: canal.nome, privado: false };
  }
  return null;
}

function desenharConversa() {
  const conversa = $("conversa");
  const linhaDoTempo = $("linha-do-tempo");
  const alvo = alvoDaConversa();

  $("titulo-canal").textContent = alvo ? alvo.nome : "Nenhum canal";
  $("redator").classList.toggle("oculto", !alvo);

  if (!alvo) {
    linhaDoTempo.textContent = "";
    $("conversa-vazio").classList.remove("oculto");
    vazio(
      estado.vistaAmigos ? "Selecione um amigo" : estado.grupo ? "Selecione um canal" : "Selecione um grupo",
      ""
    );
    $("subtitulo-canal").textContent = estado.vistaAmigos
      ? "Selecione um amigo"
      : estado.grupo
        ? "Escolha um canal"
        : "Selecione um grupo";
    return;
  }

  const mensagens = estado.mensagens.get(alvo.id);
  $("subtitulo-canal").textContent =
    mensagens === undefined
      ? "Carregando…"
      : mensagens.length === 0
        ? "Nenhuma mensagem ainda"
        : `${mensagens.length} mensagem${mensagens.length === 1 ? "" : "s"}`;

  $("conversa-vazio").classList.toggle("oculto", (mensagens?.length ?? 0) > 0);
  vazio("Sem mensagens", "");

  // Só cola no fim se já estava no fim: quem subiu para reler algo não deve
  // ser arrastado de volta a cada mensagem que chega.
  const colado = conversa.scrollHeight - conversa.scrollTop - conversa.clientHeight < 80;

  linhaDoTempo.textContent = "";
  let anterior = null;

  for (const mensagem of mensagens ?? []) {
    if (!anterior || !mesmoDia(anterior.em, mensagem.em)) {
      linhaDoTempo.append(marcoDeDia(mensagem.em));
    }

    const seguida =
      anterior &&
      anterior.autor === mensagem.autor &&
      mensagem.em - anterior.em < AGRUPAR_MS &&
      mesmoDia(anterior.em, mensagem.em);

    linhaDoTempo.append(seguida ? corpoDeMensagem(mensagem) : blocoDeMensagem(mensagem));
    anterior = mensagem;
  }

  if (colado) conversa.scrollTop = conversa.scrollHeight;
}

function vazio(titulo, texto) {
  $("conversa-vazio-titulo").textContent = titulo;
  $("conversa-vazio-texto").textContent = texto;
  $("conversa-vazio-texto").hidden = !texto;
}

function mesmoDia(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function marcoDeDia(em) {
  const data = new Date(em);
  const hoje = new Date();
  const ontem = new Date(hoje.getTime() - 86_400_000);

  const marco = document.createElement("div");
  marco.className = "marco";
  marco.textContent = mesmoDia(em, hoje.getTime())
    ? "Hoje"
    : mesmoDia(em, ontem.getTime())
      ? "Ontem"
      : DIA.format(data);
  return marco;
}

function blocoDeMensagem(mensagem) {
  const bloco = document.createElement("article");
  bloco.className = "mensagem";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  // O avatar vem da própria mensagem, e não de quem está no grupo agora: o
  // histórico é de quem escreveu naquele dia, e a pessoa pode nem estar aqui.
  // `foto` é a única exceção, e por falta de alternativa: ela nunca é gravada
  // na mensagem nem trafega pela rede, então a foto atual desta máquina é a
  // única que existe — e só para as mensagens da própria pessoa.
  pintarAvatar(
    avatar,
    mensagem.autor === estado.usuario ? { ...mensagem, foto: estado.foto } : mensagem
  );

  const conteudo = document.createElement("div");
  conteudo.className = "mensagem__conteudo";

  const cabecalho = document.createElement("div");
  cabecalho.className = "mensagem__cabecalho";

  const autor = document.createElement("span");
  autor.className = "mensagem__autor";
  autor.textContent = mensagem.apelido;

  const hora = document.createElement("time");
  hora.className = "mensagem__hora";
  hora.dateTime = new Date(mensagem.em).toISOString();
  hora.textContent = HORA.format(new Date(mensagem.em));

  cabecalho.append(autor, hora);
  conteudo.append(cabecalho, corpoDeMensagem(mensagem, true));
  bloco.append(avatar, conteudo);
  return bloco;
}

/**
 * Troca todo `:id:` de um emoji válido pelo desenho dele, e deixa o resto
 * como texto puro. `elemento.append` com uma string cria nó de texto — nunca
 * `innerHTML` — então o que a outra pessoa escreveu nunca vira marcação,
 * mesmo intercalado com os emoji.
 */
function preencherTextoComEmoji(elemento, texto) {
  elemento.textContent = "";
  TOKEN_EMOJI.lastIndex = 0;
  let ultimo = 0;
  let m;
  while ((m = TOKEN_EMOJI.exec(texto))) {
    if (m.index > ultimo) elemento.append(texto.slice(ultimo, m.index));
    elemento.append(elementoDeEmoji(m[1], "emoji emoji--linha"));
    ultimo = TOKEN_EMOJI.lastIndex;
  }
  if (ultimo < texto.length) elemento.append(texto.slice(ultimo));
}

/**
 * Uma linha de mensagem: o texto, a fileira de reações (só aparece com pelo
 * menos uma) e o botão de reagir, que só se revela no hover — a mesma lógica
 * de "nada fica exposto sem uma ação" que o resto do CALL segue.
 */
function corpoDeMensagem(mensagem, dentroDoBloco = false) {
  const linha = document.createElement("div");
  linha.className = "mensagem__linha";
  if (!dentroDoBloco) linha.classList.add("mensagem__linha--seguida");
  linha.dataset.mensagemId = mensagem.id;

  let texto;
  if (mensagem.excluida) {
    texto = document.createElement("span");
    texto.className = "mensagem__excluida";
    texto.textContent = "Mensagem excluída";
  } else {
    texto = document.createElement("p");
    texto.className = "mensagem__texto";
    preencherTextoComEmoji(texto, mensagem.texto);
    if (mensagem.editadaEm) {
      const editada = document.createElement("span");
      editada.className = "mensagem__editada";
      editada.textContent = "editada";
      texto.append(" ", editada);
    }
  }
  texto.title = HORA.format(new Date(mensagem.em));

  const reacoes = document.createElement("div");
  reacoes.className = "mensagem__reacoes";
  reacoes.hidden = true;

  const acoes = document.createElement("div");
  acoes.className = "mensagem__acoes";
  if (!mensagem.excluida) {
    const botaoReagir = botaoDeAcaoDeMensagem("Reagir", '<circle cx="10" cy="10" r="7.4"/><circle cx="7.3" cy="8.4" r=".9" fill="currentColor" stroke="none"/><circle cx="12.7" cy="8.4" r=".9" fill="currentColor" stroke="none"/><path d="M7 12.2c.9 1.1 1.9 1.7 3 1.7s2.1-.6 3-1.7" stroke-linecap="round"/>');
    botaoReagir.addEventListener("click", (evento) => {
      evento.stopPropagation();
      abrirSeletorDeEmoji(botaoReagir, (emoji) => reagir(mensagem.id, emoji));
    });
    acoes.append(botaoReagir);
    if (mensagem.autor === estado.usuario) {
      const editar = botaoDeAcaoDeMensagem("Editar", '<path d="M4 14.5l.8-3.3L13 3l4 4-8.2 8.2zM11.8 4.2l4 4"/>');
      editar.addEventListener("click", () => abrirEditorDeMensagem(mensagem, linha));
      const excluir = botaoDeAcaoDeMensagem("Excluir", '<path d="M4 6h12M8 6V4h4v2M6 6l.7 11h6.6L14 6M8.5 9v5M11.5 9v5"/>');
      excluir.classList.add("mensagem__acao--perigo");
      excluir.addEventListener("click", () => excluirMensagem(mensagem));
      acoes.append(editar, excluir);
    }
  }

  linha.append(texto, reacoes, acoes);
  desenharReacoes(linha, mensagem.id, mensagem.reacoes);
  return linha;
}

function botaoDeAcaoDeMensagem(titulo, desenho) {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "mensagem__reagir";
  botao.title = titulo;
  botao.setAttribute("aria-label", titulo);
  botao.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${desenho}</svg>`;
  return botao;
}

function abrirEditorDeMensagem(mensagem, linha) {
  if (linha.querySelector(".mensagem__editor")) return;
  const texto = linha.querySelector(".mensagem__texto");
  const editor = document.createElement("textarea");
  editor.className = "mensagem__editor";
  editor.value = mensagem.texto;
  editor.maxLength = 2000;
  editor.rows = Math.min(6, Math.max(2, mensagem.texto.split("\n").length));
  const controles = document.createElement("div");
  controles.className = "mensagem__editor-acoes";
  const cancelar = document.createElement("button");
  cancelar.type = "button";
  cancelar.className = "botao botao--sutil";
  cancelar.textContent = "Cancelar";
  const salvar = document.createElement("button");
  salvar.type = "button";
  salvar.className = "botao botao--primario";
  salvar.textContent = "Salvar";
  cancelar.addEventListener("click", () => {
    editor.remove();
    controles.remove();
    texto.hidden = false;
  });
  const concluir = () => {
    const novoTexto = editor.value.trim();
    if (!novoTexto || novoTexto === mensagem.texto) return cancelar.click();
    salvar.disabled = true;
    enviarAlteracaoDeMensagem("editar", mensagem.id, novoTexto);
  };
  salvar.addEventListener("click", concluir);
  editor.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") cancelar.click();
    if (evento.key === "Enter" && !evento.shiftKey) {
      evento.preventDefault();
      concluir();
    }
  });
  controles.append(cancelar, salvar);
  texto.hidden = true;
  texto.after(editor, controles);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

async function excluirMensagem(mensagem) {
  const confirmou = await perguntar({ titulo: "Excluir mensagem?", confirmar: "Excluir", perigo: true });
  if (confirmou) enviarAlteracaoDeMensagem("excluir", mensagem.id);
}

function enviarAlteracaoDeMensagem(acao, mensagem, texto = "") {
  if (estado.conversaPrivada) {
    social.enviar({ tipo: `${acao}-mensagem-privada`, token: estado.token, para: estado.conversaPrivada, mensagem, texto });
  } else if (estado.canalTexto) {
    sinal.enviar({ tipo: `${acao}-mensagem`, canal: estado.canalTexto, mensagem, texto });
  }
}

/**
 * As pílulas de reação de uma mensagem, sempre na mesma ordem — a de
 * `EMOJIS`, e não a que veio no JSON: um `HashMap` do Rust não promete
 * ordem nenhuma, e sem um critério fixo as pílulas trocariam de lugar a
 * cada reação de qualquer pessoa no grupo.
 */
function desenharReacoes(linha, mensagemId, reacoes) {
  const area = linha.querySelector(".mensagem__reacoes");
  area.textContent = "";
  let houveAlguma = false;

  const conhecidos = new Set(TODOS_EMOJIS.map((emoji) => emoji.id));
  const emojis = [
    ...TODOS_EMOJIS,
    ...Object.keys(reacoes ?? {}).filter((id) => !conhecidos.has(id)).map((id) => ({ id })),
  ];
  for (const emoji of emojis) {
    const usuarios = reacoes?.[emoji.id];
    if (!usuarios?.length) continue;
    houveAlguma = true;

    const pilula = document.createElement("button");
    pilula.type = "button";
    pilula.className = "reacao-pilula";
    pilula.dataset.minha = usuarios.includes(estado.usuario) ? "sim" : "nao";
    pilula.title = usuarios.length === 1 ? "1 reação" : `${usuarios.length} reações`;
    pilula.append(elementoDeEmoji(emoji.id, "emoji emoji--pilula"));
    const contagem = document.createElement("span");
    contagem.textContent = String(usuarios.length);
    pilula.append(contagem);
    pilula.addEventListener("click", () => reagir(mensagemId, emoji.id));
    area.append(pilula);
  }

  area.hidden = !houveAlguma;
}

/** Alterna a própria reação numa mensagem — igual a curtir em qualquer chat:
 *  clicar de novo no mesmo emoji tira. Otimista? Não: a pílula só muda
 *  quando o servidor confirma, a mesma regra que já vale para o texto. */
function reagir(mensagemId, emoji) {
  if (estado.conversaPrivada) {
    social.enviar({ tipo: "reagir-privado", token: estado.token, para: estado.conversaPrivada, mensagem: mensagemId, emoji });
  } else if (estado.canalTexto) {
    sinal.enviar({ tipo: "reagir", canal: estado.canalTexto, mensagem: mensagemId, emoji });
  }
}

function aoReacao({ canal, mensagem: mensagemId, reacoes }) {
  const lista = estado.mensagens.get(canal);
  const alvo = lista?.find((m) => m.id === mensagemId);
  if (alvo) alvo.reacoes = reacoes;

  if (canal !== estado.canalTexto) return;
  // Atualiza só a linha afetada — redesenhar a conversa inteira a cada
  // reação faria a tela pular e perderia a posição de quem estava lendo.
  const linha = document.querySelector(`[data-mensagem-id="${CSS.escape(mensagemId)}"]`);
  if (linha) desenharReacoes(linha, mensagemId, reacoes);
}

function aoMensagemAtualizada(mensagem, canal = mensagem.canal) {
  const lista = estado.mensagens.get(canal);
  const indice = lista?.findIndex((item) => item.id === mensagem.id) ?? -1;
  if (indice >= 0) lista[indice] = mensagem;
  if (canal === estado.canalTexto) desenharConversa();
}

/* ═══ Amigos ════════════════════════════════════════════════════ */
//
// Amizade e PV moram na conta, não no grupo — funcionam com quem já se
// conhece de um grupo em comum ou por um código digitado a mão, sobrevivem à
// troca de grupo e não exigem estar em nenhum. Por isso viajam por um socket
// próprio (`social`), independente do que entra e sai de grupos — ver
// `conectarSocial` logo abaixo.

/**
 * Backoff exponencial simples, com teto de 30s — rápido pra reconectar de um
 * soluço de rede, sem virar um martelo em cima de um servidor fora do ar.
 */
const ESPERA_RECONEXAO_SOCIAL = [1000, 2000, 5000, 10000, 20000, 30000];
let tentativasSocial = 0;
let reconexaoSocialPendente = null;

function socialDeveEstarLigada() {
  return Boolean(estado.conta && estado.token);
}

/** Abre (ou reabre) o socket social. Chamado sempre que a conta assume uma
 *  identidade — login, cadastro, sessão retomada — e de novo sozinho a cada
 *  queda, enquanto ainda houver conta. */
function conectarSocial() {
  clearTimeout(reconexaoSocialPendente);
  if (!socialDeveEstarLigada()) return;
  if (!social.conectarLivre(estado.servidor)) {
    agendarReconexaoSocial();
  }
}

function agendarReconexaoSocial() {
  if (!socialDeveEstarLigada()) return;
  clearTimeout(reconexaoSocialPendente);
  const espera = ESPERA_RECONEXAO_SOCIAL[Math.min(tentativasSocial, ESPERA_RECONEXAO_SOCIAL.length - 1)];
  tentativasSocial++;
  reconexaoSocialPendente = setTimeout(conectarSocial, espera);
}

/** Sair da conta é o único jeito de não precisar mais dela — trocar de grupo
 *  ou cair da voz não tem nada a ver com isto. */
function desligarSocial() {
  clearTimeout(reconexaoSocialPendente);
  tentativasSocial = 0;
  social.desconectar();
  estado.amigos = [];
  estado.pedidosAmigo = [];
  estado.conversaPrivada = null;
  if (estado.vistaAmigos) fecharVistaAmigos();
}

social.addEventListener("aberto", () => {
  tentativasSocial = 0;
  // O "alô" que registra a presença no servidor e já traz a lista — ver
  // `listar_amigos` em main.rs.
  social.enviar({ tipo: "amigos", token: estado.token });
});
social.addEventListener("queda", () => agendarReconexaoSocial());
social.addEventListener("amigo-pedido", (e) => aoPedidoDeAmizade(e.detail));
social.addEventListener("amigo-atualizado", () => pedirListaDeAmigos());
social.addEventListener("amigos", (e) => aoListaDeAmigos(e.detail));
social.addEventListener("mensagem-privada", (e) => aoMensagemPrivada(e.detail));
social.addEventListener("mensagem-privada-atualizada", (e) => aoMensagemPrivadaAtualizada(e.detail));
social.addEventListener("reacao-privada", (e) => aoReacaoPrivada(e.detail));
social.addEventListener("historico-privado", (e) => aoHistoricoPrivado(e.detail));

function souAmigoDe(contaId) {
  return estado.amigos.some((a) => a.id === contaId);
}

function pedirListaDeAmigos() {
  if (!estado.conta) return;
  social.enviar({ tipo: "amigos", token: estado.token });
}

function pedirAmizade(paraId) {
  if (!estado.conta || !paraId) return;
  social.enviar({ tipo: "amigo-pedido", token: estado.token, para: paraId });
}

function responderAmizade(deId, aceitar) {
  social.enviar({ tipo: "amigo-responder", token: estado.token, de: deId, aceitar });
}

function removerAmizade(amigoId) {
  social.enviar({ tipo: "amigo-remover", token: estado.token, id: amigoId });
  if (estado.conversaPrivada === amigoId) {
    estado.conversaPrivada = null;
    desenharConversa();
  }
}

async function adicionarAmigoPorCodigo() {
  const valores = await perguntar({
    titulo: "Adicionar amigo",
    campos: [{ rotulo: "Código de amigo", dica: "conta-xxxxxxxxxxxx", maximo: 40 }],
    confirmar: "Adicionar",
  });
  if (!valores) return;
  pedirAmizade(valores[0].trim());
}

/** Troca a coluna de canais pela lista de amigos — não fecha o grupo, só o
 *  que aparece ao lado dele. Só pede uma conta; não pede grupo nenhum. */
function abrirVistaAmigos() {
  if (!estado.conta) {
    avisar("Crie uma conta para adicionar amigos.", "erro");
    return;
  }
  estado.vistaAmigos = true;
  estado.canalTexto = null;
  desenharAtalhos();
  redesenhar();
  redesenharAmigos();
  desenharConversa();
}

function fecharVistaAmigos() {
  estado.vistaAmigos = false;
  desenharAtalhos();
  redesenhar();
  desenharConversa();
}

function abrirConversaPrivada(amigoId) {
  if (!estado.conta || !amigoId) return;
  estado.canalTexto = null;
  estado.conversaPrivada = amigoId;

  if (!estado.mensagens.has(amigoId)) {
    social.enviar({ tipo: "historico-privado", token: estado.token, com: amigoId });
  }

  if (!estado.vistaAmigos) abrirVistaAmigos();
  else {
    redesenharAmigos();
    desenharConversa();
  }
  $("campo-mensagem").focus();
}

function redesenharAmigos() {
  const semConta = $("amigos-sem-conta");
  const painel = $("vista-amigos");
  if (!estado.conta) {
    semConta.classList.remove("oculto");
    painel.classList.add("oculto");
    return;
  }
  semConta.classList.add("oculto");
  painel.classList.remove("oculto");

  const pedidos = $("pedidos-amigo");
  pedidos.textContent = "";
  for (const pedido of estado.pedidosAmigo) pedidos.append(linhaDePedidoDeAmizade(pedido));
  pedidos.hidden = estado.pedidosAmigo.length === 0;

  const lista = $("lista-amigos");
  lista.textContent = "";
  for (const amigo of estado.amigos) lista.append(linhaDeAmigo(amigo));

  $("amigos-vazio").classList.toggle("oculto", estado.amigos.length > 0 || estado.pedidosAmigo.length > 0);
}

function linhaDePedidoDeAmizade(pedido) {
  const linha = document.createElement("div");
  linha.className = "amigo-pedido";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  pintarAvatar(avatar, pedido);

  const nome = document.createElement("span");
  nome.className = "amigo-pedido__nome";
  nome.textContent = pedido.apelido;
  nome.title = pedido.apelido;

  const aceitar = document.createElement("button");
  aceitar.type = "button";
  aceitar.className = "botao botao--sutil";
  aceitar.textContent = "Aceitar";
  aceitar.addEventListener("click", () => responderAmizade(pedido.de, true));

  const recusar = botaoDeIcone("Recusar", '<path d="M6 6l8 8M14 6l-8 8"/>');
  recusar.addEventListener("click", () => responderAmizade(pedido.de, false));

  linha.append(avatar, nome, aceitar, recusar);
  return linha;
}

function linhaDeAmigo(amigo) {
  const linha = document.createElement("button");
  linha.type = "button";
  linha.className = "amigo-linha";
  linha.classList.toggle("amigo-linha--ativa", amigo.id === estado.conversaPrivada);

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  pintarAvatar(avatar, amigo);

  const nome = document.createElement("span");
  nome.className = "amigo-linha__nome";
  nome.textContent = amigo.apelido;

  linha.append(avatar, nome);
  linha.addEventListener("click", () => abrirConversaPrivada(amigo.id));
  return linha;
}

function aoListaDeAmigos({ amigos, pedidos }) {
  estado.amigos = amigos;
  estado.pedidosAmigo = pedidos;
  redesenharAmigos();
  // O ponto de pedido pendente fica no botão fixo, fora do que
  // `redesenharAmigos` cuida — só `desenharAtalhos` sabe atualizá-lo.
  desenharAtalhos();
}

function aoPedidoDeAmizade({ de }) {
  avisar(`${de.apelido} quer ser seu amigo.`);
  pedirListaDeAmigos();
}

function aoMensagemPrivada({ mensagem, para }) {
  // `autor` é sempre quem escreveu; a outra ponta da conversa é `para`
  // quando o eco é da própria mensagem, e o próprio `autor` quando é o
  // amigo quem escreveu.
  const outraParte = mensagem.autor === estado.usuario ? para : mensagem.autor;
  estado.mensagens.get(outraParte)?.push(mensagem);

  if (outraParte === estado.conversaPrivada) {
    desenharConversa();
  } else if (mensagem.autor !== estado.usuario) {
    avisar(`${mensagem.apelido} mandou uma mensagem.`);
  }
}

function aoMensagemPrivadaAtualizada({ mensagem, para }) {
  const outraParte = mensagem.autor === estado.usuario ? para : mensagem.autor;
  const lista = estado.mensagens.get(outraParte);
  const indice = lista?.findIndex((item) => item.id === mensagem.id) ?? -1;
  if (indice >= 0) lista[indice] = mensagem;
  if (outraParte === estado.conversaPrivada) desenharConversa();
}

function aoReacaoPrivada({ de, para, mensagem, reacoes }) {
  const outraParte = de === estado.usuario ? para : de;
  const lista = estado.mensagens.get(outraParte);
  const alvo = lista?.find((item) => item.id === mensagem);
  if (alvo) alvo.reacoes = reacoes;
  if (outraParte !== estado.conversaPrivada) return;
  const linha = document.querySelector(`[data-mensagem-id="${CSS.escape(mensagem)}"]`);
  if (linha) desenharReacoes(linha, mensagem, reacoes);
}

function aoHistoricoPrivado({ com, mensagens }) {
  estado.mensagens.set(com, mensagens);
  if (com === estado.conversaPrivada) desenharConversa();
}

/* ═══ Voz ═══════════════════════════════════════════════════════ */

// Contra quem fica entrando e saindo da voz só para incomodar o grupo: mais
// de `LIMITE_TENTATIVAS_VOZ` entradas em `JANELA_TENTATIVAS_VOZ` e a próxima
// tentativa é recusada — não pelo servidor, aqui mesmo, antes de abrir o
// microfone ou mandar qualquer coisa pela rede — por `BLOQUEIO_TENTATIVAS_VOZ`.
// Relógio de parede, e não o do `AudioContext`: essa contagem tem que
// sobreviver ao motor de áudio fechando e reabrindo a cada ciclo.
const JANELA_TENTATIVAS_VOZ = 10_000;
const LIMITE_TENTATIVAS_VOZ = 5;
const BLOQUEIO_TENTATIVAS_VOZ = 10_000;

let tentativasVoz = 0;
let inicioJanelaVoz = -Infinity;
let bloqueadaVozAte = 0;
let intervaloBloqueioVoz = null;

/** O aviso comum (`avisar`) mora no canto e é para quem quer ler — este é
 *  para quem não teve escolha. Fica parado no centro, no topo, contando os
 *  segundos que faltam, e some sozinho quando o bloqueio acaba. */
function mostrarBloqueioDeVoz(ate) {
  const caixa = $("aviso-central");
  clearInterval(intervaloBloqueioVoz);

  const atualizar = () => {
    const restante = Math.ceil((ate - Date.now()) / 1000);
    if (restante <= 0) {
      caixa.classList.remove("aviso-central--visivel");
      clearInterval(intervaloBloqueioVoz);
      return;
    }
    caixa.textContent = `O sino já tocou o bastante por agora. Mais ${restante}s de silêncio.`;
  };

  atualizar();
  caixa.classList.add("aviso-central--visivel");
  intervaloBloqueioVoz = setInterval(atualizar, 250);
}

async function entrarNaVoz(canal) {
  if (estado.canalVoz === canal || estado.ocupado) return;

  const agora = Date.now();
  if (agora < bloqueadaVozAte) {
    mostrarBloqueioDeVoz(bloqueadaVozAte);
    return;
  }

  if (agora - inicioJanelaVoz > JANELA_TENTATIVAS_VOZ) {
    inicioJanelaVoz = agora;
    tentativasVoz = 0;
  }
  tentativasVoz++;
  if (tentativasVoz > LIMITE_TENTATIVAS_VOZ) {
    bloqueadaVozAte = agora + BLOQUEIO_TENTATIVAS_VOZ;
    mostrarBloqueioDeVoz(bloqueadaVozAte);
    return;
  }

  estado.ocupado = true;

  try {
    // O microfone é pedido ao entrar na voz, e não ao entrar no grupo: ler o
    // histórico de um canal de texto não é motivo para abrir o microfone.
    await pedirMicrofone();
    sinal.enviar({ tipo: "entrar-voz", canal, transportes: ["livekit", "malha"] });
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  } finally {
    estado.ocupado = false;
  }
}

/** Resposta do servidor a `entrar-voz`: quem já está na sala. */
async function aoEntrarNaVoz({ canal, pares, midia }) {
  // O microfone é pedido antes de anunciar a entrada, mas entre uma coisa e
  // outra a pessoa pode ter desistido. Entrar sem trilha deixaria todo mundo
  // conectado a alguém permanentemente mudo.
  if (!estado.fluxoMicrofone) {
    sinal.enviar({ tipo: "sair-voz" });
    return;
  }

  // Trocar de canal desfaz os elos, mas não devolve o microfone: pedi-lo de
  // novo reabriria o dispositivo — e, em alguns sistemas, o diálogo de
  // permissão — no meio de uma troca que deveria ser instantânea.
  if (estado.canalVoz && estado.canalVoz !== canal) await desmontarMalha(false);
  estado.canalVoz = canal;

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.canalVoz = canal;

  const [trilha] = estado.fluxoMicrofone.getAudioTracks();
  provedorDeMidia = midia?.provedor === "livekit" ? "livekit" : "malha";
  midiaAtual().definirAudioLocal(trilha, estado.fluxoMicrofone);

  // Os participantes precisam existir antes do connect: as trilhas de quem já
  // está na sala podem chegar enquanto a promessa de conexão ainda resolve.
  for (const par of pares) {
    estado.membros.set(par.id, { ...estado.membros.get(par.id), ...par });
  }

  if (provedorDeMidia === "livekit") {
    try {
      await livekit.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga });
      await livekit.definirPerfilTela(acharPerfilDeTela(estado.perfilTela));
      await livekit.entrar(midia);
    } catch (erro) {
      console.error("[livekit] conexão falhou", erro);
      sinal.enviar({ tipo: "sair-voz" });
      await desmontarMalha();
      estado.canalVoz = null;
      if (eu) eu.canalVoz = null;
      atualizarRodapeDeVoz();
      redesenhar();
      avisar("Não foi possível entrar na infraestrutura de mídia.", "erro");
      return;
    }
  }
  observarVozLocal();

  // Trocar de canal é entrar em outra call: o tempo e o histórico recomeçam.
  comecarCall();

  // Quem já estava na sala: eu ofereço a conexão. Quem chegar depois oferece
  // para mim — assim nunca há dois lados ofertando ao mesmo tempo.
  for (const par of pares) {
    if (provedorDeMidia === "malha") malha.abrir(par.id, true);
    // `false`: estas pessoas já estavam aqui, e o servidor não diz desde
    // quando. O tempo delas só pode ser contado a partir de agora.
    historicoDaCall.entrou(par.id, false);
  }

  motor.tocarAviso("entrei");
  // Sem esperar: um som de entrada que falha em baixar não pode atrasar a
  // entrada na call, e o sino sintetizado já deu a confirmação de que
  // funcionou.
  tocarSomDeEntradaPersonalizado();
  atualizarRodapeDeVoz();
  redesenhar();
  anunciarEstado();
}

function aoParPorVoz({ membro, canal }) {
  estado.membros.set(membro.id, { ...estado.membros.get(membro.id), ...membro });
  if (canal === estado.canalVoz && membro.id !== estado.meuId) {
    if (provedorDeMidia === "malha") malha.abrir(membro.id, false);
    motor.tocarAviso("entrou");
    // Esta chegada eu vi acontecer, então o tempo dela é exato.
    historicoDaCall.entrou(membro.id, true);
  }
  redesenhar();
}

function aoParDeixarVoz({ id, canal }) {
  const membro = estado.membros.get(id);
  if (membro) membro.canalVoz = null;
  if (canal === estado.canalVoz) {
    // Antes de derrubar: é de `estado.membros` que saem o apelido e o
    // identificador estável com que a pessoa entra no histórico.
    if (membro) historicoDaCall.saiu(id, membro);
    derrubarPar(id);
    motor.tocarAviso("saiu");
  }
  redesenhar();
}

/** Desfaz tudo que existe por causa de um par: elo, áudio, tela e medidor. */
function derrubarPar(id) {
  malha.fechar(id);
  removerTela(id);
  esquecerVoz(id);
  motor.desligarSaida(id);
  motor.desligarSaida(`tela:${id}`);
  fluxosDeVoz.delete(id);

  const audio = audiosRemotos.get(id);
  if (audio) {
    // Zerar a fonte antes de descartar o elemento: um <audio> solto com fluxo
    // atribuído continua decodificando o que ainda chegar por ele.
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    audiosRemotos.delete(id);
  }
}

/* ═══ Soundboard ════════════════════════════════════════════════
 *
 * Sons do grupo vivem no servidor por metadado só — os bytes chegam sob
 * demanda, na primeira vez que alguém pede para tocar (`pedirBytesDoSom`), e
 * ficam em cache dentro do próprio `motor` depois disso (ver `tocarClipe`
 * em audio.js). Tocar não é "mandar áudio para o servidor repassar": é
 * decodificar aqui e misturar no grafo que já alimenta o WebRTC — quem ouve,
 * ouve pela chamada de verdade, e o servidor nunca vê um byte de áudio além
 * do que guarda em disco.
 */

/** Teto de um clipe, em bytes — o mesmo que o servidor aplica. Checar aqui
 *  também evita gastar a viagem de ida e volta com um arquivo óbvio demais. */
const SOM_BYTES_MAX = 300 * 1024;

/** id do som -> lista de resolvedores esperando os bytes dele. Mais de um
 *  pedido para o mesmo som enquanto o primeiro ainda não voltou compartilha
 *  a mesma resposta, em vez de pedir duas vezes. */
const pedidosDeSom = new Map();

function aoReceberBytesDeSom({ id, dados }) {
  const fila = pedidosDeSom.get(id);
  if (!fila) return;
  pedidosDeSom.delete(id);
  const bytes = decodificarBase64(dados);
  for (const resolver of fila) resolver(bytes);
}

/** Busca os bytes de um som do grupo atual. `null` quando o servidor nunca
 *  respondeu — um id inválido não gera resposta nenhuma, então o teto de
 *  tempo é o que evita esperar para sempre. */
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

async function tocarSomDoGrupo(som) {
  if (!estado.canalVoz) return;
  const bytes = await pedirBytesDoSom(som.id);
  if (!bytes) {
    avisar("Não foi possível buscar esse som agora.", "erro");
    return;
  }
  const tocou = await motor.tocarClipe(bytes, som.id);
  if (tocou) sinal.enviar({ tipo: "som-tocado", id: som.id });
  else avisar("Esse som não pôde ser tocado — talvez seja longo ou esteja corrompido.", "erro");
}

function removerSomDoGrupo(som) {
  sinal.enviar({ tipo: "remover-som", id: som.id });
}

async function adicionarSomAoGrupo(arquivo) {
  if (!arquivo) return;
  if (arquivo.size > SOM_BYTES_MAX) {
    avisar("Esse som passa de 300 KB.", "erro");
    return;
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const nome = arquivo.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Som";
  sinal.enviar({
    tipo: "adicionar-som",
    nome,
    mime: arquivo.type || "application/octet-stream",
    dados: codificarBase64(bytes),
  });
}

function desenharSoundboard() {
  const lista = $("soundboard-lista");
  const vazio = $("soundboard-vazio");
  if (!lista) return;
  lista.innerHTML = "";
  vazio.classList.toggle("oculto", estado.sons.length > 0);

  for (const som of estado.sons) {
    const item = document.createElement("li");
    item.className = "soundboard__item";

    const nome = document.createElement("span");
    nome.className = "soundboard__nome";
    nome.textContent = som.nome;
    nome.title = som.nome;

    const tocar = document.createElement("button");
    tocar.className = "soundboard__tocar";
    tocar.type = "button";
    tocar.title = "Tocar";
    tocar.setAttribute("aria-label", `Tocar ${som.nome}`);
    tocar.textContent = "▶";
    tocar.addEventListener("click", () => tocarSomDoGrupo(som));

    item.append(nome, tocar);

    // Quem enviou o som, ou o dono do grupo, pode removê-lo — o mesmo par
    // que o servidor confere antes de aceitar o pedido.
    if (som.dono === estado.usuario || estado.grupo?.dono === estado.usuario) {
      const remover = document.createElement("button");
      remover.className = "soundboard__remover";
      remover.type = "button";
      remover.title = "Remover";
      remover.setAttribute("aria-label", `Remover ${som.nome}`);
      remover.textContent = "✕";
      remover.addEventListener("click", () => removerSomDoGrupo(som));
      item.append(remover);
    }

    lista.append(item);
  }
}

function fecharSoundboard() {
  $("soundboard-popover")?.classList.add("oculto");
  document.removeEventListener("click", aoCliqueForaDoSoundboard);
}

function aoCliqueForaDoSoundboard(evento) {
  const popover = $("soundboard-popover");
  if (!popover || popover.contains(evento.target) || evento.target.closest("#botao-soundboard")) return;
  fecharSoundboard();
}

function alternarSoundboard() {
  const popover = $("soundboard-popover");
  if (!popover) return;
  if (popover.classList.contains("oculto")) {
    popover.classList.remove("oculto");
    // Um `setTimeout(0)` para não fechar com o próprio clique que abriu.
    setTimeout(() => document.addEventListener("click", aoCliqueForaDoSoundboard), 0);
  } else {
    fecharSoundboard();
  }
}

/* ── Som de entrada pessoal ────────────────────────────────────── */

/**
 * Toca, para o grupo, o clipe escolhido como som de entrada — no lugar (ou
 * melhor, além) do sino sintetizado que só quem entrou ouve de si mesmo.
 * `estado.conta.somEntrada` é `{ origem, grupo, id }` ou ausente.
 *
 * Um som "de grupo" só vale dentro do próprio grupo: o clipe mora na pasta
 * daquele grupo, e não existe em nenhum outro — entrar num grupo diferente
 * cai de volta para o sino, em silêncio, sem erro nenhum.
 */
async function tocarSomDeEntradaPersonalizado(preferencia) {
  // Sem argumento vale o som gravado na conta — é o caso de entrar num canal.
  // Com argumento vale o que foi passado, que é como a prévia do seletor ouve
  // um som antes de ele ser a escolha de ninguém.
  const pref = preferencia !== undefined ? preferencia : estado.conta?.somEntrada;
  if (!pref) return;

  try {
    let bytes = null;
    if (pref.origem === "grupo" && pref.grupo === estado.grupo?.codigo) {
      bytes = await pedirBytesDoSom(pref.id);
    } else if (pref.origem === "pessoal" && estado.token) {
      const resposta = await conta.pedirSomPessoal(estado.servidor, estado.token, pref.id);
      bytes = decodificarBase64(resposta.dados);
    }
    if (bytes) await motor.tocarClipe(bytes, `entrada:${pref.origem}:${pref.id}`);
  } catch {
    // Som de entrada é um extra sobre o sino, não um requisito: falhar aqui
    // não deveria virar erro na cara de ninguém.
  }
}

function preencherSeletorSomEntrada() {
  const select = $("ajuste-som-entrada");
  if (!select) return;
  const atual = estado.conta?.somEntrada ?? null;
  select.innerHTML = "";

  const padrao = document.createElement("option");
  padrao.value = "";
  padrao.textContent = "Sino padrão";
  select.append(padrao);

  if (estado.grupo && estado.sons.length) {
    const grupo = document.createElement("optgroup");
    grupo.label = `Sons deste grupo (${estado.grupo.nome})`;
    for (const som of estado.sons) {
      const opcao = document.createElement("option");
      opcao.value = JSON.stringify({ origem: "grupo", grupo: estado.grupo.codigo, id: som.id });
      opcao.textContent = som.nome;
      grupo.append(opcao);
    }
    select.append(grupo);
  }

  if (estado.sonsPessoais.length) {
    const pessoal = document.createElement("optgroup");
    pessoal.label = "Minha biblioteca pessoal";
    for (const som of estado.sonsPessoais) {
      const opcao = document.createElement("option");
      opcao.value = JSON.stringify({ origem: "pessoal", id: som.id });
      opcao.textContent = som.nome;
      pessoal.append(opcao);
    }
    select.append(pessoal);
  }

  select.value = atual ? JSON.stringify(atual) : "";
  // Uma preferência gravada que não bate com opção nenhuma (som apagado, ou
  // som de outro grupo) fica sem seleção visível — o valor real continua "o
  // sino", e é isso que `select.value` cai para quando nada casa.
  select.disabled = !estado.conta;
}

/**
 * Toca na hora o som que acabou de ser escolhido no seletor. É a mesma regra
 * que ligar os sons de aviso já seguia — a descrição escrita não substitui
 * ouvir —, agora aplicada onde a lista pode ter dezenas de nomes que não
 * dizem nada sozinhos.
 *
 * O sino padrão é a exceção: não existe clipe para ele, é sintetizado, e quem
 * sabe tocá-lo é o motor.
 */
function ouvirPreviaDoSomDeEntrada(valor) {
  if (!valor) {
    motor.ouvirAviso("entrei");
    return;
  }
  try {
    tocarSomDeEntradaPersonalizado(JSON.parse(valor));
  } catch {
    // Valor ilegível não vira erro na cara de ninguém: a gravação que vem
    // logo em seguida já devolve o seletor ao estado real.
  }
}

async function aoEscolherSomDeEntrada(valor) {
  if (!estado.conta) {
    avisar("Entre numa conta para guardar essa escolha.", "erro");
    preencherSeletorSomEntrada();
    return;
  }
  const preferencia = valor ? JSON.parse(valor) : null;
  try {
    const contaAtualizada = await conta.escolherSomEntrada(estado.servidor, estado.token, preferencia);
    if (contaAtualizada) estado.conta = contaAtualizada;
    avisar("Som de entrada atualizado.", "bom");
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
    preencherSeletorSomEntrada();
  }
}

function desenharSonsPessoais() {
  const lista = $("sons-pessoais-lista");
  const dica = $("sons-pessoais-dica");
  const botaoAdicionar = $("sons-pessoais-adicionar");
  if (!lista) return;
  lista.innerHTML = "";

  if (!estado.conta) {
    dica.textContent = "Entre numa conta para usar sua biblioteca.";
    dica.classList.remove("oculto");
    botaoAdicionar.classList.add("oculto");
    // Sem conta não há som nenhum a listar — a caixa vazia com borda não
    // diria nada que a dica acima já não tenha dito.
    lista.classList.add("oculto");
    return;
  }

  lista.classList.toggle("oculto", estado.sonsPessoais.length === 0);
  dica.classList.toggle("oculto", estado.sonsPessoais.length > 0);
  if (dica.classList.contains("oculto") === false) {
    dica.textContent = "Nenhum som pessoal ainda.";
  }
  botaoAdicionar.classList.toggle("oculto", estado.sonsPessoais.length >= 3);

  for (const som of estado.sonsPessoais) {
    const item = document.createElement("li");
    item.className = "soundboard__item";

    const nome = document.createElement("span");
    nome.className = "soundboard__nome";
    nome.textContent = som.nome;
    nome.title = som.nome;

    const remover = document.createElement("button");
    remover.className = "soundboard__remover";
    remover.type = "button";
    remover.title = "Remover";
    remover.setAttribute("aria-label", `Remover ${som.nome}`);
    remover.textContent = "✕";
    remover.addEventListener("click", async () => {
      try {
        await conta.removerSomPessoal(estado.servidor, estado.token, som.id);
        estado.sonsPessoais = estado.sonsPessoais.filter((s) => s.id !== som.id);
        desenharSonsPessoais();
        preencherSeletorSomEntrada();
      } catch (erro) {
        avisar(erro.message ?? String(erro), "erro");
      }
    });

    item.append(nome, remover);
    lista.append(item);
  }
}

async function adicionarSomPessoalArquivo(arquivo) {
  if (!arquivo || !estado.conta) return;
  if (arquivo.size > SOM_BYTES_MAX) {
    avisar("Esse som passa de 300 KB.", "erro");
    return;
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const nome = arquivo.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Som";
  try {
    const resposta = await conta.adicionarSomPessoal(
      estado.servidor,
      estado.token,
      nome,
      arquivo.type || "application/octet-stream",
      codificarBase64(bytes)
    );
    estado.sonsPessoais.push(resposta.som);
    desenharSonsPessoais();
    preencherSeletorSomEntrada();
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  }
}

/** Chamado ao abrir a aba "Sons" dos ajustes — a biblioteca pessoal só é
 *  buscada aqui, e não toda vez que a conta muda, porque é uma tela que a
 *  maioria das sessões nunca abre. */
async function abrirAbaSons() {
  preencherSeletorSomEntrada();
  if (!estado.conta) {
    desenharSonsPessoais();
    return;
  }
  estado.sonsPessoais = await conta.listarSonsPessoais(estado.servidor, estado.token);
  desenharSonsPessoais();
  preencherSeletorSomEntrada();
}

/* ── Tempo em call ─────────────────────────────────────────────── */

/**
 * Começa a contar. O relógio é de um segundo e existe só enquanto há call:
 * um `setInterval` permanente para atualizar um rótulo que ninguém está
 * vendo é trabalho por nada, 86 400 vezes por dia.
 */
function comecarCall() {
  historicoDaCall.comecar();
  inicioDaCall = Date.now();
  relogioDaCall ??= setInterval(mostrarTempoDaCall, 1000);
  mostrarTempoDaCall();
}

function encerrarCall() {
  clearInterval(relogioDaCall);
  relogioDaCall = null;
  inicioDaCall = 0;
  historicoDaCall.comecar();
}

function mostrarTempoDaCall() {
  if (inicioDaCall) $("tempo-voz").textContent = relogio(Date.now() - inicioDaCall);
}

function sairDaVoz(anunciar) {
  if (!estado.canalVoz) return;
  if (anunciar) sinal.enviar({ tipo: "sair-voz" });
  fecharSoundboard();

  // Antes de desmontar: é `desmontarMalha` que fecha o contexto de áudio, e o
  // motor só espera pela cauda de um aviso que já esteja agendado.
  motor.tocarAviso("sai");
  encerrarCall();
  desmontarMalha();
  estado.canalVoz = null;

  const eu = estado.membros.get(estado.meuId);
  if (eu) {
    eu.canalVoz = null;
    eu.mudo = false;
    eu.transmitindo = false;
  }

  atualizarRodapeDeVoz();
  redesenhar();
}

/** `soltarMicrofone` só é falso ao trocar de canal, quando a trilha local
 *  segue valendo para os elos que vêm a seguir. */
function desmontarMalha(soltarMicrofone = true) {
  pararTransmissao();
  malha.fecharTudo();
  const fechamentoLiveKit = livekit.fecharTudo();
  provedorDeMidia = "malha";

  pararIndicadorLocal?.();
  pararIndicadorLocal = null;

  for (const id of [...audiosRemotos.keys()]) derrubarPar(id);
  for (const id of [...medidores.keys()]) esquecerVoz(id);
  for (const id of [...falas.keys()]) marcarFala(id, false);
  for (const id of [...telas.keys()]) removerTela(id);

  if (!soltarMicrofone) return fechamentoLiveKit;

  motor.soltarMicrofone();
  estado.fluxoMicrofone = null;
  estado.mudo = false;

  // O contexto só é fechado se o painel de ajustes não estiver medindo: fechá-lo
  // no meio de um teste de microfone mataria o medidor que a pessoa está olhando.
  if (!$("ajustes")?.classList.contains("oculto")) return fechamentoLiveKit;
  motor.encerrar().catch(() => {});
  return fechamentoLiveKit;
}

async function pedirMicrofone() {
  if (estado.fluxoMicrofone) return estado.fluxoMicrofone;
  try {
    await motor.aplicar(estado.audio);
    // O que segue para os pares é a saída tratada, não a do dispositivo: a
    // passa-alta e a porta de ruído já agiram quando o WebRTC recebe a trilha.
    estado.fluxoMicrofone = await motor.abrirMicrofone();
    await Promise.all([
      malha.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
      livekit.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
    ]);
    return estado.fluxoMicrofone;
  } catch (erro) {
    console.error("[audio] captura falhou", erro);
    throw new Error("Não foi possível acessar o microfone. Verifique as permissões.");
  }
}

function atualizarRodapeDeVoz() {
  const dentro = Boolean(estado.canalVoz);
  $("rodape-voz").classList.toggle("oculto", !dentro);
  if (dentro) {
    $("nome-canal-voz").textContent = acharCanal(estado.canalVoz)?.nome ?? "—";
  }
  atualizarBotaoMicrofone();
  atualizarBotaoTransmissao();
}

function anunciarEstado() {
  sinal.enviar({
    tipo: "estado",
    mudo: estado.mudo,
    transmitindo: estado.transmitindo,
    atividade: estado.minhaAtividade,
    atividadeIcone: estado.minhaAtividadeIcone,
  });
}

/**
 * O ícone de um programa cadastrado a mão, achado pelo nome que já saiu de
 * `nomeVisivel` — que para um cadastro é sempre o nome escolhido por quem
 * cadastrou. Poucos cadastros existem por pessoa, então percorrer o mapa é
 * mais simples que manter um segundo índice só para isto.
 */
function iconeDoNomeAtivo(nome) {
  for (const dados of estado.programasPersonalizados.values()) {
    if (dados.nome === nome) return dados.icone ?? null;
  }
  return null;
}

/** Registra ou atualiza um programa cadastrado a mão, e salva na hora. */
function cadastrarPrograma(exe, nome, icone) {
  estado.programasPersonalizados.set(exe.toLowerCase(), { nome, icone: icone ?? null });
  salvarPreferencias();
  desenharProgramasPersonalizados();
  // O cadastro pode mudar o que está no ar agora mesmo (um nome feio virando
  // bonito, ou um ícone chegando); a próxima leitura da Vigia já aplica, mas
  // não há por que esperar até cinco segundos por isso.
  vigia.olhar();
}

function removerPrograma(exe) {
  estado.programasPersonalizados.delete(exe);
  salvarPreferencias();
  desenharProgramasPersonalizados();
  vigia.olhar();
}

/**
 * Liga ou desliga a observação conforme a preferência e a existência de um
 * grupo. Desligar anuncia a ausência: sem isso, o último aplicativo usado
 * ficaria congelado na tela de todo mundo depois de a pessoa desligar o
 * recurso — que é exatamente o contrário do que ela pediu.
 */
function ajustarVigia() {
  if (estado.grupo && estado.mostrarAtividade) vigia.ligar();
  else vigia.desligar();
}

/**
 * Mostra no painel exatamente o que está sendo dito ao grupo neste momento.
 *
 * Ler a promessa é uma coisa; ver a frase que está no ar é outra. É a
 * diferença entre confiar no texto e conferir.
 */
function mostrarAtividadeAtual() {
  const linha = $("dica-atividade-agora");
  if (!linha) return;
  if (!estado.mostrarAtividade) linha.textContent = "Desativado";
  else if (!estado.grupo) linha.textContent = "Sem grupo";
  else if (estado.minhaAtividade) linha.textContent = estado.minhaAtividade;
  else linha.textContent = "Nenhuma atividade";
}

/* ═══ Cadastro manual de atividade ══════════════════════════════════
 *
 * Para quando o CALL não reconhece um programa, ou reconhece com um nome
 * feio. Não depende de grupo nem de a pessoa ter acabado de usar o
 * programa: ela aponta o `.exe` direto pelo seletor de arquivo — que só
 * precisa do nome do arquivo, nunca do conteúdo dele — dá um nome e um
 * ícone, e dali em diante o CALL reconhece aquele executável sozinho.
 */

/** exe (minúsculas) escolhido no formulário aberto, ou `null` sem escolha. */
let atividadeEmEdicao = null;
/** exe que o formulário tinha ao abrir para editar, ou `null` se é um
 *  cadastro novo — é o que permite saber que a pessoa trocou de executável
 *  no meio da edição, e o cadastro antigo precisa sair. */
let edicaoOriginalExe = null;
/** Ícone escolhido no formulário aberto — pode ser `null` (sem ícone). */
let iconeEmEdicao = null;

/** Nome de exibição de um arquivo, sem a extensão `.exe` — é o que vira a
 *  chave do cadastro, e é dela que a Vigia reconhece o programa depois. */
const exeDeArquivo = (nomeArquivo) => String(nomeArquivo ?? "").replace(/\.exe$/i, "").toLowerCase();

function atualizarExecutavelEscolhido() {
  $("atividade-form-executavel-nome").textContent = atividadeEmEdicao
    ? `${atividadeEmEdicao}.exe`
    : "Nenhum executável escolhido";
}

function atualizarPreviewDeIconeDeAtividade() {
  const img = $("atividade-form-icone-img");
  const vazio = $("atividade-form-icone-vazio");
  img.src = iconeEmEdicao ?? "";
  img.hidden = !iconeEmEdicao;
  vazio.hidden = Boolean(iconeEmEdicao);
}

/** `existente` é `{ exe, nome }` para editar um cadastro já feito, ou
 *  omitido para um cadastro novo, começando sem executável escolhido. */
function abrirFormularioDeAtividade(existente = null) {
  edicaoOriginalExe = existente?.exe ? existente.exe.toLowerCase() : null;
  atividadeEmEdicao = edicaoOriginalExe;
  const dados = edicaoOriginalExe ? estado.programasPersonalizados.get(edicaoOriginalExe) : null;
  iconeEmEdicao = dados?.icone ?? null;

  $("atividade-form-nome").value = dados?.nome ?? existente?.nome ?? "";
  atualizarExecutavelEscolhido();
  atualizarPreviewDeIconeDeAtividade();
  $("atividade-cadastrar-botao").hidden = true;
  $("atividade-form").hidden = false;
  $("atividade-form-nome").focus();
}

function fecharFormularioDeAtividade() {
  atividadeEmEdicao = null;
  edicaoOriginalExe = null;
  iconeEmEdicao = null;
  $("atividade-form").hidden = true;
  $("atividade-form").reset();
  atualizarExecutavelEscolhido();
  atualizarPreviewDeIconeDeAtividade();
  $("atividade-cadastrar-botao").hidden = false;
}

function desenharProgramasPersonalizados() {
  const lista = $("atividade-lista");
  if (!lista) return;
  lista.textContent = "";
  const entradas = [...estado.programasPersonalizados.entries()];
  lista.hidden = entradas.length === 0;

  for (const [exe, dados] of entradas) {
    const item = document.createElement("li");
    item.className = "atividade-item";

    const icone = document.createElement("span");
    icone.className = "atividade-item__icone";
    if (dados.icone) {
      const img = document.createElement("img");
      img.src = dados.icone;
      img.alt = "";
      icone.append(img);
    }

    const nome = document.createElement("span");
    nome.className = "atividade-item__nome";
    nome.textContent = dados.nome;
    nome.title = dados.nome;

    const editar = document.createElement("button");
    editar.type = "button";
    editar.className = "icone atividade-item__acao";
    editar.title = "Editar";
    editar.setAttribute("aria-label", `Editar ${dados.nome}`);
    editar.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.7-3 8-8 2.3 2.3-8 8-3 .7z"/><path d="M11 5.5L14.5 9" /></svg>';
    editar.addEventListener("click", () => abrirFormularioDeAtividade({ exe, nome: dados.nome }));

    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "icone atividade-item__acao";
    remover.title = "Remover";
    remover.setAttribute("aria-label", `Remover ${dados.nome}`);
    remover.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>';
    remover.addEventListener("click", () => removerPrograma(exe));

    item.append(icone, nome, editar, remover);
    lista.append(item);
  }
}

function prepararCadastroDeAtividade() {
  $("atividade-cadastrar-botao").addEventListener("click", () => abrirFormularioDeAtividade());
  $("atividade-form-cancelar").addEventListener("click", fecharFormularioDeAtividade);

  $("atividade-form-executavel-botao").addEventListener("click", () =>
    $("atividade-form-executavel-arquivo").click()
  );
  $("atividade-form-executavel-arquivo").addEventListener("change", (e) => {
    const arquivo = e.target.files?.[0];
    // Zera na hora, como no seletor de foto: sem isto, escolher o mesmo
    // arquivo de novo não dispara `change` de novo.
    e.target.value = "";
    if (!arquivo) return;
    atividadeEmEdicao = exeDeArquivo(arquivo.name);
    atualizarExecutavelEscolhido();
    // Um primeiro palpite de nome, a partir do arquivo — a pessoa é livre
    // para trocar por qualquer coisa mais bonita antes de salvar.
    if (!$("atividade-form-nome").value.trim()) {
      $("atividade-form-nome").value = arquivo.name.replace(/\.exe$/i, "");
    }
  });

  $("atividade-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!atividadeEmEdicao) {
      avisar("Escolha o executável do programa primeiro.");
      return;
    }
    const nome = $("atividade-form-nome").value.trim();
    if (!nome) return;
    // Trocar de executável no meio de uma edição não pode deixar um
    // cadastro órfão para trás, apontando para o nome antigo.
    if (edicaoOriginalExe && edicaoOriginalExe !== atividadeEmEdicao) {
      removerPrograma(edicaoOriginalExe);
    }
    cadastrarPrograma(atividadeEmEdicao, nome, iconeEmEdicao);
    fecharFormularioDeAtividade();
  });

  prepararEscolhaDeFoto(
    $("atividade-form-icone"),
    $("atividade-form-arquivo"),
    (icone) => {
      iconeEmEdicao = icone;
      atualizarPreviewDeIconeDeAtividade();
    },
    (erro) => avisar(erro.message, "erro"),
    lerIconeDeArquivo
  );
}

/* ═══ Microfone ═════════════════════════════════════════════════ */

function alternarMicrofone() {
  if (!estado.fluxoMicrofone) return;
  estado.mudo = !estado.mudo;
  estado.fluxoMicrofone.getAudioTracks().forEach((t) => (t.enabled = !estado.mudo));

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.mudo = estado.mudo;

  atualizarBotaoMicrofone();
  redesenhar();
  anunciarEstado();
}

function atualizarBotaoMicrofone() {
  const botao = $("botao-microfone");
  botao.dataset.mudo = estado.mudo ? "sim" : "nao";
  const rotulo = estado.mudo ? "Microfone mudo — clique para falar" : "Microfone aberto";
  botao.title = rotulo;
  botao.setAttribute("aria-label", rotulo);
}

/* ═══ Transmissão de tela ═══════════════════════════════════════ */

let transmitirDialogoPreparado = false;
/** Verdadeiro quando o diálogo de qualidade foi aberto por cima do seletor de
 *  fontes (pela engrenagem) — fechar um devolve o outro, em vez de fechar
 *  tudo. */
let transmitirVindoDoSeletor = false;

/** A qualidade não pergunta mais nada toda vez que alguém clica em
 *  transmitir: isso morava aqui antes, e virou uma tela a mais no meio do
 *  caminho toda vez. Agora é só configuração — abre pela engrenagem do
 *  seletor, o que for escolhido vale a partir da próxima transmissão, e o
 *  botão de transmitir vai direto ao seletor de fontes. */
function prepararTransmitirDialogo() {
  if (transmitirDialogoPreparado) return;
  transmitirDialogoPreparado = true;

  montarPerfisLive();

  $("transmitir-fechar").addEventListener("click", fecharTransmitirDialogo);
  $("transmitir-confirmar").addEventListener("click", fecharTransmitirDialogo);
  $("transmitir-dialogo").addEventListener("click", (evento) => {
    if (evento.target === $("transmitir-dialogo")) fecharTransmitirDialogo();
  });

  $("transmitir-som").addEventListener("change", (e) => {
    estado.audioDaTela = e.target.checked;
    salvarPreferencias();
  });
}

/** `vindoDoSeletor`: quando true, o seletor de fontes fica em pausa (oculto,
 *  não fechado) enquanto a qualidade está aberta, e volta sozinho ao fechar. */
function abrirTransmitirDialogo(vindoDoSeletor = false) {
  if (!estado.canalVoz) return;
  transmitirVindoDoSeletor = vindoDoSeletor;
  if (vindoDoSeletor) $("seletor-dialogo").classList.add("oculto");
  refletirTransmitirDialogo();
  $("transmitir-dialogo").classList.remove("oculto");
}

function fecharTransmitirDialogo() {
  $("transmitir-dialogo").classList.add("oculto");
  if (transmitirVindoDoSeletor) {
    transmitirVindoDoSeletor = false;
    $("seletor-dialogo").classList.remove("oculto");
  }
}

/** As mesmas barrinhas de sinal, uma a mais acesa por perfil — o índice na
 *  lista já é a ordem de peso, do mais leve ao mais pesado. */
function iconeDeQualidade(indice) {
  let barras = "";
  for (let i = 0; i < PERFIS_TELA.length; i++) {
    const altura = 5 + i * 4;
    barras += `<rect x="${2 + i * 6}" y="${20 - altura}" width="4" height="${altura}" rx="1.2" class="${i <= indice ? "acesa" : ""}"/>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${barras}</svg>`;
}

function montarPerfisLive() {
  const area = $("transmitir-perfis");
  area.textContent = "";
  PERFIS_TELA.forEach((perfil, indice) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "perfil-live";
    botao.dataset.perfil = perfil.id;
    botao.innerHTML = `
      <span class="perfil-live__icone">${iconeDeQualidade(indice)}</span>
      <span class="perfil-live__texto">
        <span class="perfil-live__nome"></span>
        <span class="perfil-live__resumo"></span>
      </span>
      <span class="perfil-live__detalhe"></span>
      <span class="perfil-live__marca" aria-hidden="true"></span>
    `;
    botao.querySelector(".perfil-live__nome").textContent = perfil.nome;
    botao.querySelector(".perfil-live__resumo").textContent = perfil.resumo;
    botao.querySelector(".perfil-live__detalhe").textContent = perfil.detalhe;

    botao.addEventListener("click", async () => {
      estado.perfilTela = perfil.id;
      salvarPreferencias();
      refletirTransmitirDialogo();
      // Já transmitindo: a trilha nativa aceita novas constraints em voo —
      // resolução, FPS, bitrate e política de degradação mudam sem pedir a
      // fonte de novo, então o teto e a política valem na hora.
      if (estado.transmitindo) await aplicarPerfilDeTela(perfil);
    });
    area.append(botao);
  });
}

function refletirTransmitirDialogo() {
  for (const botao of $("transmitir-perfis").children) {
    botao.setAttribute("aria-pressed", botao.dataset.perfil === estado.perfilTela ? "true" : "false");
  }
  $("transmitir-som").checked = estado.audioDaTela;
}

/* ── Captura nativa: MediaStreamTrack direto do WebView2 ── */

let trilhaDeCaptura = null;
let iniciandoCaptura = false;

/** Aplica o perfil na fonte e nos RTCRtpSenders. Assim uma troca durante a
 * transmissão muda resolução, FPS e bitrate sem abrir outro seletor. */
async function aplicarPerfilDeTela(perfil) {
  if (trilhaDeCaptura?.applyConstraints) {
    try {
      await trilhaDeCaptura.applyConstraints(restricoesDoPerfil(perfil));
    } catch (erro) {
      // Alguns drivers recusam uma combinação apesar de aceitarem cada limite
      // separado. O sender ainda recebe bitrate/FPS e mantém a transmissão.
      console.warn("[tela] a fonte não aceitou todos os limites do perfil", erro);
    }
    trilhaDeCaptura.contentHint = perfil.dica;
  }
  await midiaAtual().definirPerfilTela(perfil);
}

/**
 * Caminho rápido: o WebView2 entrega uma MediaStreamTrack nativa diretamente
 * ao WebRTC. Isso elimina a antiga volta RGBA → resize → JPEG → base64 → IPC →
 * decode → canvas em todo quadro e mantém captura/codificação no caminho
 * acelerado do Chromium.
 */
async function iniciarCapturaOtimizada(perfil) {
  if (!estado.canalVoz || estado.transmitindo || iniciandoCaptura) return;
  iniciandoCaptura = true;

  try {
    let fluxo;
    try {
      fluxo = await navigator.mediaDevices.getDisplayMedia({
        video: restricoesDoPerfil(perfil),
        audio: false,
        // Dicas do Chromium atual; versões antigas podem ignorá-las sem impedir
        // a captura.
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
        monitorTypeSurfaces: "include",
      });
    } catch (erro) {
      if (erro?.name !== "NotAllowedError" && erro?.name !== "AbortError") {
        console.error("[tela] captura nativa falhou", erro);
        avisar("Não foi possível capturar essa fonte.", "erro");
      }
      return;
    }

    const [trilha] = fluxo.getVideoTracks();
    if (!trilha || !estado.canalVoz) {
      fluxo.getTracks().forEach((t) => t.stop());
      return;
    }

    trilhaDeCaptura = trilha;
    trilha.onended = () => pararTransmissao();
    await aplicarPerfilDeTela(perfil);

    const trilhaDeAudio = estado.audioDaTela ? await iniciarAudioDaTela() : null;
    if (!estado.canalVoz || trilha.readyState === "ended") {
      pararAudioDaTela();
      fluxo.getTracks().forEach((t) => t.stop());
      trilhaDeCaptura = null;
      return;
    }

    estado.fluxoTela = fluxo;
    try {
      await midiaAtual().publicarTela(trilha, fluxo, trilhaDeAudio);
    } catch (erro) {
      console.error("[tela] publicação falhou", erro);
      pararAudioDaTela();
      fluxo.getTracks().forEach((item) => item.stop());
      estado.fluxoTela = null;
      trilhaDeCaptura = null;
      avisar("Não foi possível publicar a transmissão.", "erro");
      return;
    }
    estado.transmitindo = true;
    mostrarTela(estado.meuId, fluxo, `${estado.apelido} (você)`);

    const eu = estado.membros.get(estado.meuId);
    if (eu) eu.transmitindo = true;

    atualizarBotaoTransmissao();
    redesenhar();
    anunciarEstado();
  } finally {
    iniciandoCaptura = false;
  }
}

function pararTransmissao() {
  if (!estado.transmitindo) return;
  estado.transmitindo = false;
  midiaAtual().retirarTela();
  trilhaDeCaptura = null;
  pararAudioDaTela();
  estado.fluxoTela?.getTracks().forEach((t) => t.stop());
  estado.fluxoTela = null;
  removerTela(estado.meuId);

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.transmitindo = false;

  atualizarBotaoTransmissao();
  redesenhar();
  anunciarEstado();
}

/* ── Áudio do sistema: WASAPI em loopback, reproduzido no Web Audio ──
 *
 * O Rust manda pedaços de 20 ms de PCM de 16 bits; cada pedaço vira um
 * `AudioBuffer` agendado logo depois do anterior — a técnica padrão para
 * tocar áudio contínuo por partes sem estalos entre elas. Se o atraso
 * acumulado passar de meio segundo (rede lenta, pedaço perdido), o cursor
 * pula direto para "agora": preferir som ao vivo, mesmo com uma perda
 * inaudível de continuidade, a ir ficando cada vez mais atrasado. */

let contextoDeAudioDaTela = null;
let destinoDeAudioDaTela = null;
let proximoInicioDeAudio = 0;
let pararDeOuvirAudio = null;
let pararDeOuvirErroAudio = null;

const ATRASO_MAXIMO_DE_AUDIO = 0.5;

function decodificarBase64(base64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/** O inverso de `decodificarBase64` — usado para mandar um clipe do
 *  soundboard. Em blocos de 32 KB: `String.fromCharCode(...bytes)` de uma vez
 *  só estoura a pilha de chamadas em arquivos de dezenas de KB. */
function codificarBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binario = "";
  const bloco = 0x8000;
  for (let i = 0; i < bytes.length; i += bloco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + bloco));
  }
  return btoa(binario);
}

function tocarPedacoDeAudioDaTela(pedaco) {
  if (!contextoDeAudioDaTela) return;

  const bytes = decodificarBase64(pedaco.dados);
  const amostras = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const canais = pedaco.canais;
  const quadros = amostras.length / canais;
  if (quadros <= 0) return;

  const buffer = contextoDeAudioDaTela.createBuffer(canais, quadros, pedaco.taxaDeAmostragem);
  for (let c = 0; c < canais; c++) {
    const canal = buffer.getChannelData(c);
    for (let i = 0; i < quadros; i++) canal[i] = amostras[i * canais + c] / 32768;
  }

  const fonte = contextoDeAudioDaTela.createBufferSource();
  fonte.buffer = buffer;
  fonte.connect(destinoDeAudioDaTela);

  const agora = contextoDeAudioDaTela.currentTime;
  if (proximoInicioDeAudio < agora || proximoInicioDeAudio - agora > ATRASO_MAXIMO_DE_AUDIO) {
    proximoInicioDeAudio = agora;
  }
  fonte.start(proximoInicioDeAudio);
  proximoInicioDeAudio += buffer.duration;
}

/** Devolve a trilha de áudio já pronta para `malha.publicarTela`, ou `null`
 *  se a captura do lado do Rust não conseguir começar (sem áudio dedicado
 *  configurado, por exemplo) — a transmissão de vídeo segue de qualquer
 *  forma, só sem o som do sistema. */
async function iniciarAudioDaTela() {
  contextoDeAudioDaTela = new AudioContext({ sampleRate: 48000 });
  destinoDeAudioDaTela = contextoDeAudioDaTela.createMediaStreamDestination();
  proximoInicioDeAudio = 0;

  pararDeOuvirAudio = await window.__TAURI__.event.listen("audio-tela", (evento) =>
    tocarPedacoDeAudioDaTela(evento.payload)
  );
  pararDeOuvirErroAudio = await window.__TAURI__.event.listen("erro-audio-tela", (evento) => {
    console.warn("[tela] som do sistema indisponível", evento.payload);
    avisar("O vídeo continua, mas o som do sistema não pôde ser capturado.", "neutro");
  });

  try {
    await invocar("iniciar_audio_da_tela");
  } catch {
    pararDeOuvirAudio?.();
    pararDeOuvirAudio = null;
    pararDeOuvirErroAudio?.();
    pararDeOuvirErroAudio = null;
    contextoDeAudioDaTela?.close().catch(() => {});
    contextoDeAudioDaTela = null;
    destinoDeAudioDaTela = null;
    avisar("Não foi possível capturar o som do sistema.", "neutro");
    return null;
  }

  return destinoDeAudioDaTela.stream.getAudioTracks()[0];
}

function pararAudioDaTela() {
  if (!contextoDeAudioDaTela) return;
  invocar("parar_audio_da_tela").catch(() => {});
  pararDeOuvirAudio?.();
  pararDeOuvirAudio = null;
  pararDeOuvirErroAudio?.();
  pararDeOuvirErroAudio = null;
  contextoDeAudioDaTela.close().catch(() => {});
  contextoDeAudioDaTela = null;
  destinoDeAudioDaTela = null;
}

function atualizarBotaoTransmissao() {
  const botao = $("botao-transmitir");
  botao.dataset.ativo = estado.transmitindo ? "sim" : "nao";
  const rotulo = estado.transmitindo ? "Parar a transmissão" : "Transmitir tela";
  botao.title = rotulo;
  botao.setAttribute("aria-label", rotulo);
}

/* ═══ Palco ═════════════════════════════════════════════════════ */

/** Qual transmissão ocupa a tela toda da janela agora — no máximo uma, e só
 *  enquanto o quadro dela ainda existir (ver `atualizarPalco`). */
let telaMaximizada = null;

const GLIFO_EXPANDIR =
  '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>';
const GLIFO_RECOLHER =
  '<path d="M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4"/>';

function mostrarTela(id, fluxo, rotulo, trilhaLiveKit = null) {
  removerTela(id);

  const quadro = document.createElement("div");
  quadro.className = "transmissao";

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  if (trilhaLiveKit) trilhaLiveKit.attach(video);
  else video.srcObject = fluxo;

  const etiqueta = document.createElement("span");
  etiqueta.className = "transmissao__etiqueta";
  etiqueta.textContent = rotulo;

  // Preenchido por `atualizarBadgesDeQualidade` a partir das estatísticas
  // reais do WebRTC — o que está chegando, não o que foi pedido — por isso
  // começa vazio e só aparece quando a primeira leitura chega.
  const qualidade = document.createElement("span");
  qualidade.className = "transmissao__qualidade oculto";

  const expandir = document.createElement("button");
  expandir.type = "button";
  expandir.className = "transmissao__expandir";
  expandir.setAttribute("aria-pressed", "false");
  expandir.title = "Maximizar";
  expandir.setAttribute("aria-label", "Maximizar");
  expandir.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GLIFO_EXPANDIR}</svg>`;
  expandir.addEventListener("click", () => alternarMaximizarTela(id));

  quadro.append(video, etiqueta, qualidade, expandir);
  $("palco-grade").append(quadro);
  telas.set(id, quadro);
  quadro.trilhaLiveKit = trilhaLiveKit;
  atualizarPalco();
}

function removerTela(id) {
  const quadro = telas.get(id);
  if (!quadro) return;
  const video = quadro.querySelector("video");
  if (quadro.trilhaLiveKit) quadro.trilhaLiveKit.detach(video);
  else video.srcObject = null;
  quadro.remove();
  telas.delete(id);
  if (telaMaximizada === id) telaMaximizada = null;
  atualizarPalco();
}

/** Maximizar não move o quadro nem mexe no `<video>` — só empresta a tela
 *  toda da janela pra ele via CSS (`position: fixed`), então o vídeo nunca
 *  recarrega e o áudio que já toca por fora não pisca. */
function alternarMaximizarTela(id) {
  telaMaximizada = telaMaximizada === id ? null : id;
  atualizarPalco();
}

function atualizarPalco() {
  const total = telas.size;
  $("palco-grade").dataset.quantidade = String(total);
  $("palco").classList.toggle("oculto", total === 0);

  for (const [id, quadro] of telas) {
    const maximizada = id === telaMaximizada;
    quadro.classList.toggle("transmissao--cheia", maximizada);
    const expandir = quadro.querySelector(".transmissao__expandir");
    expandir.setAttribute("aria-pressed", maximizada ? "true" : "false");
    expandir.title = maximizada ? "Restaurar" : "Maximizar";
    expandir.setAttribute("aria-label", expandir.title);
    expandir.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${
      maximizada ? GLIFO_RECOLHER : GLIFO_EXPANDIR
    }</svg>`;
  }
}

/** A estatística real de vídeo por trás de um quadro do palco — o que está
 *  de fato chegando (ou saindo, no caso da própria transmissão), e não o
 *  perfil pedido. Uma rede fraca ou uma máquina sobrecarregada entregam
 *  menos do que o perfil promete, e o selo deve mostrar a entrega, não a
 *  promessa. */
async function statsDeQualidade(id) {
  if (provedorDeMidia === "livekit") return livekit.statsDeVideo(id, estado.meuId);
  if (id === estado.meuId) {
    if (!trilhaDeCaptura) return null;
    for (const pc of malha.conexoes.values()) {
      const remetente = pc.getSenders().find((s) => s.track === trilhaDeCaptura);
      if (!remetente) continue;
      const relatorio = await remetente.getStats().catch(() => null);
      if (!relatorio) continue;
      for (const item of relatorio.values()) {
        if (item.type === "outbound-rtp" && item.kind === "video") return item;
      }
    }
    return null;
  }

  const pc = malha.conexoes.get(id);
  if (!pc) return null;
  const relatorio = await pc.getStats().catch(() => null);
  if (!relatorio) return null;
  for (const item of relatorio.values()) {
    if (item.type === "inbound-rtp" && item.kind === "video") return item;
  }
  return null;
}

/** Roda a cada poucos segundos — rápido o bastante para refletir uma queda
 *  de qualidade, devagar o bastante para não ser, ele mesmo, trabalho
 *  supérfluo competindo com a transmissão pela CPU. */
async function atualizarBadgesDeQualidade() {
  for (const [id, quadro] of telas) {
    const selo = quadro.querySelector(".transmissao__qualidade");
    if (!selo) continue;
    const item = await statsDeQualidade(id);
    if (!item?.frameHeight) continue;
    const quadros = Math.round(item.framesPerSecond ?? 0);
    selo.textContent = quadros > 0 ? `${item.frameHeight}p · ${quadros}fps` : `${item.frameHeight}p`;
    selo.classList.remove("oculto");
  }
}

setInterval(() => {
  if (telas.size) atualizarBadgesDeQualidade();
}, 2000);

/* ═══ Mídia recebida ════════════════════════════════════════════ */

/**
 * Qual fluxo carrega a voz de cada par.
 *
 * Uma pessoa transmitindo a tela com som manda duas trilhas de áudio, e tratar
 * as duas igual passaria a trilha sonora de um jogo pelo medidor de fala e pelo
 * volume de voz. O primeiro fluxo de áudio que chega de alguém é sempre o do
 * microfone — a voz entra na malha ao entrar no canal, muito antes de qualquer
 * transmissão —, então o que vier em outro fluxo é som de tela.
 */
const fluxosDeVoz = new Map(); // id do par -> id do MediaStream da voz

function receberTrilha(id, trilha, fluxo, origem = null, trilhaLiveKit = null) {
  if (trilha.kind === "audio") {
    const audioDeTela = origem === "screen_share_audio";
    if (!audioDeTela && !fluxosDeVoz.has(id)) fluxosDeVoz.set(id, fluxo.id);

    if (audioDeTela || fluxosDeVoz.get(id) !== fluxo.id) {
      // Som da transmissão: entra no grafo sem medidor de fala e sem os
      // filtros de voz, no volume que a pessoa tem para quem transmite.
      const membro = estado.membros.get(id);
      motor
        .ligarSaida(`tela:${id}`, fluxo)
        .then((ganho) => {
          if (ganho) ganho.gain.value = estado.volumes.get(membro?.usuario) ?? 1;
        })
        .catch(() => {});
      return;
    }

    // O `<audio>` continua aqui, mudo. Ele não reproduz nada — quem reproduz é
    // o grafo, que é o único jeito de haver volume por pessoa e escolha de
    // dispositivo de saída. Ele existe porque um fluxo remoto que não está
    // preso a nenhum elemento de mídia é tratado pelo Chromium como sem
    // consumidor, e a decodificação pode não ser mantida.
    let audio = audiosRemotos.get(id);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.muted = true;
      audio.style.display = "none";
      document.body.append(audio);
      audiosRemotos.set(id, audio);
    }
    audio.srcObject = fluxo;
    audio.play().catch(() => {});
    ligarAudioRemoto(id, fluxo);
    return;
  }

  const membro = estado.membros.get(id);
  mostrarTela(id, fluxo, membro?.apelido ?? "Participante", trilhaLiveKit);
  if (membro) {
    membro.transmitindo = true;
    redesenhar();
  }
}

/* ═══ Detecção de fala ══════════════════════════════════════════ */

/** Volume que acende a marca e volume, mais baixo, que a apaga. A folga entre
 *  os dois evita a piscada constante nas pausas entre sílabas. */
const LIMIAR_ENTRADA = 0.022;
const LIMIAR_SAIDA = 0.012;
/** Quanto a marca permanece acesa depois do último trecho acima do limiar. */
const PERMANENCIA = 420;

/** Liga a voz de alguém ao grafo e passa a medir a fala do mesmo ponto. */
async function ligarAudioRemoto(id, fluxo) {
  // Uma renegociação reentrega a mesma trilha. Sem soltar o que veio antes,
  // cada rodada deixaria para trás um nó vivo no grafo.
  esquecerVoz(id);
  motor.desligarSaida(id);

  const ganho = await motor.ligarSaida(id, fluxo);
  if (!ganho) return;

  const membro = estado.membros.get(id);
  ganho.gain.value = estado.volumes.get(membro?.usuario) ?? 1;
  // No LiveKit o SFU entrega a lista de falantes ativos. A análise local fica
  // como compatibilidade para servidores antigos que ainda usam malha P2P.
  if (provedorDeMidia === "malha") await observarVoz(id, ganho);
}

/** Usa a mesma decisão da porta de ruído para destacar a própria fala. */
function observarVozLocal() {
  pararIndicadorLocal?.();
  marcarFala(estado.meuId, false);
  pararIndicadorLocal = motor.assinarNivel((dados) => {
    marcarFala(estado.meuId, Boolean(dados.falando) && !estado.mudo);
  });
}

/**
 * Passa a acompanhar a fala em um ponto do grafo. É de propósito que o nó
 * medido seja o da saída tratada, e não o da captura: a marca de "falando"
 * precisa dizer o que os outros ouvem. Se a porta de ruído cortou, ninguém
 * ouviu, e a marca não deve acender.
 */
async function observarVoz(id, no) {
  if (!no) return;
  esquecerVoz(id);

  const contexto = await motor.contexto();
  const analisador = contexto.createAnalyser();
  analisador.fftSize = 512;
  no.connect(analisador);

  medidores.set(id, {
    no,
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
  if (!medidor) {
    marcarFala(id, false);
    return;
  }
  // Desfaz só esta ligação: o nó medido também alimenta a chamada, e um
  // `disconnect()` sem argumento derrubaria o áudio junto com o medidor.
  try {
    medidor.no.disconnect(medidor.analisador);
  } catch {
    /* o nó já podia ter sido descartado */
  }
  medidor.analisador.disconnect();
  medidores.delete(id);
  marcarFala(id, false);

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
      agora < medidor.ateQuando && !(id === estado.meuId && estado.mudo);
    if (falando === medidor.falando) continue;

    medidor.falando = falando;
    marcarFala(id, falando);
  }
}

function marcarFala(id, falando) {
  if (falando) falas.set(id, true);
  else falas.delete(id);
  for (const linha of linhas.get(id) ?? []) {
    linha.dataset.falando = falando ? "sim" : "nao";
  }
}

/* ═══ Ajustes de voz e vídeo ════════════════════════════════════ */

/** Faixa mostrada no medidor. Abaixo de −70 dB não há o que ver, e acima de 0
 *  não há o que medir. */
const MEDIDOR_MIN = -70;
const posicaoNoMedidor = (db) =>
  Math.min(100, Math.max(0, ((db - MEDIDOR_MIN) / -MEDIDOR_MIN) * 100));

let ajustesPreparados = false;
let diagnosticoSemSinal = null;
let maiorNivelNoTeste = -Infinity;

function pararDiagnosticoDoMicrofone() {
  if (diagnosticoSemSinal) clearTimeout(diagnosticoSemSinal);
  diagnosticoSemSinal = null;
  maiorNivelNoTeste = -Infinity;
  $("aviso-microfone-sem-sinal").hidden = true;
}

function iniciarDiagnosticoDoMicrofone() {
  pararDiagnosticoDoMicrofone();
  diagnosticoSemSinal = setTimeout(() => {
    diagnosticoSemSinal = null;
    if (!$("ajuste-retorno-microfone").checked || maiorNivelNoTeste > -75) return;
    const nome = $("ajuste-entrada").selectedOptions[0]?.textContent?.trim() || "microfone escolhido";
    const aviso = $("aviso-microfone-sem-sinal");
    aviso.textContent = `Nenhum sinal chegou de “${nome}”. Confira o botão de mudo, o cabo ou escolha outro microfone.`;
    aviso.hidden = false;
  }, 3000);
}

function prepararAjustes() {
  if (ajustesPreparados) return;
  ajustesPreparados = true;

  $("botao-ajustes").addEventListener("click", abrirAjustes);
  $("ajustes-fechar").addEventListener("click", fecharAjustes);
  $("ajustes").addEventListener("click", (evento) => {
    if (evento.target === $("ajustes")) fecharAjustes();
  });

  for (const aba of document.querySelectorAll(".aba")) {
    aba.addEventListener("click", () => trocarAba(aba.dataset.aba));
  }

  // Cada cartão de ajuste começa fechado (ou aberto, conforme o HTML já
  // decidiu) e só troca de estado quando alguém clica nele — é o mesmo
  // princípio do resto do aplicativo agora: nada aparece sozinho, aparece
  // porque uma ação pediu.
  for (const secao of document.querySelectorAll(".ajustes__secao")) {
    const botao = secao.querySelector(".ajustes__secao-topo");
    botao.addEventListener("click", () => {
      const aberto = secao.dataset.aberto === "sim";
      secao.dataset.aberto = aberto ? "nao" : "sim";
      botao.setAttribute("aria-expanded", String(!aberto));
    });
  }

  // Um deslizante emite `input` a cada pixel arrastado. Aplicar no motor é
  // barato (é só o valor de um parâmetro), mas gravar em disco a cada pixel
  // não é — a gravação sai da mão de quem arrasta e vai para o `change`.
  const deslizante = (id, ler, aoVivo) => {
    const campo = $(id);
    campo.addEventListener("input", () => aoVivo(ler(campo)));
    campo.addEventListener("change", () => aplicarAudio({}, true));
  };

  deslizante("ajuste-ganho", (c) => Number(c.value) / 100, (v) => {
    $("valor-ganho").textContent = `${Math.round(v * 100)}%`;
    aplicarAudio({ ganhoEntrada: v });
  });
  deslizante("ajuste-volume", (c) => Number(c.value) / 100, (v) => {
    $("valor-volume").textContent = `${Math.round(v * 100)}%`;
    aplicarAudio({ volumeGeral: v });
  });
  deslizante("ajuste-limiar", (c) => Number(c.value), (v) => {
    $("valor-limiar").textContent = `${String(v).replace("-", "−")} dB`;
    aplicarAudio({ limiar: v });
  });

  $("ajuste-retorno-microfone").addEventListener("change", async (e) => {
    try {
      if (e.target.checked && !motor.ativo) await motor.abrirMicrofone();
      motor.monitorarEntrada(e.target.checked);
      if (e.target.checked) iniciarDiagnosticoDoMicrofone();
      else pararDiagnosticoDoMicrofone();
    } catch {
      e.target.checked = false;
      motor.monitorarEntrada(false);
      pararDiagnosticoDoMicrofone();
      avisar("Não foi possível iniciar a prévia do microfone.", "erro");
    }
  });

  const chave = (id, campo) =>
    $(id).addEventListener("change", (e) => aplicarAudio({ [campo]: e.target.checked }, true));

  chave("ajuste-porta", "porta");
  chave("ajuste-eco", "cancelarEco");
  chave("ajuste-supressao", "suprimirRuido");
  chave("ajuste-agc", "ganhoAutomatico");
  chave("ajuste-continuo", "bandaLarga");
  chave("ajuste-sons", "sons");

  $("ajuste-porta").addEventListener("change", (e) => {
    $("bloco-limiar").hidden = !e.target.checked;
  });

  // Ligar os sons já toca um: a descrição escrita não substitui ouvir. O
  // mesmo vale ao soltar o controle de volume — é o único jeito de escolher
  // um volume sem estar no meio de uma conversa para conferir.
  $("ajuste-sons").addEventListener("change", (e) => {
    $("bloco-sons").hidden = !e.target.checked;
    if (e.target.checked) motor.ouvirAviso("entrei");
  });

  const controleDeSons = $("ajuste-volume-sons");
  controleDeSons.addEventListener("input", () => {
    const v = Number(controleDeSons.value) / 100;
    $("valor-volume-sons").textContent = `${Math.round(v * 100)}%`;
    aplicarAudio({ volumeSons: v });
  });
  controleDeSons.addEventListener("change", async () => {
    await aplicarAudio({}, true);
    motor.ouvirAviso("entrei");
  });

  for (const [id, campo, selo] of [
    ["ajuste-entrada", "entrada", "selo-entrada"],
    ["ajuste-saida", "saida", "selo-saida"],
  ]) {
    $(id).addEventListener("change", (e) => {
      $(selo).hidden = e.target.value !== "";
      aplicarAudio({ [campo]: e.target.value }, true);
    });
  }

  // O microfone se prova sozinho no medidor logo acima; a saída não tem como
  // se provar sem alguém mandar um som por ela.
  $("testar-saida").addEventListener("click", () => {
    motor.ouvirAviso("entrei");
    const nome = $("ajuste-saida").selectedOptions[0]?.textContent?.trim() || "saída escolhida";
    const dica = $("dica-teste-saida");
    dica.textContent = `Som enviado para “${nome}”. Se não ouviu, escolha outra saída.`;
    dica.hidden = false;
  });

  const escala = $("ajuste-escala-interface");
  escala.addEventListener("input", () => {
    estado.escalaInterface = Number(escala.value) / 100;
    aplicarEscalaDaInterface();
    atualizarRotuloDaEscala();
  });
  escala.addEventListener("change", salvarPreferencias);
  $("ajuste-escala-padrao").addEventListener("click", () => {
    estado.escalaInterface = 1;
    aplicarEscalaDaInterface();
    atualizarRotuloDaEscala();
    salvarPreferencias();
  });

  $("ajuste-brilho-cursor").addEventListener("change", (e) => {
    estado.brilhoCursor = e.target.checked;
    aplicarPreferenciasDoBrilho();
    $("bloco-controles-brilho").hidden = !estado.brilhoCursor;
    salvarPreferencias();
  });

  $("ajuste-cursor-personalizado").addEventListener("change", (e) => {
    estado.cursorPersonalizado = e.target.checked;
    aplicarCursorPersonalizado();
    salvarPreferencias();
  });
  const tamanhoDoBrilho = $("ajuste-tamanho-brilho");
  tamanhoDoBrilho.addEventListener("input", () => {
    estado.tamanhoBrilhoCursor = Number(tamanhoDoBrilho.value);
    aplicarPreferenciasDoBrilho();
    $("valor-tamanho-brilho").textContent = `${estado.tamanhoBrilhoCursor}px`;
  });
  tamanhoDoBrilho.addEventListener("change", salvarPreferencias);
  const intensidadeDoBrilho = $("ajuste-intensidade-brilho");
  intensidadeDoBrilho.addEventListener("input", () => {
    estado.intensidadeBrilhoCursor = Number(intensidadeDoBrilho.value);
    aplicarPreferenciasDoBrilho();
    $("valor-intensidade-brilho").textContent = `${estado.intensidadeBrilhoCursor}%`;
  });
  intensidadeDoBrilho.addEventListener("change", salvarPreferencias);

  $("ajuste-busca-automatica").addEventListener("change", (e) => {
    estado.buscarAtualizacoesAutomaticamente = e.target.checked;
    salvarPreferencias();
    mostrarEstadoDaAtualizacao(
      e.target.checked ? "A busca automática está ativa." : "A busca automática está desativada."
    );
  });
  $("botao-buscar-atualizacao").addEventListener("click", () => procurarAtualizacao({ manual: true }));

  $("botao-aplicar-servidor").addEventListener("click", async () => {
    const servidor = $("campo-servidor").value.trim();
    if (!servidor) return;
    if (!/^wss?:\/\//i.test(servidor)) {
      avisar("O endereço precisa começar com ws:// ou wss://", "erro");
      return;
    }
    if (servidor === estado.servidor) {
      avisar("Este já é o servidor em uso.");
      return;
    }

    // Grupos vivem no servidor onde foram criados. Sair do atual antes de
    // trocar evita ficar com a coluna cheia de atalhos que apontam para um
    // lugar onde eles não existem.
    const codigo = estado.grupo?.codigo;
    desligar();

    // Token e identidade de conta pertencem ao servidor que os emitiu. Levar
    // um token do Railway para o servidor local fazia o backend recusar a
    // conta e sortear outra identidade, enquanto a interface ainda se achava
    // dona do grupo. O resultado era conseguir criar, mas não editar de
    // verdade. Ao trocar de servidor, continuamos como visitante com uma
    // identidade local estável; quem quiser conta entra numa conta desse novo
    // servidor.
    if (estado.token || estado.usuario.startsWith("conta-")) {
      largarIdentidadeDaConta();
    }

    estado.servidor = servidor;
    salvarPreferencias();
    // A conta também é o de lá — amigos e PV de um servidor não existem no
    // outro, então o socket social precisa apontar pro endereço novo, não
    // continuar conversando com o antigo.
    conectarSocial();
    avisar("Servidor trocado.");
    if (codigo) await conectar({ tipo: "entrar", codigo });
  });

  $("ajuste-atividade").addEventListener("change", (e) => {
    estado.mostrarAtividade = e.target.checked;
    salvarPreferencias();
    $("bloco-atividade").hidden = !e.target.checked;
    ajustarVigia();
    mostrarAtividadeAtual();
  });
  prepararCadastroDeAtividade();

  montarBitrates();
  prepararAtalhoMudo();

  // Trocar de fone no meio da conversa não deve exigir reabrir o painel.
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (!$("ajustes").classList.contains("oculto")) desenharDispositivos();
  });
}

/* ── Atalho global de mudo: funciona com a janela sem foco ou escondida na
 *  bandeja, porque não é um `keydown` da página — é registrado no sistema
 *  operacional pelo lado do Rust (ver `definir_atalho_mudo`). ── */

const NOMES_DE_TECLA = {
  Space: "Espaço",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
};

function rotuloDaTecla(codigo) {
  if (NOMES_DE_TECLA[codigo]) return NOMES_DE_TECLA[codigo];
  if (codigo.startsWith("Key")) return codigo.slice(3);
  if (codigo.startsWith("Digit")) return codigo.slice(5);
  return codigo;
}

function desenharAtalho(alvo, atalho) {
  alvo.textContent = "";
  if (!atalho) {
    const vazio = document.createElement("span");
    vazio.className = "atalho-campo__vazio";
    vazio.textContent = "Nenhum — clique para definir";
    alvo.append(vazio);
    return;
  }
  const modificadores = new Set(["Ctrl", "Alt", "Shift", "Super"]);
  atalho.split("+").forEach((parte, indice) => {
    if (indice > 0) {
      const mais = document.createElement("span");
      mais.className = "atalho-campo__mais";
      mais.textContent = "+";
      alvo.append(mais);
    }
    const tecla = document.createElement("span");
    tecla.className = "atalho-tecla";
    tecla.textContent = modificadores.has(parte) ? parte : rotuloDaTecla(parte);
    alvo.append(tecla);
  });
}

/** Registra (ou remove, com `null`) o atalho no lado do Rust e só grava a
 *  preferência se o sistema aceitou — um atalho já usado por outro programa
 *  não deve parecer escolhido quando na prática não vale nada. */
async function aplicarAtalhoMudo(atalho) {
  try {
    await invocar("definir_atalho_mudo", { atalho });
    estado.atalhoMudo = atalho;
    salvarPreferencias();
  } catch (erro) {
    avisar(typeof erro === "string" ? erro : "Não foi possível registrar esse atalho.", "erro");
  }
}

let atalhoMudoPreparado = false;

function prepararAtalhoMudo() {
  if (atalhoMudoPreparado) return;
  atalhoMudoPreparado = true;

  const campo = $("atalho-mudo-campo");
  const teclas = $("atalho-mudo-teclas");
  desenharAtalho(teclas, estado.atalhoMudo);

  let gravando = false;
  let ouvinte = null;

  const pararDeGravar = () => {
    gravando = false;
    campo.dataset.gravando = "nao";
    if (ouvinte) document.removeEventListener("keydown", ouvinte, true);
    desenharAtalho(teclas, estado.atalhoMudo);
  };

  campo.addEventListener("click", () => {
    if (gravando) return;
    gravando = true;
    campo.dataset.gravando = "sim";
    teclas.textContent = "";
    const dica = document.createElement("span");
    dica.className = "atalho-campo__vazio";
    dica.textContent = "Pressione as teclas… (Esc cancela)";
    teclas.append(dica);

    // Captura na fase de captura, e não de bolha: enquanto grava, nenhuma
    // tecla deve chegar a outro atalho da própria interface (Esc fechando o
    // diálogo, por exemplo) antes de passar por aqui.
    ouvinte = async (evento) => {
      evento.preventDefault();
      evento.stopPropagation();

      if (evento.key === "Escape") {
        pararDeGravar();
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(evento.key)) return;

      if (!(evento.ctrlKey || evento.altKey || evento.metaKey)) {
        avisar("O atalho precisa de Ctrl, Alt ou uma tecla Windows, além da tecla escolhida.", "neutro");
        return;
      }

      const partes = [];
      if (evento.ctrlKey) partes.push("Ctrl");
      if (evento.altKey) partes.push("Alt");
      if (evento.shiftKey) partes.push("Shift");
      if (evento.metaKey) partes.push("Super");
      partes.push(evento.code);

      await aplicarAtalhoMudo(partes.join("+"));
      pararDeGravar();
    };

    document.addEventListener("keydown", ouvinte, true);
  });

  $("atalho-mudo-limpar").addEventListener("click", async () => {
    if (gravando) pararDeGravar();
    await aplicarAtalhoMudo(null);
    desenharAtalho(teclas, estado.atalhoMudo);
  });
}

function montarBitrates() {
  const area = $("ajuste-bitrate");
  area.textContent = "";
  for (const opcao of BITRATES_AUDIO) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "opcao";
    botao.title = opcao.detalhe;
    botao.innerHTML = `<span class="opcao__nome"></span><span class="opcao__detalhe"></span>`;
    botao.querySelector(".opcao__nome").textContent = opcao.nome;
    botao.querySelector(".opcao__detalhe").textContent = `${opcao.valor / 1000}k`;
    botao.addEventListener("click", () => {
      aplicarAudio({ bitrate: opcao.valor }, true);
      refletirAjustes();
    });
    area.append(botao);
  }
}

/**
 * Aplica preferências ao motor e, quando pedido, grava.
 *
 * A reabertura do microfone é decidida pelo motor: só o que o `getUserMedia`
 * governa — dispositivo, eco, supressão, ganho automático — obriga a recapturar.
 * Voltar da recaptura exige reentregar a trilha, porque é um destino novo.
 */
async function aplicarAudio(mudancas, gravar = false) {
  Object.assign(estado.audio, mudancas);
  if (gravar) salvarPreferencias();

  try {
    const recapturou = await motor.aplicar(estado.audio);
    if (recapturou && estado.canalVoz) {
      estado.fluxoMicrofone = motor.fluxo;
      const [trilha] = estado.fluxoMicrofone.getAudioTracks();
      trilha.enabled = !estado.mudo;
      malha.definirAudioLocal(trilha, estado.fluxoMicrofone);
      livekit.definirAudioLocal(trilha, estado.fluxoMicrofone);
      observarVozLocal();
    }
    if ("bitrate" in mudancas || "bandaLarga" in mudancas) {
      await Promise.all([
        malha.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
        livekit.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga }),
      ]);
    }
  } catch (erro) {
    console.error("[audio] ajuste recusado", erro);
    avisar("Não foi possível aplicar o ajuste de áudio.", "erro");
  }
}

async function abrirAjustes() {
  prepararAjustes();
  $("ajustes").classList.remove("oculto");
  trocarAba("voz");
  refletirAjustes();

  // O microfone é aberto para o teste mesmo fora de um canal de voz: ajustar a
  // porta de ruído sem ouvir o próprio nível seria adivinhação.
  try {
    if (!estado.fluxoMicrofone) await motor.abrirMicrofone();
    await observarNivel();
  } catch {
    $("medidor-estado").textContent = "microfone indisponível";
  }

  // Os rótulos dos dispositivos só existem depois de uma permissão concedida —
  // por isso a lista é montada depois de abrir o microfone, e não antes.
  await desenharDispositivos();
}

function fecharAjustes() {
  $("ajustes").classList.add("oculto");
  motor.medir(null);
  motor.monitorarEntrada(false);
  pararDiagnosticoDoMicrofone();
  $("ajuste-retorno-microfone").checked = false;

  // Fora de um canal de voz, o microfone aberto era só para o teste.
  if (!estado.canalVoz) {
    motor.soltarMicrofone();
    estado.fluxoMicrofone = null;
    motor.encerrar().catch(() => {});
  }
}

function trocarAba(nome) {
  for (const aba of document.querySelectorAll(".aba")) {
    aba.setAttribute("aria-selected", aba.dataset.aba === nome ? "true" : "false");
  }
  for (const painel of document.querySelectorAll(".ajustes__painel")) {
    painel.hidden = painel.dataset.painel !== nome;
  }
  // A biblioteca pessoal é buscada só quando a aba abre: é tela que a maioria
  // das sessões nunca visita, e não vale pedir em toda entrada de grupo.
  if (nome === "sons") abrirAbaSons();
}

/** Aplica a mesma escala ao layout inteiro. `zoom` no elemento raiz é
 * intencional: ao contrário de aumentar só a fonte, ele amplia alvos de clique,
 * ícones e espaçamentos, e faz o aplicativo se reorganizar no espaço disponível. */
function aplicarEscalaDaInterface() {
  document.documentElement.style.zoom = String(estado.escalaInterface);
}

function atualizarRotuloDaEscala() {
  const porcentagem = Math.round(estado.escalaInterface * 100);
  $("ajuste-escala-interface").value = String(porcentagem);
  $("valor-escala-interface").textContent = `${porcentagem}%`;
  $("ajuste-escala-padrao").hidden = porcentagem === 100;
}

function atualizarAjustesDaInterface() {
  atualizarRotuloDaEscala();
  $("ajuste-brilho-cursor").checked = estado.brilhoCursor;
  $("bloco-controles-brilho").hidden = !estado.brilhoCursor;
  $("ajuste-tamanho-brilho").value = String(estado.tamanhoBrilhoCursor);
  $("valor-tamanho-brilho").textContent = `${estado.tamanhoBrilhoCursor}px`;
  $("ajuste-intensidade-brilho").value = String(estado.intensidadeBrilhoCursor);
  $("valor-intensidade-brilho").textContent = `${estado.intensidadeBrilhoCursor}%`;
  $("ajuste-busca-automatica").checked = estado.buscarAtualizacoesAutomaticamente;
  $("versao-atual").textContent = `CALL ${VERSAO_ATUAL}`;
  $("ajuste-cursor-personalizado").checked = estado.cursorPersonalizado;
}

/** Põe na tela o que está no estado. Um só caminho: qualquer mudança passa a
 *  gravar e a chamar isto, em vez de cada controle cuidar do próprio rótulo. */
function refletirAjustes() {
  const a = estado.audio;

  atualizarAjustesDaInterface();

  $("ajuste-ganho").value = String(Math.round(a.ganhoEntrada * 100));
  $("valor-ganho").textContent = `${Math.round(a.ganhoEntrada * 100)}%`;
  $("ajuste-volume").value = String(Math.round(a.volumeGeral * 100));
  $("valor-volume").textContent = `${Math.round(a.volumeGeral * 100)}%`;
  $("ajuste-limiar").value = String(a.limiar);
  $("valor-limiar").textContent = `${String(a.limiar).replace("-", "−")} dB`;
  $("ajuste-retorno-microfone").checked = false;

  $("ajuste-porta").checked = a.porta;
  $("bloco-limiar").hidden = !a.porta;
  $("ajuste-eco").checked = a.cancelarEco;
  $("ajuste-supressao").checked = a.suprimirRuido;
  $("ajuste-agc").checked = a.ganhoAutomatico;
  $("ajuste-continuo").checked = a.bandaLarga;
  $("ajuste-sons").checked = a.sons;
  $("bloco-sons").hidden = !a.sons;
  $("ajuste-volume-sons").value = String(Math.round(a.volumeSons * 100));
  $("valor-volume-sons").textContent = `${Math.round(a.volumeSons * 100)}%`;
  $("ajuste-atividade").checked = estado.mostrarAtividade;
  $("bloco-atividade").hidden = !estado.mostrarAtividade;
  mostrarAtividadeAtual();
  desenharProgramasPersonalizados();

  for (const [i, botao] of [...$("ajuste-bitrate").children].entries()) {
    botao.setAttribute("aria-pressed", BITRATES_AUDIO[i].valor === a.bitrate ? "true" : "false");
  }

  $("medidor-limiar").style.left = `${posicaoNoMedidor(a.limiar)}%`;
}

/** Liga o medidor ao vivo. Os números vêm da própria porta, na thread de
 *  áudio — medir de novo aqui seria medir outra coisa. */
async function observarNivel() {
  const medidor = $("medidor");
  const barra = $("medidor-nivel");
  const piso = $("medidor-piso");
  const marca = $("medidor-limiar");

  motor.medir((dados) => {
    maiorNivelNoTeste = Math.max(maiorNivelNoTeste, dados.nivel);
    if (dados.nivel > -75) $("aviso-microfone-sem-sinal").hidden = true;
    barra.style.width = `${posicaoNoMedidor(dados.nivel)}%`;
    piso.style.width = `${posicaoNoMedidor(dados.piso)}%`;
    // O limiar mostrado é o que a porta usa de fato: o pedido pelo deslizante
    // ou o piso medido mais a margem, o que for maior.
    marca.style.left = `${posicaoNoMedidor(dados.abertura)}%`;
    medidor.dataset.aberta = dados.aberta ? "sim" : "nao";
    $("medidor-estado").textContent = dados.aberta ? "passando" : "em silêncio";
  });
}

async function desenharDispositivos() {
  const { entradas, saidas } = await listarDispositivos();

  const encher = (campo, lista, escolhido, padrao, selo) => {
    campo.textContent = "";
    const automatico = document.createElement("option");
    automatico.value = "";
    automatico.textContent = padrao;
    campo.append(automatico);
    for (const item of lista) {
      const opcao = document.createElement("option");
      opcao.value = item.id;
      opcao.textContent = item.nome;
      campo.append(opcao);
    }
    // O motor pode ter caído para o padrão se o dispositivo salvo sumiu; ler
    // dele, e não do estado, é o que mantém a tela honesta.
    campo.value = lista.some((i) => i.id === escolhido) ? escolhido : "";
    // O selo é a mesma honestidade em forma de selo: unicamente visível
    // quando é mesmo o sistema escolhendo, e não uma pessoa que já decidiu.
    if (selo) selo.hidden = campo.value !== "";
  };

  const atual = motor.config;
  estado.audio.entrada = atual.entrada;
  encher($("ajuste-entrada"), entradas, atual.entrada, "Padrão do sistema", $("selo-entrada"));
  encher($("ajuste-saida"), saidas, atual.saida, "Padrão do sistema", $("selo-saida"));
}

/* ═══ Atualização automática ════════════════════════════════════ */

/** De quanto em quanto tempo se pergunta ao servidor. Meia hora é frequente
 *  o bastante para uma correção chegar no mesmo dia e raro o bastante para
 *  não pesar em nada. */
const INTERVALO_ATUALIZACAO = 30 * 60 * 1000;
const LEMBRETE_ATUALIZACAO_MS = 4 * 60 * 60 * 1000;

/** Versão nova encontrada, dispensada ou não. Enquanto houver uma aqui, a
 *  marca do canto fica na tela. */
let atualizacaoDisponivel = null;
/** As notas da versão nova, como o publicador as escreveu no manifesto. Sem
 *  elas o botão "Ver o que há de novo" abre um cartão honesto — diz que a
 *  versão existe, e não inventa conteúdo que não veio. */
let atualizacaoNotas = "";
let instalando = false;

async function procurarAtualizacao({ manual = false } = {}) {
  if (instalando || (!manual && !estado.buscarAtualizacoesAutomaticamente)) return;
  if (manual) {
    $("botao-buscar-atualizacao").disabled = true;
    $("botao-buscar-atualizacao").textContent = "Verificando…";
    mostrarEstadoDaAtualizacao("Verificando atualizações…");
  }
  try {
    const achado = await invocar("procurar_atualizacao");
    if (!achado?.versao) {
      estado.atualizacaoPendente = null;
      estado.lembreteAtualizacao = null;
      salvarPreferencias();
      atualizacaoDisponivel = null;
      atualizacaoNotas = "";
      mostrarMarcaDeAtualizacao();
      if (manual) mostrarEstadoDaAtualizacao(`CALL ${VERSAO_ATUAL} já está atualizado.`);
      return;
    }
    atualizacaoDisponivel = achado.versao;
    atualizacaoNotas = achado.notas ?? "";
    estado.atualizacaoPendente = { versao: atualizacaoDisponivel, notas: atualizacaoNotas };
    salvarPreferencias();
    mostrarMarcaDeAtualizacao();
    mostrarEstadoDaAtualizacao(`CALL ${achado.versao} está pronto para instalar.`);
    const lembrete = estado.lembreteAtualizacao;
    if (!lembrete || lembrete.versao !== achado.versao || Date.now() >= lembrete.lembrarEm) {
      abrirCartaoDeAtualizacao(achado.versao);
    }
  } catch {
    // Sem rede, servidor fora do ar ou rodando fora do aplicativo. Nada disso
    // é problema do usuário: a próxima rodada tenta de novo, em silêncio.
    if (manual) mostrarEstadoDaAtualizacao("Não foi possível buscar atualizações agora.");
  } finally {
    if (manual) {
      $("botao-buscar-atualizacao").disabled = false;
      $("botao-buscar-atualizacao").textContent = "Buscar agora";
    }
  }
}

function mostrarEstadoDaAtualizacao(texto) {
  const campo = $("estado-atualizacao");
  if (campo) campo.textContent = texto;
}

/**
 * A marca do canto superior direito.
 *
 * Existe porque "Depois" escondia o cartão e não deixava rastro: a versão
 * nova continuava lá, e a única forma de lembrar dela era reabrir o
 * aplicativo. Agora "Depois" tira o cartão da frente e deixa a marca — que
 * não pisca, não pula e não interrompe, mas também não some.
 */
function mostrarMarcaDeAtualizacao() {
  const marca = $("marca-atualizacao");
  marca.classList.toggle("oculto", !atualizacaoDisponivel || instalando);
  marca.onclick = () => abrirCartaoDeAtualizacao(atualizacaoDisponivel);
}

function abrirCartaoDeAtualizacao(versao) {
  if (!versao || instalando) return;
  $("atualizacao-detalhe").textContent = `CALL ${versao} — instala em segundos`;
  $("atualizacao").classList.remove("oculto");

  $("botao-adiar").onclick = () => {
    estado.lembreteAtualizacao = { versao, lembrarEm: Date.now() + LEMBRETE_ATUALIZACAO_MS };
    salvarPreferencias();
    $("atualizacao").classList.add("oculto");
    mostrarEstadoDaAtualizacao("Lembraremos você novamente em algumas horas.");
    // O cartão sai, mas a marca fica para a atualização poder ser retomada já.
    mostrarMarcaDeAtualizacao();
  };

  $("botao-atualizar").onclick = () => instalarAtualizacao();
  $("botao-novidades").onclick = () => abrirNovidades();
}

/**
 * O cartão "O que há de novo": o que mudou nesta versão, em linguagem de
 * gente — as notas que o publicador escreveu, montadas como leitura, não
 * como lista de arquivos.
 */
function abrirNovidades() {
  if (!atualizacaoDisponivel || instalando) return;

  $("novidades-versao").textContent = `CALL ${atualizacaoDisponivel}`;
  montarNovidades($("novidades-corpo"), atualizacaoNotas);
  $("novidades-dialogo").classList.remove("oculto");

  const fechar = () => {
    $("novidades-dialogo").classList.add("oculto");
    document.removeEventListener("keydown", aoTeclar);
    // O foco volta a quem abriu — fechar deixa o teclado onde estava, em vez
    // de órfão no nada.
    $("botao-novidades").focus();
  };

  // O Escape é registrado aqui, e não só em `prepararAplicacao`, porque o
  // cartão da atualização também aparece sobre o portal — e lá dentro o
  // handler da aplicação ainda não existe.
  const aoTeclar = (evento) => {
    if (evento.key === "Escape") fechar();
  };

  // O "Depois" do cartão grande também vale aqui dentro: dispensar a leitura
  // não é dispensar a atualização, é só fechar esta janela.
  $("novidades-depois").onclick = fechar;
  $("novidades-fechar").onclick = fechar;
  $("novidades-atualizar").onclick = () => {
    fechar();
    instalarAtualizacao();
  };
  $("novidades-dialogo").onclick = (evento) => {
    if (evento.target === $("novidades-dialogo")) fechar();
  };

  document.addEventListener("keydown", aoTeclar);
  $("novidades-fechar").focus();
}

/**
 * Monta as notas da versão dentro do cartão, como texto de leitura.
 *
 * O formato é o que o publicador escreve no manifesto: uma linha por item,
 * com `-` no começo. Seções delimitadas por uma linha em branco viram blocos
 * com título — "O que mudou", "O que foi consertado" — para a leitura ter
 * hierarquia e não virar uma parede de texto. Sem notas, o cartão diz a
 * verdade: a versão chegou, e nada mais.
 */
function montarNovidades(corpo, notas) {
  corpo.textContent = "";

  const texto = String(notas ?? "").trim();
  if (!texto) {
    const vazio = document.createElement("p");
    vazio.className = "novidades__vazio";
    vazio.textContent =
      "Esta versão não trouxe notas escritas. Instale para ver o que mudou — é rápido e não desfaz nada.";
    corpo.append(vazio);
    return;
  }

  // Cada linha é um item, e uma linha vazia encerra o bloco anterior — por
  // isso o corte é por linha (`/\n/`), e não por uma ou mais (`/\n+/`): juntar
  // as vazias com as cheias apagaria a separação que o publicador fez.
  //
  // O bloco com mais de um item ganha título; o de um só, não — um título
  // para uma linha é cerimônia. E uma linha solta, sem item nenhum, é
  // parágrafo — nunca pode sumir só porque não veio seguida de marcador.
  let bloco = null;
  let itens = [];

  const fecharBloco = () => {
    if (bloco && !itens.length) {
      const paragrafo = document.createElement("p");
      paragrafo.className = "novidades__vazio";
      paragrafo.textContent = bloco;
      corpo.append(paragrafo);
      bloco = null;
      return;
    }
    if (!itens.length) return;
    if (itens.length > 1) {
      const secao = document.createElement("h4");
      secao.className = "novidades__secao";
      secao.textContent = bloco;
      corpo.append(secao);
    }
    const lista = document.createElement("ul");
    lista.className = "novidades__lista";
    for (const item of itens) {
      const linha = document.createElement("li");
      linha.className = "novidades__item";
      linha.textContent = item;
      lista.append(linha);
    }
    corpo.append(lista);
    bloco = null;
    itens = [];
  };

  for (const linhaBruta of texto.split(/\n/)) {
    const linha = linhaBruta.trim();
    if (!linha) {
      fecharBloco();
      continue;
    }
    const semMarca = linha.replace(/^[-•]\s*/, "");
    if (semMarca === linha) {
      // Linha sem a marca de item começa um bloco novo, com ela de título.
      fecharBloco();
      bloco = linha;
    } else {
      itens.push(semMarca);
    }
  }
  fecharBloco();
}

async function instalarAtualizacao() {
  if (instalando) return;

  // O instalador encerra o aplicativo. Quem está em uma chamada precisa saber
  // disso antes, e um segundo clique é confirmação suficiente — sem diálogo
  // nativo, que no WebView2 pode simplesmente não aparecer.
  const botao = $("botao-atualizar");
  if (estado.canalVoz && botao.dataset.confirmado !== "sim") {
    botao.dataset.confirmado = "sim";
    botao.textContent = "Sair da voz e atualizar";
    $("atualizacao-detalhe").textContent =
      "O CALL fecha para instalar e reabre em seguida.";
    return;
  }

  // Devolve o microfone e avisa os outros, em vez de deixar um fantasma na voz.
  desligar();

  instalando = true;
  mostrarMarcaDeAtualizacao();
  $("botao-adiar").disabled = true;
  botao.disabled = true;
  botao.textContent = "Baixando…";

  try {
    await invocar("instalar_atualizacao");
  } catch (erro) {
    instalando = false;
    // A atualizacao falhou, entao ela continua pendente: a marca volta.
    mostrarMarcaDeAtualizacao();
    $("botao-adiar").disabled = false;
    botao.disabled = false;
    botao.dataset.confirmado = "nao";
    botao.textContent = "Atualizar";
    avisar(`Não foi possível atualizar: ${erro}`, "erro");
  }
}

/* ═══ Início ════════════════════════════════════════════════════ */

window.addEventListener("beforeunload", () => {
  desligar();
  if (estado.hospedando) invocar("encerrar_hospedagem").catch(() => {});
});

carregarPreferencias();

if (estado.atualizacaoPendente) {
  atualizacaoDisponivel = estado.atualizacaoPendente.versao;
  atualizacaoNotas = estado.atualizacaoPendente.notas;
}

// Um servidor imposto pelo ambiente vence o gravado. Fora do aplicativo o
// comando não existe, e a recusa é o caso normal.
const servidorDoAmbiente = await invocar("servidor_do_ambiente").catch(() => null);
if (servidorDoAmbiente) estado.servidor = servidorDoAmbiente;

// Um apelido imposto pelo ambiente pula o portal e entra sem conta. Serve aos
// roteiros que dirigem janelas reais — e a quem sobe o CALL numa rede local
// sem querer cadastro nenhum.
const apelidoDoAmbiente = await invocar("apelido_do_ambiente").catch(() => null);
if (apelidoDoAmbiente) {
  estado.apelido = apelidoDoAmbiente;
  salvarPreferencias();
}

prepararPortal();
prepararBrilhoDoCursor();

/**
 * Quem entra direto, e quem vê o portal.
 *
 * 1. Com sessão guardada para *este* servidor, o token é conferido e a pessoa
 *    entra direto, com o perfil e os grupos da conta já em mãos.
 * 2. Uma sessão que o servidor recusa — vencida, ou derrubada de outra
 *    máquina — leva ao portal, mesmo havendo apelido guardado. Entrar assim
 *    mesmo seria rebaixar alguém a visitante sem avisar, no aplicativo em que
 *    ela acha que continua sendo ela.
 * 3. Sem sessão nenhuma, mas com apelido guardado — quem usava o CALL antes
 *    das contas —, entra direto como sempre entrou. Ninguém é obrigado a
 *    criar conta para voltar a um aplicativo que já usava.
 * 4. Sem nada, o portal.
 *
 * O servidor fora do ar não é recusa: o token continua guardado e viaja na
 * próxima saudação. O CALL funciona sem internet, e a conta não pode ser o
 * que passa a exigi-la.
 */
try {
  const guardada = conta.sessaoGuardada();
  let entrouPelaSessao = false;
  let sessaoRecusada = false;

  // Uma sessão só prova identidade no servidor que a emitiu. Isto também
  // cobre quem selecionou o backend local antes desta correção e recarregou
  // a página: não reapresentamos um id `conta-*` do servidor hospedado como
  // se ele valesse no servidor local.
  if (guardada?.token && guardada.servidor !== estado.servidor && estado.usuario.startsWith("conta-")) {
    estado.usuario = crypto.randomUUID().replace(/-/g, "");
    salvarPreferencias();
  }

  if (guardada?.token && guardada.servidor === estado.servidor) {
    // Assumido desde já: se o servidor estiver fora do ar, a saudação ainda
    // leva o token e a identidade da conta continua sendo comprovável.
    estado.token = guardada.token;
    try {
      const sessao = await conta.retomar(estado.servidor, guardada.token);
      if (sessao) {
        assumirConta(sessao, { abrir: false });
        entrouPelaSessao = true;
      } else {
        largarIdentidadeDaConta();
        sessaoRecusada = true;
      }
    } catch {
      /* servidor fora do ar: segue com o token guardado */
    }
  }

  if (entrouPelaSessao || (estado.apelido && !sessaoRecusada)) {
    abrirAplicacao();
  } else {
    refletirPortal();
    // Perguntar pelo Google custa uma conexão curta ao servidor. Só quem vai
    // mesmo ver o botão paga por ela.
    perguntarPeloGoogle();
  }
} finally {
  // Some mesmo se algo aqui em cima falhar de um jeito inesperado — travada
  // atrás do glifo para sempre é pior que aparecer no portal sem sessão.
  esconderTelaDeCarregando();
}

// Um link clicado com o CALL já aberto chega por evento; um link que abriu o
// CALL já está guardado antes desta linha rodar. Os dois entram pela mesma
// porta.
window.__TAURI__?.event?.listen("convite", receberConvite);
receberConvite();

// O atalho é global — o Rust dispara o evento com a janela sem foco ou
// escondida na bandeja, e é por isso que ele precisa ser religado aqui, na
// partida, e não só quando o painel de ajustes abre.
window.__TAURI__?.event?.listen("atalho-mudo", alternarMicrofone);
if (estado.atalhoMudo) invocar("definir_atalho_mudo", { atalho: estado.atalhoMudo }).catch(() => {});

procurarAtualizacao();
setInterval(procurarAtualizacao, INTERVALO_ATUALIZACAO);
