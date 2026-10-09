# Bloqueios e ressalvas — sessão de 2026-08-19

Nenhum item aqui impede o resto do trabalho: são registros de algo que só o
Alan pode decidir ou verificar, não pendências de código.

## 1. ~~Três grupos de teste "Estúdio" no servidor de produção~~ — resolvido

O servidor de produção daquela época foi desligado, e o de hoje (recriado em
2026-10-09) nasceu com volume e banco vazios: os grupos de teste não existem
mais. A correção de `testes/cena.html` continua valendo.

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
