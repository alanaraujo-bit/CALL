/**
 * Monta o aplicativo de celular em `docs/app/`, que é o que a Vercel publica.
 *
 *   node scripts/montar-pwa.mjs
 *
 * ## Por que existe um passo de montagem
 *
 * Em desenvolvimento, `movel/` importa o núcleo com `../src/sinal.js` — o
 * arquivo de verdade, o mesmo que o CALL de mesa usa. Não há cópia, não há
 * duplicata, e corrigir um defeito no protocolo corrige nos dois clientes.
 *
 * Publicado, porém, `docs/` é a raiz do site: subir `src/` inteiro junto
 * exporia o frontend do aplicativo de mesa numa URL pública sem motivo. Então
 * a montagem copia **só os módulos que o celular importa** para
 * `docs/app/nucleo/` e reescreve os caminhos. A reescrita é textual e
 * ancorada no início da string do `import`, que é o único formato que este
 * projeto usa — não há empacotador nenhum no caminho, e não deve haver.
 *
 * A saída é gerada: `docs/app/` está no `.gitignore` e é reconstruída pela
 * Vercel a cada publicação (ver `buildCommand` em `vercel.json`).
 */

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const origem = join(raiz, "movel");
const destino = join(raiz, "docs", "app");
const nucleo = join(destino, "nucleo");

/**
 * Os módulos do CALL de mesa que o celular reaproveita.
 *
 * A lista é explícita de propósito: copiar `src/` inteiro levaria junto o
 * `app.js` e o `index.html` do aplicativo de mesa, que não têm nada que fazer
 * numa página pública — e um dia levaria também um arquivo novo que ninguém
 * pensou em revisar antes de publicar.
 */
const MODULOS = [
  "sinal.js",
  "livekit.js",
  "rtc.js",
  "audio.js",
  "supressao.js",
  "porta-de-ruido.js",
  "sons.js",
  "tempo.js",
  "avatares.js",
  "emojis.js",
  "perfil.js",
  "plataformas.js",
  "conta.js",
  "notas-de-versao.js",
  "feedback.js",
];

/** Pesado, e carregado só quando a call começa — mas precisa estar lá. */
const CLIENTE_LIVEKIT = "livekit-client.esm.mjs";

async function principal() {
  await rm(destino, { recursive: true, force: true });
  await mkdir(nucleo, { recursive: true });

  // 1. A casca do celular, com os caminhos reescritos.
  await copiarComReescrita(origem, destino);

  // 2. O núcleo compartilhado.
  for (const modulo of MODULOS) {
    const de = join(raiz, "src", modulo);
    if (!existsSync(de)) throw new Error(`Módulo do núcleo não encontrado: src/${modulo}`);
    await cp(de, join(nucleo, modulo));
  }

  const livekit = join(raiz, "src", CLIENTE_LIVEKIT);
  if (existsSync(livekit)) {
    await cp(livekit, join(nucleo, CLIENTE_LIVEKIT));
    await cp(join(raiz, "src", "LIVEKIT-LICENSE.txt"), join(nucleo, "LIVEKIT-LICENSE.txt")).catch(
      () => {}
    );
  } else {
    console.warn(
      `AVISO: src/${CLIENTE_LIVEKIT} não existe. Rode "npm install" (o postinstall o materializa) antes de publicar, ou as chamadas de voz não vão conectar.`
    );
  }

  const total = await contar(destino);
  console.log(`docs/app/ montado — ${total.arquivos} arquivos, ${(total.bytes / 1024).toFixed(0)} KB.`);
}

/**
 * Copia `movel/` para `docs/app/`, trocando `../src/` (e `../../src/`, de
 * dentro de `telas/`) pelo caminho equivalente até `nucleo/`.
 */
async function copiarComReescrita(de, para, profundidade = 0) {
  await mkdir(para, { recursive: true });

  for (const item of await readdir(de, { withFileTypes: true })) {
    const origemItem = join(de, item.name);
    const destinoItem = join(para, item.name);

    if (item.isDirectory()) {
      await copiarComReescrita(origemItem, destinoItem, profundidade + 1);
      continue;
    }

    if (extname(item.name) === ".js") {
      const texto = await readFile(origemItem, "utf8");
      // `../` repetido conforme a profundidade: de `telas/`, `nucleo/` está
      // um nível acima; da raiz, está ao lado.
      const subida = profundidade === 0 ? "./" : "../".repeat(profundidade);
      const reescrito = texto
        .replaceAll('"../src/', `"${subida}nucleo/`)
        .replaceAll('"../../src/', `"${subida}nucleo/`)
        .replaceAll("'../src/", `'${subida}nucleo/`)
        .replaceAll("'../../src/", `'${subida}nucleo/`);
      await writeFile(destinoItem, reescrito, "utf8");
      continue;
    }

    await cp(origemItem, destinoItem);
  }
}

async function contar(pasta) {
  let arquivos = 0;
  let bytes = 0;
  for (const item of await readdir(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, item.name);
    if (item.isDirectory()) {
      const dentro = await contar(caminho);
      arquivos += dentro.arquivos;
      bytes += dentro.bytes;
    } else {
      arquivos++;
      bytes += (await stat(caminho)).size;
    }
  }
  return { arquivos, bytes };
}

await principal();
