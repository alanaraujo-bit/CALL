/**
 * Observador do teste de duas instâncias.
 *
 *   node testes/observador.mjs <porta> <codigo> <segundos> <arquivo-de-saida>
 *
 * Entra no grupo como um terceiro membro e anota tudo que o servidor difunde
 * enquanto as duas janelas reais do CALL são conduzidas por fora.
 *
 * Existe porque o roteiro que dirige as janelas só sabia tirar foto, e foto
 * não reprova nada: quando a fita de mascotes mudou a altura da tela de
 * entrada, os cliques passaram a errar o alvo e o teste continuou dizendo
 * "capturado" em cada etapa, com código de saída zero. Um teste que não pode
 * falhar não é um teste — este assiste pelo lado do servidor, que é o único
 * lugar onde dá para provar que as duas instâncias realmente se encontraram.
 */

const [porta, codigo, segundos, destino] = process.argv.slice(2);

const ws = new WebSocket(`ws://127.0.0.1:${porta}`);
const eventos = [];

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      tipo: "entrar",
      codigo,
      apelido: "observador",
      usuario: "observador-teste",
    })
  );
});

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  eventos.push(msg);

  // Entrar no canal de voz é o que permite ver `entrou-voz`: o servidor só
  // difunde isso a quem já está na mesma sala, e não ao grupo inteiro.
  if (msg.tipo === "bem-vindo") {
    const voz = msg.grupo.categorias
      .flatMap((c) => c.canais)
      .find((c) => c.tipo === "voz");
    if (voz) ws.send(JSON.stringify({ tipo: "entrar-voz", canal: voz.id }));
  }
});

await new Promise((r) => setTimeout(r, Number(segundos) * 1000));
ws.close();

const { writeFileSync } = await import("node:fs");
writeFileSync(destino, JSON.stringify(eventos, null, 2));
console.log(`observador: ${eventos.length} eventos`);
