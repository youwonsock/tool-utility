import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './io.js';
import { toolPolicy } from './backends/policy.js';
import type { WorkerSpec, WorkerState } from './types.js';
import { workerPolicyHash } from './scope.js';

export function policyHook(jobDir:string) {
  let decision:'allow'|'ask'|'deny'='deny';
  try {
    const spec=readJson<WorkerSpec>(path.join(jobDir,'spec.json'));
    const state=readJson<WorkerState>(path.join(jobDir,'worker.json'));
    const event=JSON.parse(fs.readFileSync(0,'utf8'));
    const raw=event.tool_input??event.toolInput??{};
    if(spec&&spec.job_dir===jobDir&&state?.scope_guard?.status==='healthy'&&Date.now()-state.scope_guard.checked_at<10000&&state.scope_guard.policy_hash===workerPolicyHash(spec))decision=toolPolicy(event.tool_name??event.toolName,typeof raw==='string'?{input:raw}:raw,spec.directory,spec.context.map(c=>c.path),spec.scope);
  }catch { /* Invalid/missing policy is an explicit denial, never a failing-open hook. */ }
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:'Delegation worker policy.'}}));
}
