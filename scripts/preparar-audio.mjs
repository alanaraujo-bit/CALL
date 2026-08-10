/**
 * Materializa o RNNoise dentro de `src/`, que e o frontendDist do Tauri.
 *
 * O pacote fica no node_modules durante o desenvolvimento, mas o WebView2 so
 * recebe o conteudo de `src` no instalador. Copiar no postinstall e antes de
 * cada build mantem o binario reproduzivel sem versionar WASM gerado.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const pacote = join(raiz, "node_modules", "simple-rnnoise-wasm");
const destino = join(raiz, "src");

await mkdir(destino, { recursive: true });
await Promise.all([
  copyFile(join(pacote, "dist", "rnnoise.mjs"), join(destino, "rnnoise.mjs")),
  copyFile(join(pacote, "dist", "rnnoise.worklet.js"), join(destino, "rnnoise.worklet.js")),
  copyFile(join(pacote, "dist", "rnnoise.wasm"), join(destino, "rnnoise.wasm")),
  copyFile(join(pacote, "LICENSE"), join(destino, "RNNOISE-LICENSE.txt")),
]);
