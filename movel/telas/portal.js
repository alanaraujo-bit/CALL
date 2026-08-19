/**
 * O portal: entrar, criar conta, ou nenhum dos dois.
 *
 * A mesma decisão do CALL de mesa, redesenhada para uma tela de 360 px: uma
 * pergunta por vez, o polegar sempre alcançando o botão, e a terceira saída —
 * **entrar sem conta** — ali embaixo, discreta e funcionando de verdade.
 *
 * Aparece uma vez só. Da segunda abertura em diante o aplicativo vai direto
 * para os grupos: boas-vindas se dá uma vez.
 *
 * ## O login do Google no navegador
 *
 * No computador, o CALL abre o navegador do sistema e espera a volta numa
 * porta local. Aqui já *somos* o navegador, então o fluxo é o padrão da web:
 * PKCE, ida a `accounts.google.com` e volta para esta mesma página com um
 * `?code=`. O segredo continua só no servidor — quem troca o código pelo
 * perfil é ele, exatamente como antes.
 */

import { AVATARES, pintarAvatar } from "../../src/avatares.js";
import { el, limpar, vibrar, avisar, icone, perguntar } from "../interacao.js";
import { avatar } from "../visual.js";
import {
  estado,
  conta,
  assumirConta,
  salvarPreferencias,
  emitir,
} from "../nucleo.js";
import { APELIDO_MAX } from "../../src/perfil.js";

/** Onde o PKCE fica entre a ida ao Google e a volta. */
const CHAVE_PKCE = "call.google.pkce";

/* ═══ PKCE ══════════════════════════════════════════════════════ */

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function prepararPkce() {
  const aleatorio = crypto.getRandomValues(new Uint8Array(48));
  const verificador = base64url(aleatorio);
  const resumo = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verificador));
  return { verificador, desafio: base64url(new Uint8Array(resumo)) };
}

/** Esta mesma página, sem query nem âncora — o `redirect_uri` do Google. */
const enderecoDeVolta = () => location.origin + location.pathname;

/**
 * Se a página abriu com `?code=`, é a volta do Google. Resolve com a sessão,
 * ou `null` quando não era uma volta. Sempre limpa a barra de endereço: um
 * código de autorização não deve ficar no histórico do navegador.
 */
export async function atenderVoltaDoGoogle() {
  const parametros = new URLSearchParams(location.search);
  const codigo = parametros.get("code");
  const erro = parametros.get("error");
  const guardado = sessionStorage.getItem(CHAVE_PKCE);

  if (!codigo && !erro) return null;
  sessionStorage.removeItem(CHAVE_PKCE);
  history.replaceState(null, "", enderecoDeVolta());

  if (erro) {
    avisar(erro === "access_denied" ? "Entrada cancelada." : "O Google recusou a entrada.", "erro");
    return null;
  }
  if (!guardado) return null;

  const { verificador, estado: marcaDeEstado } = JSON.parse(guardado);
  if (parametros.get("state") !== marcaDeEstado) {
    avisar("A volta do Google não conferiu. Tente de novo.", "erro");
    return null;
  }

  try {
    const sessao = await conta.entrarComGoogle(estado.servidor, {
      codigo,
      verificador,
      redirecionamento: enderecoDeVolta(),
    });
    assumirConta(sessao);
    return sessao;
  } catch (falha) {
    avisar(falha?.message ?? "Não deu para entrar com o Google.", "erro");
    return null;
  }
}

async function irAoGoogle(clienteId) {
  const { verificador, desafio } = await prepararPkce();
  const marcaDeEstado = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(CHAVE_PKCE, JSON.stringify({ verificador, estado: marcaDeEstado }));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clienteId);
  url.searchParams.set("redirect_uri", enderecoDeVolta());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", desafio);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", marcaDeEstado);
  location.assign(url.toString());
}

/* ═══ A tela ════════════════════════════════════════════════════ */

/**
 * Monta o portal e resolve quando alguém entra — com conta ou sem.
 *
 * A promessa é o contrato inteiro: quem chama não precisa saber por qual das
 * três portas a pessoa passou, só que ela passou.
 */
export function abrirPortal() {
  return new Promise((resolver) => {
    let modo = estado.ultimoEmail ? "entrar" : "criar";
    let mascoteEscolhido = estado.avatar || "";

    /* ── Prévia ──────────────────────────────────────────────── */

    const previaRetrato = el("span", { class: "avatar avatar--g" });
    const previaTitulo = el("span", { class: "portal__previa-titulo" });
    const previaLegenda = el("span", { class: "portal__previa-legenda" });

    const refletir = () => {
      const apelido = modo === "criar" ? entradaApelido.value.trim() : "";
      const pessoa = {
        apelido: apelido || estado.apelido || "Você",
        avatar: mascoteEscolhido,
        foto: estado.foto,
      };
      pintarAvatar(previaRetrato, pessoa);

      if (modo === "criar") {
        previaTitulo.textContent = apelido || "Como querem te chamar?";
        previaLegenda.textContent = mascoteEscolhido
          ? AVATARES.find((a) => a.id === mascoteEscolhido)?.lema ?? ""
          : "Escolha um mascote abaixo";
      } else {
        previaTitulo.textContent = estado.apelido || "Bem-vindo de volta";
        previaLegenda.textContent = estado.ultimoEmail || "Entre na sua conta";
      }
    };

    /* ── Folha: entrar ───────────────────────────────────────── */

    const entradaEmail = campoDeTexto({
      tipo: "email",
      inputmode: "email",
      autocomplete: "username",
      placeholder: "voce@exemplo.com",
      maximo: 160,
    });
    entradaEmail.value = estado.ultimoEmail;

    const entradaSenha = campoDeSenha({ autocomplete: "current-password" });

    const erroEntrar = el("p", { class: "campo__erro" });
    const botaoEntrar = el(
      "button",
      { class: "botao botao--primario botao--largo", type: "submit" },
      "Entrar"
    );

    const folhaEntrar = el(
      "form",
      {
        class: "portal__folha",
        onsubmit: (evento) => {
          evento.preventDefault();
          entrarNaConta();
        },
      },
      rotulado("E-mail", entradaEmail.caixa ?? entradaEmail),
      rotulado("Senha", entradaSenha.caixa),
      erroEntrar,
      botaoEntrar
    );

    /* ── Folha: criar conta ──────────────────────────────────── */

    const entradaApelido = campoDeTexto({
      placeholder: "Como querem te chamar",
      maximo: APELIDO_MAX,
      autocapitalize: "words",
    });
    entradaApelido.value = estado.apelido;
    entradaApelido.addEventListener("input", refletir);

    const fitaDeMascotes = el("div", { class: "mascotes", role: "radiogroup", "aria-label": "Mascote" });
    for (const bicho of AVATARES) {
      const botao = el(
        "button",
        {
          class: "mascote-opcao",
          type: "button",
          "aria-pressed": String(bicho.id === mascoteEscolhido),
          "aria-label": bicho.nome,
          title: `${bicho.nome} — ${bicho.lema}`,
          onclick: () => {
            vibrar("leve");
            mascoteEscolhido = bicho.id;
            for (const outro of fitaDeMascotes.children) outro.setAttribute("aria-pressed", "false");
            botao.setAttribute("aria-pressed", "true");
            refletir();
          },
        },
        avatar({ avatar: bicho.id }, "avatar")
      );
      fitaDeMascotes.append(botao);
    }

    const criarEmail = campoDeTexto({
      tipo: "email",
      inputmode: "email",
      autocomplete: "email",
      placeholder: "voce@exemplo.com",
      maximo: 160,
    });
    const criarSenha = campoDeSenha({ autocomplete: "new-password" });

    const barras = el(
      "span",
      { class: "forca__barras" },
      Array.from({ length: 5 }, () => el("i"))
    );
    const forcaTexto = el("span", { class: "forca__texto" }, "Força");
    const medidorDeForca = el("div", { class: "forca" }, barras, forcaTexto);

    criarSenha.entrada.addEventListener("input", () => {
      const { nivel, texto } = conta.forcaDaSenha(criarSenha.entrada.value);
      const cores = ["", "var(--perigo)", "var(--atencao)", "var(--atencao)", "var(--vivo)", "var(--vivo)"];
      [...barras.children].forEach((barra, indice) => {
        barra.style.background = indice < nivel ? cores[nivel] : "var(--superficie-4)";
      });
      forcaTexto.textContent = texto;
    });

    const erroCriar = el("p", { class: "campo__erro" });
    const botaoCriar = el(
      "button",
      { class: "botao botao--primario botao--largo", type: "submit" },
      "Criar conta"
    );

    const folhaCriar = el(
      "form",
      {
        class: "portal__folha",
        onsubmit: (evento) => {
          evento.preventDefault();
          criarConta();
        },
      },
      rotulado("Apelido", entradaApelido.caixa ?? entradaApelido),
      el(
        "div",
        { class: "campo" },
        el("span", { class: "campo__rotulo" }, "Mascote"),
        fitaDeMascotes
      ),
      rotulado("E-mail", criarEmail.caixa ?? criarEmail),
      rotulado("Senha", criarSenha.caixa),
      medidorDeForca,
      erroCriar,
      botaoCriar
    );

    /* ── Abas ────────────────────────────────────────────────── */

    const pilula = el("span", { class: "segmentado__pilula", "aria-hidden": "true" });
    const abaEntrar = el(
      "button",
      { class: "segmentado__aba", type: "button", role: "tab", onclick: () => trocar("entrar") },
      "Entrar"
    );
    const abaCriar = el(
      "button",
      { class: "segmentado__aba", type: "button", role: "tab", onclick: () => trocar("criar") },
      "Criar conta"
    );
    const abas = el("div", { class: "segmentado portal__abas", role: "tablist" }, pilula, abaEntrar, abaCriar);

    function trocar(novo) {
      if (novo === modo) return;
      vibrar("leve");
      modo = novo;
      aplicarModo();
    }

    function aplicarModo() {
      const entrando = modo === "entrar";
      abaEntrar.setAttribute("aria-selected", String(entrando));
      abaCriar.setAttribute("aria-selected", String(!entrando));
      folhaEntrar.hidden = !entrando;
      folhaCriar.hidden = entrando;
      // A pílula acompanha a aba escolhida; medida no quadro seguinte porque
      // antes de a folha existir na tela a largura de um botão é zero.
      requestAnimationFrame(() => {
        const alvo = entrando ? abaEntrar : abaCriar;
        pilula.style.width = `${alvo.offsetWidth}px`;
        pilula.style.transform = `translateX(${alvo.offsetLeft - 3}px)`;
      });
      refletir();
    }

    /* ── Google e a saída sem conta ──────────────────────────── */

    const areaGoogle = el("div", { style: { width: "100%" } });

    conta
      .configuracaoDoGoogle(estado.servidor)
      // O celular precisa do cliente OAuth **do tipo Web**: ele volta nesta
      // mesma página, e um cliente de computador — que é o do CALL de Windows
      // — recusa um endereço `https` de retorno. Sem esse identificador o
      // botão não aparece, em vez de aparecer e o Google recusar a volta.
      .then(({ disponivel, clienteIdWeb }) => {
        if (!disponivel || !clienteIdWeb) return;
        const clienteId = clienteIdWeb;
        areaGoogle.append(
          el("div", { class: "portal__separador" }, "ou"),
          el(
            "button",
            {
              class: "botao botao--fantasma botao--largo",
              type: "button",
              style: { marginTop: "12px" },
              onclick: () => {
                vibrar("leve");
                irAoGoogle(clienteId).catch(() =>
                  avisar("Não deu para abrir o Google agora.", "erro")
                );
              },
            },
            icone("google"),
            "Continuar com o Google"
          )
        );
      })
      .catch(() => {});

    const semConta = el(
      "button",
      {
        class: "portal__sem-conta",
        type: "button",
        onclick: async () => {
          const valores = await perguntar({
            titulo: "Entrar sem conta",
            texto:
              "Funciona igual, e fica só neste aparelho. Trocar de celular significa começar de novo.",
            campos: [
              {
                nome: "apelido",
                rotulo: "Apelido",
                valor: estado.apelido,
                placeholder: "Como querem te chamar",
                maximo: APELIDO_MAX,
                obrigatorio: true,
              },
            ],
            confirmar: "Entrar",
          });
          if (!valores) return;
          estado.apelido = valores.apelido;
          if (!estado.avatar) estado.avatar = mascoteEscolhido;
          salvarPreferencias();
          emitir("perfil");
          concluir();
        },
      },
      "Entrar sem conta"
    );

    /* ── Montagem ────────────────────────────────────────────── */

    const raiz = el(
      "section",
      { class: "portal", id: "portal" },
      el("div", { class: "portal__mancha", "aria-hidden": "true" }),
      el(
        "div",
        { class: "portal__corpo" },
        el(
          "div",
          { class: "portal__marca" },
          el(
            "span",
            { class: "glifo glifo--grande", "aria-hidden": "true" },
            el("i"),
            el("i"),
            el("i"),
            el("i"),
            el("i")
          ),
          el("span", { class: "portal__nome" }, "CALL")
        ),
        el("h1", { class: "portal__slogan" }, "Sua turma, num só lugar."),
        el(
          "p",
          { class: "portal__lead" },
          "Grupos com canais, conversa por texto, chamada de voz e a tela de quem está jogando."
        ),
        el(
          "div",
          { class: "portal__previa" },
          previaRetrato,
          el("div", { class: "portal__previa-dizeres" }, previaTitulo, previaLegenda)
        ),
        abas,
        el("div", { class: "portal__palco" }, folhaEntrar, folhaCriar),
        el("div", { class: "portal__rodape" }, areaGoogle, semConta),
        el(
          "p",
          { class: "portal__nota" },
          "A conta serve para trocar de aparelho sem virar outra pessoa. Nada além disso."
        )
      )
    );

    document.getElementById("camadas").append(raiz);
    aplicarModo();

    /* ── Ações ───────────────────────────────────────────────── */

    function esperando(botao, ligado) {
      botao.disabled = ligado;
      botao.dataset.rotulo ??= botao.textContent;
      limpar(botao);
      if (ligado) botao.append(el("span", { class: "botao__carga" }));
      else botao.append(botao.dataset.rotulo);
    }

    function mostrarRecusa(alvo, erro) {
      alvo.textContent = erro?.message ?? String(erro);
      vibrar("erro");
    }

    async function entrarNaConta() {
      erroEntrar.textContent = "";
      const email = entradaEmail.value.trim();
      const senha = entradaSenha.entrada.value;
      if (!conta.pareceEmail(email)) return mostrarRecusa(erroEntrar, new Error("E-mail inválido."));
      if (!senha) return mostrarRecusa(erroEntrar, new Error("Digite a senha."));

      esperando(botaoEntrar, true);
      try {
        const sessao = await conta.entrar(estado.servidor, email, senha);
        estado.ultimoEmail = email;
        assumirConta(sessao);
        concluir();
      } catch (erro) {
        mostrarRecusa(erroEntrar, erro);
      } finally {
        esperando(botaoEntrar, false);
      }
    }

    async function criarConta() {
      erroCriar.textContent = "";
      const apelido = entradaApelido.value.trim();
      const email = criarEmail.value.trim();
      const senha = criarSenha.entrada.value;

      if (!apelido) return mostrarRecusa(erroCriar, new Error("Escolha um apelido."));
      if (!conta.pareceEmail(email)) return mostrarRecusa(erroCriar, new Error("E-mail inválido."));
      if (conta.forcaDaSenha(senha).nivel < 2) {
        return mostrarRecusa(erroCriar, new Error("A senha precisa de pelo menos 8 caracteres."));
      }

      esperando(botaoCriar, true);
      try {
        const sessao = await conta.cadastrar(estado.servidor, {
          apelido,
          email,
          senha,
          avatar: mascoteEscolhido || "",
          bio: "",
        });
        estado.apelido = apelido;
        estado.avatar = mascoteEscolhido || estado.avatar;
        estado.ultimoEmail = email;
        assumirConta(sessao);
        concluir();
      } catch (erro) {
        mostrarRecusa(erroCriar, erro);
      } finally {
        esperando(botaoCriar, false);
      }
    }

    function concluir() {
      salvarPreferencias();
      raiz.style.transition = "opacity 260ms ease, transform 260ms ease";
      raiz.style.opacity = "0";
      raiz.style.transform = "scale(1.02)";
      setTimeout(() => raiz.remove(), 280);
      resolver();
    }
  });
}

/* ═══ Campos ════════════════════════════════════════════════════ */

function campoDeTexto({ tipo = "text", maximo = 200, ...resto }) {
  const entrada = el("input", {
    class: "campo__entrada",
    type: tipo,
    maxlength: maximo,
    autocorrect: "off",
    spellcheck: "false",
    ...resto,
  });
  entrada.caixa = el("div", { class: "campo__caixa" }, entrada);
  return entrada;
}

function campoDeSenha({ autocomplete = "current-password" }) {
  const entrada = el("input", {
    class: "campo__entrada",
    type: "password",
    maxlength: 200,
    autocomplete,
    placeholder: "••••••••",
  });
  const olho = el("button", { class: "campo__botao", type: "button", "aria-label": "Mostrar senha" });
  olho.append(icone("olho"));
  olho.addEventListener("click", () => {
    const escondida = entrada.type === "password";
    entrada.type = escondida ? "text" : "password";
    limpar(olho).append(icone(escondida ? "olho-fechado" : "olho"));
    olho.setAttribute("aria-label", escondida ? "Esconder senha" : "Mostrar senha");
  });
  const caixa = el("div", { class: "campo__caixa" }, entrada, olho);
  return { entrada, caixa };
}

const rotulado = (rotulo, conteudo) =>
  el("label", { class: "campo" }, el("span", { class: "campo__rotulo" }, rotulo), conteudo);
