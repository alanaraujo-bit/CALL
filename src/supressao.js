/** Supressão local: GTCRN → isolamento do sistema → redução nativa.
 * O Krisp fica apenas na bancada explícita de licença (supressao-krisp.js).
 * Nenhum caminho de produção tenta ativá-lo sem LiveKit Cloud.
 */
const carregarPadrao = () => import("./neural.js");
export const MOTORES = ["desligada", "neural", "sistema", "nativa"];
export function sistemaIsolaVoz() {
  try { return Boolean(navigator.mediaDevices?.getSupportedConstraints?.().voiceIsolation); }
  catch { return false; }
}

export class Supressao {
  #carregar; #modulo; #carga; #sessao; #recusado = false;
  #motor = "nativa"; #detalhe = ""; #causa = ""; #ouvintes = new Set();
  #aoDegradar; #geracao = 0; #bvcPedido = false;
  constructor({ carregarNeural = carregarPadrao, aoDegradar = null } = {}) {
    this.#carregar = carregarNeural;
    this.#aoDegradar = aoDegradar;
  }
  get motor() { return this.#motor; }
  get detalhe() { return this.#detalhe; }
  get causa() { return this.#causa; }
  get bvcRecusado() { return this.#bvcPedido; }
  get portaFazSentido() { return this.#motor !== "neural"; }
  assinar(ouvinte) {
    if (typeof ouvinte !== "function") return () => {};
    this.#ouvintes.add(ouvinte);
    ouvinte({ motor: this.#motor, detalhe: this.#detalhe });
    return () => this.#ouvintes.delete(ouvinte);
  }
  #anunciar(motor, detalhe = "") {
    if (motor === this.#motor && detalhe === this.#detalhe) return;
    this.#motor = motor; this.#detalhe = detalhe;
    for (const ouvinte of [...this.#ouvintes]) {
      try { ouvinte({ motor, detalhe }); } catch (e) { console.error("[supressao] ouvinte falhou", e); }
    }
  }
  #recusar(erro) {
    this.#recusado = true;
    this.#causa = String(erro?.message ?? erro);
    this.#anunciar("nativa", "A redução neural falhou; usando a redução do sistema.");
  }
  async prepararCaptura(ligada, { vozesAoFundo = false } = {}) {
    this.#bvcPedido = Boolean(vozesAoFundo);
    if (!ligada) {
      await this.soltar();
      this.#anunciar("desligada");
      return { noiseSuppression: false, voiceIsolation: false };
    }
    if (!this.#recusado) {
      try {
        this.#carga ??= (async () => { const m = await this.#carregar(); await m.preparar(); return m; })();
        this.#modulo = await this.#carga;
        this.#anunciar("neural", this.#bvcPedido ? "O motor livre reduz ruídos, mas não remove outras vozes." : "");
        return { noiseSuppression: false, voiceIsolation: false };
      } catch (erro) { this.#recusar(erro); }
    }
    const sistema = sistemaIsolaVoz();
    this.#anunciar(sistema ? "sistema" : "nativa", "A redução neural não está disponível nesta sessão.");
    return { noiseSuppression: !sistema, voiceIsolation: sistema };
  }
  async tratar(trilha, contexto) {
    if (this.#motor !== "neural" || !this.#modulo) return trilha;
    const geracao = ++this.#geracao;
    this.#sessao?.soltar(); this.#sessao = null;
    try {
      const sessao = await this.#modulo.tratar(trilha, contexto, erro => {
        if (geracao !== this.#geracao || this.#motor !== "neural") return;
        this.#recusar(erro);
        this.#sessao?.soltar(); this.#sessao = null;
        this.#aoDegradar?.();
      });
      if (geracao !== this.#geracao) { sessao.soltar(); return trilha; }
      if (!sessao.trilha || sessao.trilha.readyState !== "live") { sessao.soltar(); throw Error("O motor não devolveu trilha viva."); }
      this.#sessao = sessao;
      return sessao.trilha;
    } catch (erro) {
      if (geracao === this.#geracao) this.#recusar(erro);
      // MotorDeAudio consulta novamente e recaptura com as constraints nativas.
      return trilha;
    }
  }
  async aoPublicar() { /* O motor livre independe da sala e do transporte. */ }
  async soltar() { ++this.#geracao; this.#sessao?.soltar(); this.#sessao = null; }
}
