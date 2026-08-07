/**
 * Malha WebRTC: uma conexão ponto a ponto para cada participante.
 * Usa o padrão de "negociação perfeita" para que qualquer lado possa
 * adicionar a trilha de tela a qualquer momento sem colisão de ofertas.
 */

const CONFIGURACAO = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};

/**
 * Perfis de transmissão de tela.
 *
 * O valor anterior era um só: 1,2 Mbps e 15 quadros, escolhido para proteger a
 * CPU de quem transmite. Ele é razoável para mostrar um editor de texto e
 * inaceitável para qualquer outra coisa — um jogo a 15 quadros com 1,2 Mbps
 * chega do outro lado como uma sopa de blocos.
 *
 * O `codec` não é enfeite, é a diferença entre leve e pesado:
 *
 * - **VP9** custa mais CPU por quadro e rende muito mais em imagem parada com
 *   texto: nas taxas baixas ele preserva bordas que o VP8 borra. Nos perfis de
 *   até 30 quadros sobra CPU para pagar por isso.
 * - **H.264** tem codificador em hardware em praticamente toda GPU dos últimos
 *   dez anos. Nos perfis de 60 quadros é ele que mantém a promessa de ser leve:
 *   o trabalho sai do processador e vai para a placa de vídeo.
 *
 * `dica` vira `contentHint` na trilha, e decide o que o codificador sacrifica
 * quando a banda aperta: `detail` abre mão de quadros para manter a nitidez,
 * `motion` faz o contrário.
 */
export const PERFIS_TELA = [
  {
    id: "leve",
    nome: "Leve",
    detalhe: "720p · 30 fps · 1,5 Mbps",
    resumo: "Para redes modestas e máquinas antigas",
    largura: 1280, altura: 720, quadros: 30, bits: 1_500_000,
    dica: "detail", codec: "VP9", degradacao: "maintain-resolution",
  },
  {
    id: "equilibrado",
    nome: "Equilibrado",
    detalhe: "1080p · 30 fps · 3 Mbps",
    resumo: "Texto legível e movimento aceitável",
    largura: 1920, altura: 1080, quadros: 30, bits: 3_000_000,
    dica: "detail", codec: "VP9", degradacao: "maintain-resolution",
  },
  {
    id: "nitido",
    nome: "Nítido",
    detalhe: "1080p · 60 fps · 6 Mbps",
    resumo: "Movimento fluido — jogos e vídeo",
    largura: 1920, altura: 1080, quadros: 60, bits: 6_000_000,
    dica: "motion", codec: "H264", degradacao: "maintain-framerate",
  },
  {
    id: "maximo",
    nome: "Máximo",
    detalhe: "1440p · 60 fps · 10 Mbps",
    resumo: "Exige rede boa e placa de vídeo com codificador",
    largura: 2560, altura: 1440, quadros: 60, bits: 10_000_000,
    dica: "motion", degradacao: "maintain-framerate",
    codec: "H264",
  },
];

export const PERFIL_TELA_PADRAO = "equilibrado";

export function acharPerfilDeTela(id) {
  return PERFIS_TELA.find((p) => p.id === id) ?? PERFIS_TELA.find((p) => p.id === PERFIL_TELA_PADRAO);
}

/** Aplica o teto de banda, de quadros e a política de degradação ao remetente
 *  da tela. Sem teto o WebRTC sobe o bitrate até onde a rede aguentar — e é a
 *  CPU de quem transmite que paga a conta da codificação. */
async function limitarTela(remetente, perfil) {
  if (!remetente) return;
  try {
    const parametros = remetente.getParameters();
    parametros.encodings = parametros.encodings?.length ? parametros.encodings : [{}];
    for (const codificacao of parametros.encodings) {
      codificacao.maxBitrate = perfil.bits;
      codificacao.maxFramerate = perfil.quadros;
    }
    parametros.degradationPreference = perfil.degradacao;
    await remetente.setParameters(parametros);
  } catch (erro) {
    console.warn("[rtc] não foi possível limitar a tela", erro);
  }
}

/** Teto de banda do áudio. O Opus do Chromium fica em torno de 32 kbps sem
 *  isto; o `maxBitrate` do remetente é o que o faz subir de verdade. */
async function limitarAudio(remetente, bits) {
  if (!remetente) return;
  try {
    const parametros = remetente.getParameters();
    parametros.encodings = parametros.encodings?.length ? parametros.encodings : [{}];
    for (const codificacao of parametros.encodings) codificacao.maxBitrate = bits;
    await remetente.setParameters(parametros);
  } catch (erro) {
    console.warn("[rtc] não foi possível ajustar o áudio", erro);
  }
}

/**
 * Coloca o codec preferido na frente da lista do transceptor de vídeo.
 *
 * Preferir não é impor: se o outro lado não tiver o codec, a negociação escolhe
 * o primeiro em comum, como sempre. Por isso a lista completa é mantida atrás
 * do preferido, em vez de filtrada.
 */
function preferirCodec(transceptor, nome) {
  if (!transceptor?.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
  try {
    const { codecs } = RTCRtpSender.getCapabilities("video") ?? {};
    if (!codecs?.length) return;

    const alvo = nome.toLowerCase();
    const preferidos = codecs.filter((c) => c.mimeType.toLowerCase() === `video/${alvo}`);
    if (preferidos.length === 0) return;

    const resto = codecs.filter((c) => !preferidos.includes(c));
    transceptor.setCodecPreferences([...preferidos, ...resto]);
  } catch (erro) {
    console.warn("[rtc] preferência de codec recusada", erro);
  }
}

/* ═══ Opus ══════════════════════════════════════════════════════ */

/**
 * Reescreve a linha `fmtp` do Opus na descrição local.
 *
 * A negociação padrão do Chromium não declara nada, e o resultado é voz mono em
 * torno de 32 kbps sem correção de erro — audível, e bem longe do que o codec
 * consegue. Os parâmetros abaixo são declarações do *receptor*: eles dizem ao
 * outro lado o que mandar para cá. Como os dois lados rodam este mesmo código,
 * os dois passam a receber o que pediram.
 *
 * - `maxaveragebitrate` é o teto que aceitamos receber.
 * - `useinbandfec=1` embute na banda uma cópia degradada do quadro anterior. O
 *   custo é pequeno e é o que faz uma perda de 5% de pacotes soar como nada em
 *   vez de soar como um talho.
 * - `usedtx` corta o envio no silêncio. Economiza banda e, na volta da fala,
 *   entrega um degrau de ruído de conforto sintético. Fica desligado por
 *   padrão; a opção existe para quem precisa da banda.
 * - `stereo=0` é explícito de propósito: voz é mono, e dois canais só
 *   transportariam duas cópias do mesmo microfone.
 */
/**
 * Teto declarado na `fmtp`, e não a qualidade escolhida.
 *
 * A `fmtp` diz ao outro lado o que *nós* aceitamos receber; quem decide o que
 * sai daqui é o `maxBitrate` do nosso remetente. Se a escolha do usuário fosse
 * parar na `fmtp`, quem escolhesse "econômico" limitaria a voz de todos os
 * outros a 32 kbps — cada um controlaria a qualidade alheia, não a própria.
 * Declaramos sempre o teto e deixamos cada máquina governar o próprio envio.
 */
const TETO_RECEPCAO_OPUS = 128000;

/** O som que acompanha a tela é música, efeito e trilha — não voz. Ele não
 *  passa por porta de ruído nem por cancelamento de eco, e recebe o teto do
 *  codec, porque 64 kbps de voz aplicados a uma trilha sonora soam como rádio
 *  AM. */
const BITRATE_AUDIO_TELA = 128000;

export function ajustarOpus(sdp, { bitrate = TETO_RECEPCAO_OPUS, dtx = false } = {}) {
  const parametros = [
    "minptime=10",
    "useinbandfec=1",
    `usedtx=${dtx ? 1 : 0}`,
    "stereo=0",
    "sprop-stereo=0",
    `maxaveragebitrate=${bitrate}`,
    "maxplaybackrate=48000",
    "sprop-maxcapturerate=48000",
  ].join(";");

  // Todas as cargas Opus, e não a primeira: quem compartilha a tela com som
  // tem duas seções de áudio na descrição, e ajustar só uma deixaria o som do
  // sistema com a negociação padrão — justamente o que se quis corrigir.
  let saida = sdp;
  for (const [, carga] of sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)) {
    const fmtp = new RegExp(`a=fmtp:${carga} .*`);
    if (fmtp.test(saida)) {
      saida = saida.replace(fmtp, `a=fmtp:${carga} ${parametros}`);
    } else {
      // Sem linha `fmtp`, ela entra logo depois do `rtpmap` correspondente.
      const linha = new RegExp(`(a=rtpmap:${carga} opus/48000/2)`);
      saida = saida.replace(linha, `$1\r\na=fmtp:${carga} ${parametros}`);
    }
  }
  return saida;
}

class Elo {
  constructor(id, polido, malha, esperandoOferta) {
    this.id = id;
    this.polido = polido;
    this.malha = malha;
    this.fazendoOferta = false;
    this.ignorandoOferta = false;
    this.aplicandoDescricao = false;
    /** Este lado combinou de só responder: a primeira oferta vem do outro. */
    this.esperandoOferta = esperandoOferta;
    this.remetenteAudio = null;
    this.remetenteTela = null;
    this.remetenteAudioTela = null;
    /** Guardado só para a preferência de codec, que age no transceptor. */
    this.transceptorTela = null;

    const pc = new RTCPeerConnection(CONFIGURACAO);
    this.pc = pc;

    pc.onnegotiationneeded = () => {
      // Adicionar a trilha local dispara isto nos dois lados ao mesmo tempo, e
      // uma colisão de ofertas logo na abertura é o caso em que a negociação
      // perfeita mais custa: ela exige um rollback, e no Chromium o rollback
      // deixa a coleta de candidatos ICE parada. Quem já sabe que vai apenas
      // responder simplesmente não oferta, e a colisão nunca acontece.
      //
      // Um rollback também devolve o estado a `stable` e redispara este
      // evento; sem a segunda guarda, a resposta que estamos montando viraria
      // uma segunda oferta.
      //
      // Ignorar o evento não perde nada: a marca de "precisa negociar" só é
      // baixada por um `setLocalDescription` bem-sucedido, e o navegador
      // redispara isto sozinho assim que o estado volta a `stable`. Anotar a
      // pendência à mão, e ofertar depois, só produz uma renegociação a mais.
      if (this.esperandoOferta || this.aplicandoDescricao) return;
      this.ofertar();
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) malha.enviarSinal(id, { candidato: candidate });
    };

    pc.ontrack = ({ track, streams }) => {
      malha.aoTrilha(id, track, streams[0]);
      track.onended = () => malha.aoFimDeTrilha(id, track);
    };

    pc.onconnectionstatechange = () => {
      malha.aoEstado(id, pc.connectionState);
    };
  }

  /**
   * Gera e aplica a descrição local, com a `fmtp` do Opus reescrita no caminho.
   *
   * O `setLocalDescription()` sem argumento — a forma recomendada, que escolhe
   * sozinha entre oferta e resposta — não deixa espaço para editar o SDP. Aqui
   * a escolha é feita à mão pelo estado da sinalização, que é exatamente o
   * critério que ele usaria.
   */
  async descreverLocal() {
    const pc = this.pc;
    const respondendo =
      pc.signalingState === "have-remote-offer" || pc.signalingState === "have-local-pranswer";
    const descricao = respondendo ? await pc.createAnswer() : await pc.createOffer();
    descricao.sdp = ajustarOpus(descricao.sdp, this.malha.opcoesDeAudio);
    await pc.setLocalDescription(descricao);
  }

  async ofertar() {
    try {
      this.fazendoOferta = true;
      await this.descreverLocal();
      this.malha.enviarSinal(this.id, { descricao: this.pc.localDescription });
    } catch (erro) {
      console.error("[rtc] falha ao ofertar", erro);
    } finally {
      this.fazendoOferta = false;
    }
  }

  async receber({ descricao, candidato }) {
    const pc = this.pc;
    try {
      if (descricao) {
        const colisao =
          descricao.type === "offer" &&
          (this.fazendoOferta || pc.signalingState !== "stable");

        this.ignorandoOferta = !this.polido && colisao;
        if (this.ignorandoOferta) return;

        this.aplicandoDescricao = true;
        try {
          if (colisao) await pc.setLocalDescription({ type: "rollback" });
          await pc.setRemoteDescription(descricao);
          if (descricao.type === "offer") {
            await this.descreverLocal();
            this.malha.enviarSinal(this.id, { descricao: pc.localDescription });
          }
        } finally {
          this.aplicandoDescricao = false;
        }

        // A partir daqui este lado pode ofertar por conta própria: a espera
        // valia só para a primeira negociação.
        this.esperandoOferta = false;
      } else if (candidato) {
        try {
          await pc.addIceCandidate(candidato);
        } catch (erro) {
          if (!this.ignorandoOferta) throw erro;
        }
      }
    } catch (erro) {
      console.error("[rtc] sinal descartado", erro);
    }
  }

  fechar() {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* já estava fechada */
    }
  }
}

/**
 * Desempate de colisão de ofertas. Precisa dar respostas opostas nos dois
 * lados a partir do mesmo par de identificadores — é essa a única garantia
 * que a negociação perfeita pede.
 */
function souOPolido(meuId, outroId) {
  const meu = Number(meuId);
  const outro = Number(outroId);
  if (Number.isFinite(meu) && Number.isFinite(outro)) return meu < outro;
  return String(meuId) < String(outroId);
}

export class Malha {
  #elos = new Map();
  #meuId = null;
  #trilhaAudio = null;
  #fluxoAudio = null;
  #trilhaTela = null;
  #fluxoTela = null;
  #trilhaAudioTela = null;
  #bitrateAudio = 64000;
  #dtx = false;
  #perfilTela = acharPerfilDeTela(PERFIL_TELA_PADRAO);

  constructor({ enviarSinal, aoTrilha, aoFimDeTrilha, aoEstado, meuId }) {
    this.enviarSinal = enviarSinal;
    this.aoTrilha = aoTrilha;
    this.aoFimDeTrilha = aoFimDeTrilha;
    this.aoEstado = aoEstado ?? (() => {});
    this.#meuId = meuId ?? null;
  }

  /** Lido pelo `Elo` na hora de montar a descrição local. */
  get opcoesDeAudio() {
    return { bitrate: TETO_RECEPCAO_OPUS, dtx: this.#dtx };
  }

  get perfilTela() {
    return this.#perfilTela;
  }

  /**
   * Qualidade do áudio que sai desta máquina. O bitrate vale na hora, sem
   * renegociar; o `dtx` é declaração de SDP e só chega ao outro lado na
   * próxima negociação — o que é aceitável para uma opção que quase ninguém
   * muda no meio de uma conversa.
   */
  async definirAudio({ bitrate, dtx }) {
    if (bitrate !== undefined) this.#bitrateAudio = bitrate;
    if (dtx !== undefined) this.#dtx = dtx;
    await Promise.all(
      [...this.#elos.values()].map((elo) => limitarAudio(elo.remetenteAudio, this.#bitrateAudio))
    );
  }

  /**
   * Troca o perfil da tela. As dimensões e os quadros vivem na trilha de
   * captura e são aplicados por quem a possui; aqui trata-se do que depende da
   * conexão — teto de banda, política de degradação e codec.
   */
  async definirPerfilTela(perfil) {
    this.#perfilTela = perfil;
    if (this.#trilhaTela) this.#trilhaTela.contentHint = perfil.dica;
    for (const elo of this.#elos.values()) {
      if (!elo.remetenteTela) continue;
      preferirCodec(elo.transceptorTela, perfil.codec);
      await limitarTela(elo.remetenteTela, perfil);
    }
  }

  /** O servidor só diz quem eu sou depois que a malha já existe. */
  definirIdentidade(id) {
    this.#meuId = id;
  }

  get pares() {
    return [...this.#elos.keys()];
  }

  /** Conexões vivas, para diagnóstico e estatísticas. */
  get conexoes() {
    return new Map([...this.#elos].map(([id, elo]) => [id, elo.pc]));
  }

  definirAudioLocal(trilha, fluxo) {
    this.#trilhaAudio = trilha;
    this.#fluxoAudio = fluxo;
    for (const elo of this.#elos.values()) {
      if (!elo.remetenteAudio) {
        elo.remetenteAudio = elo.pc.addTrack(trilha, fluxo);
        limitarAudio(elo.remetenteAudio, this.#bitrateAudio);
      } else if (elo.remetenteAudio.track !== trilha) {
        // Trocar a trilha no remetente não muda o SDP: o microfone pode ser
        // trocado no meio da conversa sem uma renegociação por participante.
        elo.remetenteAudio.replaceTrack(trilha).catch(() => {});
      }
    }
  }

  /**
   * Abre a conexão com um participante. `iniciar` decide apenas quem oferta
   * primeiro.
   *
   * A polidez, essa, vem dos identificadores. Amarrá-la a quem criou o elo
   * primeiro parece equivalente e não é: se a oferta do outro chega antes de
   * eu abrir o elo, `receberSinal` o abre como respondedor, e os dois lados
   * acabam polidos. Sem ninguém para desempatar, uma colisão de ofertas trava
   * a conexão em `stable` e nada mais trafega.
   */
  abrir(id, iniciar) {
    if (this.#elos.has(id)) return this.#elos.get(id);

    const polido =
      this.#meuId == null ? !iniciar : souOPolido(this.#meuId, id);
    const elo = new Elo(id, polido, this, !iniciar);
    this.#elos.set(id, elo);

    if (this.#trilhaAudio) {
      elo.remetenteAudio = elo.pc.addTrack(this.#trilhaAudio, this.#fluxoAudio);
      limitarAudio(elo.remetenteAudio, this.#bitrateAudio);
    }
    if (this.#trilhaTela) this.#anexarTela(elo);
    return elo;
  }

  /** A preferência de codec precisa estar posta antes de a oferta ser criada.
   *  `addTrack` só agenda a renegociação, então o que vem logo a seguir, de
   *  forma síncrona, ainda chega a tempo. */
  #anexarTela(elo) {
    elo.remetenteTela = elo.pc.addTrack(this.#trilhaTela, this.#fluxoTela);
    elo.transceptorTela = elo.pc
      .getTransceivers()
      .find((t) => t.sender === elo.remetenteTela);
    preferirCodec(elo.transceptorTela, this.#perfilTela.codec);
    limitarTela(elo.remetenteTela, this.#perfilTela);

    // O som do sistema vai numa trilha própria, no mesmo fluxo do vídeo. É o
    // que permite ao outro lado distingui-lo da voz — e, sobretudo, não passá-lo
    // pelos filtros feitos para voz. Um cancelador de eco e uma porta de ruído
    // destroem música e efeitos de jogo.
    if (this.#trilhaAudioTela) {
      elo.remetenteAudioTela = elo.pc.addTrack(this.#trilhaAudioTela, this.#fluxoTela);
      limitarAudio(elo.remetenteAudioTela, BITRATE_AUDIO_TELA);
    }
  }

  receberSinal(id, dados) {
    const elo = this.#elos.get(id) ?? this.abrir(id, false);
    elo.receber(dados);
  }

  fechar(id) {
    const elo = this.#elos.get(id);
    if (!elo) return;
    elo.fechar();
    this.#elos.delete(id);
  }

  fecharTudo() {
    for (const id of [...this.#elos.keys()]) this.fechar(id);
    this.#trilhaAudio = null;
    this.#fluxoAudio = null;
    this.#trilhaTela = null;
    this.#fluxoTela = null;
    this.#trilhaAudioTela = null;
  }

  publicarTela(trilha, fluxo, trilhaAudio = null) {
    this.#trilhaTela = trilha;
    this.#fluxoTela = fluxo;
    this.#trilhaAudioTela = trilhaAudio;
    trilha.contentHint = this.#perfilTela.dica;
    // "music" impede que o cancelamento de eco e a supressão de ruído do motor
    // ajam sobre uma trilha que não é voz.
    if (trilhaAudio) trilhaAudio.contentHint = "music";
    for (const elo of this.#elos.values()) {
      if (!elo.remetenteTela) this.#anexarTela(elo);
    }
  }

  retirarTela() {
    for (const elo of this.#elos.values()) {
      for (const campo of ["remetenteTela", "remetenteAudioTela"]) {
        if (!elo[campo]) continue;
        try {
          elo.pc.removeTrack(elo[campo]);
        } catch {
          /* conexão já encerrada */
        }
        elo[campo] = null;
      }
      elo.transceptorTela = null;
    }
    this.#trilhaTela = null;
    this.#fluxoTela = null;
    this.#trilhaAudioTela = null;
  }
}
