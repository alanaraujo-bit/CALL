import { Sinal } from "./sinal.js";
import { Malha } from "./rtc.js";

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
};

const audiosRemotos = new Map(); // id -> HTMLAudioElement
const telas = new Map(); // id -> HTMLElement do palco
const linhas = new Map(); // id -> [HTMLElement] que recebem a marca de fala
const medidores = new Map(); // id -> { fonte, analisador, dados, ateQuando, falando }

let contexto = null; // AudioContext, criado só durante a voz
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
  $("botao-transmitir").addEventListener("click", alternarTransmissao);
  $("botao-sair-voz").addEventListener("click", () => sairDaVoz(true));

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
  $("acao-convite").textContent = "copiar";
}

async function copiarConvite() {
  if (!estado.grupo) return;
  try {
    await navigator.clipboard.writeText(estado.grupo.codigo);
    $("acao-convite").textContent = "copiado";
    setTimeout(() => ($("acao-convite").textContent = "copiar"), 1600);
  } catch {
    avisar("Não foi possível copiar. Selecione o código à mão.", "erro");
  }
}

function menuDoGrupo(ancora) {
  const itens = [
    { rotulo: "Copiar convite", acao: copiarConvite },
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

    linha.append(avatar, nome, sinais);
    lista.append(linha);
    registrarLinha(membro.id, linha);
  }
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
  observarVoz(estado.meuId, estado.fluxoMicrofone);

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

  estado.fluxoMicrofone?.getTracks().forEach((t) => t.stop());
  estado.fluxoMicrofone = null;
  estado.mudo = false;

  contexto?.close().catch(() => {});
  contexto = null;
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

async function alternarTransmissao() {
  if (estado.transmitindo) {
    pararTransmissao();
    return;
  }
  if (!estado.canalVoz) return;

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

  // Entre pedir a tela e recebê-la a pessoa pode ter saído da voz. Publicar
  // agora acenderia uma transmissão sem ninguém do outro lado.
  if (!estado.canalVoz) {
    fluxo.getTracks().forEach((t) => t.stop());
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
  telas.set(id, quadro);
  atualizarPalco();
}

function removerTela(id) {
  const quadro = telas.get(id);
  if (!quadro) return;
  quadro.querySelector("video").srcObject = null;
  quadro.remove();
  telas.delete(id);
  atualizarPalco();
}

function atualizarPalco() {
  const total = telas.size;
  $("palco-grade").dataset.quantidade = String(total);
  $("palco").classList.toggle("oculto", total === 0);
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

procurarAtualizacao();
setInterval(procurarAtualizacao, INTERVALO_ATUALIZACAO);
