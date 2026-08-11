/**
 * Resumo e foto de uma atividade, pela Wikipedia — só quando a própria
 * pessoa clica para saber mais no cartão de alguém.
 *
 * A busca de verdade mora do lado do Tauri (`resumo_de_atividade`, em
 * `resumo.rs`): é a única chamada deste app a um servidor que não é o de
 * sinalização escolhido pela pessoa nem o LiveKit, e por isso fica isolada
 * lá, atrás das `capabilities` que escopam exatamente os hosts da
 * Wikipedia — este módulo só decide quando perguntar e o que fazer com o
 * cache, do mesmo jeito que `atividade.js` decide política em cima do que o
 * Rust relata.
 */

/** Por nome de atividade, em minúsculas — a mesma busca vale para todo
 *  mundo que estiver usando o mesmo programa, então uma consulta por
 *  programa chega para o grupo inteiro durante a sessão. */
const cache = new Map();

/**
 * `invocar` entra por parâmetro, e não por import direto do Tauri: é o
 * mesmo motivo de `Vigia` receber `ler` de fora em `atividade.js` — quem
 * chama decide como falar com o Tauri, e o módulo não precisa saber.
 *
 * Devolve `null` tanto para "não achou nada" quanto para "a busca falhou" —
 * a interface trata os dois do mesmo jeito, como os testes de `atividade.js`
 * já tratam uma leitura que falha: sem quebrar nada, sem fingir certeza que
 * não existe.
 */
export async function buscarResumoDeAtividade(nome, invocar) {
  const chave = String(nome ?? "").trim().toLowerCase();
  if (!chave) return null;

  if (cache.has(chave)) return cache.get(chave);

  const promessa = invocar("resumo_de_atividade", { nome })
    .then((resumo) => resumo ?? null)
    .catch(() => null);
  cache.set(chave, promessa);

  const resultado = await promessa;
  // Uma busca sem resultado não fica presa no cache: a rede pode ter caído
  // na hora, e a próxima pessoa que clicar merece uma tentativa de verdade,
  // não o mesmo `null` repetido pelo resto da sessão.
  if (resultado === null) cache.delete(chave);
  return resultado;
}
