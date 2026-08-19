/**
 * Bancada do aplicativo de celular.
 *
 *   node scripts/servir-movel.mjs
 *   → http://127.0.0.1:8125/movel/
 *
 * Serve a raiz do repositório, e não uma cópia montada: `movel/` importa
 * `../src/` de verdade, então editar um arquivo do núcleo aparece na tela sem
 * passo de build. A página recarrega sozinha quando qualquer um dos dois
 * muda.
 *
 * Para ver no celular de verdade, use o IP da máquina na rede local. O
 * endereço aparece na partida. Duas ressalvas que valem o aviso:
 *
 * - `getUserMedia` exige contexto seguro. `localhost` conta; um IP da rede
 *   local **não** conta, e o microfone será recusado. Para testar voz no
 *   aparelho, publique numa URL https (o `vercel dev`/preview serve) ou use o
 *   encaminhamento de porta do Chrome DevTools, que faz o celular enxergar o
 *   endereço como `localhost`.
 * - O Service Worker não se registra em `localhost` sem `?sw=1`.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const PORTA = 8125;

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

const clientes = new Set();
let aviso = null;

for (const pasta of ["movel", "src"]) {
  watch(join(raiz, pasta), { recursive: true }, () => {
    clearTimeout(aviso);
    aviso = setTimeout(() => {
      for (const resposta of clientes) resposta.write("data: recarregar\n\n");
    }, 90);
  });
}

createServer(async (pedido, resposta) => {
  const url = new URL(pedido.url, "http://127.0.0.1");

  if (url.pathname === "/__recarga") {
    resposta.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    resposta.write("retry: 600\n\n");
    clientes.add(resposta);
    pedido.on("close", () => clientes.delete(resposta));
    return;
  }

  let relativo = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]+|\.\.[/\\])+/, "");
  if (!relativo) relativo = "movel/index.html";
  let arquivo = join(raiz, relativo);
  if (!arquivo.startsWith(raiz)) {
    resposta.writeHead(403).end();
    return;
  }
  if (url.pathname.endsWith("/")) arquivo = join(arquivo, "index.html");

  try {
    let corpo = await readFile(arquivo);
    if (extname(arquivo) === ".html") {
      const recarga = `<script>new EventSource('/__recarga').onmessage=()=>location.reload()</script>`;
      corpo = Buffer.from(corpo.toString().replace("</body>", `${recarga}</body>`));
    }
    resposta.writeHead(200, {
      "Content-Type": TIPOS[extname(arquivo)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      // O aplicativo mede a `visualViewport` e usa `AudioWorklet`; nenhum
      // deles precisa de cabeçalho especial, mas o `Service-Worker-Allowed`
      // deixa o escopo funcionar quando se testa com `?sw=1`.
      "Service-Worker-Allowed": "/",
    });
    resposta.end(corpo);
  } catch {
    resposta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado");
  }
}).listen(PORTA, "0.0.0.0", () => {
  const enderecos = Object.values(networkInterfaces())
    .flat()
    .filter((rede) => rede?.family === "IPv4" && !rede.internal)
    .map((rede) => rede.address);

  console.log(`CALL no celular:  http://127.0.0.1:${PORTA}/movel/`);
  for (const endereco of enderecos) console.log(`  na rede local:  http://${endereco}:${PORTA}/movel/`);
});
