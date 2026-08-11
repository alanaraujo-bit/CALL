/** Servidor local para acompanhar o CALL no navegador durante o desenvolvimento.
 * Não faz parte da produção: serve os arquivos de `src` e avisa a página quando
 * algum deles muda, para que ela recarregue sozinha. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, normalize } from "node:path";

const raiz = join(process.cwd(), "src");
const tipos = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // Sem isto, `livekit-client.esm.mjs` chega como `application/octet-stream`
  // — e o navegador recusa `import()` de módulo com tipo errado, mesmo o
  // arquivo sendo JavaScript válido.
  ".mjs": "text/javascript; charset=utf-8",
};
const clientes = new Set();
let avisoPendente = null;

function avisarMudanca() {
  clearTimeout(avisoPendente);
  avisoPendente = setTimeout(() => {
    for (const resposta of clientes) resposta.write("data: recarregar\n\n");
  }, 80);
}

watch(raiz, { recursive: true }, avisarMudanca);

createServer(async (pedido, resposta) => {
  const url = new URL(pedido.url, "http://127.0.0.1");
  if (url.pathname === "/__call_ao_vivo") {
    resposta.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    resposta.write("retry: 500\n\n");
    clientes.add(resposta);
    pedido.on("close", () => clientes.delete(resposta));
    return;
  }

  const relativo = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]+|\.\.[/\\])+/, "");
  const arquivo = join(raiz, relativo || "index.html");
  if (!arquivo.startsWith(raiz)) {
    resposta.writeHead(403).end();
    return;
  }

  try {
    let corpo = await readFile(arquivo);
    if (extname(arquivo) === ".html") {
      const recarga = `<script>new EventSource('/__call_ao_vivo').onmessage=()=>location.reload()</script>`;
      corpo = Buffer.from(corpo.toString().replace("</body>", `${recarga}</body>`));
    }
    resposta.writeHead(200, { "Content-Type": tipos[extname(arquivo)] ?? "application/octet-stream" });
    resposta.end(corpo);
  } catch {
    resposta.writeHead(404).end("Não encontrado");
  }
}).listen(8124, () => console.log("CALL ao vivo: http://127.0.0.1:8124"));
