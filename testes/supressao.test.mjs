import assert from "node:assert/strict";
import { Supressao } from "../src/supressao.js";

let cargas=0, descartes=0, degradacoes=0, falhas=[];
const crua={ readyState:"live", id:"crua" };
const modulo={ preparar:async()=>{}, tratar:async(_t,_c,aoFalhar)=>{
  falhas.push(aoFalhar);
  return {trilha:{readyState:"live",id:falhas.length},soltar:()=>descartes++};
}};
const s=new Supressao({carregarNeural:async()=>{cargas++;return modulo;},aoDegradar:()=>degradacoes++});
assert.deepEqual(await s.prepararCaptura(true),{noiseSuppression:false,voiceIsolation:false});
const a=await s.tratar(crua,{});
assert.notEqual(a,crua);assert.equal(s.portaFazSentido,false);
await s.aoPublicar({onPublish:()=>{throw Error('não pode depender da sala');}});
await s.prepararCaptura(true,{vozesAoFundo:true});assert.match(s.detalhe,/não remove outras vozes/);
const b=await s.tratar(crua,{});assert.notEqual(a,b);assert.equal(descartes,1);assert.equal(cargas,1);
falhas[0](Error('evento velho'));assert.equal(s.motor,'neural');assert.equal(degradacoes,0);
falhas[1](Error('worker morreu'));assert.equal(s.motor,'nativa');assert.equal(degradacoes,1);assert.equal(s.portaFazSentido,true);
assert.equal((await s.prepararCaptura(true)).noiseSuppression,true);assert.equal(cargas,1);
assert.equal(await s.tratar(crua,{}),crua);
await s.soltar();await s.soltar();assert.equal(descartes,2);
assert.equal((await s.prepararCaptura(false)).noiseSuppression,false);assert.equal(s.motor,'desligada');

const recusada=new Supressao({carregarNeural:async()=>{throw Error('WASM ausente');}});
assert.equal((await recusada.prepararCaptura(true)).noiseSuppression,true);assert.match(recusada.causa,/WASM ausente/);
const falhou=new Supressao({carregarNeural:async()=>({preparar:async()=>{},tratar:async()=>{throw Error('contexto incompatível');}})});
await falhou.prepararCaptura(true);assert.equal(await falhou.tratar(crua,{}),crua);
assert.equal((await falhou.prepararCaptura(true)).noiseSuppression,true);

let liberar, soltos=0;
const corrida=new Supressao({carregarNeural:async()=>({preparar:async()=>{},tratar:()=>new Promise(r=>liberar=r)})});
await corrida.prepararCaptura(true);const pendente=corrida.tratar(crua,{});await corrida.soltar();
liberar({trilha:crua,soltar:()=>soltos++});await pendente;assert.equal(soltos,1);
console.log('Supressão: seleção, sala independente, BVC, reabertura, falhas e descarte concorrente passaram.');
