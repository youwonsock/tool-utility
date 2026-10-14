import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function mockSdks(directory){
  const fixtures=path.dirname(fileURLToPath(import.meta.url)),roots={};
  for(const [platform,name,subpath,file]of [
    ['opencode','@opencode-ai/sdk','./v2/client','mock-http-sdk.mjs'],
    ['kilo','@kilocode/sdk','./v2/client','mock-http-sdk.mjs'],
    ['claude-code','@anthropic-ai/claude-agent-sdk','.','mock-claude-sdk.mjs'],
  ]){
    const root=path.join(directory,name);fs.mkdirSync(root,{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name,version:'999.1.0',type:'module',exports:{[subpath]:{types:'./types.d.ts',import:'./sdk.mjs'}}}));
    fs.copyFileSync(path.join(fixtures,file),path.join(root,'sdk.mjs'));roots[platform]=root;
  }
  return roots;
}
