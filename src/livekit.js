/**
 * Transporte de mídia do CALL sobre uma sala LiveKit (SFU).
 *
 * O SDK é carregado apenas quando o servidor entrega uma credencial LiveKit.
 * Assim o aplicativo continua compatível com servidores próprios antigos, que
 * ainda usam a malha P2P, sem carregar 1 MB de JavaScript em toda abertura.
 */

const carregarSdkPadrao = () => import("./livekit-client.esm.mjs");

export class SalaLiveKit {
  #carregarSdk;
  #sdk = null;
  #sala = null;
  #geracao = 0;
  #fechando = Promise.resolve();
  #trilhaAudio = null;
  #trilhaTela = null;
  #trilhaAudioTela = null;
  #publicacaoAudio = null;
  #publicacaoTela = null;
  #publicacaoAudioTela = null;
  #bitrateAudio = 96_000;
  #dtx = false;
  #perfilTela = null;
  #fluxosRemotos = new Map();
  #falantes = new Set();

  constructor({ aoTrilha, aoFimDeTrilha, aoEstado, aoFala, carregarSdk = carregarSdkPadrao }) {
    this.aoTrilha = aoTrilha;
    this.aoFimDeTrilha = aoFimDeTrilha;
    this.aoEstado = aoEstado ?? (() => {});
    this.aoFala = aoFala ?? (() => {});
    this.#carregarSdk = carregarSdk;
  }

  get conectado() {
    return Boolean(this.#sala);
  }

  async definirAudio({ bitrate, dtx }) {
    const mudou =
      (bitrate !== undefined && bitrate !== this.#bitrateAudio) ||
      (dtx !== undefined && dtx !== this.#dtx);
    if (bitrate !== undefined) this.#bitrateAudio = bitrate;
    if (dtx !== undefined) this.#dtx = dtx;

    // Os parâmetros são aplicados na publicação. Republicar é necessário para
    // uma mudança feita durante a call; a trilha de RNNoise continua a mesma.
    if (mudou && this.#sala && this.#trilhaAudio) {
      const anterior = this.#publicacaoAudio;
      this.#publicacaoAudio = null;
      await this.#retirarPublicacao(anterior, this.#trilhaAudio);
      this.#publicacaoAudio = await this.#publicarMicrofone();
    }
  }

  definirAudioLocal(trilha) {
    trilha.contentHint = "speech";
    const publicada = this.#publicacaoAudio?.track;
    this.#trilhaAudio = trilha;
    if (publicada && publicada.mediaStreamTrack !== trilha) {
      publicada.replaceTrack(trilha).catch((erro) =>
        console.warn("[livekit] não foi possível trocar a trilha do microfone", erro)
      );
    }
  }

  async definirPerfilTela(perfil) {
    this.#perfilTela = perfil;
    if (this.#trilhaTela) this.#trilhaTela.contentHint = perfil.dica;
  }

  async entrar({ url, token }) {
    if (!url || !token) throw new Error("Credencial de mídia incompleta.");

    const geracao = ++this.#geracao;
    await this.#fechando;
    await this.#fecharSala(false);
    const sdk = (this.#sdk ??= await this.#carregarSdk());
    if (geracao !== this.#geracao) throw new Error("Entrada na mídia cancelada.");

    const sala = new sdk.Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
      disconnectOnPageLeave: true,
    });
    this.#sala = sala;
    this.#ligarEventos(sala, sdk, geracao);

    try {
      await sala.connect(url, token, { autoSubscribe: true });
      if (geracao !== this.#geracao || this.#sala !== sala) {
        await sala.disconnect(false);
        throw new Error("Entrada na mídia cancelada.");
      }
      if (!this.#trilhaAudio) throw new Error("O microfone não está pronto.");
      this.#publicacaoAudio = await this.#publicarMicrofone();
    } catch (erro) {
      if (this.#sala === sala) this.#sala = null;
      await sala.disconnect(false).catch(() => {});
      throw erro;
    }
  }

  async #publicarMicrofone() {
    return this.#sala.localParticipant.publishTrack(this.#trilhaAudio, {
      name: "voz",
      source: this.#sdk.Track.Source.Microphone,
      stream: "voz",
      audioPreset: { maxBitrate: this.#bitrateAudio, priority: "high" },
      dtx: this.#dtx,
      red: true,
      forceStereo: false,
    });
  }

  #ligarEventos(sala, sdk, geracao) {
    const vigente = () => this.#sala === sala && this.#geracao === geracao;

    sala.on(sdk.RoomEvent.TrackSubscribed, (track, publicacao, participante) => {
      if (!vigente()) return;
      const origem = publicacao.source;
      const grupo =
        origem === sdk.Track.Source.Microphone ||
        (origem === sdk.Track.Source.Unknown && track.kind === sdk.Track.Kind.Audio)
          ? "voz"
          : "tela";
      const fluxos = this.#fluxosRemotos.get(participante.identity) ?? {};
      const fluxo = fluxos[grupo] ?? new MediaStream();
      fluxos[grupo] = fluxo;
      this.#fluxosRemotos.set(participante.identity, fluxos);
      if (!fluxo.getTracks().some((item) => item.id === track.mediaStreamTrack.id)) {
        fluxo.addTrack(track.mediaStreamTrack);
      }
      // O objeto LiveKit segue junto apenas para o vídeo: `attach()` alimenta
      // o adaptive stream com tamanho/visibilidade reais do elemento.
      this.aoTrilha(participante.identity, track.mediaStreamTrack, fluxo, origem, track);
    });

    sala.on(sdk.RoomEvent.TrackUnsubscribed, (track, publicacao, participante) => {
      if (!vigente()) return;
      const fluxos = this.#fluxosRemotos.get(participante.identity);
      for (const fluxo of Object.values(fluxos ?? {})) {
        if (fluxo.getTracks().includes(track.mediaStreamTrack)) fluxo.removeTrack(track.mediaStreamTrack);
      }
      this.aoFimDeTrilha(participante.identity, track.mediaStreamTrack, publicacao.source);
    });

    // O SFU já calcula níveis de áudio para todos os participantes. Usar esse
    // resultado evita manter um segundo detector, com outro limiar, para cada
    // voz remota e faz o destaque acompanhar exatamente o estado da sala.
    sala.on(sdk.RoomEvent.ActiveSpeakersChanged, (participantes) => {
      if (!vigente()) return;
      const atuais = new Set(participantes.map((participante) => String(participante.identity)));
      for (const id of this.#falantes) {
        if (!atuais.has(id)) this.aoFala(id, false);
      }
      for (const id of atuais) {
        if (!this.#falantes.has(id)) this.aoFala(id, true);
      }
      this.#falantes = atuais;
    });

    sala.on(sdk.RoomEvent.ParticipantDisconnected, (participante) => {
      if (!vigente()) return;
      this.#fluxosRemotos.delete(participante.identity);
      // A saída normal também chega pelo WebSocket do CALL. Dar uma pequena
      // margem evita anunciá-la como falha de mídia; se o socket ficou fantasma,
      // o membro ainda estará na voz e a checagem do aplicativo agirá.
      setTimeout(() => {
        if (vigente()) this.aoEstado(participante.identity, "closed");
      }, 1200);
    });
  }

  async publicarTela(trilha, fluxo, trilhaAudio = null) {
    if (!this.#sala) throw new Error("A sala de mídia não está conectada.");
    await this.retirarTela();
    this.#trilhaTela = trilha;
    this.#trilhaAudioTela = trilhaAudio;
    trilha.contentHint = this.#perfilTela?.dica ?? "motion";
    if (trilhaAudio) trilhaAudio.contentHint = "music";

    const perfil = this.#perfilTela;
    this.#publicacaoTela = await this.#sala.localParticipant.publishTrack(trilha, {
      name: "tela",
      source: this.#sdk.Track.Source.ScreenShare,
      stream: "tela",
      videoCodec: (perfil?.codec ?? "H264").toLowerCase(),
      screenShareEncoding: perfil
        ? { maxBitrate: perfil.bits, maxFramerate: perfil.quadros, priority: "high" }
        : undefined,
      simulcast: true,
      degradationPreference: perfil?.degradacao ?? "maintain-framerate",
    });

    if (trilhaAudio) {
      try {
        this.#publicacaoAudioTela = await this.#sala.localParticipant.publishTrack(trilhaAudio, {
          name: "som-da-tela",
          source: this.#sdk.Track.Source.ScreenShareAudio,
          stream: "tela",
          audioPreset: { maxBitrate: 128_000, priority: "high" },
          dtx: false,
          red: true,
          forceStereo: true,
        });
      } catch (erro) {
        console.warn("[livekit] o vídeo foi publicado, mas o som da tela falhou", erro);
      }
    }
  }

  async retirarTela() {
    const video = this.#trilhaTela;
    const audio = this.#trilhaAudioTela;
    const publicacaoVideo = this.#publicacaoTela;
    const publicacaoAudio = this.#publicacaoAudioTela;
    this.#publicacaoTela = null;
    this.#publicacaoAudioTela = null;
    await Promise.all([
      this.#retirarPublicacao(publicacaoVideo, video),
      this.#retirarPublicacao(publicacaoAudio, audio),
    ]);
    this.#trilhaTela = null;
    this.#trilhaAudioTela = null;
  }

  async #retirarPublicacao(publicacao, trilha) {
    if (!this.#sala || (!publicacao && !trilha)) return;
    const alvo = publicacao?.track ?? trilha;
    if (alvo) await this.#sala.localParticipant.unpublishTrack(alvo, false).catch(() => {});
  }

  async statsDeVideo(id, meuId) {
    const publicacao =
      id === meuId
        ? this.#publicacaoTela
        : this.#sala?.remoteParticipants
            .get(String(id))
            ?.getTrackPublication(this.#sdk.Track.Source.ScreenShare);
    const relatorio = await publicacao?.track?.getRTCStatsReport?.();
    if (!relatorio) return null;
    const tipo = id === meuId ? "outbound-rtp" : "inbound-rtp";
    for (const item of relatorio.values()) {
      if (item.type === tipo && item.kind === "video") return item;
    }
    return null;
  }

  fecharTudo() {
    this.#geracao++;
    this.#fechando = this.#fechando.then(() => this.#fecharSala(true));
    return this.#fechando;
  }

  async #fecharSala(limparTrilhas) {
    const sala = this.#sala;
    this.#sala = null;
    for (const id of this.#falantes) this.aoFala(id, false);
    this.#falantes.clear();
    this.#fluxosRemotos.clear();
    this.#publicacaoAudio = null;
    this.#publicacaoTela = null;
    this.#publicacaoAudioTela = null;
    if (sala) await sala.disconnect(false).catch(() => {});
    if (limparTrilhas) {
      this.#trilhaAudio = null;
      this.#trilhaTela = null;
      this.#trilhaAudioTela = null;
    }
  }
}
