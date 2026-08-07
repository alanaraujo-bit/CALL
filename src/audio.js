/**
 * Motor de áudio: um único grafo para captura, tratamento e reprodução.
 *
 * Antes, a captura ia crua do `getUserMedia` para a conexão e o áudio recebido
 * ia cru para um `<audio>` solto. Isso significa nenhuma escolha de dispositivo,
 * nenhum controle de volume por pessoa e nenhum tratamento além do que o
 * Chromium faz por conta própria — que é bom para chiado e cego para o resto.
 *
 * O grafo é deliberadamente raso. Cada nó a mais é trabalho por bloco de 128
 * amostras, 375 vezes por segundo:
 *
 *   microfone → passa-alta 85 Hz → porta de ruído → destino → WebRTC
 *   recebido  → ganho da pessoa → ganho geral → alto-falante
 *   avisos    → ganho dos avisos → alto-falante
 *
 * Os avisos — os sons de entrar e sair da voz, sintetizados em `sons.js` —
 * penduram-se no mesmo contexto, e não em um `<audio>` solto, por dois
 * motivos: assim eles saem pelo dispositivo escolhido em "Saída de som", que
 * vale para o contexto inteiro, e não pelo padrão do sistema; e o volume
 * deles é independente do volume geral, para que abaixar a voz de todo mundo
 * não apague os avisos e vice-versa.
 *
 * A passa-alta é nativa e custa quase nada, e tira o que nenhuma supressão de
 * ruído resolve bem: ronco de rede elétrica, trepidação de mesa e o estouro de
 * ar do microfone de mesa perto da boca.
 */

import { tocar as tocarSom } from "./sons.js";

/** Preferências de áudio e seus padrões. Tudo o que a interface pode mudar. */
export const AUDIO_PADRAO = {
  entrada: "", // deviceId do microfone; vazio = o do sistema
  saida: "", // deviceId do alto-falante; vazio = o do sistema
  ganhoEntrada: 1, // 0 a 4
  volumeGeral: 1, // 0 a 2
  /** Cancelamento de eco, supressão e ganho automático do próprio Chromium. */
  cancelarEco: true,
  suprimirRuido: true,
  ganhoAutomatico: true,
  /** Nossa porta de ruído, que age sobre o que sobra dos filtros acima. */
  porta: true,
  /** Limiar mínimo de abertura, em dB. O limiar real nunca fica abaixo do
   *  piso de ruído medido mais a margem — este valor é o chão dele. */
  limiar: -50,
  /** Bits por segundo do Opus. 64k é o que o Discord usa em canal comum. */
  bitrate: 64000,
  /** Envio contínuo. O `usedtx` economiza banda no silêncio às custas de um
   *  ruído de conforto sintético na entrada da fala. */
  bandaLarga: true,
  /** Sons de entrada e saída da voz. */
  sons: true,
  /** Volume deles, de 0 a 1. Fica abaixo de 1 por padrão porque estes sons
   *  interrompem uma conversa: eles avisam, não anunciam. */
  volumeSons: 0.7,
};

/** Escolhas oferecidas na interface, com o custo declarado. */
export const BITRATES_AUDIO = [
  { valor: 32000, nome: "Econômico", detalhe: "32 kbps — para redes ruins" },
  { valor: 64000, nome: "Padrão", detalhe: "64 kbps — o mesmo do Discord" },
  { valor: 96000, nome: "Alta", detalhe: "96 kbps — voz nitidamente mais aberta" },
  { valor: 128000, nome: "Máxima", detalhe: "128 kbps — praticamente transparente" },
];

/** Frequência de corte da passa-alta. Abaixo disto não existe voz humana:
 *  existe ronco de 50/60 Hz, mesa batendo e sopro. */
const CORTE_GRAVES = 85;

/** Dois avisos mais próximos do que isto viram um só. Quando três pessoas
 *  entram na voz ao mesmo tempo, três sinos sobrepostos não são três avisos:
 *  são um borrão alto. O primeiro toca, os outros são descartados — não
 *  enfileirados, porque um aviso atrasado já não avisa nada. */
const ESPACO_ENTRE_AVISOS = 0.09;

export class MotorDeAudio {
  #contexto = null;
  #worklet = null; // AudioWorkletNode da porta de ruído
  #fluxoBruto = null; // o que veio do getUserMedia
  #fonteEntrada = null;
  #passaAlta = null;
  #destino = null; // MediaStreamAudioDestinationNode
  #geral = null; // GainNode mestre da reprodução
  #avisos = null; // GainNode dos sons de entrar e sair
  // O relógio do contexto começa em zero, então o "nunca tocou" precisa ser
  // menor que qualquer instante possível — com zero aqui, um aviso disparado
  // nos primeiros 90 ms de vida do contexto seria descartado como repetido.
  #ultimoAviso = -Infinity; // instante do último aviso, no relógio do contexto
  #avisoAte = 0; // instante em que o último aviso se cala
  #saidas = new Map(); // id -> { fonte, ganho }
  #config = { ...AUDIO_PADRAO };
  #ouvinteDeNivel = null;
  #moduloCarregado = false;

  get config() {
    return { ...this.#config };
  }

  /** A trilha que deve ir para os pares: a tratada, não a do microfone. */
  get trilha() {
    return this.#destino?.stream.getAudioTracks()[0] ?? null;
  }

  get fluxo() {
    return this.#destino?.stream ?? null;
  }

  get ativo() {
    return Boolean(this.#destino);
  }

  /** Saída já tratada da própria voz. É daqui que a detecção de fala tira o
   *  sinal: o que interessa marcar é o que os outros ouvem, e não o que o
   *  microfone captou antes da porta de ruído. */
  get noLocal() {
    return this.#worklet;
  }

  /** O contexto é compartilhado com a detecção de fala; criá-lo sob demanda
   *  evita abrir um dispositivo de áudio para quem só lê mensagens. */
  async contexto() {
    if (!this.#contexto) {
      this.#contexto = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      this.#geral = this.#contexto.createGain();
      this.#geral.gain.value = this.#config.volumeGeral;
      this.#geral.connect(this.#contexto.destination);
      this.#avisos = this.#contexto.createGain();
      this.#avisos.gain.value = this.#config.volumeSons;
      this.#avisos.connect(this.#contexto.destination);
      await this.#aplicarSaida();
    }
    if (this.#contexto.state === "suspended") await this.#contexto.resume().catch(() => {});
    return this.#contexto;
  }

  /* ── Captura ───────────────────────────────────────────────────── */

  /**
   * Abre o microfone e monta a cadeia de tratamento. Chamar de novo com outro
   * dispositivo troca a fonte sem derrubar a trilha já entregue aos pares: o
   * destino continua o mesmo nó, então ninguém precisa renegociar.
   */
  async abrirMicrofone() {
    const contexto = await this.contexto();
    const fluxo = await this.#capturar();

    // Só troca depois de ter o novo em mãos: se o dispositivo escolhido sumiu,
    // é melhor continuar com o antigo do que ficar mudo.
    this.#fonteEntrada?.disconnect();
    this.#fluxoBruto?.getTracks().forEach((t) => t.stop());
    this.#fluxoBruto = fluxo;

    if (!this.#destino) {
      this.#destino = contexto.createMediaStreamDestination();
      this.#destino.channelCount = 1;
    }
    if (!this.#passaAlta) {
      this.#passaAlta = contexto.createBiquadFilter();
      this.#passaAlta.type = "highpass";
      this.#passaAlta.frequency.value = CORTE_GRAVES;
      this.#passaAlta.Q.value = 0.707;
    }
    await this.#montarPorta(contexto);

    this.#fonteEntrada = contexto.createMediaStreamSource(fluxo);
    this.#fonteEntrada.connect(this.#passaAlta);

    return this.#destino.stream;
  }

  async #capturar() {
    const c = this.#config;
    const pedido = {
      audio: {
        echoCancellation: c.cancelarEco,
        noiseSuppression: c.suprimirRuido,
        autoGainControl: c.ganhoAutomatico,
        // Voz é mono. Pedir dois canais dobra o trabalho do codificador e da
        // rede para transportar duas cópias do mesmo microfone.
        channelCount: 1,
        sampleRate: 48000,
        ...(c.entrada ? { deviceId: { exact: c.entrada } } : {}),
      },
      video: false,
    };

    try {
      return await navigator.mediaDevices.getUserMedia(pedido);
    } catch (erro) {
      // Um dispositivo que foi desconectado desde a última vez derruba tudo com
      // `exact`. Cair para o microfone padrão é melhor do que não ter voz.
      if (c.entrada && (erro?.name === "OverconstrainedError" || erro?.name === "NotFoundError")) {
        this.#config.entrada = "";
        delete pedido.audio.deviceId;
        return navigator.mediaDevices.getUserMedia(pedido);
      }
      throw erro;
    }
  }

  async #montarPorta(contexto) {
    if (this.#worklet) return;

    if (!this.#moduloCarregado) {
      await contexto.audioWorklet.addModule("./porta-de-ruido.js");
      this.#moduloCarregado = true;
    }

    this.#worklet = new AudioWorkletNode(contexto, "porta-de-ruido", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.#worklet.port.onmessage = ({ data }) => this.#ouvinteDeNivel?.(data);
    this.#worklet.parameters.get("ativa").value = this.#config.porta ? 1 : 0;
    this.#worklet.parameters.get("limiar").value = this.#config.limiar;
    this.#worklet.parameters.get("ganho").value = this.#config.ganhoEntrada;

    this.#passaAlta.connect(this.#worklet);
    this.#worklet.connect(this.#destino);
  }

  /* ── Reprodução ────────────────────────────────────────────────── */

  /**
   * Liga o áudio de um participante ao grafo. Devolve o nó de ganho, que a
   * interface usa como volume individual, e é dele que a detecção de fala tira
   * o sinal — assim ela mede o que se ouve, e não o que chegou.
   */
  async ligarSaida(id, fluxo) {
    if (fluxo.getAudioTracks().length === 0) return null;
    const contexto = await this.contexto();

    this.desligarSaida(id);

    const fonte = contexto.createMediaStreamSource(fluxo);
    const ganho = contexto.createGain();
    fonte.connect(ganho);
    ganho.connect(this.#geral);

    this.#saidas.set(id, { fonte, ganho });
    return ganho;
  }

  desligarSaida(id) {
    const saida = this.#saidas.get(id);
    if (!saida) return;
    saida.fonte.disconnect();
    saida.ganho.disconnect();
    this.#saidas.delete(id);
  }

  /** 0 a 2. Acima de 1 é reforço real, não só o teto do `<audio>`. */
  definirVolumeDe(id, volume) {
    const saida = this.#saidas.get(id);
    if (saida) saida.ganho.gain.value = volume;
  }

  /* ── Avisos ────────────────────────────────────────────────────── */

  /**
   * Toca um dos sons de `sons.js` — `entrei`, `entrou`, `sai` ou `saiu`.
   *
   * É deliberadamente síncrono. Quem sai da voz toca o som e, na linha
   * seguinte, desmonta a malha e fecha o contexto; se este método esperasse
   * qualquer coisa, o contexto fecharia antes de o som chegar a ser agendado,
   * e a própria saída seria a única sem aviso.
   *
   * Devolve `false` quando não tocou — desligado, cedo demais, ou sem
   * contexto de áudio ainda aberto.
   */
  tocarAviso(nome) {
    if (!this.#config.sons || !this.#contexto || !this.#avisos) return false;

    const agora = this.#contexto.currentTime;
    if (agora - this.#ultimoAviso < ESPACO_ENTRE_AVISOS) return false;
    this.#ultimoAviso = agora;

    // Uma aba em segundo plano suspende o contexto; o `resume` é assíncrono,
    // mas o agendamento abaixo já é feito no relógio parado e toca ao voltar.
    if (this.#contexto.state === "suspended") this.#contexto.resume().catch(() => {});

    this.#avisoAte = Math.max(this.#avisoAte, tocarSom(this.#contexto, this.#avisos, nome));
    return true;
  }

  /** Igual ao anterior, mas abre o contexto se ainda não houver um. É o
   *  caminho do painel de ajustes, onde se ouve o som sem estar na voz. */
  async ouvirAviso(nome) {
    if (!this.#config.sons) return;
    await this.contexto();
    // Ouvir de propósito não é o mesmo que ser avisado: dois cliques seguidos
    // no painel devem tocar duas vezes.
    this.#ultimoAviso = -Infinity;
    this.tocarAviso(nome);
  }

  /* ── Ajustes ───────────────────────────────────────────────────── */

  /**
   * Aplica preferências. Devolve `true` quando o microfone precisou ser
   * reaberto — o que só acontece se algo que o `getUserMedia` decide mudou.
   */
  async aplicar(mudancas) {
    const antes = this.#config;
    const depois = { ...antes, ...mudancas };
    this.#config = depois;

    if (this.#geral) this.#geral.gain.value = depois.volumeGeral;
    if (this.#avisos) this.#avisos.gain.value = depois.volumeSons;
    if (this.#worklet) {
      this.#worklet.parameters.get("ativa").value = depois.porta ? 1 : 0;
      this.#worklet.parameters.get("limiar").value = depois.limiar;
      this.#worklet.parameters.get("ganho").value = depois.ganhoEntrada;
    }
    if (depois.saida !== antes.saida) await this.#aplicarSaida();

    const recapturar =
      this.ativo &&
      (depois.entrada !== antes.entrada ||
        depois.cancelarEco !== antes.cancelarEco ||
        depois.suprimirRuido !== antes.suprimirRuido ||
        depois.ganhoAutomatico !== antes.ganhoAutomatico);

    if (recapturar) await this.abrirMicrofone();
    return recapturar;
  }

  async #aplicarSaida() {
    // `setSinkId` no contexto encaminha o grafo inteiro de uma vez. Nem toda
    // versão do WebView2 o expõe; sem ele, resta a saída padrão do sistema.
    if (!this.#contexto?.setSinkId) return;
    try {
      await this.#contexto.setSinkId(this.#config.saida || "");
    } catch (erro) {
      console.warn("[audio] saída não aceita", erro);
    }
  }

  /** Liga o medidor da porta. Sem ouvinte, o worklet nem calcula o envio. */
  medir(ouvinte) {
    this.#ouvinteDeNivel = ouvinte;
    this.#worklet?.port.postMessage({ reportando: Boolean(ouvinte) });
  }

  /* ── Encerramento ──────────────────────────────────────────────── */

  /** Fecha o microfone, mas mantém o contexto e a cadeia: trocar de canal de
   *  voz não é motivo para reabrir o dispositivo. */
  soltarMicrofone() {
    this.#fonteEntrada?.disconnect();
    this.#fonteEntrada = null;
    this.#fluxoBruto?.getTracks().forEach((t) => t.stop());
    this.#fluxoBruto = null;
  }

  async encerrar() {
    this.soltarMicrofone();
    for (const id of [...this.#saidas.keys()]) this.desligarSaida(id);
    this.medir(null);

    // Sair da voz toca um aviso e desmonta tudo em seguida. Fechar o contexto
    // agora cortaria esse som no meio da primeira nota — daí a espera pela
    // cauda do que ainda está soando. O teto de um segundo é só para que um
    // relógio esquisito nunca prenda o encerramento.
    const cauda = this.#avisoAte - (this.#contexto?.currentTime ?? 0);
    if (cauda > 0) await new Promise((pronto) => setTimeout(pronto, Math.min(cauda, 1) * 1000));
    this.#avisoAte = 0;
    this.#avisos?.disconnect();
    this.#avisos = null;

    this.#worklet?.disconnect();
    this.#passaAlta?.disconnect();
    this.#destino?.disconnect();
    this.#worklet = null;
    this.#passaAlta = null;
    this.#destino = null;
    this.#geral = null;
    this.#moduloCarregado = false;

    await this.#contexto?.close().catch(() => {});
    this.#contexto = null;
  }
}

/* ── Dispositivos ────────────────────────────────────────────────── */

/**
 * Lista microfones e alto-falantes. Antes da primeira permissão concedida os
 * rótulos vêm vazios — é assim que o navegador impede que uma página não
 * autorizada identifique a máquina pelo hardware.
 */
export async function listarDispositivos() {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    const arrumar = (lista) =>
      lista.map((d, i) => ({
        id: d.deviceId,
        nome: d.label || `Dispositivo ${i + 1}`,
      }));
    return {
      entradas: arrumar(todos.filter((d) => d.kind === "audioinput")),
      saidas: arrumar(todos.filter((d) => d.kind === "audiooutput")),
    };
  } catch {
    return { entradas: [], saidas: [] };
  }
}
