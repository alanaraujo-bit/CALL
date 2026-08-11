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
 *   microfone  → filtros nativos → passa-alta → porta → limitador → WebRTC
 *   recebido   → ganho da pessoa → folga → ganho geral → limitador → alto-falante
 *   avisos     → ganho dos avisos → alto-falante
 *   soundboard → ganho do soundboard → destino (WebRTC) e alto-falante
 *
 * Os avisos — os sons de entrar e sair da voz, sintetizados em `sons.js` —
 * penduram-se no mesmo contexto, e não em um `<audio>` solto, por dois
 * motivos: assim eles saem pelo dispositivo escolhido em "Saída de som", que
 * vale para o contexto inteiro, e não pelo padrão do sistema; e o volume
 * deles é independente do volume geral, para que abaixar a voz de todo mundo
 * não apague os avisos e vice-versa.
 *
 * O soundboard é diferente dos dois: ele é o único ramo que também alimenta
 * `destino` — o mesmo nó que vira a trilha WebRTC. Um clipe tocado precisa
 * chegar aos outros participantes pela chamada de verdade, e não só ser
 * ouvido por quem clicou; por isso ele tem sua própria saída para o destino,
 * em paralelo à do microfone, nunca passando pela porta de ruído (que existe
 * só para voz — um efeito sonoro não deve ser tratado como se fosse fala).
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
  ganhoEntrada: 1, // 0 a GANHO_ENTRADA_MAX
  volumeGeral: 1, // 0 a 2
  /** Eco, ruído e ganho usam o APM nativo do Chromium/WebView2. */
  cancelarEco: true,
  suprimirRuido: true,
  ganhoAutomatico: true,
  /** Nossa porta de ruído, que age sobre o que sobra dos filtros acima. */
  porta: true,
  /** Limiar mínimo de abertura, em dB. O limiar real nunca fica abaixo do
   *  piso de ruído medido mais a margem — este valor é o chão dele. */
  limiar: -50,
  /** 96 kbps deixa o Opus mono full-band respirar e ainda é leve na rede. */
  bitrate: 96000,
  /** Envio contínuo. O `usedtx` economiza banda no silêncio às custas de um
   *  ruído de conforto sintético na entrada da fala. */
  bandaLarga: true,
  /** Sons de entrada e saída da voz. */
  sons: true,
  /** Volume deles, de 0 a 1. Fica abaixo de 1 por padrão porque estes sons
   *  interrompem uma conversa: eles avisam, não anunciam. */
  volumeSons: 0.7,
  /** Volume dos clipes do soundboard — o que sai para os outros e o que quem
   *  tocou ouve de volta. Cheio por padrão: um efeito tocado de propósito não
   *  deveria precisar de ajuste antes de ser ouvido. */
  volumeSoundboard: 1,
};

/**
 * Teto do "Volume do microfone", antes 2 (200%).
 *
 * O ganho é aplicado dentro do worklet, depois do AGC do Chromium — que já
 * normalizou a voz para perto do fundo de escala. Dobrar aquilo não deixava a
 * voz mais alta: enfiava +6 dBFS no limitador de envio, que antes ceifava e
 * agora comprimiria sem parar. Nos dois casos quem ouve leva a pior, e quem
 * mexeu no controle não tem como saber.
 *
 * 1,5 (+3,5 dB) é o que ainda resolve um microfone fraco sem lutar contra o
 * AGC. Valores gravados de versões antigas são presos a este teto ao carregar.
 */
export const GANHO_ENTRADA_MAX = 1.5;

/** Clipe mais longo do que isto é recusado antes de tocar. Soundboard é
 *  efeito curto, não trilha sonora — e o teto evita que um clipe comprido
 *  fique pendurado no grafo de saída por muito tempo. */
export const DURACAO_CLIPE_MAX = 5;

/** Escolhas oferecidas na interface, com o custo declarado. */
export const BITRATES_AUDIO = [
  { valor: 32000, nome: "Econômico", detalhe: "32 kbps — para redes ruins" },
  { valor: 64000, nome: "Equilibrado", detalhe: "64 kbps — voz clara com pouca banda" },
  { valor: 96000, nome: "Recomendado", detalhe: "96 kbps — voz cheia e natural" },
  { valor: 128000, nome: "Máxima", detalhe: "128 kbps — praticamente transparente" },
];

/** Frequência de corte da passa-alta. Abaixo disto não existe voz humana:
 *  existe ronco de 50/60 Hz, mesa batendo e sopro. */
const CORTE_GRAVES = 85;

/**
 * Limiar do limitador, em dBFS. É uma rede de segurança, não um estágio de
 * compressão — quem mantém a soma fora daqui é a folga de `HEADROOM_VOZES`.
 *
 * -3 saiu de medição, não de gosto: com uma voz forte típica (pico em
 * -3 dBFS, que é o que o AGC do Chromium entrega) o limitador não mexe em
 * nada — 0,00 dB de alteração — e mesmo com entrada 3,0 o pico de saída fica
 * em 0,87. Um limiar mais baixo já começava a comprimir voz normal (-1,7 dB
 * em -6, -4,4 dB em -9).
 */
const TETO_LIMITADOR = -3;

/**
 * Anula o ganho de compensação que o Chromium aplica por dentro do
 * `DynamicsCompressorNode`.
 *
 * O nó não é transparente abaixo do limiar: o Blink embute um *makeup gain*
 * calculado a partir de limiar/joelho/razão. Com os valores acima ele mede
 * +1,20 dB — o bastante para o limitador *aumentar* o sinal em vez de só
 * proteger, e para o teto de saída passar de 1,0 justamente quando ele
 * deveria estar segurando.
 *
 * 10^(-1,20/20). O valor é medido, então está preso a estes parâmetros e a
 * este motor. O teste do limitador verifica as duas pontas — transparência
 * abaixo do limiar e teto acima — e falha alto se um Chromium futuro mudar a
 * fórmula.
 */
const COMPENSACAO_MAKEUP = 0.871;

/**
 * Folga aplicada à soma das vozes, em ganho linear (-3 dB).
 *
 * O AGC do Chromium entrega cada voz com pico perto de -3 dBFS. Somar duas
 * assim já passa de 0 dBFS, e três passam com folga — por isso o barramento
 * precisa de espaço antes do limitador. Sem esta folga o limitador atuaria em
 * quase toda conversa cruzada, e atuação constante é bombeamento audível: o
 * mix "respira" a cada sílaba. Com ela, uma pessoa falando nunca chega perto
 * do teto e o limitador só aparece quando três ou mais falam junto — que é
 * exatamente para isso que ele existe.
 *
 * O custo é 3 dB a menos numa voz sozinha. É um custo real e escolhido: o
 * caminho antigo era mais alto porque estava ceifando o topo da onda.
 */
const HEADROOM_VOZES = 0.707;

/**
 * Limitador de verdade, com lookahead — não um ceifador.
 *
 * A versão anterior era um `WaveShaperNode` com uma curva de joelho suave. A
 * curva estava certa; o nó, não. O `WaveShaperNode` **clampa a entrada em
 * [-1, 1] antes de consultar a curva**, então tudo acima de 1 caía no último
 * ponto da tabela: 1,1 / 1,4 / 3,0 saíam todos como 0,9264. Isso é topo
 * cortado quadrado — distorção harmônica, e não compressão. Numa call com
 * três pessoas falando junto a soma passa de 1,0 rotineiramente, ou seja, o
 * mix distorcia justo no momento em que mais importa entender quem falou.
 *
 * O `DynamicsCompressorNode` tem lookahead, então ele reduz o ganho *antes* do
 * pico chegar, em vez de achatá-lo depois. Razão 20:1 é limitador; o joelho de
 * 3 dB evita que a entrada em ação seja um degrau audível.
 *
 * Devolve os dois extremos da cadeia porque ela tem dois nós — o compressor e
 * a compensação. Ligue em `entrada` e siga a partir de `saida`.
 */
export function criarLimitador(contexto, { teto = TETO_LIMITADOR } = {}) {
  const compressor = contexto.createDynamicsCompressor();
  compressor.threshold.value = teto;
  compressor.knee.value = 3;
  compressor.ratio.value = 20;
  // Ataque curto o bastante para segurar uma sílaba explosiva; soltura longa a
  // ponto de a recuperação não ser ouvida como um pulso de volume.
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;

  const compensacao = contexto.createGain();
  compensacao.gain.value = COMPENSACAO_MAKEUP;
  compressor.connect(compensacao);

  return { entrada: compressor, saida: compensacao };
}

/** Constraints efetivamente pedidas ao dispositivo. Exportada para que os
 * testes garantam que os filtros escolhidos chegam à captura real. */
export function restricoesDoMicrofone(config) {
  return {
    echoCancellation: config.cancelarEco,
    noiseSuppression: config.suprimirRuido,
    autoGainControl: config.ganhoAutomatico,
    channelCount: 1,
    sampleRate: 48000,
    // Sem pedido de latência. `latency: { ideal: 0.01 }` pedia buffer de 10 ms
    // ao WASAPI; no WebView2, com um jogo aberto na mesma máquina, isso é
    // underrun — crepitação. E o ganho é irrelevante numa call pela internet,
    // onde a rede sozinha já custa de 30 a 80 ms. Deixar o sistema escolher.
    ...(config.entrada ? { deviceId: { exact: config.entrada } } : {}),
  };
}

/** Dois avisos mais próximos do que isto viram um só. Quando três pessoas
 *  entram na voz ao mesmo tempo, três sinos sobrepostos não são três avisos:
 *  são um borrão alto. O primeiro toca, os outros são descartados — não
 *  enfileirados, porque um aviso atrasado já não avisa nada. */
const ESPACO_ENTRE_AVISOS = 0.09;

/** Contra quem fica entrando e saindo da voz só para martelar o sino nos
 *  ouvidos de todo mundo. Mais de `LIMITE_AVISOS` avisos em `JANELA_AVISOS`
 *  segundos e o som para — não a entrada nem a saída em si, só o aviso —
 *  pelos `SILENCIO_APOS_ABUSO` seguintes. Contado em relógio de parede, e não
 *  no do `AudioContext`: o contexto fecha e reabre a cada ciclo de voz, e um
 *  relógio que zera a cada reabertura nunca perceberia repetição nenhuma. */
const JANELA_AVISOS = 6000;
const LIMITE_AVISOS = 4;
const SILENCIO_APOS_ABUSO = 8000;

export class MotorDeAudio {
  #contexto = null;
  #worklet = null; // AudioWorkletNode da porta de ruído
  #fluxoBruto = null; // o que veio do getUserMedia
  #fonteEntrada = null;
  #passaAlta = null;
  #destino = null; // MediaStreamAudioDestinationNode
  #misturaEnvio = null; // voz + soundboard antes do limitador
  #limitadorEnvio = null;
  #vozes = null; // soma do que vem dos outros (voz e som de tela), com folga
  #geral = null; // GainNode mestre da reprodução
  #limitadorSaida = null; // protege a soma de várias pessoas falando
  #avisos = null; // GainNode dos sons de entrar e sair
  #soundboard = null; // GainNode dos clipes tocados manualmente
  #retornoLocal = null; // retorno tratado do microfone, só para o teste
  #monitorandoEntrada = false;
  #soundboardLigadoAoDestino = false;
  #cacheClipes = new Map(); // id do som -> AudioBuffer já decodificado
  // O relógio do contexto começa em zero, então o "nunca tocou" precisa ser
  // menor que qualquer instante possível — com zero aqui, um aviso disparado
  // nos primeiros 90 ms de vida do contexto seria descartado como repetido.
  #ultimoAviso = -Infinity; // instante do último aviso, no relógio do contexto
  #avisoAte = 0; // instante em que o último aviso se cala
  #avisosNaJanela = 0; // contagem da janela anti-abuso, em relógio de parede
  #inicioJanelaMs = -Infinity;
  #mudoAteMs = 0; // Date.now() até quando o aviso fica suprimido
  #saidas = new Map(); // id -> { fonte, ganho }
  #config = { ...AUDIO_PADRAO };
  #ouvintesDeNivel = new Set();
  #ouvinteDoMedidor = null;
  #moduloCarregado = false;
  #encerrando = null; // promessa do `encerrar()` em andamento, se houver

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
    // Entrar de novo enquanto a saída anterior ainda está fechando o contexto
    // (a cauda do "sai" pode levar até 1s) não pode seguir em paralelo: sem
    // esperar aqui, `encerrar` reaproveitaria e depois fecharia por baixo o
    // contexto novo que esta chamada acabou de criar — daí o "às vezes some".
    if (this.#encerrando) await this.#encerrando;

    if (!this.#contexto) {
      this.#contexto = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      // O relógio de um contexto novo começa do zero. `#ultimoAviso` e
      // `#avisoAte` guardavam instantes do contexto anterior — sem zerar
      // aqui, `agora - #ultimoAviso` dava negativo e todo aviso era
      // descartado como "repetido" até o relógio novo alcançar o valor
      // antigo por conta própria.
      this.#ultimoAviso = -Infinity;
      this.#avisoAte = 0;
      this.#limitadorSaida = criarLimitador(this.#contexto);
      this.#limitadorSaida.saida.connect(this.#contexto.destination);
      this.#geral = this.#contexto.createGain();
      this.#geral.gain.value = this.#config.volumeGeral;
      this.#geral.connect(this.#limitadorSaida.entrada);
      // Tudo o que vem dos outros soma aqui, com folga, antes do volume geral
      // — voz e som de transmissão, que é justamente a fonte mais alta e mais
      // contínua de todas. Avisos e soundboard não passam por este nó: são
      // fonte única, em nível conhecido, e não é a soma deles que estoura o
      // barramento.
      this.#vozes = this.#contexto.createGain();
      this.#vozes.gain.value = HEADROOM_VOZES;
      this.#vozes.connect(this.#geral);
      this.#avisos = this.#contexto.createGain();
      this.#avisos.gain.value = this.#config.volumeSons;
      this.#avisos.connect(this.#limitadorSaida.entrada);
      this.#soundboard = this.#contexto.createGain();
      this.#soundboard.gain.value = this.#config.volumeSoundboard;
      this.#soundboard.connect(this.#limitadorSaida.entrada);
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
      this.#misturaEnvio = contexto.createGain();
      this.#limitadorEnvio = criarLimitador(contexto);
      this.#misturaEnvio.connect(this.#limitadorEnvio.entrada);
      this.#limitadorEnvio.saida.connect(this.#destino);
    }
    // Liga o soundboard ao destino uma única vez: `connect` chamado duas
    // vezes entre o mesmo par de nós somaria o sinal em dobro, não é
    // idempotente.
    if (!this.#soundboardLigadoAoDestino && this.#soundboard) {
      this.#soundboard.connect(this.#misturaEnvio);
      this.#soundboardLigadoAoDestino = true;
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

    const trilhaBruta = fluxo.getAudioTracks()[0];
    if (trilhaBruta) trilhaBruta.contentHint = "speech";
    const trilhaTratada = this.#destino.stream.getAudioTracks()[0];
    if (trilhaTratada) trilhaTratada.contentHint = "speech";

    return this.#destino.stream;
  }

  async #capturar() {
    const c = this.#config;
    const pedido = {
      // Voz é mono: dois canais dobrariam codificação e rede para transportar
      // duas cópias do mesmo microfone.
      audio: restricoesDoMicrofone(c),
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
    if (this.#worklet) {
      this.#conectarTratamento();
      return;
    }

    if (!this.#moduloCarregado) {
      await contexto.audioWorklet.addModule(new URL("./porta-de-ruido.js", import.meta.url).href);
      this.#moduloCarregado = true;
    }

    this.#worklet = new AudioWorkletNode(contexto, "porta-de-ruido", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.#worklet.port.onmessage = ({ data }) => {
      for (const ouvinte of [...this.#ouvintesDeNivel]) {
        try {
          ouvinte(data);
        } catch (erro) {
          console.error("[audio] ouvinte do nível falhou", erro);
        }
      }
    };
    this.#worklet.parameters.get("ativa").value = this.#config.porta ? 1 : 0;
    this.#worklet.parameters.get("limiar").value = this.#config.limiar;
    this.#worklet.parameters.get("ganho").value = this.#config.ganhoEntrada;
    // Uma assinatura pode ser criada antes da primeira captura. Nesse caso o
    // nó ainda não existia quando ela pediu relatórios; reaplicar o estado ao
    // criar o worklet evita um medidor permanentemente parado.
    this.#atualizarRelatorioDeNivel();

    this.#worklet.connect(this.#misturaEnvio);
    // O retorno usa exatamente o áudio que seria enviado a outra pessoa — já
    // com porta, filtros e ganho — mas fica fechado até alguém pedir o teste.
    this.#retornoLocal = contexto.createGain();
    this.#retornoLocal.gain.value = this.#monitorandoEntrada ? 1 : 0;
    this.#worklet.connect(this.#retornoLocal);
    this.#retornoLocal.connect(this.#geral);
    this.#conectarTratamento();
  }

  /** Reconecta o ramo sem trocar a trilha WebRTC nem renegociar a chamada. */
  #conectarTratamento() {
    this.#passaAlta?.disconnect();
    this.#passaAlta?.connect(this.#worklet);
  }

  /** Reproduz localmente a voz já tratada. É deliberadamente temporário: a
   * interface o desliga ao fechar os ajustes para não surpreender ninguém com
   * retorno de microfone numa chamada — sobretudo sem fones. */
  monitorarEntrada(ativo) {
    this.#monitorandoEntrada = Boolean(ativo);
    if (!this.#retornoLocal || !this.#contexto) return;
    const agora = this.#contexto.currentTime;
    this.#retornoLocal.gain.cancelScheduledValues(agora);
    this.#retornoLocal.gain.setTargetAtTime(this.#monitorandoEntrada ? 1 : 0, agora, 0.018);
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
    ganho.connect(this.#vozes);

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

    const agoraMs = Date.now();
    if (agoraMs < this.#mudoAteMs) return false;

    if (agoraMs - this.#inicioJanelaMs > JANELA_AVISOS) {
      this.#inicioJanelaMs = agoraMs;
      this.#avisosNaJanela = 0;
    }
    this.#avisosNaJanela++;
    if (this.#avisosNaJanela > LIMITE_AVISOS) {
      this.#mudoAteMs = agoraMs + SILENCIO_APOS_ABUSO;
      return false;
    }

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

  /* ── Soundboard ────────────────────────────────────────────────── */

  /**
   * Decodifica e toca um clipe do soundboard. `bytes` é um `Uint8Array` (o
   * som chega em base64 pelo protocolo e é decodificado antes de chegar
   * aqui). Quando `idCache` é dado, o `AudioBuffer` decodificado fica
   * guardado — tocar o mesmo som de novo na mesma sessão não decodifica de
   * novo.
   *
   * Exige o motor ativo (`this.ativo`, ou seja, dentro de um canal de voz):
   * é o `#destino` que carrega o clipe até os outros participantes, e ele só
   * existe depois de `abrirMicrofone`.
   *
   * Devolve `false` sem tocar quando o motor não está ativo ou o clipe passa
   * do teto de duração — nunca lança, porque um clipe malformado não deveria
   * derrubar quem tentou tocá-lo.
   */
  async tocarClipe(bytes, idCache) {
    if (!this.ativo) return false;
    const contexto = await this.contexto();

    let buffer = idCache ? this.#cacheClipes.get(idCache) : null;
    if (!buffer) {
      const copia = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      try {
        buffer = await contexto.decodeAudioData(copia);
      } catch {
        return false;
      }
      if (idCache) this.#cacheClipes.set(idCache, buffer);
    }
    if (buffer.duration > DURACAO_CLIPE_MAX) return false;

    const fonte = contexto.createBufferSource();
    fonte.buffer = buffer;
    fonte.connect(this.#soundboard);
    fonte.start();
    return true;
  }

  /* ── Ajustes ───────────────────────────────────────────────────── */

  /**
   * Aplica preferências. Devolve `true` quando o microfone precisou ser
   * reaberto — o que só acontece se algo que o `getUserMedia` decide mudou.
   */
  async aplicar(mudancas) {
    const antes = this.#config;
    const depois = { ...antes, ...mudancas };
    // Preso aqui, e não só no controle da interface: uma preferência gravada
    // por uma versão antiga chega a 2 e não passa por nenhum controle.
    depois.ganhoEntrada = Math.min(Math.max(depois.ganhoEntrada, 0), GANHO_ENTRADA_MAX);
    this.#config = depois;

    if (this.#geral) this.#geral.gain.value = depois.volumeGeral;
    if (this.#avisos) this.#avisos.gain.value = depois.volumeSons;
    if (this.#soundboard) this.#soundboard.gain.value = depois.volumeSoundboard;
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

  #atualizarRelatorioDeNivel() {
    this.#worklet?.port.postMessage({ reportando: this.#ouvintesDeNivel.size > 0 });
  }

  /**
   * Assina o detector que roda dentro da própria porta de ruído. Mais de uma
   * parte da interface pode acompanhar a mesma leitura sem uma desligar a
   * outra (por exemplo, o avatar da call e o painel de ajustes).
   */
  assinarNivel(ouvinte) {
    if (typeof ouvinte !== "function") return () => {};
    this.#ouvintesDeNivel.add(ouvinte);
    this.#atualizarRelatorioDeNivel();

    let ativa = true;
    return () => {
      if (!ativa) return;
      ativa = false;
      this.#ouvintesDeNivel.delete(ouvinte);
      this.#atualizarRelatorioDeNivel();
    };
  }

  /** Liga o medidor visual dos ajustes sem interferir em outras assinaturas. */
  medir(ouvinte) {
    if (this.#ouvinteDoMedidor) this.#ouvintesDeNivel.delete(this.#ouvinteDoMedidor);
    this.#ouvinteDoMedidor = typeof ouvinte === "function" ? ouvinte : null;
    if (this.#ouvinteDoMedidor) this.#ouvintesDeNivel.add(this.#ouvinteDoMedidor);
    this.#atualizarRelatorioDeNivel();
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

  encerrar() {
    const tarefa = this.#encerrarAgora();
    this.#encerrando = tarefa;
    tarefa.finally(() => {
      if (this.#encerrando === tarefa) this.#encerrando = null;
    });
    return tarefa;
  }

  async #encerrarAgora() {
    this.soltarMicrofone();
    for (const id of [...this.#saidas.keys()]) this.desligarSaida(id);
    this.medir(null);
    this.#ouvintesDeNivel.clear();

    // Sair da voz toca um aviso e desmonta tudo em seguida. Fechar o contexto
    // agora cortaria esse som no meio da primeira nota — daí a espera pela
    // cauda do que ainda está soando. O teto de um segundo é só para que um
    // relógio esquisito nunca prenda o encerramento.
    const cauda = this.#avisoAte - (this.#contexto?.currentTime ?? 0);
    if (cauda > 0) await new Promise((pronto) => setTimeout(pronto, Math.min(cauda, 1) * 1000));
    this.#avisoAte = 0;
    this.#avisos?.disconnect();
    this.#avisos = null;
    this.#soundboard?.disconnect();
    this.#soundboard = null;
    this.#soundboardLigadoAoDestino = false;
    // Os `AudioBuffer` guardados pertencem ao contexto que está fechando —
    // um contexto novo não pode tocar um buffer decodificado pelo anterior.
    this.#cacheClipes.clear();

    this.#vozes?.disconnect();
    this.#vozes = null;
    this.#worklet?.disconnect();
    this.#retornoLocal?.disconnect();
    this.#passaAlta?.disconnect();
    this.#misturaEnvio?.disconnect();
    this.#limitadorEnvio?.entrada.disconnect();
    this.#limitadorEnvio?.saida.disconnect();
    this.#destino?.disconnect();
    this.#limitadorSaida?.entrada.disconnect();
    this.#limitadorSaida?.saida.disconnect();
    this.#worklet = null;
    this.#retornoLocal = null;
    this.#monitorandoEntrada = false;
    this.#passaAlta = null;
    this.#misturaEnvio = null;
    this.#limitadorEnvio = null;
    this.#destino = null;
    this.#geral = null;
    this.#limitadorSaida = null;
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
