-- Amizades e pedidos de amizade.
--
-- Corresponde a `amigos: Vec<String>` e `pedidos_amigo: Vec<PedidoAmigo>` em
-- `Conta` -- ver `servidor/src/contas.rs`.
--
-- `amigos` guarda os dois lados como linhas separadas, (conta_id, amigo_id)
-- e (amigo_id, conta_id): o mesmo dado que o backend de arquivo guarda como
-- uma lista espelhada em cada conta, so que aqui e uma linha por direcao em
-- vez de duas listas -- consultar "meus amigos" vira um SELECT direto por
-- conta_id, sem OR nenhum.
CREATE TABLE amigos (
    conta_id  TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    amigo_id  TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    PRIMARY KEY (conta_id, amigo_id)
);

-- Pedidos pendentes, guardados em quem ainda nao respondeu. `apelido` e
-- `avatar` sao a copia de quando o pedido foi mandado, do mesmo jeito que o
-- backend de arquivo guarda em `PedidoAmigo`.
CREATE TABLE pedidos_amigo (
    conta_id  TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    de_id     TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    apelido   TEXT NOT NULL,
    avatar    TEXT NOT NULL DEFAULT '',
    em        BIGINT NOT NULL,
    PRIMARY KEY (conta_id, de_id)
);
