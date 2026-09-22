import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, remoteCall, uid } from '../dist/index.mjs';
const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv[process.argv.indexOf('--model') + 1];
const explicitModel = process.argv.includes('--model') ? (() => { const [providerID,...parts]=String(selected||'').split('/'); if(!providerID||!parts.length||!parts.join('/'))throw new Error('Use --model providerID/modelID');return {providerID,modelID:parts.join('/')}; })() : undefined;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenCode 실제 검증 '));
const repo = path.join(directory, 'project'), data = path.join(directory,'data'); fs.mkdirSync(repo);
const git = async args => { const r = await exec('git',args,{cwd:repo}); if(r.code!==0) throw new Error(r.stderr); };
await git(['init','-b','main']); await git(['config','user.name','Codex smoke']); await git(['config','user.email','smoke@localhost']);
fs.writeFileSync(path.join(repo,'.gitignore'),'AGENTS.md\n.specs/\n');
fs.writeFileSync(path.join(repo,'README.md'),'Temporary real-model verification fixture.\n');
fs.writeFileSync(path.join(repo,'AGENTS.md'),'Read .specs/spec.md. Implement only the assigned function. Do not commit, delegate, or invoke external MCP tools.\n');
fs.mkdirSync(path.join(repo,'.specs')); fs.writeFileSync(path.join(repo,'.specs/spec.md'),'Use standard ECMAScript modules with named exports, no dependencies.\n');
await git(['add','.']); await git(['commit','-m','smoke baseline']);
process.env.CODEX_OPENCODE_HOME=data;
const node = process.execPath.replaceAll('\\','/');
const check = (file,name,result) => `"${node}" --input-type=module -e "import {${name}} from './${file}'; if (${name}(2,3) !== ${result}) process.exit(1)"`;
const submitted = await remoteCall(data,path.join(tool,'dist/cli.mjs'),'submit_tasks',{
  request_id:uid('live'),repo,context_files:['AGENTS.md','.specs/spec.md'],
  tasks:[
    {id:'add',goal:'Create add.mjs exporting add(a,b) that returns a+b. Read supplied rules. Only edit add.mjs.',scope:['add.mjs'],acceptance:['add(2,3) equals 5'],verification:[{command:check('add.mjs','add',5)}],model:explicitModel},
    {id:'multiply',goal:'Create multiply.mjs exporting multiply(a,b) that returns a*b. Read supplied rules. Only edit multiply.mjs.',scope:['multiply.mjs'],acceptance:['multiply(2,3) equals 6'],verification:[{command:check('multiply.mjs','multiply',6)}],model:explicitModel},
  ],
  final_verification:[{command:`${check('add.mjs','add',5)} && ${check('multiply.mjs','multiply',6)}`}],
});
if (submitted.error) throw new Error(JSON.stringify(submitted.error));
const manifest={directory,repo,data,run_id:submitted.run_id,cli:path.join(tool,'dist/cli.mjs')};
fs.writeFileSync(path.join(directory,'smoke.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({...manifest,next:'Use MCP/CLI to inspect results, request an add correction, review both commits, validate, review validation artifacts and finalize. No automatic approval is performed by this script.'},null,2));
