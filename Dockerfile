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

RUN cargo build --release -p sinalizacao

# ─── Imagem final ──────────────────────────────────────────────────────
FROM scratch

COPY --from=construcao /fonte/target/release/sinalizacao /sinalizacao

# Onde o volume do Railway e montado. Sem esta variavel o servidor funciona
# igual, so que esquece tudo a cada reinicio.
ENV DADOS=/dados

# O Railway injeta PORT; o 8787 vale para quem rodar a imagem na mao.
ENV PORT=8787
EXPOSE 8787

ENTRYPOINT ["/sinalizacao"]
