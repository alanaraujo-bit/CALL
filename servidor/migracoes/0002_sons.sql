-- Soundboard pessoal e preferencia de som ao entrar.
--
-- Sons de GRUPO (a biblioteca compartilhada, tipo soundboard do Discord)
-- continuam em arquivo -- `sons.json` + `DADOS/sons/grupos/<codigo>/<id>`,
-- pelo mesmo motivo de grupos/canais/mensagens nunca terem passado a usar
-- banco (ver o topo de `modelo.rs`). Sons PESSOAIS moram aqui porque
-- pertencem a conta, do mesmo jeito que apelido/bio/avatar ja moram --
-- inclusive com o mesmo teto de 300 KB por clipe que o lado de arquivo usa.

CREATE TABLE sons_pessoais (
    id         TEXT PRIMARY KEY,
    conta_id   TEXT NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
    nome       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    dados      BYTEA NOT NULL,
    criado_em  BIGINT NOT NULL
);

CREATE INDEX idx_sons_pessoais_conta ON sons_pessoais(conta_id);

-- Qual som toca quando a pessoa entra num canal de voz. Os tres campos NULL
-- significam "sino sintetizado padrao" -- o comportamento de sempre, e o
-- default de uma conta que nunca mexeu nisso.
--
-- `origem` e 'grupo' ou 'pessoal'. Quando e 'grupo', `som_entrada_grupo`
-- guarda o codigo do grupo dono do clipe -- um som de entrada escolhido na
-- biblioteca de um grupo so toca dentro dele; fora dele cai de volta pro
-- sino padrao, por nao ter onde buscar o clipe.
ALTER TABLE contas ADD COLUMN som_entrada_origem TEXT;
ALTER TABLE contas ADD COLUMN som_entrada_grupo  TEXT;
ALTER TABLE contas ADD COLUMN som_entrada_id     TEXT;
