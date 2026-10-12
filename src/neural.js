/** Adaptador local, sem rede externa, conta ou licença de sala. */
let wasmPronto;
const modulos = new WeakMap();
export async function preparar() {
  if (typeof Worker === "undefined" || typeof AudioWorkletNode === "undefined") throw Error("AudioWorklet/Worker indisponível.");
  wasmPronto ??= (async () => {
    const resposta = await fetch(new URL("./neural/gtcrn.wasm", import.meta.url));
    if (!resposta.ok) throw Error(`Modelo neural indisponível (${resposta.status}).`);
    const bytes = await resposta.arrayBuffer();
    // Falha antes da captura se o navegador não suporta o SIMD do motor.
    await WebAssembly.compile(bytes);
    return bytes;
  })();
  return wasmPronto;
}

export async function tratar(trilha, contexto, aoFalhar) {
  if (contexto.sampleRate !== 48000) throw Error("O motor neural requer captura em 48 kHz.");
  const wasm = await preparar();
  if (!modulos.has(contexto)) {
    const carga = contexto.audioWorklet.addModule(new URL("./neural-worklet.js", import.meta.url));
    modulos.set(contexto, carga);
    carga.catch(() => modulos.delete(contexto));
  }
  await modulos.get(contexto);
  const worker = new Worker(new URL("./neural-worker.js", import.meta.url), { type: "module" });
  const canal = new MessageChannel();
  let origem, no, destino, solto = false;
  const soltar = () => {
    if (solto) return;
    solto = true;
    origem?.disconnect();
    no?.port.postMessage("parar");
    no?.disconnect();
    no?.port.close();
    canal.port1.close();
    canal.port2.close();
    worker.terminate();
    destino?.stream.getTracks().forEach(t => t.stop());
  };
  try {
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(Error("O motor neural não iniciou a tempo.")), 10000);
      const falhar = erro => { clearTimeout(limite); reject(erro); };
      worker.onerror = e => falhar(Error(e.message || "Falha no Worker neural."));
      worker.onmessage = ({ data }) => {
        if (data.erro) falhar(Error(data.erro));
        else if (data.pronta) { clearTimeout(limite); resolve(); }
      };
      worker.postMessage({ tipo: "iniciar", wasm, porta: canal.port1 }, [canal.port1]);
    });
    const falhar = erro => { if (!solto) { soltar(); aoFalhar(erro); } };
    worker.onerror = e => falhar(Error(e.message || "Falha no Worker neural."));
    worker.onmessage = ({ data }) => { if (data.erro) falhar(Error(data.erro)); };
    no = new AudioWorkletNode(contexto, "call-neural", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit",
    });
    // MessagePort não é transferível no processorOptions do AudioWorklet.
    // A conexão é enviada pela porta de controle logo após a construção.
    no.port.postMessage({ tipo: "conectar", porta: canal.port2 }, [canal.port2]);
    origem = contexto.createMediaStreamSource(new MediaStream([trilha]));
    destino = contexto.createMediaStreamDestination();
    no.onprocessorerror = () => falhar(Error("Falha no worklet neural."));
    no.port.onmessage = ({ data }) => { if (data.erro) falhar(Error(data.erro)); };
    origem.connect(no).connect(destino);
    return { trilha: destino.stream.getAudioTracks()[0], soltar };
  } catch (erro) { soltar(); throw erro; }
}
