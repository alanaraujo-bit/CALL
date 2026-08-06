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

/** Teto de banda e de quadros da tela. Sem isto o WebRTC sobe o bitrate até
 *  onde a rede aguentar — e é a CPU de quem transmite que paga a conta. */
const TETO_BITS = 1_200_000;
const TETO_QUADROS = 15;

async function limitarTela(remetente) {
  if (!remetente) return;
  try {
    const parametros = remetente.getParameters();
    parametros.encodings = parametros.encodings?.length
      ? parametros.encodings
      : [{}];
    for (const codificacao of parametros.encodings) {
      codificacao.maxBitrate = TETO_BITS;
      codificacao.maxFramerate = TETO_QUADROS;
    }
    await remetente.setParameters(parametros);
  } catch (erro) {
    console.warn("[rtc] não foi possível limitar a tela", erro);
  }
}

class Elo {
  constructor(id, polido, malha) {
    this.id = id;
    this.polido = polido;
    this.malha = malha;
    this.fazendoOferta = false;
    this.ignorandoOferta = false;
    this.remetenteTela = null;

    const pc = new RTCPeerConnection(CONFIGURACAO);
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.fazendoOferta = true;
        await pc.setLocalDescription();
        malha.enviarSinal(id, { descricao: pc.localDescription });
      } catch (erro) {
        console.error("[rtc] falha ao ofertar", erro);
      } finally {
        this.fazendoOferta = false;
      }
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

  async receber({ descricao, candidato }) {
    const pc = this.pc;
    try {
      if (descricao) {
        const colisao =
          descricao.type === "offer" &&
          (this.fazendoOferta || pc.signalingState !== "stable");

        this.ignorandoOferta = !this.polido && colisao;
        if (this.ignorandoOferta) return;

        await pc.setRemoteDescription(descricao);
        if (descricao.type === "offer") {
          await pc.setLocalDescription();
          this.malha.enviarSinal(this.id, { descricao: pc.localDescription });
        }
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

export class Malha {
  #elos = new Map();
  #trilhaAudio = null;
  #fluxoAudio = null;
  #trilhaTela = null;
  #fluxoTela = null;

  constructor({ enviarSinal, aoTrilha, aoFimDeTrilha, aoEstado }) {
    this.enviarSinal = enviarSinal;
    this.aoTrilha = aoTrilha;
    this.aoFimDeTrilha = aoFimDeTrilha;
    this.aoEstado = aoEstado ?? (() => {});
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
      const jaTem = elo.pc.getSenders().some((r) => r.track?.kind === "audio");
      if (!jaTem) elo.pc.addTrack(trilha, fluxo);
    }
  }

  /**
   * Abre a conexão com um participante.
   * `iniciar` decide quem oferta primeiro; a polidez desempata colisões.
   */
  abrir(id, iniciar) {
    if (this.#elos.has(id)) return this.#elos.get(id);

    const elo = new Elo(id, !iniciar, this);
    this.#elos.set(id, elo);

    if (this.#trilhaAudio) elo.pc.addTrack(this.#trilhaAudio, this.#fluxoAudio);
    if (this.#trilhaTela) {
      elo.remetenteTela = elo.pc.addTrack(this.#trilhaTela, this.#fluxoTela);
      limitarTela(elo.remetenteTela);
    }
    return elo;
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
  }

  publicarTela(trilha, fluxo) {
    this.#trilhaTela = trilha;
    this.#fluxoTela = fluxo;
    for (const elo of this.#elos.values()) {
      if (!elo.remetenteTela) {
        elo.remetenteTela = elo.pc.addTrack(trilha, fluxo);
        limitarTela(elo.remetenteTela);
      }
    }
  }

  retirarTela() {
    for (const elo of this.#elos.values()) {
      if (elo.remetenteTela) {
        try {
          elo.pc.removeTrack(elo.remetenteTela);
        } catch {
          /* conexão já encerrada */
        }
        elo.remetenteTela = null;
      }
    }
    this.#trilhaTela = null;
    this.#fluxoTela = null;
  }
}
