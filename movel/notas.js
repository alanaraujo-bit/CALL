/**
 * O histórico de versões do CALL no celular.
 *
 * Fica separado de `src/notas-de-versao.js` porque as duas cascas têm relógios
 * próprios: o aplicativo de mesa está na 0.17, o de celular acabou de nascer
 * na 1.0, e misturar as duas numerações numa lista só faria a Central de
 * Novidades parecer que voltou no tempo.
 *
 * A tela mostra as duas listas, nesta ordem, com um selo dizendo de qual
 * casca é cada bloco — porque o produto é um só, e quem usa os dois quer ler
 * o que mudou nos dois.
 */

export const NOTAS_DO_CELULAR = [
  {
    versao: "1.0.0",
    data: "2026-08-19",
    titulo: "O CALL cabe no bolso",
    resumo:
      "O mesmo CALL, a mesma conta e os mesmos grupos — agora abrindo no navegador do celular e instalável na tela de início.",
    destaques: [
      {
        titulo: "Novo",
        itens: [
          "Grupos, canais de texto e canais de voz funcionando no Android e no iPhone, sem baixar nada.",
          "Dá para adicionar à tela de início: o CALL abre em tela cheia, com ícone próprio e sem barra de endereço.",
          "A call continua acontecendo enquanto você navega pelo aplicativo — uma tira no rodapé mostra o canal, o tempo e o botão de mudo.",
          "A tela de quem está transmitindo do computador aparece aqui, e um toque abre em tela cheia com pinça para ampliar.",
          "Amigos e mensagens privadas, com o mesmo código de amigo do computador.",
          "Soundboard do grupo: tocar um clipe para todo mundo na call, do celular.",
        ],
      },
      {
        titulo: "Feito para o dedo",
        itens: [
          "Arrastar da borda esquerda volta uma tela, seguindo o dedo — não é uma animação disparada depois do gesto.",
          "Segurar uma mensagem abre reagir, copiar, editar e excluir.",
          "Cada aba guarda onde você estava: ir aos Amigos e voltar devolve a conversa aberta, e não a lista de grupos.",
          "Vibração curta a cada toque, desligável nos ajustes.",
        ],
      },
      {
        titulo: "O que ainda mora só no Windows",
        itens: [
          "Transmitir a sua tela: o navegador de celular não tem como capturar a tela do aparelho. Assistir à de outra pessoa, sim.",
          "Mostrar ao grupo o programa em uso, e o filtro neural de ruído — os dois dependem do sistema, e não do navegador.",
        ],
      },
    ],
  },
];
