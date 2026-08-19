/**
 * Escolher e enquadrar uma foto, com o dedo.
 *
 * O CALL de mesa tem o próprio recortador, feito para mouse e roda de
 * rolagem. Aqui o gesto é outro: arrastar para mover, pinçar para ampliar, e
 * a máscara redonda mostrando exatamente o que vai virar retrato. O resultado
 * é o mesmo formato que o servidor e o `localStorage` já esperam — um data
 * URL quadrado, comprimido.
 *
 * GIF passa direto, sem canvas: desenhar um GIF num canvas congela o primeiro
 * quadro, e escolher um GIF animado é justamente escolher a animação. Em
 * troca, o teto de tamanho dele é bem mais apertado.
 */

import { el, vibrar, avisar, abrirFolha, icone } from "./interacao.js";

const ehGif = (arquivo) => /image\/gif/i.test(arquivo?.type ?? "");

/**
 * Abre o seletor de arquivo do sistema e devolve um data URL, ou `null` se a
 * pessoa desistiu.
 *
 * @param lado lado do quadrado final, em pixels
 * @param maxCaracteres teto do data URL resultante
 * @param gifMaxBytes teto do arquivo quando ele é um GIF
 */
export function escolherFoto({
  lado = 256,
  qualidade = 0.82,
  maxCaracteres = 2_200_000,
  gifMaxBytes = 1_500_000,
  redonda = true,
  titulo = "Ajustar foto",
} = {}) {
  return new Promise((resolver) => {
    const entrada = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
    document.body.append(entrada);

    let respondeu = false;
    const encerrar = (valor) => {
      if (respondeu) return;
      respondeu = true;
      entrada.remove();
      resolver(valor);
    };

    /* Desistir do seletor do sistema não dispara evento nenhum: `change` só
       vem quando há arquivo. O sinal de que a pessoa voltou é a janela
       recuperar o foco — e se, um instante depois, nada foi escolhido, é
       porque ela cancelou. Sem isto, quem fecha o seletor deixa a promessa
       pendurada para sempre e o `<input>` esquecido no documento. */
    window.addEventListener(
      "focus",
      () => setTimeout(() => {
        if (!entrada.files?.length) encerrar(null);
      }, 700),
      { once: true }
    );

    entrada.addEventListener("change", async () => {
      const arquivo = entrada.files?.[0];
      if (!arquivo) return encerrar(null);

      if (ehGif(arquivo)) {
        if (arquivo.size > gifMaxBytes) {
          avisar(`Esse GIF passa de ${Math.round(gifMaxBytes / 1024)} KB.`, "erro");
          return encerrar(null);
        }
        const leitor = new FileReader();
        leitor.onload = () => encerrar(String(leitor.result));
        leitor.onerror = () => encerrar(null);
        leitor.readAsDataURL(arquivo);
        return;
      }

      try {
        const imagem = await carregarImagem(arquivo);
        encerrar(await enquadrar(imagem, { lado, qualidade, maxCaracteres, redonda, titulo }));
      } catch {
        avisar("Não deu para ler essa imagem.", "erro");
        encerrar(null);
      }
    });

    // Sem gesto de usuário não há seletor de arquivo no iOS. Este `click`
    // acontece dentro do toque que chamou a função, então vale.
    entrada.click();
  });
}

function carregarImagem(arquivo) {
  return new Promise((resolver, rejeitar) => {
    const url = URL.createObjectURL(arquivo);
    const imagem = new Image();
    // A URL do blob não é revogada aqui: a prévia da folha ainda vai apontar
    // para ela. Quem revoga é o `aoFechar` do enquadramento.
    imagem.onload = () => resolver(imagem);
    imagem.onerror = () => {
      URL.revokeObjectURL(url);
      rejeitar(new Error("imagem ilegível"));
    };
    imagem.src = url;
  });
}

/**
 * A folha de enquadramento. Resolve com o data URL, ou `null`.
 *
 * O estado é `{ zoom, x, y }` em unidades da própria janela de prévia; a
 * conversão para pixels da imagem acontece uma vez só, no fim, quando o
 * canvas desenha. Assim o arrasto é aritmética de duas somas por quadro, e
 * não um redesenho de imagem.
 */
function enquadrar(imagem, { lado, qualidade, maxCaracteres, redonda, titulo }) {
  return new Promise((resolver) => {
    const JANELA = 260; // lado da prévia, em px de tela
    const razao = imagem.naturalWidth / imagem.naturalHeight;

    // Zoom 1 = a imagem cobrindo a janela pelo lado menor.
    let zoom = 1;
    let x = 0;
    let y = 0;

    const desenho = el("img", { src: imagem.src, alt: "", draggable: "false" });
    Object.assign(desenho.style, {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: razao >= 1 ? "auto" : `${JANELA}px`,
      height: razao >= 1 ? `${JANELA}px` : "auto",
      maxWidth: "none",
      willChange: "transform",
      userSelect: "none",
      pointerEvents: "none",
    });

    const janela = el("div", { style: {
      position: "relative",
      width: `${JANELA}px`,
      height: `${JANELA}px`,
      margin: "0 auto",
      overflow: "hidden",
      borderRadius: redonda ? "50%" : "24px",
      background: "var(--superficie-3)",
      touchAction: "none",
      boxShadow: "0 0 0 2px var(--borda-forte)",
    } }, desenho);

    const aplicar = () => {
      const largura = (razao >= 1 ? JANELA * razao : JANELA) * zoom;
      const altura = (razao >= 1 ? JANELA : JANELA / razao) * zoom;
      const limiteX = Math.max(0, (largura - JANELA) / 2);
      const limiteY = Math.max(0, (altura - JANELA) / 2);
      x = Math.min(limiteX, Math.max(-limiteX, x));
      y = Math.min(limiteY, Math.max(-limiteY, y));
      desenho.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${zoom})`;
    };
    aplicar();

    /* ── Gestos ─────────────────────────────────────────────── */

    const dedos = new Map();
    let distancia0 = 0;
    let zoom0 = 1;

    janela.addEventListener("pointerdown", (evento) => {
      janela.setPointerCapture(evento.pointerId);
      dedos.set(evento.pointerId, { x: evento.clientX, y: evento.clientY });
      if (dedos.size === 2) {
        const [a, b] = [...dedos.values()];
        distancia0 = Math.hypot(a.x - b.x, a.y - b.y);
        zoom0 = zoom;
      }
    });

    janela.addEventListener("pointermove", (evento) => {
      const antes = dedos.get(evento.pointerId);
      if (!antes) return;
      const agora = { x: evento.clientX, y: evento.clientY };

      if (dedos.size === 2) {
        dedos.set(evento.pointerId, agora);
        const [a, b] = [...dedos.values()];
        const distancia = Math.hypot(a.x - b.x, a.y - b.y);
        if (distancia0 > 0) zoom = Math.min(4, Math.max(1, (zoom0 * distancia) / distancia0));
      } else {
        x += agora.x - antes.x;
        y += agora.y - antes.y;
        dedos.set(evento.pointerId, agora);
      }
      aplicar();
    });

    const soltar = (evento) => {
      dedos.delete(evento.pointerId);
      if (dedos.size < 2) distancia0 = 0;
    };
    janela.addEventListener("pointerup", soltar);
    janela.addEventListener("pointercancel", soltar);

    const controleZoom = el("input", {
      class: "escala",
      type: "range",
      min: "100",
      max: "400",
      value: "100",
      "aria-label": "Zoom",
    });
    controleZoom.addEventListener("input", () => {
      zoom = Number(controleZoom.value) / 100;
      controleZoom.style.setProperty(
        "--preenchido",
        `${((Number(controleZoom.value) - 100) / 300) * 100}%`
      );
      aplicar();
    });

    /* ── Resultado ──────────────────────────────────────────── */

    function recortar() {
      const tela = document.createElement("canvas");
      tela.width = lado;
      tela.height = lado;
      const pincel = tela.getContext("2d");
      pincel.imageSmoothingQuality = "high";

      // De pixels da prévia para pixels da imagem: a janela mostra `JANELA`
      // px de tela, que valem `JANELA / (fator * zoom)` px da imagem.
      const fator = razao >= 1 ? JANELA / imagem.naturalHeight : JANELA / imagem.naturalWidth;
      const visivel = JANELA / (fator * zoom);
      const centroX = imagem.naturalWidth / 2 - x / (fator * zoom);
      const centroY = imagem.naturalHeight / 2 - y / (fator * zoom);

      pincel.drawImage(
        imagem,
        centroX - visivel / 2,
        centroY - visivel / 2,
        visivel,
        visivel,
        0,
        0,
        lado,
        lado
      );

      // Cai a qualidade até caber. Uma foto normal sai na primeira tentativa.
      for (const q of [qualidade, 0.7, 0.6, 0.5, 0.4]) {
        const url = tela.toDataURL("image/jpeg", q);
        if (url.length <= maxCaracteres) return url;
      }
      return null;
    }

    let resposta = null;
    const folha = abrirFolha({
      titulo,
      texto: "Arraste para mover, pince ou use a barra para ampliar.",
      conteudo: el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "18px" } },
        janela,
        controleZoom
      ),
      acoes: [
        el(
          "button",
          {
            class: "botao botao--primario",
            type: "button",
            onclick: () => {
              const url = recortar();
              if (!url) {
                avisar("Essa imagem ficou grande demais mesmo depois do ajuste.", "erro");
                return;
              }
              vibrar("sucesso");
              resposta = url;
              folha.fechar();
            },
          },
          icone("check"),
          "Usar esta foto"
        ),
        el(
          "button",
          { class: "botao botao--fantasma", type: "button", onclick: () => folha.fechar() },
          "Cancelar"
        ),
      ],
      aoFechar: () => {
        if (imagem.src.startsWith("blob:")) URL.revokeObjectURL(imagem.src);
        resolver(resposta);
      },
    });
  });
}
