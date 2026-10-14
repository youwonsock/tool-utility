// Explicit test setup only. Install/build/update never invokes this script.
import fs from 'node:fs';
import path from 'node:path';
import { exec, findExecutable } from '../dist/index.mjs';
const directory=process.argv[2];
if(!directory||!path.isAbsolute(directory))throw new Error('Pass an absolute, empty test environment directory.');
const marker=path.join(directory,'.agent-delegation-test-environment.json');
if(fs.existsSync(directory)&&fs.readdirSync(directory).length&&!fs.existsSync(marker))throw new Error('Refusing to install test runtimes into a non-owned directory.');
fs.mkdirSync(directory,{recursive:true});
const packages=['opencode-ai@1.18.30','@openai/codex@0.146.0','@anthropic-ai/claude-code@2.1.296','@kilocode/cli@7.4.23','@opencode-ai/sdk@1.18.30','@anthropic-ai/claude-agent-sdk@0.3.296','@kilocode/sdk@7.4.23'];
fs.writeFileSync(marker,JSON.stringify({purpose:'model-free compatibility tests',packages},null,2));
const npm=findExecutable('npm');if(!npm)throw new Error('npm is required to explicitly prepare the test environment.');
const result=await exec(npm,['install','--cache',path.join(directory,'.npm-cache'),'--prefix',directory,'--save-exact','--no-audit','--no-fund',...packages],{timeout:600000});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);
if(result.code!==0)throw new Error('External test environment setup failed.');
console.log(JSON.stringify({test_environment:directory,packages,model_requests:0}));
