# Estudo: qualidade de áudio do CALL

Comparação honesta com Discord e WhatsApp, feita lendo `src/audio.js`,
`src/porta-de-ruido.js`, `src/livekit.js` e o caminho de recepção em
`src/app.js`. Nada aqui é palpite de "boa prática": cada item aponta a linha
e, onde dá, a medição.

**Contexto confirmado:** vocês estão em **LiveKit Cloud**
(`wss://call-5avcakc0.livekit.cloud`), não em SFU próprio. Isso muda a
recomendação principal — a melhor opção de supressão de ruído é um plugin
oficial, não um WASM de terceiros.

---

## O que NÃO é o problema

Vale dizer primeiro, para não gastar esforço no lugar errado.

O **bitrate está bom**. 96 kbps Opus mono com `red: true` (redundância) e
`useinbandfec=1` já é **melhor que o padrão do Discord**, que manda 64 kbps
(96 kbps só em Nitro/Stage). Subir para 128 kbps não vai mudar nada
perceptível. O codec não é o gargalo.

O `<audio>` mudo em `app.js:4607` está certo — não há reprodução dupla. Já
tinham pensado nisso.

---

## Diagnóstico, separado por sintoma

"Está horrível" cobre pelo menos quatro falhas diferentes. Elas têm causas
distintas e correções distintas.

### 1. "Ouço todos os ruídos dos meus amigos" — falta supressão neural

**Esta é a causa principal, e é estrutural.**

Hoje existem duas defesas contra ruído, e nenhuma das duas resolve o que
vocês estão descrevendo:

| Defesa | Onde | O que remove | O que **não** remove |
|---|---|---|---|
| `noiseSuppression: true` do Chromium | `audio.js:113` | ruído **estacionário**: chiado, ventilador, ar-condicionado, zumbido de fonte | teclado, cachorro, TV, outra pessoa falando no cômodo, cadeira, prato, clique de mouse |
| Porta de ruído própria | `porta-de-ruido.js` | tudo, **enquanto a pessoa está calada** | tudo, **enquanto a pessoa está falando** |

Junte as duas colunas da direita e você tem exatamente o sintoma. A porta é
bem-feita (expansor com piso adaptativo e histerese — melhor que a maioria),
mas ela é um portão: abriu, passa tudo. O teclado do seu amigo enquanto ele
fala chega inteiro no seu ouvido.

Discord e WhatsApp não fazem isso. Eles rodam uma **rede neural** que separa
voz de não-voz espectralmente, quadro a quadro, **inclusive durante a fala**.
No Discord isso é o Krisp. É por isso que o colega deles pode datilografar
durante a call e ninguém escuta.

Essa é a distância. Não é ajuste de parâmetro — é um componente que falta.

### 2. Distorção quando mais de uma pessoa fala — ceifamento duro (medido)

O `criarLimitador()` em `audio.js:101` não é um limitador. É um **ceifador**.

O `WaveShaperNode` **clampa a entrada em [-1, 1]** antes de consultar a curva.
Como a curva foi desenhada assumindo entradas maiores que 1, tudo acima de 1
cai no mesmo ponto final da tabela. Medido rodando a curva real do código:

```
entrada -> saída        compressão
 0.60   -> 0.6000        0.00 dB   (linear, ok)
 0.80   -> 0.8000        0.00 dB   (linear, ok)
 1.00   -> 0.9264       -0.66 dB
 1.10   -> 0.9264       -1.49 dB   <- mesmo valor
 1.40   -> 0.9264       -3.59 dB   <- mesmo valor
 3.00   -> 0.9264      -10.21 dB   <- mesmo valor
```

Teto absoluto: **0.9264**. Tudo acima de 1.0 vira uma linha reta — a onda fica
com o topo cortado quadrado. Isso é distorção harmônica audível, não uma
compressão suave. O `oversample: "2x"` reduz o aliasing dela, mas não o corte.

Isso acontece em **dois lugares**, e os dois são atingidos na prática:

**No barramento de recepção** (`#limitadorSaida`, `audio.js:212`) — somam
nele: cada pessoa (ganho padrão 1), o ganho geral (padrão 1), os avisos e o
soundboard. Duas vozes pós-AGC com pico ~0.6 cada já passam de 0.8; três
pessoas passam de 1.0 rotineiramente. Ou seja: **numa call de gaming, sempre
que duas ou três pessoas falam junto, o mix inteiro distorce.** Exatamente o
momento em que você mais precisa entender quem falou.

**No barramento de envio** (`#limitadorEnvio`, `audio.js:250`) — o
`ganhoEntrada` vai até **2** (`AUDIO_PADRAO`, `audio.js:42`) e é aplicado
dentro do worklet, *antes* do limitador (`porta-de-ruido.js:184`). O AGC do
Chromium já normalizou o sinal perto do fundo de escala. Quem subir o ganho
de entrada no painel está **ceifando a própria voz no ouvido de todo mundo**,
e não tem como saber disso.

Este é o segundo maior problema, e é o mais barato de corrigir.

### 3. Suspeita a medir: cliques e falhas na recepção

O áudio remoto entra no grafo via `createMediaStreamSource` (`audio.js:378`).
Isso liga dois domínios de relógio diferentes: o do NetEq (escravo do relógio
do remetente remoto) e o do hardware do `AudioContext`. A compensação de
deriva do Chromium nesse ponto é historicamente uma fonte de estalos e
microcortes periódicos.

Vale questionar o custo/benefício. O comentário em `audio.js:5-7` justifica o
grafo pela escolha de dispositivo e volume por pessoa — mas os dois existem
sem WebAudio: `HTMLAudioElement.volume` e `HTMLMediaElement.setSinkId()`. A
**única** coisa que o grafo compra de fato na recepção é ganho **acima de
1.0**. A pergunta honesta: vale pagar risco de estalo e de referência de AEC
para poder passar de 100%?

Não estou afirmando que é isso — estou dizendo que é testável e que ninguém
testou. Ver "Medir primeiro" abaixo.

### 4. Cancelamento de eco pode estar falhando silenciosamente

Vocês permitem escolher o dispositivo de saída via `setSinkId` no
`AudioContext` (`audio.js:530`). O AEC do Chromium usa como referência o
sinal do dispositivo de **renderização padrão**. Se a pessoa escolhe uma saída
diferente da padrão do sistema, a referência não bate com o que está tocando
— e **o cancelamento de eco para de funcionar sem avisar**. Quem estiver sem
fone vira uma fonte de eco para a sala inteira.

### 4b. Eco quando alguém transmite a tela — em aberto, com teste decisivo

Relatado: transmitindo a tela, a outra pessoa passa a ouvir a própria voz de
volta. Duas coisas já foram **descartadas** olhando o código:

- **Não é reprodução dupla pelo LiveKit.** O SDK só reproduz áudio remoto
  sozinho se alguém chamar `attach()` numa trilha de áudio, e o CALL só chama
  `attach()` em vídeo (`app.js:4450`). O `<audio>` de `app.js:4607` está mudo.
- **Não é o loopback ingênuo.** `tela.rs:68` já usa
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, que exclui o próprio
  processo e seus filhos justamente para não recapturar as vozes remotas.

Sobram duas hipóteses, e elas pedem correções bem diferentes:

**(a) A exclusão de processo não alcança o WebView2.** O `std::process::id()`
é o processo Tauri. Quem *toca* o som é a árvore do WebView2
(`msedgewebview2.exe`), e o Chromium renderiza áudio num processo de serviço
separado ainda dentro dessa árvore. Se esse processo não estiver na árvore de
`call.exe` aos olhos da API, o loopback recaptura as vozes remotas e as manda
de volta.

**(b) O AEC quebra quando a transmissão começa.** `iniciarAudioDaTela()`
(`app.js:4395`) abre um **segundo `AudioContext`** a 48 kHz. Abrir outro fluxo
de áudio pode fazer o Chromium reconfigurar o caminho de renderização, e o
AEC3 perde o alinhamento com o sinal de referência. Sem AEC, o microfone de
quem transmite devolve para a sala tudo o que sai dos alto-falantes dele.

**O teste que separa as duas, em 30 segundos:** transmita a tela com
**"Transmitir som" desmarcado** (o controle existe — `estado.audioDaTela`,
`index.html#transmitir-som`).

- O eco **sumiu** → é a hipótese (a), o loopback. A correção é do lado Rust.
- O eco **continua** → é a hipótese (b), o AEC. A correção é do lado do
  `AudioContext` extra.

Um segundo teste confirma: se quem transmite puser **fones de ouvido** e o eco
sumir, é (b) — sem alto-falante não há o que o microfone recapturar.

Não dá para escolher a correção antes de saber qual das duas é. As duas ficam
em arquivos diferentes e nenhuma é pequena.

### 5. `latency: { ideal: 0.01 }`

Em `audio.js:117`. Pedir buffer de 10 ms no WASAPI/WebView2 do Windows é
agressivo e é uma causa conhecida de crepitação e underrun em máquina com
carga (jogo aberto, por exemplo). O ganho de latência é irrelevante numa call
pela internet, onde a rede já custa 30-80 ms. Não há motivo para manter.

---

## As opções de supressão neural

| Opção | Qualidade | CPU | Licença / custo | Esforço |
|---|---|---|---|---|
| **`@livekit/krisp-noise-filter`** | Excelente — é literalmente o que o Discord usa | Baixa (WASM otimizado) | **Exige LiveKit Cloud** (vocês já têm); é recurso de plano pago — confirmar no plano de vocês | **Baixo** — plugin oficial, `setProcessor()` |
| **RNNoise (WASM)** | Média. Modelo de 2018. Melhor que nada, bem abaixo do Krisp em ruído não-estacionário | Muito baixa | BSD, grátis | Médio — worklet próprio |
| **DeepFilterNet 3 (WASM/ONNX)** | Muito boa, perto do Krisp | Média-alta; quer SIMD | MIT/Apache, grátis | Alto — integração e tuning por conta de vocês |
| **`voiceIsolation: true`** (constraint) | Depende da máquina: usa Windows Studio Effects (NPU) ou o isolamento de voz do macOS | Zero (é o SO/NPU) | Grátis | **Trivial** — uma linha |

**Recomendação:** Krisp, porque vocês já estão em LiveKit Cloud e é o mesmo
motor do concorrente que está ganhando de vocês.

**As opções são mutuamente exclusivas.** O `voiceIsolation` do Windows Studio
Effects *também* é um supressor neural — ligá-lo junto com o Krisp é
exatamente o empilhamento que produz ruído musical (risco 2 abaixo). Ele é a
**alternativa** para quando o Krisp não estiver disponível, não um
complemento. Onde o Krisp roda, `voiceIsolation` fica desligado.

DeepFilterNet só se o Krisp não estiver no plano e vocês não quiserem subir de
plano. RNNoise eu não recomendaria: o trabalho de integração é quase o mesmo
do DeepFilterNet para um resultado bem pior.

### Importante: a correção de ruído é do lado de quem envia

O que você ouve do João é limpo pela máquina **do João**. Instalar o Krisp na
sua build não muda nada no teclado dele — só muda o que os outros ouvem de
você. O ganho só aparece por completo quando todo o grupo estiver na versão
nova. Os itens 2, 3 e 4 do diagnóstico, ao contrário, são do lado de quem
recebe e melhoram na hora.

### Riscos de integração (mordem na hora de implementar)

1. **Ponto de inserção.** O Krisp é um `TrackProcessor` de uma
   `LocalAudioTrack`. Vocês publicam a trilha do `#destino`, ou seja, **depois**
   da porta e do limitador (`livekit.js:108`). A supressão neural tem que vir
   **antes** da porta — o caminho é aplicar o Krisp na trilha crua do
   `getUserMedia` e alimentar o grafo com a saída dele.
   *A confirmar antes de prometer a fiação:* nos processors do LiveKit a saída
   processada costuma ser uma trilha **separada** da `mediaStreamTrack`
   original. Precisa verificar qual objeto entregar ao
   `createMediaStreamSource` — não é necessariamente a trilha que vocês já têm
   em mãos.
2. **Desligar o `noiseSuppression` nativo** quando a neural estiver ativa.
   Dois supressores empilhados produzem "ruído musical" — aquele borbulhar
   metálico. Fica pior que um só. Vale para o `voiceIsolation` também.
3. **Decidir se a porta de ruído continua existindo.** Não é só retune. O
   Krisp já cobre silêncio *e* fala; uma porta depois dele acrescenta risco de
   morder o ataque das palavras em troca de quase nada. O piso adaptativo
   (`porta-de-ruido.js:136`) aprende do áudio já suprimido, então com a neural
   na frente ele desaba para perto do silêncio digital e `piso + margem` passa
   a cortar sílabas. A única coisa do worklet que precisa sobreviver de
   qualquer forma é a saída `falando`, que alimenta o indicador de fala e o
   medidor. **Remover a porta e manter o medidor** é provavelmente menos
   trabalho e menos risco do que retunar.
4. **CSP.** `src-tauri/tauri.conf.json:28` já tem `wasm-unsafe-eval`, então o
   WASM carrega. Mas se o plugin buscar o modelo de um CDN, o `connect-src`
   vai bloquear. Verificar se o pacote empacota o modelo.
   *Resolvido, e o palpite estava meio certo:* o modelo vem embutido, mas o
   plugin busca a **licença** em `integrations.livekit.io` e monta o worklet a
   partir de um `blob:`. Ver "A CSP quase engoliu tudo isto".

---

## Medir primeiro (barato, e resolve a ambiguidade)

Antes de mexer, dá para saber qual dos quatro sintomas está dominando. Vocês
já têm `statsDeVideo()` usando `getRTCStatsReport` (`livekit.js:237`). O
equivalente para áudio é o mesmo código lendo `inbound-rtp` / `kind: "audio"`:

- **`concealedSamples` / `concealmentEvents`** — se estiver subindo, o
  problema é o item 3 (falhas na recepção), não ruído.
- **`packetsLost` / `jitter`** — separa problema de rede de problema local.
- **`audioLevel`** no `outbound-rtp` — mostra se o AGC está empurrando o sinal
  para o topo e alimentando o ceifamento do item 2.

Meia hora de trabalho e para de ser adivinhação.

---

## Feito nesta rodada

Os itens 2 e 3 do diagnóstico foram corrigidos e medidos. Antes e depois do
limitador, num Chromium real (`DynamicsCompressorNode` no lugar do
`WaveShaperNode`):

| entrada | antes (ceifador) | depois (limitador) |
|---|---|---|
| 0,20 | 0,2000 | 0,1999 |
| 0,60 | 0,6000 | 0,5997 |
| 1,00 | 0,9264 | 0,8067 |
| 1,40 | **0,9264** | 0,8273 |
| 1,80 | **0,9264** | 0,8432 |
| 3,00 | **0,9264** | 0,8713 |

À esquerda, tudo acima de 1,0 no mesmo valor — topo quadrado. À direita, cada
entrada tem sua saída, e o **fator de crista fica em 1,414 em toda a faixa**
(senoide perfeita; onda ceifada tende a 1,0). Voz normal atravessa com
−0,00 dB.

Mudanças:

- `criarLimitador()` virou `DynamicsCompressorNode` (limiar −3 dBFS, joelho 3,
  razão 20:1, ataque 3 ms, soltura 200 ms) mais um ganho que **anula o
  *makeup* de +1,20 dB que o Blink embute por dentro do nó** — sem isso o
  "limitador" *aumentava* o sinal e deixava o pico passar de 1,0. Passou a
  devolver `{ entrada, saida }`, porque agora são dois nós.
- Barramento `#vozes` novo, com **−3 dB de folga**, somando o que vem dos
  outros antes do volume geral. É ele que mantém o limitador como rede de
  segurança em vez de estágio de compressão permanente — sem folga, três
  pessoas falando junto fariam o limitador atuar o tempo todo, e atuação
  constante é bombeamento audível.

  **Efeito colateral a saber:** o som de transmissão de tela também passa por
  este barramento (`ligarSaida("tela:…")`), então ele fica **3 dB mais baixo
  do que antes**. Isso é proposital — som de jogo é a fonte mais alta e mais
  contínua do barramento, e era ela que mais empurrava o mix para o
  ceifamento —, mas é uma mudança perceptível de volume, e não só uma
  correção de distorção. Se ficar baixo demais na prática, o lugar de ajustar
  é o volume por pessoa, que já é independente.
- `ganhoEntrada` preso em **1,5** (era 2), no controle e no `aplicar()` — o
  segundo para que uma preferência gravada por versão antiga também seja
  presa.
- `latency: { ideal: 0.01 }` removido das constraints de captura.

Testes: `testes/malha.html` 57/57, `testes/motor-audio.html` 5/5. O teste do
limitador ganhou uma verificação de **fator de crista** — os dois testes que
já existiam ("voz normal atravessa", "picos não clipam") passavam com o
ceifador, porque nenhum dos dois olhava a forma da onda.

## Feito na rodada seguinte — a supressão neural e o eco

O item 1 (o principal) e o 4/4b foram implementados. O que mudou:

### Supressão neural, com queda planejada

`src/supressao.js` é novo e é quem escolhe o motor. São três, **exclusivos
entre si** — dois supressores em série produzem ruído musical:

| Motor | O que é | Quando entra |
|---|---|---|
| `neural` | `@livekit/krisp-noise-filter`, o mesmo Krisp do Discord | sempre que carregar |
| `sistema` | constraint `voiceIsolation` (Windows Studio Effects) | se o Krisp não carregar |
| `nativa` | supressor do Chromium + porta de ruído | chão, quando nada acima existe |

O ponto de inserção é **antes** do grafo: o Krisp trata a trilha crua do
`getUserMedia` e é a saída dele que alimenta `createMediaStreamSource`. Se
fosse aplicado na trilha publicada, viria depois da porta e do limitador — que
é o lugar errado, porque a porta precisa medir um sinal já limpo.

Três armadilhas que a implementação teve de cobrir:

1. **O Krisp roda no `AudioContext` do motor de voz**, não em um próprio. Um
   contexto a mais é outro caminho de renderização aberto — o mesmo risco de
   AEC do item 4b.
2. **A licença só é conferida com a sala em mãos.** O SDK chama `onPublish`
   sozinho para trilhas que ele mesmo processa; a nossa é montada à mão, então
   a chamada saiu daqui (`livekit.js` ganhou `aoEntrar`). Se a licença for
   negada, o pacote emite `disable-lk-krisp-noise-filter` — o motor ouve esse
   evento e **recaptura o microfone com o supressor nativo**. Sem isso a pessoa
   ficaria sem supressão nenhuma, porque o nativo foi desligado para dar lugar
   ao Krisp.
3. **A porta de ruído fica em repouso sob o motor neural** (`ativa = 0`). O
   piso adaptativo dela aprende do sinal que recebe; com uma rede neural na
   frente esse piso desaba para perto do silêncio digital e `piso + margem`
   passa a cortar sílaba. O detector `falando` continua rodando, então o
   indicador de fala e o medidor não mudam.

### A CSP quase engoliu tudo isto

O Krisp **não** é autossuficiente, ao contrário do que a primeira leitura do
pacote sugeria. Ele precisa de duas coisas que a CSP do CALL negava:

| Falta | Erro | Correção em `tauri.conf.json` |
|---|---|---|
| conferir a licença em `integrations.livekit.io` no `init` | `Failed to fetch` | `connect-src … https://integrations.livekit.io` |
| montar o worklet a partir de uma URL `blob:` | `WORKLET_NOT_SUPPORTED` | `script-src … blob:` e `worker-src 'self' blob:` |

**As duas falhavam calado.** O `init` lança, a queda para o motor de baixo
acontece como projetada, e o aplicativo segue funcionando — com ruído. Nada na
tela dizia que a peça principal não tinha entrado. Teria sido exatamente mais
uma rodada de "mexemos e não resolveu".

Só apareceram porque `testes/servir.mjs` passou a servir a CSP real também para
as páginas de áudio. Num navegador sem política — que é como o ensaio rodava
antes — o filtro carregava e o teste dizia que estava tudo certo.

**Medido:** com microfone real e **sob a CSP de produção**, o motor escolhido é
`neural`. Com o microfone sintético dos testes o
Krisp recusa a trilha ("Cannot satisfy constraints": ele aplica constraints de
dispositivo, e um `MediaStreamAudioDestinationNode` não tem o que satisfazer) e
a queda para `sistema` acontece como projetada, sem deixar a captura sem
supressão.

O ramo da reabertura do microfone no meio da call — trocar de microfone, mexer
nos filtros do sistema, ou a recaptura automática depois de o filtro perder a
licença — tem ensaio próprio em `testes/krisp-reabrir.html`, porque
`motor-audio.html` troca o `getUserMedia` por trilhas do Web Audio e o filtro
neural as recusa.

### Eco: as duas hipóteses do item 4b, resolvidas sem esperar o teste

A hipótese (b) foi corrigida direto: `iniciarAudioDaTela()` **não abre mais um
segundo `AudioContext`** — usa o do motor de voz. Era a mais barata das duas e
elimina a variável.

A hipótese (a) — o loopback do WebView2 — continua em aberto e continua
dependendo do teste de transmitir com "Transmitir som" desmarcado. Se o eco
sumiu com esta mudança, era (b) e acabou.

### O item 4 (`setSinkId`) virou aviso

Não há como corrigir por código: o AEC do Chromium usa como referência o
dispositivo de renderização **padrão** do sistema, e escolher outra saída no
CALL desalinha essa referência sem qualquer sinal de que isso aconteceu. Agora
um aviso aparece no painel — e só para quem escolheu uma saída diferente da
padrão com o cancelamento de eco ligado, que é exatamente quem está no
problema.

### O que isto **não** resolve

A correção de ruído é do lado de **quem envia**. O Krisp na sua máquina limpa o
que os outros ouvem de você; o teclado do João continua chegando inteiro até o
João atualizar. Um teste com metade do grupo na versão antiga vai parecer que
nada mudou.

---

## Ordem sugerida

1. **Medição de áudio no stats** — meia hora, e diz se o item 3 é real.
2. **Gain staging — e só depois a forma do limitador.** A ordem importa, e é
   fácil errar aqui.

   O problema da recepção **não é só a curva**: é que não existe escalonamento
   de ganho nenhum. `#geral` em 1.0 com N fontes em 1.0 cada faz a soma passar
   de 1.0 por construção. Trocar o ceifador por um limitador com lookahead sem
   mexer nisso só substitui distorção constante por **bombeamento constante**
   — várias pessoas falando continua soando errado, e vocês vão achar que
   consertaram.

   A correção, nesta ordem:
   1. Trazer a soma para baixo de 1.0 (atenuação no mestre ou por fonte).
   2. Só então o limitador vira o que ele deveria ser: uma rede de segurança
      que quase nunca atua.

   Mesma lógica no envio: **o conserto é limitar o `ganhoEntrada`**; a forma
   do limitador é secundária.

   Correção pequena, ganho imediato e audível.
3. **Remover `latency: {ideal: 0.01}`** — uma linha, sem risco.
4. **Krisp** — o item que fecha a distância para o Discord. Confirmar
   disponibilidade no plano LiveKit Cloud antes. (Se não estiver disponível:
   `voiceIsolation: true` como alternativa, nunca junto.)
5. **Decidir o destino da porta de ruído** depois do Krisp — remover ou
   retunar, mas não deixar como está.
6. **A/B da recepção** (grafo vs. `<audio>` + `setSinkId`) — só se o passo 1
   mostrar concealment alto.

Os itens 2 e 3 são correções pequenas e independentes: dá para fazer agora
sem esperar decisão sobre o Krisp.

**Estado desta lista:** 2, 3, 4 e 5 estão feitos (ver as duas seções
"Feito"). Sobram, em ordem:

1. **O grupo inteiro na versão nova.** É pré-condição para julgar o resultado,
   não uma tarefa técnica — sem isso o teste mede a máquina antiga do colega.
2. **O teste do "Transmitir som" desmarcado**, se o eco tiver sobrevivido ao
   fim do segundo `AudioContext`. Só ele separa a hipótese do loopback.
3. **Medição de áudio no stats** (`concealedSamples`, `packetsLost`,
   `audioLevel`) — continua sendo meia hora que tira o resto da adivinhação.
4. **A/B da recepção**, só se o item acima mostrar concealment alto.
