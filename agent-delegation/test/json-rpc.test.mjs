import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {JsonRpcPeer} from '../dist/index.mjs';

const brokenPipe=()=>Object.assign(new Error('write EPIPE'),{code:'EPIPE'});
function transport(t,write) {
  const stdin=new Writable({write}),stdout=new PassThrough(),child=Object.assign(new EventEmitter(),{stdin,stdout});
  t.after(()=>{stdin.destroy();stdout.end();});
  return {stdin,child,peer:new JsonRpcPeer(child,()=>{})};
}
test('asynchronous native stdin EPIPE rejects every pending RPC and never replays a request',async t=>{
  let writes=0;const {peer}=transport(t,(_chunk,_encoding,done)=>{writes++;setImmediate(()=>done(brokenPipe()));});
  const results=await Promise.allSettled([peer.request('first',{}),peer.request('second',{})]);
  for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'BACKEND_DISCONNECTED');assert.equal(result.reason.details.code,'EPIPE');}
  assert.equal(writes,1);
  await assert.rejects(()=>peer.request('after-failure',{}),error=>error.code==='BACKEND_DISCONNECTED');assert.equal(writes,1);
});
test('late asynchronous stdin failure remains handled after native exit and teardown notifications',async t=>{
  let writes=0;const {peer,child,stdin}=transport(t,(_chunk,_encoding,done)=>{writes++;setImmediate(()=>done(brokenPipe()));});
  peer.write({method:'initialized'});child.emit('exit',0);child.emit('close',0);
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotThrow(()=>stdin.emit('error',brokenPipe()));
  await assert.rejects(()=>peer.request('after-exit',{}),error=>error.code==='BACKEND_DISCONNECTED');assert.equal(writes,1);
});
test('synchronous native write failure closes the peer and rejects earlier pending work',async t=>{
  const {peer,stdin}=transport(t,(_chunk,_encoding,done)=>done());
  const first=peer.request('first',{});stdin.write=()=>{throw brokenPipe();};
  const results=await Promise.allSettled([first,peer.request('second',{})]);
  for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'BACKEND_DISCONNECTED');assert.equal(result.reason.details.code,'EPIPE');}
  assert.throws(()=>peer.write({method:'after-failure'}),error=>error.code==='BACKEND_DISCONNECTED');
});
