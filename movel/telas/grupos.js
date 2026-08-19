/**
 * A aba Grupos e a tela de um grupo.
 *
 * São os dois primeiros degraus da navegação: a lista do que existe, e o
 * dentro de um deles. A lista é a primeira coisa que aparece ao abrir o
 * aplicativo, então ela carrega o peso de duas decisões:
 *
 * - **Mostrar movimento.** Um grupo com gente dentro tem um ponto verde e a
 *   contagem. Sem isso, a lista é um armário de pastas; com isso, é o lugar
 *   onde se vê que tem alguém para conversar.
 * - **Ter uma ação óbvia.** O botão redondo no canto abre as duas únicas
 *   maneiras de começar: criar, ou entrar com um convite.
 */

import { montarTela } from "../navegacao.js";
import {
  el,
  anexar,
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
import { marcaDeGrupo, avatar } from "../visual.js";
import {
  estado,
  assinar,
  conectarGrupo,
  esquecerGrupo,
  acharCanal,
  membrosNaVoz,
  linkDoConvite,
  entrarNaVoz,
  criarCategoria,
  criarCanal,
  renomear,
  remover,
  editarGrupoNoServidor,
  souDono,
  falando,
} from "../nucleo.js";
import { abrirConversa } from "./conversa.js";
import { abrirCall } from "./call.js";
import { editarGrupo } from "./pessoas.js";
import { blocoDeInstalacao } from "./instalar.js";

/* ═══ Aba: a lista de grupos ════════════════════════════════════ */

export function telaDeGrupos(nav) {
  const tela = montarTela({
    titulo: "CALL",
    acoes: [acao("mais", "Novo grupo", () => menuDeNovoGrupo(nav))],
  });

  const lista = el("div");
  const flutuante = el(
    "button",
    {
      class: "flutuante",
      type: "button",
      "aria-label": "Criar grupo ou entrar com convite",
      onclick: () => {
        vibrar("medio");
        menuDeNovoGrupo(nav);
      },
    },
    icone("mais")
  );

  // O convite para instalar tem lugar próprio, acima da lista: ele aparece e
  // some por conta dele — `beforeinstallprompt` costuma chegar depois de a
  // tela já estar pintada, e sem um lugar reservado o cartão só apareceria na
  // abertura seguinte.
  const areaDeInstalacao = el("div");
  anexar(tela.corpo, el("h1", { class: "titulao" }, "Grupos"), areaDeInstalacao, lista);
  tela.elemento.append(flutuante);

  function desenharConviteDeInstalacao() {
    anexar(limpar(areaDeInstalacao), blocoDeInstalacao());
  }

  function desenhar() {
    desenharConviteDeInstalacao();
    limpar(lista);

    if (!estado.atalhos.length) {
      lista.append(
        vazio(
          "grupos",
          "Nenhum grupo ainda",
          "Crie o seu ou entre com um código de convite que alguém te mandou.",
          el(
            "button",
            {
              class: "botao botao--primario",
              type: "button",
              style: { marginTop: "8px" },
              onclick: () => menuDeNovoGrupo(nav),
            },
            icone("mais"),
            "Começar"
          )
        )
      );
      return;
    }

    const caixa = el("div", { class: "grupo" });
    for (const atalho of estado.atalhos) {
      const dentro = estado.grupo?.codigo === atalho.codigo;
      const online = estado.presencasGrupos.get(atalho.codigo) ?? 0;

      const cartao = el(
        "button",
        {
          class: "cartao-grupo linha",
          type: "button",
          onclick: () => {
            vibrar("leve");
            abrirGrupo(nav, atalho.codigo);
          },
        },
        marcaDeGrupo(atalho),
        el(
          "span",
          { class: "cartao-grupo__dizeres" },
          el("span", { class: "cartao-grupo__nome" }, atalho.nome || atalho.codigo),
          el(
            "span",
            { class: "cartao-grupo__linha" },
            online > 0 ? el("span", { class: "cartao-grupo__ponto" }) : null,
            online > 0
              ? `${online} ${online === 1 ? "pessoa conectada" : "pessoas conectadas"}`
              : dentro
                ? "Conectado"
                : "Ninguém online agora"
          )
        ),
        icone("avancar", "linha__seta")
      );

      pressaoLonga(cartao, () => menuDoAtalho(nav, atalho));
      caixa.append(cartao);
    }
    lista.append(caixa);
  }

  desenhar();
  const cancelar = assinar(["atalhos", "presencas", "grupo", "conta"], desenhar);
  window.addEventListener("call:instalavel", desenharConviteDeInstalacao);

  return {
    ...tela,
    aoEntrar: desenhar,
    aoDestruir() {
      cancelar();
      window.removeEventListener("call:instalavel", desenharConviteDeInstalacao);
    },
  };
}

/* ═══ Criar, entrar, esquecer ═══════════════════════════════════ */

export async function menuDeNovoGrupo(nav) {
  const escolha = await menu("Novo grupo", [
    {
      valor: "criar",
      rotulo: "Criar um grupo",
      legenda: "Você vira o dono e recebe o código de convite",
      icone: "mais",
    },
    {
      valor: "entrar",
      rotulo: "Entrar com convite",
      legenda: "Cole o código ou o link que te mandaram",
      icone: "convite",
    },
  ]);

  if (escolha === "criar") await criarGrupo(nav);
  else if (escolha === "entrar") await entrarPorConvite(nav);
}

async function criarGrupo(nav) {
  const valores = await perguntar({
    titulo: "Criar grupo",
    texto: "Você vira o dono: só você cria canais e categorias aqui dentro.",
    campos: [
      {
        nome: "nome",
        rotulo: "Nome do grupo",
        placeholder: "Ex.: Sexta à noite",
        maximo: 40,
        obrigatorio: true,
      },
    ],
    confirmar: "Criar",
  });
  if (!valores) return;

  try {
    const boasVindas = await conectarGrupo({ tipo: "criar-grupo", nome: valores.nome });
    vibrar("sucesso");
    avisar("Grupo criado.", "bom");
    abrirTelaDoGrupo(nav, boasVindas.grupo.codigo);
    mostrarConvite(boasVindas.grupo.codigo, boasVindas.grupo.nome);
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  }
}

/** Aceita o código cru ou o link inteiro — quem cola não deveria ter de saber
 *  a diferença entre as duas coisas que o CALL sabe compartilhar. */
function codigoDoQueFoiColado(texto) {
  const limpo = String(texto ?? "").trim();
  const daUrl = /[?&]c=([A-Za-z0-9]{4,20})/.exec(limpo);
  if (daUrl) return daUrl[1].toUpperCase();
  return limpo.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export async function entrarPorConvite(nav, codigoPronto = "") {
  let codigo = codigoPronto;

  if (!codigo) {
    const valores = await perguntar({
      titulo: "Entrar com convite",
      texto: "Cole o código de dez caracteres, ou o link inteiro.",
      campos: [
        {
          nome: "codigo",
          rotulo: "Convite",
          placeholder: "ABCD123456",
          maximo: 120,
          obrigatorio: true,
          autocapitalize: "characters",
        },
      ],
      confirmar: "Entrar",
    });
    if (!valores) return;
    codigo = codigoDoQueFoiColado(valores.codigo);
  }

  if (!codigo) {
    avisar("Esse convite não parece um código.", "erro");
    return;
  }
  if (codigo === estado.grupo?.codigo) {
    avisar("Você já está neste grupo.");
    abrirTelaDoGrupo(nav, codigo);
    return;
  }

  try {
    const boasVindas = await conectarGrupo({ tipo: "entrar", codigo });
    vibrar("sucesso");
    abrirTelaDoGrupo(nav, boasVindas.grupo.codigo);
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  }
}

/** Abre o grupo, conectando antes se ainda não for o grupo corrente. */
export async function abrirGrupo(nav, codigo) {
  if (estado.grupo?.codigo === codigo) {
    abrirTelaDoGrupo(nav, codigo);
    return;
  }
  try {
    await conectarGrupo({ tipo: "entrar", codigo });
    abrirTelaDoGrupo(nav, codigo);
  } catch (erro) {
    avisar(erro.message ?? String(erro), "erro");
  }
}

function abrirTelaDoGrupo(nav, codigo) {
  if (nav.topo?.grupoAberto === codigo) return;
  nav.trocarAba("grupos");
  nav.voltarAoInicio();
  // Um quadro depois: `voltarAoInicio` desempilha pelo histórico, e empilhar
  // no mesmo tique atropelaria a animação de volta.
  setTimeout(() => nav.empilhar(telaDoGrupo(nav, codigo)), 30);
}

async function menuDoAtalho(nav, atalho) {
  const dono = estado.grupo?.codigo === atalho.codigo && souDono();
  const escolha = await menu(atalho.nome || atalho.codigo, [
    { valor: "convite", rotulo: "Compartilhar convite", icone: "compartilhar" },
    { valor: "codigo", rotulo: "Copiar o código", legenda: atalho.codigo, icone: "copiar" },
    dono ? { valor: "editar", rotulo: "Editar o grupo", icone: "lapis" } : null,
    { valor: "esquecer", rotulo: "Sair do grupo", icone: "sair", perigo: true },
  ]);

  if (escolha === "convite") mostrarConvite(atalho.codigo, atalho.nome);
  else if (escolha === "codigo") copiar(atalho.codigo, "Código copiado.");
  else if (escolha === "editar") {
    const campos = await editarGrupo(estado.grupo);
    if (campos) editarGrupoNoServidor(campos);
  } else if (escolha === "esquecer") {
    const certeza = await confirmar({
      titulo: "Sair do grupo?",
      texto: `"${atalho.nome || atalho.codigo}" some da sua lista. Para voltar você vai precisar do convite de novo.`,
      confirmar: "Sair do grupo",
      perigo: true,
    });
    if (!certeza) return;
    esquecerGrupo(atalho.codigo);
    if (nav.profundidade > 1) nav.voltarAoInicio();
  }
}

export async function copiar(texto, recado = "Copiado.") {
  try {
    await navigator.clipboard.writeText(texto);
    vibrar("sucesso");
    avisar(recado, "bom");
    return true;
  } catch {
    avisar("Este navegador não deixou copiar. Toque e segure para copiar à mão.", "erro");
    return false;
  }
}

/**
 * O convite.
 *
 * `navigator.share` é o caminho certo no celular: ele abre o WhatsApp, o
 * Telegram e a lista de contatos do próprio sistema, que é onde o convite de
 * verdade acaba indo. Quando não existe, sobra copiar — e copiar o **link**,
 * não o código, porque quem recebe um link sabe o que fazer com ele.
 */
export function mostrarConvite(codigo, nome = "") {
  const link = linkDoConvite(codigo, nome);
  const podeCompartilhar = typeof navigator.share === "function";

  menu(
    "Convite do grupo",
    [
      podeCompartilhar
        ? { valor: "compartilhar", rotulo: "Compartilhar link", icone: "compartilhar" }
        : null,
      { valor: "link", rotulo: "Copiar link", legenda: link, icone: "copiar" },
      { valor: "codigo", rotulo: "Copiar código", legenda: codigo, icone: "chave" },
    ],
    { texto: "Quem tiver isto entra no grupo. É a única chave que existe." }
  ).then((escolha) => {
    if (escolha === "compartilhar") {
      navigator
        .share({
          title: nome ? `Convite para ${nome}` : "Convite para o CALL",
          text: "Entra na conversa comigo no CALL:",
          url: link,
        })
        .catch(() => {});
    } else if (escolha === "link") copiar(link, "Link copiado.");
    else if (escolha === "codigo") copiar(codigo, "Código copiado.");
  });
}

/* ═══ Tela de um grupo ══════════════════════════════════════════ */

export function telaDoGrupo(nav, codigo) {
  const tela = montarTela({
    titulo: estado.grupo?.nome ?? "Grupo",
    voltar: () => nav.voltar(),
    acoes: [acao("reticencias", "Opções do grupo", () => menuDoGrupo(nav))],
  });

  const arvore = el("div");
  tela.corpo.append(arvore);

  function desenhar() {
    const grupo = estado.grupo;
    tela.definirTitulo(grupo?.nome ?? "Grupo");
    tela.definirLegenda(
      grupo ? `${estado.membros.size} ${estado.membros.size === 1 ? "conectado" : "conectados"}` : "Conectando…"
    );

    limpar(arvore);
    if (!grupo || grupo.codigo !== codigo) {
      arvore.append(vazio("wifi", "Conectando…", "Um instante — estamos falando com o servidor."));
      return;
    }

    if (grupo.descricao) {
      arvore.append(
        el(
          "p",
          {
            style: {
              padding: "6px 20px 10px",
              color: "var(--texto-2)",
              fontSize: "14px",
              lineHeight: "1.5",
            },
          },
          grupo.descricao
        )
      );
    }

    for (const categoria of grupo.categorias ?? []) {
      const cabecalho = el(
        "div",
        { class: "secao" },
        el("span", null, categoria.nome),
        souDono()
          ? el(
              "button",
              {
                class: "secao__acao",
                type: "button",
                onclick: () => novoCanal(categoria.id),
              },
              "Novo canal"
            )
          : null
      );
      const caixa = el("div", { class: "grupo" });

      if (!categoria.canais?.length) {
        caixa.append(
          el(
            "div",
            { class: "linha", "data-inerte": "" },
            el(
              "span",
              { class: "linha__dizeres" },
              el("span", { class: "linha__legenda" }, "Nenhum canal nesta categoria.")
            )
          )
        );
      }

      for (const canal of categoria.canais ?? []) {
        caixa.append(linhaDeCanal(canal));
        if (canal.tipo === "voz") {
          for (const membro of membrosNaVoz(canal.id)) caixa.append(linhaNaVoz(membro));
        }
      }

      arvore.append(cabecalho, caixa);
    }

    if (souDono()) {
      arvore.append(
        el(
          "div",
          { style: { padding: "4px 20px 24px" } },
          el(
            "button",
            { class: "botao botao--fantasma botao--largo botao--baixo", type: "button", onclick: novaCategoria },
            icone("mais"),
            "Nova categoria"
          )
        )
      );
    }
  }

  function linhaDeCanal(canal) {
    const naoLidas = estado.naoLidos.get(canal.id) ?? 0;
    const naVoz = canal.tipo === "voz" ? membrosNaVoz(canal.id).length : 0;

    const linha = el(
      "button",
      {
        class: "canal",
        type: "button",
        dataset: { ativo: canal.id === estado.canalTexto || canal.id === estado.canalVoz },
        onclick: () => {
          vibrar("leve");
          if (canal.tipo === "texto") nav.empilhar(abrirConversa(nav, { canal: canal.id }));
          else entrarNoCanalDeVoz(canal);
        },
      },
      icone(canal.tipo === "voz" ? "voz" : "texto"),
      el("span", { class: "canal__nome" }, canal.nome),
      naoLidas ? el("span", { class: "canal__marca" }, naoLidas > 99 ? "99+" : String(naoLidas)) : null,
      naVoz ? el("span", { class: "canal__contagem" }, String(naVoz)) : null
    );

    if (souDono()) pressaoLonga(linha, () => menuDoCanal(canal));
    return linha;
  }

  function linhaNaVoz(membro) {
    const no = el(
      "div",
      {
        class: "na-voz",
        dataset: { falando: falando.has(String(membro.id)) },
        onclick: () => {
          vibrar("leve");
          if (membro.canalVoz === estado.canalVoz) abrirCall(nav);
        },
      },
      avatar(membro, "na-voz__avatar"),
      el("span", { class: "na-voz__nome" }, membro.apelido),
      el(
        "span",
        { class: "na-voz__selos" },
        membro.mudo ? icone("microfone-mudo", "perigo") : null,
        membro.transmitindo ? icone("transmitir", "vivo") : null
      )
    );
    no.dataset.membro = membro.id;
    return no;
  }

  async function entrarNoCanalDeVoz(canal) {
    if (estado.canalVoz === canal.id) {
      abrirCall(nav);
      return;
    }
    try {
      await entrarNaVoz(canal.id);
      abrirCall(nav);
    } catch (erro) {
      // Uma desistência nossa — trocar de grupo no meio da entrada — não é
      // falha de ninguém, e não merece um aviso vermelho.
      if (!erro?.silencioso) avisar(erro.message ?? String(erro), "erro");
    }
  }

  /* ── Estrutura, só para quem é dono ────────────────────────── */

  async function novaCategoria() {
    const valores = await perguntar({
      titulo: "Nova categoria",
      campos: [{ nome: "nome", rotulo: "Nome", maximo: 40, obrigatorio: true }],
      confirmar: "Criar",
    });
    if (valores) criarCategoria(valores.nome);
  }

  async function novoCanal(categoriaId) {
    const tipo = await menu("Novo canal", [
      { valor: "texto", rotulo: "Canal de texto", legenda: "Conversa escrita, com histórico", icone: "texto" },
      { valor: "voz", rotulo: "Canal de voz", legenda: "Chamada com quem entrar nele", icone: "voz" },
    ]);
    if (!tipo) return;

    const valores = await perguntar({
      titulo: tipo === "voz" ? "Novo canal de voz" : "Novo canal de texto",
      campos: [{ nome: "nome", rotulo: "Nome", maximo: 40, obrigatorio: true }],
      confirmar: "Criar",
    });
    if (valores) criarCanal(categoriaId, valores.nome, tipo);
  }

  async function menuDoCanal(canal) {
    const escolha = await menu(canal.nome, [
      { valor: "renomear", rotulo: "Renomear", icone: "lapis" },
      { valor: "remover", rotulo: "Remover canal", icone: "lixeira", perigo: true },
    ]);
    if (escolha === "renomear") {
      const valores = await perguntar({
        titulo: "Renomear canal",
        campos: [{ nome: "nome", rotulo: "Nome", valor: canal.nome, maximo: 40, obrigatorio: true }],
        confirmar: "Salvar",
      });
      if (valores) renomear("canal", canal.id, valores.nome);
    } else if (escolha === "remover") {
      const certeza = await confirmar({
        titulo: `Remover "${canal.nome}"?`,
        texto: "As mensagens deste canal somem junto, para todo mundo.",
        confirmar: "Remover",
        perigo: true,
      });
      if (certeza) remover("canal", canal.id);
    }
  }

  async function menuDoGrupo(navegacao) {
    const grupo = estado.grupo;
    if (!grupo) return;
    const dono = souDono();

    const escolha = await menu(grupo.nome, [
      { valor: "convite", rotulo: "Compartilhar convite", icone: "compartilhar" },
      { valor: "pessoas", rotulo: "Quem está aqui", legenda: `${estado.membros.size} conectados`, icone: "amigos" },
      dono ? { valor: "editar", rotulo: "Editar o grupo", icone: "lapis" } : null,
      dono ? { valor: "categoria", rotulo: "Nova categoria", icone: "mais" } : null,
      { valor: "sair", rotulo: "Sair do grupo", icone: "sair", perigo: true },
    ]);

    if (escolha === "convite") mostrarConvite(grupo.codigo, grupo.nome);
    else if (escolha === "pessoas") navegacao.empilhar(telaDePresentes(navegacao));
    else if (escolha === "editar") {
      const campos = await editarGrupo(grupo);
      if (campos) editarGrupoNoServidor(campos);
    } else if (escolha === "categoria") novaCategoria();
    else if (escolha === "sair") {
      const certeza = await confirmar({
        titulo: "Sair do grupo?",
        texto: "Ele some da sua lista. Para voltar você vai precisar do convite de novo.",
        confirmar: "Sair do grupo",
        perigo: true,
      });
      if (!certeza) return;
      esquecerGrupo(grupo.codigo);
      navegacao.voltar();
    }
  }

  desenhar();
  const cancelar = assinar(["grupo", "estrutura", "membros", "naolidos", "voz", "fala"], desenhar);

  return { ...tela, grupoAberto: codigo, aoEntrar: desenhar, aoDestruir: cancelar };
}

/* ═══ Quem está no grupo agora ══════════════════════════════════ */

export function telaDePresentes(nav) {
  const tela = montarTela({ titulo: "Quem está aqui", voltar: () => nav.voltar() });
  const lista = el("div");
  tela.corpo.append(lista);

  function desenhar() {
    limpar(lista);
    const pessoas = [...estado.membros.values()].sort((a, b) =>
      a.apelido.localeCompare(b.apelido, "pt-BR")
    );
    tela.definirLegenda(`${pessoas.length} ${pessoas.length === 1 ? "pessoa" : "pessoas"}`);

    if (!pessoas.length) {
      lista.append(vazio("amigos", "Ninguém por aqui", "Quando alguém abrir o grupo, aparece nesta lista."));
      return;
    }

    const caixa = el("div", { class: "grupo" });
    for (const pessoa of pessoas) {
      const canal = pessoa.canalVoz ? acharCanal(pessoa.canalVoz) : null;
      caixa.append(
        el(
          "button",
          {
            class: "linha",
            type: "button",
            onclick: () => {
              vibrar("leve");
              import("./pessoas.js").then((modulo) => modulo.mostrarCartao(pessoa));
            },
          },
          avatar(pessoa),
          el(
            "span",
            { class: "linha__dizeres" },
            el(
              "span",
              { class: "linha__titulo" },
              pessoa.apelido,
              estado.grupo?.dono === pessoa.usuario ? " 👑" : ""
            ),
            el(
              "span",
              { class: "linha__legenda" },
              canal ? `Na voz — ${canal.nome}` : pessoa.bio || "No grupo"
            )
          ),
          pessoa.mudo ? icone("microfone-mudo", "linha__seta") : null
        )
      );
    }
    lista.append(caixa);
  }

  desenhar();
  const cancelar = assinar(["membros", "grupo"], desenhar);
  return { ...tela, aoEntrar: desenhar, aoDestruir: cancelar };
}
