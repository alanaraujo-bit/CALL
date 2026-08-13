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

import {
  AVATARES,
  acharAvatar,
  gravarFotoEnquadrada,
  lerFotoEnquadrada,
  pintarAvatar,
  pintarMarcaDeGrupo,
} from "./avatares.js";
import { preencherIconeDeAtividade } from "./plataformas.js";

const $ = (id) => document.getElementById(id);

/** A seta que diz "isto abre" — só aparece quando o quadro é clicável. */
const GLIFO_SETA = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 7.5l4.5 4.5 4.5-4.5"/></svg>';

export const APELIDO_MAX = 24;
/** Uma linha, não uma página. O cartão tem largura fixa e a lista, não. */
export const BIO_MAX = 160;
export const GRUPO_NOME_MAX = 40;
export const GRUPO_DESCRICAO_MAX = 160;
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
const FOTO_GRUPO_LADO = 160;
const FOTO_GRUPO_MAX_CARACTERES = 900_000;
const FOTO_PREPARO_LADO = 384;
const FOTO_GRUPO_PREPARO_LADO = 256;

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
 * `foto` passa pelo servidor apenas como presença efêmera, para o grupo ver a
 * troca na hora. Ela continua guardada neste computador, e o mesmo teto é
 * aplicado nas duas pontas do protocolo.
 */
export function saneado({ apelido, avatar, bio, foto } = {}) {
  return {
    apelido: cortar(apelido, APELIDO_MAX).trim(),
    // Um identificador desconhecido — cliente adulterado, ou versão futura com
    // um sétimo mascote — vira "sem mascote", que cai nas iniciais.
    avatar: acharAvatar(avatar)?.id ?? "",
    bio: cortar(bio, BIO_MAX).trim(),
    foto: fotoValida(foto, FOTO_MAX_CARACTERES),
  };
}

export function saneadoGrupo({ nome, foto, descricao } = {}) {
  return {
    nome: cortar(nome, GRUPO_NOME_MAX).trim(),
    descricao: cortar(descricao, GRUPO_DESCRICAO_MAX).trim(),
    foto: fotoValida(foto, FOTO_GRUPO_MAX_CARACTERES),
  };
}

function fotoValida(foto, maxCaracteres) {
  return typeof foto === "string" && foto.length <= maxCaracteres && lerFotoEnquadrada(foto) ? foto : "";
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

function lerArquivoComoDataURL(arquivo) {
  return new Promise((resolver, rejeitar) => {
    const leitor = new FileReader();
    leitor.onerror = () => rejeitar(new Error("Não foi possível ler o arquivo."));
    leitor.onload = () => resolver(String(leitor.result ?? ""));
    leitor.readAsDataURL(arquivo);
  });
}

function carregarImagem(src) {
  return new Promise((resolver, rejeitar) => {
    const imagem = new Image();
    imagem.onerror = () => rejeitar(new Error("Esse arquivo não parece ser uma imagem válida."));
    imagem.onload = () => resolver(imagem);
    imagem.src = src;
  });
}

async function imagemRedimensionadaParaEnquadrar(arquivo, { ladoMax, qualidadeBase, maxCaracteres, mensagemGrande }) {
  if (!arquivo.type.startsWith("image/")) {
    throw new Error("Escolha um arquivo de imagem.");
  }

  const original = await carregarImagem(await lerArquivoComoDataURL(arquivo));
  const maiorLado = Math.max(original.naturalWidth, original.naturalHeight);
  const escalaBase = Math.min(1, ladoMax / maiorLado);

  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const escala = escalaBase * Math.pow(0.86, tentativa);
    const largura = Math.max(1, Math.round(original.naturalWidth * escala));
    const altura = Math.max(1, Math.round(original.naturalHeight * escala));
    const tela = document.createElement("canvas");
    tela.width = largura;
    tela.height = altura;
    tela.getContext("2d").drawImage(original, 0, 0, largura, altura);

    const qualidade = Math.max(0.58, qualidadeBase - tentativa * 0.08);
    const dados = tela.toDataURL("image/jpeg", qualidade);
    if (dados.length <= maxCaracteres - 200) {
      return { src: dados, w: largura, h: altura, panX: 0, panY: 0, zoom: 1 };
    }
  }

  throw new Error(mensagemGrande);
}

function pintarMidiaEnquadrada(area, foto) {
  const dados = typeof foto === "string" ? lerFotoEnquadrada(foto) : foto;
  area.textContent = "";
  if (!dados?.src) return;

  const imagem = document.createElement("img");
  imagem.src = dados.src;
  imagem.alt = "";

  const proporcao = dados.w > 0 && dados.h > 0 ? dados.w / dados.h : 1;
  const baseLargura = proporcao >= 1 ? proporcao * 100 : 100;
  const baseAltura = proporcao >= 1 ? 100 : (100 / proporcao);
  const largura = baseLargura * (dados.zoom ?? 1);
  const altura = baseAltura * (dados.zoom ?? 1);
  const extraX = Math.max(0, largura - 100);
  const extraY = Math.max(0, altura - 100);

  imagem.style.left = `${50 + ((dados.panX ?? 0) * extraX) / 2}%`;
  imagem.style.top = `${50 + ((dados.panY ?? 0) * extraY) / 2}%`;
  imagem.style.width = `${largura}%`;
  imagem.style.height = `${altura}%`;
  area.append(imagem);
}

function excessoEmPixels(dados, quadro) {
  const larguraQuadro = quadro.clientWidth || 1;
  const alturaQuadro = quadro.clientHeight || larguraQuadro;
  const proporcao = dados.w > 0 && dados.h > 0 ? dados.w / dados.h : 1;
  const baseLargura = proporcao >= 1 ? proporcao * larguraQuadro : larguraQuadro;
  const baseAltura = proporcao >= 1 ? alturaQuadro : alturaQuadro / proporcao;
  return {
    x: Math.max(0, baseLargura * dados.zoom - larguraQuadro),
    y: Math.max(0, baseAltura * dados.zoom - alturaQuadro),
  };
}

function limitarPan(dados, quadro) {
  const excesso = excessoEmPixels(dados, quadro);
  if (excesso.x <= 0) dados.panX = 0;
  else dados.panX = Math.max(-1, Math.min(1, dados.panX));
  if (excesso.y <= 0) dados.panY = 0;
  else dados.panY = Math.max(-1, Math.min(1, dados.panY));
}

function abrirEditorDeFoto(midia, { titulo, ajuda, confirmar, maxCaracteres, mensagemGrande }) {
  return new Promise((resolver) => {
    const cortina = $("foto-dialogo");
    const quadro = $("foto-quadro");
    const area = $("foto-imagem");
    const zoom = $("foto-zoom");
    const ajudaEl = $("foto-ajuda");
    const zoomValor = $("foto-zoom-valor");
    const estado = {
      ...midia,
      panX: Number(midia.panX ?? 0),
      panY: Number(midia.panY ?? 0),
      zoom: Number(midia.zoom ?? 1),
    };

    $("foto-titulo").textContent = titulo;
    ajudaEl.textContent = ajuda;
    $("foto-confirmar").textContent = confirmar;
    zoom.value = String(estado.zoom);

    const refletir = () => {
      limitarPan(estado, quadro);
      zoomValor.textContent = `${Math.round(estado.zoom * 100)}%`;
      pintarMidiaEnquadrada(area, estado);
    };

    let arrasto = null;
    const aoPointerDown = (evento) => {
      const excesso = excessoEmPixels(estado, quadro);
      arrasto = {
        x: evento.clientX,
        y: evento.clientY,
        panX: estado.panX,
        panY: estado.panY,
        excesso,
      };
      quadro.setPointerCapture?.(evento.pointerId);
    };

    const aoPointerMove = (evento) => {
      if (!arrasto) return;
      if (arrasto.excesso.x > 0) {
        estado.panX = arrasto.panX + (evento.clientX - arrasto.x) / (arrasto.excesso.x / 2);
      }
      if (arrasto.excesso.y > 0) {
        estado.panY = arrasto.panY + (evento.clientY - arrasto.y) / (arrasto.excesso.y / 2);
      }
      refletir();
    };

    const aoPointerUp = () => {
      arrasto = null;
    };

    const aoWheel = (evento) => {
      evento.preventDefault();
      estado.zoom = Math.max(1, Math.min(4, estado.zoom - Math.sign(evento.deltaY) * 0.08));
      zoom.value = String(estado.zoom);
      refletir();
    };

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      zoom.oninput = null;
      $("foto-confirmar").onclick = null;
      $("foto-cancelar").onclick = null;
      $("foto-fechar").onclick = null;
      cortina.onclick = null;
      quadro.onpointerdown = null;
      quadro.onpointermove = null;
      quadro.onpointerup = null;
      quadro.onpointercancel = null;
      quadro.onwheel = null;
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const confirmarEscolha = () => {
      const serializada = gravarFotoEnquadrada(estado);
      if (serializada.length > maxCaracteres) {
        ajudaEl.textContent = mensagemGrande;
        return;
      }
      fechar(serializada);
    };

    const aoTeclar = (evento) => {
      if (evento.key === "Escape") fechar(null);
    };

    zoom.oninput = () => {
      estado.zoom = Number(zoom.value);
      refletir();
    };
    $("foto-confirmar").onclick = confirmarEscolha;
    $("foto-cancelar").onclick = () => fechar(null);
    $("foto-fechar").onclick = () => fechar(null);
    cortina.onclick = (evento) => {
      if (evento.target === cortina) fechar(null);
    };
    quadro.onpointerdown = aoPointerDown;
    quadro.onpointermove = aoPointerMove;
    quadro.onpointerup = aoPointerUp;
    quadro.onpointercancel = aoPointerUp;
    quadro.onwheel = aoWheel;
    document.addEventListener("keydown", aoTeclar);

    refletir();
    cortina.classList.remove("oculto");
  });
}

async function ajustarFotoDeArquivo(
  arquivo,
  { titulo, ajuda, confirmar, ladoMax, qualidadeBase, maxCaracteres, mensagemGrande, gifMaxBytes = GIF_MAX_BYTES }
) {
  if (!arquivo.type.startsWith("image/")) {
    throw new Error("Escolha um arquivo de imagem.");
  }

  let midia;
  if (arquivo.type === "image/gif") {
    if (arquivo.size > gifMaxBytes) {
      throw new Error(`Esse GIF passa de ${(gifMaxBytes / 1_000_000).toFixed(1)} MB. Tente um menor.`);
    }
    const src = await lerArquivoComoDataURL(arquivo);
    if (src.length > maxCaracteres - 200) {
      throw new Error(mensagemGrande);
    }
    const imagem = await carregarImagem(src);
    midia = { src, w: imagem.naturalWidth, h: imagem.naturalHeight, panX: 0, panY: 0, zoom: 1 };
  } else {
    midia = await imagemRedimensionadaParaEnquadrar(arquivo, {
      ladoMax,
      qualidadeBase,
      maxCaracteres,
      mensagemGrande,
    });
  }

  return abrirEditorDeFoto(midia, { titulo, ajuda, confirmar, maxCaracteres, mensagemGrande });
}

/**
 * Lê um arquivo de imagem e devolve um data URL quadrado, pequeno o bastante
 * para viver na `localStorage` sem drama.
 */
export function lerFotoDeArquivo(arquivo) {
  return ajustarFotoDeArquivo(arquivo, {
    titulo: "Ajustar foto",
    ajuda: "Arraste e ajuste o zoom.",
    confirmar: "Usar esta foto",
    ladoMax: FOTO_PREPARO_LADO,
    qualidadeBase: 0.82,
    maxCaracteres: FOTO_MAX_CARACTERES,
    mensagemGrande: "Essa imagem é grande demais, mesmo depois do ajuste.",
  });
}

export function lerFotoDoGrupoDeArquivo(arquivo) {
  return ajustarFotoDeArquivo(arquivo, {
    titulo: "Ajustar foto do grupo",
    ajuda: "Arraste e ajuste o zoom.",
    confirmar: "Usar esta foto",
    ladoMax: FOTO_GRUPO_PREPARO_LADO,
    qualidadeBase: 0.8,
    maxCaracteres: FOTO_GRUPO_MAX_CARACTERES,
    mensagemGrande: "Essa imagem do grupo ficou grande demais.",
    gifMaxBytes: 500_000,
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
 * O popover que reúne as duas decisões do retrato — mascote e foto — atrás
 * de um único clique no avatar, em vez de dois cartões sempre visíveis. Mesmo
 * padrão do seletor de emoji: um elemento fixo, reancorado a cada abertura,
 * que fecha sozinho no primeiro clique fora dele.
 */
function abrirSeletorDeAvatar(ancora, escolhido, temFoto, aoEscolherMascote, aoEscolherFoto, aoRemoverFoto) {
  const seletor = $("seletor-avatar");
  const botaoRemover = $("seletor-avatar-remover");

  montarEscolhaDeMascotes($("seletor-avatar-mascotes"), escolhido, (id) => {
    fecharSeletorDeAvatar();
    aoEscolherMascote(id);
  });
  botaoRemover.classList.toggle("oculto", !temFoto);
  botaoRemover.onclick = () => {
    fecharSeletorDeAvatar();
    aoRemoverFoto();
  };
  $("seletor-avatar-foto").onclick = () => {
    fecharSeletorDeAvatar();
    aoEscolherFoto();
  };

  seletor.classList.remove("oculto");

  const caixa = ancora.getBoundingClientRect();
  const minha = seletor.getBoundingClientRect();
  const x = Math.min(caixa.left, window.innerWidth - minha.width - 8);
  const y =
    caixa.bottom + minha.height + 8 > window.innerHeight
      ? caixa.top - minha.height - 6
      : caixa.bottom + 6;
  seletor.style.left = `${Math.max(8, x)}px`;
  seletor.style.top = `${Math.max(8, y)}px`;

  setTimeout(() => {
    document.addEventListener("click", fecharSeletorDeAvatar, { once: true });
  }, 0);
}

function fecharSeletorDeAvatar() {
  $("seletor-avatar").classList.add("oculto");
}

function abrirSeletorDeFotoDeGrupo(ancora, temFoto, aoEscolherFoto, aoRemoverFoto) {
  const seletor = $("seletor-foto-grupo");
  const botaoRemover = $("seletor-foto-grupo-remover");

  botaoRemover.classList.toggle("oculto", !temFoto);
  botaoRemover.onclick = () => {
    fecharSeletorDeFotoDeGrupo();
    aoRemoverFoto();
  };
  $("seletor-foto-grupo-escolher").onclick = () => {
    fecharSeletorDeFotoDeGrupo();
    aoEscolherFoto();
  };

  seletor.classList.remove("oculto");

  const caixa = ancora.getBoundingClientRect();
  const minha = seletor.getBoundingClientRect();
  const x = Math.min(caixa.left, window.innerWidth - minha.width - 8);
  const y =
    caixa.bottom + minha.height + 8 > window.innerHeight
      ? caixa.top - minha.height - 6
      : caixa.bottom + 6;
  seletor.style.left = `${Math.max(8, x)}px`;
  seletor.style.top = `${Math.max(8, y)}px`;

  setTimeout(() => {
    document.addEventListener("click", fecharSeletorDeFotoDeGrupo, { once: true });
  }, 0);
}

function fecharSeletorDeFotoDeGrupo() {
  $("seletor-foto-grupo").classList.add("oculto");
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
    const botaoAvatar = $("perfil-avatar-botao");
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
        ? "Foto local"
        : mascote
          ? mascote.nome
          : "Iniciais";

      $("perfil-previa-bio").textContent = previa.bio;
      $("perfil-previa-bio").hidden = !previa.bio;
      // Conta pontos de código: com `.length`, um emoji contaria como dois e a
      // pessoa veria "159/160" com um caractere digitado.
      $("perfil-bio-conta").textContent = `${[...campoBio.value].length}/${BIO_MAX}`;
      $("perfil-salvar").disabled = !campoApelido.value.trim();
    };

    const erroFoto = $("perfil-foto-erro");
    const inputFoto = $("perfil-foto-arquivo");
    // O editor compartilhado de foto está antes deste diálogo no HTML. Sem
    // pausar o perfil, ele abre por baixo desta cortina e a pessoa consegue
    // salvar antes de terminar o recorte. O rascunho então nunca recebe a foto.
    let editandoFoto = false;
    inputFoto.onchange = async () => {
      const arquivo = inputFoto.files?.[0];
      // Zera na hora: sem isto, escolher o mesmo arquivo de novo (depois de
      // remover a foto, por exemplo) não dispara `change` de novo.
      inputFoto.value = "";
      if (!arquivo) return;
      try {
        editandoFoto = true;
        erroFoto.hidden = true;
        cortina.classList.add("oculto");
        const foto = await lerFotoDeArquivo(arquivo);
        // Cancelar o recorte não é remover a foto atual.
        if (foto) {
          rascunho.foto = foto;
          refletir();
        }
      } catch (erro) {
        erroFoto.textContent = erro.message;
        erroFoto.hidden = false;
      } finally {
        editandoFoto = false;
        cortina.classList.remove("oculto");
      }
    };

    botaoAvatar.onclick = (evento) => {
      evento.stopPropagation();
      abrirSeletorDeAvatar(
        botaoAvatar,
        rascunho.avatar,
        Boolean(rascunho.foto),
        (id) => {
          rascunho.avatar = id;
          refletir();
        },
        () => inputFoto.click(),
        () => {
          erroFoto.hidden = true;
          rascunho.foto = "";
          refletir();
        }
      );
    };

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      campoApelido.oninput = null;
      campoBio.oninput = null;
      $("perfil-salvar").onclick = null;
      $("perfil-cancelar").onclick = null;
      $("perfil-fechar").onclick = null;
      botaoAvatar.onclick = null;
      inputFoto.onchange = null;
      cortina.onclick = null;
      fecharSeletorDeAvatar();
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const aoTeclar = (evento) => {
      // Enquanto o editor de recorte está aberto, Escape pertence a ele;
      // fechar o perfil junto descartaria a foto recém-escolhida.
      if (editandoFoto) return;
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
        ? "Foto local"
        : mascote
          ? mascote.nome
          : "Iniciais";

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
export function mostrarCartao({
  apelido,
  avatar,
  bio,
  atividade,
  atividadeIcone,
  etiquetas = [],
  acoes = [],
  buscarAtividade = null,
}) {
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

  // O quadro de atividade — ícone, rótulo pequeno e nome em destaque — em vez
  // de uma linha de texto solta, porque é o "jogando agora" do cartão: quem
  // olha o perfil de alguém já espera achar isto num bloco próprio, como no
  // Discord, e não perdido entre a bio e os botões.
  const caixaAtividade = $("cartao-atividade");
  caixaAtividade.textContent = "";
  caixaAtividade.hidden = !atividade;
  if (atividade) {
    const icone = document.createElement("span");
    preencherIconeDeAtividade(icone, { atividade, atividadeIcone }, "cartao__atividade-icone");

    const texto = document.createElement("span");
    texto.className = "cartao__atividade-texto";
    const rotulo = document.createElement("span");
    rotulo.className = "cartao__atividade-rotulo";
    rotulo.textContent = "Usando";
    const nome = document.createElement("span");
    nome.className = "cartao__atividade-nome";
    nome.textContent = atividade;
    nome.title = atividade;
    texto.append(rotulo, nome);

    // Sem uma busca para acionar, o cabeçalho é um `div` — mesma linha,
    // mesmo espaçamento, só sem seta e sem nada para clicar.
    const cabecalho = document.createElement(buscarAtividade ? "button" : "div");
    cabecalho.className = "cartao__atividade-cabecalho";
    if (buscarAtividade) cabecalho.type = "button";
    cabecalho.append(icone, texto);

    if (!buscarAtividade) {
      caixaAtividade.append(cabecalho);
    } else {
      const seta = document.createElement("span");
      seta.className = "cartao__atividade-seta";
      seta.innerHTML = GLIFO_SETA;
      cabecalho.append(seta);

      const detalhe = document.createElement("div");
      detalhe.className = "cartao__atividade-detalhe";
      detalhe.hidden = true;

      let carregado = false;
      cabecalho.addEventListener("click", async () => {
        const abrindo = detalhe.hidden;
        detalhe.hidden = !abrindo;
        cabecalho.classList.toggle("cartao__atividade-cabecalho--aberto", abrindo);
        if (!abrindo || carregado) return;

        carregado = true;
        detalhe.textContent = "";
        const carregando = document.createElement("p");
        carregando.className = "cartao__atividade-carregando";
        carregando.textContent = "Buscando…";
        detalhe.append(carregando);

        const resumo = await buscarAtividade();
        // A pessoa pode ter fechado o cartão inteiro enquanto a busca ainda
        // estava no ar — escrever num elemento que já saiu da tela não faz
        // mal, mas não custa nada conferir antes.
        if (!detalhe.isConnected) return;

        detalhe.textContent = "";
        if (!resumo) {
          const vazio = document.createElement("p");
          vazio.className = "cartao__atividade-carregando";
          vazio.textContent = "Não encontramos nada sobre isso.";
          detalhe.append(vazio);
          return;
        }

        if (resumo.foto) {
          const capa = document.createElement("img");
          capa.className = "cartao__atividade-capa";
          capa.src = resumo.foto;
          capa.alt = "";
          detalhe.append(capa);
        }

        const corpo = document.createElement("div");
        corpo.className = "cartao__atividade-corpo";

        const paragrafo = document.createElement("p");
        paragrafo.className = "cartao__atividade-resumo";
        paragrafo.textContent = resumo.texto;
        corpo.append(paragrafo);

        const fonte = document.createElement("span");
        fonte.className = "cartao__atividade-fonte";
        fonte.textContent = "Wikipédia";
        corpo.append(fonte);

        detalhe.append(corpo);
      });

      caixaAtividade.append(cabecalho, detalhe);
    }
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

export function editarGrupo(atual, { titulo = "Editar grupo", confirmar = "Salvar", texto = "" } = {}) {
  return new Promise((resolver) => {
    const cortina = $("grupo-dialogo");
    const campoNome = $("grupo-nome");
    const campoDescricao = $("grupo-descricao");
    const botaoAvatar = $("grupo-avatar-botao");
    const rascunho = saneadoGrupo(atual);

    campoNome.value = rascunho.nome;
    campoDescricao.value = rascunho.descricao;
    $("grupo-titulo").textContent = titulo;
    $("grupo-texto").textContent = texto;
    $("grupo-texto").hidden = !texto;
    $("grupo-foto-erro").hidden = true;
    $("grupo-confirmar").textContent = confirmar;

    const refletir = () => {
      const nome = campoNome.value.trim() || rascunho.nome;
      const descricao = campoDescricao.value.trim();
      const previa = $("grupo-previa-avatar");
      pintarMarcaDeGrupo(previa, { nome, foto: rascunho.foto });

      $("grupo-previa-nome").textContent = nome || "Sem nome";
      $("grupo-previa-lema").textContent = descricao;
      $("grupo-previa-lema").hidden = !descricao;
      $("grupo-descricao-conta").textContent = `${[...campoDescricao.value].length}/${GRUPO_DESCRICAO_MAX}`;
      $("grupo-confirmar").disabled = !campoNome.value.trim();
    };

    const inputFoto = $("grupo-foto-arquivo");
    inputFoto.onchange = async () => {
      const arquivo = inputFoto.files?.[0];
      inputFoto.value = "";
      if (!arquivo) return;
      try {
        const foto = await lerFotoDoGrupoDeArquivo(arquivo);
        $("grupo-foto-erro").hidden = true;
        rascunho.foto = foto;
        refletir();
      } catch (erro) {
        $("grupo-foto-erro").textContent = erro.message;
        $("grupo-foto-erro").hidden = false;
      }
    };

    botaoAvatar.onclick = (evento) => {
      evento.stopPropagation();
      abrirSeletorDeFotoDeGrupo(
        botaoAvatar,
        Boolean(rascunho.foto),
        () => inputFoto.click(),
        () => {
          $("grupo-foto-erro").hidden = true;
          rascunho.foto = "";
          refletir();
        }
      );
    };

    const fechar = (valor) => {
      cortina.classList.add("oculto");
      campoNome.oninput = null;
      campoDescricao.oninput = null;
      $("grupo-confirmar").onclick = null;
      $("grupo-cancelar").onclick = null;
      $("grupo-fechar").onclick = null;
      botaoAvatar.onclick = null;
      inputFoto.onchange = null;
      cortina.onclick = null;
      fecharSeletorDeFotoDeGrupo();
      document.removeEventListener("keydown", aoTeclar);
      resolver(valor);
    };

    const salvar = () => {
      const escolhido = saneadoGrupo({
        nome: campoNome.value,
        descricao: campoDescricao.value,
        foto: rascunho.foto,
      });
      if (!escolhido.nome) {
        campoNome.focus();
        return;
      }
      fechar(escolhido);
    };

    const aoTeclar = (evento) => {
      if (evento.key === "Escape") fechar(null);
      else if (evento.key === "Enter" && document.activeElement === campoNome) {
        evento.preventDefault();
        salvar();
      }
    };

    campoNome.oninput = refletir;
    campoDescricao.oninput = refletir;
    $("grupo-confirmar").onclick = salvar;
    $("grupo-cancelar").onclick = () => fechar(null);
    $("grupo-fechar").onclick = () => fechar(null);
    cortina.onclick = (evento) => {
      if (evento.target === cortina) fechar(null);
    };
    document.addEventListener("keydown", aoTeclar);

    refletir();
    cortina.classList.remove("oculto");
    campoNome.focus();
  });
}
