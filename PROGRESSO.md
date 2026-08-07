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

## Iteração 13 — O convite vira um link

**Motivo:** convidar alguém era mandar dez caracteres por WhatsApp e explicar o
resto — baixe ali, abra, clique em "Entrar com convite", cole isto. Cada passo
desses é um lugar onde a pessoa desiste.

**Construído:** o cartão do convite passou a copiar um endereço, e não o
código. O endereço abre uma página do próprio site (`docs/entrar/`) que mostra
o grupo e o convite, com dois botões: "Abrir no CALL", que entra no grupo pelo
protocolo `call://`, e o instalador, para quem ainda não tem o aplicativo.
O código continua acessível em "Copiar código do convite", no menu do grupo —
ele é o que se dita por voz.

**Por que o link não é `call://` direto:** um esquema que ninguém registrou não
abre nada e não explica nada. A página no meio é o que distingue "não está
instalado" de "não funcionou", e é ela que sabe oferecer o instalador. Sem
servidor por trás, ela descobre isso do jeito possível: dispara o protocolo e
observa se a aba perdeu o foco.

**O que sustenta o `call://` do lado do aplicativo:** o esquema é registrado
pelo instalador NSIS a partir do `tauri.conf.json`, e também em tempo de
execução — sem isso ele não existiria em uma máquina onde o CALL nunca foi
instalado, que é o caso de qualquer compilação de desenvolvimento. O código
vem de `call://entrar/CODIGO`, é validado no Rust (dez caracteres
alfanuméricos, e nada mais atravessa: o valor vem de um clique em uma página
qualquer da internet) e entregue à interface por um caminho único — um evento
avisa que existe convite, e um comando o entrega e o esquece. Se o aviso e a
leitura da partida se cruzarem, o segundo encontra a vaga vazia em vez de
entrar no grupo duas vezes.

**O convite sabe esperar.** Um link clicado por quem nunca abriu o CALL cai na
tela de entrada, sem apelido escolhido e sem servidor confirmado. Entrar no
grupo ali seria aparecer para os outros como alguém sem nome: o convite fica
guardado e só é usado quando a tela de entrada é preenchida.

### O preço da instância única, registrado

Para um link clicado com o CALL aberto chegar à janela que já existe, o
aplicativo passou a ser de instância única — sem isso, cada clique abriria uma
janela nova. O custo é direto: **duas janelas na mesma máquina deixaram de ser
possíveis**, e é exatamente disso que depende o `duas-instancias.ps1`, o
roteiro que prova texto e voz atravessando entre duas pessoas.

A saída é uma variável de ambiente explícita (`CALL_INSTANCIAS_MULTIPLAS`), que
só os roteiros de teste usam. Preferiu-se isso a descobrir o problema na
próxima vez que alguém rodasse a suíte.

### Verificado

Um roteiro novo, `testes/convite.ps1`, dirige a janela real e prova os dois
caminhos — oito verificações, todas automáticas:

| O quê | Como |
| --- | --- |
| Link com o CALL aberto | O aplicativo está no grupo "estudio"; o `call://` do grupo "equipe" é disparado, nenhuma segunda instância aparece, e a janela original escreve uma mensagem que o servidor grava **num canal de equipe** |
| Link com o CALL fechado | Perfil zerado, aplicativo encerrado, o link abre o CALL sozinho, ele espera a tela de entrada ser preenchida e só então entra no grupo — provado do mesmo jeito, pelo canal em que a mensagem caiu |
| Registro do esquema | `HKCU\Software\Classes\call\shell\open\command` existe depois da primeira execução |

A pergunta "em qual grupo a janela está?" tem resposta visual na captura, mas
captura precisa de olho humano. A mensagem escrita depois de entrar responde
sozinha: ela cai num canal, e um canal pertence a um grupo só.

Também foram executadas, sem alterações: 46 verificações do protocolo, a malha
WebRTC no motor real, e o `duas-instancias.ps1` — que continua abrindo as duas
janelas graças à saída registrada acima.

**Duas armadilhas do próprio teste, e não do produto:**

1. *O clique caía no console.* O Windows recusa `SetForegroundWindow` vindo de
   um processo que não tem o foco, e recusa em silêncio: a janela do teste
   ficava por cima, o clique ia para ela, e a falha aparecia muito depois,
   como um grupo que não existia. O roteiro agora empresta a fila de entrada de
   quem está na frente (`AttachThreadInput`) e **confere** que a janela veio,
   em vez de presumir.

2. *O servidor local morria no meio da execução.* O sintoma era o pior
   possível — "Não foi possível falar com o servidor", que é indistinguível de
   um convite que não funcionou. A causa não estava no convite: todos os
   roteiros deste projeto começam matando `sinalizacao.exe`, então dois deles
   ao mesmo tempo se derrubam. O roteiro passou a conferir o servidor
   separadamente e a informar se ele saiu por defeito próprio ou foi morto de
   fora.

**Custo em disco, medido:** o instalador foi de 1,65 MB para **1,69 MB** — o
preço do `deep-link`, do `single-instance` e das imagens do instalador. O
`call.exe` foi de 4,26 MB para 4,32 MB.

### Acabamento que veio junto

- **Cartão de link do site.** `docs/index.html` ganhou as marcas Open Graph e
  Twitter completas, com uma imagem de 1200×630 gerada a partir do próprio HTML
  do site — o endereço colado numa conversa deixa de aparecer como texto cru.
- **Instalador com identidade.** Ícone próprio, cabeçalho (150×57) e lateral
  (164×314) no formato BMP de 24 bits que o NSIS exige.
- **`[hidden]` na folha do site.** O mesmo defeito já registrado na iteração 11
  para o aplicativo: regras de componente com `display` explícito vencem o
  `[hidden]` do navegador, que é de prioridade mais baixa. Sem a correção, a
  página de convite mostraria ao mesmo tempo o código e o aviso de link
  incompleto.

---

## Iteração 13 — Qualidade de áudio e de transmissão

**Motivo:** o áudio era o que o Chromium entregasse por conta própria, e a
transmissão de tela tinha exatamente um ajuste — o que estava escrito no código.
Nenhum dos dois era escolha de ninguém.

### O que estava errado, medido

O primeiro número da iteração é o mais importante: com o teto de banda declarado
em 32 kbps e depois em 128 kbps, o tráfego real de áudio foi de **32 para 129
kbps**. Isso confirma, e não estima, que a negociação padrão estava mesmo em
32 kbps mono — cerca de metade do que o Discord usa em canal comum.

Faltava, além disso: escolher microfone e alto-falante, volume de entrada,
volume por pessoa, qualquer filtro de ruído além do supressor do próprio motor,
e qualquer escolha de qualidade de tela.

### Áudio

O grafo passou a existir. Antes a captura ia crua do `getUserMedia` para a
conexão e o recebido ia cru para um `<audio>` solto; agora:

```
microfone → passa-alta 85 Hz → porta de ruído → destino → WebRTC
recebido  → ganho da pessoa → ganho geral → alto-falante
```

O `<audio>` continua no código, **mudo**, só para o Chromium não considerar o
fluxo remoto sem consumidor. Quem reproduz é o grafo — é o único jeito de haver
volume por pessoa e escolha de dispositivo de saída.

No Opus: `useinbandfec=1` (correção de erro em banda, que faz 5% de perda soar
como nada em vez de um talho), `usedtx=0`, `stereo=0` explícito, e o teto de
recepção declarado sempre em 128 kbps — **não** na qualidade escolhida. Foi uma
correção de raciocínio no caminho: a `fmtp` diz ao outro lado o que aceitamos
receber, então pôr a escolha do usuário nela faria quem escolhesse "econômico"
limitar a voz de todos os outros. Cada máquina governa o próprio envio, pelo
`maxBitrate` do remetente.

### A porta de ruído, e o defeito que só a medição pegou

O supressor do Chromium tira chiado estacionário e é cego para o resto: o "tom
de sala" — respiração, teclado, o eco baixo do cômodo — é inaudível sozinho e
insuportável somado a cinco pessoas.

A porta é um `AudioWorkletProcessor` com piso de ruído adaptativo: o limiar não
é um número que o usuário adivinha, ele acompanha o ruído medido da sala com uma
margem por cima, e o deslizante é só o chão dele.

**A primeira versão foi reprovada pelo próprio teste, e o motivo era
estrutural.** Ela era um expansor puro: a atenuação crescia com a distância
abaixo do limiar. Só que o limiar de fechamento é, por construção, `piso +
margem − histerese` — ou seja, fica poucos decibéis acima do ruído de fundo. O
ruído nunca chegava a ficar longe o bastante do limiar para ganhar mais do que
uns 5 dB de corte. O expansor mordia o próprio rabo. Medido: **5,7 dB** de
atenuação, quando a intenção eram 32.

E foi o mesmo número — 5,7 dB com a porta *desligada* — que denunciou o segundo
defeito: `port.postMessage` para ligar e desligar corria contra a renderização, e
a mensagem chegava depois do áudio já processado. Virou `AudioParam`, que vale na
hora.

Corrigidos os dois, separando quem decide (a máquina de estados, com histerese e
permanência) de quem suaviza (a rampa por amostra):

| Medida | Antes | Depois |
| --- | --- | --- |
| Ruído de sala atenuado | 5,7 dB | **32,0 dB** |
| Perda no miolo da fala | — | **0,00 dB** |
| Primeiros 25 ms de uma palavra | — | **0,9 dB** |
| Cauda depois da última sílaba | — | **0,0 dB** |
| Desligada | 5,7 dB de perda | **0,00 dB** |

Os dois números do meio são os que separam uma porta boa de uma que estraga a
voz: comer o ataque da palavra e fechar em cima da última sílaba são os defeitos
que fazem todo mundo desligar a supressão de ruído.

### Transmissão de tela

Quatro perfis, de 720p30 a 1440p60. E o codec deixou de ser o que viesse:

- **VP9** nos perfis de até 30 quadros, onde sobra CPU para pagar por ele e o
  ganho em imagem parada com texto é grande.
- **H.264** nos de 60 quadros, porque tem codificador em hardware em toda GPU
  dos últimos dez anos — é ele que mantém a promessa de ser leve num jogo.

Verificado que o VP9 foi realmente negociado, e não apenas pedido.

O som do sistema passou a acompanhar a tela, **numa trilha própria**, no mesmo
fluxo do vídeo. É o que permite ao outro lado distingui-lo da voz — e, sobretudo,
não passá-lo pelos filtros feitos para voz: um cancelador de eco e uma porta de
ruído destroem música e efeitos de jogo. Ele sai no teto do codec, com
`contentHint = "music"`.

Isso obrigou uma correção no ajuste do Opus: com duas seções de áudio na
descrição, a versão que mexia só na primeira deixaria o som do sistema com a
negociação padrão — justamente o que se quis corrigir.

### Ressalvas honestas

- **O som do sistema não foi verificado numa captura real do Windows.** O que a
  suíte prova é o encaminhamento: duas trilhas de áudio separadas, em fluxos
  distintos, com o bitrate e a dica certos. Se o seletor nativo entrega ou não o
  áudio depende do que se compartilha — a aplicação avisa quando a captura veio
  sem som.
- **Os perfis não foram medidos em rede ruim.** O que está provado é que o teto,
  os quadros e a política de degradação chegam ao codificador, e que trocar de
  perfil durante uma transmissão vale na hora.
- A porta de ruído foi medida com voz sintética — fundamental grave, dois
  harmônicos e modulação silábica —, não com voz humana gravada. Ela exercita o
  detector de forma parecida com voz; não é voz.

### Custo

O instalador compilado nesta iteração deu **1,71 MB**, contra 1,65 MB na
anterior. O número é honesto e a atribuição não seria: esta compilação carrega
também as mudanças de outra frente de trabalho no `lib.rs` e no `Cargo.toml`, e
os 60 KB não são todos do áudio.

O que é atribuível com precisão é o código: dois arquivos novos somando **20 KB**
(`audio.js` e `porta-de-ruido.js`), mais os acréscimos em `app.js`, `rtc.js`,
`index.html` e `estilo.css`. Zero dependências novas — a porta de ruído é
`AudioWorklet` do próprio motor, não uma biblioteca embarcada.

A janela com o painel aberto e o microfone em teste ficou em **31,6 MB** de
*working set* — a mesma faixa de uma janela num canal de voz, porque é o mesmo
`AudioContext`. Abrir os ajustes não custa memória nova.

### Verificado

| O quê | Como |
| --- | --- |
| Malha e mídia | 44 verificações no motor Chromium real, incluindo tráfego de áudio medido nos dois extremos de qualidade e o codec efetivamente negociado |
| Porta de ruído | Renderização fora do tempo real, em `OfflineAudioContext`: mesmo sinal sempre, resultado inteiro disponível para medir |
| Painel de ajustes | 22 verificações conduzindo a aplicação real num quadro, recolhendo os erros de execução dela |
| Protocolo | 49 verificações, sem regressão |
| Janela real | Painel aberto no WebView2, sob a CSP do Tauri, com os dispositivos de áudio da máquina |

### Publicação da v0.4.0

A release saiu com esta iteração e com o convite por link da outra frente de
trabalho, e foi conferida de ponta a ponta — não pelo fato de o `publicar.ps1`
ter terminado sem erro, que é coisa diferente de a atualização chegar:

| Conferência | Resultado |
| --- | --- |
| `latest.json` publicado sem marca de ordem de bytes | sim — é o defeito da iteração 8, que era silencioso |
| Assinatura no manifesto igual à do arquivo `.sig` | sim |
| Instalador publicado idêntico ao compilado (SHA-256) | sim, 1,71 MB |
| Identificador da chave que assinou | `0ff7228b0ddd9605` |
| Identificador embutido em `tauri.conf.json` | `0ff7228b0ddd9605` — é isto que faz as instalações da 0.3.0 aceitarem |

O identificador teve de ser lido dos bytes, e não do comentário: o Tauri escreve
`signature from tauri secret key` na primeira linha do arquivo, sem o
identificador. Ele está nos bytes 2 a 9 da segunda linha, e a primeira tentativa
de conferência — por expressão regular no comentário — deu "não batem" para duas
chaves iguais. Uma conferência que erra assim é pior do que nenhuma: ela ensina a
ignorar o próprio alarme.

---

## Iteração 14 — Perfil: quem você é para o grupo

**Motivo:** entrar no CALL era digitar um apelido e cair direto na aplicação.
Não havia nada seu ali dentro: a lista de participantes era um monte de
iniciais cinzas em círculos iguais, e a única coisa que distinguia uma pessoa
da outra era o texto do lado. Quem é quem numa coluna de 212 px é uma pergunta
que se responde em um décimo de segundo ou não se responde.

**Construído:** perfil com apelido, bio e mascote. Um painel próprio para
editar o seu, e um cartão para ver o de outra pessoa — clicar em alguém na
lista de presentes ou na árvore de canais abre o cartão dela; clicar em si
mesmo abre o editor, porque "quem é essa pessoa?" só é uma pergunta
interessante quando a pessoa é outra.

### Os seis mascotes

São SVG escritos à mão em `avatares.js`, sem arquivo de imagem e sem
dependência: seis PNG decentes custariam mais que toda a interface, e vetor é o
que permite a mesma arte servir a 28 px na lista e a 88 px no cartão.

O que os faz parecerem uma família, e não seis desenhos avulsos: mesma caixa de
64×64, mesma luz vinda de cima e da esquerda, mesmo tratamento de olho, e uma
cor dominante por bicho bem separada das outras na roda — índigo, laranja,
rosa, castanho, ciano e verde. Nada de gradiente: `<defs>` pede `id`, e o mesmo
`id` repetido dezenas de vezes na mesma página é lixo. A profundidade vem de
camadas chapadas.

**O desenho foi julgado onde ele é usado, e não onde ele é bonito.**
`testes/avatares.html` monta a mesma arte a 160, 88, 56 e 28 px, e a fileira de
28 px fica sobre a superfície real da coluna de participantes. Três reprovações
vieram dessa prova de contato, e nenhuma delas apareceria lendo o código:

| O que se via | Por quê | O que mudou |
| --- | --- | --- |
| A capivara era um urso | Cabeça oval com focinho claro e redondo — a receita exata de um urso | Cabeça em pão de topo achatado, orelhas pequenas nos cantos, e um focinho blocudo com nariz largo e chapado |
| O axolote virava um borrão rosa | As guelras eram folhinhas coladas na cabeça e sumiam | Três hastes por lado com tufos nas pontas, bem para fora da silhueta |
| O dragão parecia um sapo | Chifres finos e focinho largo e claro | Chifres em cunha grossa de dois tons, crista serrilhada e barbatanas na mandíbula |

A silhueta é o que decide aos 28 px; a cor só desempata. Foi por isso que a
correção nunca foi "mudar o tom", e sim mudar a forma.

O mascote de quem nunca escolheu é sorteado do próprio identificador. Sem isso
um grupo recém-criado teria seis avatares idênticos — e o avatar deixaria de
distinguir alguém justamente antes de qualquer ajuste.

### O que o servidor faz com isso, e o que ele não faz

Perfil não é conta. Ele mora no computador da pessoa, viaja na saudação como o
apelido sempre viajou, e o servidor esquece quando a conexão cai. Duas decisões
que parecem detalhe e não são:

**O servidor não conhece a lista de mascotes.** Ele recorta o identificador
para minúsculas, dígitos e hífen, com teto de 24 caracteres, e repassa. Mascote
é assunto da interface — uma versão nova do aplicativo com um sétimo desenho
não pode depender de o servidor hospedado ser atualizado junto. Quem não
reconhece o identificador desenha as iniciais.

**Trocar de perfil não pode ser um jeito de trocar de identidade.** A mensagem
`perfil` traz apelido, mascote e bio, e o campo `usuario` dela é ignorado de
propósito. É o `usuario` que atribui autoria às mensagens e decide quem é o
dono do grupo: relê-lo no meio da sessão deixaria qualquer um se apresentar
como outra pessoa depois de já ter sido admitido. Há um teste só para isso —
ele troca o perfil mandando o `usuario` de outra pessoa e depois confere de
quem é a mensagem seguinte.

O apelido e o mascote são **gravados na mensagem**, e não buscados na hora de
ler: o histórico é de quem escreveu naquele dia. Isso obrigou um
`#[serde(default)]` no campo novo do modelo — sem ele, uma linha antiga do
`mensagens.jsonl` faria a desserialização falhar e o histórico inteiro do canal
sumiria em silêncio na primeira atualização do servidor. O teste de persistência
confere justamente as duas: uma mensagem gravada antes do campo existir e uma
gravada depois.

### Duas armadilhas do ferramental, e não do produto

**1. `aguardar` entrega o anúncio mais antigo da fila.** O teste do perfil
pedia o `entrou` da pessoa que acabara de chegar e recebia o de outra, de uma
seção anterior que nenhum teste tinha consumido. A suíte ganhou um
`aguardarQual`, que espera a mensagem que satisfaz um teste em vez da próxima
— "aconteceu?" e "aconteceu com esta pessoa?" são perguntas diferentes.

**2. O relógio virtual corre à frente da rede.** A captura de tela do Chromium
headless dispara no `load` da página, então uma cena que precisa do servidor
não está pronta a essa altura. `--virtual-time-budget` parecia a saída e é uma
armadilha: ele adianta os relógios sem adiantar a rede, e o limite de oito
segundos da conexão estourava antes de o servidor responder — a cena aparecia
com "O servidor não respondeu a tempo" sobre uma tela vazia. A saída foi
segurar o `load` em tempo real, com um recurso lento servido pelo
`servir.mjs` (`/segurar?ms=`), que é o único relógio com que a rede concorda.

### Custo, medido

Os dois arquivos novos do front-end somam **22 KB** — `avatares.js` com 14 KB
(os seis desenhos) e `perfil.js` com 8 KB. Zero dependências novas.

O binário do servidor ficou em **0,48 MB**, o mesmo da iteração anterior. A
atribuição honesta: esta compilação carrega também a atividade em primeiro
plano, que é de outra frente de trabalho no mesmo arquivo.

### Verificado

| O quê | Como |
| --- | --- |
| Protocolo | 74 verificações, 14 delas novas: mascote e bio na saudação e no anúncio de entrada, troca de perfil difundida sem eco para quem trocou, quem entra depois vendo o perfil trocado e não o da saudação, os tetos do servidor, e a identidade que não se troca |
| Aplicação real | 40 verificações conduzindo a janela num quadro — a fita de mascotes da entrada, o painel com prévia ao vivo, o contador de bio contando emoji como um caractere, cancelar que não grava, e o cartão de outra pessoa |
| Duas pessoas | A própria página de teste entra no grupo por um WebSocket cru, com mascote e bio. É o que prova o cartão e a troca de perfil chegando de fora sem depender de duas instâncias e do foco de janela |
| Desenho | Prova de contato em quatro tamanhos, e captura da aplicação montada com cinco pessoas na lista |
| Painel de ajustes | 22 verificações, sem regressão |

**Ressalva honesta:** o que a suíte de duas pessoas prova é a sinalização e a
interface. O segundo participante é um WebSocket, não outra instância do CALL —
ele não abre microfone nem negocia mídia, e não é disso que este recurso trata.

---

## Estado final medido

### Peso em disco

| Artefato | Tamanho |
| --- | --- |
| Instalador `CALL_0.3.0_x64-setup.exe` | **1,69 MB** |
| `call.exe` | 4,32 MB |
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

## Iteração 15 — Som, tempo e presença

**Motivo:** entrar e sair de uma call era um evento sem eco. A lista mudava, e
era só. Não havia como saber há quanto tempo a conversa durava, quem tinha
passado por ela, nem o que as outras pessoas estavam fazendo do outro lado.

### O sino: nenhum byte de áudio no instalador

**Construído:** quatro avisos — você entrou, você saiu, alguém entrou, alguém
saiu — sintetizados nota por nota em `sons.js`, dentro do mesmo grafo que toca
a voz. Não há `.wav` no pacote, não há sample de banco de efeitos, e não há
consulta a serviço nenhum.

É **um som só, lido de quatro maneiras**: um sino de vidro de duas notas em
quinta justa. Sobe na chegada, desce na saída; tem grave quando o evento é
seu, e é leve quando é de outra pessoa. Direção diz o quê, peso diz de quem.

Três decisões respondem por quase todo o resultado: parciais harmônicas com
tempos de queda diferentes (os agudos morrem primeiro, que é o que separa
sino de bipe); ataque de 6 ms (abaixo estala, acima some no meio da conversa);
e a razão 3:2, o intervalo mais consonante depois da oitava — é o que permite
ouvir isto quarenta vezes por noite sem criar irritação.

**"Agradável" não passa em teste, então virou número.** `testes/sons.html`
renderiza os quatro sons em `OfflineAudioContext` e mede as amostras:

| Medida | Alvo | `entrei` | `entrou` | `sai` | `saiu` |
| --- | --- | --- | --- | --- | --- |
| Pico | −22 a −10 dBFS | −13,8 | −18,9 | −14,8 | −20,1 |
| Maior degrau entre amostras | < 15% do pico | 10,8% | 11,0% | 9,8% | 10,3% |
| Duração até −40 dB | < 700 ms | 534 ms | 539 ms | 599 ms | 605 ms |

**O teste reprovou o projeto na primeira execução.** Com o ganho "óbvio" de
1,0, `entrei` saiu a **−1,1 dBFS** — à beira do corte, e alto o bastante para
assustar quem está de fone. Quatro parciais e duas notas se somam
construtivamente, e a intuição errou por 13 dB. Os ganhos em `RECEITAS` são o
resultado da medição, e não uma estimativa.

O teste também prova o gesto, e não só o nível: via Goertzel nas duas notas,
que a frequência sobe ao entrar e desce ao sair; que `entrei` tem 26,7 dB mais
grave que `entrou`; e que o evento dos outros é 5 dB mais discreto que o seu.

### Tempo em call e quem passou por ela

**Construído:** cronômetro na linha do estado, no rodapé da voz, e uma seção
no rodapé da coluna de presentes com quem esteve na call e já saiu — nome e
quanto tempo ficou, uma linha por pessoa, somando quem sai e volta.

**A regra difícil é sobre honestidade.** De quem já estava na sala quando você
chegou não dá para saber desde quando: o servidor não guarda o instante em que
cada um entrou na voz. Essas linhas levam um `+` de "pelo menos", e somar um
piso com um valor exato dá outro piso — nunca um total. Mostrar o número
redondo seria mais bonito e seria mentira.

A lógica saiu do `app.js` para `tempo.js` justamente para poder ser exercitada
sem navegador: o relógio entra por injeção, então uma call de duas horas custa
o mesmo que uma de dois segundos. As 31 verificações cobrem o que a intuição
erra — tempo negativo (relógio do sistema andando para trás ao sair da
suspensão) não virando `-1:-1`, truncar em vez de arredondar para o cronômetro
não mostrar `2` antes de dois segundos, e um `saiu-voz` repetido não inventar
uma linha de zero segundo.

### Atividade: o nome do programa, nunca o título da janela

**Construído:** o que cada pessoa está usando, em tempo real, na lista de
presentes e no cartão de perfil.

**A decisão que define o recurso é o que fica de fora.** O título da janela diz
"Contrato de rescisão — Word", "consulta oncologista — Google Chrome",
"namorada (2) — WhatsApp". O nome do programa diz "Word". Um se conta aos
amigos sem pensar; o outro não se conta a ninguém sem querer. Sai só o segundo.

O nome de exibição vem do `FileDescription` do próprio executável — o mesmo
campo que o Gerenciador de Tarefas mostra —, e é de onde saem "Google Chrome"
em vez de `chrome.exe` sem lista curada e sem consultar serviço nenhum. Sem
descrição, o nome do arquivo é arrumado (`RocketLeague` → `Rocket League`, sem
quebrar siglas como `VLC`).

**Sem dependência nova:** as seis funções do Windows são declaradas à mão em
`atividade.rs`. Uma caixa inteira para chamar `GetForegroundWindow` custaria
mais ao instalador do que o recurso vale.

Duas regras governam o custo:

| Regra | Efeito |
| --- | --- |
| Anuncia só depois de **duas leituras seguidas** | Alt-Tab de dois segundos numa partida não vira anúncio nem mensagem na rede |
| Anuncia só **quando muda** | Custo de rede em repouso: zero. Em uso: uma mensagem curta por troca real de programa |

Sair, ao contrário, é imediato: deixar o nome velho na tela seria afirmar algo
que já não é verdade por até dois intervalos.

O `explorer` é filtrado, e é ele que obriga a lista de ocultos a existir — é o
dono da área de trabalho, então fica em primeiro plano toda vez que nada mais
está. Sem isso, "Windows Explorer" seria o que o grupo mais veria.

O painel mostra ao vivo a frase que está no ar (*"Agora o grupo vê: Visual
Studio Code"*). Ler a promessa é uma coisa; conferir a frase é outra.

### Custo medido

| Métrica | 0.5.0 | 0.6.0 | Variação |
| --- | --- | --- | --- |
| Instalador NSIS | 1 867 495 B | 1 939 221 B | +71 726 B (+3,8%) |
| `call.exe` | — | 4 899 328 B | — |
| Sidecar `sinalizacao.exe` | 501 248 B | 505 344 B | +4 096 B |
| `call.exe` em repouso | 26 MB | **32,1 MB** | +6 MB |
| — em memória privada | 5,7 MB | 7,9 MB | +2,2 MB |

**O teto de 30 MB deixou de ser cumprido, e agora em repouso.** Na iteração 13
o executável ficava em 26 MB parado e estourava a meta só em uso, com 31 MB.
Agora a tela de entrada sozinha custa 32,1 MB. Medido 15 s após abrir o
`target/release/call.exe`, na tela de entrada, com `CALL_INSTANCIAS_MULTIPLAS`
para não colidir com uma instância aberta.

Cinco módulos de JavaScript entraram desde então — `avatares.js`, `perfil.js`,
`sons.js`, `tempo.js` e `atividade.js` —, e o custo deles não é o texto no
disco: é o que o WebView2 aloca para o DOM dos mascotes em SVG, para o grafo
de áudio que passou a existir fora da voz, e para os dois relógios novos. O
número está registrado como saiu, e não arredondado para dentro da meta.
Reduzi-lo é trabalho da próxima iteração, e não deste release.

Os 70 KB cobrem **três recursos e o perfil da iteração 14 inteiro**: os quatro
sons custam os 9 982 B de `sons.js` e mais nada, porque não há áudio a
embarcar — era exatamente a aposta da síntese. `tempo.js` são 3 570 B,
`atividade.js` 5 736 B, e `atividade.rs` entra no executável sem trazer caixa
nenhuma junto.

### O teste que não podia falhar

Depois de publicada a 0.6.0, a pergunta "está tudo funcionando?" não tinha
resposta: cada peça estava verificada isoladamente, mas o aplicativo montado
nunca tinha sido exercitado numa sessão real de duas pessoas. O roteiro que
existia para isso, `duas-instancias.ps1`, **passava — e não verificava nada**.

Ele clica por coordenada, e a fita de mascotes da iteração 14 mudou a altura
da tela de entrada. Os cliques passaram a errar o alvo, as duas janelas nunca
saíram da tela de entrada, e o roteiro imprimiu "capturado" em cada etapa,
mediu memória e saiu com código zero. Só tirava foto, e foto não reprova.

Três consertos:

| Problema | Conserto |
| --- | --- |
| Cliques na tela de entrada erravam o alvo | Coordenadas remedidas passo a passo, com captura a cada clique |
| Nenhuma verificação, só capturas | O servidor local grava numa pasta descartável, e um **observador** entra no grupo pelo código lido do disco e assiste ao que é difundido |
| Voz reprovava numa máquina sem microfone | Detecta o dispositivo de captura no registro e **pula, dizendo por quê** — sem virar falso verde nem falso vermelho |

O observador é o que torna o roteiro capaz de reprovar: ele prova, pelo lado
do servidor, que as duas janelas reais se encontraram no mesmo grupo, que a
mensagem de texto atravessou, e que a **atividade em primeiro plano foi
anunciada** — com o Bloco de Notas trazido à frente de propósito, já que com o
CALL em foco o aplicativo não anuncia nada.

Essa última é a única prova que existe da cadeia inteira da atividade
funcionando junta: API do Windows → `atividade.rs` → `invoke` do Tauri →
`Vigia` e suas duas leituras → servidor → tela da outra pessoa. Nenhum teste
de unidade cobre a costura entre esses seis pedaços.

### O recurso que não cabia na janela (0.6.1)

A pergunta "está tudo funcionando?" trouxe o defeito que nenhum teste pegaria,
porque nenhum teste olhava a janela **no tamanho em que ela nasce**.

A janela padrão tem 1080 px, ou seja, 1064 de área útil. A coluna de presentes
era escondida abaixo de 1120 px. Ou seja: **numa instalação nova, no tamanho
padrão, o histórico da call e a atividade embaixo do nome eram invisíveis** —
e não havia nada na tela sugerindo que existiam. Eu tinha conferido o layout
numa captura de 1400 px, largura que só existe em quem maximiza a janela.

A regra era defensável quando foi escrita: a lista de presentes repetia, sem o
aninhamento por canal, o que a árvore de canais já mostra, então era a
primeira candidata a sair. A iteração 15 tornou isso falso — ela virou o único
lugar onde vivem "estiveram na call" e o que cada pessoa está usando.

Agora a coluna **encolhe antes de sumir**: de 208 px para 190 px abaixo de
1120, e só desaparece abaixo de 940, quando a coluna da conversa deixaria de
caber. Conferido nas três larguras que importam:

| Largura útil | Presentes | Conversa | Resultado |
| --- | --- | --- | --- |
| 1064 (padrão do aplicativo) | 190 px | 472 px | histórico e atividade visíveis |
| 950 (acima do corte) | 190 px | 358 px | apertado, mas inteiro |
| 880 (mínimo da janela) | oculta | 542 px | sai limpo, sem transbordo |

A lição não é sobre CSS: **um recurso conferido fora do tamanho real da janela
não foi conferido.** O cronômetro escapou por acidente, não por acerto — ele
mora no rodapé da voz, que nunca some.

## Iteração 16 — Tirar do caminho o que não decide nada (0.7.0)

**Motivo:** dois atritos que só aparecem em uso repetido, e por isso nenhuma
suíte notaria. A tela de entrada voltava a cada abertura, com os campos já
preenchidos, pedindo um clique em "Continuar" que não decidia coisa alguma. E
o aviso de versão nova, uma vez dispensado com "Depois", sumia sem deixar
rastro: a única forma de lembrar dele era fechar e reabrir o aplicativo.

**Construído:**

| Antes | Agora |
| --- | --- |
| Tela de entrada a cada abertura | Aparece uma vez; quem tem apelido guardado cai direto nos grupos |
| Apelido e mascote só na entrada | Em "Meu perfil", onde já viviam a bio e o mascote |
| Endereço do servidor na entrada | Aba **Servidor** nos ajustes, com "Salvar e reconectar" |
| "Depois" apagava o aviso | "Depois" tira o cartão e deixa uma marca no alto da janela, até resolver |

A marca da atualização não pisca e não anima. Um indicador que chama atenção
sem parar ensina a pessoa a não olhar para ele; o objetivo aqui é o contrário
— estar disponível quando ela lembrar. Ela ficaria melhor colada ao canto da
janela, mas ali cobre o contador de presentes, o que a captura mostrou na
primeira tentativa. Foi para a barra do topo, que nunca some.

### `CALL_SERVIDOR`

Tirar o endereço do servidor da tela de entrada quebrou o roteiro de duas
instâncias, que era ali que apontava o aplicativo para o servidor local. A
saída fácil seria navegar o painel de ajustes por coordenada de clique — e o
painel é modal, com cinco abas, o que multiplicaria exatamente o tipo de
fragilidade que a iteração anterior acabou de consertar.

Em vez disso, o Rust passou a ler `CALL_SERVIDOR`, no mesmo padrão do
`CALL_INSTANCIAS_MULTIPLAS` que já existia. Três linhas, nenhuma dependência,
e serve também a quem sobe o CALL numa rede local sem querer abrir ajuste.

### O que a conduta por coordenada ensina

Duas armadilhas apareceram, e as duas valem registro porque voltarão:

**Medir no navegador não vale.** As coordenadas da tela de entrada, medidas em
Edge headless com `--window-size=1064,701`, erraram **46 px na vertical** —
o viewport do navegador não é a área cliente do WebView2. A medição que vale é
a captura da própria janela.

**O Windows recusa o primeiro plano a processos de fundo.** Sem um clique numa
área morta antes de digitar, uma execução em cada três perdia o apelido, e a
falha parecia defeito do aplicativo. O roteiro agora repete a entrada até três
vezes usando o grupo no disco como sinal, e só então reprova.

E o Bloco de Notas do Windows 11 é aplicativo empacotado: o processo devolvido
não é o dono da janela, e `MainWindowHandle` volta vazio. Trocado por `cmd`.

### A voz, enfim verificada

Na primeira execução desta suíte a máquina não tinha dispositivo de captura e
a verificação de voz era pulada, dizendo por quê. Com um microfone presente,
ela passou: **as duas instâncias entram no canal de voz**, e a captura
`15-B-na-voz` mostra o cronômetro da call correndo em `00:08`. Era a última
peça da iteração 15 sem prova no aplicativo montado.

---

### Limites honestos

O tempo de quem já estava na call antes de você é um piso, e a interface diz
isso com o `+` em vez de esconder. A atividade depende do `FileDescription`
que cada executável declara: quem não declara nada aparece com o nome do
arquivo arrumado, que às vezes é sem graça — errar para menos aqui mostra um
nome feio, e errar para mais seria inventar o que a pessoa está usando.

E a atividade é um recurso do Windows: `atividade.rs` compila fora dele, mas
devolve sempre `None`. O CALL só é distribuído para Windows, então isto é
fronteira declarada, e não dívida.

A entrada no canal de voz **depende de haver microfone na máquina que roda o
teste**. Onde não há, o roteiro pula a verificação e diz por quê, em vez de
reprovar o aplicativo por uma falta de hardware — e em vez de fingir que
verificou. Com microfone presente, ela passa (iteração 16).

O que continua sem prova automatizada é o **som** de entrada e saída: as
amostras são medidas em `OfflineAudioContext`, mas que o sino chegue ao
alto-falante no aplicativo montado, ninguém verifica. `testes/ouvir-sons.ps1`
existe para essa parte, e ela é de ouvido — nenhum número resolve.

---

## Testes automatizados

| Suíte | Comando | Cobertura |
| --- | --- | --- |
| Protocolo de sinalização | `node testes/sinalizacao.test.mjs` | 74 verificações: criação de grupo, convite recusado, entrada por código, voz isolada por canal, encaminhamento de sinais, difusão de estado, mensagens e histórico, regra de dono, remoção que tira gente da voz, persistência entre execuções do servidor, o cartão de perfil que viaja na saudação, e a atividade — repassada, recortada no teto de 40 caracteres, presente no resumo de quem chega depois, e desligada tanto por texto em branco quanto pela ausência do campo |
| Malha WebRTC e mídia | `powershell -File testes/rodar-malha.ps1` | 44 verificações no próprio motor Chromium: entrada no canal de voz, conexão nos dois lados, áudio com bytes recebidos, vídeo com quadros decodificados, renegociação ao encerrar a tela, limpeza de elos — e, desde a iteração 13, o SDP do Opus, o tráfego de áudio medido nos dois extremos de qualidade, o perfil e o codec da tela efetivamente negociado, o som que acompanha a transmissão, e a porta de ruído renderizada em `OfflineAudioContext` |
| Painel de ajustes | `powershell -File testes/rodar-interface.ps1` | 22 verificações conduzindo a aplicação real dentro de um quadro: controles refletindo o estado, medidor recebendo nível da porta de ruído, dispositivos enumerados com nome, abas, persistência das escolhas — e os erros de execução da própria aplicação, recolhidos |
| Convite por link | `powershell -File testes/convite.ps1` | 8 verificações na janela real: o esquema `call://` registrado, o link com o aplicativo aberto trocando de grupo sem abrir segunda instância, e o link com o aplicativo fechado abrindo o CALL e esperando a tela de entrada — os dois provados pelo canal em que a mensagem escrita depois caiu |
| Perfil | `powershell -File testes/rodar-perfil.ps1` | 40 verificações conduzindo a aplicação real: a fita de mascotes da tela de entrada, o painel com prévia ao vivo e contador de bio, cancelar que não grava, e — com uma segunda pessoa entrando no grupo por um WebSocket cru — o cartão dela e a troca de perfil chegando de fora |
| Sons de entrada e saída | `powershell -File testes/rodar-sons.ps1` | 33 medições nas amostras renderizadas em `OfflineAudioContext`: pico dentro da faixa alvo, ausência de degrau no ataque, começo e fim em silêncio real, duração abaixo de 700 ms, e — via Goertzel nas duas notas — que o gesto sobe ao entrar e desce ao sair, que o evento próprio tem grave e o dos outros não, e que o intervalo continua sendo uma quinta justa |
| Tempo em call | `node testes/tempo.test.mjs` | 31 verificações com relógio injetado: formatação do cronômetro nas viradas de minuto e de hora, truncamento em vez de arredondamento, tempo negativo de relógio que anda para trás, e o histórico — somar quem sai e volta numa linha só, a contaminação do "pelo menos" quando uma passagem tem começo desconhecido, saída sem entrada que não cria linha, e a limpeza ao trocar de call |
| Atividade | `node testes/atividade.test.mjs` | 28 verificações da política: a área de trabalho e as cascas do Windows que não viram atividade, caracteres de controle e nomes absurdos que não estragam a coluna, a exigência de duas leituras seguidas antes de anunciar, a saída imediata, a leitura que falha sem apagar o que estava no ar, e o desligamento que limpa a linha dos outros em vez de congelá-la |

Todas passam integralmente na última execução.

Duas páginas servem ao desenho, e não à verificação: `testes/avatares.html` é
a prova de contato dos mascotes em quatro tamanhos, e `testes/cena.html` leva a
aplicação a um estado e para ali, para a captura — é o que permite olhar o
resultado em vez de deduzi-lo da marcação.

`testes/duas-instancias.ps1` deixou de ser um roteiro de captura e virou
suíte: sobe duas janelas reais do build de release contra um servidor local e
verifica, pelo lado do servidor, que elas se encontram no grupo, trocam
mensagem e anunciam a atividade em primeiro plano. Ele **reprova** quando os
cliques erram o alvo, e **pula dizendo por quê** a parte de voz numa máquina
sem microfone.

Além dele, dois roteiros dirigem a janela real só para deixar capturas em
`testes/capturas`: `testes/inspecionar.ps1` (uma instância, da tela de entrada
até o canal de voz) e `testes/ajustes.ps1` (o painel de ajustes
dentro do WebView2, sob a CSP do Tauri e com os dispositivos de áudio reais da
máquina). Eles clicam por coordenada, então quebram
quando o layout muda de altura — e foi assim que o convite truncado e a coluna
que descia de linha apareceram.
