/**
 * A partida do CALL no celular.
 *
 * Este arquivo faz cinco coisas e nenhuma delas é regra de negócio:
 *
 * 1. Carrega as preferências e decide quem entra direto e quem vê o portal.
 * 2. Monta as três abas e a navegação em pilha.
 * 3. Mantém a tira da call viva no rodapé enquanto a chamada existe.
 * 4. Atende o convite que veio no link.
 * 5. Registra o Service Worker, que é o que faz o aplicativo abrir instalado.
 *
 * O resto mora em `nucleo.js` (o que o aplicativo é) e em `telas/` (o que ele
 * mostra).
 */

import { Navegacao } from "./navegacao.js";
import {
  el,
  limpar,
  icone,
  vibrar,
  avisar,
  definirTatico,
  acompanharTeclado,
} from "./interacao.js";
import {
  estado,
  conta,
  ouvir,
  emitir,
  carregarPreferencias,
  assumirConta,
  conectarSocial,
  alternarMudo,
  sairDaVoz,
  tempoDeCallEmTexto,
  acharCanal,
  VERSAO,
} from "./nucleo.js";
import { abrirPortal, atenderVoltaDoGoogle } from "./telas/portal.js";
import { telaDeGrupos, entrarPorConvite } from "./telas/grupos.js";
import { telaDeAmigos } from "./telas/amigos.js";
import { telaDeVoce } from "./telas/voce.js";
import { abrirCall, fecharCall, callAberta } from "./telas/call.js";
import { NOTAS_DO_CELULAR } from "./notas.js";

/* ═══ Abertura ══════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

carregarPreferencias();
definirTatico(estado.tatico);
acompanharTeclado();

/** O convite que veio no link, esperando o aplicativo ficar de pé. */
const convitePendente = (() => {
  const parametros = new URLSearchParams(location.search);
  const bruto = (parametros.get("convite") ?? parametros.get("c") ?? "").trim();
  if (!bruto) return "";
  // Limpa a barra de endereço: recarregar não deve reentrar no grupo.
  const url = new URL(location.href);
  url.searchParams.delete("convite");
  url.searchParams.delete("c");
  history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
  return bruto.toUpperCase();
})();

let navegacao = null;

comecar();

async function comecar() {
  // A volta do Google chega como `?code=` nesta mesma página, e precisa ser
  // atendida antes de qualquer decisão sobre mostrar o portal.
  const daVoltaDoGoogle = await atenderVoltaDoGoogle();

  if (!daVoltaDoGoogle) await retomarSessao();

  const precisaDoPortal = !estado.conta && !estado.apelido;
  if (precisaDoPortal) {
    esconderAbertura();
    await abrirPortal();
  }

  montarAplicativo();
  esconderAbertura();

  conectarSocial();
  registrarTrabalhador();

  if (convitePendente) {
    avisar("Entrando pelo convite…");
    entrarPorConvite(navegacao, convitePendente);
  }
}

/**
 * Confere a sessão guardada, em silêncio.
 *
 * Uma sessão recusada — vencida, ou derrubada de outro aparelho — não é erro
 * a mostrar: é simplesmente alguém que vai ver o portal.
 */
async function retomarSessao() {
  const guardada = conta.sessaoGuardada();
  if (!guardada || guardada.servidor !== estado.servidor) return;

  try {
    const sessao = await conta.retomar(estado.servidor, guardada.token);
    if (sessao) assumirConta({ ...sessao, token: sessao.token ?? guardada.token });
    else conta.esquecerSessao();
  } catch {
    // Servidor fora do ar não é sessão inválida: o token continua guardado, e
    // a próxima abertura tenta de novo. Quem não tem apelido vê o portal.
  }
}

function esconderAbertura() {
  const abertura = $("abertura");
  if (!abertura || abertura.dataset.saindo !== undefined) return;
  abertura.dataset.saindo = "";
  setTimeout(() => abertura.remove(), 320);
}

/* ═══ Abas e pilhas ═════════════════════════════════════════════ */

const ABAS = [
  { nome: "grupos", rotulo: "Grupos", icone: "grupos" },
  { nome: "amigos", rotulo: "Amigos", icone: "amigos" },
  { nome: "voce", rotulo: "Você", icone: "voce" },
];

function montarAplicativo() {
  $("app").hidden = false;

  navegacao = new Navegacao($("pilha"), ABAS.map((aba) => aba.nome), {
    aoTrocarAba: pintarAbas,
  });

  navegacao.definirRaiz("grupos", telaDeGrupos(navegacao));
  navegacao.definirRaiz("amigos", telaDeAmigos(navegacao));
  navegacao.definirRaiz("voce", telaDeVoce(navegacao));

  montarBarraDeAbas();
  pintarAbas();

  ouvir("erro", (motivo) => avisar(motivo, "erro"));
  ouvir("aviso", (texto) => avisar(texto));
  ouvir("naolidos", pintarAbas);
  ouvir("amigos", pintarAbas);
  ouvir("perfil", pintarAbas);

  ouvir("voz", () => {
    if (!estado.canalVoz) fecharCall();
    atualizarTira();
  });
  ouvir("call", atualizarTira);
  ouvir("relogio", atualizarTira);
  ouvir("membros", atualizarTira);

  ouvir("conexao", (situacao) => {
    if (situacao === "reconectando") avisar("A conexão caiu. Tentando voltar…");
    else if (situacao === true && barraDeConexaoMostrada) avisar("Conexão restabelecida.", "bom");
    barraDeConexaoMostrada = situacao === "reconectando";
  });

  atualizarTira();
}

let barraDeConexaoMostrada = false;

function montarBarraDeAbas() {
  const barra = $("abas");
  limpar(barra);

  for (const aba of ABAS) {
    const marca = el("span", { class: "aba__marca", hidden: true });
    const botao = el(
      "button",
      {
        class: "aba",
        type: "button",
        role: "tab",
        dataset: { aba: aba.nome },
        "aria-selected": String(navegacao.aba === aba.nome),
        onclick: () => {
          vibrar("leve");
          // Tocar na aba em que já se está volta ao topo dela — o mesmo
          // atalho que todo app de celular tem, e que ninguém documenta.
          if (navegacao.aba === aba.nome) navegacao.voltarAoInicio();
          else navegacao.trocarAba(aba.nome);
          pintarAbas();
        },
      },
      icone(aba.icone),
      el("span", null, aba.rotulo),
      marca
    );
    barra.append(botao);
  }
}

function pintarAbas() {
  const barra = $("abas");
  if (!barra.children.length) return;

  const naoLidasDeGrupos = [...estado.naoLidos.entries()]
    .filter(([chave]) => !chave.startsWith("conta-"))
    .reduce((soma, [, quantas]) => soma + quantas, 0);
  const naoLidasDeAmigos = [...estado.naoLidos.entries()]
    .filter(([chave]) => chave.startsWith("conta-"))
    .reduce((soma, [, quantas]) => soma + quantas, 0);
  const pedidos = estado.pedidosAmigo.length;
  const notasNovas = estado.ultimaVersaoNotasVista !== (NOTAS_DO_CELULAR[0]?.versao ?? null);

  const contagens = {
    grupos: naoLidasDeGrupos,
    amigos: naoLidasDeAmigos + pedidos,
    voce: notasNovas ? -1 : 0,
  };

  for (const botao of barra.children) {
    const nome = botao.dataset.aba;
    botao.setAttribute("aria-selected", String(navegacao.aba === nome));
    const marca = botao.querySelector(".aba__marca");
    const valor = contagens[nome] ?? 0;
    marca.classList.toggle("aba__marca--ponto", valor === -1);
    marca.textContent = valor > 0 ? (valor > 99 ? "99+" : String(valor)) : "";
    marca.hidden = valor === 0;
  }
}

/* ═══ A tira da call ════════════════════════════════════════════ */

/**
 * A faixa que fica acima das abas enquanto a chamada acontece fora da tela.
 *
 * É o que permite recolher a call e continuar no aplicativo sem medo de tê-la
 * perdido: ela continua ali, com o tempo correndo, o botão de mudo à mão e um
 * toque para voltar.
 */
function atualizarTira() {
  const tira = $("tira-call");
  const dentro = Boolean(estado.canalVoz);
  const escondida = !dentro || callAberta();

  if (escondida) {
    tira.hidden = true;
    limpar(tira);
    return;
  }

  const canal = acharCanal(estado.canalVoz);

  if (tira.hidden || !tira.children.length) {
    tira.hidden = false;
    limpar(tira).append(
      el(
        "button",
        {
          class: "tira-call__toque",
          type: "button",
          onclick: () => {
            vibrar("leve");
            abrirCall(navegacao);
          },
        },
        el(
          "span",
          { class: "tira-call__onda", "aria-hidden": "true" },
          el("i"),
          el("i"),
          el("i"),
          el("i")
        ),
        el(
          "span",
          { class: "tira-call__dizeres" },
          el("span", { class: "tira-call__canal" }, canal?.nome ?? "Na call"),
          el("span", { class: "tira-call__estado" }, tempoDeCallEmTexto())
        )
      ),
      el(
        "button",
        {
          class: "tira-call__botao",
          type: "button",
          "aria-label": "Microfone",
          onclick: (evento) => {
            evento.stopPropagation();
            vibrar("medio");
            alternarMudo();
          },
        },
        icone(estado.mudo ? "microfone-mudo" : "microfone")
      ),
      el(
        "button",
        {
          class: "tira-call__botao tira-call__botao--sair",
          type: "button",
          "aria-label": "Sair da call",
          onclick: (evento) => {
            evento.stopPropagation();
            vibrar("pesado");
            sairDaVoz(true);
          },
        },
        icone("desligar")
      )
    );
  }

  // Isto roda a cada segundo, pelo relógio da call: só texto, e o ícone
  // apenas quando o mudo de fato virou. Recriar o SVG a cada tique seriam
  // sessenta nós por minuto para desenhar a mesma coisa.
  tira.querySelector(".tira-call__canal").textContent = canal?.nome ?? "Na call";
  tira.querySelector(".tira-call__estado").textContent = tempoDeCallEmTexto();
  tira.toggleAttribute("data-mudo", estado.mudo);

  const botaoMudo = tira.querySelector(".tira-call__botao");
  const mudoAgora = estado.mudo ? "sim" : "nao";
  if (botaoMudo.dataset.mudo !== mudoAgora) {
    botaoMudo.dataset.mudo = mudoAgora;
    botaoMudo.toggleAttribute("data-ligado", estado.mudo);
    limpar(botaoMudo).append(icone(estado.mudo ? "microfone-mudo" : "microfone"));
  }
}

/* ═══ Service Worker ════════════════════════════════════════════ */

/**
 * Sem ele o aplicativo não é instalável e não abre sem rede.
 *
 * Não registramos em `localhost` a menos que se peça com `?sw=1`: durante o
 * desenvolvimento, um trabalhador servindo a versão em cache é meia hora
 * perdida procurando um defeito que já foi corrigido.
 */
function registrarTrabalhador() {
  if (!("serviceWorker" in navigator)) return;

  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const forcado = new URLSearchParams(location.search).has("sw");
  if (local && !forcado) return;

  navigator.serviceWorker
    .register("sw.js", { scope: "./" })
    .then((registro) => {
      registro.addEventListener("updatefound", () => {
        const novo = registro.installing;
        novo?.addEventListener("statechange", () => {
          // Só avisa quando havia uma versão anterior: numa instalação nova
          // "atualização disponível" não quer dizer nada.
          if (novo.state === "installed" && navigator.serviceWorker.controller) {
            avisar("Uma versão nova do CALL está pronta. Feche e abra para usá-la.", "bom", 6000);
          }
        });
      });
    })
    .catch((erro) => console.warn("[sw] não registrou", erro));
}

/* ═══ Ciclo de vida da página ═══════════════════════════════════ */

/**
 * Sair da página no meio de uma call é o único caso em que o aplicativo
 * pergunta alguma coisa ao navegador — e ele só pergunta porque fechar sem
 * avisar deixaria a pessoa "presa" na sala para os outros até o socket cair.
 */
window.addEventListener("beforeunload", (evento) => {
  if (!estado.canalVoz) return;
  evento.preventDefault();
  evento.returnValue = "";
});

// Voltar à aba depois de um tempo fora: reconferir presenças e amigos, que
// podem ter mudado enquanto o aparelho dormia.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  emitir("membros");
  if (estado.conta) conectarSocial();
});

// Deixado à mão para diagnóstico: `window.CALL.estado` no console conta o que
// o aplicativo acha que está acontecendo, sem precisar de ferramenta nenhuma.
window.CALL = { estado, versao: VERSAO, navegacao: () => navegacao };
