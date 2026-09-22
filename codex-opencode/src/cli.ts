import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataRoot } from './io.js';
import { mcp } from './mcp.js';
import { worker } from './worker.js';
import { serve, remoteCall } from './service.js';
import { VERSION } from './types.js';

const file = fileURLToPath(import.meta.url);
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  if (command === 'mcp') await mcp(dataRoot(), file);
  else if (command === 'service') await serve(args[0] || dataRoot(), file);
  else if (command === 'worker') await worker(args[0]!);
  else if (command === 'call') {
    const input = args[1] ? JSON.parse(fs.readFileSync(args[1], 'utf8')) : JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await remoteCall(dataRoot(), file, args[0]!, input), null, 2));
  } else if (command === 'doctor' || command === 'status') console.log(JSON.stringify(await remoteCall(dataRoot(), file, command === 'doctor' ? 'doctor' : 'list_runs', command === 'doctor' && args[0] ? { repo: args[0] } : {}), null, 2));
  else if (command === 'stop') console.log(JSON.stringify(await remoteCall(dataRoot(), file, '', { cancel: args.includes('--cancel') }, '/stop'), null, 2));
  else if (command === 'cleanup') console.log(JSON.stringify(await remoteCall(dataRoot(), file, '', { run_id: args[0] }, '/cleanup'), null, 2));
  else if (command === '--version') console.log(VERSION);
  else console.log('codex-opencode: mcp | doctor [repo] | status | call <tool> [input.json] | stop [--cancel] | cleanup <run_id>\nSet CODEX_OPENCODE_HOME to select the user data directory.');
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
