import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataRoot } from './io.js';
import { mcp } from './mcp.js';
import { worker } from './worker.js';
import { serve, remoteCall } from './service.js';
import { VERSION } from './types.js';
import { commandHost } from './verification.js';
import { policyHook } from './policy-hook.js';
import { exportHost } from './hosts.js';
import type { Platform } from './types.js';

const file = fileURLToPath(import.meta.url);
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  if (command === 'mcp') await mcp(dataRoot(), file);
  else if (command === 'service') await serve(args[0] || dataRoot(), file);
  else if (command === 'worker') await worker(args[0]!);
  else if (command === 'command-host') await commandHost(args[0]!);
  else if (command === 'policy-hook') policyHook(args[0]!);
  else if (command === 'export-host') {
    const body = fs.readFileSync(new URL('./workflow.md', import.meta.url), 'utf8');
    console.log(JSON.stringify(exportHost(args[0] as Platform, args[1]!, file, body), null, 2));
  } else if (command === 'call') {
    const input = args[1]
      ? JSON.parse(fs.readFileSync(args[1], 'utf8'))
      : JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await remoteCall(dataRoot(), file, args[0]!, input), null, 2));
  } else if (command === 'doctor') {
    if (!args[0]) throw new Error('Usage: doctor <platform> [repo]');
    const input = { worker: { platform: args[0] }, ...(args[1] ? { repo: args[1] } : {}) };
    console.log(JSON.stringify(await remoteCall(dataRoot(), file, 'doctor', input), null, 2));
  } else if (command === 'status')
    console.log(JSON.stringify(await remoteCall(dataRoot(), file, 'list_runs', {}), null, 2));
  else if (command === 'stop')
    console.log(
      JSON.stringify(await remoteCall(dataRoot(), file, '', { cancel: args.includes('--cancel') }, '/stop'), null, 2),
    );
  else if (command === 'cleanup')
    console.log(JSON.stringify(await remoteCall(dataRoot(), file, '', { run_id: args[0] }, '/cleanup'), null, 2));
  else if (command === '--version') console.log(VERSION);
  else if (command === 'help' || command === '--help' || command === '-h')
    console.log(
      'agent-delegation: mcp | doctor <platform> [repo] | status | call <tool> [input.json] | stop [--cancel] | cleanup <run_id> | export-host <platform> <new-output-directory>\nSet AGENT_DELEGATION_HOME to select the user data directory.',
    );
  else throw new Error(`Unknown command: ${command}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
