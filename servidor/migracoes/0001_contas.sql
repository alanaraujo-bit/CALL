-- Contas do CALL.
--
-- Corresponde exatamente ao que `contas.rs` guardava em `contas.json` e
-- `sessoes.json` -- a migracao para Postgres troca a persistencia, nao o
-- modelo. Ver `servidor/src/contas.rs` para o porque de cada campo.

CREATE TABLE contas (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    -- String PHC do Argon2id. Vazia numa conta que so entra pelo Google.
    senha      TEXT NOT NULL DEFAULT '',
    -- O `sub` do Google. NULL, e nao vazio, para a UNIQUE abaixo aceitar
    -- varias contas sem Google -- Postgres nao considera dois NULLs iguais,
    -- mas consideraria duas strings vazias iguais e recusaria a segunda conta
    -- sem Google cadastrada.
    google     TEXT UNIQUE,
    apelido    TEXT NOT NULL,
    avatar     TEXT NOT NULL DEFAULT '',
    bio        TEXT NOT NULL DEFAULT '',
    criada_em  BIGINT NOT NULL
);

-- Um grupo que a conta conhece -- a coluna da esquerda do aplicativo.
CREATE TABLE atalhos (
    conta_id  TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    codigo    TEXT NOT NULL,
    nome      TEXT NOT NULL,
    PRIMARY KEY (conta_id, codigo)
);

-- Sessoes vivas. `marca` e a impressao do token (Blake2s256 em hexadecimal),
-- nunca o token: um vazamento deste arquivo -- ou desta tabela -- nao abre
-- conta nenhuma.
CREATE TABLE sessoes (
    marca     TEXT PRIMARY KEY,
    conta_id  TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    expira    BIGINT NOT NULL
);

-- `retomar` e `sair-conta` procuram por marca; a limpeza periodica de
-- sessoes vencidas procura por conta e por prazo. Os dois caminhos usam o
-- indice da chave primaria e este aqui.
CREATE INDEX idx_sessoes_conta ON sessoes(conta_id);
