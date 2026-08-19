/**
 * O soundboard do grupo.
 *
 * Uma biblioteca de clipes curtos que qualquer um na call adiciona e toca
 * para todos. Os arquivos ficam no servidor; quem toca decodifica aqui e
 * mistura o som no próprio áudio de saída — quem ouve, ouve pela chamada de
 * verdade, e o servidor nunca repassa um byte de áudio ao vivo.
 *
 * Vive numa folha, e não numa tela empilhada, porque tocar um som é uma
 * interrupção de dois segundos no meio da call — não um lugar aonde se vai.
 */

import { el, limpar, vibrar, avisar, icone, abrirFolha, confirmar, pressaoLonga, vazio } from "../interacao.js";
import {
  estado,
  assinar,
  tocarSomDoGrupo,
  removerSomDoGrupo,
  adicionarSomAoGrupo,
  SOM_BYTES_MAX,
} from "../nucleo.js";

export function abrirSoundboard() {
  const grade = el("div", { class: "sons" });
  const escolherArquivo = el("input", {
    type: "file",
    accept: "audio/*",
    style: { display: "none" },
  });

  escolherArquivo.addEventListener("change", async () => {
    const arquivo = escolherArquivo.files?.[0];
    escolherArquivo.value = "";
    if (!arquivo) return;
    try {
      await adicionarSomAoGrupo(arquivo);
      vibrar("sucesso");
      avisar("Som enviado para o grupo.", "bom");
    } catch (erro) {
      avisar(erro.message ?? String(erro), "erro");
    }
  });

  function desenhar() {
    limpar(grade);

    if (!estado.sons.length) {
      grade.style.display = "block";
      grade.append(
        vazio(
          "soundboard",
          "Nenhum som ainda",
          `Envie um clipe curto (até ${Math.round(SOM_BYTES_MAX / 1024)} KB) e ele fica disponível para todo mundo do grupo.`
        )
      );
      return;
    }
    grade.style.display = "grid";

    for (const som of estado.sons) {
      const botao = el(
        "button",
        {
          class: "som",
          type: "button",
          onclick: async () => {
            vibrar("medio");
            botao.disabled = true;
            try {
              await tocarSomDoGrupo(som);
            } catch (erro) {
              avisar(erro.message ?? String(erro), "erro");
            } finally {
              botao.disabled = false;
            }
          },
        },
        icone("soundboard"),
        el("span", { class: "som__nome" }, som.nome)
      );

      // Só quem enviou pode remover — a mesma regra do servidor, repetida
      // aqui para não oferecer um botão que voltaria recusado.
      if (som.dono === estado.usuario) {
        pressaoLonga(botao, async () => {
          const certeza = await confirmar({
            titulo: `Remover "${som.nome}"?`,
            texto: "Ele sai da biblioteca do grupo para todo mundo.",
            confirmar: "Remover",
            perigo: true,
          });
          if (certeza) removerSomDoGrupo(som);
        });
      }

      grade.append(botao);
    }
  }

  desenhar();
  const cancelar = assinar(["sons"], desenhar);

  const folha = abrirFolha({
    titulo: "Soundboard",
    texto: "Toque para tocar para todo mundo na call. Segure num som seu para removê-lo.",
    conteudo: [grade, escolherArquivo],
    corpoLiso: true,
    acoes: [
      el(
        "button",
        {
          class: "botao botao--fantasma",
          type: "button",
          onclick: () => escolherArquivo.click(),
        },
        icone("mais"),
        "Adicionar um som"
      ),
    ],
    aoFechar: cancelar,
  });

  return folha;
}
