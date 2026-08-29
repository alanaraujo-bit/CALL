/**
 * A escada de mídia — a suíte que existe por causa de um apagão.
 *
 * No dia 20 de agosto de 2026 o plano do LiveKit acabou e o CALL parou de
 * abrir call nenhuma. Não foi o LiveKit que quebrou o produto: foi o CALL
 * não ter para onde ir quando o LiveKit disse não. O servidor continuava
 * emitindo tokens com confiança, cada cliente falhava sozinho, ninguém
 * contava a ninguém, e o resultado era um botão que não fazia nada.
 *
 * Estes testes sobem o binário de verdade com credenciais de LiveKit que
 * **apontam para o nada** — o que é, para o servidor, indistinguível de um
 * plano esgotado: ele assina o token, entrega, e o cliente não consegue
 * entrar. É a encenação exata do dia ruim.
 *
 * O que eles existem para provar, em ordem de importância:
 *
 *   1. **A call acontece assim mesmo.** Quem falha em entrar no SFU é
 *      desviado para o degrau seguinte, e no fim da escada está a malha
 *      P2P, que não depende de servidor de mídia nenhum.
 *   2. **A sala inteira desce junto.** Nunca metade no SFU e metade na
 *      malha — isso é uma sala em que as pessoas não se ouvem.
 *   3. **O servidor aprende.** Depois que o degrau cai, quem chegar depois
 *      já nasce na malha, sem repetir a falha de quem veio antes.
 *   4. **Ninguém derruba o SFU de fora.** Um relato de falha sobre um
 *      degrau em que a pessoa não está é ignorado.
 *
 *   node testes/midia.test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARIO = "target/release/sinalizacao.exe";
const PASTA = mkdtempSync(join(tmpdir(), "call-midia-"));
const DONO = "dona@exemplo.com";
const SENHA = "segredo-bom-1";
const porta = 8934;

let falhas = 0;
function conferir(condicao, descricao) {
  if (condicao) {
    console.log(`  ok   ${descricao}`);
  } else {
    falhas++;
    console.log(`  FALHA ${descricao}`);
  }
}

/* ─── Apoio ─────────────────────────────────────────────────────── */

/**
 * Sobe o servidor com uma escada de dois degraus de LiveKit.
 *
 * As URLs são `wss://` válidas que não levam a lugar nenhum. O servidor não
 * tem como saber disso — e é justamente esse o ponto: **ele nunca vê a
 * conexão de mídia**, ela acontece entre o navegador e o SFU. A única
 * maneira de ele descobrir que um degrau parou de atender é alguém contar.
 */
async function subirServidor(ambiente = {}) {
  const processo = spawn(BINARIO, [String(porta)], {
    stdio: "ignore",
    env: {
      ...process.env,
      DADOS: PASTA,
      ADMIN_EMAILS: DONO,
      LIVEKIT_URL: "wss://nuvem.invalido.exemplo",
      LIVEKIT_API_KEY: "chave-da-nuvem",
      LIVEKIT_API_SECRET: "segredo-da-nuvem-com-tamanho-suficiente",
      LIVEKIT_RESERVA_URL: "wss://proprio.invalido.exemplo",
      LIVEKIT_RESERVA_API_KEY: "chave-propria",
      LIVEKIT_RESERVA_API_SECRET: "segredo-proprio-com-tamanho-suficiente",
      ...ambiente,
    },
  });

  for (let tentativa = 0; tentativa < 60; tentativa++) {
    try {
      const sonda = new WebSocket(`ws://127.0.0.1:${porta}`);
      await new Promise((ok, falhou) => {
        sonda.addEventListener("open", ok, { once: true });
        sonda.addEventListener("error", falhou, { once: true });
      });
      sonda.close();
      return processo;
    } catch {
      await esperar(50);
    }
  }
  throw new Error("o servidor não abriu a porta");
}

async function cliente(saudacao) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}`);
  const recebidas = [];
  const ouvintes = [];
  const consumidas = new Set();

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    recebidas.push(msg);
    const ouvinte = ouvintes.find((o) => o.tipo === msg.tipo);
    if (ouvinte) {
      ouvintes.splice(ouvintes.indexOf(ouvinte), 1);
      consumidas.add(msg);
      ouvinte.resolver(msg);
    }
  });

  await new Promise((ok, falhou) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", falhou, { once: true });
  });

  const eu = {
    enviar: (o) => ws.send(JSON.stringify(o)),
    do: (tipo) => recebidas.filter((m) => m.tipo === tipo),
    fechar: () => ws.close(),

    aguardar(tipo, limite = 2500) {
      const pronta = recebidas.find((m) => m.tipo === tipo && !consumidas.has(m));
      if (pronta) {
        consumidas.add(pronta);
        return Promise.resolve(pronta);
      }
      return new Promise((resolver) => {
        const relogio = setTimeout(() => {
          const i = ouvintes.findIndex((o) => o.resolver === entregar);
          if (i >= 0) ouvintes.splice(i, 1);
          resolver(null);
        }, limite);
        const entregar = (msg) => {
          clearTimeout(relogio);
          resolver(msg);
        };
        ouvintes.push({ tipo, resolver: entregar });
      });
    },
  };

  if (saudacao) eu.enviar(saudacao);
  return eu;
}

async function cadastrar(email, apelido) {
  const c = await cliente(null);
  c.enviar({ tipo: "cadastrar", email, senha: SENHA, apelido, avatar: "coruja", plataforma: "windows" });
  const sessao = await c.aguardar("sessao", 6000);
  c.fechar();
  return sessao;
}

/** Todo cliente moderno aceita os dois transportes — é o que o aplicativo
 *  de verdade manda em `entrar-voz`. */
const TRANSPORTES = ["livekit", "malha"];

/* ─── Os testes ─────────────────────────────────────────────────── */

let servidor = await subirServidor();

try {
  const dona = await cadastrar(DONO, "Dona");
  const outra = await cadastrar("outra@exemplo.com", "Outra");

  const ana = await cliente({
    tipo: "criar-grupo",
    nome: "Time",
    apelido: "Ana",
    token: dona.token,
    plataforma: "windows",
  });
  const bemVindo = await ana.aguardar("bem-vindo", 6000);
  const grupo = bemVindo?.grupo;
  const canal = grupo?.categorias?.flatMap((c) => c.canais).find((c) => c.tipo === "voz");

  console.log("\nA escada começa no topo");

  ana.enviar({ tipo: "entrar-voz", canal: canal.id, transportes: TRANSPORTES });
  const primeira = await ana.aguardar("voz", 3000);
  conferir(primeira?.degrau === "nuvem", "a primeira call nasce no melhor degrau da escada");
  conferir(
    primeira?.midia?.url === "wss://nuvem.invalido.exemplo",
    "com a credencial do degrau de cima, e não de outro"
  );
  conferir(
    typeof primeira?.midia?.token === "string" && primeira.midia.token.length > 40,
    "e com um token assinado de verdade"
  );

  console.log("\nQuem não consegue entrar é desviado, e não largado");

  // Isto é o que o cliente faz quando `livekit.entrar()` lança — a mensagem
  // que não existia no dia do apagão, e sem a qual o servidor nunca
  // aprendia nada.
  ana.enviar({
    tipo: "midia-falhou",
    degrau: "nuvem",
    motivo: "could not establish signal connection",
  });
  const desviada = await ana.aguardar("voz-migrar", 3000);
  conferir(desviada !== null, "o servidor responde ao relato de falha, em vez de ignorá-lo");
  conferir(desviada?.degrau === "proprio", "e manda descer para o degrau seguinte da escada");
  conferir(
    desviada?.midia?.url === "wss://proprio.invalido.exemplo",
    "com a credencial do degrau novo — cada degrau assina com a própria chave"
  );

  console.log("\nO fim da escada é a malha, que não depende de ninguém");

  ana.enviar({ tipo: "midia-falhou", degrau: "proprio", motivo: "sem resposta" });
  const naMalha = await ana.aguardar("voz-migrar", 3000);
  conferir(naMalha?.degrau === "malha", "sem SFU que atenda, a call cai na malha P2P");
  conferir(!naMalha?.midia, "e sem credencial nenhuma junto: a malha não precisa de token");

  console.log("\nA sala inteira desce junto");

  // Uma segunda pessoa entra na sala já degradada. Se ela entrasse no SFU
  // enquanto a Ana está na malha, as duas se veriam na lista sem se ouvir —
  // que é o pior defeito possível numa call.
  const bia = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Bia",
    token: outra.token,
    plataforma: "windows",
  });
  await bia.aguardar("bem-vindo", 6000);
  bia.enviar({ tipo: "entrar-voz", canal: canal.id, transportes: TRANSPORTES });
  const dela = await bia.aguardar("voz", 3000);
  conferir(dela?.degrau === "malha", "quem chega depois entra pelo mesmo caminho da sala");
  conferir(!dela?.midia, "sem credencial de SFU, como o resto da sala");

  console.log("\nNinguém derruba o SFU de fora");

  // O disjuntor exige mais de uma falha na janela justamente para que um
  // cliente sozinho com rede ruim não tire o SFU do ar para todo mundo. As
  // guardas abaixo são a outra metade da mesma proteção.
  const carla = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Carla",
    token: outra.token,
    plataforma: "windows",
  });
  await carla.aguardar("bem-vindo", 6000);

  carla.enviar({ tipo: "midia-falhou", degrau: "nuvem", motivo: "não estou nem na voz" });
  await esperar(250);
  conferir(
    carla.do("voz-migrar").length === 0,
    "quem não está na voz não relata falha de degrau nenhum"
  );

  bia.enviar({ tipo: "midia-falhou", degrau: "nuvem", motivo: "estou na malha, não na nuvem" });
  await esperar(250);
  conferir(
    bia.do("voz-migrar").length === 0,
    "e quem está noutro degrau não fala pelo degrau em que não está"
  );

  bia.enviar({ tipo: "midia-falhou", degrau: "malha", motivo: "não deveria contar" });
  await esperar(250);
  conferir(
    bia.do("voz-migrar").length === 0,
    "um relato sobre a malha é ignorado: ela não é um degrau que possa cair"
  );

  console.log("\nO disjuntor derruba o degrau, e a sala inteira desce junto");

  // Uma sala nova, para nascer no topo da escada de novo. É aqui que a
  // segunda falha da janela acontece — e uma segunda falha não desvia só
  // quem falhou: ela tira o degrau da escada, e todo mundo que estava nele
  // precisa descer antes de descobrir sozinho, um a um, que a porta fechou.
  ana.enviar({
    tipo: "criar-canal",
    categoria: grupo.categorias[0].id,
    nome: "Sala 2",
    tipoCanal: "voz",
  });
  await esperar(400);
  const estrutura = await (async () => {
    const atualizacoes = ana.do("grupo");
    return atualizacoes[atualizacoes.length - 1]?.grupo ?? grupo;
  })();
  const sala2 = estrutura.categorias
    ?.flatMap((c) => c.canais)
    .find((c) => c.nome === "Sala 2");
  conferir(!!sala2, "o canal de voz novo foi criado");

  carla.enviar({ tipo: "entrar-voz", canal: sala2.id, transportes: TRANSPORTES });
  const carlaNaSala = await carla.aguardar("voz", 3000);
  conferir(carlaNaSala?.degrau === "nuvem", "a sala nova nasce no topo da escada, como deve");

  const dina0 = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Dina",
    token: outra.token,
    plataforma: "windows",
  });
  await dina0.aguardar("bem-vindo", 6000);
  dina0.enviar({ tipo: "entrar-voz", canal: sala2.id, transportes: TRANSPORTES });
  conferir(
    (await dina0.aguardar("voz", 3000))?.degrau === "nuvem",
    "e a segunda pessoa entra no mesmo degrau da sala"
  );

  // A segunda falha da nuvem dentro da janela: é esta que derruba o degrau.
  carla.enviar({ tipo: "midia-falhou", degrau: "nuvem", motivo: "recusado de novo" });
  const carlaDesceu = await carla.aguardar("voz-migrar", 3000);
  const dinaDesceu = await dina0.aguardar("voz-migrar", 3000);
  conferir(carlaDesceu?.degrau === "proprio", "quem relatou desce para o degrau seguinte");
  conferir(
    dinaDesceu?.degrau === "proprio",
    "e quem nem percebeu o problema desce junto, sem precisar falhar também"
  );
  conferir(
    dinaDesceu?.midia?.url === "wss://proprio.invalido.exemplo",
    "cada uma com a própria credencial do degrau novo"
  );

  const tardia = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Tardia",
    token: outra.token,
    plataforma: "windows",
  });
  await tardia.aguardar("bem-vindo", 6000);
  tardia.enviar({ tipo: "entrar-voz", canal: sala2.id, transportes: TRANSPORTES });
  conferir(
    (await tardia.aguardar("voz", 3000))?.degrau === "proprio",
    "e quem chega depois já nasce no degrau novo — o servidor aprendeu"
  );
  tardia.fechar();
  dina0.fechar();
  // Três gigabytes: um número grande de propósito, para o teste conseguir
  // ver a banda sobreviver a um reinício sem depender de arredondamento.
  carla.enviar({ tipo: "sair-voz", bytes: 3_000_000_000 });
  await esperar(300);

  console.log("\nO painel conta a história");

  const painel = await cliente(null);
  painel.enviar({ tipo: "admin-painel", token: dona.token, fuso: new Date().getTimezoneOffset() });
  const retrato = (await painel.aguardar("admin-painel", 6000))?.painel;

  conferir(Array.isArray(retrato?.midia?.degraus), "o retrato traz a escada de mídia");
  conferir(retrato?.midia?.degraus?.length === 2, "com os dois degraus configurados no ambiente");
  conferir(
    retrato?.midia?.degraus?.[0]?.url === "nuvem.invalido.exemplo",
    "e o endereço mascarado, sem o esquema — o painel não é um mapa para bater no servidor"
  );
  const nuvem = retrato?.midia?.degraus?.find((d) => d.nome === "nuvem");
  conferir(nuvem?.quedas >= 1, "a queda do degrau aparece no retrato");
  conferir(nuvem?.atende === false, "e ele consta como fora do ar");
  conferir(
    typeof nuvem?.impedimento === "string" && nuvem.impedimento.length > 0,
    "dizendo por que, e por quanto tempo ainda"
  );
  conferir(
    retrato?.midia?.ativo === "proprio",
    "com o degrau seguinte assumindo como o que atende agora"
  );
  conferir(typeof retrato?.consumo?.totalMinutos === "number", "o consumo do ciclo vem junto");
  conferir(
    (retrato?.consumo?.totalFalhas ?? 0) >= 3,
    "e cada desvio ficou registrado — não só as quedas, mas cada pessoa desviada"
  );

  console.log("\nA chave do dono vale mais que qualquer degrau saudável");

  painel.enviar({ tipo: "admin-midia", token: dona.token, malhaForcada: true });
  const aviso = await painel.aguardar("admin-midia", 3000);
  conferir(aviso?.midia?.malhaForcada === true, "a chave é aceita e volta confirmada");
  conferir(aviso?.midia?.ativo === "malha", "e a escada inteira passa a responder malha");

  const dina = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Dina",
    token: outra.token,
    plataforma: "windows",
  });
  await dina.aguardar("bem-vindo", 6000);
  dina.enviar({ tipo: "entrar-voz", canal: canal.id, transportes: TRANSPORTES });
  conferir(
    (await dina.aguardar("voz", 3000))?.degrau === "malha",
    "com a chave virada, nenhuma call nova toca num SFU"
  );

  painel.enviar({ tipo: "admin-midia", token: dona.token, malhaForcada: false });
  await painel.aguardar("admin-midia", 3000);

  console.log("\nUma conta comum não mexe na infraestrutura");

  const intruso = await cliente(null);
  intruso.enviar({ tipo: "admin-midia", token: outra.token, malhaForcada: true });
  conferir(
    (await intruso.aguardar("admin-negado", 3000))?.motivo?.length > 0,
    "virar a chave da mídia pede a mesma prova que abrir o painel"
  );
  intruso.fechar();

  console.log("\nO consumo é medido, e não estimado");

  const eva = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Eva",
    token: outra.token,
    plataforma: "windows",
  });
  await eva.aguardar("bem-vindo", 6000);
  eva.enviar({ tipo: "entrar-voz", canal: canal.id, transportes: TRANSPORTES });
  await eva.aguardar("voz", 3000);
  await esperar(1200);
  // O cliente diz quantos bytes recebeu do SFU — o servidor de sinalização
  // não vê um byte de mídia passar, então este número só pode vir de lá.
  eva.enviar({ tipo: "sair-voz", bytes: 12_345_678 });
  await esperar(400);

  painel.enviar({ tipo: "admin-painel", token: dona.token, fuso: new Date().getTimezoneOffset() });
  const depois = (await painel.aguardar("admin-painel", 6000))?.painel;
  const passagem = (depois?.ultimos ?? []).find((e) => e.tipo === "voz-saiu" && e.valor >= 1);
  conferir(!!passagem, "a passagem pela call vira acontecimento com duração medida");
  conferir(
    passagem?.meio === "malha",
    "e anotada com o caminho por onde passou, e não com um caminho presumido"
  );

  ana.fechar();
  bia.fechar();
  carla.fechar();
  dina.fechar();
  eva.fechar();
  painel.fechar();
  await esperar(300);

  console.log("\nO consumo do ciclo sobrevive a um redeploy");

  // O contador que decide emitir ou não um token vive na memória do
  // processo — e a memória de um processo termina no próximo deploy, que
  // numa hospedagem gerenciada acontece toda semana. Se ele não fosse
  // relido do histórico na partida, o teto zeraria a cada publicação e
  // nunca chegaria a proteger fatura nenhuma.
  servidor.kill();
  await esperar(600);
  servidor = await subirServidor();

  const depoisDoReinicio = await cliente(null);
  depoisDoReinicio.enviar({
    tipo: "admin-painel",
    token: dona.token,
    fuso: new Date().getTimezoneOffset(),
  });
  const recomecado = (await depoisDoReinicio.aguardar("admin-painel", 6000))?.painel;
  const proprio = recomecado?.midia?.degraus?.find((d) => d.nome === "proprio");
  conferir(
    proprio?.gb >= 2.9,
    "os gigabytes gastos no ciclo voltam com o servidor, e não recomeçam do zero"
  );
  conferir(
    (recomecado?.consumo?.totalMinutos ?? -1) >= 0,
    "e o consumo do ciclo continua sendo contado a partir do histórico"
  );
  conferir(
    recomecado?.midia?.degraus?.find((d) => d.nome === "nuvem")?.atende === true,
    "já o disjuntor recomeça fechado: uma queda de dez minutos atrás não é motivo para nascer de castigo"
  );
  depoisDoReinicio.fechar();
  await esperar(200);

  console.log("\nSem LiveKit no ambiente, a escada tem um degrau só");

  servidor.kill();
  await esperar(500);
  servidor = await subirServidor({
    LIVEKIT_URL: "",
    LIVEKIT_API_KEY: "",
    LIVEKIT_API_SECRET: "",
    LIVEKIT_RESERVA_URL: "",
    LIVEKIT_RESERVA_API_KEY: "",
    LIVEKIT_RESERVA_API_SECRET: "",
  });

  const sozinha = await cliente({
    tipo: "entrar",
    codigo: grupo.codigo,
    apelido: "Ana",
    token: dona.token,
    plataforma: "windows",
  });
  await sozinha.aguardar("bem-vindo", 6000);
  sozinha.enviar({ tipo: "entrar-voz", canal: canal.id, transportes: TRANSPORTES });
  const semSfu = await sozinha.aguardar("voz", 3000);
  conferir(semSfu?.degrau === "malha", "um servidor sem credencial de mídia manda a call para a malha");
  conferir(!semSfu?.midia, "e não promete uma credencial que não tem");
  sozinha.fechar();
  await esperar(200);
} finally {
  servidor.kill();
  await esperar(200);
  rmSync(PASTA, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nTodos os testes passaram.\n" : `\n${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
