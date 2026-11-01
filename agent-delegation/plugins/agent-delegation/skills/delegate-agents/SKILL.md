---
name: delegate-agents
description: Plan in the current agent, delegate implementation across local agent platforms, review observed evidence, request corrections and finalize validated commits.
---

Read the shared [delegation workflow](../../../../docs/workflow.md).
It is the canonical source used to generate the standalone installed skills
and Codex, OpenCode, Claude Code and Kilo host exports.

The current conversation is the supervisor. Use `doctor`, `create_run`, `add_tasks`,
`list_runs`, `get_run`, `wait_run`, `get_artifact`, `approve_task`, `request_changes`,
`respond_to_request`, `reconcile_run`, `cancel_run`, `validate_run` and
`finalize_run` in that workflow. Select the implementation platform using
`worker.platform`; `create_run` and `doctor` require it.

Do not activate an installation or perform a paid model smoke test unless
the user's requested scope includes it. Observed command evidence and exact
commit/revision approval remain required for every platform.

Read [the tool contract and examples](references/contract.md) when preparing tasks.
