import { Sinal } from "./sinal.js";
import { Malha, PERFIS_TELA, PERFIL_TELA_PADRAO, acharPerfilDeTela } from "./rtc.js";
import { MotorDeAudio, AUDIO_PADRAO, BITRATES_AUDIO, listarDispositivos } from "./audio.js";

/* ═══ Atalhos ═══════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const invocar = (comando, args) =>
  window.__TAURI__?.core?.invoke
    ? window.__TAURI__.core.invoke(comando, args)
    : Promise.reject(new Error("Recurso disponível apenas no aplicativo."));

const CHAVE = "call.preferencias";
/** Servidor oficial do CALL, hospedado. É o padrão para que ninguém precise
 *  subir nada na própria máquina para conversar com os amigos. */
const SERVIDOR_PADRAO = "wss://sinalizacao-production.up.railway.app";

/** Padrão das versões anteriores. Quem já usou o CALL tem este endereço
 *  gravado, e sem a troca continuaria preso a um servidor local que na maioria
 *  das máquinas nem está de pé. */
const SERVIDOR_ANTIGO = "ws://127.0.0.1:8787";

/** Página do projeto, que hospeda a página de convite. */
const SITE = "https://alanaraujo-bit.github.io/CALL";

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
  /** Grupos que este computador conhece — [{ codigo, nome }]. O servidor é a
   *  fonte da verdade; isto é só a lista de atalhos da coluna da esquerda. */
  atalhos: [],

  grupo: null, // { codigo, nome, dono, categorias } vindo do servidor
  meuId: null,
  membros: new Map(), // id -> { id, usuario, apelido, canalVoz, mudo, transmitindo }

  canalTexto: null,
  canalVoz: null,
  mensagens: new Map(), // idCanal -> [mensagem]
  naoLidos: new Map(), // idCanal -> quantidade

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
  /** Volume por pessoa, guardado pelo identificador estável e não pelo `id`
   *  da sessão — quem sobe o volume de alguém quer isso amanhã também. */
  volumes: new Map(), // usuario -> 0 a 2
};

const audiosRemotos = new Map(); // id -> HTMLAudioElement de sustentação
const telas = new Map(); // id -> HTMLElement do palco
const linhas = new Map(); // id -> [HTMLElement] que recebem a marca de fala
const medidores = new Map(); // id -> { no, analisador, dados, ateQuando, falando }

const motor = new MotorDeAudio();
let cronometroVoz = null;

const sinal = new Sinal();
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

/* ═══ Preferências ══════════════════════════════════════════════ */

function carregarPreferencias() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
    estado.apelido = bruto.apelido ?? "";
    // Quem escolheu um servidor próprio continua com ele; só o padrão antigo,
    // que a pessoa nunca escolheu de fato, é levado ao servidor hospedado.
    estado.servidor =
      !bruto.servidor || bruto.servidor === SERVIDOR_ANTIGO
        ? SERVIDOR_PADRAO
        : bruto.servidor;
    estado.usuario = bruto.usuario || "";
    estado.atalhos = Array.isArray(bruto.atalhos)
      ? bruto.atalhos.filter((a) => a && typeof a.codigo === "string")
      : [];

    // Só as chaves conhecidas entram: uma preferência gravada por uma versão
    // futura, ou adulterada à mão, não deve virar constraint de captura.
    for (const chave of Object.keys(AUDIO_PADRAO)) {
      if (bruto.audio && chave in bruto.audio) estado.audio[chave] = bruto.audio[chave];
    }
    if (PERFIS_TELA.some((p) => p.id === bruto.perfilTela)) estado.perfilTela = bruto.perfilTela;
    if (typeof bruto.audioDaTela === "boolean") estado.audioDaTela = bruto.audioDaTela;
    estado.volumes = new Map(Array.isArray(bruto.volumes) ? bruto.volumes : []);
  } catch {
    /* preferências ilegíveis: segue com os padrões */
  }

  // O servidor aceita letras, números e hífen. Gerar aqui, e não lá, é o que
  // permite ser reconhecido como a mesma pessoa depois de reinstalar o app.
  if (!estado.usuario) {
    estado.usuario = crypto.randomUUID().replace(/-/g, "");
    salvarPreferencias();
  }
}

function salvarPreferencias() {
  localStorage.setItem(
    CHAVE,
    JSON.stringify({
      apelido: estado.apelido,
      servidor: estado.servidor,
      usuario: estado.usuario,
      atalhos: estado.atalhos,
      audio: estado.audio,
      perfilTela: estado.perfilTela,
      audioDaTela: estado.audioDaTela,
      volumes: [...estado.volumes],
    })
  );
}

function lembrarGrupo(codigo, nome) {
  const existente = estado.atalhos.find((a) => a.codigo === codigo);
  if (existente) existente.nome = nome;
  else estado.atalhos.push({ codigo, nome });
  salvarPreferencias();
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

/* ═══ Tela de entrada ═══════════════════════════════════════════ */

function prepararEntrada() {
  $("campo-apelido").value = estado.apelido;
  $("campo-servidor").value = estado.servidor;

  // O campo de servidor some atrás de "Usar um servidor próprio" para quem
  // já está no padrão hospedado — mas quem tem um servidor próprio salvo
  // precisa continuar vendo qual é, não descobrir escondido.
  if (estado.servidor !== SERVIDOR_PADRAO) $("avancado-servidor").open = true;

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
  $("rotulo-usuario").textContent = estado.apelido;
  $("avatar-usuario").textContent = iniciais(estado.apelido);

  $("botao-novo-grupo").addEventListener("click", criarGrupo);
  $("botao-entrar-grupo").addEventListener("click", entrarPorConvite);
  $("botao-menu-grupo").addEventListener("click", (e) => menuDoGrupo(e.currentTarget));
  $("botao-convite").addEventListener("click", copiarConvite);

  $("botao-microfone").addEventListener("click", alternarMicrofone);
  $("botao-transmitir").addEventListener("click", () => {
    if (estado.transmitindo) pararTransmissao();
    else abrirSeletorDeFontes();
  });
  $("botao-sair-voz").addEventListener("click", () => sairDaVoz(true));

  prepararAjustes();
  prepararTransmitirDialogo();
  prepararSeletorDeFontes();
  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape") return;
    if (!$("transmitir-dialogo").classList.contains("oculto")) {
      fecharTransmitirDialogo();
    } else if (!$("ajustes").classList.contains("oculto")) {
      fecharAjustes();
    } else if (!$("seletor-dialogo").classList.contains("oculto")) {
      fecharSeletorDeFontes();
    } else if (telaMaximizada) {
      alternarMaximizarTela(telaMaximizada);
    }
  });

  prepararRedator();

  sinal.addEventListener("entrou", (e) => aoEntrar(e.detail.membro));
  sinal.addEventListener("saiu", (e) => aoSair(e.detail.id));
  sinal.addEventListener("grupo", (e) => aoEstrutura(e.detail.grupo));
  sinal.addEventListener("voz", (e) => aoEntrarNaVoz(e.detail));
  sinal.addEventListener("entrou-voz", (e) => aoParPorVoz(e.detail));
  sinal.addEventListener("saiu-voz", (e) => aoParDeixarVoz(e.detail));
  sinal.addEventListener("sinal", (e) => malha.receberSinal(e.detail.de, e.detail.dados));
  sinal.addEventListener("estado", (e) => aoEstadoDeMidia(e.detail));
  sinal.addEventListener("mensagem", (e) => aoMensagem(e.detail.mensagem));
  sinal.addEventListener("historico", (e) => aoHistorico(e.detail));
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

const souDono = () => estado.grupo?.dono === estado.usuario;

/* ═══ Grupos ════════════════════════════════════════════════════ */

function desenharAtalhos() {
  const lista = $("lista-grupos");
  lista.textContent = "";

  if (estado.atalhos.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "grupos__vazio";
    vazio.textContent = "Nenhum grupo ainda. Crie o primeiro ou entre com um convite.";
    lista.append(vazio);
    return;
  }

  for (const atalho of estado.atalhos) {
    const item = document.createElement("button");
    item.className = "grupo";
    item.type = "button";
    if (atalho.codigo === estado.grupo?.codigo) item.classList.add("grupo--ativo");

    const marca = document.createElement("span");
    marca.className = "grupo__marca";
    marca.textContent = iniciais(atalho.nome);

    const rotulo = document.createElement("span");
    rotulo.className = "grupo__nome";
    rotulo.textContent = atalho.nome;

    item.append(marca, rotulo);
    item.addEventListener("click", () => abrirGrupo(atalho.codigo));
    item.addEventListener("contextmenu", (evento) => {
      evento.preventDefault();
      abrirMenu(item, [
        {
          rotulo: "Esquecer este grupo",
          perigo: true,
          acao: () => esquecerGrupo(atalho.codigo),
        },
      ]);
    });
    lista.append(item);
  }
}

async function criarGrupo() {
  const valores = await perguntar({
    titulo: "Criar grupo",
    texto: "O servidor devolve um código de convite para você compartilhar.",
    campos: [{ rotulo: "Nome do grupo", dica: "Equipe de produto", maximo: 40 }],
    confirmar: "Criar",
  });
  if (!valores) return;
  await conectar({ tipo: "criar-grupo", nome: valores[0] });
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

  try {
    const boasVindas = await sinal.conectar(estado.servidor, {
      ...saudacao,
      apelido: estado.apelido,
      usuario: estado.usuario,
    });
    assumirGrupo(boasVindas);
  } catch (erro) {
    desligar();
    avisar(erro.message ?? String(erro), "erro");
  } finally {
    estado.ocupado = false;
  }
}

function assumirGrupo({ eu, grupo, presentes }) {
  estado.grupo = grupo;
  estado.meuId = eu.id;
  malha.definirIdentidade(eu.id);

  estado.membros.clear();
  estado.membros.set(eu.id, { ...eu, apelido: estado.apelido });
  for (const membro of presentes) estado.membros.set(membro.id, membro);

  lembrarGrupo(grupo.codigo, grupo.nome);
  atualizarConexao(true);
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
  sinal.desconectar();

  estado.grupo = null;
  estado.meuId = null;
  estado.membros.clear();
  estado.canalTexto = null;
  estado.mensagens.clear();
  estado.naoLidos.clear();

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
  desenharAtalhos();
}

function desenharCabecalhoDoGrupo() {
  const grupo = estado.grupo;
  $("nome-grupo").textContent = grupo?.nome ?? "Nenhum grupo";
  $("botao-menu-grupo").disabled = !grupo;
  $("botao-convite").hidden = !grupo;
  $("codigo-convite").textContent = grupo?.codigo ?? "—";
  $("acao-convite").textContent = "copiar link";
}

/**
 * O link do convite aponta para a página do projeto, não direto para
 * `call://`: quem recebe pode não ter o CALL instalado, e um esquema que
 * ninguém registrou não abre nada nem explica por quê. A página abre o
 * aplicativo com um clique para quem tem, e oferece o instalador para quem
 * não tem.
 */
function linkDoConvite() {
  const grupo = estado.grupo;
  if (!grupo) return null;

  const endereco = new URL(`${SITE}/entrar/`);
  endereco.searchParams.set("c", grupo.codigo);
  if (grupo.nome) endereco.searchParams.set("g", grupo.nome);
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

/** Clique no cartão do convite: o link, que é o que se manda para alguém. */
async function copiarConvite() {
  const link = linkDoConvite();
  if (!link) return;
  if (!(await copiar(link))) return;

  $("acao-convite").textContent = "link copiado";
  setTimeout(() => ($("acao-convite").textContent = "copiar link"), 1600);
}

/** O código continua tendo dono: quem vai ditar por voz ou digitar à mão. */
async function copiarCodigo() {
  if (!estado.grupo) return;
  if (await copiar(estado.grupo.codigo)) avisar("Código copiado.", "bom");
}

function menuDoGrupo(ancora) {
  const itens = [
    { rotulo: "Copiar link do convite", acao: copiarConvite },
    { rotulo: "Copiar código do convite", acao: copiarCodigo },
    { rotulo: "Sair do grupo", acao: () => desligar() },
    "-",
    {
      rotulo: "Esquecer este grupo",
      perigo: true,
      acao: () => esquecerGrupo(estado.grupo.codigo),
    },
  ];

  if (souDono()) {
    itens.unshift(
      { rotulo: "Renomear grupo", acao: renomearGrupo },
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
  lembrarGrupo(grupo.codigo, grupo.nome);

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

function renomearGrupo() {
  pedirNome("Renomear grupo", estado.grupo.nome, (nome) =>
    sinal.enviar({ tipo: "renomear", alvo: "grupo", nome })
  );
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
  linhas.clear();
  desenharArvore();
  desenharParticipantes();
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
  const linha = document.createElement("div");
  linha.className = "vozinho";
  linha.dataset.falando = medidores.get(membro.id)?.falando ? "sim" : "nao";

  const avatar = document.createElement("span");
  avatar.className = "avatar avatar--pequeno";
  avatar.textContent = iniciais(membro.apelido);

  const nome = document.createElement("span");
  nome.className = "vozinho__nome";
  nome.textContent = membro.id === estado.meuId ? `${membro.apelido} (você)` : membro.apelido;

  const sinais = document.createElement("span");
  sinais.className = "vozinho__sinais";
  if (membro.transmitindo) sinais.innerHTML += SVG_TRANSMITINDO;
  if (membro.mudo) sinais.innerHTML += SVG_MUDO;

  linha.append(avatar, nome, sinais);
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

function aoEstadoDeMidia({ de, mudo, transmitindo }) {
  const membro = estado.membros.get(de);
  if (!membro) return;
  membro.mudo = mudo;
  membro.transmitindo = transmitindo;
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

function desenharParticipantes() {
  const lista = $("lista-participantes");
  lista.textContent = "";

  if (!estado.grupo) {
    const vazio = document.createElement("p");
    vazio.className = "participantes__vazio";
    vazio.textContent = "Você não está em nenhum grupo.";
    lista.append(vazio);
    $("contador-participantes").textContent = "0";
    return;
  }

  const todos = [...estado.membros.values()].sort((a, b) =>
    a.id === estado.meuId ? -1 : b.id === estado.meuId ? 1 : a.apelido.localeCompare(b.apelido)
  );
  $("contador-participantes").textContent = String(todos.length);

  for (const membro of todos) {
    const linha = document.createElement("div");
    linha.className = "participante";
    // A lista é redesenhada a cada mudança de estado; sem reaplicar a marca,
    // quem estivesse falando apagaria a cada silenciar de outra pessoa.
    linha.dataset.falando = medidores.get(membro.id)?.falando ? "sim" : "nao";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = iniciais(membro.apelido);

    const nome = document.createElement("span");
    nome.className = "participante__nome";
    nome.textContent =
      membro.id === estado.meuId ? `${membro.apelido} (você)` : membro.apelido;

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

    // O volume de cada pessoa fica no botão direito, e não numa engrenagem por
    // linha: é ajuste raro, e um controle permanente por participante encheria
    // uma coluna de 212 px de coisa que quase nunca se usa.
    if (membro.id !== estado.meuId) {
      linha.addEventListener("contextmenu", (evento) => {
        evento.preventDefault();
        abrirMenu(linha, [{ rotulo: "Ajustar volume…", acao: () => ajustarVolumeDe(membro) }]);
      });
    }

    linha.append(avatar, nome, sinais);
    lista.append(linha);
    registrarLinha(membro.id, linha);
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
    }
  });

  campo.addEventListener("input", () => {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(campo.scrollHeight, 160)}px`;
  });
}

function enviarMensagem() {
  const campo = $("campo-mensagem");
  const texto = campo.value.trim();
  if (!texto || !estado.canalTexto) return;

  sinal.enviar({ tipo: "mensagem", canal: estado.canalTexto, texto });
  campo.value = "";
  campo.style.height = "auto";
}

function abrirCanalTexto(id) {
  estado.canalTexto = id;
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

function desenharConversa() {
  const conversa = $("conversa");
  const linhaDoTempo = $("linha-do-tempo");
  const canal = estado.canalTexto ? acharCanal(estado.canalTexto) : null;

  $("titulo-canal").textContent = canal ? canal.nome : "Nenhum canal";
  $("redator").classList.toggle("oculto", !canal);

  if (!canal) {
    linhaDoTempo.textContent = "";
    $("conversa-vazio").classList.remove("oculto");
    vazio(
      "Nada por aqui ainda",
      "Escolha um canal de texto para conversar, ou um de voz para falar."
    );
    $("subtitulo-canal").textContent = estado.grupo
      ? "Escolha um canal"
      : "Selecione ou crie um grupo para começar";
    return;
  }

  const mensagens = estado.mensagens.get(canal.id);
  $("subtitulo-canal").textContent =
    mensagens === undefined
      ? "Carregando…"
      : mensagens.length === 0
        ? "Nenhuma mensagem ainda"
        : `${mensagens.length} mensagem${mensagens.length === 1 ? "" : "s"}`;

  $("conversa-vazio").classList.toggle("oculto", (mensagens?.length ?? 0) > 0);
  vazio(
    `Ninguém escreveu em ${canal.nome} ainda`,
    "A primeira mensagem pode ser a sua."
  );

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
  avatar.textContent = iniciais(mensagem.apelido);

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

function corpoDeMensagem(mensagem, dentroDoBloco = false) {
  const texto = document.createElement("p");
  texto.className = dentroDoBloco ? "mensagem__texto" : "mensagem__texto mensagem__texto--seguida";
  texto.title = HORA.format(new Date(mensagem.em));
  // textContent, nunca innerHTML: o que chega aqui foi digitado por outra
  // pessoa e não é marcação.
  texto.textContent = mensagem.texto;
  return texto;
}

/* ═══ Voz ═══════════════════════════════════════════════════════ */

async function entrarNaVoz(canal) {
  if (estado.canalVoz === canal || estado.ocupado) return;
  estado.ocupado = true;

  try {
    // O microfone é pedido ao entrar na voz, e não ao entrar no grupo: ler o
    // histórico de um canal de texto não é motivo para abrir o microfone.
    await pedirMicrofone();
    sinal.enviar({ tipo: "entrar-voz", canal });
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  } finally {
    estado.ocupado = false;
  }
}

/** Resposta do servidor a `entrar-voz`: quem já está na sala. */
function aoEntrarNaVoz({ canal, pares }) {
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
  if (estado.canalVoz && estado.canalVoz !== canal) desmontarMalha(false);
  estado.canalVoz = canal;

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.canalVoz = canal;

  const [trilha] = estado.fluxoMicrofone.getAudioTracks();
  malha.definirAudioLocal(trilha, estado.fluxoMicrofone);
  observarVoz(estado.meuId, motor.noLocal);

  // Quem já estava na sala: eu ofereço a conexão. Quem chegar depois oferece
  // para mim — assim nunca há dois lados ofertando ao mesmo tempo.
  for (const par of pares) {
    estado.membros.set(par.id, { ...estado.membros.get(par.id), ...par });
    malha.abrir(par.id, true);
  }

  atualizarRodapeDeVoz();
  redesenhar();
  anunciarEstado();
}

function aoParPorVoz({ membro, canal }) {
  estado.membros.set(membro.id, { ...estado.membros.get(membro.id), ...membro });
  if (canal === estado.canalVoz && membro.id !== estado.meuId) malha.abrir(membro.id, false);
  redesenhar();
}

function aoParDeixarVoz({ id, canal }) {
  const membro = estado.membros.get(id);
  if (membro) membro.canalVoz = null;
  if (canal === estado.canalVoz) derrubarPar(id);
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

function sairDaVoz(anunciar) {
  if (!estado.canalVoz) return;
  if (anunciar) sinal.enviar({ tipo: "sair-voz" });

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

  for (const id of [...audiosRemotos.keys()]) derrubarPar(id);
  for (const id of [...medidores.keys()]) esquecerVoz(id);
  for (const id of [...telas.keys()]) removerTela(id);

  if (!soltarMicrofone) return;

  motor.soltarMicrofone();
  estado.fluxoMicrofone = null;
  estado.mudo = false;

  // O contexto só é fechado se o painel de ajustes não estiver medindo: fechá-lo
  // no meio de um teste de microfone mataria o medidor que a pessoa está olhando.
  if (!$("ajustes")?.classList.contains("oculto")) return;
  motor.encerrar().catch(() => {});
}

async function pedirMicrofone() {
  if (estado.fluxoMicrofone) return estado.fluxoMicrofone;
  try {
    await motor.aplicar(estado.audio);
    // O que segue para os pares é a saída tratada, não a do dispositivo: a
    // passa-alta e a porta de ruído já agiram quando o WebRTC recebe a trilha.
    estado.fluxoMicrofone = await motor.abrirMicrofone();
    await malha.definirAudio({ bitrate: estado.audio.bitrate, dtx: !estado.audio.bandaLarga });
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
  });
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
      refletirAjustes();
      // Já transmitindo: o teto e a política valem na hora, sem reabrir a
      // captura — ver a explicação em `montarPerfis`.
      if (estado.transmitindo) await malha.definirPerfilTela(perfil);
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

/* ── Seletor de fontes (telas e janelas, capturadas pelo próprio CALL) ── */

let seletorDeFontesPreparado = false;
let fonteEscolhida = null;

function prepararSeletorDeFontes() {
  if (seletorDeFontesPreparado) return;
  seletorDeFontesPreparado = true;

  $("seletor-fechar").addEventListener("click", fecharSeletorDeFontes);
  $("seletor-cancelar").addEventListener("click", fecharSeletorDeFontes);
  $("seletor-config").addEventListener("click", () => {
    prepararTransmitirDialogo();
    abrirTransmitirDialogo(true);
  });
  $("seletor-dialogo").addEventListener("click", (evento) => {
    if (evento.target === $("seletor-dialogo")) fecharSeletorDeFontes();
  });
  $("seletor-confirmar").addEventListener("click", () => {
    if (!fonteEscolhida) return;
    const perfil = acharPerfilDeTela(estado.perfilTela);
    fecharSeletorDeFontes();
    iniciarCapturaNativa(fonteEscolhida, perfil);
  });
}

async function abrirSeletorDeFontes() {
  if (!estado.canalVoz) return;
  prepararSeletorDeFontes();

  fonteEscolhida = null;
  $("seletor-confirmar").disabled = true;
  $("seletor-secoes").classList.add("oculto");
  $("seletor-vazio").classList.add("oculto");
  $("seletor-carregando").classList.remove("oculto");
  $("seletor-dialogo").classList.remove("oculto");

  let fontes;
  try {
    fontes = await invocar("listar_fontes_de_tela");
  } catch {
    fontes = [];
  }

  $("seletor-carregando").classList.add("oculto");
  if (!fontes.length) {
    $("seletor-vazio").classList.remove("oculto");
    return;
  }
  montarSecoesDeFontes(fontes);
  $("seletor-secoes").classList.remove("oculto");
}

function fecharSeletorDeFontes() {
  $("seletor-dialogo").classList.add("oculto");
}

function montarSecoesDeFontes(fontes) {
  const area = $("seletor-secoes");
  area.textContent = "";

  const grupos = [
    { tipo: "tela", legenda: "Telas" },
    { tipo: "janela", legenda: "Janelas" },
  ];

  for (const grupo of grupos) {
    const itens = fontes.filter((f) => f.tipo === grupo.tipo);
    if (!itens.length) continue;

    const secao = document.createElement("div");
    const legenda = document.createElement("h4");
    legenda.className = "seletor__legenda";
    legenda.textContent = grupo.legenda;
    const grade = document.createElement("div");
    grade.className = "seletor__grade";

    for (const fonte of itens) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "fonte";
      botao.dataset.id = String(fonte.id);
      botao.dataset.tipo = fonte.tipo;
      botao.setAttribute("aria-pressed", "false");
      botao.innerHTML = `
        <span class="fonte__miniatura"><img alt="" /></span>
        <span class="fonte__nome"></span>
      `;
      botao.querySelector("img").src = fonte.miniatura;
      botao.querySelector(".fonte__nome").textContent = fonte.nome;

      botao.addEventListener("click", () => {
        fonteEscolhida = fonte;
        for (const outro of area.querySelectorAll(".fonte")) {
          outro.setAttribute("aria-pressed", outro === botao ? "true" : "false");
        }
        $("seletor-confirmar").disabled = false;
      });

      grade.append(botao);
    }

    secao.append(legenda, grade);
    area.append(secao);
  }
}

/* ── Captura em si: Rust manda quadros, o canvas vira o `MediaStreamTrack` ── */

let pararDeOuvirQuadros = null;
let canvasDeCaptura = null;

/** Decodifica o JPEG que veio do Rust e desenha no canvas — é o canvas quem
 *  empresta a `captureStream()` que vira a trilha de vídeo publicada. */
async function desenharQuadroCapturado(quadro) {
  if (!canvasDeCaptura) return;
  if (canvasDeCaptura.width !== quadro.largura || canvasDeCaptura.height !== quadro.altura) {
    canvasDeCaptura.width = quadro.largura;
    canvasDeCaptura.height = quadro.altura;
  }

  const binario = atob(quadro.dados);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  const memoria = new Blob([bytes], { type: "image/jpeg" });

  try {
    const quadroDecodificado = await createImageBitmap(memoria);
    canvasDeCaptura.getContext("2d").drawImage(quadroDecodificado, 0, 0);
    quadroDecodificado.close();
  } catch {
    // Um quadro corrompido não é motivo para parar a transmissão inteira —
    // o próximo, um instante depois, resolve sozinho.
  }
}

async function iniciarCapturaNativa(fonte, perfil) {
  if (!estado.canalVoz) return;

  canvasDeCaptura = document.createElement("canvas");
  canvasDeCaptura.width = fonte.largura;
  canvasDeCaptura.height = fonte.altura;

  pararDeOuvirQuadros = await window.__TAURI__.event.listen("quadro-tela", (evento) =>
    desenharQuadroCapturado(evento.payload)
  );

  try {
    await invocar("iniciar_captura_de_tela", {
      tipo: fonte.tipo,
      id: fonte.id,
      larguraMax: perfil.largura,
      alturaMax: perfil.altura,
      quadros: perfil.quadros,
    });
  } catch {
    pararDeOuvirQuadros?.();
    pararDeOuvirQuadros = null;
    canvasDeCaptura = null;
    avisar("Não foi possível capturar essa fonte.", "erro");
    return;
  }

  // Pedir e começar a capturar leva um instante; nesse meio-tempo a pessoa
  // pode ter saído da voz. Publicar agora acenderia uma transmissão sem
  // ninguém do outro lado.
  if (!estado.canalVoz) {
    await invocar("parar_captura_de_tela").catch(() => {});
    pararDeOuvirQuadros?.();
    pararDeOuvirQuadros = null;
    canvasDeCaptura = null;
    return;
  }

  const fluxo = canvasDeCaptura.captureStream(perfil.quadros);
  const [trilha] = fluxo.getVideoTracks();

  // O áudio do sistema ainda não viaja por esse caminho — a captura é
  // nativa, e não passa pelo `getDisplayMedia` que oferecia o áudio de
  // graça. Melhor avisar do que deixar a pessoa descobrir pelo silêncio.
  if (estado.audioDaTela) {
    avisar("Som do sistema ainda não é suportado nesta transmissão.", "neutro");
  }

  estado.fluxoTela = fluxo;
  estado.transmitindo = true;

  await malha.definirPerfilTela(perfil);
  malha.publicarTela(trilha, fluxo, null);
  mostrarTela(estado.meuId, fluxo, `${estado.apelido} (você)`);

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.transmitindo = true;

  atualizarBotaoTransmissao();
  redesenhar();
  anunciarEstado();
}

function pararTransmissao() {
  if (!estado.transmitindo) return;
  estado.transmitindo = false;
  malha.retirarTela();
  invocar("parar_captura_de_tela").catch(() => {});
  pararDeOuvirQuadros?.();
  pararDeOuvirQuadros = null;
  canvasDeCaptura = null;
  estado.fluxoTela?.getTracks().forEach((t) => t.stop());
  estado.fluxoTela = null;
  removerTela(estado.meuId);

  const eu = estado.membros.get(estado.meuId);
  if (eu) eu.transmitindo = false;

  atualizarBotaoTransmissao();
  redesenhar();
  anunciarEstado();
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

  const expandir = document.createElement("button");
  expandir.type = "button";
  expandir.className = "transmissao__expandir";
  expandir.setAttribute("aria-pressed", "false");
  expandir.title = "Maximizar";
  expandir.setAttribute("aria-label", "Maximizar");
  expandir.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GLIFO_EXPANDIR}</svg>`;
  expandir.addEventListener("click", () => alternarMaximizarTela(id));

  quadro.append(video, etiqueta, expandir);
  $("palco-grade").append(quadro);
  telas.set(id, quadro);
  atualizarPalco();
}

function removerTela(id) {
  const quadro = telas.get(id);
  if (!quadro) return;
  quadro.querySelector("video").srcObject = null;
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

function receberTrilha(id, trilha, fluxo) {
  if (trilha.kind === "audio") {
    if (!fluxosDeVoz.has(id)) fluxosDeVoz.set(id, fluxo.id);

    if (fluxosDeVoz.get(id) !== fluxo.id) {
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
  mostrarTela(id, fluxo, membro?.apelido ?? "Participante");
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
  await observarVoz(id, ganho);
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
  if (!medidor) return;
  // Desfaz só esta ligação: o nó medido também alimenta a chamada, e um
  // `disconnect()` sem argumento derrubaria o áudio junto com o medidor.
  try {
    medidor.no.disconnect(medidor.analisador);
  } catch {
    /* o nó já podia ter sido descartado */
  }
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
      agora < medidor.ateQuando && !(id === estado.meuId && estado.mudo);
    if (falando === medidor.falando) continue;

    medidor.falando = falando;
    marcarFala(id, falando);
  }
}

function marcarFala(id, falando) {
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

  const chave = (id, campo) =>
    $(id).addEventListener("change", (e) => aplicarAudio({ [campo]: e.target.checked }, true));

  chave("ajuste-porta", "porta");
  chave("ajuste-eco", "cancelarEco");
  chave("ajuste-supressao", "suprimirRuido");
  chave("ajuste-agc", "ganhoAutomatico");
  chave("ajuste-continuo", "bandaLarga");

  $("ajuste-porta").addEventListener("change", (e) => {
    $("bloco-limiar").hidden = !e.target.checked;
  });

  for (const [id, campo] of [["ajuste-entrada", "entrada"], ["ajuste-saida", "saida"]]) {
    $(id).addEventListener("change", (e) => aplicarAudio({ [campo]: e.target.value }, true));
  }

  $("ajuste-som-da-tela").addEventListener("change", (e) => {
    estado.audioDaTela = e.target.checked;
    salvarPreferencias();
  });

  montarBitrates();
  montarPerfis();

  // Trocar de fone no meio da conversa não deve exigir reabrir o painel.
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (!$("ajustes").classList.contains("oculto")) desenharDispositivos();
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

function montarPerfis() {
  const area = $("ajuste-perfil");
  area.textContent = "";
  for (const perfil of PERFIS_TELA) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "perfil-tela";
    botao.dataset.perfil = perfil.id;

    const texto = document.createElement("span");
    texto.className = "perfil-tela__texto";
    const nome = document.createElement("span");
    nome.className = "perfil-tela__nome";
    nome.textContent = perfil.nome;
    const resumo = document.createElement("span");
    resumo.className = "perfil-tela__resumo";
    resumo.textContent = perfil.resumo;
    texto.append(nome, resumo);

    const detalhe = document.createElement("span");
    detalhe.className = "perfil-tela__detalhe";
    detalhe.textContent = perfil.detalhe;

    botao.append(texto, detalhe);
    botao.addEventListener("click", async () => {
      estado.perfilTela = perfil.id;
      salvarPreferencias();
      refletirAjustes();
      // Já transmitindo: o teto e a política valem na hora. As dimensões e os
      // quadros vivem na captura, e trocá-los exigiria pedir a tela de novo —
      // o que faria o Windows perguntar tudo outra vez no meio da conversa.
      if (estado.transmitindo) await malha.definirPerfilTela(perfil);
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
      await observarVoz(estado.meuId, motor.noLocal);
    }
    if ("bitrate" in mudancas || "bandaLarga" in mudancas) {
      await malha.definirAudio({
        bitrate: estado.audio.bitrate,
        dtx: !estado.audio.bandaLarga,
      });
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
}

/** Põe na tela o que está no estado. Um só caminho: qualquer mudança passa a
 *  gravar e a chamar isto, em vez de cada controle cuidar do próprio rótulo. */
function refletirAjustes() {
  const a = estado.audio;

  $("ajuste-ganho").value = String(Math.round(a.ganhoEntrada * 100));
  $("valor-ganho").textContent = `${Math.round(a.ganhoEntrada * 100)}%`;
  $("ajuste-volume").value = String(Math.round(a.volumeGeral * 100));
  $("valor-volume").textContent = `${Math.round(a.volumeGeral * 100)}%`;
  $("ajuste-limiar").value = String(a.limiar);
  $("valor-limiar").textContent = `${String(a.limiar).replace("-", "−")} dB`;

  $("ajuste-porta").checked = a.porta;
  $("bloco-limiar").hidden = !a.porta;
  $("ajuste-eco").checked = a.cancelarEco;
  $("ajuste-supressao").checked = a.suprimirRuido;
  $("ajuste-agc").checked = a.ganhoAutomatico;
  $("ajuste-continuo").checked = a.bandaLarga;
  $("ajuste-som-da-tela").checked = estado.audioDaTela;

  for (const [i, botao] of [...$("ajuste-bitrate").children].entries()) {
    botao.setAttribute("aria-pressed", BITRATES_AUDIO[i].valor === a.bitrate ? "true" : "false");
  }
  for (const botao of $("ajuste-perfil").children) {
    botao.setAttribute(
      "aria-pressed",
      botao.dataset.perfil === estado.perfilTela ? "true" : "false"
    );
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

  const encher = (campo, lista, escolhido, padrao) => {
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
  };

  const atual = motor.config;
  estado.audio.entrada = atual.entrada;
  encher($("ajuste-entrada"), entradas, atual.entrada, "Padrão do sistema");
  encher($("ajuste-saida"), saidas, atual.saida, "Padrão do sistema");
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
  desligar();
  if (estado.hospedando) invocar("encerrar_hospedagem").catch(() => {});
});

carregarPreferencias();
prepararEntrada();

// Um link clicado com o CALL já aberto chega por evento; um link que abriu o
// CALL já está guardado antes desta linha rodar. Os dois entram pela mesma
// porta.
window.__TAURI__?.event?.listen("convite", receberConvite);
receberConvite();

procurarAtualizacao();
setInterval(procurarAtualizacao, INTERVALO_ATUALIZACAO);
