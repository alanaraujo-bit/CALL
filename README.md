# CALL

Aplicativo de comunicação: **grupos com canais**, **chat de texto**, **chat de
voz** e **transmissão de tela**. Interface inteiramente em português do Brasil.

Ele mora em duas cascas, e as duas são o mesmo CALL — a mesma conta, os mesmos
grupos, o mesmo protocolo:

* **Windows**, em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
  Electron. O cliente de mídia é materializado no `frontendDist` durante o
  build, sem depender de CDN em tempo de execução.
* **Celular**, em PWA — abre no navegador do Android e do iPhone, e se instala
  na tela de início. Vive em `movel/` e reaproveita os módulos de núcleo de
  `src/` sem cópia: protocolo, mídia, áudio, conta, mascotes e emojis são
  literalmente os mesmos arquivos. Ver **[No celular](#no-celular)**.

O aplicativo se atualiza sozinho: quando sai uma versão nova, ele avisa e
instala com um clique, sem sair da tela. Quem responder "Depois" continua
vendo uma marca discreta no alto da janela, que fica lá até a atualização ser
feita — dispensar o aviso não faz a versão nova ser esquecida. Antes de
atualizar, "Ver o que há de novo" mostra o que a versão traz, escrito para
gente e organizado por blocos — o aviso deixa de ser uma ordem e vira uma
escolha informada. Página do projeto:
**https://call.aionixdev.com/**

---

## Instalação

Baixe o instalador da versão mais recente em
**[call.aionixdev.com](https://call.aionixdev.com/)** e
execute. A instalação é por usuário e não exige privilégios de administrador.
O único requisito é o **WebView2**, presente por padrão no Windows 10 e 11.

Quem já tem o CALL instalado não precisa baixar nada: o próprio aplicativo
detecta a versão nova e oferece a atualização.

O botão **Baixar** do site não decide por quem clica: ele pergunta onde o CALL
vai ser usado, e oferece o instalador do Windows ou o aplicativo no navegador.
Quem abre o site do celular vê a opção do navegador primeiro — um `.exe` ali é
um arquivo que não abre.

---

## No celular

**[call.aionixdev.com/app/](https://call.aionixdev.com/app/)** — abre e
funciona, sem baixar nada. Android e iPhone.

Dá para **adicionar à tela de início**: no Android o próprio navegador
oferece; no iPhone é Compartilhar → "Adicionar à Tela de Início", no Safari, e
o aplicativo ensina o caminho com o desenho do botão. Instalado, ele abre em
tela cheia, com ícone próprio, sem barra de endereço, e continua funcionando
com a rede caindo.

O que existe aqui: grupos, canais de texto e de voz, conversa com emoji,
reação, edição e exclusão, amigos e mensagem privada, soundboard do grupo,
perfil com mascote e foto, e a tela de quem está transmitindo do computador —
com um toque para ver em tela cheia e pinça para ampliar.

O que **não** existe, e por quê:

| Recurso | Motivo |
| --- | --- |
| Transmitir a sua tela | `getDisplayMedia` não existe em navegador de celular. Assistir à de outra pessoa, sim. |
| Mostrar o programa em uso | Depende de ler a janela em primeiro plano do sistema — é comando nativo, não web. |
| Filtro neural de ruído | São 6 MB de modelo para um aparelho que provavelmente está no 4G. O supressor do sistema atende. |
| Escolher a saída de som | Quem escolhe é o próprio celular, e faz isso melhor do que nós. |

A voz de cada participante toca num `<audio playsinline>` próprio, e não no
grafo de áudio como no computador: mandar fluxo remoto para dentro do Web
Audio é o caminho conhecido de áudio mudo no Safari do iOS, e o elemento
resolve as duas coisas — toca em qualquer aparelho e ainda dá volume por
pessoa. A captura do microfone continua passando pelo mesmo motor de áudio do
CALL de mesa, com a porta de ruído e o soundboard.

A call não some quando você navega: ela vira uma tira no rodapé com o canal, o
tempo, o mudo e o desligar, e um toque a traz de volta inteira.

---

## Como usar

### 1. Abra, entre ou crie uma conta

Não há nada a configurar. O aplicativo já vem apontado para o servidor oficial
do CALL, hospedado — ninguém precisa deixar máquina ligada nem passar IP.

A tela de entrada pergunta uma coisa só: quem você é. **Criar conta** pede
apelido, mascote, e-mail e senha numa folha só, com a prévia do seu retrato
acompanhando o que você digita e a força da senha desenhada nas mesmas cinco
barras da marca do CALL. **Entrar** é para quem já tem conta, aqui ou pelo
Google. E **entrar sem conta**, embaixo, é a saída de sempre — o CALL inteiro
funciona sem cadastro, inclusive sem internet.

O mascote sai daqui: são seis — coruja, raposa, axolote, capivara, polvo e
dragão —, desenhados para o CALL. Quem não escolher nenhum ganha um sorteado,
para que ninguém apareça como mais um círculo cinza igual ao dos outros.

**Essa tela aparece uma vez só.** Da segunda abertura em diante o aplicativo
vai direto para os grupos: boas-vindas se dá uma vez, e um clique diário que
não decide nada é pedágio, não recurso. Com conta, a sessão vale 90 dias e é
conferida em silêncio na partida; sem conta, basta ter um apelido guardado.
Apelido, bio, mascote e a própria conta passam a ser tratados em **Meu
perfil**, no canto inferior esquerdo.

O servidor guarda a estrutura dos grupos e o histórico dos canais de texto.
No serviço oficial ele também emite uma credencial curta e restrita para a
sala de mídia no **LiveKit**; áudio e vídeo passam pelo SFU, nunca pelo servidor
Rust nem pelo banco. Em um servidor próprio sem LiveKit, o CALL usa a malha P2P.

Para apontar para outro endereço, use a aba **Servidor** nos ajustes.
**Hospedar** sobe um servidor nesta máquina, na porta 8787, útil em rede local
ou sem internet; ele fecha junto com o aplicativo. A variável de ambiente
`CALL_SERVIDOR` vence o que estiver gravado, para quem sobe o CALL apontado a
um servidor de teste sem mexer em ajuste nenhum.

### 2. Crie um grupo ou entre com um convite

**Criar grupo** devolve um código de convite de dez caracteres — é ele que se
compartilha, e não o nome do grupo. Quem recebe usa **Entrar com convite**. Os
grupos ficam salvos na coluna da esquerda e vivem no servidor: estrutura e
histórico sobrevivem a fechar o aplicativo.

O cartão do convite copia um **link**, e não o código: quem recebe abre a
página, e um clique em "Abrir no CALL" entra no grupo direto no aplicativo.
Quem ainda não tem o CALL encontra o instalador na mesma página. O código
continua à mão em **Copiar código do convite**, no menu do grupo, para ditar
por voz ou digitar.

### 3. Converse

Cada grupo tem categorias e canais. Canais de **texto** guardam as últimas 500
mensagens; canais de **voz** ligam os participantes entre si.

Clique num canal de texto para ler e escrever. Clique num canal de voz para
entrar nele — só aí o microfone é capturado. Uma vez na voz, use **Microfone**
para silenciar e **Transmitir** para compartilhar uma janela ou a tela inteira.

Entrar e sair da voz toca um **sino curto** — sobe na chegada, desce na saída,
e tem peso de grave quando o evento é seu. É um som só, lido de quatro
maneiras: direção diz o quê, peso diz de quem. Nenhum arquivo de áudio é
distribuído com o aplicativo; o sino é construído nota por nota no mesmo grafo
de áudio que toca a voz, e sai pelo dispositivo escolhido em "Saída de som".

O rodapé da voz mostra o **tempo nesta call**, e a coluna de presentes ganha,
no rodapé, quem **esteve na call e já saiu**, com quanto tempo ficou. De quem
já estava na sala quando você chegou não dá para saber desde quando, e essas
linhas levam um `+` de "pelo menos" — o número é um piso, e não um total.

As mensagens aceitam **emojis Unicode**, reações, edição e exclusão pelo
próprio autor, e todo mundo no canal vê as mudanças na hora. O aplicativo também
tem **soundboard de grupo**: uma biblioteca de sons que qualquer um na call
adiciona e toca para todos. Os clipes ficam no servidor, mas quem toca mistura
o som no próprio áudio de saída e o envia pelo mesmo transporte de mídia da voz.

Quem cria o grupo é o dono, e só ele cria, renomeia e remove categorias e
canais. O convite dá acesso à conversa, não à estrutura.

### 4. Ajuste a voz e a imagem

A engrenagem ao lado do seu nome, no canto inferior esquerdo, abre os ajustes.

Em **Voz**: microfone e saída de som, volume de entrada e geral, filtros nativos
do WebView2 para eco, ruído e ganho, mais uma porta adaptativa que cala o que
ainda sobra entre as falas sem aprender a própria voz como ruído. O medidor ao
vivo mostra nível, piso da sala e ponto de abertura. Limitadores transparentes
protegem tanto o envio quanto a soma de várias pessoas contra clipping. A voz
usa Opus mono full-band, VBR, FEC e prioridade alta; a qualidade vai de 32 a
128 kbps, com 96 kbps como padrão para novas instalações.

Em **Transmissão**: quatro perfis, de 720p a 30 quadros até 1440p a 60. Todos
preferem H.264 para aproveitar o codificador da GPU e preservar o FPS escolhido;
se a rede apertar, a resolução cede antes dos quadros. Trocar de perfil durante
uma transmissão vale na hora. O **som do sistema** viaja numa trilha separada da
sua voz, no teto do codec e sem os filtros de voz. A captura exclui a árvore
de processos do WebView2 que reproduz o áudio do CALL, portanto as vozes que
você ouve não retornam pela transmissão e não criam eco.

Em **Atividade**: mostrar ao grupo o programa que está na sua frente. Vai **só
o nome do programa** — "Google Chrome", "Rocket League" —, e nunca o título da
janela: o site aberto, o nome do arquivo e o assunto do e-mail não saem daqui.
O nome vem da descrição que o próprio executável declara, a mesma que o
Gerenciador de Tarefas mostra, sem consultar serviço nenhum. Um programa só é
anunciado depois de ficar em foco por duas leituras seguidas, então passar
pelo navegador durante uma partida não vira anúncio; sair é imediato. O painel
mostra ao vivo a frase que está no ar, para conferir em vez de confiar. A área
de trabalho vazia não conta, e o recurso se desliga num clique. Um programa
cadastrado à mão pode ganhar um ícone junto do nome.

Em **Sons**: escolher o que toca quando você entra num canal de voz — o sino
sintetizado de sempre, um som da biblioteca do grupo atual (que só toca
naquele grupo), ou um clipe da sua biblioteca pessoal. Quem tem conta guarda
até três sons pessoais, que funcionam como som de entrada em qualquer grupo.

### 5. Deixe o perfil com a sua cara

Clique no seu nome, no canto inferior esquerdo, para abrir **Meu perfil**:
apelido, uma **bio** de até 160 caracteres e o **mascote**. A prévia no topo
mostra, enquanto você digita, exatamente o que os outros vão ver. Trocar
qualquer coisa vale na hora, inclusive com um grupo aberto.

Clique em alguém — na lista de presentes ou embaixo de um canal de voz — para
ver o cartão dessa pessoa: mascote, bio, se é dona do grupo e o que ela está
usando. O volume dela também fica ali (e continua no botão direito, para quem
já tinha o atalho na mão). O volume é lembrado entre sessões.

Sem conta, o perfil fica **neste computador** e viaja junto de você a cada
entrada em um grupo: o servidor repassa aos outros enquanto você está
conectado e esquece quando você fecha o CALL. Com conta, ele fica guardado —
ver abaixo.

### 6. Conta (opcional)

Na primeira abertura o CALL oferece **criar conta** ou **entrar**, e uma
terceira saída, discreta: **entrar sem conta**. As três funcionam, e a
terceira é o CALL como ele sempre foi.

A conta existe para uma coisa só: **trocar de computador sem virar outra
pessoa**. Ela guarda apelido, mascote, bio e a lista de grupos — formate a
máquina, instale o CALL de novo, entre, e a coluna da esquerda volta inteira.
Sem ela, a identidade é um número sorteado no primeiro uso e gravado neste
computador: perdê-lo é perder a autoria do que você escreveu e a posse dos
grupos que criou.

O que a conta **não** faz: não dá acesso a grupo nenhum (isso continua sendo
questão de ter o convite), não muda quem pode o quê, e não é exigida para
nada. Também não existe no servidor que você mesmo hospeda com "Hospedar" —
ali não há cadastro a fazer, e é o cenário sem internet.

**Entrar com o Google** aparece quando o servidor está configurado para ele. O
CALL não pede sua senha do Google: ele abre o **navegador do sistema**, com a
barra de endereço à vista em `accounts.google.com`, e espera a volta numa porta
local que só existe durante o login. O segredo da aplicação fica no servidor, e
a troca do código acontece lá — nunca dentro do `.exe`.

Sua conta fica em **Meu perfil**, embaixo do mascote: qual é, e como sair dela.
Sair derruba a sessão no servidor, e não só neste computador.

Senhas são guardadas com **Argon2id**, e o que fica gravado é o hash. Tokens
de sessão valem 90 dias, e o que sobrevive deles é a impressão, nunca o
próprio token: um vazamento da tabela de sessões não abre conta nenhuma.

No servidor oficial as contas ficam num **Postgres**, e não num arquivo — ver
"Arquitetura" logo abaixo para o porquê de ter dois jeitos de guardar a mesma
coisa.

### 7. Central de comando (só o dono)

A conta cadastrada em `ADMIN_EMAILS` — e só ela — vê um ícone a mais na
barra do topo, no computador, e uma linha a mais na aba **Você**, no celular.
Ele abre a **central de comando**: o que está acontecendo no CALL, em números
que podem dar má notícia.

Não é uma página à parte, não tem senha própria e não tem endereço para
decorar. O token de sessão que já abre a conta é o mesmo que abre o painel, e
quem decide se ele abre é o **e-mail** — ver `contas::e_admin`. Ninguém vira
administrador se cadastrando: a lista vive no ambiente do servidor, e não no
banco.

Sete abas:

| Aba | O que responde |
| --- | --- |
| **Visão geral** | Quantas pessoas usaram hoje, quantas entraram, quanto tempo de voz, e a curva de trinta dias |
| **Crescimento** | Contas acumuladas, contas novas, acessos, mensagens e minutos por dia |
| **Retenção** | De quem criou conta num dia, quantos voltaram no seguinte, no sétimo e no trigésimo — em coortes, dia a dia |
| **Pessoas** | Cada conta: quando entrou, quando foi vista, dias ativos, mensagens, tempo de voz, em que aparelho |
| **Grupos** | Cada grupo: tamanho, quem está dentro agora, mensagens, última atividade |
| **Ao vivo** | Quem está conectado neste instante, em qual grupo, em qual canal — e cada acontecimento na hora em que acontece |
| **Feedback** | Os relatos que chegaram, e o status de cada um |

**A tela não recarrega em laço.** O servidor empurra um pulso a cada cinco
segundos e cada acontecimento na hora em que ele acontece; o retrato inteiro é
refeito a cada 45 segundos e é ele quem reconcilia. O canto do painel diz há
quantos segundos o que está na tela chegou — um painel que não diz isso é um
painel em que não dá para confiar no dia em que o servidor cair.

**Os números foram escolhidos para poderem dar má notícia.** "Total de contas"
sobe todo dia e nunca desce; ele faz qualquer produto parecer saudável,
inclusive um que ninguém abre há um mês. Por isso a manchete é *pessoas ativas
por dia* (pessoas, não eventos, e não acumulado), e o bloco que mais importa é
a retenção por coorte — a única medida que separa "muita gente entrou" de "o
produto serve para alguma coisa". O funil de ativação mostra onde se perde
gente entre criar conta e entrar numa call.

Retenção só cobra de quem teve a chance: quem criou a conta ontem não entra no
denominador do D7, porque o sétimo dia dela ainda não chegou. Sem isso, cada
conta nova de hoje derrubaria a média, e o painel puniria o próprio
crescimento.

Os dias são os **dias de quem lê**: o navegador manda o próprio fuso junto do
pedido. Sem isso, "hoje" num servidor em UTC começaria às 21h de ontem no
Brasil.

#### O que é anotado, e o que não é

A retenção exige memória do percurso, e o estado atual do banco não a tem —
nenhuma consulta em `contas` reconstrói um dia de uso que ninguém anotou. Daí
a tabela `eventos`, e ela guarda o mínimo que responde à pergunta:

* **O que entra:** o instante, o tipo do acontecimento (conta criada, sessão
  aberta ou retomada, entrou/criou grupo, entrou/saiu da voz, transmitiu,
  mensagem, feedback), o **identificador da conta** — o mesmo que já viaja no
  protocolo —, o código do grupo ou do canal, os segundos de uma passagem pela
  call, e uma palavra dizendo de qual casca veio: `windows`, `movel` ou
  `navegador`.
* **O que não entra:** endereço IP, user-agent, impressão digital de
  navegador, **o texto das mensagens**, o título de janela, o nome do programa
  em uso, e qualquer coisa vinda de quem está sem conta além do fato de haver
  uma janela aberta. Uma linha ali diz *"esta conta fez isto, nesta hora"*, e o
  painel não precisa de mais.
* **Por quanto tempo:** noventa dias. O que passa disso é apagado pelo próprio
  servidor.

Quem usa **sem conta** aparece como número, nunca como pessoa: o CALL nunca
prometeu saber quem essa pessoa é, e o painel não finge que sabe.

---

## Arquitetura

```
call.exe                 janela Tauri + interface
  └─ WebView2            renderização e pilha WebRTC
sinalizacao.exe          servidor de sinalização (sidecar, só ao hospedar)
LiveKit                  SFU/TURN da mídia — em escada, ver abaixo
```

O servidor guarda a estrutura dos grupos e o histórico dos canais de texto. Ele
assina um JWT LiveKit de dez minutos, limitado a uma sala e às fontes de
microfone, tela e som da tela. O segredo fica somente no servidor; expirar o
token afeta novas entradas, não derruba uma call já estabelecida.

### A escada de mídia

A mídia não é um interruptor de sim ou não: é uma **escada**, e a call desce
sozinha quando um degrau para de atender.

```text
1. nuvem     LiveKit Cloud       qualidade e alcance, com teto mensal
2. proprio   LiveKit nosso       sem quota; custa uma máquina
3. malha     P2P, sem servidor   nunca falta, mas grupos grandes sofrem
```

Isto existe por causa de um apagão: no dia em que o plano do LiveKit acabou, o
servidor continuou emitindo tokens com confiança, cada cliente falhou sozinho
sem contar a ninguém, e o CALL simplesmente não abriu call nenhuma. A escada é
a resposta, e tem três gatilhos independentes:

* **Preventivo.** O servidor mede o próprio consumo do ciclo e para de emitir
  token ao chegar em `LIVEKIT_MARGEM` (90% por padrão) do teto declarado.
  Nenhuma call precisa falhar para o degrau seguinte assumir.
* **Reativo.** O cliente que não consegue entrar no SFU **avisa o servidor**
  (`midia-falhou`) em vez de desistir, e recebe de volta o degrau seguinte
  (`voz-migrar`) sem perder o microfone nem o cronômetro da call. Duas falhas
  na janela derrubam o degrau por dez minutos, e ele volta em observação: a
  primeira falha depois de reabrir o derruba de novo.
* **Manual.** Uma chave na aba **Mídia** da central de comando força a malha
  em todas as calls novas, sem redeploy.

Quando um degrau cai com gente dentro, a **sala inteira desce junto** — metade
no SFU e metade na malha é uma sala em que as pessoas não se ouvem. Quem está
numa call de contingência vê uma marca discreta no rodapé ("servidor reserva",
"rede direta"), com o motivo no `title`: informação para entender uma mudança
de qualidade, não um alarme.

O consumo é medido do lado de cá em **minutos-participante** (a mesma unidade
que o LiveKit cobra) e em **bytes recebidos do SFU**, que só o navegador
conhece e reporta ao sair da call. Os dois ficam gravados no evento, e não só
na memória do processo: sem isso, um redeploy zeraria o teto e ele nunca
chegaria a proteger a fatura.

Na imagem hospedada, configure diretamente no Railway — nunca no repositório:

```text
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...

# O teto do plano, para o medidor. O painel do provedor é a fonte de verdade
# da fatura; estes números são o alarme que dispara antes dela. Sem eles o
# degrau atende até falhar — que é o comportamento antigo.
LIVEKIT_MINUTOS_MES=5000        # minutos-participante do plano
LIVEKIT_GB_MES=50               # banda do plano
LIVEKIT_MARGEM=90               # % do teto em que o degrau se aposenta
LIVEKIT_DIA_DO_CICLO=1          # dia do mês em que a fatura vira

# O segundo degrau: um LiveKit nosso. Opcional — sem ele a escada vai da
# nuvem direto para a malha.
LIVEKIT_RESERVA_URL=wss://midia.seudominio.com
LIVEKIT_RESERVA_API_KEY=...
LIVEKIT_RESERVA_API_SECRET=...
```

### Subir o LiveKit próprio

O LiveKit é código aberto e cabe num contêiner. No Railway, um serviço novo a
partir da imagem `livekit/livekit-server`, com um volume para o arquivo de
configuração:

```yaml
# livekit.yaml
port: 7880
rtc:
  tcp_port: 7881
  # Numa hospedagem com um IP público e sem faixa UDP aberta, `use_external_ip`
  # e a porta TCP única são o que faz a mídia atravessar. UDP é melhor quando
  # dá para abrir a faixa; TCP funciona em qualquer lugar.
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  # A mesma chave/segredo que vão para LIVEKIT_RESERVA_API_KEY/SECRET.
  chave_da_reserva: segredo_bem_longo_e_aleatorio
```

Aponte um subdomínio para o serviço, sirva por TLS (o Railway já faz), e
preencha as três variáveis `LIVEKIT_RESERVA_*`. O servidor loga a escada que
montou na partida:

```text
[midia] escada de mídia: nuvem → proprio → malha P2P.
```

Se aparecer só `malha P2P`, alguma credencial está incompleta — o servidor
diz qual prefixo falhou e continua funcionando pela malha, em vez de subir
prometendo um degrau que não tem.

### O TURN da malha

A malha P2P só com STUN falha justamente no 4G: a operadora põe milhares de
aparelhos atrás do mesmo endereço (CGNAT), nenhum dos lados alcança o outro, e
a call abre sem ninguém se ouvir. O serviço `turn` (pasta `turn/`, um coturn)
é o ponto de encontro para esse caso.

O Railway não abre UDP para fora — só TCP, por proxy. Então o TURN atende
apenas por TCP, e os dois lados da call se encontram em duas alocações do
mesmo coturn, que repassa os pacotes pela própria máquina. Por isso o
endereço anunciado é o IP privado do contêiner, e **não** há `--external-ip`,
ao contrário do que os guias de coturn mandam. Todo o resto da rede privada
fica negado (`--denied-peer-ip`): quem tem um convite recebe credencial, e
sem isso o TURN seria uma porta para o Postgres.

A credencial não é fixa: o servidor assina, a cada entrada na voz, um usuário
que vence em 24 horas (`servidor/src/turn.rs`), e o coturn confere com o
mesmo segredo. No Railway:

```text
# serviço turn
TURN_SECRET=...                 # aleatório, longo

# serviço sinalizacao
TURN_SECRET=${{turn.TURN_SECRET}}
TURN_URLS=turn:<proxy TCP do turn>?transport=tcp
```

O tráfego que passa pelo TURN sai do Railway e é cobrado, por isso há teto:
4 Mbps por sessão e 60 Mbps no total (`turn/iniciar.sh`). Ele só é usado
quando a conexão direta falha — o ICE prefere sempre o caminho direto.

O login do Google usa **dois clientes OAuth**, e não um — porque o Google
separa por tipo e o CALL precisa dos dois:

```text
GOOGLE_CLIENT_ID=...            # cliente "Aplicativo para computador"
GOOGLE_CLIENT_SECRET=...        # → o CALL de Windows, que volta em http://127.0.0.1:{porta}
GOOGLE_CLIENT_ID_WEB=...        # cliente "Aplicativo da Web"
GOOGLE_CLIENT_SECRET_WEB=...    # → o CALL de celular, que volta em /app/
```

Não dá para atender os dois com um cliente só: o de computador recusa URI
`https`, e o Web exige porta fixa no loopback — e a porta do aplicativo
instalado é sorteada a cada login. `servidor/src/google.rs` escolhe o par
pelo formato do endereço de retorno, que é a única coisa que distingue, de
fora, de qual casca veio o código.

O dono do serviço — quem abre a central de comando — sai daqui:

```text
ADMIN_EMAILS=voce@exemplo.com          # separados por vírgula, se houver mais de um
```

Sem a variável vale o padrão gravado em `contas.rs` (`ADMIN_PADRAO`). É
deliberado que isto seja ambiente e não banco: assim ninguém vira
administrador se cadastrando, e trocar de dono não exige uma migração. O
mesmo e-mail também abre a página `/admin` do servidor, com o token de sessão
do aplicativo — o `ADMIN_TOKEN` de antes continua valendo ali, para quando
não há sessão à mão.

Sem o par `_WEB`, tudo continua funcionando e o celular simplesmente **não
oferece o botão do Google** — entrar por e-mail e senha, e entrar sem conta,
seguem inteiros. No cliente Web, cadastre em *URIs de redirecionamento
autorizados* as duas formas do endereço, com e sem a barra final:
`https://call.aionixdev.com/app/` e `https://call.aionixdev.com/app`.

Se uma variável faltar ou a URL for inválida, o servidor registra o motivo sem
imprimir nenhum segredo e continua disponível em P2P. A imagem da nuvem compila
com `--features google,banco,livekit`; o sidecar não inclui essas dependências.

Grupos e histórico continuam em dois arquivos, sem banco de dados nenhum:
`grupos.json`, reescrito inteiro a cada mudança de estrutura, e
`mensagens.jsonl`, só acréscimo, compactado quando cresce demais. Sem a
variável de ambiente `DADOS` o servidor funciona igual e esquece tudo ao
fechar — é o caso do sidecar.

**Contas têm dois backends**, escolhidos em tempo de execução pela presença
de `DATABASE_URL` — não é o mesmo binário rodando de dois jeitos por acaso,
é uma escolha deliberada: contas crescem (mais campos de perfil, planos,
integrações) de um jeito que a estrutura de grupos não cresce, e é ali que um
banco relacional de verdade compensa — sobretudo a garantia de e-mail único
que o próprio Postgres impõe, em vez de um índice montado à mão em Rust com
uma janela de corrida entre dois cadastros simultâneos.

* **Postgres**, quando o binário foi compilado com `--features banco` **e**
  `DATABASE_URL` está no ambiente — o caso do servidor oficial. Três tabelas
  (`contas`, `atalhos`, `sessoes`), migradas automaticamente no boot a partir
  de `servidor/migracoes/`, sem `sqlx-cli` nem passo manual de implantação.
* **Um par de arquivos** (`contas.json`, `sessoes.json`), do mesmo jeito que
  sempre foi — o caso do sidecar que hospeda uma conversa em rede local sem
  internet, onde não há Postgres nenhum para se conectar.

Qualquer falha ao conectar ou migrar faz o servidor cair para o arquivo, em
vez de recusar subir — um `DATABASE_URL` fora do ar por um instante não deve
impedir até quem entra sem conta de conversar. E a troca do backend importa
sozinha, uma vez, o que estiver em `contas.json`/`sessoes.json` no volume:
é assim que uma conta criada antes de o Postgres existir não se perde.

O **"Entrar com o Google" fica atrás da opção de compilação `google`**, pelo
mesmo motivo do Postgres: ele arrasta um cliente HTTPS inteiro para trocar o
código de autorização pelo perfil, e esse cliente não serve a nada no
servidor caseiro — que não tem `client_secret` nem endereço público. `banco`,
`google` e `livekit` são opcionais e só entram na imagem da nuvem; essas
dependências do servidor não viajam no sidecar do aplicativo.

| Arquivo | Responsabilidade |
| --- | --- |
| `src/index.html` | Estrutura da interface |
| `src/estilo.css` | Tema escuro e componentes visuais |
| `src/app.js` | Estado da aplicação, canais, conversa, voz e palco |
| `src/sinal.js` | Cliente do canal de sinalização |
| `src/conta.js` | Cadastro, login, sessão e força de senha |
| `src/rtc.js` | Malha WebRTC com negociação perfeita |
| `src/livekit.js` | Transporte SFU, publicação e assinatura de trilhas LiveKit |
| `src/avatares.js` | Os seis mascotes, desenhados em SVG |
| `src/perfil.js` | Painel do próprio perfil e cartão de outra pessoa |
| `src/sons.js` | O sino de entrada e saída, sintetizado |
| `src/audio.js` | Motor de áudio: voz, soundboard e saídas por pessoa |
| `src/porta-de-ruido.js` | Porta adaptativa, ganho e medição na thread de áudio |
| `scripts/preparar-audio.mjs` | Leva o cliente LiveKit do pacote npm ao frontend do instalador |
| `src/tempo.js` | Tempo em call e histórico de quem passou por ela |
| `src/atividade.js` | O que mostrar do programa em uso, e com que calma |
| `src/emojis.js` | Emojis Unicode e os cinco emojis próprios do CALL |
| `src/painel.js` | A central de comando: abas, gráficos e tabelas, nas duas cascas |
| `src/painel.css` | A folha do painel — própria porque as duas cascas a usam |
| `src-tauri/src/atividade.rs` | Qual programa está em primeiro plano |
| `src-tauri/src/google.rs` | PKCE, navegador do sistema e porta de retorno |
| `src-tauri/src/tela.rs` | Som da transmissão via loopback, excluindo o próprio CALL |
| `src-tauri/src/lib.rs` | Comandos nativos, permissões e ajuste de memória |
| `servidor/src/main.rs` | Protocolo do servidor |
| `servidor/src/modelo.rs` | Grupos, mensagens e persistência em disco |
| `servidor/src/contas.rs` | Contas, senhas e sessões — backend de arquivo e de Postgres |
| `servidor/src/telemetria.rs` | De eventos crus a retenção, coortes, funil e séries — funções puras, com testes |
| `servidor/migracoes/0006_eventos.sql` | A tabela de eventos, e a nota do que **não** entra nela |
| `servidor/migracoes/` | Schema das contas, migrado automaticamente no boot |
| `servidor/src/google.rs` | Troca do código de autorização com o Google |

E a casca de celular, que reaproveita o núcleo acima sem copiá-lo:

| Arquivo | Responsabilidade |
| --- | --- |
| `movel/index.html` | Casca: abertura, pilha de telas, tira da call e abas |
| `movel/estilo.css` | Folha do celular — área segura, alvo de 44 px, teclado |
| `movel/app.js` | Partida: sessão, abas, tira da call, convite, Service Worker |
| `movel/nucleo.js` | Estado, protocolo, conta e voz — não desenha nada |
| `movel/navegacao.js` | Pilha de telas por aba e o gesto de voltar |
| `movel/interacao.js` | DOM, háptico, folhas, menus, avisos, teclado e o "voltar" do sistema |
| `movel/visual.js` | Retratos, texto com emoji, seletor de emoji e reações |
| `movel/foto.js` | Escolher e enquadrar foto com arrasto e pinça |
| `movel/telas/` | Portal, grupos, conversa, call, amigos, você, pessoas, soundboard, instalar |
| `movel/sw.js` | Service Worker: abre instantâneo e abre sem rede |
| `movel/manifest.webmanifest` | O que torna o aplicativo instalável |
| `scripts/montar-pwa.mjs` | Monta `docs/app/` a partir de `movel/` + os módulos de `src/` |
| `scripts/gerar-icones-pwa.mjs` | Rasteriza os ícones do PWA a partir do glifo do CALL |
| `scripts/servir-movel.mjs` | Bancada do celular, com recarga ao salvar |

---

## Desenvolvimento

```powershell
npm install
npm run dev        # aplicativo de Windows, com recarga
npm run build      # gera o instalador

npm run dev:movel  # o celular em http://127.0.0.1:8125/movel/, com recarga
npm run montar:pwa # monta docs/app/, que é o que a Vercel publica
npm run icones:pwa # regera os ícones do PWA
```

A bancada do celular serve a raiz do repositório, e não uma cópia montada:
`movel/` importa `../src/` de verdade, então corrigir o protocolo corrige nos
dois clientes sem passo de build. Duas ressalvas ao abrir pelo IP da rede
local: `getUserMedia` exige contexto seguro (o IP não conta — use o
encaminhamento de porta do DevTools ou uma URL https), e o Service Worker só
se registra em `localhost` com `?sw=1`.

O site publicado é `docs/`, e `docs/app/` é **gerado** — está no
`.gitignore` e a Vercel o reconstrói a cada publicação, pelo `buildCommand`
do `vercel.json`.

O sidecar é um binário compilado e não é versionado. Gere-o antes do primeiro
`npm run build`, e de novo sempre que `servidor/src/main.rs` mudar:

```powershell
cargo build --release -p sinalizacao
Copy-Item target\release\sinalizacao.exe `
  src-tauri\binaries\sinalizacao-x86_64-pc-windows-msvc.exe -Force
```

### Testes

```powershell
cargo test -p sinalizacao                    # e-mail, senha, sessão e castigo
cargo test -p sinalizacao --features banco   # o mesmo, com o backend Postgres compilado
cargo test -p call --lib                     # PKCE, convite e atividade
node testes/sinalizacao.test.mjs             # protocolo do servidor, contas inclusas
node testes/tempo.test.mjs                   # cronômetro e histórico da call
node testes/atividade.test.mjs               # política do que se anuncia
node testes/painel.test.mjs                  # a central de comando: porta fechada, números reais, ao vivo
node testes/midia.test.mjs                   # a escada de mídia: queda, desvio e o consumo que sobrevive ao redeploy
powershell -File testes/rodar-malha.ps1      # malha WebRTC e áudio no motor real
powershell -File testes/rodar-portal.ps1     # entrar e criar conta na aplicação real
powershell -File testes/rodar-perfil.ps1     # perfil, mascotes e cartão de alguém
powershell -File testes/rodar-interface.ps1  # painel de ajustes na aplicação real
powershell -File testes/rodar-motor-audio.ps1 # captura, filtros, porta e trilha enviada
powershell -File testes/rodar-livekit-nuvem.ps1 # SFU e falantes ativos na infraestrutura real
powershell -File testes/rodar-sons.ps1       # o sino, medido na amostra renderizada
powershell -File testes/rodar-movel.ps1      # o aplicativo de celular, num quadro de iPhone
powershell -File testes/capturar-movel.ps1   # fotografa cada tela do celular
powershell -File testes/capturar-site.ps1    # fotografa o seletor de plataforma do site
powershell -File testes/capturar-painel.ps1  # fotografa a central de comando, aba por aba
node testes/painel-semente.mjs               # semeia 30 dias de história e deixa o servidor de pé
powershell -File testes/duas-instancias.ps1  # duas janelas reais no mesmo grupo
powershell -File testes/convite.ps1          # o link call:// abrindo o grupo
```

Tudo até `rodar-sons.ps1` é automático e roda sem tomar a tela — os `rodar-*`
usam o Edge em modo *headless*. Os dois últimos dirigem janelas reais, deixam
capturas em `testes/capturas`, tomam o mouse e o teclado enquanto rodam, e não
devem correr ao mesmo tempo: cada um começa encerrando o servidor local do
outro.

`CALL_APELIDO` faz o aplicativo pular o portal de conta e entrar direto, sem
conta, com o apelido dado — é assim que os roteiros de janela real evitam
preencher formulário por coordenada de clique.

**O backend Postgres não tem suíte automatizada.** `cargo test --features
banco` confere que o binário compila com o driver dentro e continua a
exercitar a lógica de `contas.rs` — mas os testes de unidade rodam sem
`DATABASE_URL`, e por isso caem no backend de arquivo mesmo com a opção
ligada. As consultas SQL em si foram verificadas à mão contra um Postgres de
verdade (um túnel `railway connect` até o serviço da nuvem) antes de cada
deploy; não há uma suíte que repita isso sozinha. É o próximo passo óbvio se
o schema crescer.

---

## Limites conhecidos

- **A malha é rede de segurança, e não plano.** Ela é adequada a grupos
  pequenos: cada participante envia sua mídia para todos os outros. Até quatro
  ou cinco pessoas vai bem; a partir daí a transmissão de tela sofre bastante.
  Quando a escada de mídia cai até ela, a call acontece — mas com qualidade
  menor, e o rodapé diz isso a quem está dentro. Um degrau de LiveKit próprio
  (`LIVEKIT_RESERVA_*`) é o que evita chegar até aqui.
- **O medidor de consumo mede do lado de cá.** Os minutos-participante e os
  bytes recebidos do SFU são contados pelo servidor e pelos clientes do CALL,
  e comparados com um teto que o dono declara no ambiente. É um alarme, e não
  uma fatura: o painel do provedor continua sendo a fonte de verdade, e uma
  diferença entre os dois números é esperada — a nossa medida não enxerga o
  que o provedor cobra por fora (gravação, egress, tráfego de reconexão).
- O TURN é só por TCP e passa pela região do Railway, longe do Brasil: quando
  a call precisa dele, a latência sobe. Um TURN gerenciado com UDP e presença
  em São Paulo seria melhor; este é o que cabe sem conta nova em lugar nenhum.
  E só ajuda quando os dois lados têm a v0.20.0 ou mais nova.
- A porta 8787 só entra em jogo para quem usa **Hospedar**: nesse caso ela
  precisa estar liberada no firewall da máquina que hospeda. Com o servidor
  oficial, não há porta a abrir.
- **O convite continua sendo a única chave dos grupos.** A conta diz quem você
  é, não o que você pode: quem tem o código entra, com conta ou sem. Isso é
  deliberado, e é o que mantém o CALL utilizável entre amigos — mas significa
  que ele não serve para dados sensíveis.
- Quem entra sem conta continua se identificando por um número que o próprio
  cliente informa, e que não prova nada. O prefixo `conta-` é o único
  reservado: alegá-lo sem token é recusado pelo servidor.
- Não há recuperação de senha. Esquecer a senha de uma conta que não está
  vinculada ao Google significa criar outra — não existe envio de e-mail em
  lugar nenhum do projeto, e inventar um servidor de e-mail para isto custaria
  mais do que todo o resto do servidor junto.
- O aplicativo de Windows abre o Google por `ShellExecuteW`, e por isso o
  login do Google ali só funciona no Windows. No celular o fluxo é o padrão da
  web (PKCE, ida ao `accounts.google.com` e volta para a própria página), o
  que exige um **segundo cliente OAuth, do tipo "Aplicativo da Web"** — ver
  `GOOGLE_CLIENT_ID_WEB` em "Arquitetura". Enquanto ele não existir no
  ambiente, o botão do Google não aparece no celular em vez de aparecer e
  falhar; entrar por e-mail e senha, e entrar sem conta, seguem inteiros.
- **Transmitir a própria tela não existe no celular.** `getDisplayMedia` não
  é implementado em navegador de celular — nem no Chrome do Android, nem no
  Safari do iOS. Assistir à tela de quem transmite do computador funciona, e o
  botão de transmitir simplesmente não aparece em vez de aparecer e falhar.
- No celular o CALL é uma página, e uma página só continua com o microfone
  aberto enquanto o navegador a mantém viva. Trocar de aplicativo por muito
  tempo, ou o sistema decidir economizar bateria, derruba a call — e é por isso
  que a tira do rodapé existe: sair da tela da call *dentro* do CALL não
  derruba nada, e ela deixa isso visível.
