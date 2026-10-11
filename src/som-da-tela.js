/**
 * Tocador do som da tela: o nó que recebe o PCM vindo do Rust e o devolve como
 * áudio contínuo dentro do grafo. O trabalho de verdade está em
 * `som-da-tela-worklet.js` e `fila-de-amostras.js`; aqui fica só a montagem,
 * num lugar que o aplicativo e o teste importam igual.
 */

/** Reserva de 80 ms antes de tocar, que cresce até 150 ms numa máquina que
 *  engasga, e teto de 250 ms de atraso. A reserva cobre os soluços do IPC; o
 *  teto impede uma rajada atrasada de descolar o som da imagem de vez. */
export const RESERVA_DO_SOM_DA_TELA = 0.08;
export const RESERVA_MAXIMA_DO_SOM_DA_TELA = 0.15;
export const TETO_DO_SOM_DA_TELA = 0.25;

/** O módulo do worklet é carregado uma vez por contexto — `addModule`
 *  repetido é inofensivo, mas custa uma ida ao disco a cada transmissão. */
const contextosPreparados = new WeakSet();

export async function criarTocadorDeSomDaTela(contexto) {
  if (!contextosPreparados.has(contexto)) {
    await contexto.audioWorklet.addModule(new URL("./som-da-tela-worklet.js", import.meta.url).href);
    contextosPreparados.add(contexto);
  }
  return new AudioWorkletNode(contexto, "som-da-tela", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      alvo: Math.round(RESERVA_DO_SOM_DA_TELA * contexto.sampleRate),
      alvoMaximo: Math.round(RESERVA_MAXIMA_DO_SOM_DA_TELA * contexto.sampleRate),
      teto: Math.round(TETO_DO_SOM_DA_TELA * contexto.sampleRate),
    },
  });
}
