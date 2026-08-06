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
  constructor(id, polido, malha, esperandoOferta) {
    this.id = id;
    this.polido = polido;
    this.malha = malha;
    this.fazendoOferta = false;
    this.ignorandoOferta = false;
    this.aplicandoDescricao = false;
    /** Este lado combinou de só responder: a primeira oferta vem do outro. */
    this.esperandoOferta = esperandoOferta;
    this.remetenteTela = null;

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

  async ofertar() {
    try {
      this.fazendoOferta = true;
      await this.pc.setLocalDescription();
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
            await pc.setLocalDescription();
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

  constructor({ enviarSinal, aoTrilha, aoFimDeTrilha, aoEstado, meuId }) {
    this.enviarSinal = enviarSinal;
    this.aoTrilha = aoTrilha;
    this.aoFimDeTrilha = aoFimDeTrilha;
    this.aoEstado = aoEstado ?? (() => {});
    this.#meuId = meuId ?? null;
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
      const jaTem = elo.pc.getSenders().some((r) => r.track?.kind === "audio");
      if (!jaTem) elo.pc.addTrack(trilha, fluxo);
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
