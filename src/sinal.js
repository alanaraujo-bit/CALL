/**
 * Canal de sinalização: um WebSocket com JSON simples.
 * Só transporta metadados de conexão — nenhuma mídia passa por aqui.
 */
export class Sinal extends EventTarget {
  #ws = null;

  get conectado() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Abre a conexão e entra na sala. Resolve quando o servidor confirma. */
  conectar(endereco, sala, apelido) {
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

      const expirar = setTimeout(() => {
        ws.close();
        rejeitar(new Error("O servidor não respondeu a tempo."));
      }, 8000);

      ws.onopen = () => ws.send(JSON.stringify({ tipo: "entrar", sala, apelido }));

      ws.onmessage = (evento) => {
        let msg;
        try {
          msg = JSON.parse(evento.data);
        } catch {
          return;
        }

        if (msg.tipo === "bem-vindo") {
          clearTimeout(expirar);
          resolver(msg);
        }
        this.dispatchEvent(new CustomEvent(msg.tipo, { detail: msg }));
      };

      ws.onerror = () => {
        clearTimeout(expirar);
        rejeitar(new Error("Não foi possível falar com o servidor."));
      };

      ws.onclose = () => {
        clearTimeout(expirar);
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
