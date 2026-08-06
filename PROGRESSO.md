# Registro de progresso — CALL

Diário contínuo das iterações de performance e interface. Cada entrada
registra o que foi medido na compilação real, não em estimativa.

Ambiente das medições: Windows 11 Pro 26200, Rust 1.97.1, WebView2 151.0.4129.59,
20 núcleos lógicos.

---

## Iteração 1 — Esqueleto Tauri e primeira compilação

**Construído:** workspace Rust com dois membros (`src-tauri`, `servidor`),
front-end em HTML/CSS/JS puro sem empacotador, perfil de release agressivo
(`opt-level="z"`, `lto`, `codegen-units=1`, `panic="abort"`, `strip`).

**Medido na compilação real:**

| Métrica | Valor |
| --- | --- |
| `call.exe` | 3,77 MB |
| Instalador NSIS | 1,44 MB |
| `call.exe` em repouso | 30,3 MB *working set* / 6,1 MB privado |
| Árvore WebView2 | ~370 MB em 6 processos |

**Veredito do crítico:** *reprovado por performance.* O executável ficou em
30,3 MB de *working set*, acima do teto de 30 MB, e a árvore do WebView2
subiu a 370 MB sem necessidade.

---

## Iteração 2 — Corte de memória

**Alterado:**

1. `--renderer-process-limit=1` e desligamento de serviços de fundo do
   Chromium (`--disable-background-networking`, `--disable-component-update`,
   `--disable-sync`, `--disable-breakpad`) via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
2. `EmptyWorkingSet` 4 s após a janela assentar e novamente quando a janela
   perde o foco — devolve ao sistema as páginas usadas só na partida.
3. Servidor de sinalização compilado com `windows_subsystem = "windows"`,
   eliminando a janela de console (e o `conhost.exe` que a acompanhava).

**Medido:**

| Métrica | Antes | Depois |
| --- | --- | --- |
| `call.exe` em repouso (*working set*) | 30,3 MB | **1,3 MB** |
| `call.exe` em repouso (privado) | 6,1 MB | 5,8 MB |
| Árvore completa em repouso | ~370 MB | 312 MB |
| Processos na árvore | 8 | 7 |

**Veredito:** *aprovado em performance.* O executável ficou muito abaixo do
teto de 30 MB. Ressalva registrada: o WebView2 é um componente compartilhado
do sistema operacional e responde pelo restante — ver "Limites honestos".

---

## Iteração 3 — Permissão de microfone

**Problema encontrado:** ao inspecionar o código do `wry` 0.55 confirmou-se
que ele só concede automaticamente a permissão de área de transferência.
O microfone cairia no diálogo nativo do WebView2 a cada chamada.

**Alterado:** handler próprio de `PermissionRequested` via `webview2-com`,
concedendo apenas `COREWEBVIEW2_PERMISSION_KIND_MICROPHONE`. Todas as demais
permissões seguem o comportamento padrão.

**Verificado na compilação real:** entrar em um grupo captura o microfone sem
exibir nenhum diálogo.

---

## Iteração 4 — Falha de conexão em produção

**Sintoma:** na compilação real, entrar em um grupo falhava com "Não foi
possível falar com o servidor", embora o servidor respondesse normalmente a
um cliente Node.

**Diagnóstico:** foi adicionado um ouvinte de `securitypolicyviolation` na
interface. Ele revelou bloqueio em `connect-src`.

**Causa raiz:** a política declarava `ws://*`. Em CSP, uma origem sem porta
casa somente com a porta padrão do esquema — ou seja, `ws://*` autorizava
apenas a porta 80, e o servidor roda na 8787.

**Correção:** `ws://*:*` e `wss://*:*`.

O ouvinte de violação foi mantido no código: sem ele, qualquer bloqueio
futuro apareceria apenas como uma falha genérica de conexão.

---

## Iteração 5 — Transmissão de tela aparentemente quebrada

**Sintoma:** com duas instâncias reais na mesma sala, quem recebia via o
quadro da transmissão montado e rotulado corretamente, porém sempre preto.

**Investigação:** o teste automatizado da malha foi estendido para medir
`bytesReceived` e `framesDecoded` de vídeo. Ele passou — vídeo trafegava e
era decodificado no mesmo motor Chromium que o aplicativo usa. Instrumentando
então o aplicativo real com as mesmas estatísticas, o quadro passou a exibir
`IN v 117044B dec=16`, e a imagem apareceu.

**Conclusão:** não havia defeito. O preto vinha da automação de teste, que
selecionava no seletor nativo uma janela do próprio CALL — recursão de
espelho, que colapsa para preto em poucos níveis. Ao compartilhar uma janela
externa (Paint), a imagem chega íntegra.

**Lição registrada:** a asserção de "recebeu a trilha" não prova exibição.
Os testes agora verificam bytes recebidos e quadros decodificados.

---

## Iteração 6 — Acabamento visual

**Alterado:** acento reduzido de `#6d7cf0` para `#5f6ad9` e todas as cores
derivadas realinhadas. O tom anterior puxava para um roxo saturado que
destoava do restante da paleta grafite.

**Restante da inspeção visual — aprovado:** tema escuro em tons acinzentados
profundos (`#0e0f11` → `#1f2328`), tipografia Segoe UI Variable com escala
contida, cantos de 7–14 px, bordas de 1 px a 6% de branco em vez de sombras,
transições de 140 ms com curva própria, e respeito a
`prefers-reduced-motion`.

---

## Iteração 7 — Revisão crítica do front-end

Revisão linha a linha de `app.js` e `rtc.js` procurando o que estava errado,
e não o que estava faltando. Seis correções:

**1. Teto de banda na transmissão de tela.** O `RTCRtpSender` da tela subia o
bitrate até onde a rede aguentasse, e é a CPU de quem transmite que paga a
conta da codificação. `maxBitrate` de 1,2 Mbps e `maxFramerate` de 15 aplicados
em `limitarTela`, tanto no elo criado com a tela já ativa quanto no elo que
recebe a tela depois (`publicarTela`).

**2. Queda de par sem aviso do servidor.** Se a máquina de alguém hibernava ou
a rede caía, o WebSocket do servidor podia continuar de pé e ninguém era
removido da lista — o participante ficava listado como presente e mudo para
sempre. `onconnectionstatechange` agora chega até a aplicação
(`aoEstadoDaConexao`), que trata `failed` e `closed` como saída.

**3. Vazamento no grafo de áudio.** Cada renegociação reentrega a mesma trilha
por `ontrack`, e `observarVoz` criava um `MediaStreamAudioSourceNode` novo a
cada vez sem soltar o anterior. Os nós antigos ficavam vivos no `AudioContext`
pelo resto da chamada. Agora `esquecerVoz` desconecta fonte e analisador antes
de substituir, na saída do participante e no fim da chamada — e desliga o
cronômetro quando não resta ninguém a medir.

**4. Detecção de fala refeita.** Media do espectro (`getByteFrequencyData`)
com limiar único: qualquer chiado de fundo mantinha o valor acima do corte, e
as pausas entre sílabas faziam a marca piscar. Trocado por valor eficaz no
domínio do tempo, com limiar de entrada (0,022) mais alto que o de saída
(0,012) e permanência de 420 ms.

**5. Marca de fala apagando sozinha.** `desenharParticipantes` recria a lista
inteira a cada mudança de estado, e o `data-falando` ia junto — bastava alguém
silenciar o microfone para a marca de quem estava falando sumir. O estado
agora vive no medidor e é reaplicado no desenho. De quebra, as linhas ficam
guardadas em um `Map` em vez de serem reencontradas por `querySelector` com o
id do par interpolado no seletor a cada 120 ms.

**6. Medidor de memória removido.** Era instrumento de desenvolvimento exibido
na barra da sala, e o comando `memoria_mb` que o alimentava já havia saído do
`lib.rs` — o painel sobrevivia apenas para se esconder sozinho ao primeiro
erro. Saiu da interface, do CSS e do JS.

Também saiu o `EmptyWorkingSet` da iteração 2. Ele não reduzia consumo: forçava
as páginas para o arquivo de paginação, e o número de 1,3 MB que ele produzia
media a mentira, não o aplicativo. As medições abaixo foram refeitas sem ele.

**Verificado:** 15 verificações do protocolo de sinalização e 14 da malha
WebRTC no motor Chromium real — todas passam. Compilação de release refeita,
instalador em 1,44 MB.

---

## Iteração 8 — Atualização automática e página do projeto

**Construído:** o aplicativo passou a procurar versões novas sozinho. Consulta
o manifesto da última release a cada meia hora, mostra um cartão discreto e
instala com um clique. A verificação e a instalação ficaram do lado do Rust
(`procurar_atualizacao`, `instalar_atualizacao`), não do JavaScript: assim não
dependem de um pacote npm em um projeto que não tem empacotador.

O pacote é assinado com uma chave que não está no repositório. O aplicativo
confere a assinatura contra a chave pública embutida nele antes de executar
qualquer coisa — um instalador trocado no caminho é recusado.

**Custo em disco, medido:** o plugin com as opções padrão levaria o instalador
de 1,44 MB a **2,03 MB** — ele arrasta `rustls` com os certificados embutidos e
`zip`/`tar`/`flate2` para formatos de pacote que o Windows não usa. Com
`default-features = false, features = ["native-tls"]` o TLS passa a vir do
Schannel do próprio sistema e o instalador ficou em **1,61 MB**. O atualizador
custou 0,17 MB, não 0,59 MB.

**Três defeitos encontrados só porque foi testado de verdade:**

1. *A compilação travava sem dizer nada.* A chave gerada com `-p ""` sai
   criptografada, e o `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` vazio não chega ao
   processo — no Windows não existe variável de ambiente com valor vazio. O
   build parava esperando uma senha digitada que nunca viria. A chave foi
   regerada com senha real, guardada ao lado dela em `~/.tauri/`.

2. *O `latest.json` saía com BOM.* `Set-Content -Encoding utf8` no PowerShell
   5.1 grava a marca de ordem de bytes, e o leitor de JSON recusa o arquivo
   inteiro por causa dela. O sintoma era o pior possível: nenhum erro, nenhum
   aviso, apenas nada acontecendo. O mesmo BOM quebrou o `tauri.conf.json` em
   outra etapa.

3. *O gradiente do diagrama do site não aparecia.* Numa linha horizontal a
   caixa delimitadora tem altura zero, e um gradiente em `objectBoundingBox`
   simplesmente não renderiza. Resolvido com `gradientUnits="userSpaceOnUse"`.

**Verificado na compilação real:** uma versão 0.0.9 compilada localmente
detectou a 0.1.0 publicada e exibiu o cartão de atualização. É por isso que os
dois primeiros defeitos apareceram — a asserção de que "o código está certo"
não prova que a atualização chega.

**Página do projeto:** `docs/`, servida pelo GitHub Pages. A maquete do topo
não é captura de tela: é a interface em HTML, que se comporta como o
aplicativo. O fundo é a topologia em malha do projeto, projetada em
perspectiva. O botão de download pergunta ao GitHub qual é o instalador mais
recente, porque o nome do arquivo carrega a versão e um link fixo apontaria
para um arquivo que deixa de existir na publicação seguinte.

**Publicação:** `publicar.ps1` faz o caminho inteiro — compila assinado, monta
o manifesto e cria a release.

---

## Iteração 9 — O desvio desnecessário na publicação do site

**Sintoma:** o construtor do GitHub Pages falhava e o endereço respondia 404.
A conclusão registrada na hora foi "falha sem log utilizável", e a resposta foi
trocar o construtor padrão por um fluxo próprio do GitHub Actions, que ao menos
mostraria o erro.

**O que os horários realmente diziam:** a causa do 404 era o Jekyll, e ela já
tinha sido corrigida por `docs/.nojekyll`. A primeira compilação depois dessa
correção *passou* — é dela que vem o site no ar. As execuções anteriores não
tinham falhado por defeito: cada envio novo cancela a compilação em andamento,
e "cancelada" foi lido como "falhou". O fluxo por Actions entrou depois disso,
sem que a correção tivesse sido observada.

**E o desvio custou caro:** o `deploy-pages` ficou dez minutos em
`deployment_queued` até estourar o tempo; a segunda tentativa foi cancelada por
disputar o mesmo commit da primeira. Duas falhas contra um caminho padrão que
já funcionava.

**Corrigido:** origem do Pages de volta ao ramo `main` em `/docs`, e o fluxo do
Actions removido.

**Verificado:** os bytes servidos em `alanaraujo-bit.github.io/CALL/` são
idênticos aos de `docs/index.html`, e `estilo.css` e `site.js` respondem 200.

**Lição registrada:** *cancelada* não é *falhou*, e uma correção só está provada
depois que a execução seguinte é observada. Trocar de ferramenta antes disso
troca um problema já resolvido por um problema novo.

**Release conferida de ponta a ponta:** o `latest.json` publicado não tem BOM, o
identificador da chave da assinatura é o mesmo da chave pública embutida em
`tauri.conf.json` (`0ff7228b0ddd9605`), a assinatura Ed25519 confere contra o
instalador publicado, e o SHA-256 do arquivo na release é igual ao do binário
compilado localmente.

---

## Estado final medido

### Peso em disco

| Artefato | Tamanho |
| --- | --- |
| Instalador `CALL_0.1.0_x64-setup.exe` | **1,61 MB** |
| `call.exe` | 3,77 MB |
| `sinalizacao.exe` (sidecar) | 0,39 MB |

### Memória

Medido sem `EmptyWorkingSet`, contando apenas os processos descendentes de
`call.exe` — a máquina tinha outros aplicativos WebView2 abertos, e uma
contagem por nome de processo somaria os deles.

| Cenário | `call.exe` | Árvore completa |
| --- | --- | --- |
| Em repouso | **26 MB** WS / 5,7 MB privado | 338 MB WS / 172 MB privado (7 processos) |
| Em chamada, 2 participantes | ~4 MB WS / 6 MB privado | — |
| Transmitindo a tela | ~7 MB WS / 6 MB privado | 665 MB WS (9 processos) |

As duas últimas linhas vêm da iteração 2 e ainda incluíam o `EmptyWorkingSet`;
o número de `call.exe` nelas está subestimado pelo mesmo motivo e precisa ser
remedido em uma chamada real.

### CPU

Transmitindo uma janela de conteúdo estático, a árvore consumiu 0,1% de um
núcleo em uma janela de 10 s. O número é baixo porque o WebRTC praticamente
não codifica quadros quando a imagem não muda; conteúdo em movimento consome
proporcionalmente mais.

### Limites honestos

O teto de 30 MB é cumprido pelo executável do CALL, que é o que o projeto
controla — com 26 MB, e não com a folga que o `EmptyWorkingSet` aparentava dar.
O WebView2 — o motor Chromium do próprio Windows — responde pelo
restante da árvore e não pode ser reduzido a essa faixa por nenhum aplicativo
que renderize HTML. O ganho frente ao Electron continua real e grande: o
Electron embarcaria o seu próprio Chromium e um runtime Node, resultando em
instalador na casa das dezenas de megabytes e consumo tipicamente maior,
enquanto aqui o instalador tem 1,61 MB e reaproveita um componente que já
existe no sistema.

---

## Testes automatizados

| Suíte | Comando | Cobertura |
| --- | --- | --- |
| Protocolo de sinalização | `node testes/sinalizacao.test.mjs` | 15 verificações: entrada, lista de pares, encaminhamento de sinais, difusão de estado, isolamento entre salas, saída |
| Malha WebRTC | `powershell -File testes/rodar-malha.ps1` | 14 verificações no próprio motor Chromium: conexão nos dois lados, áudio com bytes recebidos, vídeo com quadros decodificados, renegociação ao encerrar a tela, limpeza de elos |

Ambas passam integralmente na última execução.
