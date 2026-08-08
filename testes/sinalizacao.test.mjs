/**
 * Testes do servidor de sinalização.
 * Sobe o binário de verdade e exercita o protocolo com clientes reais — nada
 * de simulação: o que passa aqui é o que o aplicativo vai encontrar.
 *
 *   node testes/sinalizacao.test.mjs
 */

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARIO = "target/release/sinalizacao.exe";
const PASTA = mkdtempSync(join(tmpdir(), "call-testes-"));

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

let porta = 8899;

async function subirServidor() {
  porta++;
  const processo = spawn(BINARIO, [String(porta)], {
    stdio: "ignore",
    env: { ...process.env, DADOS: PASTA },
  });

  // Esperar a porta abrir, e não um tempo fixo: numa máquina ocupada o tempo
  // fixo é curto demais, e numa ociosa é tempo jogado fora.
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

/** Cliente de teste: guarda tudo que recebe e sabe esperar por um tipo. */
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
    ws,
    recebidas,
    enviar: (o) => ws.send(JSON.stringify(o)),
    do: (tipo) => recebidas.filter((m) => m.tipo === tipo),
    fechar: () => ws.close(),

    /**
     * Resolve com a próxima mensagem do tipo, ou `null` se ela não vier.
     *
     * Olha primeiro o que já chegou: o servidor costuma anunciar um fato a
     * vários clientes de uma vez, e esperar só pelo futuro faria o teste
     * perder o anúncio que chegou enquanto se esperava por outro.
     */
    aguardar(tipo, limite = 1500) {
      const pronta = recebidas.find((m) => m.tipo === tipo && !consumidas.has(m));
      if (pronta) {
        consumidas.add(pronta);
        return Promise.resolve(pronta);
      }

      return new Promise((resolver) => {
        const relogio = setTimeout(() => {
          const indice = ouvintes.findIndex((o) => o.resolver === entregar);
          if (indice >= 0) ouvintes.splice(indice, 1);
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

/**
 * Espera a mensagem do tipo que satisfaça o teste, e não a próxima da fila.
 *
 * `aguardar` entrega a primeira ainda não consumida, o que é o certo para
 * "aconteceu?" e o errado para "aconteceu com esta pessoa?": anúncios de
 * entrada e saída de seções anteriores ficam na fila sem que nenhum teste
 * precise deles, e seriam colhidos no lugar do esperado.
 */
async function aguardarQual(quem, tipo, teste, limite = 1500) {
  const ateQuando = Date.now() + limite;
  while (Date.now() < ateQuando) {
    const achada = quem.do(tipo).find(teste);
    if (achada) return achada;
    await esperar(25);
  }
  return null;
}

/**
 * Faz o aperto de mao na mao, com o cabecalho do tamanho que um navegador
 * produz. O `WebSocket` do Node manda um pedido curto, e foi por isso que o
 * servidor pode passar tanto tempo decidindo pela janela errada: com o
 * `Upgrade` empurrado para depois dos primeiros bytes, ele respondia como se
 * fosse um GET comum. Devolve a primeira linha da resposta.
 */
function apertoDeMaoLongo(recheio) {
  return new Promise((resolver, rejeitar) => {
    const soquete = connect(porta, "127.0.0.1");
    let resposta = "";

    soquete.on("connect", () => {
      // A ordem imita a de um navegador: o Upgrade vem depois do User-Agent.
      soquete.write(
        "GET / HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${porta}\r\n` +
          "Connection: Upgrade\r\n" +
          "Pragma: no-cache\r\n" +
          "Cache-Control: no-cache\r\n" +
          `User-Agent: ${recheio}\r\n` +
          `X-Forwarded-For: 203.0.113.7\r\n` +
          "X-Forwarded-Proto: https\r\n" +
          "Upgrade: websocket\r\n" +
          "Origin: http://tauri.localhost\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Accept-Encoding: gzip, deflate, br\r\n" +
          "Accept-Language: pt-BR,pt;q=0.9\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Extensions: permessage-deflate\r\n" +
          "\r\n"
      );
    });

    soquete.on("data", (pedaco) => {
      resposta += pedaco.toString();
      if (resposta.includes("\r\n")) {
        soquete.destroy();
        resolver(resposta.split("\r\n")[0]);
      }
    });
    soquete.on("error", rejeitar);
    soquete.setTimeout(4000, () => {
      soquete.destroy();
      resolver("SEM RESPOSTA");
    });
  });
}

const canalPorTipo = (grupo, tipo) =>
  grupo.categorias.flatMap((c) => c.canais).find((c) => c.tipo === tipo);

/* ─── Bateria ───────────────────────────────────────────────────── */

let servidor = await subirServidor();
let codigo;
let canalTexto;
let canalVoz;
let somPersistenteId;

try {
  console.log("\nAperto de mão de navegador, atrás de proxy");
  const curto = await apertoDeMaoLongo("Node");
  conferir(curto.startsWith("HTTP/1.1 101"), `cabeçalho curto sobe para WebSocket (${curto})`);

  // Um Chromium real manda perto de 1 KB de cabeçalho; com os `X-Forwarded-*`
  // de um proxy de hospedagem, passa disso.
  const longo = await apertoDeMaoLongo("M".repeat(900));
  conferir(
    longo.startsWith("HTTP/1.1 101"),
    `cabeçalho de 1 KB também sobe para WebSocket (${longo})`
  );

  console.log("\nHealth check continua sendo HTTP");
  const semUpgrade = await new Promise((resolver) => {
    const s = connect(porta, "127.0.0.1");
    let r = "";
    s.on("connect", () => s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
    s.on("data", (p) => {
      r += p.toString();
      if (r.includes("\r\n")) {
        s.destroy();
        resolver(r.split("\r\n")[0]);
      }
    });
    s.setTimeout(4000, () => {
      s.destroy();
      resolver("SEM RESPOSTA");
    });
  });
  conferir(semUpgrade.startsWith("HTTP/1.1 200"), `GET comum recebe 200 (${semUpgrade})`);

  console.log("\nCriação de grupo");
  const ana = await cliente({
    tipo: "criar-grupo",
    nome: "Equipe de produto",
    apelido: "Ana",
    usuario: "ana-001",
  });
  const bemVindoAna = await ana.aguardar("bem-vindo");

  conferir(!!bemVindoAna, "quem cria recebe bem-vindo");
  conferir(bemVindoAna?.grupo?.nome === "Equipe de produto", "o nome do grupo volta como veio");
  conferir(bemVindoAna?.grupo?.codigo?.length === 10, "o convite tem dez caracteres");
  conferir(
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(bemVindoAna?.grupo?.codigo ?? ""),
    "o convite evita caracteres que se confundem"
  );
  conferir(bemVindoAna?.grupo?.dono === "ana-001", "quem cria fica registrado como dono");
  conferir(bemVindoAna?.presentes?.length === 0, "grupo novo chega vazio");

  const grupo = bemVindoAna.grupo;
  codigo = grupo.codigo;
  canalTexto = canalPorTipo(grupo, "texto");
  canalVoz = canalPorTipo(grupo, "voz");
  conferir(!!canalTexto && !!canalVoz, "grupo novo já vem com um canal de cada tipo");

  console.log("\nEntrada por convite");
  const bruno = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Bruno",
    usuario: "bruno-002",
  });
  const bemVindoBruno = await bruno.aguardar("bem-vindo");
  conferir(bemVindoBruno?.presentes?.length === 1, "quem entra vê quem já estava");
  conferir(bemVindoBruno?.presentes?.[0]?.apelido === "Ana", "o apelido do presente vem correto");
  conferir(
    bemVindoBruno?.grupo?.codigo === codigo,
    "quem entra recebe a mesma estrutura de grupo"
  );
  conferir((await ana.aguardar("entrou"))?.membro?.apelido === "Bruno", "a entrada é anunciada");

  const intruso = await cliente({
    tipo: "entrar",
    codigo: "ZZZZZZZZZZ",
    apelido: "Ninguém",
    usuario: "zzz-003",
  });
  conferir(!!(await intruso.aguardar("erro")), "convite inexistente é recusado");
  conferir((await intruso.aguardar("bem-vindo", 300)) === null, "e não admite ninguém");
  intruso.fechar();

  console.log("\nVoz por canal");
  ana.enviar({ tipo: "entrar-voz", canal: canalVoz.id });
  const vozAna = await ana.aguardar("voz");
  conferir(vozAna?.pares?.length === 0, "primeiro a entrar na voz encontra a sala vazia");

  bruno.enviar({ tipo: "entrar-voz", canal: canalVoz.id });
  const vozBruno = await bruno.aguardar("voz");
  conferir(vozBruno?.pares?.length === 1, "segundo a entrar recebe a lista de pares");
  const entrouVoz = await ana.aguardar("entrou-voz");
  conferir(entrouVoz?.membro?.apelido === "Bruno", "a entrada na voz é anunciada ao grupo");
  conferir(entrouVoz?.membro?.canalVoz === canalVoz.id, "o anúncio diz em qual canal");

  const idBruno = bemVindoBruno.eu.id;
  const idAna = bemVindoAna.eu.id;

  console.log("\nEncaminhamento de sinais");
  ana.enviar({ tipo: "sinal", para: idBruno, dados: { descricao: "oferta" } });
  const sinal = await bruno.aguardar("sinal");
  conferir(sinal?.dados?.descricao === "oferta", "o sinal chega ao destinatário");
  conferir(sinal?.de === idAna, "o sinal identifica o remetente");

  console.log("\nEstado de microfone e transmissão");
  bruno.enviar({ tipo: "estado", mudo: true, transmitindo: true });
  const estado = await ana.aguardar("estado");
  conferir(estado?.mudo === true && estado?.transmitindo === true, "o estado é propagado");
  conferir((await bruno.aguardar("estado", 300)) === null, "quem mudou não recebe o próprio eco");

  console.log("\nSoundboard");
  ana.enviar({
    tipo: "adicionar-som",
    nome: "Buzina",
    mime: "audio/mpeg",
    dados: Buffer.from("um clipe pequeno de mentira").toString("base64"),
  });
  const somAdicionado = await bruno.aguardar("som-adicionado");
  conferir(somAdicionado?.som?.nome === "Buzina", "o som adicionado é anunciado ao grupo");
  conferir(somAdicionado?.som?.dono === "ana-001", "com quem enviou");
  const idBuzina = somAdicionado.som.id;

  ana.enviar({ tipo: "pedir-som", id: idBuzina });
  const bytesDoSom = await ana.aguardar("som");
  conferir(
    Buffer.from(bytesDoSom?.dados ?? "", "base64").toString() === "um clipe pequeno de mentira",
    "os bytes pedidos batem com os enviados"
  );

  ana.enviar({
    tipo: "adicionar-som",
    nome: "Grande demais",
    mime: "audio/mpeg",
    dados: Buffer.alloc(300 * 1024 + 1).toString("base64"),
  });
  conferir(!!(await ana.aguardar("erro")), "um som acima de 300 KB é recusado");

  bruno.enviar({ tipo: "remover-som", id: idBuzina });
  conferir(
    !!(await bruno.aguardar("erro")),
    "só quem enviou o som, ou o dono do grupo, pode removê-lo"
  );

  ana.enviar({ tipo: "remover-som", id: idBuzina });
  const somRemovido = await bruno.aguardar("som-removido");
  conferir(somRemovido?.id === idBuzina, "a remoção é anunciada ao grupo");

  // `som-tocado` é só o aviso — "fulano tocou este som" — para quem está na
  // mesma voz. O áudio em si nunca passa pelo servidor: quem toca decodifica
  // e mistura no próprio envio WebRTC.
  ana.enviar({
    tipo: "adicionar-som",
    nome: "Buzina 2",
    mime: "audio/mpeg",
    dados: Buffer.from("outro clipe").toString("base64"),
  });
  const som2 = (await bruno.aguardar("som-adicionado"))?.som;
  somPersistenteId = som2?.id;

  ana.enviar({ tipo: "som-tocado", id: som2.id });
  const tocado = await bruno.aguardar("som-tocado");
  conferir(
    tocado?.id === som2.id && tocado?.canal === canalVoz.id,
    "o aviso de quem tocou diz o som e o canal"
  );
  conferir(
    (await ana.aguardar("som-tocado", 300)) === null,
    "quem tocou não recebe o próprio eco"
  );

  console.log("\nIsolamento entre canais de voz");
  bruno.enviar({ tipo: "sair-voz" });
  conferir(!!(await ana.aguardar("saiu-voz")), "a saída da voz é anunciada");
  ana.enviar({ tipo: "sinal", para: idBruno, dados: { descricao: "vazamento" } });
  conferir(
    (await bruno.aguardar("sinal", 400)) === null,
    "sinal para quem não está na mesma voz é descartado"
  );

  console.log("\nMensagens de texto");
  bruno.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "  bom dia  " });
  const paraAna = await ana.aguardar("mensagem");
  const paraBruno = await bruno.aguardar("mensagem");
  conferir(paraAna?.mensagem?.texto === "bom dia", "a mensagem chega aos outros, sem sobras");
  conferir(paraBruno?.mensagem?.id === paraAna?.mensagem?.id, "e volta para quem escreveu");
  conferir(paraAna?.mensagem?.autor === "bruno-002", "a autoria acompanha a mensagem");
  conferir(typeof paraAna?.mensagem?.em === "number", "a mensagem carrega o instante");

  bruno.enviar({ tipo: "mensagem", canal: canalVoz.id, texto: "aqui não" });
  conferir(!!(await bruno.aguardar("erro")), "canal de voz não aceita mensagem de texto");

  bruno.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "   " });
  conferir(
    (await ana.aguardar("mensagem", 400)) === null,
    "mensagem só de espaços não é difundida"
  );

  console.log("\nHistórico");
  const carla = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Carla",
    usuario: "carla-004",
  });
  await carla.aguardar("bem-vindo");
  carla.enviar({ tipo: "historico", canal: canalTexto.id });
  const historico = await carla.aguardar("historico");
  conferir(historico?.mensagens?.length === 1, "quem chega depois recebe o que já foi dito");
  conferir(historico?.mensagens?.[0]?.texto === "bom dia", "o histórico vem íntegro");

  console.log("\nEstrutura: só o dono altera");
  carla.enviar({ tipo: "criar-categoria", nome: "Invasão" });
  conferir(!!(await carla.aguardar("erro")), "quem não é dono não cria categoria");
  conferir(
    (await ana.aguardar("grupo", 400)) === null,
    "e a tentativa não difunde estrutura nenhuma"
  );

  ana.enviar({ tipo: "criar-categoria", nome: "Projetos" });
  const comCategoria = await bruno.aguardar("grupo");
  conferir(comCategoria?.grupo?.categorias?.length === 2, "o dono cria categoria");
  const projetos = comCategoria.grupo.categorias.find((c) => c.nome === "Projetos");

  ana.enviar({
    tipo: "criar-canal",
    categoria: projetos.id,
    nome: "lançamento",
    tipoCanal: "voz",
  });
  const comCanal = await bruno.aguardar("grupo");
  const novoCanal = comCanal.grupo.categorias
    .find((c) => c.id === projetos.id)
    ?.canais?.find((c) => c.nome === "lançamento");
  conferir(novoCanal?.tipo === "voz", "o dono cria canal do tipo pedido");

  ana.enviar({ tipo: "renomear", alvo: "canal", id: novoCanal.id, nome: "estreia" });
  const renomeado = await bruno.aguardar("grupo");
  conferir(
    renomeado?.grupo?.categorias
      ?.flatMap((c) => c.canais)
      ?.some((c) => c.id === novoCanal.id && c.nome === "estreia"),
    "renomear canal difunde a estrutura nova"
  );

  console.log("\nRemoção tira quem estava na voz do canal");
  carla.enviar({ tipo: "entrar-voz", canal: novoCanal.id });
  await carla.aguardar("voz");
  ana.enviar({ tipo: "remover", alvo: "canal", id: novoCanal.id });
  const semCanal = await bruno.aguardar("grupo");
  conferir(
    !semCanal.grupo.categorias.flatMap((c) => c.canais).some((c) => c.id === novoCanal.id),
    "o canal removido some da estrutura"
  );
  conferir(
    !!(await bruno.aguardar("saiu-voz")),
    "quem estava na voz do canal removido é retirado dela"
  );

  console.log("\nO grupo não fica sem chão");
  ana.enviar({ tipo: "remover", alvo: "categoria", id: projetos.id });
  await bruno.aguardar("grupo");
  ana.enviar({ tipo: "remover", alvo: "categoria", id: grupo.categorias[0].id });
  conferir(!!(await ana.aguardar("erro")), "a última categoria não pode ser removida");
  ana.enviar({ tipo: "remover", alvo: "canal", id: canalVoz.id });
  await bruno.aguardar("grupo");
  ana.enviar({ tipo: "remover", alvo: "canal", id: canalTexto.id });
  conferir(!!(await ana.aguardar("erro")), "o último canal não pode ser removido");

  // O servidor não interpreta a atividade: ele repassa e esquece. O que se
  // exige dele é o teto de tamanho — o texto vem de um cliente e vai para a
  // tela de todo mundo — e que ausência e vazio signifiquem a mesma coisa.
  console.log("\nAtividade em primeiro plano");
  bruno.enviar({ tipo: "estado", mudo: false, transmitindo: false, atividade: "Rocket League" });
  const anunciada = await ana.aguardar("estado");
  conferir(anunciada?.atividade === "Rocket League", "a atividade chega a quem está no grupo");
  conferir(anunciada?.de === idBruno, "e vem identificada por quem a anunciou");

  // Quem chega depois precisa ver o que já está acontecendo; sem isto, só se
  // descobriria o que alguém está usando quando essa pessoa trocasse.
  const davi = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Davi",
    usuario: "davi-005",
  });
  const bemVindoDavi = await davi.aguardar("bem-vindo");
  conferir(
    bemVindoDavi?.presentes?.some((p) => p.atividade === "Rocket League"),
    "quem entra depois já vê o que os outros estão usando"
  );

  bruno.enviar({ tipo: "estado", mudo: false, transmitindo: false, atividade: "N".repeat(200) });
  const cortada = await ana.aguardar("estado");
  conferir(
    cortada?.atividade?.length === 40,
    `um cliente adulterado não empurra um romance para a lista (${cortada?.atividade?.length})`
  );

  bruno.enviar({ tipo: "estado", mudo: false, transmitindo: false, atividade: "   " });
  conferir(
    (await ana.aguardar("estado"))?.atividade === null,
    "texto em branco é o mesmo que não mostrar nada"
  );

  bruno.enviar({ tipo: "estado", mudo: false, transmitindo: false });
  conferir(
    (await ana.aguardar("estado"))?.atividade === null,
    "não mandar o campo desliga a atividade"
  );
  // Consumir a saída do Davi aqui, e não deixá-la para trás: `aguardar` olha
  // primeiro o que já chegou, e um `saiu` pendente seria colhido pelo teste
  // da seção seguinte no lugar do que ele espera.
  davi.fechar();
  conferir((await ana.aguardar("saiu"))?.id === bemVindoDavi.eu.id, "e a saída dele é anunciada");

  // O perfil viaja com a pessoa e não é guardado: o servidor o recorta, o
  // repassa e esquece. O que se exige dele é que a troca no meio da sessão
  // chegue aos outros, que os tetos valham, e — o mais importante — que trocar
  // de perfil não seja um jeito de trocar de identidade.
  console.log("\nPerfil: mascote e bio");
  const elis = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Elis",
    usuario: "elis-006",
    avatar: "capivara",
    bio: "Fuso de Brasília. Jogo à noite.",
  });
  const bemVindoElis = await elis.aguardar("bem-vindo");
  conferir(bemVindoElis?.eu?.avatar === "capivara", "o mascote da saudação volta no bem-vindo");
  conferir(bemVindoElis?.eu?.bio?.startsWith("Fuso"), "a bio da saudação também");

  const chegada = await aguardarQual(ana, "entrou", (m) => m.membro?.id === bemVindoElis.eu.id);
  conferir(chegada?.membro?.avatar === "capivara", "o grupo vê o mascote de quem chega");
  conferir(chegada?.membro?.bio?.startsWith("Fuso"), "e a bio junto");

  elis.enviar({ tipo: "perfil", apelido: "Elis R.", avatar: "dragao", bio: "Mudei de ideia." });
  const trocado = await ana.aguardar("perfil");
  conferir(trocado?.de === bemVindoElis.eu.id, "a troca de perfil identifica quem trocou");
  conferir(
    trocado?.apelido === "Elis R." && trocado?.avatar === "dragao",
    "apelido e mascote novos chegam ao grupo"
  );
  conferir(trocado?.bio === "Mudei de ideia.", "e a bio nova");
  conferir((await elis.aguardar("perfil", 300)) === null, "quem trocou não recebe o próprio eco");

  const fabio = await cliente({ tipo: "entrar", codigo, apelido: "Fábio", usuario: "fabio-007" });
  const bemVindoFabio = await fabio.aguardar("bem-vindo");
  conferir(
    bemVindoFabio?.presentes?.find((p) => p.usuario === "elis-006")?.avatar === "dragao",
    "quem entra depois vê o perfil trocado, e não o da saudação"
  );

  elis.enviar({ tipo: "perfil", apelido: "Elis", avatar: "<img src=x>coruja", bio: "B".repeat(400) });
  const recortado = await ana.aguardar("perfil");
  conferir(
    /^[a-z0-9-]*$/.test(recortado?.avatar ?? "!"),
    `o identificador do mascote sai só com minúsculas, dígitos e hífen (${recortado?.avatar})`
  );
  conferir(
    [...(recortado?.bio ?? "")].length === 160,
    `a bio é cortada no teto (${[...(recortado?.bio ?? "")].length})`
  );

  // Um cliente adulterado pode mandar `usuario` na troca de perfil. Se o
  // servidor o aceitasse, bastaria isso para escrever como outra pessoa — e
  // para se apresentar como dono do grupo.
  elis.enviar({ tipo: "perfil", apelido: "Elis", avatar: "coruja", bio: "", usuario: "ana-001" });
  await ana.aguardar("perfil");
  elis.enviar({ tipo: "mensagem", canal: canalTexto.id, texto: "quem sou eu" });
  const autoria = await ana.aguardar("mensagem");
  conferir(autoria?.mensagem?.autor === "elis-006", "trocar de perfil não troca de identidade");
  conferir(autoria?.mensagem?.avatar === "coruja", "a mensagem carrega o mascote de quem escreveu");

  fabio.fechar();
  conferir((await ana.aguardar("saiu"))?.id === bemVindoFabio.eu.id, "a saída do Fábio é anunciada");
  elis.fechar();
  conferir((await ana.aguardar("saiu"))?.id === bemVindoElis.eu.id, "e a da Elis também");

  console.log("\nSaída");
  bruno.fechar();
  conferir((await ana.aguardar("saiu"))?.id === idBruno, "a saída é anunciada aos demais");

  ana.fechar();
  carla.fechar();
  await esperar(200);

  /* ─── Contas ──────────────────────────────────────────────────── */

  console.log("\nContas");

  const balcao = await cliente(null);

  balcao.enviar({
    tipo: "cadastrar",
    email: "  Ana@Exemplo.COM ",
    senha: "segredo-bom-1",
    apelido: "Ana",
    avatar: "coruja",
    bio: "gosto de coruja",
  });
  const cadastro = await balcao.aguardar("sessao", 4000);
  conferir(!!cadastro?.token, "o cadastro devolve um token de sessão");
  conferir(cadastro?.conta?.email === "ana@exemplo.com", "o e-mail é normalizado em minúsculas");
  conferir(cadastro?.conta?.apelido === "Ana", "o perfil escolhido no cadastro fica guardado");
  conferir(cadastro?.conta?.avatar === "coruja", "com o mascote junto");
  conferir(cadastro?.conta?.id?.startsWith("conta-"), "a conta ganha um identificador próprio");
  conferir(
    cadastro?.conta?.senha === undefined && cadastro?.conta?.google === false,
    "a senha não volta para o cliente, nem em forma de hash"
  );

  balcao.enviar({ tipo: "cadastrar", email: "ana@exemplo.com", senha: "outra-senha-9", apelido: "Ana 2" });
  const repetido = await balcao.aguardar("recusa", 4000);
  conferir(repetido?.campo === "email", "o e-mail ocupado é recusado no campo do e-mail");

  balcao.enviar({ tipo: "cadastrar", email: "curta@exemplo.com", senha: "1234567", apelido: "Curta" });
  conferir((await balcao.aguardar("recusa"))?.campo === "senha", "senha de sete caracteres não passa");

  balcao.enviar({ tipo: "cadastrar", email: "sem-arroba", senha: "segredo-bom-1", apelido: "X" });
  conferir((await balcao.aguardar("recusa"))?.campo === "email", "e-mail sem forma de e-mail não passa");

  balcao.enviar({ tipo: "cadastrar", email: "sem-nome@exemplo.com", senha: "segredo-bom-1", apelido: "  " });
  conferir((await balcao.aguardar("recusa"))?.campo === "apelido", "cadastro sem apelido não passa");

  balcao.enviar({ tipo: "entrar-conta", email: "ana@exemplo.com", senha: "segredo-bom-1" });
  const login = await balcao.aguardar("sessao", 4000);
  conferir(!!login?.token, "a senha certa abre uma sessão");
  conferir(login?.token !== cadastro?.token, "cada entrada abre uma sessão nova");
  conferir(login?.conta?.id === cadastro?.conta?.id, "e é a mesma conta");

  balcao.enviar({ tipo: "entrar-conta", email: "ana@exemplo.com", senha: "senha-errada-1" });
  const errada = await balcao.aguardar("recusa", 4000);
  balcao.enviar({ tipo: "entrar-conta", email: "ninguem@exemplo.com", senha: "senha-errada-1" });
  const inexistente = await balcao.aguardar("recusa", 4000);
  conferir(errada?.campo === "senha", "a senha errada é recusada");
  conferir(
    errada?.motivo === inexistente?.motivo,
    "e-mail sem conta e senha errada dão a mesma resposta — o servidor não conta quem tem conta aqui"
  );

  balcao.enviar({ tipo: "retomar", token: login.token });
  conferir((await balcao.aguardar("sessao"))?.conta?.id === login.conta.id, "o token retoma a sessão");
  balcao.enviar({ tipo: "retomar", token: "token-inventado" });
  conferir(!!(await balcao.aguardar("sem-sessao")), "um token inventado não retoma nada");

  balcao.enviar({ tipo: "google-config" });
  const google = await balcao.aguardar("google");
  conferir(
    google?.disponivel === false,
    "sem as variáveis do Google, o servidor diz que o botão não existe"
  );

  balcao.enviar({
    tipo: "guardar",
    token: login.token,
    apelido: "Aninha",
    bio: "mudei de ideia",
    atalhos: [{ codigo: "XXXXXXXXXX", nome: "Grupo à mão" }, { codigo: "curto", nome: "lixo" }],
  });
  const guardada = await balcao.aguardar("conta");
  conferir(guardada?.conta?.apelido === "Aninha", "o perfil gravado na conta volta atualizado");
  conferir(
    guardada?.conta?.atalhos?.length === 1,
    "um código com forma errada não entra na lista de grupos da conta"
  );

  balcao.enviar({ tipo: "guardar", token: "token-inventado", apelido: "Invasora" });
  conferir(!!(await balcao.aguardar("sem-sessao")), "sem token válido não se grava nada");

  balcao.fechar();

  // Entrar num grupo com a conta: é aqui que o identificador do cliente
  // deixa de valer, e é isso que faz a autoria sobreviver a uma reinstalação.
  const comConta = await cliente({
    tipo: "entrar",
    codigo,
    token: login.token,
    usuario: "identidade-mentirosa",
    apelido: "Aninha",
    avatar: "coruja",
    bio: "mudei de ideia",
  });
  const bemVindaConta = await comConta.aguardar("bem-vindo", 4000);
  conferir(
    bemVindaConta?.eu?.usuario === login.conta.id,
    "com token, o `usuario` é o da conta e não o que o cliente disse ser"
  );
  conferir(!!bemVindaConta?.conta, "a saudação com token volta com a conta inteira");
  conferir(
    bemVindaConta?.conta?.atalhos?.some((a) => a.codigo === codigo),
    "e o grupo em que se acabou de entrar já está na lista dela"
  );

  // O prefixo `conta-` é reservado a quem provou o token. Sem esta recusa,
  // bastaria dizer-se `conta-XYZ` para assinar mensagens como outra pessoa.
  const impostor = await cliente({
    tipo: "entrar",
    codigo,
    usuario: login.conta.id,
    apelido: "Impostor",
  });
  const bemVindoImpostor = await impostor.aguardar("bem-vindo", 4000);
  conferir(
    bemVindoImpostor?.eu?.usuario !== login.conta.id,
    "dizer-se dono de uma conta sem token não faz de ninguém dono dela"
  );
  conferir(
    !bemVindoImpostor?.conta,
    "e quem se diz assim não recebe conta nenhuma de volta"
  );
  impostor.fechar();
  await esperar(150);

  comConta.enviar({ tipo: "perfil", token: login.token, apelido: "Ana de novo", avatar: "raposa", bio: "" });
  await esperar(150);
  comConta.fechar();
  await esperar(150);

  const conferindo = await cliente(null);
  conferindo.enviar({ tipo: "retomar", token: login.token });
  const depois = await conferindo.aguardar("sessao", 4000);
  conferir(
    depois?.conta?.apelido === "Ana de novo" && depois?.conta?.avatar === "raposa",
    "trocar de perfil dentro do grupo grava na conta"
  );

  conferindo.enviar({ tipo: "sair-conta", token: login.token });
  await conferindo.aguardar("sem-sessao");
  conferindo.enviar({ tipo: "retomar", token: login.token });
  conferir(
    !!(await conferindo.aguardar("sem-sessao")),
    "sair da conta derruba a sessão no servidor, e não só no computador"
  );
  conferindo.fechar();
  await esperar(200);
} finally {
  servidor.kill();
  await esperar(300);
}

/* ─── Persistência ──────────────────────────────────────────────── */

console.log("\nPersistência entre execuções");
conferir(existsSync(join(PASTA, "grupos.json")), "a estrutura é gravada em grupos.json");
conferir(existsSync(join(PASTA, "mensagens.jsonl")), "as mensagens vão para mensagens.jsonl");
conferir(
  !readFileSync(join(PASTA, "grupos.json"), "utf8").startsWith("﻿"),
  "o arquivo de grupos não sai com marca de ordem de bytes"
);
conferir(existsSync(join(PASTA, "contas.json")), "as contas vão para contas.json");
conferir(existsSync(join(PASTA, "sessoes.json")), "e as sessões para sessoes.json");
conferir(existsSync(join(PASTA, "sons.json")), "os metadados dos sons vão para sons.json");
conferir(
  existsSync(join(PASTA, "sons", "grupos", codigo, somPersistenteId)),
  "o clipe em si fica num arquivo próprio, fora do JSON de metadados"
);

const arquivoDeContas = readFileSync(join(PASTA, "contas.json"), "utf8");
conferir(
  !arquivoDeContas.includes("segredo-bom-1"),
  "a senha não aparece em claro no arquivo de contas"
);
conferir(
  arquivoDeContas.includes("$argon2id$"),
  "o que está lá é um hash Argon2id, e não a senha nem um resumo simples"
);
// O token tem 40 caracteres do alfabeto do convite; a marca gravada tem 64
// hexadecimais. Conferir a forma é o que prova que o arquivo não guarda o
// token — e não uma leitura otimista de que ele "não parece estar lá".
const sessoesGravadas = JSON.parse(readFileSync(join(PASTA, "sessoes.json"), "utf8"));
conferir(
  sessoesGravadas.length > 0 &&
    sessoesGravadas.every((s) => /^[0-9a-f]{64}$/.test(s.marca) && s.token === undefined),
  "as sessões guardam a impressão do token, e não o token"
);
conferir(
  sessoesGravadas.every((s) => s.expira > Date.now()),
  "e cada uma sabe quando vence"
);

servidor = await subirServidor();
try {
  const ana = await cliente({
    tipo: "entrar",
    codigo,
    apelido: "Ana",
    usuario: "ana-001",
  });
  const devolta = await ana.aguardar("bem-vindo");
  conferir(!!devolta, "o grupo sobrevive ao fechamento do servidor");
  conferir(devolta?.grupo?.nome === "Equipe de produto", "com o nome que tinha");
  conferir(devolta?.grupo?.dono === "ana-001", "e com o mesmo dono");
  conferir(
    devolta?.sons?.some((s) => s.id === somPersistenteId && s.nome === "Buzina 2"),
    "a biblioteca de sons do grupo sobrevive ao reinício"
  );

  ana.enviar({ tipo: "historico", canal: canalTexto.id });
  const historico = await ana.aguardar("historico");
  conferir(historico?.mensagens?.[0]?.texto === "bom dia", "o histórico também sobrevive");
  // A primeira mensagem foi gravada por uma versão do arquivo sem o campo do
  // mascote; a segunda, com ele. As duas precisam voltar — sem o `default` no
  // modelo, uma linha antiga derrubaria a leitura do histórico inteiro.
  conferir(
    historico?.mensagens?.some((m) => m.autor === "elis-006" && m.avatar === "coruja"),
    "o mascote de quem escreveu sobrevive ao reinício"
  );

  // A conta também atravessa o reinício — e é ela que carrega os grupos.
  const voltando = await cliente(null);
  voltando.enviar({ tipo: "entrar-conta", email: "ana@exemplo.com", senha: "segredo-bom-1" });
  const denovo = await voltando.aguardar("sessao", 4000);
  conferir(!!denovo?.token, "a conta sobrevive ao fechamento do servidor");
  conferir(denovo?.conta?.apelido === "Ana de novo", "com o perfil que tinha");
  conferir(
    denovo?.conta?.atalhos?.some((a) => a.codigo === codigo),
    "e com a lista de grupos, que é o que uma conta promete guardar"
  );

  voltando.enviar({ tipo: "entrar-conta", email: "ana@exemplo.com", senha: "senha-errada-1" });
  conferir(
    (await voltando.aguardar("recusa", 4000))?.campo === "senha",
    "e a senha errada continua sendo recusada depois do reinício"
  );
  voltando.fechar();

  ana.fechar();
  await esperar(200);
} finally {
  servidor.kill();
  await esperar(200);
  rmSync(PASTA, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nTodos os testes passaram.\n" : `\n${falhas} teste(s) falharam.\n`);
process.exit(falhas === 0 ? 0 : 1);
