/**
 * A conversa — canal de texto do grupo, ou mensagem privada com um amigo.
 *
 * Uma tela só para os dois casos, porque para quem usa eles *são* a mesma
 * coisa: um histórico que rola, um campo embaixo, e o teclado subindo. O que
 * muda é para onde a mensagem vai, e isso o núcleo já decide sozinho a partir
 * de `estado.conversaPrivada`.
 *
 * ## Três decisões que fazem a diferença aqui
 *
 * - **Rolar sozinho só quando faz sentido.** Chegou mensagem e você estava
 *   no fim? Desce. Estava lendo o que passou? Fica, e aparece um botão
 *   discreto dizendo que tem coisa nova embaixo. Rolar por baixo do dedo de
 *   quem está lendo é o defeito mais irritante de um chat.
 * - **Redesenho por mensagem, não da lista inteira.** Uma mensagem nova
 *   acrescenta um bloco; uma reação repinta uma fileira de pílulas. Refazer
 *   as 500 mensagens a cada evento faria a tela piscar e perder a posição.
 * - **Ações por toque longo.** Não há hover no celular: o menu da mensagem
 *   sai de segurar o dedo em cima dela, que é o gesto que todo mundo já
 *   tenta.
 */

import { montarTela } from "../navegacao.js";
import {
  el,
  limpar,
  vibrar,
  avisar,
  icone,
  acao,
  menu,
  confirmar,
  pressaoLonga,
  vazio,
} from "../interacao.js";
import { avatar, textoComEmoji, desenharReacoes, abrirEmojis } from "../visual.js";
import { acharEmoji } from "../../src/emojis.js";
import {
  estado,
  assinar,
  abrirCanalTexto,
  abrirConversaPrivada,
  fecharConversa,
  enviarMensagem,
  alterarMensagem,
  reagir,
  acharCanal,
  entrarNaVoz,
  AGRUPAR_MS,
  HORA,
  DIA,
  DIA_COM_ANO,
} from "../nucleo.js";
import { copiar } from "./grupos.js";
import { abrirCall } from "./call.js";

/**
 * @param alvo `{ canal }` para um canal de texto, `{ amigo }` para uma PV.
 */
export function abrirConversa(nav, alvo) {
  const chave = alvo.canal ?? alvo.amigo;
  const ehPrivada = Boolean(alvo.amigo);

  if (ehPrivada) abrirConversaPrivada(alvo.amigo);
  else abrirCanalTexto(alvo.canal);

  const canal = ehPrivada ? null : acharCanal(alvo.canal);
  const amigo = ehPrivada ? estado.amigos.find((a) => a.id === alvo.amigo) : null;

  const lista = el("div", { class: "conversa" });
  const tela = montarTela({
    titulo: ehPrivada ? (amigo?.apelido ?? "Conversa") : (canal?.nome ?? "Canal"),
    legenda: ehPrivada ? "Mensagem privada" : estado.grupo?.nome,
    voltar: () => nav.voltar(),
    acoes: canalDeVozIrmao() ? [acao("voz", "Entrar na voz", entrarNaVozDoGrupo)] : [],
    corpoProprio: lista,
  });

  /* ── Compositor ──────────────────────────────────────────────── */

  const campo = el("textarea", {
    class: "compositor__campo",
    rows: 1,
    placeholder: ehPrivada ? "Mensagem" : `Escrever em ${canal?.nome ?? "canal"}`,
    maxlength: 2000,
    enterkeyhint: "send",
    autocapitalize: "sentences",
  });

  const botaoEnviar = el(
    "button",
    {
      class: "compositor__enviar",
      type: "button",
      "aria-label": "Enviar",
      dataset: { vazio: true },
      onclick: () => enviar(),
    },
    icone("enviar")
  );

  const botaoEmoji = el(
    "button",
    {
      class: "compositor__botao",
      type: "button",
      "aria-label": "Emoji",
      onclick: () => {
        vibrar("leve");
        // Emoji do sistema entra como o próprio caractere; os cinco do CALL
        // entram como `:nome:`, que a mensagem publicada vira desenho.
        abrirEmojis((id) => inserirNoCampo(acharEmoji(id)?.nativo === false ? `:${id}:` : id));
      },
    },
    icone("emoji")
  );

  const barraDeContexto = el("div", { class: "contexto-compositor" });
  barraDeContexto.hidden = true;

  const compositor = el(
    "div",
    { class: "compositor" },
    el("div", { class: "compositor__caixa" }, campo, botaoEmoji),
    botaoEnviar
  );

  tela.elemento.append(barraDeContexto, compositor);

  /** Quando não está vazio, o que se está editando. */
  let editando = null;

  function ajustarAltura() {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(116, campo.scrollHeight)}px`;
  }

  function refletirCompositor() {
    const vazioAgora = campo.value.trim().length === 0;
    botaoEnviar.toggleAttribute("data-vazio", vazioAgora);
    ajustarAltura();
  }

  campo.addEventListener("input", refletirCompositor);
  campo.addEventListener("keydown", (evento) => {
    // Teclado físico (tablet com capa): Enter envia, Shift+Enter quebra linha.
    if (evento.key === "Enter" && !evento.shiftKey && !evento.isComposing) {
      evento.preventDefault();
      enviar();
    }
    if (evento.key === "Escape" && editando) cancelarEdicao();
  });
  campo.addEventListener("focus", () => setTimeout(() => descerAoFim(true), 120));

  function inserirNoCampo(texto) {
    const inicio = campo.selectionStart ?? campo.value.length;
    const fim = campo.selectionEnd ?? campo.value.length;
    campo.value = campo.value.slice(0, inicio) + texto + campo.value.slice(fim);
    campo.selectionStart = campo.selectionEnd = inicio + texto.length;
    campo.focus();
    refletirCompositor();
  }

  function enviar() {
    const texto = campo.value.trim();
    if (!texto) return;

    if (editando) {
      alterarMensagem("editar", editando, texto);
      cancelarEdicao();
      return;
    }
    if (!enviarMensagem(texto)) {
      avisar("Sem conexão com o canal agora.", "erro");
      return;
    }
    campo.value = "";
    refletirCompositor();
    vibrar("leve");
    grudarNoFim = true;
    descerAoFim(true);
  }

  function comecarEdicao(mensagem) {
    editando = mensagem.id;
    campo.value = mensagem.texto;
    refletirCompositor();
    campo.focus();
    limpar(barraDeContexto).append(
      icone("lapis"),
      el("span", null, "Editando mensagem"),
      el(
        "button",
        { class: "compositor__botao", type: "button", "aria-label": "Cancelar", onclick: cancelarEdicao },
        icone("fechar")
      )
    );
    barraDeContexto.hidden = false;
  }

  function cancelarEdicao() {
    editando = null;
    campo.value = "";
    barraDeContexto.hidden = true;
    refletirCompositor();
  }

  /* ── Rolagem ─────────────────────────────────────────────────── */

  /** Verdadeiro enquanto a pessoa está lendo o fim da conversa. */
  let grudarNoFim = true;

  const botaoDescer = el(
    "button",
    {
      class: "flutuante",
      type: "button",
      "aria-label": "Ir para a última mensagem",
      style: { width: "44px", height: "44px", borderRadius: "50%", bottom: "84px", opacity: "0", pointerEvents: "none" },
      onclick: () => {
        grudarNoFim = true;
        descerAoFim(true);
      },
    },
    icone("descer")
  );
  tela.elemento.append(botaoDescer);

  lista.addEventListener(
    "scroll",
    () => {
      const folga = lista.scrollHeight - lista.scrollTop - lista.clientHeight;
      grudarNoFim = folga < 60;
      botaoDescer.style.opacity = grudarNoFim ? "0" : "1";
      botaoDescer.style.pointerEvents = grudarNoFim ? "none" : "auto";
      tela.cabecalho?.toggleAttribute("data-rolado", lista.scrollTop > 4);
    },
    { passive: true }
  );

  function descerAoFim(suave = false) {
    lista.scrollTo({ top: lista.scrollHeight, behavior: suave ? "smooth" : "auto" });
  }

  /* ── Desenho ─────────────────────────────────────────────────── */

  /** id da mensagem -> elemento, para repintar reação sem refazer a lista. */
  const linhas = new Map();
  let ultimaDesenhada = null;

  function desenharTudo() {
    limpar(lista);
    linhas.clear();
    ultimaDesenhada = null;

    const mensagens = estado.mensagens.get(chave);
    if (!mensagens) {
      lista.append(carregando());
      return;
    }
    if (!mensagens.length) {
      lista.append(
        vazio(
          ehPrivada ? "amigos" : "texto",
          ehPrivada ? "Comecem a conversa" : `Bem-vindo a ${canal?.nome ?? "este canal"}`,
          ehPrivada
            ? "Nada aqui ainda. A primeira mensagem é sua."
            : "Este é o começo do canal. Diga alguma coisa."
        )
      );
      return;
    }

    const fragmento = document.createDocumentFragment();
    for (const mensagem of mensagens) fragmento.append(...blocoDe(mensagem));
    lista.append(fragmento);
    requestAnimationFrame(() => descerAoFim());
  }

  function acrescentar(mensagem) {
    if (!linhas.size && !estado.mensagens.get(chave)?.length) return desenharTudo();
    const vazioAntes = lista.querySelector(".vazio");
    if (vazioAntes) return desenharTudo();

    lista.append(...blocoDe(mensagem));
    if (grudarNoFim) descerAoFim(true);
    else {
      botaoDescer.style.opacity = "1";
      botaoDescer.style.pointerEvents = "auto";
    }
  }

  /** O marco de dia, quando muda, mais a linha da mensagem. */
  function blocoDe(mensagem) {
    const pedacos = [];
    const anterior = ultimaDesenhada;

    if (!anterior || !mesmoDia(anterior.em, mensagem.em)) {
      pedacos.push(el("div", { class: "marco-dia" }, rotuloDeDia(mensagem.em)));
    }

    const seguida =
      anterior &&
      anterior.autor === mensagem.autor &&
      mensagem.em - anterior.em < AGRUPAR_MS &&
      mesmoDia(anterior.em, mensagem.em) &&
      pedacos.length === 0;

    pedacos.push(linhaDeMensagem(mensagem, seguida));
    ultimaDesenhada = mensagem;
    return pedacos;
  }

  function linhaDeMensagem(mensagem, seguida) {
    const minha = mensagem.autor === estado.usuario;
    const areaReacoes = el("div", { class: "reacoes" });
    const corpoTexto = el("div", { class: "mensagem__texto" });

    if (mensagem.excluida) {
      corpoTexto.className = "mensagem__excluida";
      corpoTexto.textContent = "Mensagem excluída";
    } else {
      textoComEmoji(corpoTexto, mensagem.texto);
      if (mensagem.editadaEm) {
        corpoTexto.append(el("span", { class: "mensagem__editada" }, "(editada)"));
      }
    }

    const linha = el(
      "div",
      { class: `mensagem${seguida ? " mensagem--seguida" : ""}`, dataset: { id: mensagem.id } },
      avatar(
        { apelido: mensagem.apelido, avatar: mensagem.avatar, foto: mensagem.foto },
        "mensagem__avatar"
      ),
      el(
        "div",
        { class: "mensagem__corpo" },
        seguida
          ? null
          : el(
              "div",
              { class: "mensagem__cabecalho" },
              el("span", { class: "mensagem__autor" }, mensagem.apelido),
              el("span", { class: "mensagem__hora" }, HORA.format(mensagem.em))
            ),
        corpoTexto,
        areaReacoes
      )
    );

    desenharReacoes(areaReacoes, mensagem.id, mensagem.reacoes, estado.usuario, (emoji) =>
      reagir(mensagem.id, emoji)
    );

    if (!mensagem.excluida) {
      pressaoLonga(linha, () => menuDaMensagem(mensagem, minha, linha));
    }

    linhas.set(mensagem.id, { linha, areaReacoes });
    return linha;
  }

  async function menuDaMensagem(mensagem, minha, linha) {
    linha.dataset.realce = "";
    const escolha = await menu(
      mensagem.apelido,
      [
        { valor: "reagir", rotulo: "Reagir", icone: "emoji" },
        { valor: "copiar", rotulo: "Copiar texto", icone: "copiar" },
        minha ? { valor: "editar", rotulo: "Editar", icone: "lapis" } : null,
        minha ? { valor: "excluir", rotulo: "Excluir", icone: "lixeira", perigo: true } : null,
      ],
      { texto: recorte(mensagem.texto) }
    );
    delete linha.dataset.realce;

    if (escolha === "reagir") abrirReacoesRapidas(mensagem);
    else if (escolha === "copiar") copiar(mensagem.texto, "Mensagem copiada.");
    else if (escolha === "editar") comecarEdicao(mensagem);
    else if (escolha === "excluir") {
      const certeza = await confirmar({
        titulo: "Excluir mensagem?",
        texto: "Ela some para todo mundo no canal.",
        confirmar: "Excluir",
        perigo: true,
      });
      if (certeza) alterarMensagem("excluir", mensagem.id);
    }
  }

  function abrirReacoesRapidas(mensagem) {
    abrirEmojis((id) => reagir(mensagem.id, id), { titulo: "Reagir" });
  }

  /* ── Ações do cabeçalho ──────────────────────────────────────── */

  function canalDeVozIrmao() {
    if (ehPrivada || !estado.grupo) return null;
    return (
      estado.grupo.categorias
        ?.flatMap((categoria) => categoria.canais)
        .find((c) => c.tipo === "voz") ?? null
    );
  }

  async function entrarNaVozDoGrupo() {
    const voz = canalDeVozIrmao();
    if (!voz) return;
    if (estado.canalVoz) {
      abrirCall(nav);
      return;
    }
    try {
      await entrarNaVoz(voz.id);
      abrirCall(nav);
    } catch (erro) {
      if (!erro?.silencioso) avisar(erro.message ?? String(erro), "erro");
    }
  }

  /* ── Ciclo de vida ───────────────────────────────────────────── */

  desenharTudo();

  const cancelar = assinar(
    ["conversa", "mensagem", "reacao", "membros", "grupo"],
    (detalhe, tipo) => {
      if (detalhe?.chave && detalhe.chave !== chave) return;

      if (tipo === "mensagem") {
        acrescentar(detalhe.mensagem);
        return;
      }
      if (tipo === "reacao") {
        const guardada = linhas.get(detalhe.mensagem);
        if (guardada) {
          desenharReacoes(
            guardada.areaReacoes,
            detalhe.mensagem,
            detalhe.reacoes,
            estado.usuario,
            (emoji) => reagir(detalhe.mensagem, emoji)
          );
        }
        return;
      }
      desenharTudo();
    }
  );

  return {
    ...tela,
    semAbas: true,
    aoEntrar() {
      if (ehPrivada) abrirConversaPrivada(alvo.amigo);
      else abrirCanalTexto(alvo.canal);
      requestAnimationFrame(() => descerAoFim());
    },
    aoSair() {
      fecharConversa();
    },
    aoDestruir() {
      cancelar();
      fecharConversa();
    },
  };
}

/* ═══ Miudezas ══════════════════════════════════════════════════ */

const mesmoDia = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function rotuloDeDia(em) {
  const data = new Date(em);
  const hoje = new Date();
  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);

  if (mesmoDia(data, hoje)) return "Hoje";
  if (mesmoDia(data, ontem)) return "Ontem";
  return data.getFullYear() === hoje.getFullYear() ? DIA.format(data) : DIA_COM_ANO.format(data);
}

const recorte = (texto) => {
  const limpo = String(texto ?? "").replace(/\s+/g, " ").trim();
  return limpo.length > 90 ? `${limpo.slice(0, 90)}…` : limpo;
};

/** Três blocos cinza pulsando: melhor que uma roda girando no vazio, porque
 *  já mostra a forma do que está chegando. */
function carregando() {
  const caixa = el("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "12px 4px" } });
  for (let i = 0; i < 5; i++) {
    caixa.append(
      el(
        "div",
        { style: { display: "flex", gap: "10px", alignItems: "flex-start" } },
        el("div", { class: "esqueleto", style: { width: "36px", height: "36px", borderRadius: "50%", flex: "none" } }),
        el(
          "div",
          { style: { flex: "1", display: "flex", flexDirection: "column", gap: "6px" } },
          el("div", { class: "esqueleto", style: { width: "34%", height: "11px" } }),
          el("div", { class: "esqueleto", style: { width: `${55 + ((i * 13) % 40)}%`, height: "13px" } })
        )
      )
    );
  }
  return caixa;
}
