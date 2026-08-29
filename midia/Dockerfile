# O degrau `proprio` da escada de midia: um LiveKit nosso.
#
# A imagem oficial e Alpine com um binario dentro e mais nada -- o que e
# otimo, e insuficiente aqui: no Railway o servidor precisa de `socat` (para
# costurar a porta publica do TCP Proxy com a porta em que o LiveKit escuta) e
# de `getent` (para resolver o IP que vai no candidato ICE). Os dois motivos
# estao explicados em `entrada.sh`.
FROM livekit/livekit-server:latest

USER root
RUN apk add --no-cache socat iptables

COPY entrada.sh /entrada.sh
RUN chmod +x /entrada.sh

# A imagem oficial define ENTRYPOINT ["/livekit-server"]; aqui ele passa a ser
# o roteiro, que gera a configuracao e so entao entrega o processo ao LiveKit.
ENTRYPOINT ["/bin/sh", "/entrada.sh"]
