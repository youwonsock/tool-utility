import fs from 'node:fs';
import path from 'node:path';
import { platforms } from '../dist/index.mjs';
import { root } from './helpers.mjs';
export function mockProfiles(f){
  const profiles={...JSON.parse(fs.readFileSync(path.join(f.data,'profiles.json'))).profiles,...Object.fromEntries(platforms.map(platform=>[`mock-${platform}`,{platform,executable:process.execPath,args:[path.join(root,'test',platform==='codex'?'fake-codex.mjs':platform==='claude-code'?'fake-claude.mjs':'fake-opencode.mjs'),...(platform==='kilo'?['--kilo']:[])]}]))};
  fs.writeFileSync(path.join(f.data,'profiles.json'),JSON.stringify({profiles}));
}
export const selection=platform=>({platform,profile:`mock-${platform}`,model:['opencode','kilo'].includes(platform)?{providerID:'fake',modelID:'test'}:'fake-model'});
