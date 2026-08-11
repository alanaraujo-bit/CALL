/**
 * Materializa o cliente LiveKit dentro de `src/`, que e o frontendDist do
 * Tauri.
 *
 * O pacote fica no node_modules durante o desenvolvimento, mas o WebView2 so
 * recebe o conteudo de `src` no instalador. Copiar no postinstall e antes de
 * cada build mantem o binario reproduzivel sem versionar WASM gerado.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const pacoteLiveKit = join(raiz, "node_modules", "livekit-client");
const destino = join(raiz, "src");

await mkdir(destino, { recursive: true });
await Promise.all([
  copyFile(
    join(pacoteLiveKit, "dist", "livekit-client.esm.mjs"),
    join(destino, "livekit-client.esm.mjs")
  ),
  copyFile(join(pacoteLiveKit, "LICENSE"), join(destino, "LIVEKIT-LICENSE.txt")),
]);
