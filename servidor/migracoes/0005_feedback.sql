-- Relatos de usuario: bug, sugestao ou elogio.
--
-- `status` comeca em 'recebido' e so muda pelo painel administrativo web
-- (ainda por construir) -- ver `servidor/src/contas.rs`, `Feedback`.
CREATE TABLE feedback (
    id            TEXT PRIMARY KEY,
    conta_id      TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    apelido       TEXT NOT NULL,
    categoria     TEXT NOT NULL,
    titulo        TEXT NOT NULL,
    descricao     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'recebido',
    criado_em     BIGINT NOT NULL,
    atualizado_em BIGINT NOT NULL
);

CREATE INDEX idx_feedback_conta ON feedback(conta_id);
CREATE INDEX idx_feedback_status ON feedback(status);
