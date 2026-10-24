import readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { Fault, invariant } from '../types.js';

export type RpcFrame={id?:string|number;method?:string;params?:any;result?:any;error?:any};
export class JsonRpcPeer {
  private next=1;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private closed=false;
  constructor(private child:ChildProcess,private onFrame:(frame:RpcFrame)=>void) {
    readline.createInterface({input:child.stdout!}).on('line',line=>{
      try {
        const frame=JSON.parse(line) as RpcFrame;
        if(frame.id!==undefined&&!frame.method) {
          const key=String(frame.id),waiting=this.pending.get(key);
          if(waiting){this.pending.delete(key);clearTimeout(waiting.timer);frame.error?waiting.reject(new Fault('BACKEND_RPC','Native request failed.',frame.error)):waiting.resolve(frame.result);}
        } else this.onFrame(frame);
      } catch(e){this.fail(e as Error);}
    });
    child.once('close',()=>this.fail(new Fault('BACKEND_DISCONNECTED','Native transport closed. No request was replayed.')));
    // Descendants may retain inherited pipes after the owned root exits. Stop
    // awaiting its RPCs immediately; process-tree proof still owns lease release.
    child.once('exit',()=>this.fail(new Fault('BACKEND_DISCONNECTED','Native process exited. No request was replayed.')));
    child.once('error',e=>this.fail(e));
    // stdin is a separate Writable: asynchronous EPIPE can arrive after the
    // child exit/close event or teardown. Keep its listener for the stream's
    // lifetime so a late write failure cannot become an uncaught exception.
    child.stdin?.on('error',error=>this.inputFailed(error));
  }
  private fail(error:Error){this.closed=true;for(const wait of this.pending.values()){clearTimeout(wait.timer);wait.reject(error);}this.pending.clear();}
  private inputFailed(error:Error) {
    const fault=new Fault('BACKEND_DISCONNECTED','Native input transport failed. No request was replayed.',{code:(error as NodeJS.ErrnoException).code??null});
    this.fail(fault);return fault;
  }
  write(frame:RpcFrame) {
    const input=this.child.stdin;
    invariant(!this.closed&&input?.writable,'BACKEND_DISCONNECTED','Native transport is closed.');
    const payload=`${JSON.stringify(frame)}\n`;
    try{input.write(payload);}catch(error){throw this.inputFailed(error as Error);}
  }
  request(method:string,params:unknown,timeout=30000):Promise<any> {
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(String(id));reject(new Fault('BACKEND_TIMEOUT',`${method} response was not observed. No request was replayed.`));},timeout);
      this.pending.set(String(id),{resolve,reject,timer});
      try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(String(id));reject(e as Error);}
    });
  }
}
