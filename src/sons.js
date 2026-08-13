/**
 * A identidade sonora do CALL.
 *
 * Nada aqui é um arquivo de áudio. Os sons são construídos nota por nota no
 * mesmo grafo do Web Audio que já toca a voz — não há .wav para baixar, não há
 * sample de banco de efeitos e não há um byte a mais no instalador. O som é
 * nosso no sentido literal: ele não existe em lugar nenhum antes de o
 * aplicativo o construir.
 *
 * ── O motivo ──────────────────────────────────────────────────────
 *
 * Existe *um* som, lido de quatro maneiras. Isso é deliberado: uma marca
 * sonora é uma frase curta que se reconhece, e não um catálogo de bipes.
 *
 *   um sino de vidro, duas notas, um quinta justa
 *
 *   • sobe (Lá♭4 → Mi♭5) quando alguém chega
 *   • desce (Mi♭5 → Lá♭4) quando alguém sai
 *   • com peso de grave e mais perto quando o evento é seu
 *   • leve e mais longe quando o evento é de outra pessoa
 *
 * Direção diz o quê. Peso diz de quem. Timbre diz que é o CALL.
 *
 * ── Por que soa agradável ─────────────────────────────────────────
 *
 * Três decisões respondem por quase tudo:
 *
 * 1. **Parciais harmônicas que morrem em ordem.** Um sino real perde os
 *    agudos antes dos graves. Cada parcial tem o próprio tempo de queda, e é
 *    isso que separa "sino" de "bipe" — o som escurece enquanto some, em vez
 *    de sumir do jeito que entrou.
 *
 * 2. **Ataque de 6 ms.** Abaixo disso o alto-falante estala; muito acima o som
 *    fica mole e some no meio da conversa. Seis milissegundos é a janela em
 *    que o som tem contorno sem ter clique.
 *
 * 3. **Uma quinta justa, nunca um semitom.** A razão 3:2 é a mais consonante
 *    depois da oitava. É o que permite ouvir isto quarenta vezes por noite sem
 *    criar irritação — o intervalo não pede resolução, então não incomoda.
 *
 * O registro (415 a 622 Hz) fica acima da fundamental da voz e abaixo do
 * agudo que fere. É a mesma faixa em que a fala é inteligível, mas o som é
 * curto demais para mascarar alguma coisa: aos 90 ms já entregou o que tinha.
 */

/* ── Material ─────────────────────────────────────────────────────── */

/** Temperamento igual, Lá4 = 440 Hz. Lá♭ nas três oitavas que interessam. */
const NOTA_GRAVE = 103.826; // Lá♭2 — o peso, duas oitavas abaixo da base
const NOTA_BASE = 415.305; // Lá♭4 — a nota de baixo do par
const NOTA_ALTA = 622.254; // Mi♭5 — a quinta justa acima dela

/**
 * O timbre do sino, como parciais senoidais somadas.
 *
 * `decai` é a fração do tempo de queda da fundamental que aquela parcial
 * dura. Os agudos somem primeiro — é isso que dá o escurecimento do sino.
 * A parcial em 4,19 é inarmônica de propósito: um pouco fora da série dá o
 * brilho do golpe, e ela morre rápido demais para soar desafinada.
 */
const PARCIAIS = [
  { razao: 1, amp: 1, decai: 1 },
  { razao: 2, amp: 0.16, decai: 0.55 },
  { razao: 3, amp: 0.055, decai: 0.32 },
  { razao: 4.19, amp: 0.03, decai: 0.16 },
];

/** Curto o bastante para não estalar, longo o bastante para ter contorno. */
const ATAQUE = 0.006;

/** Atraso da segunda nota. Em 85 ms as duas ainda se leem como um gesto só,
 *  e não como dois sons seguidos. */
const INTERVALO = 0.085;

/** Quanto cada nota dura, em segundos. A primeira é curta para não embolar a
 *  segunda; a segunda leva a cauda. */
const QUEDA_PRIMEIRA = 0.45;
const QUEDA_SEGUNDA = 0.8;
const QUEDA_PESO = 0.22;

/** Afastamento das notas no campo estéreo. O gesto anda de um lado para o
 *  outro: quem entra vem para dentro, quem sai vai embora. */
const LARGURA = 0.28;

/**
 * As quatro leituras do mesmo motivo.
 *
 * `peso` é o grave que sustenta a nota Lá♭ — presente só quando o evento é
 * seu. É o que faz a própria entrada ter corpo e a dos outros ser um aviso.
 *
 * Os ganhos não são estimados: saíram da medição em `testes/sons.html`. Vale
 * anotar por quê, porque o valor "óbvio" está errado por 13 dB. Quatro
 * parciais e duas notas se somam construtivamente, e um ganho de 1,0 leva o
 * pico a −1,1 dBFS — à beira do corte, e alto o bastante para assustar quem
 * está de fone. Os números abaixo põem cada som no alvo medido:
 *
 *   entrei −14 dBFS   entrou −19 dBFS   sai −15 dBFS   saiu −20 dBFS
 *
 * e ainda passam pelo volume dos avisos, que por padrão tira outros 3 dB.
 * Mexer em `PARCIAIS` muda esses picos: o teste é que diz para onde.
 */
export const RECEITAS = {
  /** Você entrou na voz. */
  entrei: { subindo: true, ganho: 0.23, peso: 0.2 },
  /** Alguém entrou no seu canal de voz. */
  entrou: { subindo: true, ganho: 0.13, peso: 0 },
  /** Você saiu da voz. */
  sai: { subindo: false, ganho: 0.21, peso: 0.16 },
  /** Alguém saiu do seu canal de voz. */
  saiu: { subindo: false, ganho: 0.12, peso: 0 },
  /** Mensagem nova de outra pessoa. Curto, agudo e um pouco mais presente. */
  mensagem: { subindo: true, ganho: 0.2, peso: 0 },
};

/* ── Construção ───────────────────────────────────────────────────── */

/**
 * Uma nota de sino: as parciais somadas, cada uma com o próprio envelope.
 * Devolve o instante em que a última se cala.
 */
function sino(ctx, destino, { freq, em, queda, lado }) {
  const saida = ctx.createGain();
  saida.gain.value = 1;

  // `StereoPannerNode` existe em todo WebView2 atual, mas o grafo não pode
  // depender disso: sem ele o som fica no centro, e só.
  if (ctx.createStereoPanner) {
    const panorama = ctx.createStereoPanner();
    panorama.pan.value = lado;
    saida.connect(panorama);
    panorama.connect(destino);
  } else {
    saida.connect(destino);
  }

  let fim = em;
  for (const p of PARCIAIS) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * p.razao;

    const envelope = ctx.createGain();
    const dura = queda * p.decai;
    // A rampa exponencial não chega a zero — daí o corte seco no fim, quando
    // o valor já está 60 dB abaixo e ninguém ouve o degrau.
    envelope.gain.setValueAtTime(0.0001, em);
    envelope.gain.linearRampToValueAtTime(p.amp, em + ATAQUE);
    envelope.gain.exponentialRampToValueAtTime(p.amp * 0.0008, em + ATAQUE + dura);
    envelope.gain.setValueAtTime(0, em + ATAQUE + dura);

    osc.connect(envelope);
    envelope.connect(saida);
    osc.start(em);
    osc.stop(em + ATAQUE + dura + 0.01);

    fim = Math.max(fim, em + ATAQUE + dura + 0.01);
  }
  return fim;
}

/**
 * O grave que sustenta a nota Lá♭. Senoide pura e curta: em alto-falante de
 * notebook não se ouve nada, em fone é o que dá o peito do som.
 */
function peso(ctx, destino, { em, ganho }) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = NOTA_GRAVE;

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, em);
  envelope.gain.linearRampToValueAtTime(ganho, em + 0.004);
  envelope.gain.exponentialRampToValueAtTime(ganho * 0.001, em + QUEDA_PESO);
  envelope.gain.setValueAtTime(0, em + QUEDA_PESO);

  osc.connect(envelope);
  envelope.connect(destino);
  osc.start(em);
  osc.stop(em + QUEDA_PESO + 0.01);
  return em + QUEDA_PESO + 0.01;
}

/**
 * Uma única repetição abafada, 110 ms depois. Não é reverberação de verdade —
 * é o truque barato que a substitui: sem ela o sino toca dentro do fone, com
 * ela toca dentro de uma sala. Um `ConvolverNode` faria melhor e custaria uma
 * resposta impulsiva inteira para uma diferença que quase ninguém nomeia.
 */
function sala(ctx, entrada, destino) {
  const atraso = ctx.createDelay(0.5);
  atraso.delayTime.value = 0.11;

  const abafo = ctx.createBiquadFilter();
  abafo.type = "lowpass";
  abafo.frequency.value = 2500;

  const nivel = ctx.createGain();
  nivel.gain.value = 0.16;

  entrada.connect(atraso);
  atraso.connect(abafo);
  abafo.connect(nivel);
  nivel.connect(destino);

  return () => {
    atraso.disconnect();
    abafo.disconnect();
    nivel.disconnect();
  };
}

/**
 * Agenda um dos sons e devolve o instante, no relógio do contexto, em que ele
 * termina de soar. Quem chama usa isso para não desligar o dispositivo de
 * áudio no meio da cauda.
 */
export function tocar(ctx, destino, nome) {
  const receita = RECEITAS[nome];
  if (!receita) return 0;

  // Uma folga antes do primeiro evento: agendar no `currentTime` exato deixa
  // o começo do ataque a cargo de quando o bloco seguinte for processado, e é
  // exatamente aí que aparece o estalo.
  const t0 = ctx.currentTime + 0.02;

  const raiz = ctx.createGain();
  raiz.gain.value = receita.ganho;
  raiz.connect(destino);
  const desligarSala = sala(ctx, raiz, destino);

  const primeira = receita.subindo ? NOTA_BASE : NOTA_ALTA;
  const segunda = receita.subindo ? NOTA_ALTA : NOTA_BASE;
  const lado = receita.subindo ? LARGURA : -LARGURA;

  let fim = sino(ctx, raiz, { freq: primeira, em: t0, queda: QUEDA_PRIMEIRA, lado: -lado });
  fim = Math.max(
    fim,
    sino(ctx, raiz, { freq: segunda, em: t0 + INTERVALO, queda: QUEDA_SEGUNDA, lado })
  );

  // O grave acompanha sempre o Lá♭ — a primeira nota ao entrar, a segunda ao
  // sair. Chegar é firmar o chão; sair é pousar nele.
  if (receita.peso > 0) {
    const quando = receita.subindo ? t0 : t0 + INTERVALO;
    fim = Math.max(fim, peso(ctx, raiz, { em: quando, ganho: receita.peso }));
  }

  // Os osciladores se soltam sozinhos ao terminar, mas a raiz e a sala ficam
  // penduradas no destino até alguém desligá-las. A cauda mais 200 ms cobre o
  // atraso da repetição com folga.
  const sobra = (fim - ctx.currentTime + 0.2) * 1000;
  setTimeout(() => {
    raiz.disconnect();
    desligarSala();
  }, Math.max(0, sobra));

  return fim + 0.2;
}
