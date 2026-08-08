/**
 * Conta: o que sobrevive a troca de computador.
 *
 * Este arquivo é o lado do cliente do que `servidor/src/contas.rs` guarda.
 * Ele faz três coisas e nenhuma delas é desenhar tela — a tela é o portal, no
 * `app.js`:
 *
 * 1. Conversa com o servidor em transações curtas: abre um socket, faz um
 *    pedido, recebe a resposta, fecha.
 * 2. Guarda o token no `localStorage`, separado das preferências.
 * 3. Mede a força de uma senha, para o medidor de cinco barras.
 *
 * ## Por que um socket só para isto
 *
 * A classe `Sinal` existe para viver dentro de um grupo: ela abre a conexão
 * *com a saudação junto*, porque o servidor recusa mais de um grupo por
 * conexão, e resolve no "bem-vindo". Entrar numa conta não é entrar num
 * grupo: acontece antes, pode falhar de um jeito que não é queda de conexão,
 * e não deixa nada aberto depois. Enfiar isso na `Sinal` seria dar dois
 * significados ao mesmo objeto.
 *
 * Cada transação custa um aperto de mão de WebSocket — alguns milissegundos,
 * numa ação que a pessoa faz uma vez por instalação.
 */

const CHAVE_SESSAO = "call.sessao";

/** Uma transação não pode ficar pendurada para sempre. Oito segundos é o
 *  mesmo teto que a entrada em grupo usa — e o cadastro tem um Argon2 do
 *  outro lado, que come dezenas de milissegundos por conta. */
const LIMITE_MS = 8000;

/** Erro que a interface sabe mostrar embaixo do campo certo. */
export class Recusa extends Error {
  constructor(motivo, campo = "") {
    super(motivo);
    this.campo = campo;
  }
}

/**
 * Uma ida e volta ao servidor.
 *
 * Resolve com a primeira mensagem cujo tipo esteja em `esperados`, e rejeita
 * com `Recusa` quando o servidor responde `recusa` — que é resposta, e não
 * falha de transporte.
 */
function transacao(endereco, pedido, esperados) {
  return new Promise((resolver, rejeitar) => {
    let ws;
    try {
      ws = new WebSocket(endereco);
    } catch {
      rejeitar(new Recusa("Endereço de servidor inválido."));
      return;
    }

    let pronta = false;
    const encerrar = (acao, valor) => {
      if (pronta) return;
      pronta = true;
      clearTimeout(relogio);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* já estava fechado */
      }
      acao(valor);
    };

    const relogio = setTimeout(
      () => encerrar(rejeitar, new Recusa("O servidor não respondeu a tempo.")),
      LIMITE_MS
    );

    ws.onopen = () => ws.send(JSON.stringify(pedido));

    ws.onmessage = (evento) => {
      let msg;
      try {
        msg = JSON.parse(evento.data);
      } catch {
        return;
      }
      if (esperados.includes(msg.tipo)) encerrar(resolver, msg);
      else if (msg.tipo === "recusa") {
        encerrar(rejeitar, new Recusa(msg.motivo, msg.campo));
      } else if (msg.tipo === "erro") encerrar(rejeitar, new Recusa(msg.motivo));
    };

    ws.onerror = () =>
      encerrar(rejeitar, new Recusa("Não foi possível falar com o servidor."));
    ws.onclose = () =>
      encerrar(rejeitar, new Recusa("A conexão foi fechada pelo servidor."));
  });
}

/* ═══ Sessão guardada aqui ══════════════════════════════════════ */

/**
 * O token vive fora de `call.preferencias` de propósito: sair da conta apaga
 * um item, e não precisa costurar remoção de campo dentro de um objeto que
 * guarda volume de microfone e perfil de transmissão.
 *
 * O endereço vai junto porque um token vale num servidor só — quem troca de
 * servidor nos ajustes não deve carregar uma sessão que não existe lá.
 */
export function sessaoGuardada() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_SESSAO) ?? "null");
    if (bruto && typeof bruto.token === "string" && bruto.token) return bruto;
  } catch {
    /* ilegível: é como não ter sessão */
  }
  return null;
}

export function guardarSessao(token, servidor) {
  localStorage.setItem(CHAVE_SESSAO, JSON.stringify({ token, servidor }));
}

export function esquecerSessao() {
  localStorage.removeItem(CHAVE_SESSAO);
}

/* ═══ Pedidos ═══════════════════════════════════════════════════ */

export const cadastrar = (servidor, dados) =>
  transacao(servidor, { tipo: "cadastrar", ...dados }, ["sessao"]);

export const entrar = (servidor, email, senha) =>
  transacao(servidor, { tipo: "entrar-conta", email, senha }, ["sessao"]);

/** Devolve a sessão, ou `null` quando o token venceu ou foi revogado. */
export async function retomar(servidor, token) {
  const resposta = await transacao(servidor, { tipo: "retomar", token }, [
    "sessao",
    "sem-sessao",
  ]);
  return resposta.tipo === "sessao" ? resposta : null;
}

export const sair = (servidor, token) =>
  transacao(servidor, { tipo: "sair-conta", token }, ["sem-sessao"]);

/** O que o servidor sabe oferecer de Google. Nunca rejeita por não ter: a
 *  resposta "não tem" é uma resposta, e o botão simplesmente não aparece. */
export async function configuracaoDoGoogle(servidor) {
  try {
    const { disponivel, clienteId } = await transacao(
      servidor,
      { tipo: "google-config" },
      ["google"]
    );
    return { disponivel: Boolean(disponivel) && Boolean(clienteId), clienteId };
  } catch {
    return { disponivel: false, clienteId: "" };
  }
}

export const entrarComGoogle = (servidor, passagem) =>
  transacao(servidor, { tipo: "google-entrar", ...passagem }, ["sessao"]);

/**
 * Grava perfil e lista de grupos na conta.
 *
 * Recebe um `enviar` opcional: dentro de um grupo já existe um socket aberto,
 * e abrir um segundo para dizer "mudei de mascote" seria desperdício. Fora
 * dele, a transação abre o seu.
 */
export async function guardar(servidor, token, campos, enviar = null) {
  if (!token) return null;
  const pedido = { tipo: "guardar", token, ...campos };

  if (enviar) {
    enviar(pedido);
    return null;
  }

  try {
    const resposta = await transacao(servidor, pedido, ["conta", "sem-sessao"]);
    return resposta.tipo === "conta" ? resposta.conta : null;
  } catch {
    // Perder a gravação de um mascote não pode virar erro na cara de
    // ninguém: a próxima entrada em grupo grava de novo, na saudação.
    return null;
  }
}

/* ═══ Biblioteca pessoal de sons ════════════════════════════════ */
//
// Presos à conta, e não a um grupo — ver a nota em `contas.rs`. Cada chamada
// abre a própria transação, do mesmo jeito que `guardar`: é uma ação rara
// (adicionar um som, trocar o som de entrada), não algo que precise de um
// socket já aberto.

export async function listarSonsPessoais(servidor, token) {
  if (!token) return [];
  try {
    const resposta = await transacao(servidor, { tipo: "listar-sons-pessoais", token }, [
      "sons-pessoais",
      "sem-sessao",
    ]);
    return resposta.tipo === "sons-pessoais" ? resposta.sons : [];
  } catch {
    return [];
  }
}

export const adicionarSomPessoal = (servidor, token, nome, mime, dados) =>
  transacao(servidor, { tipo: "adicionar-som-pessoal", token, nome, mime, dados }, [
    "som-pessoal-adicionado",
  ]);

export const removerSomPessoal = (servidor, token, id) =>
  transacao(servidor, { tipo: "remover-som-pessoal", token, id }, ["som-pessoal-removido"]);

export const pedirSomPessoal = (servidor, token, id) =>
  transacao(servidor, { tipo: "pedir-som-pessoal", token, id }, ["som"]);

/** `preferencia` é `{ origem: "grupo" | "pessoal", grupo, id }`, ou `null`
 *  para voltar ao sino sintetizado padrão. Devolve a conta atualizada. */
export async function escolherSomEntrada(servidor, token, preferencia) {
  const resposta = await transacao(
    servidor,
    { tipo: "escolher-som-entrada", token, preferencia },
    ["conta", "sem-sessao"]
  );
  return resposta.tipo === "conta" ? resposta.conta : null;
}

/* ═══ Força da senha ════════════════════════════════════════════ */

const RUINS = [
  "senha",
  "password",
  "123456",
  "12345678",
  "qwerty",
  "abc123",
  "111111",
  "iloveyou",
  "admin",
  "call",
];

/**
 * Nota de 0 a 5 para o medidor de cinco barras.
 *
 * Não é uma medida de entropia — é um empurrão honesto. Conta tamanho, que é
 * o que de fato importa, e variedade, que é o que as pessoas esperam ver
 * contando. E derruba para 1 o que está numa lista curta de senhas que
 * qualquer ataque tenta primeiro: uma senha dessas com dez caracteres não é
 * melhor que uma de quatro.
 */
export function forcaDaSenha(senha) {
  const texto = String(senha ?? "");
  const tamanho = [...texto].length;

  if (tamanho === 0) return { nivel: 0, texto: "A senha protege sua conta" };

  const achatada = texto.toLowerCase();
  if (RUINS.some((ruim) => achatada.includes(ruim))) {
    return { nivel: 1, texto: "Essa é das primeiras que qualquer ataque tenta" };
  }
  if (tamanho < 8) {
    return { nivel: 1, texto: `Faltam ${8 - tamanho} caractere(s)` };
  }

  // Repetição pura ("aaaaaaaa") tem oito caracteres e uma variedade só.
  const distintos = new Set(texto).size;

  let nota = 2;
  if (tamanho >= 12) nota++;
  if (tamanho >= 16) nota++;
  if (/[a-z]/.test(texto) && /[A-Z]/.test(texto)) nota++;
  if (/\d/.test(texto)) nota++;
  if (/[^\p{L}\d]/u.test(texto)) nota++;
  if (distintos < 5) nota = Math.min(nota, 2);

  const nivel = Math.max(1, Math.min(5, nota));
  const recados = {
    1: "Curta e repetitiva",
    2: "Serve, mas dá para melhorar",
    3: "Razoável",
    4: "Boa senha",
    5: "Excelente",
  };

  // Um conselho só, e o mais barato: comprimento vence variedade, e mandar
  // "acrescente um símbolo" a quem tem 20 caracteres seria conselho ruim.
  const conselho = nivel < 4 && tamanho < 12 ? " — senhas longas valem mais" : "";
  return { nivel, texto: recados[nivel] + conselho };
}

/** A forma de um e-mail, para o tique de confirmação do campo. O servidor é
 *  quem decide de verdade; isto é só para não prometer o que será recusado. */
export function pareceEmail(texto) {
  const limpo = String(texto ?? "").trim();
  if (!limpo || limpo.length > 160 || /\s/.test(limpo)) return false;
  const [usuario, dominio, ...sobra] = limpo.split("@");
  if (sobra.length || !usuario || !dominio) return false;
  const partes = dominio.split(".");
  return partes.length > 1 && partes.every((p) => p.length > 0);
}
