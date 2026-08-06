/**
 * Canal de sinalização: um WebSocket com JSON simples.
 * Só transporta metadados — estrutura dos grupos, mensagens de texto e a
 * negociação das conexões. Áudio e vídeo nunca passam por aqui.
 */
export class Sinal extends EventTarget {
  #ws = null;

  get conectado() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Abre a conexão e apresenta a saudação — `criar-grupo` ou `entrar`.
   * Resolve com o "bem-vindo" do servidor.
   *
   * O servidor recusa mais de um grupo por conexão, então trocar de grupo é
   * trocar de socket: a saudação vai junto da abertura, e não depois.
   */
  conectar(endereco, saudacao) {
    this.desconectar();

    return new Promise((resolver, rejeitar) => {
      let ws;
      try {
        ws = new WebSocket(endereco);
      } catch {
        rejeitar(new Error("Endereço de servidor inválido."));
        return;
      }
      this.#ws = ws;

      let resolvida = false;
      const encerrar = (acao, valor) => {
        if (resolvida) return;
        resolvida = true;
        clearTimeout(expirar);
        acao(valor);
      };

      const expirar = setTimeout(() => {
        ws.close();
        encerrar(rejeitar, new Error("O servidor não respondeu a tempo."));
      }, 8000);

      ws.onopen = () => ws.send(JSON.stringify(saudacao));

      ws.onmessage = (evento) => {
        let msg;
        try {
          msg = JSON.parse(evento.data);
        } catch {
          return;
        }

        if (msg.tipo === "bem-vindo") {
          encerrar(resolver, msg);
        } else if (msg.tipo === "erro" && !resolvida) {
          // Convite inválido é resposta imediata do servidor. Sem tratar isso
          // aqui, a recusa só apareceria oito segundos depois, como se fosse
          // um servidor fora do ar.
          this.desconectar();
          encerrar(rejeitar, new Error(msg.motivo));
          return;
        }

        this.dispatchEvent(new CustomEvent(msg.tipo, { detail: msg }));
      };

      ws.onerror = () => {
        encerrar(rejeitar, new Error("Não foi possível falar com o servidor."));
      };

      ws.onclose = () => {
        encerrar(rejeitar, new Error("A conexão foi fechada pelo servidor."));
        // Só há queda se este ainda for o socket corrente: um socket antigo,
        // já descartado, não pode derrubar a conexão que o substituiu.
        if (this.#ws === ws) {
          this.#ws = null;
          this.dispatchEvent(new CustomEvent("queda"));
        }
      };
    });
  }

  enviar(objeto) {
    if (this.conectado) this.#ws.send(JSON.stringify(objeto));
  }

  desconectar() {
    const ws = this.#ws;
    if (!ws) return;
    this.#ws = null;

    // Desliga os ouvintes antes de fechar: o onclose assíncrono deste socket
    // não deve mais falar em nome da instância.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* já estava fechado */
    }
  }
}
