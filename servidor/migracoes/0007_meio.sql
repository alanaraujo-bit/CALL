-- Por onde a midia passou.
--
-- Ate aqui um evento de voz dizia quanto tempo alguem ficou na call, e nada
-- sobre *por onde* essa call passou. Enquanto so havia um transporte
-- possivel, a coluna teria sido ruido. Deixou de ser no dia em que a midia
-- virou uma escada com degraus -- LiveKit na nuvem, LiveKit proprio, malha
-- P2P -- e a pergunta "quantos minutos do plano ja gastamos?" passou a
-- depender de saber quais minutos foram para qual degrau.
--
-- Vazio e uma resposta legitima e comum:
--
--   * todo evento que nao e de voz nao tem transporte nenhum;
--   * todo evento gravado antes desta migracao nao teve quem o anotasse.
--
-- O painel mostra esses como "nao medido", e nao os atribui ao degrau mais
-- provavel. Um medidor de consumo que chuta e um medidor que nao serve para
-- decidir desligar nada.
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS meio TEXT NOT NULL DEFAULT '';

-- E quanta banda essa passagem custou. Fica na mesma linha, e nao numa
-- tabela de medicao a parte, porque e a mesma passagem pela call: uma linha
-- de voz-saiu ja responde "quem, por onde, por quanto tempo", e "quantos
-- bytes" e a quarta pergunta da mesma frase.
--
-- Sem esta coluna o contador do ciclo viveria so na memoria do processo, e
-- um redeploy -- que numa hospedagem gerenciada acontece toda vez que se
-- publica -- esqueceria tudo que ja foi gasto no mes. Um teto que esquece e
-- um teto que nao protege.
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0;

-- A consulta do consumo e "os eventos de voz do ciclo, por degrau". O indice
-- parcial cobre exatamente isso e nao cresce com o resto do historico.
CREATE INDEX IF NOT EXISTS idx_eventos_meio ON eventos(meio, em) WHERE meio <> '';
