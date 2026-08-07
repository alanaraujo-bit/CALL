# CALL

Aplicativo de comunicação para Windows: **grupos com canais**, **chat de
texto**, **chat de voz** e **transmissão de tela**. Interface inteiramente em
português do Brasil.

Construído em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
empacotador e sem Electron. O instalador tem 1,85 MB e o executável ocupa
32 MB de memória residente em repouso — 7,9 MB deles em memória privada.

O aplicativo se atualiza sozinho: quando sai uma versão nova, ele avisa e
instala com um clique, sem sair da tela. Página do projeto:
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

### 1. Abra, escolha um apelido e um mascote

Não há nada a configurar. O aplicativo já vem apontado para o servidor oficial
do CALL, hospedado — ninguém precisa deixar máquina ligada nem passar IP.

A tela de entrada oferece seis mascotes — coruja, raposa, axolote, capivara,
polvo e dragão —, desenhados para o CALL. Quem não escolher nenhum ganha um
sorteado, para que ninguém apareça como mais um círculo cinza igual ao dos
outros.

O servidor apenas apresenta os participantes uns aos outros e guarda a
estrutura dos grupos e o histórico dos canais de texto. **Áudio e vídeo nunca
passam por ele** — trafegam diretamente entre as máquinas.

Em "Usar um servidor próprio", na tela de entrada, dá para apontar para outro
endereço. **Hospedar** sobe um servidor nesta máquina, na porta 8787, útil em
rede local ou sem internet; ele fecha junto com o aplicativo.

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
de trabalho vazia não conta, e o recurso se desliga num clique.

### 5. Deixe o perfil com a sua cara

Clique no seu nome, no canto inferior esquerdo, para abrir **Meu perfil**:
apelido, uma **bio** de até 160 caracteres e o **mascote**. A prévia no topo
mostra, enquanto você digita, exatamente o que os outros vão ver. Trocar
qualquer coisa vale na hora, inclusive com um grupo aberto.

Clique em alguém — na lista de presentes ou embaixo de um canal de voz — para
ver o cartão dessa pessoa: mascote, bio, se é dona do grupo e o que ela está
usando. O volume dela também fica ali (e continua no botão direito, para quem
já tinha o atalho na mão). O volume é lembrado entre sessões.

O perfil fica **neste computador** e viaja junto de você a cada entrada em um
grupo. O servidor não guarda nada disso: ele repassa aos outros enquanto você
está conectado e esquece quando você fecha o CALL. Não é conta e não autentica
ninguém — quem troca de máquina começa de novo.

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

A persistência são dois arquivos, e nenhum banco de dados: `grupos.json`,
reescrito inteiro a cada mudança de estrutura, e `mensagens.jsonl`, só
acréscimo, compactado quando cresce demais. Sem a variável de ambiente `DADOS`
o servidor funciona igual e esquece tudo ao fechar — é o caso do sidecar.

| Arquivo | Responsabilidade |
| --- | --- |
| `src/index.html` | Estrutura da interface |
| `src/estilo.css` | Tema escuro e componentes visuais |
| `src/app.js` | Estado da aplicação, canais, conversa, voz e palco |
| `src/sinal.js` | Cliente do canal de sinalização |
| `src/rtc.js` | Malha WebRTC com negociação perfeita |
| `src/avatares.js` | Os seis mascotes, desenhados em SVG |
| `src/perfil.js` | Painel do próprio perfil e cartão de outra pessoa |
| `src/sons.js` | O sino de entrada e saída, sintetizado |
| `src/tempo.js` | Tempo em call e histórico de quem passou por ela |
| `src/atividade.js` | O que mostrar do programa em uso, e com que calma |
| `src-tauri/src/atividade.rs` | Qual programa está em primeiro plano |
| `src-tauri/src/lib.rs` | Comandos nativos, permissões e ajuste de memória |
| `servidor/src/main.rs` | Protocolo do servidor |
| `servidor/src/modelo.rs` | Grupos, mensagens e persistência em disco |

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
node testes/sinalizacao.test.mjs             # protocolo do servidor
powershell -File testes/rodar-malha.ps1      # malha WebRTC e áudio no motor real
powershell -File testes/rodar-interface.ps1  # painel de ajustes na aplicação real
powershell -File testes/duas-instancias.ps1  # duas janelas reais no mesmo grupo
powershell -File testes/convite.ps1          # o link call:// abrindo o grupo
powershell -File testes/ajustes.ps1          # o painel dentro do WebView2
```

Os três primeiros são automáticos e não pedem permissões de mídia. Os três
últimos dirigem a interface real e deixam capturas em `testes/capturas`; eles
tomam o mouse e o teclado enquanto rodam, e não devem correr ao mesmo tempo —
cada um começa encerrando o servidor local do outro.

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
- O servidor oficial não autentica ninguém. Quem tem o código do convite
  entra, e o identificador de usuário é o que o cliente informa — bom o
  bastante para um grupo de amigos, e não para dados sensíveis.
