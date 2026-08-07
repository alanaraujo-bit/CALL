# Imagem do servidor de sinalizacao do CALL, para hospedagem no Railway.
#
# O binario e ligado estaticamente contra a musl, entao a imagem final nao
# precisa de sistema operacional nenhum: e o executavel e mais nada. Isso
# mantem o deploy rapido e a superficie de ataque no chao.

# ─── Compilacao ────────────────────────────────────────────────────────
FROM rust:1-alpine AS construcao

RUN apk add --no-cache musl-dev

WORKDIR /fonte

# Só o servidor entra aqui. O membro `src-tauri` do workspace arrasta o
# Tauri inteiro e as bibliotecas de interface do Linux, que nao tem nada a
# ver com este binario — por isso a raiz do workspace e reescrita.
COPY servidor/Cargo.toml servidor/Cargo.toml
COPY servidor/src servidor/src
# O `sqlx::migrate!` em `src/contas.rs` embute estes arquivos no binario em
# tempo de compilacao -- por isso entram aqui, antes do `cargo build`, e nao
# so na imagem final. O schema vira parte do executavel; nao ha pasta de
# migracoes para copiar depois.
COPY servidor/migracoes servidor/migracoes
COPY Cargo.lock Cargo.lock

RUN printf '[workspace]\n\
members = ["servidor"]\n\
resolver = "2"\n\
\n\
[profile.release]\n\
opt-level = "z"\n\
lto = true\n\
codegen-units = 1\n\
panic = "abort"\n\
strip = true\n\
incremental = false\n' > Cargo.toml

# `--features google,banco` e o que separa esta imagem do binario que viaja
# dentro do instalador do CALL:
#
# * `google` liga "Entrar com o Google", que arrasta um cliente HTTPS inteiro
#   -- 599 KB viram 1,93 MB. Ver `servidor/src/google.rs`.
# * `banco` liga o Postgres como backend das contas -- ver `servidor/src/contas.rs`.
#
# As duas pagariam por recursos que o sidecar da rede local nem teria como
# usar: ele nao tem `client_secret` nem `DATABASE_URL`. Sem estas opcoes o
# servidor compila e roda igual, so que guarda contas num par de arquivos.
RUN cargo build --release -p sinalizacao --features google,banco

# ─── Imagem final ──────────────────────────────────────────────────────
FROM scratch

COPY --from=construcao /fonte/target/release/sinalizacao /sinalizacao

# Onde o volume do Railway e montado. Sem esta variavel o servidor funciona
# igual, so que esquece tudo a cada reinicio -- inclusive as contas.
ENV DADOS=/dados

# Entrar com o Google precisa das duas variaveis abaixo, definidas no painel
# da hospedagem e nunca aqui: `GOOGLE_CLIENT_SECRET` e segredo de verdade, e o
# unico motivo de a troca do codigo acontecer no servidor e nao no aplicativo.
#
# Os dois valores saem de um cliente OAuth do tipo "Aplicativo para computador"
# no Google Cloud Console. Sem eles o servidor sobe igual e apenas responde
# que o botao nao existe -- e a interface nao o mostra.
#
#   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
#   GOOGLE_CLIENT_SECRET=...

# O Railway injeta PORT; o 8787 vale para quem rodar a imagem na mao.
ENV PORT=8787
EXPOSE 8787

ENTRYPOINT ["/sinalizacao"]
