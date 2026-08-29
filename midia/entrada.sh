#!/bin/sh
# O LiveKit proprio do CALL, rodando no Railway.
#
# Este arquivo existe por causa de uma incompatibilidade real entre o que o
# WebRTC quer e o que o Railway oferece, e quase tudo aqui e a costura entre
# os dois. Vale a pena entender antes de mexer.
#
# ## O Railway nao roteia UDP
#
# WebRTC prefere UDP: perder um pacote de audio e melhor do que atrasar todos
# os seguintes esperando a retransmissao dele. O Railway so encaminha TCP.
# Entao este servidor roda em modo TCP, e isso e uma escolha consciente de
# onde hospedar, nao um defeito de configuracao -- ver a nota no README sobre
# o que isso custa e o que resolveria.
#
# ## A porta publica nao e a porta de dentro
#
# O TCP Proxy do Railway publica uma porta sorteada (`RAILWAY_TCP_PROXY_PORT`,
# tipo 11105) e a encaminha para uma porta de dentro do contentor
# (`RAILWAY_TCP_APPLICATION_PORT`, tipo 7881). Isso quebra o WebRTC de um jeito
# que nao e obvio: o LiveKit anuncia, dentro do candidato ICE, **a porta em que
# ele escuta** -- e nao existe opcao para anunciar uma porta diferente. Se ele
# escutasse na 7881, todo cliente receberia "conecte na 7881", tentaria, e
# falharia, porque de fora so a porta sorteada existe.
#
# A costura, entao, e ao contrario do que parece natural:
#
#   1. o LiveKit escuta **na porta publica** (a sorteada), e a anuncia -- que e
#      o endereco que o cliente consegue mesmo alcancar;
#   2. um encaminhador (`socat`) escuta na porta que o Railway entrega e joga
#      o trafego para a porta publica, dentro do contentor.
#
#   fora:  cliente -> proxy.rlwy.net:11105
#   dentro:          :7881 (socat) -> :11105 (livekit)
#
# ## O IP do candidato ICE
#
# `use_external_ip` descobre o IP publico por STUN, e o que ele descobre e o
# IP de **saida** do contentor. O cliente precisa do IP de **entrada** do
# proxy TCP, que e outro. Por isso o IP e resolvido aqui a partir de
# `RAILWAY_TCP_PROXY_DOMAIN` e fixado em `node_ip`. Se a resolucao falhar,
# cai para a descoberta por STUN -- que e melhor do que nao subir.

set -eu

PORTA_SINAL="${PORTA_SINAL:-7880}"
PORTA_ENTREGA="${RAILWAY_TCP_APPLICATION_PORT:-7881}"
PORTA_ICE="${RAILWAY_TCP_PROXY_PORT:-$PORTA_ENTREGA}"
DOMINIO_ICE="${RAILWAY_TCP_PROXY_DOMAIN:-}"

if [ -z "${LIVEKIT_KEY:-}" ] || [ -z "${LIVEKIT_SECRET:-}" ]; then
  echo "[midia] LIVEKIT_KEY e LIVEKIT_SECRET sao obrigatorias." >&2
  exit 1
fi

# O segredo do LiveKit precisa ter pelo menos 32 caracteres; um segredo curto
# faz o servidor subir e recusar todo token depois, que e o pior jeito de
# descobrir o problema.
if [ "${#LIVEKIT_SECRET}" -lt 32 ]; then
  echo "[midia] LIVEKIT_SECRET precisa de 32 caracteres ou mais." >&2
  exit 1
fi

IP_ICE=""
if [ -n "$DOMINIO_ICE" ]; then
  IP_ICE="$(getent hosts "$DOMINIO_ICE" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
fi

echo "[midia] sinalizacao na porta ${PORTA_SINAL}"
echo "[midia] ICE/TCP anunciado em ${DOMINIO_ICE:-?}:${PORTA_ICE} (IP ${IP_ICE:-por STUN})"
echo "[midia] o Railway entrega na porta ${PORTA_ENTREGA}"

{
  echo "port: ${PORTA_SINAL}"
  echo "log_level: info"
  echo "rtc:"
  echo "  tcp_port: ${PORTA_ICE}"
  # Nao ha como desligar o UDP: o LiveKit nao expoe essa opcao, e zerar a
  # faixa e ignorado (ele volta ao padrao 50000-60000). Entao o cliente
  # recebe um candidato UDP que nunca responde -- porque o Railway nao roteia
  # UDP -- junto do candidato TCP que funciona. O ICE resolve, e o custo e um
  # ou dois segundos a mais para a call comecar. E o preco de hospedar um SFU
  # numa plataforma que so fala TCP; ver a nota no README.
  echo "  port_range_start: 50000"
  echo "  port_range_end: 50100"
  if [ -n "$IP_ICE" ]; then
    echo "  node_ip: ${IP_ICE}"
    echo "  use_external_ip: false"
  else
    echo "  use_external_ip: true"
  fi
  echo "keys:"
  echo "  ${LIVEKIT_KEY}: ${LIVEKIT_SECRET}"
} > /tmp/livekit.yaml

echo "[midia] configuracao gerada:"
# O segredo nunca vai para o log: a chave aparece, o valor vira reticencias.
sed "s|${LIVEKIT_SECRET}|...|" /tmp/livekit.yaml

# O encaminhamento da porta de entrega para a porta em que o LiveKit escuta.
#
# **Tem que ser DNAT, e nao um encaminhador em espaco de usuario.** Um `socat`
# aceita a conexao do cliente e abre outra, propria, para o LiveKit -- e nessa
# segunda conexao o endereco de origem passa a ser 127.0.0.1. O ICE compara o
# endereco de origem da checagem de conectividade com o candidato que o outro
# lado anunciou; como nao batem, o par e descartado e nenhuma conexao TCP se
# forma. Isso foi medido: com socat, as estatisticas do LiveKit mostravam
# apenas pares UDP (todos falhos) e nenhum par TCP.
#
# `iptables -j REDIRECT` faz a traducao no proprio nucleo, preservando o IP de
# origem do cliente. E o que o template oficial do Railway usa, e e a unica
# forma que funciona.
if [ "$PORTA_ENTREGA" != "$PORTA_ICE" ]; then
  echo "[midia] redirecionando :${PORTA_ENTREGA} -> :${PORTA_ICE} (DNAT)"
  if iptables -t nat -A PREROUTING -p tcp --dport "${PORTA_ENTREGA}" \
       -j REDIRECT --to-port "${PORTA_ICE}" 2>/tmp/iptables.erro; then
    echo "[midia] DNAT no lugar."
  else
    echo "[midia] AVISO: iptables recusado neste contentor:" >&2
    cat /tmp/iptables.erro >&2
    echo "[midia] AVISO: caindo para socat, que NAO preserva o IP de origem." >&2
    echo "[midia] AVISO: o ICE/TCP vai falhar; ver a nota no README." >&2
    socat "TCP-LISTEN:${PORTA_ENTREGA},fork,reuseaddr" "TCP:127.0.0.1:${PORTA_ICE}" &
  fi
fi

exec /livekit-server --config /tmp/livekit.yaml
