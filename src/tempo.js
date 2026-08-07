/**
 * Tempo em call e quem passou por ela.
 *
 * Vive fora do `app.js` porque é a única parte disto que tem regra de
 * verdade — o resto é DOM. Aqui a regra pode ser exercitada sem navegador,
 * sem microfone e sem servidor, em `testes/tempo.test.mjs`.
 *
 * A regra difícil é uma só, e é sobre honestidade: **de quem já estava na
 * call quando você chegou, não dá para saber desde quando.** O servidor não
 * guarda o instante em que cada um entrou na voz, e o aplicativo só passa a
 * ver a pessoa no momento em que ele próprio entra. Essas passagens ficam
 * marcadas como inexatas e o número que sai delas é um piso, nunca um total.
 * Arredondar isso para um número redondo seria mais bonito e seria mentira.
 */

/** `12:34`, e `1:02:03` depois de uma hora. */
export function relogio(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const dois = (n) => String(n).padStart(2, "0");
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundos = total % 60;
  return horas > 0
    ? `${horas}:${dois(minutos)}:${dois(segundos)}`
    : `${dois(minutos)}:${dois(segundos)}`;
}

/**
 * Duração aproximada, para o histórico: ali o segundo exato não importa e
 * `03:47` custa mais para ler do que `4 min`.
 */
export function tempoCurto(ms) {
  const segundos = Math.max(0, Math.round(ms / 1000));
  if (segundos < 60) return `${segundos} s`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h ${String(minutos % 60).padStart(2, "0")}`;
}

/**
 * O registro de uma call: quem está nela agora e quem já saiu.
 *
 * O relógio entra por parâmetro para que o teste não precise esperar o tempo
 * passar de verdade para conferir uma duração de duas horas.
 */
export class HistoricoDaCall {
  #presentes = new Map(); // id da sessão -> { desde, exato }
  #saidas = new Map(); // usuario -> { apelido, tempo, exato, saiuEm }
  #agora;

  constructor(agora = () => Date.now()) {
    this.#agora = agora;
  }

  /** Zera tudo. Trocar de canal de voz é entrar em outra call. */
  comecar() {
    this.#presentes.clear();
    this.#saidas.clear();
  }

  /**
   * Alguém está na call. `exato` é falso quando a pessoa já estava aqui na
   * hora em que você chegou — o começo dela é desconhecido.
   */
  entrou(id, exato) {
    this.#presentes.set(id, { desde: this.#agora(), exato });
  }

  /**
   * Passa alguém para o histórico. Quem sai e volta soma na mesma linha: o
   * que interessa é "esta pessoa esteve aqui, por tanto tempo", e não a
   * contabilidade de cada ida e volta.
   *
   * Ignora quem nunca foi anunciado como presente — um `saiu-voz` de outro
   * canal, ou repetido, não pode inventar uma linha de zero segundo.
   */
  saiu(id, { usuario, apelido }) {
    const entrada = this.#presentes.get(id);
    if (!entrada) return;
    this.#presentes.delete(id);

    const chave = usuario ?? id;
    const antes = this.#saidas.get(chave);
    this.#saidas.set(chave, {
      apelido,
      tempo: (antes?.tempo ?? 0) + (this.#agora() - entrada.desde),
      // Basta uma passagem de começo desconhecido para o total deixar de ser
      // exato: somar um piso com um valor certo dá outro piso.
      exato: (antes?.exato ?? true) && entrada.exato,
      saiuEm: this.#agora(),
    });
  }

  /** Quem já saiu, do mais recente para o mais antigo — é de quem se lembra. */
  lista() {
    return [...this.#saidas.values()].sort((a, b) => b.saiuEm - a.saiuEm);
  }
}
