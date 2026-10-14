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
 * Essa distância só se fecha com um motor que separe voz de não-voz quadro a
 * quadro, inclusive por cima da fala. É o que o Discord faz com o Krisp. O
 * CALL faz com o **GTCRN** — um modelo neural (2024, licença MIT) que roda
 * inteiramente offline, num AudioWorklet, com o modelo embutido em ~197 KB de
 * WASM. Ele **não depende de servidor de mídia nenhum**: funciona igual no
 * LiveKit auto-hospedado, na malha P2P e sem SFU algum. Foi essa a troca que
 * tirou o CALL da dependência do LiveKit Cloud — antes o filtro bom (Krisp) só
 * valia dentro de uma sala do LiveKit Cloud, que é justamente o que não dá para
 * pagar.
 *
 * Há três motores, em ordem de preferência:
 *
 *   1. `neural`  — GTCRN. O modelo vem embutido; não há busca em CDN e a CSP
 *                  não precisa ser afrouxada.
 *   2. `sistema` — `voiceIsolation`, o isolamento de voz do próprio sistema
 *                  operacional (Windows Studio Effects, macOS). Custa zero de
 *                  CPU porque é o SO/NPU que faz, mas só existe em máquina que
 *                  tenha o recurso.
 *   3. `nativa`  — o supressor do Chromium mais a porta de ruído. É o chão,
 *                  quando nada acima está disponível.
 *
 * **Eles nunca se acumulam.** Dois supressores em série produzem "ruído
 * musical" — aquele borbulhar metálico em volta das palavras — e o resultado
 * fica pior do que com um só. Quem escolhe é este módulo, e a escolha decide
 * tanto as constraints da captura quanto se a porta de ruído fica de pé.
 *
 * ## GTCRN é um nó de grafo, não um processador de trilha
 *
 * O Krisp recebia uma `MediaStreamTrack` e devolvia outra, já tratada. O GTCRN
 * é um `AudioWorkletNode`: ele entra **dentro** do grafo de áudio, entre a
 * fonte do microfone e a passa-alta. Por isso `tratar()` devolve a trilha crua
 * (que vai para o grafo como fonte) e expõe o nó em `no` — é o motor de áudio
 * que o costura no lugar certo, no **mesmo `AudioContext`** do resto. Nunca um
 * segundo contexto: abrir outro caminho de renderização é causa conhecida de o
 * cancelamento de eco do Chromium perder o alinhamento.
 *
 * O motor escolhido é observável (`assinar`) porque a interface precisa dizer
 * qual está valendo: "o ruído continua passando" tem causas diferentes se a
 * resposta for `neural` ou `nativa`, e quem usa não tem como adivinhar.
 */

const carregarGtcrnPadrao = async () => {
  // A thread principal só precisa do binário do modelo e da URL do worklet. As
  // duas são locais (`src/`), então `connect-src 'self'` e `script-src 'self'`
  // já bastam — o worklet em si é adicionado ao `AudioContext` pelo `tratar`.
  const wasm = await fetch(new URL("./gtcrn.wasm", import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`gtcrn.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  const urlWorklet = new URL("./gtcrn-worklet.js", import.meta.url).href;
  return { wasm, urlWorklet };
};

/** O id com que o worklet se registra, fixado pelo pacote. */
const WORKLET_GTCRN = "@sapphi-red/web-noise-suppressor/gtcrn";

/**
 * Estados possíveis. `indisponivel` não é um motor: é a memória de que o GTCRN
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
  #carregarGtcrn;
  #recursos = null; // { wasm, urlWorklet } do GTCRN, carregados uma vez
  #no = null; // AudioWorkletNode do GTCRN
  #contextoDoNo = null; // o AudioContext a que o nó e o módulo pertencem
  #motor = "nativa";
  #neuralRecusado = false; // já tentou e não deu; não insistir nesta sessão
  #detalhe = "";
  #causa = ""; // o erro cru, para diagnóstico — nunca vai para a interface
  #ouvintes = new Set();
  #aoDegradar = null;

  /**
   * `aoDegradar` existia para o Krisp, que podia cair **depois** de já estar
   * valendo (licença negada ao publicar) e exigia recaptura com o supressor
   * nativo. O GTCRN não tem esse modo de falha assíncrono: ou o nó monta no
   * grafo, ou a falha é vista ainda dentro da captura e a "revista" recaptura
   * sozinha. O parâmetro segue aceito para não quebrar quem instancia, mas hoje
   * não é chamado.
   */
  constructor({ carregarGtcrn = carregarGtcrnPadrao, aoDegradar = null } = {}) {
    this.#carregarGtcrn = carregarGtcrn;
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
   *  "não carregou" e "carregou e falhou ao montar" pedem correções
   *  diferentes, e a frase da interface apaga essa diferença de propósito. */
  get causa() {
    return this.#causa;
  }

  /**
   * O nó do GTCRN a ser costurado no grafo, ou `null` quando o motor não é o
   * neural. Lido pelo motor de áudio depois de `tratar`, para inserir o nó
   * entre a fonte do microfone e a passa-alta.
   */
  get no() {
    return this.#no;
  }

  /**
   * Se a porta de ruído ainda tem trabalho a fazer.
   *
   * Ela sai de cena **só** sob o motor neural. Com uma rede neural na frente, o
   * piso de ruído que a porta mede desaba para perto do silêncio digital — e
   * `piso + margem`, que é como ela decide abrir, passa a cortar sílaba. Manter
   * a porta ali troca "ouço o teclado dele" por "ele come o começo das
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
   *   sem sinal de que isso aconteceu. Do GTCRN, ao contrário, temos certeza:
   *   ou o nó montou e está tratando, ou caímos para outro motor.
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
   * que vão ao `getUserMedia`. Carregar o modelo do GTCRN é o que demora (o
   * binário tem ~197 KB), então acontece aqui e uma vez só.
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

    if (!this.#neuralRecusado && (await this.#garantirRecursos())) {
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

  /** Baixa o modelo e a URL do worklet, uma vez por sessão. Não monta nada no
   *  grafo ainda — isso é `tratar`, que precisa do `AudioContext`. */
  async #garantirRecursos() {
    if (this.#recursos) return true;
    try {
      this.#recursos = await this.#carregarGtcrn();
      return true;
    } catch (erro) {
      console.warn("[supressao] o modelo neural não carregou", erro);
      this.#neuralRecusado = true;
      this.#causa = String(erro?.message ?? erro);
      this.#detalhe = "A redução neural não pôde ser carregada.";
      return false;
    }
  }

  /**
   * Monta (ou reaproveita) o nó do GTCRN no `AudioContext` dado e devolve a
   * trilha que deve alimentar o grafo — que é a **crua**: o GTCRN trata dentro
   * do grafo, como um nó, e não trocando a trilha. O nó fica em `this.no`, para
   * o motor de áudio costurar.
   *
   * Nos outros motores não há nó: devolve a trilha recebida e `this.no` é
   * `null`. `sistema` e `nativa` acontecem dentro da própria captura.
   *
   * Recebe o `AudioContext` do motor de áudio de propósito: um contexto só para
   * o filtro seria um segundo dispositivo de renderização aberto, e abrir um
   * segundo caminho de áudio é causa conhecida de o AEC do Chromium perder o
   * alinhamento com o sinal de referência.
   */
  async tratar(trilha, contexto) {
    if (this.#motor !== "neural") return trilha;

    // O módulo do worklet é por `AudioContext`. Entrar e sair da voz fecha o
    // contexto e abre outro, então um nó de um contexto morto não serve: se o
    // contexto mudou, descarta o nó velho e monta no novo.
    if (this.#no && this.#contextoDoNo !== contexto) {
      try {
        this.#no.destroy?.();
      } catch {
        /* contexto já foi embora */
      }
      this.#no = null;
      this.#contextoDoNo = null;
    }
    if (this.#no) return trilha;

    try {
      await contexto.audioWorklet.addModule(this.#recursos.urlWorklet);
      // `wasmBinary` embutido + `maxChannels: 1` (voz é mono). O construtor do
      // pacote é só um `AudioWorkletNode` com estes `processorOptions`.
      this.#no = new AudioWorkletNode(contexto, WORKLET_GTCRN, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { maxChannels: 1, wasmBinary: this.#recursos.wasm },
      });
      this.#contextoDoNo = contexto;
      return trilha;
    } catch (erro) {
      console.warn("[supressao] o filtro neural não montou no grafo", erro);
      this.#neuralRecusado = true;
      this.#no = null;
      this.#contextoDoNo = null;
      this.#causa = String(erro?.message ?? erro);
      this.#anunciar("nativa", "A redução neural falhou ao iniciar.");
      // Não é preciso chamar `aoDegradar` aqui: `#neuralRecusado` já está de pé,
      // então a "revista" de `#capturarComSupressao` vê que as constraints
      // mudaram (o nativo volta a ser pedido) e recaptura no mesmo
      // `abrirMicrofone` — sem reentrância e sem deixar a captura sem supressão.
      return trilha;
    }
  }

  /**
   * Compatibilidade com o fluxo de entrada no LiveKit. O Krisp conferia a
   * licença aqui, na sala. O GTCRN não licencia nada — roda offline —, então
   * não há o que fazer ao publicar. Mantido como no-op para `livekit.js` seguir
   * chamando sem um caminho condicional.
   */
  async aoPublicar() {
    /* GTCRN não depende de sala nem de licença. */
  }

  /** Solta o filtro. O `destroy` devolve o worklet e o WASM; sem ele, entrar e
   *  sair da voz algumas vezes deixa uma pilha de instâncias na memória. */
  async soltar() {
    const no = this.#no;
    this.#no = null;
    this.#contextoDoNo = null;
    try {
      no?.disconnect();
    } catch {
      /* já desconectado */
    }
    try {
      no?.destroy?.();
    } catch {
      /* contexto já fechou */
    }
  }
}
