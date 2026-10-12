import carregar from "./neural/gtcrn.js";

let modulo, estado = 0, entrada = 0, saida = 0, porta;
function falhar(erro) { postMessage({ erro: String(erro?.message ?? erro) }); }
self.onmessage = async ({ data }) => {
  try {
    if (data.tipo !== "iniciar" || modulo) throw Error("Inicialização neural inválida.");
    modulo = await carregar({ wasmBinary: data.wasm });
    estado = modulo._gtcrn_create();
    entrada = modulo._malloc(768 * 4);
    saida = modulo._malloc(768 * 4);
    if (!estado || !entrada || !saida) throw Error("Sem memória para a redução neural.");
    porta = data.porta;
    porta.onmessage = ({ data: pcm }) => {
      try {
        if (!(pcm instanceof Float32Array) || pcm.length !== 768) throw Error("Quadro de áudio inválido.");
        modulo.HEAPF32.set(pcm, entrada / 4);
        modulo._gtcrn_process_48k(estado, entrada, saida);
        pcm.set(modulo.HEAPF32.subarray(saida / 4, saida / 4 + 768));
        porta.postMessage(pcm, [pcm.buffer]);
      } catch (erro) { porta.close(); falhar(erro); }
    };
    postMessage({ pronta: true });
  } catch (erro) { falhar(erro); }
};
// O dono encerra este Worker ao trocar/sair: toda a memória WASM e o estado
// recorrente são descartados juntos. Não há modelo compartilhado entre falas.
