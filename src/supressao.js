/**
 * Supressão de ruído: escolhe o melhor motor disponível e diz qual escolheu.
 *
 * O supressor nativo do Chromium (`noiseSuppression: true`) só remove ruído
 * **estacionário** — chiado, ventilador, zumbido de fonte. Ele é cego para
 * teclado, prato, cadeira, cachorro e televisão. A porta de ruído
 * (`porta-de-ruido.js`) cobre o outro lado: remove tudo, mas só **enquanto a
 * pessoa está calada**. Juntas, as duas deixam passar exatamente o que mais
 * incomoda: o ruído que acontece **durante** a fala.
 *
 * É essa a distância para o Discord, e ela não se fecha com ajuste de
 * parâmetro. O que falta é um terceiro tipo de motor: uma rede neural que
 * separa voz de não-voz quadro a quadro, inclusive por cima da fala. No
 * Discord isso é o Krisp — e é literalmente o mesmo Krisp que o LiveKit
 * distribui para quem está no LiveKit Cloud, que é o nosso caso.
 *
 * Há três motores, em ordem de preferência:
 *
 *   1. `neural`  — Krisp. O modelo vem embutido no pacote, mas ele **não** é
 *                  autossuficiente: ver a nota sobre a CSP abaixo.
 *   2. `sistema` — `voiceIsolation`, o isolamento de voz do próprio sistema
 *                  operacional (Windows Studio Effects, macOS). Custa zero de
 *                  CPU porque é o SO/NPU que faz, mas só existe em máquina que
 *                  tenha o recurso.
 *   3. `nativa`  — o supressor do Chromium mais a porta de ruído. É o que o
 *                  CALL sempre fez, e continua sendo o chão quando nada acima
 *                  está disponível.
 *
 * **Eles nunca se acumulam.** Dois supressores em série produzem "ruído
 * musical" — aquele borbulhar metálico em volta das palavras — e o resultado
 * fica pior do que com um só. Quem escolhe é este módulo, e a escolha decide
 * tanto as constraints da captura quanto se a porta de ruído fica de pé.
 *
 * O motor escolhido é observável (`assinar`) porque a interface precisa dizer
 * qual está valendo: "o ruído continua passando" tem causas diferentes se a
 * resposta for `neural` ou `nativa`, e quem usa não tem como adivinhar.
 *
 * ## O Krisp depende da CSP, e falha calado
 *
 * Duas linhas de `src-tauri/tauri.conf.json` são pré-requisito dele. Sem
 * qualquer uma, o `init` lança, a queda para o motor de baixo acontece como
 * projetada, e **tudo continua funcionando com ruído** — que é o modo de
 * falhar mais caro possível, porque não parece falha nenhuma:
 *
 * - `connect-src https://integrations.livekit.io` — ele confere a licença
 *   nesse endereço ao iniciar. Bloqueado, o erro é `Failed to fetch`.
 * - `script-src blob:` e `worker-src blob:` — o worklet dele é montado a
 *   partir de uma URL `blob:`. Bloqueado, o erro é `WORKLET_NOT_SUPPORTED`.
 *
 * Os dois só aparecem sob a CSP real. `testes/krisp-reabrir.html` roda sob
 * ela de propósito — foi assim que os dois foram encontrados, depois de
 * passarem batido num navegador sem política nenhuma.
 */

const carregarKrispPadrao = () => import("./krisp-noise-filter.esm.mjs");

/**
 * Estados possíveis. `indisponivel` não é um motor: é a memória de que o Krisp
 * já foi tentado e recusado nesta sessão, para não tentar de novo a cada
 * reabertura do microfone.
 */
export const MOTORES = ["desligada", "neural", "sistema", "nativa"];

/** O `voiceIsolation` é recente. Perguntar antes evita pedir ao
 *  `getUserMedia` uma constraint que ele não conhece — e que, em navegador
 *  antigo, derruba a captura inteira em vez de ser ignorada. */
export function sistemaIsolaVoz() {
  try {
    return Boolean(navigator.mediaDevices?.getSupportedConstraints?.().voiceIsolation);
  } catch {
    return false;
  }
}

export class Supressao {
  #carregarKrisp;
  #modulo = null;
  #processador = null;
  #motor = "nativa";
  #krispRecusado = false; // já tentou e não deu; não insistir nesta sessão
  #detalhe = "";
  #causa = ""; // o erro cru, para diagnóstico — nunca vai para a interface
  #ouvintes = new Set();
  #aoDegradar = null;

  /**
   * `aoDegradar` é chamado quando o Krisp cai **depois** de já estar valendo —
   * o caso real é o LiveKit negar a licença na hora de publicar. Quando isso
   * acontece o microfone precisa ser recapturado com o supressor nativo, senão
   * a pessoa fica sem supressão nenhuma justamente por termos desligado o
   * nativo para dar lugar ao Krisp.
   */
  constructor({ carregarKrisp = carregarKrispPadrao, aoDegradar = null } = {}) {
    this.#carregarKrisp = carregarKrisp;
    this.#aoDegradar = aoDegradar;
  }

  /** Qual motor está valendo agora. */
  get motor() {
    return this.#motor;
  }

  /** Por que não é o de cima da lista. Vazio quando não há o que explicar. */
  get detalhe() {
    return this.#detalhe;
  }

  /** O erro cru por trás de `detalhe`. Existe para o teste e para o console:
   *  "não carregou" e "carregou e recusou a trilha" pedem correções
   *  diferentes, e a frase da interface apaga essa diferença de propósito. */
  get causa() {
    return this.#causa;
  }

  /**
   * Se a porta de ruído ainda tem trabalho a fazer.
   *
   * Ela sai de cena **só** sob o Krisp. Com uma rede neural na frente, o piso
   * de ruído que a porta mede desaba para perto do silêncio digital — e
   * `piso + margem`, que é como ela decide abrir, passa a cortar sílaba.
   * Manter a porta ali troca "ouço o teclado dele" por "ele come o começo das
   * palavras", que é pior e muito mais difícil de diagnosticar.
   *
   * Nos outros três casos ela fica, e cada um por seu motivo:
   *
   * - `nativa`: é o par de sempre, e a porta é justamente o que cobre o que o
   *   supressor do Chromium não vê.
   * - `desligada`: quem desmarcou a redução de ruído não desmarcou a porta.
   *   São dois controles, e desligar um não pode desligar o outro por tabela.
   * - `sistema`: aqui é prudência. `getSupportedConstraints().voiceIsolation`
   *   diz que o Chromium **conhece** a constraint, não que a máquina tenha o
   *   efeito — numa sem Studio Effects o pedido é aceito e não faz nada. Tirar
   *   a porta com base nessa promessa deixaria a pessoa sem defesa nenhuma e
   *   sem sinal de que isso aconteceu. Do Krisp, ao contrário, chega evento
   *   dizendo que ele está mesmo valendo.
   */
  get portaFazSentido() {
    return this.#motor !== "neural";
  }

  assinar(ouvinte) {
    if (typeof ouvinte !== "function") return () => {};
    this.#ouvintes.add(ouvinte);
    ouvinte({ motor: this.#motor, detalhe: this.#detalhe });
    return () => this.#ouvintes.delete(ouvinte);
  }

  #anunciar(motor, detalhe = "") {
    if (motor === this.#motor && detalhe === this.#detalhe) return;
    this.#motor = motor;
    this.#detalhe = detalhe;
    for (const ouvinte of [...this.#ouvintes]) {
      try {
        ouvinte({ motor, detalhe });
      } catch (erro) {
        console.error("[supressao] ouvinte falhou", erro);
      }
    }
  }

  /**
   * Decide o motor **antes** da captura, porque a escolha muda as constraints
   * que vão ao `getUserMedia`. Carregar o Krisp é o que demora (o pacote traz
   * o modelo dentro), então acontece aqui e uma vez só.
   *
   * Devolve o que `restricoesDoMicrofone` precisa saber: qual supressor pedir
   * ao sistema. O `false` nos dois é o caso da neural — ela vem depois, no
   * grafo, e o pedido ao sistema tem que sair do caminho.
   */
  async prepararCaptura(ligada) {
    if (!ligada) {
      this.#anunciar("desligada");
      return { noiseSuppression: false, voiceIsolation: false };
    }

    if (!this.#krispRecusado && (await this.#garantirKrisp())) {
      this.#anunciar("neural");
      return { noiseSuppression: false, voiceIsolation: false };
    }

    if (sistemaIsolaVoz()) {
      this.#anunciar("sistema", this.#detalheDaRecusa());
      return { noiseSuppression: false, voiceIsolation: true };
    }

    this.#anunciar("nativa", this.#detalheDaRecusa());
    return { noiseSuppression: true, voiceIsolation: false };
  }

  #detalheDaRecusa() {
    return this.#detalhe || "A redução neural não está disponível nesta máquina.";
  }

  async #garantirKrisp() {
    if (this.#processador) return true;
    try {
      this.#modulo ??= await this.#carregarKrisp();
      if (!this.#modulo.isKrispNoiseFilterSupported()) {
        this.#krispRecusado = true;
        this.#detalhe = "Esta máquina não suporta a redução neural.";
        return false;
      }
      // `quality: "medium"` é o padrão do pacote e o equilíbrio que o próprio
      // Krisp recomenda; "high" pesa em máquina fraca com um jogo aberto, que
      // é justamente a situação de uso do CALL.
      this.#processador = this.#modulo.KrispNoiseFilter({ quality: "medium" });
      return true;
    } catch (erro) {
      console.warn("[supressao] o filtro neural não carregou", erro);
      this.#krispRecusado = true;
      this.#causa = String(erro?.message ?? erro);
      this.#detalhe = "A redução neural não pôde ser carregada.";
      return false;
    }
  }

  /**
   * Põe o motor neural no caminho da trilha crua e devolve a trilha que deve
   * alimentar o grafo. Nos outros motores devolve a trilha recebida sem tocar
   * nela — `sistema` e `nativa` acontecem dentro da captura, e não aqui.
   *
   * Recebe o `AudioContext` do motor de áudio de propósito: um contexto só
   * para o filtro seria um segundo dispositivo de renderização aberto, e abrir
   * um segundo caminho de áudio é uma causa conhecida de o AEC do Chromium
   * perder o alinhamento com o sinal de referência.
   */
  async tratar(trilha, contexto) {
    if (this.#motor !== "neural" || !this.#processador) return trilha;

    const opcoes = { kind: "audio", track: trilha, audioContext: contexto };
    try {
      if (this.#processador.processedTrack) await this.#processador.restart(opcoes);
      else await this.#processador.init(opcoes);
    } catch (erro) {
      console.warn("[supressao] o filtro neural não iniciou", erro);
      this.#krispRecusado = true;
      this.#processador = null;
      this.#causa = String(erro?.message ?? erro);
      this.#anunciar("nativa", "A redução neural falhou ao iniciar.");
      return trilha;
    }

    const tratada = this.#processador.processedTrack;
    if (!tratada) {
      this.#krispRecusado = true;
      this.#anunciar("nativa", "A redução neural não devolveu áudio.");
      return trilha;
    }

    // O pacote avisa por evento quando a licença é recusada ou quando ele se
    // desliga sozinho por sobrecarga. Sem ouvir isso, o filtro sai do caminho
    // em silêncio e ficamos com supressão nenhuma — pior do que nunca ter
    // tentado, porque o nativo foi desligado para dar lugar a ele.
    //
    // A retirada antes da inscrição é para o caminho do `restart`: trocar de
    // microfone mantém a mesma `processedTrack`, e sem isto cada troca
    // penduraria mais uma cópia do mesmo ouvinte.
    tratada.removeEventListener("disable-lk-krisp-noise-filter", this.#aoDesligar);
    tratada.removeEventListener("enable-lk-krisp-noise-filter", this.#aoLigar);
    tratada.addEventListener("disable-lk-krisp-noise-filter", this.#aoDesligar);
    tratada.addEventListener("enable-lk-krisp-noise-filter", this.#aoLigar);
    return tratada;
  }

  #aoLigar = () => {
    this.#anunciar("neural");
  };

  #aoDesligar = () => {
    if (this.#motor !== "neural") return;
    this.#krispRecusado = true;
    this.#anunciar("nativa", "A redução neural não está liberada para esta sala.");
    // Recapturar é responsabilidade de quem abriu o microfone: as constraints
    // mudaram, e só o `getUserMedia` pode ligar o supressor nativo de volta.
    this.#aoDegradar?.();
  };

  /**
   * Entrega a sala ao filtro. É aqui que o Krisp confere a licença — antes
   * disso ele passa áudio, mas o modelo pode estar em espera. O SDK faz esta
   * chamada sozinho para trilhas que ele mesmo publica; a nossa é montada à
   * mão no grafo, então a chamada é nossa também.
   */
  async aoPublicar(sala) {
    if (!sala || !this.#processador?.onPublish) return;
    try {
      await this.#processador.onPublish(sala);
    } catch (erro) {
      console.warn("[supressao] a sala não liberou o filtro neural", erro);
    }
  }

  /** Solta o filtro. O `destroy` devolve o worklet e o WASM; sem ele, entrar e
   *  sair da voz algumas vezes deixa uma pilha de instâncias na memória. */
  async soltar() {
    const processador = this.#processador;
    this.#processador = null;
    processador?.processedTrack?.removeEventListener("disable-lk-krisp-noise-filter", this.#aoDesligar);
    processador?.processedTrack?.removeEventListener("enable-lk-krisp-noise-filter", this.#aoLigar);
    await processador?.destroy?.().catch?.(() => {});
  }
}
