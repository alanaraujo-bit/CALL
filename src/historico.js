/**
 * A Central de Novidades: o histórico completo de versões, navegável a
 * qualquer momento — não só quando há uma atualização esperando.
 *
 * Complementa (não substitui) o cartão "O que há de novo" de app.js: aquele
 * é o convite do momento (existe só enquanto uma versão nova está pronta
 * para instalar, e some depois); este é o registro permanente, igual a um
 * changelog público, aberto por uma pessoa que quer entender o que mudou —
 * hoje ou há três versões.
 *
 * Puro DOM, sem estado próprio: quem chama decide o que já foi visto (ver
 * `estado.ultimaVersaoNotasVista` em app.js) e quando abrir/fechar.
 */

/** Monta a lista de versões dentro do corpo do painel, mais recente primeiro
 * (a ordem em que `notas` já vem, então isso é responsabilidade de quem
 * escreve `notas-de-versao.js`, não daqui). */
export function montarHistorico(corpo, notas) {
  corpo.textContent = "";

  if (!notas.length) {
    const vazio = document.createElement("p");
    vazio.className = "historico__vazio";
    vazio.textContent = "Ainda não há notas de versão para mostrar.";
    corpo.append(vazio);
    return;
  }

  for (const entrada of notas) {
    corpo.append(montarEntrada(entrada));
  }
}

function montarEntrada(entrada) {
  const artigo = document.createElement("article");
  artigo.className = "historico__entrada";

  const cabecalho = document.createElement("header");
  cabecalho.className = "historico__entrada-topo";

  const versao = document.createElement("span");
  versao.className = "historico__versao";
  versao.textContent = `v${entrada.versao}`;
  cabecalho.append(versao);

  if (entrada.data) {
    const data = document.createElement("time");
    data.className = "historico__data";
    data.dateTime = entrada.data;
    data.textContent = formatarData(entrada.data);
    cabecalho.append(data);
  }
  artigo.append(cabecalho);

  const titulo = document.createElement("h3");
  titulo.className = "historico__titulo";
  titulo.textContent = entrada.titulo;
  artigo.append(titulo);

  if (entrada.resumo) {
    const resumo = document.createElement("p");
    resumo.className = "historico__resumo";
    resumo.textContent = entrada.resumo;
    artigo.append(resumo);
  }

  if (entrada.imagem?.src) {
    const figura = document.createElement("figure");
    figura.className = "historico__captura";
    const img = document.createElement("img");
    img.src = entrada.imagem.src;
    img.alt = entrada.imagem.alt ?? "";
    img.loading = "lazy";
    figura.append(img);
    artigo.append(figura);
  }

  for (const bloco of entrada.destaques ?? []) {
    const secao = document.createElement("h4");
    secao.className = `historico__secao historico__secao--${rotuloParaClasse(bloco.titulo)}`;
    secao.textContent = bloco.titulo;
    artigo.append(secao);

    const lista = document.createElement("ul");
    lista.className = "historico__lista";
    for (const item of bloco.itens) {
      const linha = document.createElement("li");
      linha.className = "historico__item";
      linha.textContent = item;
      lista.append(linha);
    }
    artigo.append(lista);
  }

  return artigo;
}

/** "Novo" → "novo", "Consertado" → "consertado" — vira modificador de classe
 * para cada bloco ganhar sua própria cor de destaque sem precisar de um mapa
 * fixo aqui (uma seção com título novo, ex. "Experimental", ainda funciona,
 * só cai no estilo neutro por não ter modificador correspondente no CSS). */
function rotuloParaClasse(titulo) {
  return String(titulo)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatarData(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
}
