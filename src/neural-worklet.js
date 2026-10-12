/** Só transporta PCM. A rede roda num Worker, fora da thread de renderização. */
class NeuralWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ponte = null;
    this.entrada = new Float32Array(768);
    this.pos = 0;
    this.fila = new Float32Array(768 * 16);
    this.ler = 0;
    this.escrever = 0;
    this.quantidade = 0;
    this.pendentes = 0;
    this.rodando = false;
    this.terminou = false;
    this.faltas = 0;
    this.amostras = 0;
    this.inicio = 0;
    this.receber = ({ data }) => {
      if (this.terminou) return;
      if (!(data instanceof Float32Array) || data.length !== 768 || !data.every(Number.isFinite)) {
        this.falhar("O motor devolveu áudio inválido.");
        return;
      }
      this.pendentes--;
      if (this.quantidade + data.length > this.fila.length) return this.falhar("A fila neural excedeu o limite.");
      for (let i = 0; i < data.length; i++) {
        this.fila[this.escrever] = data[i];
        this.escrever = (this.escrever + 1) % this.fila.length;
      }
      this.quantidade += data.length;
    };
    this.port.onmessage = ({ data }) => {
      if (data === "parar") { this.terminou = true; this.ponte?.close(); }
      else if (data.tipo === "conectar" && !this.ponte) {
        this.ponte = data.porta;
        this.ponte.onmessage = this.receber;
      }
    };
  }

  falhar(causa) {
    if (this.terminou) return;
    this.terminou = true;
    this.ponte?.close();
    this.port.postMessage({ erro: causa });
  }

  process(entradas, saidas) {
    if (this.terminou) return false;
    if (!this.ponte) return true;
    const entrada = entradas[0]?.[0], saida = saidas[0]?.[0];
    if (!entrada || !saida) return true;
    this.amostras += entrada.length;
    for (let i = 0; i < entrada.length; i++) {
      this.entrada[this.pos++] = entrada[i];
      if (this.pos === 768) {
        if (++this.pendentes > 12) { this.falhar("O processamento neural não acompanhou o microfone."); return false; }
        this.ponte.postMessage(this.entrada, [this.entrada.buffer]);
        this.entrada = new Float32Array(768);
        this.pos = 0;
      }
    }
    if (!this.rodando && this.quantidade >= 1536) this.rodando = true;
    if (!this.rodando) return true;
    if (this.quantidade < saida.length) {
      // Uma falta isolada recompõe a reserva. Repetições em dois segundos
      // acionam a recaptura nativa, em vez de manter áudio entrecortado.
      if (this.amostras - this.inicio > 96000) { this.inicio = this.amostras; this.faltas = 0; }
      if (++this.faltas >= 3) this.falhar("A redução neural perdeu o ritmo do áudio.");
      this.rodando = false;
      return !this.terminou;
    }
    for (let i = 0; i < saida.length; i++) {
      saida[i] = this.fila[this.ler];
      this.ler = (this.ler + 1) % this.fila.length;
    }
    this.quantidade -= saida.length;
    return true;
  }
}
registerProcessor("call-neural", NeuralWorklet);
