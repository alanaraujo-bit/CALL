/**
 * Gera os PNGs do aplicativo de celular a partir do glifo do CALL.
 *
 *   node scripts/gerar-icones-pwa.mjs
 *
 * Rasterizar com o Edge em modo headless é o mesmo caminho que os testes de
 * interface já usam: não acrescenta dependência de build nenhuma ao projeto,
 * e o desenho de saída é exatamente o que um navegador desenharia — que é
 * onde ele vai aparecer.
 *
 * São três formas, e elas não são a mesma imagem em tamanhos diferentes:
 *
 * - **`icone-*`**: o quadrado de canto arredondado, para onde o sistema
 *   mostra o ícone como ele é (Android antigo, aba do navegador, catálogo).
 * - **`mascara-*`**: `purpose: maskable`. O Android recorta este PNG na forma
 *   que o launcher escolher — círculo, gota, esquilo. Só os 80% centrais são
 *   garantidos, então o fundo sangra até a borda e o glifo fica pequeno.
 * - **`toque-180`**: o `apple-touch-icon`. O iOS arredonda sozinho e **não**
 *   respeita transparência, então este é quadrado e opaco.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const executar = promisify(execFile);
const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const destino = join(raiz, "movel", "icones");

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((caminho) => existsSync(caminho));

if (!EDGE) {
  console.error("Edge não encontrado — os ícones são rasterizados com ele.");
  process.exit(1);
}

/** As cinco barras, centradas em 512, com a altura relativa que a marca usa. */
function barras({ escala = 1, cores = ["#6a7079", "#9ba1a9", "#e9ebee"] } = {}) {
  const meio = 256;
  const alturas = [48, 128, 220, 128, 48];
  const tintas = [cores[0], cores[1], cores[2], cores[1], cores[0]];
  const passo = 60 * escala;
  const largura = 34 * escala;

  return alturas
    .map((altura, indice) => {
      const x = meio + (indice - 2) * passo;
      const metade = (altura * escala) / 2;
      return `<path d="M${x} ${meio - metade}v${altura * escala}" stroke="${tintas[indice]}" stroke-width="${largura}" />`;
    })
    .join("\n    ");
}

const pagina = (svg, lado) => `<!doctype html>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${lado}px; height: ${lado}px; }
</style>
${svg}
`;

const svgQuadrado = (raio, escala) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#22262c" />
      <stop offset="1" stop-color="#0d0e10" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${raio}" fill="url(#f)" />
  <g fill="none" stroke-linecap="round">
    ${barras({ escala })}
  </g>
</svg>`;

const PECAS = [
  { arquivo: "icone-192.png", lado: 192, raio: 114, escala: 1 },
  { arquivo: "icone-512.png", lado: 512, raio: 114, escala: 1 },
  // Sangrando até a borda (raio 0) e com o glifo a 62%: o launcher do Android
  // pode cortar até 20% de cada lado, e o que sobra ainda é a marca inteira.
  { arquivo: "mascara-192.png", lado: 192, raio: 0, escala: 0.62 },
  { arquivo: "mascara-512.png", lado: 512, raio: 0, escala: 0.62 },
  { arquivo: "toque-180.png", lado: 180, raio: 0, escala: 0.78 },
];

await mkdir(destino, { recursive: true });
const pasta = join(tmpdir(), `call-icones-${process.pid}`);
await mkdir(pasta, { recursive: true });

for (const peca of PECAS) {
  const html = join(pasta, `${peca.arquivo}.html`);
  await writeFile(html, pagina(svgQuadrado(peca.raio, peca.escala), peca.lado), "utf8");

  const saida = join(destino, peca.arquivo);
  await executar(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--screenshot=${saida}`,
    `--window-size=${peca.lado},${peca.lado}`,
    `--user-data-dir=${join(pasta, "perfil")}`,
    `file:///${html.replace(/\\/g, "/")}`,
  ]);
  console.log(`  ${peca.arquivo} (${peca.lado}px)`);
}

await rm(pasta, { recursive: true, force: true });
console.log("Ícones do PWA gerados em movel/icones/.");
