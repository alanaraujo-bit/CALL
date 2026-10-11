/**
 * Testes da fila que toca o som da tela.
 *
 *   node testes/fila-de-amostras.test.mjs
 *
 * A fila é pura, então o ritmo do Rust (pedaços de 20 ms) e o do worklet
 * (blocos de 128 quadros) são encenados à mão: um minuto de transmissão custa
 * milissegundos e o resultado não depende da máquina.
 */

import { FilaDeAmostras } from "../src/fila-de-amostras.js";

let falhas = 0;
function conferir(condicao, descricao, medida) {
  if (condicao) {
    console.log(`  ok    ${descricao}${medida ? `  [${medida}]` : ""}`);
  } else {
    falhas++;
    console.log(`  FALHA ${descricao}${medida ? `  [${medida}]` : ""}`);
  }
}

const TAXA = 48000;
const PEDACO = 960; // 20 ms, o que o Rust manda
const BLOCO = 128; // o que o worklet pede
const ALVO = Math.round(0.06 * TAXA);
const TETO = Math.round(0.25 * TAXA);

/** Um pedaço de senoide estéreo, continuando de onde a anterior parou. */
function senoide(quadros, fase, frequencia = 440, amplitude = 0.5) {
  const pcm = new Int16Array(quadros * 2);
  for (let i = 0; i < quadros; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * frequencia * (fase + i)) / TAXA) * amplitude * 32767);
    pcm[2 * i] = v;
    pcm[2 * i + 1] = -v;
  }
  return pcm;
}

/** Maior salto entre duas amostras seguidas — numa senoide de 440 Hz a 0,5
 *  ele fica em ~0,029; um clique é um salto muito maior que isso. */
function maiorSalto(amostras) {
  let maior = 0;
  for (let i = 1; i < amostras.length; i++) maior = Math.max(maior, Math.abs(amostras[i] - amostras[i - 1]));
  return maior;
}

const SALTO_DA_SENOIDE = (2 * Math.PI * 440 * 0.5) / TAXA; // derivada máxima por amostra

function puxarBlocos(fila, quantos) {
  const esquerda = new Float32Array(quantos * BLOCO);
  const direita = new Float32Array(quantos * BLOCO);
  for (let b = 0; b < quantos; b++) {
    fila.puxar(esquerda.subarray(b * BLOCO, (b + 1) * BLOCO), direita.subarray(b * BLOCO, (b + 1) * BLOCO));
  }
  return { esquerda, direita };
}

/* ─── Começo ─────────────────────────────────────────────────────── */

console.log("\nAntes de tocar, a fila junta reserva");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  fila.empurrar(senoide(PEDACO, 0));
  const { esquerda } = puxarBlocos(fila, 1);
  conferir(esquerda.every((v) => v === 0), "um pedaço só não basta para começar: sai silêncio", `nível ${fila.nivel}`);
  conferir(fila.juntando, "e a fila continua juntando");

  fila.empurrar(senoide(PEDACO, PEDACO));
  fila.empurrar(senoide(PEDACO, 2 * PEDACO));
  const tocado = puxarBlocos(fila, 1);
  conferir(!fila.juntando, "com 60 ms na fila, começa a tocar", `nível ${fila.nivel}`);
  conferir(tocado.esquerda[0] === 0 && Math.abs(tocado.esquerda[BLOCO - 1]) > 0, "e entra com rampa, a partir do zero");
  conferir(
    tocado.direita.every((v, i) => Math.abs(v + tocado.esquerda[i]) < 1e-6),
    "os dois canais chegam separados, cada um no seu lado"
  );
}

/* ─── Regime ─────────────────────────────────────────────────────── */

console.log("\nCom os dois ritmos batendo, o som é contínuo");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  let fase = 0;
  for (let i = 0; i < 3; i++) {
    fila.empurrar(senoide(PEDACO, fase));
    fase += PEDACO;
  }
  puxarBlocos(fila, 2); // passa a rampa

  // Dez segundos: a cada 20 ms chega um pedaço, e o worklet pede 7,5 blocos.
  const saida = [];
  let devidos = 0;
  for (let p = 0; p < 500; p++) {
    fila.empurrar(senoide(PEDACO, fase));
    fase += PEDACO;
    devidos += PEDACO / BLOCO;
    while (devidos >= 1) {
      saida.push(...puxarBlocos(fila, 1).esquerda);
      devidos--;
    }
  }
  conferir(fila.faltas === 0, "dez segundos sem faltar som", `faltas ${fila.faltas}`);
  conferir(fila.descartes === 0, "e sem descartar nada", `descartes ${fila.descartes}`);
  const salto = maiorSalto(saida);
  conferir(salto < SALTO_DA_SENOIDE * 1.05, "nenhum salto além do da própria onda — nenhum clique", salto.toFixed(4));
}

/* ─── O IPC engasga ──────────────────────────────────────────────── */

console.log("\nQuando o IPC atrasa, a reserva cobre");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  let fase = 0;
  for (let i = 0; i < 3; i++) {
    fila.empurrar(senoide(PEDACO, fase));
    fase += PEDACO;
  }
  puxarBlocos(fila, 2);
  // 40 ms sem chegar nada (dois pedaços atrasados) e depois os dois de uma vez:
  // o caso que antes virava buraco, porque o agendamento já tinha passado.
  puxarBlocos(fila, 15);
  conferir(fila.faltas === 0, "40 ms de atraso não viram buraco", `nível ${fila.nivel}`);
  fila.empurrar(senoide(PEDACO, fase));
  fila.empurrar(senoide(PEDACO, fase + PEDACO));
  conferir(fila.descartes === 0, "e a rajada que chega depois não é descartada");
}

/* ─── Falta de verdade ───────────────────────────────────────────── */

console.log("\nQuando o som acaba, ele esmaece em vez de cortar");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  fila.empurrar(senoide(ALVO + 64, 0, 440, 0.9));
  puxarBlocos(fila, 1);
  const esquerda = new Float32Array(BLOCO * 30);
  const direita = new Float32Array(BLOCO * 30);
  for (let b = 0; b < 30; b++) {
    fila.puxar(esquerda.subarray(b * BLOCO, (b + 1) * BLOCO), direita.subarray(b * BLOCO, (b + 1) * BLOCO));
  }
  conferir(fila.faltas === 1, "a falta é contada uma vez", `faltas ${fila.faltas}`);
  conferir(fila.juntando, "e a fila volta a juntar reserva antes de tocar de novo");
  const salto = maiorSalto(esquerda);
  conferir(salto < 0.1, "o fim do som não tem degrau", salto.toFixed(4));
  conferir(esquerda[esquerda.length - 1] === 0, "e termina em silêncio de verdade");
}

/* ─── Sobra ──────────────────────────────────────────────────────── */

console.log("\nQuando sobra som, o atraso volta ao alvo");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  // Um segundo inteiro de uma vez: o que chegaria depois de a interface ficar
  // travada. Tocar tudo deixaria o som um segundo atrás da imagem para sempre.
  for (let i = 0; i < 50; i++) fila.empurrar(senoide(PEDACO, i * PEDACO));
  conferir(fila.nivel <= TETO, "a fila nunca guarda mais que o teto", `nível ${fila.nivel}`);
  conferir(fila.descartes > 0, "o excesso é descartado", `descartes ${fila.descartes}`);
  const atraso = fila.nivel / TAXA;
  conferir(atraso <= 0.25, "o atraso fica dentro de 250 ms", `${(atraso * 1000).toFixed(0)} ms`);
}
{
  // O descarte no meio de um som que já está tocando: o salto na fila não
  // pode virar degrau na saída.
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  let fase = 0;
  for (let i = 0; i < 4; i++) {
    fila.empurrar(senoide(PEDACO, fase, 440, 0.9));
    fase += PEDACO;
  }
  const antes = puxarBlocos(fila, 8).esquerda;
  for (let i = 0; i < 20; i++) {
    fila.empurrar(senoide(PEDACO, fase + 37, 440, 0.9)); // fase deslocada de propósito
    fase += PEDACO;
  }
  const depois = puxarBlocos(fila, 8).esquerda;
  const costura = new Float32Array([...antes.slice(-BLOCO), ...depois]);
  conferir(fila.descartes > 0, "a rajada provoca descarte", `descartes ${fila.descartes}`);
  const salto = maiorSalto(costura);
  conferir(salto < 0.1, "e a emenda do descarte não tem degrau", salto.toFixed(4));
}

/* ─── Limpar ─────────────────────────────────────────────────────── */

console.log("\nUma transmissão nova não herda som da anterior");
{
  const fila = new FilaDeAmostras({ alvo: ALVO, teto: TETO });
  for (let i = 0; i < 5; i++) fila.empurrar(senoide(PEDACO, i * PEDACO));
  fila.limpar();
  conferir(fila.nivel === 0 && fila.juntando, "limpar esvazia e volta a juntar");
  const { esquerda } = puxarBlocos(fila, 1);
  conferir(esquerda.every((v) => v === 0), "e o primeiro bloco depois é silêncio");
}

/* ─── Contrato ───────────────────────────────────────────────────── */

console.log("\nParâmetros sem sentido são recusados");
{
  let lancou = false;
  try {
    new FilaDeAmostras({ alvo: 100, teto: 50 });
  } catch {
    lancou = true;
  }
  conferir(lancou, "teto menor que o alvo é recusado na construção");
}

console.log("");
if (falhas === 0) {
  console.log("Fila do som da tela: todos os testes passaram.");
  process.exit(0);
}
console.log(`Fila do som da tela: ${falhas} falha(s).`);
process.exit(1);
