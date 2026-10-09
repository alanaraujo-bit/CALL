# Servidor TURN do CALL, para a malha P2P.
#
# Sem LiveKit, cada participante fala direto com os outros. Isso funciona
# enquanto os dois lados conseguem se enxergar pela internet — e deixa de
# funcionar justamente no 4G, onde a operadora coloca milhares de aparelhos
# atras do mesmo endereco (CGNAT). O TURN e o ponto de encontro para esse caso:
# os dois lados se conectam a ele, e ele repassa os pacotes.
#
# O Railway nao abre UDP para fora, so TCP por proxy. Por isso este servidor
# atende apenas TURN sobre TCP, e o repasse acontece entre duas alocacoes
# deste mesmo processo — ver `iniciar.sh`.
FROM coturn/coturn:4.6.3

COPY iniciar.sh /iniciar.sh

ENTRYPOINT ["/bin/sh", "/iniciar.sh"]
