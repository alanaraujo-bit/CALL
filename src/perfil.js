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
/** Lado do quadrado final, em pixels — grande o bastante para o cartão de
 *  88 px, pequeno o bastante para a `localStorage` nem sentir. */
const FOTO_LADO = 256;
/** Teto do data URL depois de comprimido. Uma foto normal fica bem abaixo
 *  disso; o teto existe para recusar cedo o raro caso de ficar grande demais,
 *  e não descobrir isso só na hora de gravar. Alto o bastante para caber um
 *  GIF no teto de `GIF_MAX_BYTES` já em base64 (que engorda o tamanho em
 *  cerca de um terço). */
const FOTO_MAX_CARACTERES = 2_200_000;
/** GIF não passa pelo canvas — desenhá-lo ali travaria no primeiro quadro, e
 *  a animação é o ponto todo de escolher um. Sem a compressão dos outros
 *  formatos, o teto mora no arquivo original, e por isso é bem mais apertado. */
const GIF_MAX_BYTES = 1_500_000;

/** Lado do ícone de uma atividade cadastrada a mão — um selo, não um retrato:
 *  pequeno o bastante para trafegar a cada troca de programa sem pesar na
 *  rede de ninguém do grupo. */
const ICONE_LADO = 96;
/** Teto do data URL do ícone, igual ao que o servidor aplica. */
const ICONE_MAX_CARACTERES = 40_000;

/** Corta por pontos de código, e não por unidades UTF-16: `slice` parte um
 *  emoji ao meio e deixa meio caractere quebrado no lugar. */
const cortar = (texto, maximo) => [...String(texto ?? "")].slice(0, maximo).join("");

/**
 * Os mesmos limites que o servidor aplica. Repetidos aqui de propósito: o
 * servidor é quem manda — ele recorta o que chega de qualquer cliente —, e
 * isto é só para a tela não prometer um campo que seria cortado depois.
 *
 * `foto` não passa pelo servidor — ele só aceita um mascote de 24 caracteres
 * no campo `avatar`, e uma foto de verdade não cabe nisso. Por enquanto ela
 * fica só neste computador; daí só validar a forma (é mesmo um data URL de
 * imagem, dentro do teto de tamanho) e não um limite do protocolo.
 */
export function saneado({ apelido, avatar, bio, foto } = {}) {
  return {
    apelido: cortar(apelido, APELIDO_MAX).trim(),
    // Um identificador desconhecido — cliente adulterado, ou versão futura com
    // um sétimo mascote — vira "sem mascote", que cai nas iniciais.
    avatar: acharAvatar(avatar)?.id ?? "",
    bio: cortar(bio, BIO_MAX).trim(),
    foto:
      typeof foto === "string" &&
      foto.startsWith("data:image/") &&
      foto.length <= FOTO_MAX_CARACTERES
        ? foto
        : "",
  };
}

/**
 * Lê um arquivo de imagem, recorta o quadrado central e devolve um data URL
 * comprimido nesse lado e qualidade. O recorte central é sempre o mesmo,
 * usado tanto pela foto de perfil quanto pelo ícone de atividade: é assim que
 * as duas aparecem em todo canto do CALL, e um retrato retangular ficaria
 * esticado ou cortado de um jeito que ninguém escolheu.
 */
function imagemQuadradaDeArquivo(arquivo, { lado, qualidade, maxCaracteres, mensagemGrande }) {
  return new Promise((resolver, rejeitar) => {
    if (!arquivo.type.startsWith("image/")) {
      rejeitar(new Error("Escolha um arquivo de imagem."));
      return;
    }

    const leitor = new FileReader();
    leitor.onerror = () => rejeitar(new Error("Não foi possível ler o arquivo."));
    leitor.onload = () => {
      const imagem = new Image();
      imagem.onerror = () => rejeitar(new Error("Esse arquivo não parece ser uma imagem válida."));
      imagem.onload = () => {
        const ladoOriginal = Math.min(imagem.naturalWidth, imagem.naturalHeight);
        const tela = document.createElement("canvas");
        tela.width = lado;
        tela.height = lado;
        tela
          .getContext("2d")
          .drawImage(
            imagem,
            (imagem.naturalWidth - ladoOriginal) / 2,
            (imagem.naturalHeight - ladoOriginal) / 2,
            ladoOriginal,
            ladoOriginal,
            0,
            0,
            lado,
            lado
          );

        const dados = tela.toDataURL("image/jpeg", qualidade);
        if (dados.length > maxCaracteres) {
          rejeitar(new Error(mensagemGrande));
          return;
        }
        resolver(dados);
      };
      imagem.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

/**
 * Lê um arquivo de imagem e devolve um data URL quadrado, pequeno o bastante
 * para viver na `localStorage` sem drama.
 */
export function lerFotoDeArquivo(arquivo) {
  // Sem recorte nem compressão: qualquer um dos dois passaria pelo canvas,
  // que só enxerga o primeiro quadro. O GIF viaja do jeito que foi escolhido,
  // e quem o desenha depois (o `<img>` do avatar) já anima sozinho.
  if (arquivo.type === "image/gif") {
    return new Promise((resolver, rejeitar) => {
      if (arquivo.size > GIF_MAX_BYTES) {
        rejeitar(
          new Error(`Esse GIF passa de ${(GIF_MAX_BYTES / 1_000_000).toFixed(1)} MB. Tente um menor.`)
        );
        return;
      }
      const leitorGif = new FileReader();
      leitorGif.onerror = () => rejeitar(new Error("Não foi possível ler o arquivo."));
      leitorGif.onload = () => resolver(leitorGif.result);
      leitorGif.readAsDataURL(arquivo);
    });
  }

  return imagemQuadradaDeArquivo(arquivo, {
    lado: FOTO_LADO,
    qualidade: 0.86,
    maxCaracteres: FOTO_MAX_CARACTERES,
    mensagemGrande: "Essa imagem é grande demais, mesmo depois de comprimida.",
  });
}

/**
 * Lê um arquivo de imagem e devolve o ícone de uma atividade cadastrada a
 * mão: um selo pequeno, não uma foto — sem caso especial para GIF, porque
 * animar um ícone que aparece do lado do nome de todo mundo no grupo seria
 * distração, não beleza.
 */
export function lerIconeDeArquivo(arquivo) {
  return imagemQuadradaDeArquivo(arquivo, {
    lado: ICONE_LADO,
    qualidade: 0.82,
    maxCaracteres: ICONE_MAX_CARACTERES,
    mensagemGrande: "Esse ícone é grande demais, mesmo depois de comprimido.",
  });
}

/**
 * Liga um botão de "escolher foto" ao seletor de arquivo escondido atrás
 * dele. `aoEscolher` só roda com uma imagem já lida e recortada; `aoErrar`
 * recebe o motivo quando o arquivo escolhido não serve. `ler` é
 * `lerFotoDeArquivo` por padrão, mas o cadastro de ícone de atividade usa a
 * mesma amarração de botão↔input com `lerIconeDeArquivo` no lugar.
 */
export function prepararEscolhaDeFoto(botaoEscolher, inputArquivo, aoEscolher, aoErrar, ler = lerFotoDeArquivo) {
  botaoEscolher.onclick = () => inputArquivo.click();
  inputArquivo.onchange = async () => {
    const arquivo = inputArquivo.files?.[0];
    // Zera na hora: sem isto, escolher o mesmo arquivo de novo (depois de
    // remover a foto, por exemplo) não dispara `change` de novo.
    inputArquivo.value = "";
    if (!arquivo) return;
    try {
      aoEscolher(await ler(arquivo));
    } catch (erro) {
      aoErrar(erro);
    }
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
    const botaoRemoverFoto = $("perfil-remover-foto");
    const rascunho = saneado(atual);

    campoApelido.value = rascunho.apelido;
    campoBio.value = rascunho.bio;
    $("perfil-foto-erro").hidden = true;

    const refletir = () => {
      const previa = {
        apelido: campoApelido.value.trim() || rascunho.apelido,
        avatar: rascunho.avatar,
        bio: campoBio.value.trim(),
        foto: rascunho.foto,
      };
      pintarAvatar($("perfil-previa-avatar"), previa);
      $("perfil-previa-nome").textContent = previa.apelido || "Sem apelido";

      const mascote = acharAvatar(rascunho.avatar);
      $("perfil-previa-lema").textContent = rascunho.foto
        ? "Sua foto — os outros veem o mascote, aqui embaixo"
        : mascote
          ? `${mascote.nome} — ${mascote.lema.toLowerCase()}`
          : "Sem mascote — aparecem suas iniciais";

      $("perfil-previa-bio").textContent = previa.bio;
      $("perfil-previa-bio").hidden = !previa.bio;
      // Conta pontos de código: com `.length`, um emoji contaria como dois e a
      // pessoa veria "159/160" com um caractere digitado.
      $("perfil-bio-conta").textContent = `${[...campoBio.value].length}/${BIO_MAX}`;
      $("perfil-salvar").disabled = !campoApelido.value.trim();
      botaoRemoverFoto.classList.toggle("oculto", !rascunho.foto);
    };

    montarEscolhaDeMascotes($("perfil-mascotes"), rascunho.avatar, (id) => {
      rascunho.avatar = id;
      refletir();
    });

    const erroFoto = $("perfil-foto-erro");
    prepararEscolhaDeFoto(
      $("perfil-escolher-foto"),
      $("perfil-foto-arquivo"),
      (foto) => {
        erroFoto.hidden = true;
        rascunho.foto = foto;
        refletir();
      },
      (erro) => {
        erroFoto.textContent = erro.message;
        erroFoto.hidden = false;
      }
    );
    botaoRemoverFoto.onclick = () => {
      erroFoto.hidden = true;
      rascunho.foto = "";
      refletir();
    };

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      campoApelido.oninput = null;
      campoBio.oninput = null;
      $("perfil-salvar").onclick = null;
      $("perfil-cancelar").onclick = null;
      $("perfil-fechar").onclick = null;
      $("perfil-escolher-foto").onclick = null;
      $("perfil-foto-arquivo").onchange = null;
      botaoRemoverFoto.onclick = null;
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
        foto: rascunho.foto,
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
 * O onboarding de depois de criar conta. Duas etapas — retrato e bio —, cada
 * uma com "Pular" ao lado de "Continuar": não existe "cancelar" aqui, porque
 * não há nada para desfazer, só perguntas que ninguém é obrigado a responder
 * agora. Resolve sempre com um perfil completo (as etapas puladas mantêm o
 * que a pessoa já tinha — o apelido e o mascote sorteado no cadastro).
 */
export function iniciarOnboarding(atual) {
  return new Promise((resolver) => {
    const cortina = $("onboarding-dialogo");
    const campoBio = $("onboarding-bio");
    const botaoRemoverFoto = $("onboarding-remover-foto");
    const erroFoto = $("onboarding-foto-erro");
    const botaoPular = $("onboarding-pular");
    const botaoContinuar = $("onboarding-continuar");
    const pontos = [...$("onboarding-passos").children];
    const etapas = [...cortina.querySelectorAll(".onboarding__etapa")];

    // O apelido não tem etapa própria aqui — já foi escolhido no cadastro —,
    // mas precisa viajar intacto até `saneado`, ou viraria "" no resultado
    // final e apagaria o que a pessoa acabou de digitar.
    const escolhas = { apelido: atual.apelido, avatar: atual.avatar, foto: atual.foto || "", bio: atual.bio };
    const retrato = { avatar: atual.avatar, foto: atual.foto || "" };
    let indice = 0;

    erroFoto.hidden = true;
    campoBio.value = "";

    const refletirRetrato = () => {
      pintarAvatar($("onboarding-previa-avatar"), {
        avatar: retrato.avatar,
        apelido: atual.apelido,
        foto: retrato.foto,
      });
      $("onboarding-previa-nome").textContent = atual.apelido || "Sem apelido";

      const mascote = acharAvatar(retrato.avatar);
      $("onboarding-previa-lema").textContent = retrato.foto
        ? "Sua foto — os outros veem o mascote, aqui embaixo, por enquanto"
        : mascote
          ? `${mascote.nome} — ${mascote.lema.toLowerCase()}`
          : "Sem mascote — aparecem suas iniciais";

      botaoRemoverFoto.classList.toggle("oculto", !retrato.foto);
    };

    montarEscolhaDeMascotes($("onboarding-mascotes"), retrato.avatar, (id) => {
      retrato.avatar = id;
      refletirRetrato();
    });

    prepararEscolhaDeFoto(
      $("onboarding-escolher-foto"),
      $("onboarding-foto-arquivo"),
      (foto) => {
        erroFoto.hidden = true;
        retrato.foto = foto;
        refletirRetrato();
      },
      (erro) => {
        erroFoto.textContent = erro.message;
        erroFoto.hidden = false;
      }
    );
    botaoRemoverFoto.onclick = () => {
      erroFoto.hidden = true;
      retrato.foto = "";
      refletirRetrato();
    };

    const contarBio = () => {
      $("onboarding-bio-conta").textContent = `${[...campoBio.value].length}/${BIO_MAX}`;
    };
    campoBio.oninput = contarBio;

    const refletirPassos = () => {
      pontos.forEach((ponto, i) => {
        ponto.dataset.atual = String(i === indice);
        ponto.dataset.feito = String(i < indice);
      });
      etapas.forEach((etapa, i) => etapa.classList.toggle("oculto", i !== indice));
      botaoContinuar.textContent = indice === etapas.length - 1 ? "Concluir" : "Continuar";
    };

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      botaoPular.onclick = null;
      botaoContinuar.onclick = null;
      $("onboarding-escolher-foto").onclick = null;
      $("onboarding-foto-arquivo").onchange = null;
      botaoRemoverFoto.onclick = null;
      campoBio.oninput = null;
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const avancar = () => {
      if (indice < etapas.length - 1) {
        indice += 1;
        refletirPassos();
        if (etapas[indice].dataset.etapa === "bio") campoBio.focus();
      } else {
        fechar(saneado(escolhas));
      }
    };

    // Enter avança a etapa de qualquer lugar do diálogo, exceto de dentro da
    // própria bio — lá ele deveria quebrar linha, não pular etapa.
    const aoTeclar = (evento) => {
      if (evento.key === "Enter" && document.activeElement !== campoBio) {
        evento.preventDefault();
        botaoContinuar.click();
      }
    };

    botaoContinuar.onclick = () => {
      if (etapas[indice].dataset.etapa === "retrato") {
        escolhas.avatar = retrato.avatar;
        escolhas.foto = retrato.foto;
      } else {
        escolhas.bio = campoBio.value;
      }
      avancar();
    };
    botaoPular.onclick = avancar;

    document.addEventListener("keydown", aoTeclar);

    refletirRetrato();
    contarBio();
    refletirPassos();
    cortina.classList.remove("oculto");
  });
}

/**
 * Cartão de alguém. `etiquetas` são textos curtos (dono, você) e `acoes` são
 * botões — o ajuste de volume mora aqui, que é onde se está pensando na
 * pessoa, e não num menu de contexto que ninguém descobre.
 */
export function mostrarCartao({ apelido, avatar, bio, atividade, atividadeIcone, etiquetas = [], acoes = [] }) {
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
  linhaAtividade.textContent = "";
  linhaAtividade.hidden = !atividade;
  if (atividade) {
    if (atividadeIcone) {
      const icone = document.createElement("img");
      icone.className = "cartao__atividade-icone";
      icone.src = atividadeIcone;
      icone.alt = "";
      linhaAtividade.append(icone);
    }
    linhaAtividade.append(document.createTextNode(`Usando ${atividade}`));
  }

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
