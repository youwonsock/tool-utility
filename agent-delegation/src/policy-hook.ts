import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './io.js';
import { toolPolicy } from './backends/policy.js';
import type { WorkerSpec, WorkerState } from './types.js';
import { scopeMonitorHealthy } from './scope.js';
import { CODEX_COMMAND_TOOL, CODEX_READ_TOOL } from './backends/codex-tools.js';

export function policyHook(jobDir: string) {
  let decision: 'allow' | 'deny' = 'deny';
  try {
    const spec = readJson<WorkerSpec>(path.join(jobDir, 'spec.json'));
    const state = readJson<WorkerState>(path.join(jobDir, 'worker.json'));
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    const raw = event.tool_input ?? event.toolInput ?? {};
    if (
      spec &&
      spec.job_dir === jobDir &&
      state &&
      scopeMonitorHealthy(spec, state) &&
      typeof event.cwd === 'string' &&
      fs.realpathSync.native(event.cwd) === fs.realpathSync.native(spec.directory)
    ) {
      const tool = event.tool_name ?? event.toolName;
      // Codex parses `ask` but does not implement it: emitting it fails the hook
      // and can continue tool execution. Only owned adapters, the native pure
      // question route and path-checked patches proceed. Shell is never granted.
      if ([CODEX_READ_TOOL, CODEX_COMMAND_TOOL, 'request_user_input'].includes(tool)) decision = 'allow';
      else if (
        tool === 'apply_patch' &&
        toolPolicy(
          tool,
          typeof raw === 'string' ? { command: raw } : raw,
          spec.directory,
          spec.context.map((c) => c.path),
          spec.scope,
        ) === 'allow'
      )
        decision = 'allow';
    }
  } catch {
    /* Invalid/missing policy is an explicit denial, never a failing-open hook. */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: 'Delegation worker policy.',
      },
    }),
  );
}
