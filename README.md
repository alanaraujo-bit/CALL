# CALL

Aplicativo de comunicação para Windows: **grupos com canais**, **chat de
texto**, **chat de voz** e **transmissão de tela**. Interface inteiramente em
português do Brasil.

Construído em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
empacotador e sem Electron. O instalador tem 1,71 MB e o executável ocupa
26 MB de memória residente em repouso — 5,7 MB deles em memória privada.

O aplicativo se atualiza sozinho: quando sai uma versão nova, ele avisa e
instala com um clique, sem sair da tela. Página do projeto:
**https://alanaraujo-bit.github.io/CALL/**

> A publicação espelhada na Vercel (`call-rho-dusky.vercel.app`) está fora do
> ar desde a v0.2.0: o endereço responde `DEPLOYMENT_NOT_FOUND`, ou seja, o
> projeto foi removido do lado da plataforma. O `vercel.json` continua no
> repositório e a religação é feita pelo painel da Vercel.

---

## Instalação

Execute `target/release/bundle/nsis/CALL_0.1.0_x64-setup.exe`. A instalação é
por usuário e não exige privilégios de administrador. O único requisito é o
**WebView2**, presente por padrão no Windows 10 e 11.

---

## Como usar

### 1. Abra e escolha um apelido

Não há nada a configurar. O aplicativo já vem apontado para o servidor oficial
do CALL, hospedado — ninguém precisa deixar máquina ligada nem passar IP.

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

O volume de cada pessoa fica no botão direito sobre o nome dela, na lista de
presentes, e é lembrado entre sessões.

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
