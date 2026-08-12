/**
 * Materializa o cliente LiveKit e o filtro neural de ruido dentro de `src/`,
 * que e o frontendDist do Tauri.
 *
 * Os pacotes ficam no node_modules durante o desenvolvimento, mas o WebView2
 * so recebe o conteudo de `src` no instalador. Copiar no postinstall e antes
 * de cada build mantem o binario reproduzivel sem versionar WASM gerado.
 *
 * O bundle do Krisp e grande (~6 MB) porque traz o modelo dentro. Isso e
 * proposital e e o que mantem a CSP simples: nao ha busca de modelo em CDN,
 * entao `connect-src` nao precisa ser afrouxado.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const pacoteLiveKit = join(raiz, "node_modules", "livekit-client");
const pacoteKrisp = join(raiz, "node_modules", "@livekit", "krisp-noise-filter");
const destino = join(raiz, "src");

await mkdir(destino, { recursive: true });
await Promise.all([
  copyFile(
    join(pacoteLiveKit, "dist", "livekit-client.esm.mjs"),
    join(destino, "livekit-client.esm.mjs")
  ),
  copyFile(join(pacoteLiveKit, "LICENSE"), join(destino, "LIVEKIT-LICENSE.txt")),
  copyFile(join(pacoteKrisp, "dist", "index.js"), join(destino, "krisp-noise-filter.esm.mjs")),
]);
