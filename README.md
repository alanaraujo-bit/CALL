# CALL

Aplicativo de comunicação para Windows com exatamente três recursos: **grupos**,
**chat de voz** e **transmissão de tela**. Interface inteiramente em português
do Brasil.

Construído em Tauri — Rust no back-end, HTML/CSS/JS puro no front-end, sem
empacotador e sem Electron. O instalador tem 1,61 MB e o executável ocupa
26 MB de memória residente em repouso — 5,7 MB deles em memória privada.

O aplicativo se atualiza sozinho: quando sai uma versão nova, ele avisa e
instala com um clique, sem sair da tela. Página do projeto:
**https://call-rho-dusky.vercel.app/** — e o mesmo conteúdo em
https://alanaraujo-bit.github.io/CALL/

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

### 2. Crie ou escolha um grupo

Clique em **+** na coluna da esquerda. Quem entrar com o mesmo nome de grupo,
no mesmo servidor, fica na mesma conversa. Os grupos ficam salvos localmente.

### 3. Converse

Ao entrar em um grupo, o microfone é capturado e a voz começa a fluir. Use
**Microfone** para silenciar e **Transmitir tela** para compartilhar uma
janela ou a tela inteira.

---

## Arquitetura

```
call.exe                 janela Tauri + interface
  └─ WebView2            renderização e pilha WebRTC
sinalizacao.exe          servidor de sinalização (sidecar, só ao hospedar)
```

Cada participante abre uma conexão direta com cada um dos outros (topologia
em malha). O servidor encaminha apenas ofertas, respostas e candidatos ICE,
além de avisar quem entrou, quem saiu e quem está mudo ou transmitindo.

| Arquivo | Responsabilidade |
| --- | --- |
| `src/index.html` | Estrutura da interface |
| `src/estilo.css` | Tema escuro e componentes visuais |
| `src/app.js` | Estado da aplicação, grupos, controles, palco |
| `src/sinal.js` | Cliente do canal de sinalização |
| `src/rtc.js` | Malha WebRTC com negociação perfeita |
| `src-tauri/src/lib.rs` | Comandos nativos, permissões e ajuste de memória |
| `servidor/src/main.rs` | Servidor de sinalização |

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
powershell -File testes/duas-instancias.ps1  # duas janelas reais na mesma sala
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
