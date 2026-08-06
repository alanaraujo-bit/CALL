# CALL

Aplicativo de comunicação para Windows: **grupos com canais**, **chat de
texto**, **chat de voz** e **transmissão de tela**. Interface inteiramente em
português do Brasil.

Construído em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
empacotador e sem Electron. O instalador tem 1,61 MB e o executável ocupa
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

### 1. Escolha um servidor de sinalização

O servidor apenas apresenta os participantes uns aos outros. Áudio e vídeo
nunca passam por ele — trafegam diretamente entre as máquinas.

- **Para hospedar:** clique em **Hospedar** na tela de entrada. Um servidor
  sobe nesta máquina na porta 8787. Passe aos demais o seu endereço na rede,
  no formato `ws://SEU-IP:8787`.
- **Para entrar no de outra pessoa:** cole o endereço recebido.

### 2. Crie um grupo ou entre com um convite

**Criar grupo** devolve um código de convite de dez caracteres — é ele que se
compartilha, e não o nome do grupo. Quem recebe usa **Entrar com convite**. Os
grupos ficam salvos na coluna da esquerda e vivem no servidor: estrutura e
histórico sobrevivem a fechar o aplicativo.

### 3. Converse

Cada grupo tem categorias e canais. Canais de **texto** guardam as últimas 500
mensagens; canais de **voz** ligam os participantes entre si.

Clique num canal de texto para ler e escrever. Clique num canal de voz para
entrar nele — só aí o microfone é capturado. Uma vez na voz, use **Microfone**
para silenciar e **Transmitir** para compartilhar uma janela ou a tela inteira.

Quem cria o grupo é o dono, e só ele cria, renomeia e remove categorias e
canais. O convite dá acesso à conversa, não à estrutura.

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
powershell -File testes/rodar-malha.ps1      # malha WebRTC no motor real
powershell -File testes/duas-instancias.ps1  # duas janelas reais no mesmo grupo
```

Os dois primeiros são automáticos e não pedem permissões de mídia. O terceiro
dirige a interface real e deixa capturas em `testes/capturas`.

---

## Limites conhecidos

- A topologia em malha é adequada a grupos pequenos: cada participante envia
  sua mídia para todos os outros. Grupos grandes exigiriam um servidor
  intermediário de mídia.
- Sem servidor TURN configurado, participantes atrás de NATs restritivos
  podem não se conectar. Há apenas STUN público configurado em `src/rtc.js`.
- A porta 8787 precisa estar liberada no firewall da máquina que hospeda.
