/**
 * O Service Worker do CALL.
 *
 * Faz duas coisas, e as duas importam para a sensação de aplicativo:
 *
 * 1. **Abre instantaneamente.** A casca (HTML, folha de estilo, módulos e
 *    ícones) vem do cache; a rede só entra para atualizar em segundo plano.
 *    Sem isso, abrir o ícone da tela de início mostra branco enquanto o 4G
 *    resolve DNS.
 * 2. **Abre sem rede.** Um aplicativo instalado que dá "sem conexão" na cara
 *    de quem tocou no ícone não é um aplicativo. Aqui ele abre, mostra os
 *    grupos que conhece e avisa que não conseguiu falar com o servidor.
 *
 * O que **nunca** é guardado: o WebSocket do CALL (não passa por `fetch`), e
 * qualquer resposta que não seja um GET de mesma origem. Mensagem, áudio e
 * credencial de mídia não têm nada que fazer num cache de disco.
 *
 * ## Sobre a versão
 *
 * `VERSAO` no nome do cache é o interruptor de invalidação: subir esse número
 * joga fora tudo que a versão anterior guardou. É deliberado que seja manual
 * — um cache que se invalida sozinho a cada deploy não economiza nada e
 * transforma toda abertura em download.
 */

const VERSAO = "1.0.0";
const CACHE = `call-movel-${VERSAO}`;

/** A casca mínima: o que precisa existir para a primeira tela aparecer. */
const CASCA = [
  "./",
  "index.html",
  "estilo.css",
  "app.js",
  "nucleo.js",
  "navegacao.js",
  "interacao.js",
  "icones.js",
  "visual.js",
  "foto.js",
  "notas.js",
  "manifest.webmanifest",
  "icones/icone.svg",
  "icones/icone-192.png",
  "icones/icone-512.png",
  "telas/portal.js",
  "telas/grupos.js",
  "telas/conversa.js",
  "telas/call.js",
  "telas/amigos.js",
  "telas/voce.js",
  "telas/pessoas.js",
  "telas/soundboard.js",
  "telas/instalar.js",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Um arquivo que falhar não pode derrubar a instalação inteira: sem
      // isso, um 404 num ícone deixaria o aplicativo sem Service Worker
      // nenhum, e portanto não instalável.
      await Promise.all(
        CASCA.map((caminho) =>
          cache.add(new Request(caminho, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(
        nomes.filter((nome) => nome.startsWith("call-movel-") && nome !== CACHE).map((nome) => caches.delete(nome))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (evento) => {
  const pedido = evento.request;
  if (pedido.method !== "GET") return;

  const url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;

  // Navegação: a rede manda, o cache salva. Assim uma versão nova aparece na
  // primeira abertura com sinal, e a falta de sinal não impede de abrir.
  if (pedido.mode === "navigate") {
    evento.respondWith(
      (async () => {
        try {
          const daRede = await fetch(pedido);
          const cache = await caches.open(CACHE);
          cache.put("index.html", daRede.clone());
          return daRede;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("index.html")) ?? (await cache.match("./")) ?? Response.error();
        }
      })()
    );
    return;
  }

  // O resto: responde do cache na hora e revalida atrás. É o compromisso
  // certo para uma casca versionada — rápido sempre, atualizado no próximo.
  evento.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const guardado = await cache.match(pedido);

      const daRede = fetch(pedido)
        .then((resposta) => {
          if (resposta.ok && resposta.type === "basic") cache.put(pedido, resposta.clone());
          return resposta;
        })
        .catch(() => null);

      return guardado ?? (await daRede) ?? Response.error();
    })()
  );
});

/** Permite ao aplicativo pedir a troca imediata quando quiser. */
self.addEventListener("message", (evento) => {
  if (evento.data === "assumir-agora") self.skipWaiting();
});
