# Bloqueios e ressalvas — sessão de 2026-08-19

Nenhum item aqui impede o resto do trabalho: são registros de algo que só o
Alan pode decidir ou verificar, não pendências de código.

## 1. Três grupos de teste "Estúdio" ficaram no servidor de produção

Ao automatizar a captura de tela da sala de voz (`testes/cena.html`, cenas
"voz"/"voz-chat"), descobri que a própria `testes/cena.html` tinha um defeito
antigo: o endereço do servidor virou preferência (`localStorage`) desde que o
campo saiu da tela de entrada, mas a cena continuava tentando escrevê-lo num
campo (`#campo-servidor`) que já não fica nessa tela — então a semeadura nunca
tinha efeito, e o aplicativo caía no padrão, `SERVIDOR_PADRAO` em `app.js`
(`wss://sinalizacao-production.up.railway.app`, o servidor de produção).

Antes de eu perceber isso e corrigir (semear `localStorage` antes do quadro
carregar, como `testes/perfil.html` já fazia), três execuções de depuração
criaram grupos reais de nome "Estúdio" no servidor de produção, com códigos de
convite aleatórios de 10 caracteres que não anotei todos — um deles foi
`M7GFVB4Y55`. São grupos vazios, sem ninguém além de um participante de teste
efêmero ("Bruna", que nunca ficou conectada), e o código não foi compartilhado
em lugar nenhum — mas existem lá, ocupando uma entrada no arquivo de grupos do
servidor hospedado.

**O que falta:** decidir se vale a pena removê-los (o servidor não expõe uma
rota de exclusão de grupo por código para quem não é o dono logado, e "dono"
aqui é um `usuario` aleatório de uma sessão de teste que não voltará). Na
prática são inofensivos — sem conteúdo, sem acesso de ninguém — mas o Alan
deve saber que existem.

**O que já foi corrigido:** `testes/cena.html` agora semeia
`call.preferencias` no `localStorage` antes do `<iframe>` carregar (mesma
técnica de `testes/perfil.html`), então toda cena passou a rodar contra o
servidor local que `testes/capturar-desktop.ps1` sobe (porta 8898, sem
`DADOS` — não grava nada em disco). Reexecutei as cenas "entrada", "login",
"grupo", "voz", "voz-chat" e "cartão" depois da correção e todas criam grupo
contra o servidor local, confirmado pelo próprio `__log` de mensagens do
WebSocket durante a depuração.

## 2. Tela cheia (F11) não foi vista com os próprios olhos

A troca de tela cheia (`alternarTelaCheia` em `app.js`, usando
`window.__TAURI__.window`) só existe dentro do aplicativo Tauri compilado — a
verificação visual desta sessão rodou inteira no Edge headless (via
`testes/cena.html`), que não tem `window.__TAURI__` e não pode mostrar o
comportamento de tela cheia nativa da janela.

**O que já foi verificado:** a permissão `core:window:allow-set-fullscreen`
foi adicionada em `src-tauri/capabilities/default.json`, `cargo build` compila
sem erro, e o código do atalho segue o mesmo padrão defensivo do resto do
aplicativo (`window.__TAURI__?.window?.getCurrentWindow?.()`, que não quebra
fora do app instalado — só não faz nada, do mesmo jeito que o atalho global de
mudo já se comporta no navegador e no celular).

**O que falta:** abrir o `.exe` de verdade (há um em `target\debug\call.exe`,
compilado nesta sessão) e apertar F11 para ver a janela perder as bordas.
Ambiente sem interação gráfica direta nesta sessão — é um clique de trinta
segundos da próxima vez que o Alan estiver na máquina.

## 3. Efeito sonoro de mutar/desmutar: só medido, não ouvido

`testes/rodar-sons.ps1` mede os dois sons novos (`mudo`, `desmudo`) em
`OfflineAudioContext` — pico dentro da faixa alvo, direção do gesto (desce ao
mutar, sobe ao desmutar), sem estalo, sem clipping — as mesmas 6 medidas que
os quatro sons antigos já passavam, e todas passaram. O que a medição não
prova é se o timbre agrada ao ouvido; isso só se avalia ouvindo, e esta sessão
não tem alto-falante. Se o Alan quiser ajustar o timbre depois de ouvir,
`RECEITAS.mudo`/`RECEITAS.desmudo` em `src/sons.js` são os dois números
(`ganho`, `peso`) que valem mexer — o teste dirá se a mudança ainda cabe na
faixa.
