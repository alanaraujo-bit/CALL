/**
 * Renderização da lista "Meus envios" da Central de Feedback — puro DOM,
 * sem estado próprio, mesmo espírito de `historico.js`. O envio em si (o
 * formulário, o protocolo pelo socket `social`) fica em `app.js`, porque
 * depende de `estado`/`social` do mesmo jeito que amizade e DM já dependem.
 */

export const ROTULOS_CATEGORIA = {
  bug: "Bug",
  sugestao: "Sugestão",
  elogio: "Elogio",
};

export const ROTULOS_STATUS = {
  recebido: "Recebido",
  aceito: "Aceito",
  em_andamento: "Em andamento",
  finalizado: "Finalizado",
};

/** Monta a lista de feedbacks já enviados, mais recente primeiro — a ordem
 * em que o servidor já manda (ver `feedback_de` em `contas.rs`). */
export function montarListaDeFeedback(container, lista) {
  container.textContent = "";
  for (const item of lista) {
    container.append(montarItem(item));
  }
}

function montarItem(item) {
  const artigo = document.createElement("article");
  artigo.className = "feedback__item";

  const topo = document.createElement("header");
  topo.className = "feedback__item-topo";

  const categoria = document.createElement("span");
  categoria.className = `feedback__etiqueta-categoria feedback__etiqueta-categoria--${item.categoria}`;
  categoria.textContent = ROTULOS_CATEGORIA[item.categoria] ?? item.categoria;
  topo.append(categoria);

  const status = document.createElement("span");
  status.className = `feedback__etiqueta-status feedback__etiqueta-status--${item.status}`;
  status.textContent = ROTULOS_STATUS[item.status] ?? item.status;
  topo.append(status);

  artigo.append(topo);

  const titulo = document.createElement("h4");
  titulo.className = "feedback__item-titulo";
  titulo.textContent = item.titulo;
  artigo.append(titulo);

  const descricao = document.createElement("p");
  descricao.className = "feedback__item-descricao";
  descricao.textContent = item.descricao;
  artigo.append(descricao);

  const data = document.createElement("time");
  data.className = "feedback__item-data";
  const quando = new Date(item.criado_em);
  data.dateTime = quando.toISOString();
  data.textContent = quando.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
  artigo.append(data);

  return artigo;
}
