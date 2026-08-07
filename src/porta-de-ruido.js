/**
 * Porta de ruído — expansor descendente com piso adaptativo.
 *
 * Roda na thread de áudio, em blocos de 128 amostras (2,67 ms a 48 kHz). O
 * supressor do Chromium já tira o chiado estacionário; o que sobra é o "tom de
 * sala" — respiração, ventilador, teclado, o eco baixo do cômodo. Ele é
 * inaudível sozinho e insuportável somado a cinco pessoas.
 *
 * Três decisões que separam uma porta boa de uma porta que estraga a voz:
 *
 * 1. **Expansor, não chave.** Abaixo do limiar o ganho não vai a zero: cai por
 *    uma razão, com atenuação máxima limitada. Um corte total é audível como
 *    um buraco; uma atenuação de 30 dB soa como a sala tendo ficado silenciosa.
 *
 * 2. **Piso adaptativo.** O limiar não é um número fixo que o usuário adivinha:
 *    ele acompanha o ruído de fundo medido, com uma margem por cima. O mesmo
 *    ajuste funciona num quarto silencioso e ao lado de um ar-condicionado.
 *
 * 3. **Histerese e permanência.** Abre num limiar mais baixo do que fecha, e
 *    continua aberta por um tempo depois da última sílaba. Sem isso a porta
 *    treme nas pausas entre palavras — o defeito que faz todo mundo desligar
 *    a supressão de ruído.
 */

/** Piso absoluto: abaixo disto é silêncio digital, não vale medir. */
const PISO_ABSOLUTO_DB = -90;

/** Converte tempo de constante em coeficiente de um filtro de primeira ordem. */
function coeficiente(segundos, taxa) {
  if (segundos <= 0) return 0;
  return Math.exp(-1 / (segundos * taxa));
}

const paraDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));
const paraLinear = (db) => 10 ** (db / 20);

class PortaDeRuido extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      /**
       * Liga a porta. É parâmetro, e não mensagem pela porta de comunicação,
       * porque a mensagem chega quando o motor a entrega — e ele pode entregá-la
       * depois de já ter processado o áudio. Um parâmetro vale na hora.
       */
      { name: "ativa", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      /**
       * Sensibilidade em dB. É o limiar *mínimo* de abertura: o limiar real é
       * o maior entre este valor e o piso de ruído medido mais a margem. Mais
       * negativo = deixa passar mais.
       */
      { name: "limiar", defaultValue: -50, minValue: -80, maxValue: -15, automationRate: "k-rate" },
      /** Atenuação máxima aplicada com a porta fechada, em dB. */
      { name: "atenuacao", defaultValue: -32, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      /** Ganho de entrada aplicado depois da porta. */
      { name: "ganho", defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    /** Quando falso, o medidor não é calculado nem enviado. */
    this.reportando = false;

    const taxa = sampleRate;

    // Detector: sobe quase instantaneamente e desce devagar. A subida rápida é
    // o que garante que o ataque de uma palavra não seja comido.
    this.envelope = 0;
    this.subidaDetector = coeficiente(0.002, taxa);
    this.descidaDetector = coeficiente(0.05, taxa);

    // Ganho aplicado: rampas por amostra, senão cada bloco vira um degrau
    // audível como estalo.
    this.ganhoAtual = 1;
    this.aberturaGanho = coeficiente(0.004, taxa);
    this.fechamentoGanho = coeficiente(0.12, taxa);

    // Piso de ruído em dB. Começa pessimista e é puxado para baixo depressa.
    // Os coeficientes já vêm elevados ao tamanho do bloco: ele é atualizado uma
    // vez por bloco, e uma potência por bloco é trabalho que não precisa ser
    // refeito 375 vezes por segundo.
    this.piso = -55;
    this.pisoDescendo = coeficiente(0.15, taxa) ** 128;
    this.pisoSubindo = coeficiente(4.0, taxa) ** 128;

    /** Quanto acima do piso medido a porta abre. */
    this.margem = 9;
    /** Diferença entre abrir e fechar, que impede a porta de tremer. */
    this.histerese = 7;

    this.permanencia = 0.28 * taxa;
    this.restaAberta = 0;
    this.aberta = false;

    // Medidor: um envio a cada ~32 ms basta para uma barra fluida e não pesa.
    this.blocosPorEnvio = Math.max(1, Math.round(taxa / 128 / 30));
    this.blocosDesdeEnvio = 0;
    this.picoDoPeriodo = 0;

    this.port.onmessage = ({ data }) => {
      if (data.reportando !== undefined) this.reportando = Boolean(data.reportando);
    };
  }

  process(entradas, saidas, parametros) {
    const entrada = entradas[0];
    const saida = saidas[0];
    if (!entrada || entrada.length === 0 || !saida || saida.length === 0) return true;

    const canalEntrada = entrada[0];
    const quadros = canalEntrada.length;
    const ganhoEntrada = parametros.ganho[0];

    // Envelope do bloco, amostra a amostra: é ele que decide abrir ou fechar.
    let pico = 0;
    for (let i = 0; i < quadros; i++) {
      const amostra = Math.abs(canalEntrada[i]);
      if (amostra > pico) pico = amostra;
      const coef = amostra > this.envelope ? this.subidaDetector : this.descidaDetector;
      this.envelope = amostra + (this.envelope - amostra) * coef;
    }
    if (pico > this.picoDoPeriodo) this.picoDoPeriodo = pico;

    const nivelDb = paraDb(this.envelope);

    // O piso persegue o nível para baixo e sobe com muita relutância: assim ele
    // acaba representando o silêncio da sala, e não a voz que passou por cima.
    if (nivelDb > PISO_ABSOLUTO_DB) {
      const coef = nivelDb < this.piso ? this.pisoDescendo : this.pisoSubindo;
      this.piso = nivelDb + (this.piso - nivelDb) * coef;
    }

    const limiarPedido = parametros.limiar[0];
    const abertura = Math.max(limiarPedido, this.piso + this.margem);
    const fechamento = abertura - this.histerese;

    if (this.aberta ? nivelDb > fechamento : nivelDb > abertura) {
      this.aberta = true;
      this.restaAberta = this.permanencia;
    } else if (this.restaAberta > 0) {
      this.restaAberta -= quadros;
    } else {
      this.aberta = false;
    }

    // Alvo de ganho.
    //
    // A primeira versão disto era um expansor puro: a atenuação crescia com a
    // distância abaixo do limiar. A medição reprovou-a, e o motivo é estrutural.
    // O limiar de fechamento é `piso + margem − histerese`, ou seja, ele fica
    // por construção poucos decibéis acima do ruído de fundo — e o ruído de
    // fundo nunca chega a ficar longe o bastante do limiar para ganhar mais do
    // que uns 5 dB de corte. O expansor mordia o próprio rabo.
    //
    // O que funciona é separar as duas coisas. Quem decide se corta é a máquina
    // de estados, com histerese e permanência; quem suaviza é o tempo, na rampa
    // por amostra logo abaixo. O joelho entre `fechamento` e `abertura` fica
    // para o que está em cima do limiar, onde uma decisão dura seria audível.
    let alvo;
    if (parametros.ativa[0] < 0.5 || this.aberta || this.restaAberta > 0) {
      alvo = 1;
    } else if (nivelDb > fechamento) {
      // Zona intermediária: nem voz nem silêncio claro. Atenua em proporção,
      // para que um som limítrofe apareça e suma sem degraus.
      const parte = (abertura - nivelDb) / Math.max(abertura - fechamento, 1e-6);
      alvo = paraLinear(Math.min(Math.max(parte, 0), 1) * parametros.atenuacao[0]);
    } else {
      alvo = paraLinear(parametros.atenuacao[0]);
    }

    const coefGanho = alvo > this.ganhoAtual ? this.aberturaGanho : this.fechamentoGanho;
    const canaisSaida = saida.length;

    for (let i = 0; i < quadros; i++) {
      this.ganhoAtual = alvo + (this.ganhoAtual - alvo) * coefGanho;
      const amostra = canalEntrada[i] * this.ganhoAtual * ganhoEntrada;
      for (let c = 0; c < canaisSaida; c++) saida[c][i] = amostra;
    }

    if (this.reportando && ++this.blocosDesdeEnvio >= this.blocosPorEnvio) {
      this.blocosDesdeEnvio = 0;
      this.port.postMessage({
        nivel: paraDb(this.picoDoPeriodo),
        piso: this.piso,
        abertura,
        aberta: this.ganhoAtual > 0.5,
      });
      this.picoDoPeriodo = 0;
    }

    return true;
  }
}

registerProcessor("porta-de-ruido", PortaDeRuido);
