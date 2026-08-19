/**
 * A aba Amigos: pedidos, lista e as conversas privadas.
 *
 * Amizade mora na conta, não no grupo — funciona com quem você já encontrou
 * em algum grupo ou com um código digitado à mão, sobrevive à troca de grupo
 * e não exige estar em nenhum. Quem não tem conta vê aqui a única tela do
 * aplicativo que pede uma: sem conta não há para onde uma amizade apontar.
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
  perguntar,
  confirmar,
  pressaoLonga,
  vazio,
} from "../interacao.js";
import { avatar } from "../visual.js";
import {
  estado,
  assinar,
  pedirAmigos,
  pedirAmizade,
  responderAmizade,
  removerAmizade,
} from "../nucleo.js";
import { abrirConversa } from "./conversa.js";
import { copiar } from "./grupos.js";
import { mostrarCartao } from "./pessoas.js";

export function telaDeAmigos(nav) {
  const tela = montarTela({
    titulo: "Amigos",
    acoes: [acao("adicionar-pessoa", "Adicionar amigo", adicionar)],
  });

  const corpo = el("div");
  tela.corpo.append(el("h1", { class: "titulao" }, "Amigos"), corpo);

  function desenhar() {
    limpar(corpo);

    if (!estado.conta) {
      corpo.append(
        vazio(
          "amigos",
          "Amigos pedem uma conta",
          "É a conta que dá um endereço fixo a você. Sem ela não há a quem um pedido de amizade chegar.",
          el(
            "button",
            {
              class: "botao botao--primario",
              type: "button",
              style: { marginTop: "8px" },
              onclick: () => nav.trocarAba("voce"),
            },
            icone("usuario"),
            "Ir para a conta"
          )
        )
      );
      return;
    }

    if (estado.pedidosAmigo.length) {
      const caixa = el("div", { class: "grupo" });
      for (const pedido of estado.pedidosAmigo) {
        caixa.append(
          el(
            "div",
            { class: "linha" },
            avatar(pedido),
            el(
              "span",
              { class: "linha__dizeres" },
              el("span", { class: "linha__titulo" }, pedido.apelido),
              el("span", { class: "linha__legenda" }, "Quer ser seu amigo")
            ),
            el(
              "span",
              { style: { display: "flex", gap: "6px" } },
              el(
                "button",
                {
                  class: "acao acao--acento",
                  type: "button",
                  "aria-label": "Aceitar",
                  onclick: () => {
                    vibrar("sucesso");
                    responderAmizade(pedido.de, true);
                  },
                },
                icone("check")
              ),
              el(
                "button",
                {
                  class: "acao acao--perigo",
                  type: "button",
                  "aria-label": "Recusar",
                  onclick: () => {
                    vibrar("leve");
                    responderAmizade(pedido.de, false);
                  },
                },
                icone("fechar")
              )
            )
          )
        );
      }
      corpo.append(
        el("div", { class: "secao" }, `Pedidos (${estado.pedidosAmigo.length})`),
        caixa
      );
    }

    if (!estado.amigos.length) {
      corpo.append(
        vazio(
          "adicionar-pessoa",
          "Nenhum amigo ainda",
          "Compartilhe o seu código de amigo, ou toque em alguém de um grupo para adicionar.",
          el(
            "button",
            {
              class: "botao botao--primario",
              type: "button",
              style: { marginTop: "8px" },
              onclick: adicionar,
            },
            icone("mais"),
            "Adicionar amigo"
          )
        )
      );
      return;
    }

    const lista = el("div", { class: "grupo" });
    for (const amigo of estado.amigos) {
      const naoLidas = estado.naoLidos.get(amigo.id) ?? 0;
      const item = el(
        "button",
        {
          class: "linha",
          type: "button",
          onclick: () => {
            vibrar("leve");
            nav.empilhar(abrirConversa(nav, { amigo: amigo.id }));
          },
        },
        avatar(amigo),
        el(
          "span",
          { class: "linha__dizeres" },
          el("span", { class: "linha__titulo" }, amigo.apelido),
          el("span", { class: "linha__legenda" }, amigo.bio || "Toque para conversar")
        ),
        naoLidas ? el("span", { class: "canal__marca" }, naoLidas > 99 ? "99+" : String(naoLidas)) : null,
        icone("avancar", "linha__seta")
      );
      pressaoLonga(item, () => menuDoAmigo(amigo));
      lista.append(item);
    }

    corpo.append(el("div", { class: "secao" }, `Amigos (${estado.amigos.length})`), lista);

    corpo.append(
      el(
        "div",
        { style: { padding: "10px 20px 30px" } },
        el(
          "button",
          {
            class: "botao botao--fantasma botao--largo botao--baixo",
            type: "button",
            onclick: () => copiar(estado.conta.id, "Seu código de amigo foi copiado."),
          },
          icone("copiar"),
          "Copiar meu código de amigo"
        )
      )
    );
  }

  async function menuDoAmigo(amigo) {
    const escolha = await menu(amigo.apelido, [
      { valor: "conversar", rotulo: "Abrir conversa", icone: "responder" },
      { valor: "perfil", rotulo: "Ver perfil", icone: "usuario" },
      { valor: "remover", rotulo: "Desfazer amizade", icone: "lixeira", perigo: true },
    ]);

    if (escolha === "conversar") nav.empilhar(abrirConversa(nav, { amigo: amigo.id }));
    else if (escolha === "perfil") mostrarCartao({ ...amigo, usuario: amigo.id });
    else if (escolha === "remover") {
      const certeza = await confirmar({
        titulo: `Desfazer amizade com ${amigo.apelido}?`,
        texto: "A conversa privada de vocês continua guardada, mas some daqui.",
        confirmar: "Desfazer",
        perigo: true,
      });
      if (certeza) removerAmizade(amigo.id);
    }
  }

  async function adicionar() {
    if (!estado.conta) {
      avisar("Crie uma conta para adicionar amigos.", "erro");
      return;
    }
    const valores = await perguntar({
      titulo: "Adicionar amigo",
      texto: "Peça o código de amigo da pessoa. O seu está no fim desta tela.",
      campos: [
        {
          nome: "codigo",
          rotulo: "Código de amigo",
          placeholder: "conta-xxxxxxxxxxxx",
          maximo: 40,
          obrigatorio: true,
          autocapitalize: "none",
        },
      ],
      confirmar: "Enviar pedido",
    });
    if (!valores) return;

    const codigo = valores.codigo.trim();
    if (codigo === estado.conta.id) {
      avisar("Esse é o seu próprio código.", "erro");
      return;
    }
    pedirAmizade(codigo);
    vibrar("sucesso");
    avisar("Pedido enviado.", "bom");
  }

  desenhar();
  const cancelar = assinar(["amigos", "conta", "naolidos"], desenhar);

  return {
    ...tela,
    aoEntrar() {
      pedirAmigos();
      desenhar();
    },
    aoDestruir: cancelar,
  };
}
