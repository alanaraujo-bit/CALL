-- Eventos: a memoria do que aconteceu, e a unica fonte de retencao.
--
-- Ate aqui o servidor sabia *o estado atual* (quem tem conta, quais grupos
-- existem, quais sessoes valem) e nada sobre *o percurso*. "Quantas pessoas
-- que criaram conta na semana passada voltaram?" nao e uma pergunta que o
-- estado atual responda -- nenhuma quantidade de consultas em `contas`
-- reconstroi um dia de uso que ninguem anotou.
--
-- Esta tabela e o minimo que responde essa pergunta, e nada alem dele:
--
--   * `conta_id` e a **unica** coluna que aponta para uma pessoa, e e o mesmo
--     identificador que ja viaja no protocolo. Nao ha IP, nao ha user-agent,
--     nao ha titulo de janela, nao ha texto de mensagem. Uma linha aqui diz
--     "esta conta fez isto, nesta hora", e o painel nao precisa de mais.
--   * `alvo` guarda o codigo do grupo ou o id do canal -- o que ja e publico
--     para quem esta la dentro.
--   * `valor` e o unico numero livre: a duracao em segundos de uma passagem
--     pela voz, e nada mais por enquanto.
--
-- Quem entra **sem conta** aparece com `conta_id` NULL: continua contando
-- como acesso, e continua sem virar pessoa nenhuma no painel -- o CALL nunca
-- prometeu saber quem essa pessoa e, e o painel nao vai fingir que sabe.
CREATE TABLE eventos (
    id         BIGSERIAL PRIMARY KEY,
    em         BIGINT NOT NULL,
    tipo       TEXT NOT NULL,
    -- Sem REFERENCES de proposito: apagar uma conta nao deve reescrever o
    -- passado do painel. O evento vira orfao, e o painel simplesmente nao
    -- acha a pessoa -- que e a verdade.
    conta_id   TEXT,
    alvo       TEXT NOT NULL DEFAULT '',
    valor      BIGINT NOT NULL DEFAULT 0,
    plataforma TEXT NOT NULL DEFAULT ''
);

-- Toda consulta do painel e "os eventos desde tal instante", em ordem: e uma
-- janela movel de dias, nunca a tabela inteira.
CREATE INDEX idx_eventos_em ON eventos(em);
CREATE INDEX idx_eventos_conta ON eventos(conta_id, em);
