# CALL

Aplicativo de comunicação para Windows: **grupos com canais**, **chat de
texto**, **chat de voz** e **transmissão de tela**. Interface inteiramente em
português do Brasil.

Construído em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
empacotador e sem Electron. O instalador tem 1,95 MB e o executável ocupa
32 MB de memória residente em repouso — 7,9 MB deles em memória privada.

O aplicativo se atualiza sozinho: quando sai uma versão nova, ele avisa e
instala com um clique, sem sair da tela. Quem responder "Depois" continua
vendo uma marca discreta no alto da janela, que fica lá até a atualização ser
feita — dispensar o aviso não faz a versão nova ser esquecida. Antes de
atualizar, "Ver o que há de novo" mostra o que a versão traz, escrito para
gente e organizado por blocos — o aviso deixa de ser uma ordem e vira uma
escolha informada. Página do projeto:
**https://alanaraujo-bit.github.io/CALL/**

> A publicação espelhada na Vercel (`call-rho-dusky.vercel.app`) está fora do
> ar desde a v0.2.0: o endereço responde `DEPLOYMENT_NOT_FOUND`, ou seja, o
> projeto foi removido do lado da plataforma. O `vercel.json` continua no
> repositório e a religação é feita pelo painel da Vercel.

---

## Instalação

Baixe o instalador da versão mais recente em
**[Releases](https://github.com/alanaraujo-bit/CALL/releases/latest)** e
execute. A instalação é por usuário e não exige privilégios de administrador.
O único requisito é o **WebView2**, presente por padrão no Windows 10 e 11.

Quem já tem o CALL instalado não precisa baixar nada: o próprio aplicativo
detecta a versão nova e oferece a atualização.

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

O servidor apenas apresenta os participantes uns aos outros e guarda a
estrutura dos grupos e o histórico dos canais de texto. **Áudio e vídeo nunca
passam por ele** — trafegam diretamente entre as máquinas.

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

As mensagens aceitam **reação com emoji** — cinco, desenhados para o CALL —
num clique, e todo mundo no canal vê a contagem na hora. O aplicativo também
tem **soundboard de grupo**: uma biblioteca de sons que qualquer um na call
adiciona e toca para todos. Os clipes ficam no servidor, mas o áudio em si vai
direto pela sua conexão — quem toca mistura o som no próprio áudio de saída, e
o servidor nem vê um byte no caminho de quem ouve.

Quem cria o grupo é o dono, e só ele cria, renomeia e remove categorias e
canais. O convite dá acesso à conversa, não à estrutura.

### 4. Ajuste a voz e a imagem

A engrenagem ao lado do seu nome, no canto inferior esquerdo, abre os ajustes.

Em **Voz**: microfone e saída de som, volume de entrada e geral, e uma
**porta de ruído** que cala o ruído de fundo entre as falas. Ela não é um corte
seco — o limiar acompanha o ruído medido da sua sala, e o medidor ao vivo mostra
o seu nível, o piso da sala e onde a porta abre, para o ajuste ser visto e não
adivinhado. A qualidade da voz vai de 32 a 128 kbps e vale só para o que sai da
sua máquina: a sua escolha não limita a voz de ninguém.

Em **Transmissão**: quatro perfis, de 720p a 30 quadros até 1440p a 60. Os de
até 30 quadros usam VP9, que rende muito mais em texto; os de 60 usam H.264, que
tem codificador em hardware e mantém a transmissão leve num jogo. Trocar de
perfil durante uma transmissão vale na hora. O **som do sistema** viaja numa
trilha separada da sua voz, no teto do codec e sem os filtros de voz — um
cancelador de eco destrói música e efeito de jogo.

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

---

## Arquitetura

```
call.exe                 janela Tauri + interface
  └─ WebView2            renderização e pilha WebRTC
sinalizacao.exe          servidor de sinalização (sidecar, só ao hospedar)
```

O servidor guarda a estrutura dos grupos e o histórico dos canais de texto, e
encaminha ofertas, respostas e candidatos ICE entre quem está no **mesmo canal
de voz**. A mídia não passa por ele: cada participante abre uma conexão direta
com cada um dos outros (topologia em malha), e a malha se forma por canal —
estar no mesmo grupo não é estar na mesma conversa.

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
servidor caseiro — que não tem `client_secret` nem endereço público. Sozinho,
o `google` leva o servidor de 599 KB a 1,93 MB; com `banco` junto (a
combinação que a imagem da nuvem de fato compila), a 2,34 MB. Nenhum desses
KB viaja no instalador do CALL: o sidecar continua nos 599 KB de sempre.

| Arquivo | Responsabilidade |
| --- | --- |
| `src/index.html` | Estrutura da interface |
| `src/estilo.css` | Tema escuro e componentes visuais |
| `src/app.js` | Estado da aplicação, canais, conversa, voz e palco |
| `src/sinal.js` | Cliente do canal de sinalização |
| `src/conta.js` | Cadastro, login, sessão e força de senha |
| `src/rtc.js` | Malha WebRTC com negociação perfeita |
| `src/avatares.js` | Os seis mascotes, desenhados em SVG |
| `src/perfil.js` | Painel do próprio perfil e cartão de outra pessoa |
| `src/sons.js` | O sino de entrada e saída, sintetizado |
| `src/audio.js` | Motor de áudio: voz, soundboard e saídas por pessoa |
| `src/tempo.js` | Tempo em call e histórico de quem passou por ela |
| `src/atividade.js` | O que mostrar do programa em uso, e com que calma |
| `src/emojis.js` | Os cinco emoji de reação, desenhados em SVG |
| `src-tauri/src/atividade.rs` | Qual programa está em primeiro plano |
| `src-tauri/src/google.rs` | PKCE, navegador do sistema e porta de retorno |
| `src-tauri/src/lib.rs` | Comandos nativos, permissões e ajuste de memória |
| `servidor/src/main.rs` | Protocolo do servidor |
| `servidor/src/modelo.rs` | Grupos, mensagens e persistência em disco |
| `servidor/src/contas.rs` | Contas, senhas e sessões — backend de arquivo e de Postgres |
| `servidor/migracoes/` | Schema das contas, migrado automaticamente no boot |
| `servidor/src/google.rs` | Troca do código de autorização com o Google |

---

## Desenvolvimento

```powershell
npm install
npm run dev      # desenvolvimento com recarga
npm run build    # gera o instalador
```

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
powershell -File testes/rodar-malha.ps1      # malha WebRTC e áudio no motor real
powershell -File testes/rodar-portal.ps1     # entrar e criar conta na aplicação real
powershell -File testes/rodar-perfil.ps1     # perfil, mascotes e cartão de alguém
powershell -File testes/rodar-interface.ps1  # painel de ajustes na aplicação real
powershell -File testes/rodar-sons.ps1       # o sino, medido na amostra renderizada
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

- A topologia em malha é adequada a grupos pequenos: cada participante envia
  sua mídia para todos os outros. Grupos grandes exigiriam um servidor
  intermediário de mídia.
- Sem servidor TURN configurado, participantes atrás de NATs restritivos
  podem não se conectar. Há apenas STUN público configurado em `src/rtc.js`.
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
- O login do Google só funciona no Windows: ele abre o navegador por
  `ShellExecuteW`. É a mesma fronteira já declarada da atividade em primeiro
  plano, e o CALL só é distribuído para Windows.
