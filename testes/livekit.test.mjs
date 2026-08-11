import assert from "node:assert/strict";
import test from "node:test";

import { SalaLiveKit } from "../src/livekit.js";

class FluxoFalso {
  #trilhas = [];
  addTrack(trilha) {
    this.#trilhas.push(trilha);
  }
  removeTrack(trilha) {
    this.#trilhas = this.#trilhas.filter((item) => item !== trilha);
  }
  getTracks() {
    return [...this.#trilhas];
  }
}

globalThis.MediaStream = FluxoFalso;

const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantDisconnected: "participantDisconnected",
  ActiveSpeakersChanged: "activeSpeakersChanged",
};

const Track = {
  Source: {
    Microphone: "microphone",
    ScreenShare: "screen_share",
    ScreenShareAudio: "screen_share_audio",
    Unknown: "unknown",
  },
  Kind: { Audio: "audio", Video: "video" },
};

class SalaFalsa {
  static ultima = null;
  #eventos = new Map();
  publicacoes = [];
  retiradas = [];
  remoteParticipants = new Map();
  localParticipant = {
    publishTrack: async (trilha, opcoes) => {
      const track = {
        mediaStreamTrack: trilha,
        getRTCStatsReport: async () => new Map(),
        replaceTrack: async (nova) => (track.mediaStreamTrack = nova),
      };
      const publicacao = { track, source: opcoes.source };
      this.publicacoes.push({ trilha, opcoes, publicacao });
      return publicacao;
    },
    unpublishTrack: async (trilha, parar) => this.retiradas.push({ trilha, parar }),
  };
  constructor(opcoes) {
    this.opcoes = opcoes;
    SalaFalsa.ultima = this;
  }
  on(tipo, acao) {
    this.#eventos.set(tipo, acao);
  }
  emitir(tipo, ...args) {
    this.#eventos.get(tipo)?.(...args);
  }
  async connect(url, token, opcoes) {
    this.conexao = { url, token, opcoes };
  }
  async disconnect(parar) {
    this.desconectouCom = parar;
  }
}

const sdk = { Room: SalaFalsa, RoomEvent, Track };
const trilha = (id, kind) => ({ id, kind, contentHint: "", readyState: "live" });

test("publica voz tratada e tela com fontes e limites corretos", async () => {
  const recebidas = [];
  const falas = [];
  const midia = new SalaLiveKit({
    carregarSdk: async () => sdk,
    aoTrilha: (...args) => recebidas.push(args),
    aoFimDeTrilha: () => {},
    aoFala: (...args) => falas.push(args),
  });
  const microfone = trilha("microfone", "audio");
  midia.definirAudioLocal(microfone);
  await midia.definirAudio({ bitrate: 64_000, dtx: true });
  await midia.definirPerfilTela({
    dica: "motion",
    codec: "H264",
    bits: 3_000_000,
    quadros: 30,
    degradacao: "maintain-framerate",
  });
  await midia.entrar({ url: "wss://exemplo", token: "token-curto" });

  const sala = SalaFalsa.ultima;
  assert.deepEqual(sala.conexao, {
    url: "wss://exemplo",
    token: "token-curto",
    opcoes: { autoSubscribe: true },
  });
  assert.equal(sala.publicacoes[0].opcoes.source, "microphone");
  assert.equal(sala.publicacoes[0].opcoes.audioPreset.maxBitrate, 64_000);
  assert.equal(sala.publicacoes[0].opcoes.dtx, true);

  const video = trilha("video", "video");
  const som = trilha("som", "audio");
  await midia.publicarTela(video, new FluxoFalso(), som);
  assert.equal(sala.publicacoes[1].opcoes.source, "screen_share");
  assert.equal(sala.publicacoes[1].opcoes.videoCodec, "h264");
  assert.equal(sala.publicacoes[1].opcoes.screenShareEncoding.maxBitrate, 3_000_000);
  assert.equal(sala.publicacoes[2].opcoes.source, "screen_share_audio");

  const vozRemota = { mediaStreamTrack: trilha("remota", "audio"), kind: "audio" };
  sala.emitir(
    RoomEvent.TrackSubscribed,
    vozRemota,
    { source: "microphone" },
    { identity: "participante-2" }
  );
  assert.equal(recebidas[0][0], "participante-2");
  assert.equal(recebidas[0][3], "microphone");
  assert.equal(recebidas[0][4], vozRemota);
  assert.deepEqual(recebidas[0][2].getTracks(), [vozRemota.mediaStreamTrack]);

  sala.emitir(RoomEvent.ActiveSpeakersChanged, [
    { identity: "participante-2" },
    { identity: "participante-3" },
  ]);
  sala.emitir(RoomEvent.ActiveSpeakersChanged, [{ identity: "participante-3" }]);
  assert.deepEqual(falas, [
    ["participante-2", true],
    ["participante-3", true],
    ["participante-2", false],
  ]);

  await midia.fecharTudo();
  assert.deepEqual(falas.at(-1), ["participante-3", false]);
  assert.equal(sala.desconectouCom, false, "o SDK não deve parar a trilha pertencente ao motor");
});
