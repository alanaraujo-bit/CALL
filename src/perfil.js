/**
 * Perfil: quem você é para o grupo.
 *
 * Duas telas, e a diferença entre elas é o ponto do recurso — o editor é seu
 * e muda as coisas; o cartão é de outra pessoa e só mostra. Ambos vivem na
 * marcação estática do `index.html`, como o resto da interface, e este arquivo
 * é só o comportamento.
 *
 * O perfil não é conta: não há senha, não há servidor guardando quem você é.
 * Ele mora neste computador e viaja junto da saudação, do mesmo jeito que o
 * apelido sempre viajou. Quem troca de máquina começa de novo, e é honesto que
 * a interface não prometa o contrário.
 */

import { AVATARES, acharAvatar, pintarAvatar } from "./avatares.js";

const $ = (id) => document.getElementById(id);

export const APELIDO_MAX = 24;
/** Uma linha, não uma página. O cartão tem largura fixa e a lista, não. */
export const BIO_MAX = 160;

/** Corta por pontos de código, e não por unidades UTF-16: `slice` parte um
 *  emoji ao meio e deixa meio caractere quebrado no lugar. */
const cortar = (texto, maximo) => [...String(texto ?? "")].slice(0, maximo).join("");

/**
 * Os mesmos limites que o servidor aplica. Repetidos aqui de propósito: o
 * servidor é quem manda — ele recorta o que chega de qualquer cliente —, e
 * isto é só para a tela não prometer um campo que seria cortado depois.
 */
export function saneado({ apelido, avatar, bio } = {}) {
  return {
    apelido: cortar(apelido, APELIDO_MAX).trim(),
    // Um identificador desconhecido — cliente adulterado, ou versão futura com
    // um sétimo mascote — vira "sem mascote", que cai nas iniciais.
    avatar: acharAvatar(avatar)?.id ?? "",
    bio: cortar(bio, BIO_MAX).trim(),
  };
}

/**
 * A fita de mascotes. Serve à tela de entrada e ao editor: são o mesmo
 * controle em dois tamanhos, e duas implementações divergiriam na primeira vez
 * que um sétimo mascote entrasse na lista.
 */
export function montarEscolhaDeMascotes(area, escolhido, aoEscolher) {
  area.textContent = "";

  for (const mascote of AVATARES) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "mascote-opcao";
    botao.title = `${mascote.nome} — ${mascote.lema}`;
    botao.setAttribute("aria-pressed", String(mascote.id === escolhido));
    botao.style.setProperty("--cor-mascote", mascote.cor);

    const retrato = document.createElement("span");
    retrato.className = "avatar";
    pintarAvatar(retrato, { avatar: mascote.id });

    const nome = document.createElement("span");
    nome.className = "mascote-opcao__nome";
    nome.textContent = mascote.nome;

    botao.append(retrato, nome);
    botao.addEventListener("click", () => {
      for (const irmao of area.children) irmao.setAttribute("aria-pressed", "false");
      botao.setAttribute("aria-pressed", "true");
      aoEscolher(mascote.id);
    });
    area.append(botao);
  }
}

/**
 * Editor do próprio perfil. Resolve com o perfil novo, ou `null` se a pessoa
 * desistir — e desistir devolve tudo como estava, inclusive o mascote clicado
 * na prévia.
 */
export function editarPerfil(atual) {
  return new Promise((resolver) => {
    const cortina = $("perfil-dialogo");
    const campoApelido = $("perfil-apelido");
    const campoBio = $("perfil-bio");
    const rascunho = saneado(atual);

    campoApelido.value = rascunho.apelido;
    campoBio.value = rascunho.bio;

    const refletir = () => {
      const previa = {
        apelido: campoApelido.value.trim() || rascunho.apelido,
        avatar: rascunho.avatar,
        bio: campoBio.value.trim(),
      };
      pintarAvatar($("perfil-previa-avatar"), previa);
      $("perfil-previa-nome").textContent = previa.apelido || "Sem apelido";

      const mascote = acharAvatar(rascunho.avatar);
      $("perfil-previa-lema").textContent = mascote
        ? `${mascote.nome} — ${mascote.lema.toLowerCase()}`
        : "Sem mascote — aparecem suas iniciais";

      $("perfil-previa-bio").textContent = previa.bio;
      $("perfil-previa-bio").hidden = !previa.bio;
      // Conta pontos de código: com `.length`, um emoji contaria como dois e a
      // pessoa veria "159/160" com um caractere digitado.
      $("perfil-bio-conta").textContent = `${[...campoBio.value].length}/${BIO_MAX}`;
      $("perfil-salvar").disabled = !campoApelido.value.trim();
    };

    montarEscolhaDeMascotes($("perfil-mascotes"), rascunho.avatar, (id) => {
      rascunho.avatar = id;
      refletir();
    });

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      campoApelido.oninput = null;
      campoBio.oninput = null;
      $("perfil-salvar").onclick = null;
      $("perfil-cancelar").onclick = null;
      $("perfil-fechar").onclick = null;
      cortina.onclick = null;
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const aoTeclar = (evento) => {
      if (evento.key === "Escape") fechar(null);
    };

    const salvar = () => {
      const escolhido = saneado({
        apelido: campoApelido.value,
        avatar: rascunho.avatar,
        bio: campoBio.value,
      });
      // Sem apelido não há o que mostrar aos outros, e o servidor trocaria o
      // vazio por "Convidado" pelas costas da pessoa.
      if (!escolhido.apelido) {
        campoApelido.focus();
        return;
      }
      fechar(escolhido);
    };

    campoApelido.oninput = refletir;
    campoBio.oninput = refletir;
    $("perfil-salvar").onclick = salvar;
    $("perfil-cancelar").onclick = () => fechar(null);
    $("perfil-fechar").onclick = () => fechar(null);
    cortina.onclick = (evento) => {
      if (evento.target === cortina) fechar(null);
    };
    document.addEventListener("keydown", aoTeclar);

    refletir();
    cortina.classList.remove("oculto");
    campoApelido.focus();
  });
}

/**
 * Cartão de alguém. `etiquetas` são textos curtos (dono, você) e `acoes` são
 * botões — o ajuste de volume mora aqui, que é onde se está pensando na
 * pessoa, e não num menu de contexto que ninguém descobre.
 */
export function mostrarCartao({ apelido, avatar, bio, atividade, etiquetas = [], acoes = [] }) {
  const cortina = $("cartao-dialogo");
  const mascote = acharAvatar(avatar);

  pintarAvatar($("cartao-avatar"), { avatar, apelido });
  $("cartao-nome").textContent = apelido;

  // A capa toma a cor do mascote. É o único lugar do aplicativo onde a cor
  // muda com a pessoa, e é de propósito: o cartão é dela.
  $("cartao-capa").style.background = mascote
    ? `linear-gradient(160deg, ${mascote.cor}55, ${mascote.fundo})`
    : "var(--superficie-3)";

  const faixa = $("cartao-etiquetas");
  faixa.textContent = "";
  for (const texto of etiquetas) {
    const etiqueta = document.createElement("span");
    etiqueta.className = "etiqueta";
    etiqueta.textContent = texto;
    faixa.append(etiqueta);
  }
  faixa.hidden = etiquetas.length === 0;

  $("cartao-bio").textContent = bio || "";
  $("cartao-bio").hidden = !bio;

  $("cartao-vazio").hidden = Boolean(bio);

  const linhaAtividade = $("cartao-atividade");
  linhaAtividade.textContent = atividade ? `Usando ${atividade}` : "";
  linhaAtividade.hidden = !atividade;

  const area = $("cartao-acoes");
  area.textContent = "";
  for (const acao of acoes) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "botao botao--sutil botao--largo";
    botao.textContent = acao.rotulo;
    botao.addEventListener("click", () => {
      fechar();
      acao.fazer();
    });
    area.append(botao);
  }
  area.hidden = acoes.length === 0;

  const aoTeclar = (evento) => {
    if (evento.key === "Escape") fechar();
  };

  function fechar() {
    cortina.classList.add("oculto");
    cortina.onclick = null;
    $("cartao-fechar").onclick = null;
    document.removeEventListener("keydown", aoTeclar);
  }

  cortina.onclick = (evento) => {
    if (evento.target === cortina) fechar();
  };
  $("cartao-fechar").onclick = fechar;
  document.addEventListener("keydown", aoTeclar);
  cortina.classList.remove("oculto");
}
