/**
 * Toca o som da tela a partir de uma fila, no thread de áudio.
 *
 * Antes, cada pedaço de 20 ms virava um `AudioBufferSource` agendado pelo
 * thread da interface. Bastava a interface engasgar — redesenho, jogo pesado
 * disputando CPU — para o pedaço chegar depois da hora marcada e o som
 * estalar. Aqui o thread da interface só repassa os bytes; quem decide o que
 * tocar a cada 2,67 ms é este processador, que roda no thread de tempo real.
 */

import { FilaDeAmostras } from "./fila-de-amostras.js";

class SomDaTela extends AudioWorkletProcessor {
  constructor(opcoes) {
    super();
    const { alvo, alvoMaximo, teto } = opcoes.processorOptions;
    this.fila = new FilaDeAmostras({ alvo, alvoMaximo, teto });
    this.ultimoRelato = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "limpar") this.fila.limpar();
      else if (data === "relatar") this.relatar();
      else this.fila.empurrar(data);
    };
  }

  relatar() {
    this.port.postMessage({
      nivel: this.fila.nivel,
      alvo: this.fila.alvo,
      faltas: this.fila.faltas,
      descartes: this.fila.descartes,
    });
  }

  process(_entradas, saidas) {
    const [esquerda, direita = esquerda] = saidas[0];
    this.fila.puxar(esquerda, direita);

    // Um relato por segundo basta para o teste e para o console verem se a
    // fila está faltando ou sobrando — mais que isso seria ruído no port.
    if (currentTime - this.ultimoRelato >= 1) {
      this.ultimoRelato = currentTime;
      this.relatar();
    }
    return true;
  }
}

registerProcessor("som-da-tela", SomDaTela);
