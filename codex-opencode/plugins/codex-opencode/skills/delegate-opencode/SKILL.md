---
name: delegate-opencode
description: Plan in the current agent, delegate implementation to persistent OpenCode workers, review observed evidence, request corrections and finalize validated commits.
---

Use OpenCode as the default implementation worker. The current conversation
remains the planning and review agent on any supported supervisor platform.
Read the canonical [delegation workflow](../../../../docs/workflow.md).
The build generates a complete standalone copy of that workflow for this
compatibility entry point and for delegate-agents.

Use `doctor`, `submit_tasks`, `list_runs`, `get_run`, `wait_run`, `get_artifact`,
`review_task`, `respond_to_request`, `reconcile_run`, `cancel_run`,
`validate_run` and `finalize_run` with their shared contracts. Keep exact
attempt/commit/revision approval, observed verification and uncertain-delivery
rules when resuming an existing run.

Read [the tool contract and examples](references/contract.md) when preparing
inputs. Missing worker selection retains OpenCode. Model requests and command
execution are never replayed automatically to resolve uncertain delivery.
