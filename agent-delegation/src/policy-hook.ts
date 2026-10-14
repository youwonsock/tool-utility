import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './io.js';
import { toolPolicy } from './backends/policy.js';
import type { WorkerSpec } from './types.js';

export function policyHook(jobDir:string) {
  let decision:'allow'|'ask'|'deny'='deny';
  try {
    const spec=readJson<WorkerSpec>(path.join(jobDir,'spec.json'));
    const event=JSON.parse(fs.readFileSync(0,'utf8'));
    if(spec&&spec.job_dir===jobDir)decision=toolPolicy(event.tool_name??event.toolName,event.tool_input??event.toolInput??{},spec.directory,spec.context.map(c=>c.path));
  }catch { /* Invalid/missing policy is an explicit denial, never a failing-open hook. */ }
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:'Delegation worker policy.'}}));
}
