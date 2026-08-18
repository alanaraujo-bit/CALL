/**
 * O histórico de versões do CALL, escrito por quem construiu — não uma lista
 * de commits, uma conversa sobre o que mudou e por quê.
 *
 * Cada entrada é lida por `historico.js` na Central de Novidades (o hub
 * navegável, aberto a qualquer momento) e não tem relação com
 * `atualizacaoNotas` em app.js (o texto solto que o manifesto do updater
 * carrega e que vira o cartão "O que há de novo" só quando existe uma versão
 * nova esperando instalar). São dois lugares por design: um é o registro
 * permanente, o outro é o convite do momento — ver [[project-call-ui-refresh]]
 * no histórico de decisões da IA para a discussão completa.
 *
 * `imagem` é opcional, e deliberadamente raro: uma captura real da própria
 * ferramenta (nunca ilustração ou mockup) só entra quando a mudança tem algo
 * concreto para mostrar. Arquivos vivem em `capturas/`, pesam pouco (o hub
 * roda dentro do instalador) e são servidos por `img-src 'self'` sem precisar
 * abrir a CSP.
 */
export const NOTAS_DE_VERSAO = [
  {
    versao: "0.15.0",
    data: "2026-08-12",
    titulo: "Um perfil que conta mais sobre você",
    resumo:
      "O cartão de perfil ganhou identidade visual própria — e agora, quando alguém está assistindo sua tela, você fica sabendo.",
    destaques: [
      {
        titulo: "Novo",
        itens: [
          "O que você está usando aparece com o ícone real do programa (Spotify, Discord, Steam, VS Code e outros) — antes era sempre o mesmo símbolo genérico.",
          "Compartilhando a tela? Agora dá para ver quem está assistindo, em tempo real.",
          "Uma mensagem nova toca um som — silenciável a qualquer momento em Ajustes.",
        ],
      },
      {
        titulo: "Melhorado",
        itens: [
          "O cartão de perfil foi reorganizado: bio e atividade agora vivem dentro de um painel próprio, como no seu próprio card.",
          "Clicar em si mesmo mostra o mesmo cartão elegante dos outros, com o atalho de editar no lugar certo.",
        ],
      },
    ],
    imagem: { src: "capturas/perfil-cartao.png", alt: "Cartão de perfil do CALL mostrando bio, atividade com o ícone do programa e ações rápidas" },
  },
  {
    versao: "0.14.0",
    data: "2026-08-11",
    titulo: "A voz ganhou rosto",
    resumo:
      "Chamadas em grupo agora mostram quem está falando com o mesmo destaque de uma transmissão de tela — sem perder o chat de vista.",
    destaques: [
      {
        titulo: "Novo",
        itens: [
          "Cada pessoa na chamada de voz aparece como um cartão grande com avatar, nome e um anel verde quando fala — ao lado do chat, não no lugar dele.",
          "O cartão vira transmissão de tela automaticamente assim que a pessoa começa a compartilhar, e volta ao avatar quando ela para.",
        ],
      },
      {
        titulo: "Consertado",
        itens: [
          "Menus de contexto e o seletor de emoji não desalinhavam mais ao mudar a escala da interface.",
          "Estabilidade geral de chamadas e transmissão sob conexões instáveis.",
        ],
      },
    ],
  },
  {
    versao: "0.13.1",
    data: "2026-08-10",
    titulo: "Pequenos ajustes de confiança",
    resumo:
      "Uma correção discreta: o CALL agora sempre mostra a versão real que está instalada, em vez de um número que podia ficar para trás.",
    destaques: [
      {
        titulo: "Consertado",
        itens: ["O número de versão exibido no rodapé do perfil agora vem sempre do aplicativo instalado."],
      },
    ],
  },
];
