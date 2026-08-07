/** Servidor estático mínimo para rodar os testes de navegador. */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const RAIZ = process.cwd();
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

createServer(async (req, res) => {
  // Canal de retorno: a página de teste entrega o relatório por aqui.
  if (req.method === "POST" && (req.url === "/resultado" || req.url === "/diagnostico")) {
    const pedacos = [];
    for await (const p of req) pedacos.push(p);
    const corpo = Buffer.concat(pedacos).toString();
    const arquivo = req.url === "/resultado" ? "resultado.json" : "diagnostico.json";
    await writeFile(join(RAIZ, "testes", arquivo), corpo);
    console.log(`[${arquivo}] ${corpo}`);
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    return;
  }

  // Recurso que demora de propósito. A captura de tela do Chromium headless
  // dispara no evento `load` da página, e uma cena que precisa da rede não
  // está pronta a essa altura. `--virtual-time-budget` não resolve: ele adianta
  // os relógios sem adiantar a rede, e o limite de conexão da aplicação estoura
  // antes de o servidor responder. Uma imagem lenta segura o `load` em tempo
  // real, que é o único relógio com que a rede concorda.
  if (req.url.startsWith("/segurar")) {
    const ms = Math.min(Number(new URL(req.url, "http://x").searchParams.get("ms")) || 3000, 30000);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "image/gif" });
      res.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
    }, ms);
    return;
  }

  const caminho = join(RAIZ, normalize(decodeURI(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
  try {
    const corpo = await readFile(caminho);
    res.writeHead(200, { "Content-Type": TIPOS[extname(caminho)] ?? "application/octet-stream" });
    res.end(corpo);
  } catch {
    res.writeHead(404).end("nao encontrado");
  }
}).listen(8123, () => console.log("estatico em http://127.0.0.1:8123"));
