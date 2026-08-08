-- Foto do grupo também na lista de atalhos da conta.
--
-- O grupo completo continua em `grupos.json`; aqui fica só a cópia necessária
-- para a coluna da esquerda atravessar troca de máquina e partida offline.
ALTER TABLE atalhos ADD COLUMN IF NOT EXISTS foto TEXT NOT NULL DEFAULT '';
