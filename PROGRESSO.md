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

## Iteração 10 — Publicação na Vercel a cada envio

**Construído:** o site em `docs/` também é publicado pela Vercel, ligada ao
repositório. Cada envio para `main` dispara uma construção sem nenhum comando
manual.

**A armadilha evitada:** o `package.json` deste repositório declara
`"build": "tauri build"`. A Vercel executa o script de construção do projeto
por padrão — ela teria tentado compilar o aplicativo Rust inteiro, em um
servidor Linux sem o alvo do Windows, para publicar três arquivos estáticos.
`vercel.json` zera os comandos de instalação e de construção e aponta a saída
direto para `docs/`; não há nada a compilar.

**Do lado do envio:** `.vercelignore` mantém fora `target/`, `node_modules/` e
`build.log`. Sem ele, um deploy pela linha de comando enviaria a árvore de
compilação do Rust inteira.

**Sobre as URLs:** os endereços com o sufixo da equipe
(`call-git-main-aionixdev.vercel.app`) respondem 302 para o login da Vercel —
é assim que a Proteção de Implantação funciona, e ela não alcança o domínio
público do projeto. Nenhuma configuração precisou ser afrouxada.

**Verificado:** o envio do commit `a2fb540` gerou sozinho uma implantação de
produção (`Ready`, 1 s), e `index.html`, `estilo.css` e `site.js` servidos em
`call-rho-dusky.vercel.app` são byte a byte idênticos aos de `docs/`. Os
cabeçalhos `X-Content-Type-Options` e `Referrer-Policy` declarados no
`vercel.json` chegam na resposta.

**Por que os dois:** o GitHub Pages continua no ar com o mesmo conteúdo. Publicar
nos dois custa zero — a mesma pasta, dois consumidores — e nenhum dos dois é
ponto único de falha para a página que oferece o instalador.

---

## Iteração 11 — De salas planas a grupos com canais

**Construído:** o modelo do aplicativo mudou de "uma sala por nome" para
grupos persistentes com categorias, canais de texto e canais de voz. O
servidor deixou de ser só um encaminhador de sinais: agora guarda a estrutura
dos grupos e o histórico dos canais de texto.

**Persistência sem banco de dados.** O servidor é o mesmo binário que viaja
dentro do instalador como sidecar, e o projeto é medido em quilobytes:
embutir um SQLite custaria cerca de 1 MB para guardar algumas dezenas de
linhas de estrutura. São dois arquivos, com perfis de escrita opostos —
`grupos.json`, reescrito inteiro por arquivo temporário e *rename* a cada
mudança, e `mensagens.jsonl`, só acréscimo, compactado quando passa de 20 mil
linhas. Sem a variável `DADOS` o servidor funciona igual e esquece tudo ao
fechar, que é o caso do sidecar numa partida na rede local.

**A malha passou a ser por canal, e não por grupo.** Estar no mesmo servidor
não é estar na mesma conversa: o encaminhamento de sinais só acontece entre
quem está no mesmo canal de voz, e o microfone só é pedido ao entrar num
canal de voz — ler o histórico de um canal de texto não é motivo para abrir o
microfone.

**Convite em vez de nome combinado.** O grupo é identificado por um código de
dez caracteres sorteado com entropia do sistema (cerca de 49 bits), num
alfabeto sem `I`, `L`, `O`, `0` e `1` — os caracteres que se confundem lidos
em voz alta ou copiados de uma captura de tela.

**O campo `dono` deixou de ser enfeite.** Ele já existia no modelo e não era
verificado em lugar nenhum: qualquer pessoa com o convite podia apagar canais
e histórico do grupo inteiro. O servidor agora recusa alterações de estrutura
de quem não é o dono, e a interface esconde os botões — mas é a recusa do
servidor que vale, porque esconder botão não é permissão.

### Três defeitos encontrados por medição, não por leitura

**1. A negociação perfeita não tinha quem desempatasse.** A polidez vinha de
quem tinha pedido para abrir o elo. Parece equivalente a um desempate estável
e não é: quando a oferta do outro lado chega antes de eu abrir o elo,
`receberSinal` o abre como respondedor — e os dois lados ficam polidos. Sem
ninguém para ceder, a colisão de ofertas travava a conexão em `stable` e nada
mais trafegava. A polidez passou a sair da comparação dos identificadores,
que os dois lados enxergam igual.

**2. O rollback do Chromium deixa a coleta de candidatos ICE parada.** Com o
desempate corrigido, o lado polido fazia o rollback previsto pela negociação
perfeita — e daí em diante não emitia um único candidato, ficando em
`gathering` para sempre. O rollback explícito consertava, mas ele redispara
`negotiationneeded`, e a segunda oferta recriava a colisão: o teste passou
duas vezes e falhou na terceira.

A correção não foi um rollback melhor, foi não precisar dele: quem sabe de
antemão que só vai responder simplesmente não oferta. Assim a colisão de
abertura — o único caso em que ela é garantida, porque os dois lados adicionam
a trilha local ao mesmo tempo — deixa de existir. A negociação perfeita
continua no lugar para as renegociações seguintes, onde a colisão é rara e o
estado, estável. Quatro execuções seguidas da suíte passaram.

Houve ainda uma correção a mais que se provou errada e foi desfeita. O
raciocínio parecia sólido: se o ouvinte de `negotiationneeded` ignora o
evento, uma tela publicada naquele instante ficaria sem negociação para
sempre — então a pendência foi anotada para ser ofertada depois. A suíte
respondeu na hora: a conexão fechava, o áudio fluía, e o vídeo deixava de
chegar. A premissa estava errada. A marca de "precisa negociar" só é baixada
por um `setLocalDescription` bem-sucedido, e o navegador redispara o evento
sozinho quando o estado volta a `stable`; ignorar não perde nada. A anotação
apenas acrescentava uma renegociação a mais logo depois da resposta, e era ela
que atrapalhava. Sem a suíte, seria uma proteção plausível contra um problema
inexistente — cobrando um preço real.

**3. Uma coluna a mais que o layout declarava.** A interface passou a ter
quatro colunas, e a regra de janela estreita que escondia a lista de presentes
estava no topo da folha de estilo — perdendo, por ordem, para o `display: flex`
que a própria coluna declara depois. O resultado não foi um erro visível: a
quarta coluna desceu para uma segunda linha do *grid*, e as três de cima
encolheram para caber. As regras responsivas foram para o fim da folha, e o
`grid-template-rows: 100%` faz um excedente futuro estourar de forma visível
em vez de se acomodar em silêncio.

Também apareceram, e foram corrigidos: `[hidden]` não escondia nada, porque o
`display` das regras de componente vence o da folha do navegador; e o código
do convite era truncado justamente na parte que se copia.

### Verificado

| O quê | Como |
| --- | --- |
| Protocolo do servidor | 46 verificações, incluindo persistência entre execuções: o servidor é morto e reaberto, e grupo, dono e histórico voltam |
| Malha WebRTC | 17 verificações no motor Chromium real, medindo bytes recebidos e quadros decodificados — não apenas "a trilha chegou" |
| Aplicativo real | Duas instâncias: criação de grupo, convite, árvore de canais, mensagem de texto entregue de uma janela a outra, e os dois participantes aninhados sob o canal de voz |

A ressalva honesta: o tráfego de mídia é medido na suíte da malha, que roda o
mesmo `rtc.js` no mesmo motor. O teste de duas janelas prova a sinalização, a
interface e a associação ao canal de voz — não mede bytes de áudio.

Antes de acusar o código, foi medido o ambiente: dois pares ligados à mão na
mesma página, sem servidor nenhum, fecharam ICE com candidatos reais. Só
depois disso a investigação foi para dentro do projeto.

**Custo em disco:** o instalador foi de 1,61 MB para **1,65 MB**, e o servidor
de 0,39 MB para 0,48 MB — o preço de `getrandom`, da persistência e do modelo
de grupos.

### Publicação da v0.2.0

A release foi criada e conferida de ponta a ponta: o instalador publicado é
idêntico byte a byte ao compilado localmente (SHA-256), a assinatura no
`latest.json` é a mesma do arquivo `.sig`, e o identificador da chave que
assinou é `0ff7228b0ddd9605` — o mesmo embutido em `tauri.conf.json`, que é o
que faz as instalações da v0.1.0 aceitarem a atualização.

O `publicar.ps1` precisou de um conserto no caminho. O `tauri` escreve
andamento em stderr mesmo quando dá tudo certo e, no PowerShell 5.1 com
`ErrorActionPreference = "Stop"`, cada uma dessas linhas vira erro terminante:
a publicação morria **depois** de uma compilação bem-sucedida e assinada. É o
mesmo tropeço que a iteração 8 já tinha registrado em outro ponto do roteiro.
Agora só o código de saída decide se a compilação falhou.

**A publicação espelhada na Vercel caiu.** `call-rho-dusky.vercel.app` responde
`DEPLOYMENT_NOT_FOUND` — não é atraso de propagação, é ausência do projeto do
lado da plataforma. O `vercel.json` segue no repositório e nada no código
mudou; a religação depende do painel. O GitHub Pages está no ar, servindo
bytes idênticos aos de `docs/`, e passou a ser o endereço principal no README.
A iteração 10 dizia que nenhum dos dois seria ponto único de falha para a
página que oferece o instalador — foi exatamente para este dia.

---

## Iteração 12 — O servidor sai da máquina de quem conversa

**Motivo:** para falar com alguém era preciso que uma das pessoas clicasse em
"Hospedar", deixasse a máquina ligada e passasse o próprio IP. Isso não é um
detalhe de configuração, é o produto pedindo que o usuário seja administrador
de servidor.

**Construído:** o servidor de sinalização passou a rodar hospedado, no Railway,
em `wss://sinalizacao-production.up.railway.app`. O aplicativo já vem apontado
para ele; "Usar um servidor próprio" virou uma seção recolhida, e "Hospedar"
continua lá para quem quiser rodar na rede local.

O servidor praticamente não precisou mudar para isso — ele já lia `PORT` do
ambiente, já lia `DADOS` para a pasta de dados, já escutava em `0.0.0.0` e já
respondia a um GET comum para não ser dado como morto pelo health check. Metade
do trabalho estava feita desde a iteração 1.

**A imagem é o binário e mais nada.** Como o servidor não fala TLS — quem
termina TLS é a borda do Railway — o binário é ligado estaticamente contra a
musl e a imagem final parte de `scratch`. Não há sistema operacional dentro
dela. O `Dockerfile` reescreve a raiz do workspace para conter só `servidor`:
o membro `src-tauri` arrastaria o Tauri inteiro e as bibliotecas de interface
do Linux, que não têm nada a ver com este binário.

A persistência é um volume montado em `/dados`. Foi verificada do jeito que
tem de ser: criar um grupo, reiniciar o serviço, e entrar no grupo de novo
pelo código. Ele voltou com nome, dono e histórico.

### O defeito que só a hospedagem revelou

Com tudo no ar, o aplicativo real dizia **"Não foi possível falar com o
servidor"** — enquanto um cliente Node conectava ao mesmo endereço sem
reclamar.

A primeira suspeita foi a CSP, que já tinha mordido este projeto na iteração 4.
Era falsa: autorizar o host explicitamente não mudou nada, e o ouvinte de
`securitypolicyviolation` seguia calado. A segunda medição separou as coisas —
o mesmo motor Chromium, fora do Tauri e sem CSP nenhuma, também não conectava.
Logo, não era o Tauri: era navegador contra Node.

A causa estava em `responder_se_for_http`, no nosso servidor. Ele decidia se a
conexão era WebSocket **espiando os primeiros 512 bytes** e procurando
`upgrade: websocket`. O aperto de mão do Node é curto e cabe. O de um navegador
é bem maior — e o proxy do Railway ainda acrescenta os `X-Forwarded-*`. O
`Upgrade` era empurrado para além da janela, o servidor concluía "isto é um GET
comum", respondia texto e fechava. Do lado do cliente isso aparece como código
1006, que não diz nada.

Pior: o código já tinha a intenção certa — *"só decide que não é WebSocket com
o cabeçalho inteiro em mãos"* — mas a condição `lidos == espiada.len()`
desfazia exatamente isso, tratando "a janela encheu" como "o cabeçalho acabou".
O comentário estava certo e o código não o cumpria.

Agora a janela vai a 8 KB, a decisão negativa só é tomada depois do `\r\n\r\n`,
e a busca pelo `Upgrade` acontece no bloco de cabeçalhos e não no que couber.

**Por que os testes não pegaram:** todos usavam o `WebSocket` do Node, cujo
aperto de mão tem uns 200 bytes. A suíte ganhou um teste que faz o aperto de
mão à mão, com `User-Agent` longo e `X-Forwarded-*`, na ordem em que um
navegador manda — e outro que confere que um GET comum continua recebendo 200,
para o health check não quebrar na próxima vez.

### Verificado

- 49 verificações do protocolo, incluindo as três novas do aperto de mão.
- O motor Chromium abre `wss://` no servidor hospedado e cria grupo.
- O aplicativo real, compilado, conecta na nuvem e cria grupo — sem nada
  rodando na máquina.
- O volume sobrevive a um reinício do serviço.

**Ressalva:** o `duas-instancias.ps1` passou a apontar para o servidor local de
propósito, para não depender da internet nem criar grupos de verdade no
servidor que as pessoas usam. Nesta execução a segunda instância ficou com o
apelido da primeira — as duas compartilham o perfil do WebView2, e a digitação
do apelido de B não pegou. Isso torna a captura confusa, mas não afeta o que o
teste prova: texto e voz atravessam entre duas janelas distintas.

---

## Estado final medido

### Peso em disco

| Artefato | Tamanho |
| --- | --- |
| Instalador `CALL_0.1.0_x64-setup.exe` | **1,65 MB** |
| `call.exe` | 4,26 MB |
| `sinalizacao.exe` (sidecar) | 0,48 MB |

### Memória

Medido sem `EmptyWorkingSet`, contando apenas os processos descendentes de
`call.exe` — a máquina tinha outros aplicativos WebView2 abertos, e uma
contagem por nome de processo somaria os deles.

| Cenário | `call.exe` | Árvore completa |
| --- | --- | --- |
| Em repouso | **26 MB** WS / 5,7 MB privado | 338 MB WS / 172 MB privado (7 processos) |
| Num grupo, 2 participantes (iteração 11) | **31,4 MB** WS / 7,3 MB privado | — |
| Num canal de voz, uma instância (iteração 11) | **31,6 MB** WS / 7,7 MB privado | — |
| Transmitindo a tela | ~7 MB WS / 6 MB privado | 665 MB WS (9 processos) |

As medições de dois participantes vêm da iteração 11 e são reais. A linha da
transmissão de tela ainda vem da iteração 2, quando o `EmptyWorkingSet`
mascarava o número: ela está subestimada e precisa ser remedida.

O crescimento de 26 MB para 31 MB entre uma janela vazia e uma janela em um
grupo é o custo da conversa: a árvore de canais, a lista de mensagens e o
`AudioContext` da detecção de fala.

### CPU

Transmitindo uma janela de conteúdo estático, a árvore consumiu 0,1% de um
núcleo em uma janela de 10 s. O número é baixo porque o WebRTC praticamente
não codifica quadros quando a imagem não muda; conteúdo em movimento consome
proporcionalmente mais.

### Limites honestos

O teto de 30 MB é cumprido pelo executável do CALL em repouso, com 26 MB — e
não com a folga que o `EmptyWorkingSet` aparentava dar. Em uso, num grupo com
outra pessoa, ele passa para 31 MB e portanto **estoura o teto por pouco**.
Registrado como está, e não arredondado para dentro da meta: o número que
importa é o do aplicativo trabalhando, não o da janela vazia.
O WebView2 — o motor Chromium do próprio Windows — responde pelo
restante da árvore e não pode ser reduzido a essa faixa por nenhum aplicativo
que renderize HTML. O ganho frente ao Electron continua real e grande: o
Electron embarcaria o seu próprio Chromium e um runtime Node, resultando em
instalador na casa das dezenas de megabytes e consumo tipicamente maior,
enquanto aqui o instalador tem 1,65 MB e reaproveita um componente que já
existe no sistema.

---

## Testes automatizados

| Suíte | Comando | Cobertura |
| --- | --- | --- |
| Protocolo de sinalização | `node testes/sinalizacao.test.mjs` | 46 verificações: criação de grupo, convite recusado, entrada por código, voz isolada por canal, encaminhamento de sinais, difusão de estado, mensagens e histórico, regra de dono, remoção que tira gente da voz, e persistência entre execuções do servidor |
| Malha WebRTC | `powershell -File testes/rodar-malha.ps1` | 17 verificações no próprio motor Chromium: entrada no canal de voz, conexão nos dois lados, áudio com bytes recebidos, vídeo com quadros decodificados, renegociação ao encerrar a tela, limpeza de elos |

Ambas passam integralmente na última execução.

Além delas, dois roteiros dirigem a janela real e deixam capturas em
`testes/capturas`: `testes/inspecionar.ps1` (uma instância, da tela de entrada
até o canal de voz) e `testes/duas-instancias.ps1` (duas janelas, com mensagem
de texto entregue de uma a outra). Eles clicam por coordenada, então quebram
quando o layout muda de altura — e foi assim que o convite truncado e a coluna
que descia de linha apareceram.
