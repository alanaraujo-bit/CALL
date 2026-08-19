/**
 * Pessoas: o cartão de alguém, o editor do próprio perfil e o do grupo.
 *
 * Os três moram em folhas, e não em telas empilhadas, porque os três são
 * interrupções curtas: você olha quem é, muda um mascote, troca o nome do
 * grupo — e volta para onde estava. Empilhar tela para isso deixaria a
 * navegação funda sem ninguém ter ido a lugar nenhum.
 */

import { AVATARES } from "../../src/avatares.js";
import { APELIDO_MAX, BIO_MAX, GRUPO_NOME_MAX, GRUPO_DESCRICAO_MAX } from "../../src/perfil.js";
import {
  el,
  limpar,
  vibrar,
  avisar,
  icone,
  abrirFolha,
  confirmar,
  linha as linhaDeLista,
} from "../interacao.js";
import { avatar, marcaDeGrupo } from "../visual.js";
import { pintarAvatar, pintarMarcaDeGrupo } from "../../src/avatares.js";
import { escolherFoto } from "../foto.js";
import {
  estado,
  salvarPreferencias,
  sincronizarConta,
  sinal,
  emitir,
  souAmigoDe,
  pedirAmizade,
  definirVolumeDe,
  volumeDe,
  acharCanal,
} from "../nucleo.js";

/* ═══ Cartão de alguém ══════════════════════════════════════════ */

export function mostrarCartao(pessoa) {
  const souEu = pessoa.usuario === estado.usuario;
  const ehDono = estado.grupo?.dono === pessoa.usuario;
  const temConta = String(pessoa.usuario ?? "").startsWith("conta-");
  const canal = pessoa.canalVoz ? acharCanal(pessoa.canalVoz) : null;

  const corpo = el(
    "div",
    { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" } },
    avatar(pessoa, "avatar avatar--enorme"),
    el("p", { class: "retrato__nome" }, pessoa.apelido),
    pessoa.bio ? el("p", { class: "retrato__bio selecionavel" }, pessoa.bio) : null,
    el(
      "div",
      { style: { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" } },
      ehDono ? el("span", { class: "retrato__selo" }, icone("coroa"), "Dono do grupo") : null,
      canal ? el("span", { class: "retrato__selo" }, icone("voz"), canal.nome) : null,
      pessoa.atividade ? el("span", { class: "retrato__selo" }, icone("raio"), pessoa.atividade) : null,
      pessoa.mudo ? el("span", { class: "retrato__selo" }, icone("microfone-mudo"), "Mudo") : null
    )
  );

  // O volume de alguém só faz sentido enquanto essa pessoa está na sua call.
  if (!souEu && pessoa.canalVoz && pessoa.canalVoz === estado.canalVoz) {
    const controle = el("input", {
      class: "escala",
      type: "range",
      min: "0",
      max: "150",
      value: String(Math.round(volumeDe(pessoa.usuario) * 100)),
      "aria-label": `Volume de ${pessoa.apelido}`,
    });
    const valor = el("span", { class: "campo__contador" }, `${controle.value}%`);
    const pintar = () => {
      controle.style.setProperty("--preenchido", `${(Number(controle.value) / 150) * 100}%`);
      valor.textContent = `${controle.value}%`;
    };
    pintar();
    controle.addEventListener("input", () => {
      pintar();
      definirVolumeDe(pessoa.usuario, Number(controle.value) / 100);
    });

    corpo.append(
      el(
        "div",
        { style: { width: "100%", marginTop: "6px" } },
        el(
          "div",
          { style: { display: "flex", justifyContent: "space-between", marginBottom: "2px" } },
          el("span", { class: "campo__rotulo" }, "Volume"),
          valor
        ),
        controle
      )
    );
  }

  const acoes = [];
  if (souEu) {
    acoes.push(
      el(
        "button",
        {
          class: "botao botao--primario",
          type: "button",
          onclick: () => {
            folha.fechar();
            setTimeout(editarPerfil, 260);
          },
        },
        icone("lapis"),
        "Editar meu perfil"
      )
    );
  } else if (temConta && estado.conta && !souAmigoDe(pessoa.usuario)) {
    acoes.push(
      el(
        "button",
        {
          class: "botao botao--primario",
          type: "button",
          onclick: () => {
            pedirAmizade(pessoa.usuario);
            vibrar("sucesso");
            avisar("Pedido de amizade enviado.", "bom");
            folha.fechar();
          },
        },
        icone("adicionar-pessoa"),
        "Adicionar como amigo"
      )
    );
  }

  const folha = abrirFolha({ conteudo: corpo, acoes: acoes.length ? acoes : null });
  return folha;
}

/* ═══ Meu perfil ════════════════════════════════════════════════ */

export function editarPerfil() {
  let mascote = estado.avatar;
  let foto = estado.foto;

  const retrato = el("span", { class: "avatar avatar--enorme" });
  const previaNome = el("p", { class: "retrato__nome" });

  const campoApelido = el("input", {
    class: "campo__entrada",
    maxlength: APELIDO_MAX,
    placeholder: "Como querem te chamar",
    autocapitalize: "words",
  });
  campoApelido.value = estado.apelido;

  const campoBio = el("textarea", {
    class: "campo__area",
    maxlength: BIO_MAX,
    rows: 2,
    placeholder: "Uma linha sobre você",
  });
  campoBio.value = estado.bio;

  const contador = el("span", { class: "campo__contador" });

  const refletir = () => {
    pintarAvatar(retrato, {
      apelido: campoApelido.value.trim() || "Você",
      avatar: mascote,
      foto,
    });
    previaNome.textContent = campoApelido.value.trim() || "Sem apelido";
    contador.textContent = `${campoBio.value.length}/${BIO_MAX}`;
  };

  campoApelido.addEventListener("input", refletir);
  campoBio.addEventListener("input", refletir);

  const fita = el("div", { class: "mascotes", role: "radiogroup", "aria-label": "Mascote" });
  const pintarFita = () => {
    for (const botao of fita.children) {
      botao.setAttribute("aria-pressed", String(botao.dataset.id === mascote));
    }
  };
  for (const bicho of AVATARES) {
    fita.append(
      el(
        "button",
        {
          class: "mascote-opcao",
          type: "button",
          dataset: { id: bicho.id },
          "aria-label": bicho.nome,
          onclick: () => {
            vibrar("leve");
            mascote = bicho.id;
            // Escolher mascote é dizer "quero o bicho, não a foto".
            foto = "";
            pintarFita();
            refletir();
          },
        },
        avatar({ avatar: bicho.id }, "avatar")
      )
    );
  }
  pintarFita();

  const corpo = el(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "16px" } },
    el(
      "div",
      { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" } },
      el(
        "div",
        { class: "retrato__moldura" },
        retrato,
        el(
          "button",
          {
            class: "retrato__editar",
            type: "button",
            "aria-label": "Trocar a foto",
            onclick: async () => {
              const nova = await escolherFoto({ titulo: "Sua foto" });
              if (!nova) return;
              foto = nova;
              refletir();
            },
          },
          icone("camera")
        )
      ),
      previaNome
    ),
    el(
      "label",
      { class: "campo" },
      el("span", { class: "campo__rotulo" }, "Apelido"),
      el("div", { class: "campo__caixa" }, campoApelido)
    ),
    el(
      "label",
      { class: "campo" },
      el(
        "span",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
        el("span", { class: "campo__rotulo" }, "Bio"),
        contador
      ),
      campoBio
    ),
    el(
      "div",
      { class: "campo" },
      el("span", { class: "campo__rotulo" }, "Mascote"),
      fita,
      foto
        ? el(
            "button",
            {
              class: "botao botao--fantasma botao--baixo",
              type: "button",
              style: { marginTop: "8px" },
              onclick: () => {
                foto = "";
                refletir();
              },
            },
            "Remover a foto"
          )
        : null
    )
  );

  refletir();

  const folha = abrirFolha({
    titulo: "Meu perfil",
    conteudo: corpo,
    acoes: [
      el(
        "button",
        {
          class: "botao botao--primario",
          type: "button",
          onclick: () => {
            const apelido = campoApelido.value.trim();
            if (!apelido) {
              vibrar("erro");
              campoApelido.focus();
              return;
            }
            estado.apelido = apelido;
            estado.bio = campoBio.value.trim();
            estado.avatar = mascote;
            estado.foto = foto;
            salvarPreferencias();

            // Vale na hora para quem está no grupo, e fica guardado na conta.
            const eu = estado.membros.get(estado.meuId);
            if (eu) Object.assign(eu, { apelido, bio: estado.bio, avatar: mascote, foto });
            sinal.enviar({ tipo: "perfil", apelido, avatar: mascote, bio: estado.bio, foto });
            sincronizarConta({ apelido, avatar: mascote, bio: estado.bio });

            vibrar("sucesso");
            emitir("perfil");
            emitir("membros");
            folha.fechar();
          },
        },
        "Salvar"
      ),
      el(
        "button",
        { class: "botao botao--fantasma", type: "button", onclick: () => folha.fechar() },
        "Cancelar"
      ),
    ],
  });

  return folha;
}

/* ═══ Editar o grupo ════════════════════════════════════════════ */

/** Resolve com `{ nome, descricao, foto }`, ou `null` se desistiu. */
export function editarGrupo(grupo) {
  return new Promise((resolver) => {
    let foto = grupo.foto ?? "";
    let resposta = null;

    const marca = el("span", { class: "marca-grupo marca-grupo--g" });

    const campoNome = el("input", {
      class: "campo__entrada",
      maxlength: GRUPO_NOME_MAX,
      placeholder: "Nome do grupo",
    });
    campoNome.value = grupo.nome ?? "";

    const campoDescricao = el("textarea", {
      class: "campo__area",
      maxlength: GRUPO_DESCRICAO_MAX,
      rows: 2,
      placeholder: "Do que é este grupo",
    });
    campoDescricao.value = grupo.descricao ?? "";

    const refletir = () =>
      pintarMarcaDeGrupo(marca, { nome: campoNome.value.trim() || "Grupo", foto });
    campoNome.addEventListener("input", refletir);
    refletir();

    const folha = abrirFolha({
      titulo: "Editar grupo",
      conteudo: el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "16px" } },
        el(
          "div",
          { style: { display: "flex", justifyContent: "center" } },
          el(
            "div",
            { class: "retrato__moldura" },
            marca,
            el(
              "button",
              {
                class: "retrato__editar",
                type: "button",
                "aria-label": "Trocar a foto do grupo",
                onclick: async () => {
                  const nova = await escolherFoto({
                    titulo: "Foto do grupo",
                    lado: 160,
                    redonda: false,
                    maxCaracteres: 900_000,
                    gifMaxBytes: 500_000,
                  });
                  if (!nova) return;
                  foto = nova;
                  refletir();
                },
              },
              icone("camera")
            )
          )
        ),
        el(
          "label",
          { class: "campo" },
          el("span", { class: "campo__rotulo" }, "Nome"),
          el("div", { class: "campo__caixa" }, campoNome)
        ),
        el(
          "label",
          { class: "campo" },
          el("span", { class: "campo__rotulo" }, "Descrição"),
          campoDescricao
        ),
        foto
          ? el(
              "button",
              {
                class: "botao botao--fantasma botao--baixo",
                type: "button",
                onclick: () => {
                  foto = "";
                  refletir();
                },
              },
              "Remover a foto"
            )
          : null
      ),
      acoes: [
        el(
          "button",
          {
            class: "botao botao--primario",
            type: "button",
            onclick: () => {
              const nome = campoNome.value.trim();
              if (!nome) {
                vibrar("erro");
                campoNome.focus();
                return;
              }
              resposta = { nome, descricao: campoDescricao.value.trim(), foto };
              folha.fechar();
            },
          },
          "Salvar"
        ),
        el(
          "button",
          { class: "botao botao--fantasma", type: "button", onclick: () => folha.fechar() },
          "Cancelar"
        ),
      ],
      aoFechar: () => resolver(resposta),
    });
  });
}

export { confirmar, linhaDeLista, limpar, marcaDeGrupo };
