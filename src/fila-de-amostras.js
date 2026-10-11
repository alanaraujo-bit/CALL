/**
 * Fila circular de áudio estéreo para o som da tela.
 *
 * O som chega do Rust em pedaços de 20 ms, no ritmo da placa de som de quem
 * transmite e com os soluços do IPC no meio. Quem consome é o `AudioWorklet`,
 * que pede 128 quadros a cada 2,67 ms no ritmo do relógio de saída. Entre os
 * dois fica esta fila — e é ela que decide como soar quando os dois ritmos
 * não batem:
 *
 * - **Antes de tocar, junta uma reserva** (`alvo`). Começar a tocar com o
 *   primeiro pedaço é o que fazia cada atraso de IPC virar um buraco.
 * - **Faltou som** (a reserva acabou): fica em silêncio e volta a juntar
 *   reserva.
 * - **Sobrou som** (a reserva passou de `teto`): descarta o excesso até voltar
 *   ao alvo. Sem isto, uma rajada de pedaços atrasados viraria atraso
 *   permanente entre a imagem e o som.
 *
 * Toda descontinuidade — começar, faltar, descartar — passa pela mesma
 * costura: a última amostra tocada **decai** até zero em `CAUDA` quadros, e o
 * som novo entra em rampa por cima dela. Um corte seco é um clique; uma costura
 * de 1,3 ms não é. A cauda parte do que de fato saiu, e não de um esmaecimento
 * dentro do bloco, porque o som pode acabar exatamente na fronteira de um
 * bloco — e aí não sobra amostra nenhuma para esmaecer.
 *
 * Pura de propósito — sem Web Audio, sem `port` — para ser testável no Node.
 */

/** Comprimento da costura, em quadros: 1,3 ms a 48 kHz. */
const CAUDA = 64;

export class FilaDeAmostras {
  #esquerda;
  #direita;
  #capacidade;
  #escrita = 0;
  #leitura = 0;
  #nivel = 0;
  #juntando = true;
  /** Ganho da rampa do som novo (0 → 1 depois de uma costura). */
  #rampa = 1;
  /** A última amostra que saiu, por canal. */
  #ultimaE = 0;
  #ultimaD = 0;
  /** O valor que está decaindo, e quantos quadros de decaimento faltam. */
  #retidaE = 0;
  #retidaD = 0;
  #cauda = 0;
  #passoDoAlvo;
  #alvoInicial;

  /** Contadores de diagnóstico: quantas vezes faltou e quantas sobrou. */
  faltas = 0;
  descartes = 0;

  /**
   * @param {object} opcoes
   * @param {number} opcoes.alvo reserva inicial, em quadros, antes de tocar
   * @param {number} [opcoes.alvoMaximo] até onde a reserva pode crescer
   * @param {number} opcoes.teto acima disto, o excesso é descartado
   * @param {number} [opcoes.capacidade] tamanho físico da fila, em quadros
   *
   * A reserva **cresce** a cada falta, metade do alvo inicial por vez, até
   * `alvoMaximo`: a máquina que engasga mais ganha mais folga, e a que não
   * engasga fica com o atraso mínimo. É o que todo jitter buffer faz — um
   * número fixo seria curto demais numa máquina com um jogo pesado e longo
   * demais em todas as outras.
   */
  constructor({ alvo, alvoMaximo = alvo, teto, capacidade = teto * 2 }) {
    if (!(alvo > 0) || !(alvoMaximo >= alvo) || !(teto > alvoMaximo) || !(capacidade >= teto)) {
      throw new RangeError("Fila de amostras: alvo <= alvoMaximo < teto <= capacidade.");
    }
    this.alvo = alvo;
    this.#alvoInicial = alvo;
    this.alvoMaximo = alvoMaximo;
    this.#passoDoAlvo = Math.max(1, Math.round(alvo / 2));
    this.teto = teto;
    this.#capacidade = capacidade;
    this.#esquerda = new Float32Array(capacidade);
    this.#direita = new Float32Array(capacidade);
  }

  /** Quadros prontos para tocar. */
  get nivel() {
    return this.#nivel;
  }

  get juntando() {
    return this.#juntando;
  }

  /**
   * Recebe PCM de 16 bits intercalado (E, D, E, D…), que é o que o Rust manda.
   * Aceita `ArrayBuffer` ou `Int16Array`.
   */
  empurrar(dados) {
    const amostras = dados instanceof Int16Array ? dados : new Int16Array(dados);
    const quadros = amostras.length >> 1;
    for (let i = 0; i < quadros; i++) {
      // Fila cheia: o mais antigo sai. Só acontece se o consumidor parou de
      // vez (aba em segundo plano, contexto suspenso) — o teto cuida do resto.
      if (this.#nivel === this.#capacidade) {
        this.#leitura = (this.#leitura + 1) % this.#capacidade;
        this.#nivel--;
      }
      this.#esquerda[this.#escrita] = amostras[2 * i] / 32768;
      this.#direita[this.#escrita] = amostras[2 * i + 1] / 32768;
      this.#escrita = (this.#escrita + 1) % this.#capacidade;
      this.#nivel++;
    }

    if (this.#nivel > this.teto) {
      // Corta até o alvo: o atraso volta ao que era, e não a zero — zerar
      // deixaria a fila sem reserva para o próximo soluço.
      const excesso = this.#nivel - this.alvo;
      this.#leitura = (this.#leitura + excesso) % this.#capacidade;
      this.#nivel -= excesso;
      this.#costurar(); // o salto entra com costura, e não como degrau
      this.descartes++;
    }
  }

  /** Começa uma costura a partir do que saiu por último. */
  #costurar() {
    this.#retidaE = this.#ultimaE;
    this.#retidaD = this.#ultimaD;
    this.#cauda = CAUDA;
    this.#rampa = 0;
  }

  /** Escreve um quadro de saída: o som novo em rampa mais a cauda decaindo. */
  #sair(esquerda, direita, i, e, d) {
    if (this.#rampa < 1) {
      e *= this.#rampa;
      d *= this.#rampa;
      this.#rampa = Math.min(1, this.#rampa + 1 / CAUDA);
    }
    if (this.#cauda > 0) {
      const ganho = this.#cauda / CAUDA;
      e += this.#retidaE * ganho;
      d += this.#retidaD * ganho;
      this.#cauda--;
    }
    esquerda[i] = e;
    direita[i] = d;
    this.#ultimaE = e;
    this.#ultimaD = d;
  }

  /**
   * Preenche `esquerda` e `direita` (mesmo tamanho) com o que houver. Devolve
   * `true` se tocou alguma coisa.
   */
  puxar(esquerda, direita) {
    const pedidos = esquerda.length;

    if (this.#juntando) {
      if (this.#nivel < this.alvo) {
        for (let i = 0; i < pedidos; i++) this.#sair(esquerda, direita, i, 0, 0);
        return false;
      }
      this.#juntando = false;
      this.#costurar();
    }

    const disponiveis = Math.min(pedidos, this.#nivel);
    for (let i = 0; i < disponiveis; i++) {
      this.#sair(esquerda, direita, i, this.#esquerda[this.#leitura], this.#direita[this.#leitura]);
      this.#leitura = (this.#leitura + 1) % this.#capacidade;
    }
    this.#nivel -= disponiveis;

    if (disponiveis < pedidos) {
      // Acabou o som: o que saiu por último decai até o silêncio.
      this.#costurar();
      for (let i = disponiveis; i < pedidos; i++) this.#sair(esquerda, direita, i, 0, 0);
      this.#juntando = true;
      this.faltas++;
      this.alvo = Math.min(this.alvoMaximo, this.alvo + this.#passoDoAlvo);
    }
    return disponiveis > 0;
  }

  /** Esvazia, para uma transmissão nova não herdar som da anterior. */
  limpar() {
    this.#escrita = 0;
    this.#leitura = 0;
    this.#nivel = 0;
    this.#juntando = true;
    this.alvo = this.#alvoInicial;
    this.#rampa = 1;
    this.#ultimaE = this.#ultimaD = 0;
    this.#retidaE = this.#retidaD = 0;
    this.#cauda = 0;
  }
}
