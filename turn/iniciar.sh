#!/bin/sh
# Partida do TURN do CALL.
#
# A credencial e efemera: o servidor de sinalizacao assina, com o mesmo
# `TURN_SECRET`, um usuario que expira em 24 horas (o "TURN REST API" que o
# coturn entende com `--use-auth-secret`). Nenhuma senha fixa viaja dentro do
# aplicativo.

set -eu

if [ -z "${TURN_SECRET:-}" ]; then
  echo "[turn] TURN_SECRET ausente; sem ele qualquer um usaria este repasse." >&2
  exit 1
fi

# O endereco IPv4 do proprio conteiner. Sem UDP publico no Railway, o unico
# caminho que funciona e o repasse entre duas alocacoes deste mesmo processo:
# os dois lados da call entram por TCP, e o coturn passa os pacotes de uma
# alocacao para a outra pela propria maquina. Para isso o endereco anunciado
# precisa ser o do conteiner — e por isso nao ha `--external-ip` aqui, ao
# contrario do que quase todo guia de coturn manda fazer.
proprio="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n 1 || true)"
if [ -z "$proprio" ]; then
  proprio="$(awk '/32 host/ { print ip } { ip = $2 }' /proc/net/fib_trie 2>/dev/null | grep -v '^127\.' | head -n 1 || true)"
fi
if [ -z "$proprio" ]; then
  echo "[turn] nao achei o IPv4 do conteiner." >&2
  exit 1
fi
echo "[turn] repassando por $proprio"

# Quem tem um codigo de grupo recebe credencial — inclusive quem entra sem
# conta. Sem as negacoes abaixo, isto seria um repasse aberto para dentro da
# rede privada do Railway, onde mora o Postgres. Tudo que e privado fica
# negado; so o proprio conteiner (o repasse entre alocacoes) e liberado.
#
# Os tetos de banda sao em BYTES por segundo, nao bits: 500 KB/s sao 4 Mbps
# por sessao (voz e uma tela em qualidade media cabem folgados) e 7,5 MB/s sao
# 60 Mbps para o servidor inteiro. O trafego que sai daqui e cobrado pelo
# Railway, e foi custo de midia que tirou o CALL do ar da outra vez.
exec turnserver \
  --listening-port=3478 \
  --relay-ip="$proprio" \
  --min-port=49152 --max-port=65535 \
  --realm=call.aionixdev.com \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" \
  --fingerprint \
  --no-tls --no-dtls --no-cli \
  --no-tcp-relay \
  --no-multicast-peers \
  --no-software-attribute \
  --denied-peer-ip=0.0.0.0-0.255.255.255 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 \
  --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --allowed-peer-ip="$proprio" \
  --max-bps=500000 \
  --bps-capacity=7500000 \
  --total-quota=120 \
  --stale-nonce=600 \
  --log-file=stdout --simple-log
