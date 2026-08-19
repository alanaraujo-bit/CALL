/**
 * A aba Você: quem você é, e tudo que se ajusta.
 *
 * O topo é o retrato — grande, com o apelido e a bio, porque é isso que os
 * outros veem, e a maneira mais curta de dizer "isto aqui é você" é mostrar.
 * Abaixo, os ajustes em grupos, cada um abrindo uma tela própria: uma tela de
 * ajustes de celular com trinta linhas seguidas é uma tela que ninguém lê.
 */

import { montarTela } from "../navegacao.js";
import {
  el,
  limpar,
  vibrar,
  avisar,
  icone,
  acao,
  linha,
  chave,
  grupo as grupoDeLinhas,
  confirmar,
  perguntar,
  abrirFolha,
  definirTatico,
  vazio,
} from "../interacao.js";
import { avatar } from "../visual.js";
import {
  estado,
  assinar,
  emitir,
  salvarPreferencias,
  sairDaConta,
  motor,
  pedirMicrofone,
  pedirMeuFeedback,
  enviarFeedback,
  conectarSocial,
  VERSAO,
  SITE,
} from "../nucleo.js";
import { BITRATES_AUDIO } from "../../src/audio.js";
import { NOTAS_DE_VERSAO } from "../../src/notas-de-versao.js";
import { NOTAS_DO_CELULAR } from "../notas.js";
import { ROTULOS_CATEGORIA, ROTULOS_STATUS } from "../../src/feedback.js";
import { editarPerfil } from "./pessoas.js";
import { abrirPortal } from "./portal.js";
import { copiar } from "./grupos.js";
import { podeInstalar, convidarAInstalar, instalado } from "./instalar.js";

/* ═══ A aba ═════════════════════════════════════════════════════ */

export function telaDeVoce(nav) {
  const tela = montarTela({
    titulo: "Você",
    acoes: [acao("lapis", "Editar perfil", () => editarPerfil())],
  });

  const corpo = el("div");
  tela.corpo.append(corpo);

  function desenhar() {
    limpar(corpo);

    corpo.append(
      el(
        "div",
        { class: "retrato" },
        el(
          "div",
          {
            class: "retrato__moldura",
            onclick: () => {
              vibrar("leve");
              editarPerfil();
            },
          },
          avatar(
            { apelido: estado.apelido, avatar: estado.avatar, foto: estado.foto },
            "avatar avatar--enorme"
          ),
          el("span", { class: "retrato__editar" }, icone("lapis"))
        ),
        el("p", { class: "retrato__nome" }, estado.apelido || "Sem apelido"),
        estado.bio ? el("p", { class: "retrato__bio" }, estado.bio) : null,
        el(
          "span",
          { class: "retrato__selo" },
          icone(estado.conta ? "usuario" : "informacao"),
          estado.conta ? estado.conta.email : "Sem conta — só neste aparelho"
        )
      )
    );

    corpo.append(
      grupoDeLinhas(
        "Preferências",
        linha({
          titulo: "Voz e microfone",
          legenda: "Entrada, qualidade e filtros",
          icone: "microfone",
          tintaIcone: "tinta",
          seta: true,
          aoTocar: () => nav.empilhar(telaDeVoz(nav)),
        }),
        linha({
          titulo: "Retorno tátil",
          legenda: "A vibração curta a cada toque",
          icone: "ondas",
          direita: chave(estado.tatico, (ligado) => {
            estado.tatico = ligado;
            definirTatico(ligado);
            salvarPreferencias();
          }),
        })
      )
    );

    corpo.append(
      grupoDeLinhas(
        "Conta",
        estado.conta
          ? linha({
              titulo: "Código de amigo",
              legenda: "Toque para copiar e mandar para alguém",
              icone: "chave",
              aoTocar: () => copiar(estado.conta.id, "Código copiado."),
            })
          : linha({
              titulo: "Criar conta ou entrar",
              legenda: "Para levar seus grupos a outro aparelho",
              icone: "entrar",
              tintaIcone: "tinta",
              seta: true,
              aoTocar: async () => {
                // O mesmo portal da primeira abertura, por cima do que estiver
                // na tela. Ele resolve quando alguém entra, e o que ele mudou
                // já chegou pelos eventos — só falta repintar esta aba.
                await abrirPortal();
                desenhar();
                conectarSocial();
              },
            }),
        linha({
          titulo: "Servidor",
          legenda: estado.servidor,
          icone: "servidor",
          seta: true,
          aoTocar: trocarServidor,
        }),
        estado.conta
          ? linha({
              titulo: "Sair da conta",
              icone: "sair",
              tintaIcone: "perigo",
              perigo: true,
              aoTocar: async () => {
                const certeza = await confirmar({
                  titulo: "Sair da conta?",
                  texto:
                    "Seus grupos continuam na conta e voltam quando você entrar de novo — neste ou em outro aparelho.",
                  confirmar: "Sair da conta",
                  perigo: true,
                });
                if (!certeza) return;
                await sairDaConta();
                avisar("Você saiu da conta.");
                location.reload();
              },
            })
          : null
      )
    );

    corpo.append(
      grupoDeLinhas(
        "CALL",
        !instalado() && podeInstalar()
          ? linha({
              titulo: "Instalar na tela de início",
              legenda: "Abrir em tela cheia, como aplicativo",
              icone: "adicionar-inicio",
              tintaIcone: "tinta",
              seta: true,
              aoTocar: convidarAInstalar,
            })
          : null,
        linha({
          titulo: "Novidades",
          legenda: `Versão ${VERSAO}`,
          icone: "novidades",
          seta: true,
          aoTocar: () => nav.empilhar(telaDeNovidades(nav)),
        }),
        linha({
          titulo: "Mandar um retorno",
          legenda: "Bug, sugestão ou elogio",
          icone: "feedback",
          seta: true,
          aoTocar: () => nav.empilhar(telaDeFeedback(nav)),
        }),
        linha({
          titulo: "Baixar para Windows",
          legenda: "O CALL completo, com transmissão de tela",
          icone: "baixar",
          seta: true,
          aoTocar: () => window.open(SITE, "_blank", "noopener"),
        })
      )
    );

    corpo.append(
      el(
        "p",
        {
          style: {
            padding: "6px 24px 30px",
            textAlign: "center",
            fontSize: "12px",
            color: "var(--texto-3)",
            lineHeight: "1.6",
          },
        },
        `CALL para celular · versão ${VERSAO}`,
        el("br"),
        "Áudio e vídeo passam pelo SFU; o servidor do CALL nunca vê o conteúdo da conversa."
      )
    );
  }

  async function trocarServidor() {
    const valores = await perguntar({
      titulo: "Servidor",
      texto:
        "Só mude isto se você hospeda o próprio servidor do CALL. O endereço começa com wss:// ou ws://.",
      campos: [
        {
          nome: "endereco",
          rotulo: "Endereço",
          valor: estado.servidor,
          maximo: 200,
          obrigatorio: true,
          inputmode: "url",
          autocapitalize: "none",
        },
      ],
      confirmar: "Usar este servidor",
    });
    if (!valores) return;
    if (!/^wss?:\/\//i.test(valores.endereco)) {
      avisar("O endereço precisa começar com wss:// ou ws://.", "erro");
      return;
    }
    estado.servidor = valores.endereco.trim();
    salvarPreferencias();
    avisar("Servidor trocado. Reabrindo…");
    setTimeout(() => location.reload(), 700);
  }

  desenhar();
  const cancelar = assinar(["perfil", "conta"], desenhar);
  return { ...tela, aoEntrar: desenhar, aoDestruir: cancelar };
}

/* ═══ Voz ═══════════════════════════════════════════════════════ */

/**
 * Ajustes de voz.
 *
 * O medidor ao vivo é o coração desta tela: ele responde a pergunta que todo
 * ajuste de microfone realmente faz — "está pegando?". Sem ele, mexer em
 * ganho e supressão é apertar botão no escuro.
 */
export function telaDeVoz(nav) {
  const tela = montarTela({ titulo: "Voz e microfone", voltar: () => nav.voltar() });
  const corpo = el("div");
  tela.corpo.append(corpo);

  const barra = el("div", { class: "medidor__barra" });
  const medidor = el("div", { class: "medidor" }, barra);
  const rotuloNivel = el("span", { class: "campo__contador" }, "Desligado");
  let soltarNivel = null;

  /**
   * O medidor só liga quando alguém pede.
   *
   * Abrir o microfone ao entrar nesta tela faria o navegador pedir permissão
   * de microfone para quem só queria ver um ajuste — e no celular esse pedido
   * é uma caixa no meio da tela. Quem quiser conferir se está pegando toca em
   * "Testar", que é o gesto que já autoriza.
   */
  const botaoTestar = el(
    "button",
    {
      class: "botao botao--fantasma botao--largo botao--baixo",
      type: "button",
      style: { marginTop: "10px" },
      onclick: () => (soltarNivel ? desligarMedidor(true) : ligarMedidor()),
    },
    icone("microfone"),
    "Testar o microfone"
  );

  const refletirBotao = () => {
    limpar(botaoTestar).append(
      icone(soltarNivel ? "fechar" : "microfone"),
      soltarNivel ? "Parar o teste" : "Testar o microfone"
    );
  };

  async function ligarMedidor() {
    if (soltarNivel) return;
    try {
      await pedirMicrofone();
      motor.monitorarEntrada(true);
      soltarNivel = motor.assinarNivel((dados) => {
        // De dBFS para uma fração de largura: −70 dB é o chão do que vale a
        // pena mostrar; acima de 0 não há o que medir.
        const fracao = Math.min(1, Math.max(0, (dados.nivel + 70) / 70));
        barra.style.transform = `scaleX(${fracao})`;
        rotuloNivel.textContent = dados.falando ? "Falando" : "Silêncio";
      });
      refletirBotao();
    } catch (erro) {
      rotuloNivel.textContent = "Sem microfone";
      avisar(erro.message ?? String(erro), "erro");
    }
  }

  function desligarMedidor(pedido = false) {
    if (!soltarNivel) return;
    soltarNivel();
    soltarNivel = null;
    motor.monitorarEntrada(false);
    barra.style.transform = "scaleX(0)";
    rotuloNivel.textContent = "Desligado";
    if (pedido) refletirBotao();

    // Só encerra o motor se ninguém mais estiver usando: no meio de uma call,
    // fechá-lo aqui derrubaria a própria voz.
    if (!estado.canalVoz) {
      motor.soltarMicrofone();
      estado.fluxoMicrofone = null;
      motor.encerrar().catch(() => {});
    }
  }

  const aplicar = async (mudancas) => {
    Object.assign(estado.audio, mudancas);
    salvarPreferencias();
    try {
      await motor.aplicar(estado.audio);
    } catch (erro) {
      console.warn("[audio] não deu para aplicar", erro);
    }
  };

  function desenhar() {
    limpar(corpo);

    corpo.append(
      el(
        "div",
        { style: { padding: "6px 20px 4px" } },
        el(
          "div",
          { style: { display: "flex", justifyContent: "space-between", marginBottom: "8px" } },
          el("span", { class: "campo__rotulo" }, "Nível do microfone"),
          rotuloNivel
        ),
        medidor,
        botaoTestar
      )
    );

    const controleGanho = el("input", {
      class: "escala",
      type: "range",
      min: "50",
      max: "150",
      value: String(Math.round(estado.audio.ganhoEntrada * 100)),
      "aria-label": "Volume do microfone",
    });
    const valorGanho = el("span", { class: "campo__contador" }, `${controleGanho.value}%`);
    const pintarGanho = () => {
      controleGanho.style.setProperty(
        "--preenchido",
        `${((Number(controleGanho.value) - 50) / 100) * 100}%`
      );
      valorGanho.textContent = `${controleGanho.value}%`;
    };
    pintarGanho();
    controleGanho.addEventListener("input", () => {
      pintarGanho();
      aplicar({ ganhoEntrada: Number(controleGanho.value) / 100 });
    });

    corpo.append(
      el(
        "div",
        { style: { padding: "10px 20px 4px" } },
        el(
          "div",
          { style: { display: "flex", justifyContent: "space-between", marginBottom: "2px" } },
          el("span", { class: "campo__rotulo" }, "Volume do microfone"),
          valorGanho
        ),
        controleGanho
      )
    );

    corpo.append(
      grupoDeLinhas(
        "Tratamento",
        linha({
          titulo: "Cancelar eco",
          legenda: "Impede que a voz dos outros volte pelo seu microfone",
          legendaQuebra: true,
          direita: chave(estado.audio.cancelarEco, (v) => aplicar({ cancelarEco: v })),
        }),
        linha({
          titulo: "Reduzir ruído",
          legenda: "Ventilador, teclado, rua",
          direita: chave(estado.audio.suprimirRuido, (v) => aplicar({ suprimirRuido: v })),
        }),
        linha({
          titulo: "Ganho automático",
          legenda: "Nivela a sua voz sozinho",
          direita: chave(estado.audio.ganhoAutomatico, (v) => aplicar({ ganhoAutomatico: v })),
        }),
        linha({
          titulo: "Porta de ruído",
          legenda: "Cala o que sobra entre as suas falas",
          direita: chave(estado.audio.porta, (v) => aplicar({ porta: v })),
        })
      )
    );

    corpo.append(
      grupoDeLinhas(
        "Qualidade",
        ...BITRATES_AUDIO.map((opcao) => {
          const escolhida = estado.audio.bitrate === opcao.valor;
          const item = linha({
            titulo: opcao.nome,
            legenda: opcao.detalhe,
            icone: "check",
            tintaIcone: escolhida ? "tinta" : "",
            aoTocar: () => {
              aplicar({ bitrate: opcao.valor });
              desenhar();
            },
          });
          // Invisível, e não ausente: o tique some mas continua ocupando o
          // lugar, e as quatro linhas ficam com o texto no mesmo eixo.
          if (!escolhida) item.querySelector(".linha__icone").style.visibility = "hidden";
          return item;
        })
      )
    );

    corpo.append(
      grupoDeLinhas(
        "Avisos",
        linha({
          titulo: "Sons de entrada e saída",
          legenda: "O sino curto quando alguém chega ou sai da call",
          legendaQuebra: true,
          direita: chave(estado.audio.sons, (v) => aplicar({ sons: v })),
        })
      )
    );

    corpo.append(
      el(
        "p",
        {
          style: {
            padding: "4px 24px 30px",
            fontSize: "12.5px",
            color: "var(--texto-3)",
            lineHeight: "1.6",
          },
        },
        "A saída de som é escolhida pelo sistema do aparelho: trocar para o fone é trocar no próprio celular, e o CALL acompanha."
      )
    );
  }

  desenhar();
  refletirBotao();

  return {
    ...tela,
    aoSair: () => desligarMedidor(),
    aoDestruir: () => desligarMedidor(),
  };
}

/* ═══ Novidades ═════════════════════════════════════════════════ */

export function telaDeNovidades(nav) {
  const tela = montarTela({ titulo: "Novidades", voltar: () => nav.voltar() });

  // As duas cascas, na mesma lista e com o selo dizendo de qual é cada bloco.
  // O produto é um só; as numerações é que são independentes.
  const todas = [
    ...NOTAS_DO_CELULAR.map((nota) => ({ ...nota, casca: "celular" })),
    ...NOTAS_DE_VERSAO.map((nota) => ({ ...nota, casca: "Windows" })),
  ];

  const lista = el("div");
  for (const [indice, nota] of todas.entries()) {
    lista.append(
      el(
        "article",
        { class: "nota" },
        el(
          "div",
          { class: "nota__topo" },
          el("span", { class: "nota__versao" }, `v${nota.versao}`),
          el("span", { class: "nota__selo" }, nota.casca),
          indice === 0 ? el("span", { class: "nota__data" }, "mais recente") : null,
          el("span", { class: "nota__data" }, formatarData(nota.data))
        ),
        el("p", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "4px" } }, nota.titulo),
        nota.resumo
          ? el("p", { style: { fontSize: "14px", color: "var(--texto-2)", lineHeight: "1.5" } }, nota.resumo)
          : null,
        ...(nota.destaques ?? []).map((bloco) =>
          el(
            "div",
            null,
            el("p", { class: "nota__titulo" }, bloco.titulo),
            el(
              "ul",
              { class: "nota__itens" },
              bloco.itens.map((item) => el("li", null, item))
            )
          )
        )
      )
    );
  }
  tela.corpo.append(lista);

  // Abrir a Central marca as notas como lidas: o ponto no menu some.
  estado.ultimaVersaoNotasVista = NOTAS_DO_CELULAR[0]?.versao ?? null;
  salvarPreferencias();
  emitir("perfil");

  return tela;
}

function formatarData(texto) {
  const data = new Date(`${texto}T12:00:00`);
  return Number.isNaN(data.getTime())
    ? texto
    : data.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

/* ═══ Feedback ══════════════════════════════════════════════════ */

export function telaDeFeedback(nav) {
  const tela = montarTela({ titulo: "Seu retorno", voltar: () => nav.voltar() });
  const corpo = el("div");
  tela.corpo.append(corpo);

  let categoria = "sugestao";
  let meus = [];

  const campoTitulo = el("input", {
    class: "campo__entrada",
    maxlength: 80,
    placeholder: "Em uma linha, o que é",
  });
  const campoTexto = el("textarea", {
    class: "campo__area",
    maxlength: 2000,
    rows: 5,
    placeholder: "Conte o que aconteceu, ou o que você queria que existisse.",
  });

  function desenhar() {
    limpar(corpo);

    if (!estado.conta) {
      corpo.append(
        vazio(
          "feedback",
          "Precisa de conta",
          "O retorno fica ligado à sua conta para que a resposta chegue de volta a você."
        )
      );
      return;
    }

    const escolhaCategoria = el(
      "div",
      { class: "segmentado", style: { margin: "8px 20px 0" } },
      ...Object.entries(ROTULOS_CATEGORIA).map(([valor, rotulo]) =>
        el(
          "button",
          {
            class: "segmentado__aba",
            type: "button",
            role: "tab",
            "aria-selected": String(valor === categoria),
            onclick: () => {
              vibrar("leve");
              categoria = valor;
              for (const aba of escolhaCategoria.children) aba.setAttribute("aria-selected", "false");
              escolhaCategoria.querySelector(`[data-valor="${valor}"]`)?.setAttribute("aria-selected", "true");
            },
            dataset: { valor },
          },
          rotulo
        )
      )
    );

    corpo.append(
      el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "8px 20px 20px" } },
        escolhaCategoria,
        el(
          "label",
          { class: "campo" },
          el("span", { class: "campo__rotulo" }, "Assunto"),
          el("div", { class: "campo__caixa" }, campoTitulo)
        ),
        el(
          "label",
          { class: "campo" },
          el("span", { class: "campo__rotulo" }, "Detalhes"),
          campoTexto
        ),
        el(
          "button",
          {
            class: "botao botao--primario botao--largo",
            type: "button",
            onclick: () => {
              const titulo = campoTitulo.value.trim();
              const texto = campoTexto.value.trim();
              if (!titulo || !texto) {
                vibrar("erro");
                avisar("Preencha o assunto e os detalhes.", "erro");
                return;
              }
              enviarFeedback({ categoria, titulo, texto });
            },
          },
          icone("enviar"),
          "Enviar"
        )
      )
    );

    if (meus.length) {
      corpo.append(
        el("div", { class: "secao" }, "Meus envios"),
        el(
          "div",
          { class: "grupo" },
          meus.map((item) =>
            linha({
              titulo: item.titulo,
              legenda: `${ROTULOS_CATEGORIA[item.categoria] ?? item.categoria} · ${
                ROTULOS_STATUS[item.status] ?? item.status
              }`,
              icone: item.status === "finalizado" ? "check" : "relogio",
              tintaIcone: item.status === "finalizado" ? "tinta" : "",
              aoTocar: () =>
                abrirFolha({ titulo: item.titulo, texto: item.texto, corpoLiso: true }),
            })
          )
        )
      );
    }
  }

  desenhar();
  pedirMeuFeedback();

  const cancelar = assinar(["feedback", "conta"], (detalhe) => {
    if (detalhe?.enviado) {
      vibrar("sucesso");
      avisar("Recebido. Obrigado!", "bom");
      campoTitulo.value = "";
      campoTexto.value = "";
      pedirMeuFeedback();
      return;
    }
    if (detalhe?.lista) {
      meus = detalhe.lista;
      desenhar();
    }
    if (detalhe?.atualizado) pedirMeuFeedback();
  });

  return { ...tela, aoDestruir: cancelar };
}
