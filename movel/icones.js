/**
 * Os ícones do CALL no celular.
 *
 * Mesmo vocabulário do aplicativo de mesa: traço fino de 1,7, ponta e junta
 * arredondadas, nada preenchido. Todos desenhados numa grade de 24 para que
 * dois ícones lado a lado tenham o mesmo peso óptico — o que não acontece
 * quando se mistura biblioteca de 16 com biblioteca de 24.
 *
 * O arquivo guarda só o miolo do `<svg>`; a moldura sai de `icone()`, para que
 * nenhum lugar da interface precise repetir `viewBox`, `fill` e `stroke`.
 */

export const ICONES = {
  /* ── Navegação ─────────────────────────────────────────────── */
  voltar: '<path d="M15 5l-7 7 7 7"/>',
  avancar: '<path d="M9 5l7 7-7 7"/>',
  descer: '<path d="M5 9l7 7 7-7"/>',
  subir: '<path d="M5 15l7-7 7 7"/>',
  fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  menos: '<path d="M5 12h14"/>',
  reticencias: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  busca: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',

  /* ── Abas ──────────────────────────────────────────────────── */
  grupos: '<rect x="3" y="3" width="7.5" height="7.5" rx="2.4"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2.4"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2.4"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.4"/>',
  amigos: '<path d="M9 11.5a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z"/><path d="M2.5 19.5c.9-3.1 3.3-4.8 6.5-4.8s5.6 1.7 6.5 4.8"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M18 15.2c2 .6 3.2 1.9 3.7 3.8"/>',
  voce: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4.5 20c1-3.4 3.8-5.2 7.5-5.2s6.5 1.8 7.5 5.2"/>',

  /* ── Canais ────────────────────────────────────────────────── */
  texto: '<path d="M8.5 3.5L6 20.5M17 3.5l-2.5 17M4 8.5h16M3 15.5h16"/>',
  voz: '<path d="M12 4.5L7.5 8.5H4v7h3.5L12 19.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.6 7.6 0 0 1 0 11"/>',
  categoria: '<path d="M9 6l6 6-6 6"/>',

  /* ── Chamada ───────────────────────────────────────────────── */
  microfone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  "microfone-mudo": '<path d="M9 5.8A3 3 0 0 1 15 6v5.2"/><path d="M15 14.2A3 3 0 0 1 9 13.2V9"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.2 5.3"/><path d="M18.5 11.5a6.4 6.4 0 0 1-.4 2.2"/><path d="M12 18v3"/><path d="M4 3.5l16 17"/>',
  fone: '<path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="2.8" y="13.5" width="4.2" height="7" rx="2.1"/><rect x="17" y="13.5" width="4.2" height="7" rx="2.1"/>',
  "fone-mudo": '<path d="M4.5 15v-3a7.5 7.5 0 0 1 12.8-5.3"/><path d="M19.5 12.2V15"/><rect x="2.8" y="13.5" width="4.2" height="7" rx="2.1"/><rect x="17" y="13.5" width="4.2" height="7" rx="2.1"/><path d="M4 3.5l16 17"/>',
  desligar: '<path d="M3.2 13.4c4.9-4.5 11.9-4.6 17.6 0"/><path d="M6.9 16.9l1.5-2.2a1.6 1.6 0 0 0-.2-2"/><path d="M17.1 16.9l-1.5-2.2a1.6 1.6 0 0 1 .2-2"/><path d="M9 20.5h6"/>',
  telefone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  transmitir: '<rect x="2.8" y="4.5" width="18.4" height="12.5" rx="2.2"/><path d="M9 20.5h6"/><path d="M12 8v6M9.2 10.8L12 8l2.8 2.8"/>',
  "parar-transmissao": '<rect x="2.8" y="4.5" width="18.4" height="12.5" rx="2.2"/><path d="M9 20.5h6"/><rect x="9.5" y="9" width="5" height="5" rx="1"/>',
  espectadores: '<path d="M2.5 12s3.4-5.8 9.5-5.8S21.5 12 21.5 12s-3.4 5.8-9.5 5.8S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  soundboard: '<path d="M9 18.5V6.2l10-2v12"/><ellipse cx="6.5" cy="18.5" rx="2.5" ry="2"/><ellipse cx="16.5" cy="16.2" rx="2.5" ry="2"/>',
  expandir: '<path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/>',
  encolher: '<path d="M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5"/>',
  volume: '<path d="M11 5L7 8.5H4v7h3l4 3.5z"/><path d="M14.5 9.5a3.4 3.4 0 0 1 0 5"/><path d="M17 7a7 7 0 0 1 0 10"/>',
  "volume-mudo": '<path d="M11 5L7 8.5H4v7h3l4 3.5z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  ondas: '<path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4"/>',

  /* ── Conversa ──────────────────────────────────────────────── */
  enviar: '<path d="M4.5 12l15.5-7-7 15.5-2.2-6.3z"/>',
  emoji: '<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><path d="M9 9.5v.01M15 9.5v.01"/>',
  responder: '<path d="M9 8L4.5 12 9 16"/><path d="M4.5 12h9a6 6 0 0 1 6 6v1.5"/>',
  lapis: '<path d="M16.4 4.6l3 3L8.6 18.4l-4 1 1-4z"/>',
  lixeira: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.5 6.5l.9 12.2a1.8 1.8 0 0 0 1.8 1.8h5.6a1.8 1.8 0 0 0 1.8-1.8l.9-12.2"/>',
  copiar: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 5.5H6.7a2.2 2.2 0 0 0-2.2 2.2v8.8"/>',
  compartilhar: '<path d="M12 3.5v12"/><path d="M8.2 7.3L12 3.5l3.8 3.8"/><path d="M5.5 13v5.7a1.8 1.8 0 0 0 1.8 1.8h9.4a1.8 1.8 0 0 0 1.8-1.8V13"/>',
  anexo: '<path d="M18.5 11.5l-7.4 7.4a4.2 4.2 0 0 1-6-6l8-8a2.8 2.8 0 0 1 4 4l-7.9 7.9a1.4 1.4 0 0 1-2-2l7.2-7.2"/>',

  /* ── Contas, perfil, grupos ────────────────────────────────── */
  usuario: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4.5 20c1-3.4 3.8-5.2 7.5-5.2s6.5 1.8 7.5 5.2"/>',
  "adicionar-pessoa": '<path d="M10 11.5a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4z"/><path d="M3 20c.9-3.2 3.4-4.9 7-4.9 1 0 1.9.1 2.7.4"/><path d="M18 14v6M15 17h6"/>',
  camera: '<path d="M4.5 8h2.8l1.4-2.2h6.6L16.7 8h2.8a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H4.5a1.8 1.8 0 0 1-1.8-1.8V9.8A1.8 1.8 0 0 1 4.5 8z"/><circle cx="12" cy="13.5" r="3.4"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M3.6 6.5L12 12.6l8.4-6.1"/>',
  cadeado: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  olho: '<path d="M2.5 12s3.4-5.8 9.5-5.8S21.5 12 21.5 12s-3.4 5.8-9.5 5.8S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  "olho-fechado": '<path d="M4 5l16 14"/><path d="M9.4 9.6a2.6 2.6 0 0 0 3.4 3.7"/><path d="M6.2 7.6C4 9.3 2.5 12 2.5 12s3.4 5.8 9.5 5.8c1.5 0 2.8-.3 4-.9"/><path d="M17.6 15.2c2.3-1.7 3.9-3.2 3.9-3.2s-3.4-5.8-9.5-5.8c-.8 0-1.6.1-2.3.3"/>',
  google: '<path d="M20.6 12.2c0-.7-.06-1.3-.18-1.9H12v3.7h4.85a4.2 4.2 0 0 1-1.8 2.7v2.3h2.9c1.7-1.6 2.65-3.9 2.65-6.8z"/><path d="M12 21c2.4 0 4.45-.8 5.95-2.2l-2.9-2.3c-.8.55-1.85.87-3.05.87-2.35 0-4.35-1.6-5.05-3.72H3.9v2.34A9 9 0 0 0 12 21z"/><path d="M6.95 13.65a5.4 5.4 0 0 1 0-3.45V7.86H3.9a9 9 0 0 0 0 8.13z"/><path d="M12 6.6c1.3 0 2.5.45 3.4 1.33l2.58-2.58A9 9 0 0 0 3.9 7.86l3.05 2.34C7.65 8.08 9.65 6.6 12 6.6z"/>',
  sair: '<path d="M15.5 16.5l4-4.5-4-4.5"/><path d="M19 12H9.5"/><path d="M12.5 4.5H6a1.8 1.8 0 0 0-1.8 1.8v11.4A1.8 1.8 0 0 0 6 19.5h6.5"/>',
  entrar: '<path d="M11.5 16.5l4-4.5-4-4.5"/><path d="M15 12H5.5"/><path d="M9 4.5h9a1.8 1.8 0 0 1 1.8 1.8v11.4A1.8 1.8 0 0 1 18 19.5H9"/>',
  convite: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M3.6 6.5L12 12.6l8.4-6.1"/><path d="M12 12.6V19"/>',
  chave: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.5 12v3M20 12v2.2"/>',

  /* ── Ajustes ───────────────────────────────────────────────── */
  ajustes: '<circle cx="12" cy="12" r="3.2"/><path d="M19.6 14.4a1.6 1.6 0 0 0 .32 1.76l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.05-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46v.17a1.9 1.9 0 1 1-3.8 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.46-.97h-.17a1.9 1.9 0 1 1 0-3.8h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.76.32h.08a1.6 1.6 0 0 0 .97-1.46v-.17a1.9 1.9 0 1 1 3.8 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.05-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.76v.08a1.6 1.6 0 0 0 1.46.97h.17a1.9 1.9 0 1 1 0 3.8h-.09a1.6 1.6 0 0 0-1.46.97z"/>',
  servidor: '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 7.2v.01M7 16.7v.01"/>',
  sino: '<path d="M18 8.8a6 6 0 1 0-12 0c0 6.2-2.2 7.2-2.2 7.2h16.4S18 15 18 8.8z"/><path d="M13.7 19.5a2 2 0 0 1-3.4 0"/>',
  novidades: '<path d="M4 8.5h11l4.5-3.2v13.4L15 15.5H4a1.5 1.5 0 0 1-1.5-1.5V10A1.5 1.5 0 0 1 4 8.5z"/><path d="M7 15.5v3.8a1.2 1.2 0 0 0 1.2 1.2H10"/>',
  feedback: '<path d="M20.5 13.5a2 2 0 0 1-2 2h-9L5 19.5v-4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h14.5a2 2 0 0 1 2 2z"/><path d="M8 8h8M8 11h5"/>',
  informacao: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.01"/>',
  alerta: '<path d="M12 4.2l8.5 15H3.5z"/><path d="M12 10v4M12 17.2v.01"/>',
  atualizar: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  baixar: '<path d="M12 4v11m0 0l-4-4m4 4l4-4"/><path d="M5 19.5h14"/>',
  "adicionar-inicio": '<rect x="4.5" y="2.8" width="15" height="18.4" rx="3"/><path d="M12 8.5v6M9 11.5h6"/>',
  "compartilhar-ios": '<path d="M12 3.5v11"/><path d="M8.5 6.8L12 3.5l3.5 3.3"/><path d="M6 11.5H5.2A1.7 1.7 0 0 0 3.5 13.2v6.1a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7v-6.1a1.7 1.7 0 0 0-1.7-1.7H18"/>',
  wifi: '<path d="M2.5 9.2a14 14 0 0 1 19 0"/><path d="M5.8 12.6a9.3 9.3 0 0 1 12.4 0"/><path d="M9 15.9a4.6 4.6 0 0 1 6 0"/><path d="M12 19.2v.01"/>',
  "sem-wifi": '<path d="M4 4l16 16"/><path d="M2.5 9.2A14 14 0 0 1 7 6.4"/><path d="M15.5 7a13.9 13.9 0 0 1 6 2.2"/><path d="M5.8 12.6a9.3 9.3 0 0 1 3-2"/><path d="M18.2 12.6a9.4 9.4 0 0 0-2.4-1.6"/><path d="M9 15.9a4.6 4.6 0 0 1 4.6-1.1"/><path d="M12 19.2v.01"/>',
  coroa: '<path d="M3.5 8l3.8 3L12 5l4.7 6 3.8-3-1.6 10.5H5.1z"/>',
  relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  "sem-som": '<path d="M11 5L7 8.5H4v7h3l4 3.5z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  estrela: '<path d="M12 3.8l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  raio: '<path d="M13.5 3L5 13.5h6L10.5 21 19 10.5h-6z"/>',
};

/**
 * Um `<svg>` pronto para entrar na tela.
 *
 * `nome` desconhecido devolve um quadrado vazio em vez de explodir: um ícone
 * que faltou é um defeito visual, não motivo para derrubar a tela inteira.
 */
export function icone(nome, classe = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (classe) svg.setAttribute("class", classe);
  svg.innerHTML = ICONES[nome] ?? "";
  return svg;
}

/** A mesma coisa em texto, para quem monta HTML de uma vez só. */
export const svgDe = (nome, classe = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"${classe ? ` class="${classe}"` : ""}>${
    ICONES[nome] ?? ""
  }</svg>`;
