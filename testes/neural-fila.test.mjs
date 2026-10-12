import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
let Tipo;const mensagens=[];
const ctx=vm.createContext({Float32Array,Number,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>mensagens.push(m)};}},registerProcessor:(_n,c)=>Tipo=c});
vm.runInContext(fs.readFileSync(new URL('../src/neural-worklet.js',import.meta.url),'utf8'),ctx);
const p=new Tipo();let fechada=false;const quadros=[];
const ponte={postMessage:x=>quadros.push(x),close:()=>fechada=true};
p.port.onmessage({data:{tipo:'conectar',porta:ponte}});
let pos=0;const saidas=[];
for(let k=0;k<1000;k++){
 const entrada=Float32Array.from({length:128},()=>Math.sin(++pos*.03)),saida=new Float32Array(128);
 assert.equal(p.process([[entrada]],[[saida]]),true);saidas.push(...saida);
 while(quadros.length)ponte.onmessage({data:quadros.shift()});
}
assert.equal(mensagens.length,0);assert.ok(saidas.some(v=>Math.abs(v)>.9));
// Depois da reserva, nenhuma quebra: saída continua sendo a senoide atrasada.
let salto=0;for(let i=3000;i<saidas.length;i++)salto=Math.max(salto,Math.abs(saidas[i]-saidas[i-1]));
assert.ok(salto<.031,`salto ${salto}`);
p.port.onmessage({data:'parar'});assert.ok(fechada);assert.equal(p.process([],[]),false);
const lento=new Tipo();lento.port.onmessage({data:{tipo:'conectar',porta:{postMessage(){},close(){}}}});
for(let k=0;k<100;k++)lento.process([[new Float32Array(128)]],[[new Float32Array(128)]]);
assert.ok(mensagens.some(m=>m.erro.includes('não acompanhou')));
console.log('Fila neural: continuidade 128/768, reserva, descarte e worker travado passaram.');
