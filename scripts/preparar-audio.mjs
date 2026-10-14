/**
 * Materializa o cliente LiveKit e o filtro de ruido dentro de `src/`, que e o
 * frontendDist do Tauri.
 *
 * Os pacotes ficam no node_modules durante o desenvolvimento, mas o WebView2
 * so recebe o conteudo de `src` no instalador. Copiar no postinstall e antes
 * de cada build mantem o binario reproduzivel sem versionar WASM gerado.
 *
 * O filtro neural e o **GTCRN** (`@sapphi-red/web-noise-suppressor`): um modelo
 * de ~197 KB em WASM que roda num AudioWorklet, inteiramente offline e **sem
 * depender do LiveKit**. E ele que faz o audio ficar bom em qualquer
 * transporte, inclusive sem SFU nenhum. Licenca MIT. Como o modelo vem dentro
 * do proprio pacote, nao ha busca em CDN e `connect-src` nao precisa ser
 * afrouxado.
 *
 * (O Krisp foi removido: so licenciava dentro de uma sala LiveKit Cloud — o
 * degrau pago que o CALL nao usa —, e o GTCRN cobre todos os transportes.)
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copia o worklet do GTCRN trocando `import.meta.url` por uma base fixa.
 *
 * O glue do Emscripten traz `var a=import.meta.url`. Um AudioWorklet nao e um
 * modulo ES: `import.meta` e **erro de sintaxe** no escopo do worklet, e o
 * `addModule` rejeitaria o arquivo inteiro antes de executar uma linha. O
 * `locateFile` que passamos (`e=>e`) e o `wasmBinary` embutido fazem o modelo
 * nunca ser buscado por URL, entao a base so precisa ser uma URL valida para o
 * `new URL(...)` interno nao lancar — o conteudo dela e irrelevante. Fazer a
 * troca aqui, e nao a mao em `src/`, e o que impede o proximo `postinstall` de
 * trazer o token de volta.
 */
async function vendorarWorkletGtcrn(origem, destino) {
  const original = await readFile(origem, "utf8");
  const corrigido = original.replaceAll("import.meta.url", JSON.stringify("https://gtcrn.invalid/"));
  if (corrigido === original) {
    throw new Error("gtcrn-worklet: `import.meta.url` nao foi encontrado — o pacote mudou, revise a troca.");
  }
  await writeFile(destino, corrigido);
}

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const pacoteLiveKit = join(raiz, "node_modules", "livekit-client");
const pacoteGtcrn = join(raiz, "node_modules", "@sapphi-red", "web-noise-suppressor");
const destino = join(raiz, "src");

await mkdir(destino, { recursive: true });
await Promise.all([
  copyFile(
    join(pacoteLiveKit, "dist", "livekit-client.esm.mjs"),
    join(destino, "livekit-client.esm.mjs")
  ),
  copyFile(join(pacoteLiveKit, "LICENSE"), join(destino, "LIVEKIT-LICENSE.txt")),
  // GTCRN: o processador do AudioWorklet (com o glue do WASM embutido) e o
  // modelo. A API de thread principal (carregar o WASM e instanciar o no) e
  // pequena e vive inline em `supressao.js`, entao so estes dois precisam ser
  // materializados.
  vendorarWorkletGtcrn(
    join(pacoteGtcrn, "dist", "gtcrn", "workletProcessor.js"),
    join(destino, "gtcrn-worklet.js")
  ),
  copyFile(join(pacoteGtcrn, "dist", "gtcrn.wasm"), join(destino, "gtcrn.wasm")),
  copyFile(join(pacoteGtcrn, "LICENSE"), join(destino, "GTCRN-LICENSE.txt")),
]);
