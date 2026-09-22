---
name: delegate-opencode
description: Plan changes in Codex, delegate implementation and command execution to persistent OpenCode workers, review bounded Git diffs and observed verification evidence, request corrections, and finalize a validated commit. Use when the user asks to use OpenCode as Codex's implementation worker or to resume a codex-opencode delegation run.
---

# Delegate implementation to OpenCode

Own the plan, task boundaries, review decisions and final report. Use the `codex-opencode` MCP tools to assign code editing, tests and builds to OpenCode. The service schedules declared work; it does not plan, approve, or decide how to correct failures.

## Prepare the run

1. Call `doctor` for the target checkout. Resolve incompatible versions, unavailable configured models, and connection failures before submitting work. Use a named branch with clean source files. Confirm the repository from the user's request; do not assume the current Codex workspace is the implementation target.
2. Inspect relevant repository rules and write the implementation plan. Split independent scopes into tasks. Declare task IDs, goals, dependencies, exact allowed paths or directory prefixes, acceptance criteria, verification commands, explicit context files, and resource keys. Dependencies finish only after review and integration.
3. Include ignored local `AGENTS.md` and every needed referenced rule/spec file in `context_files`, keeping their relative paths. Context is immutable and excluded from implementation commits. Never include credentials or copy the whole user configuration. If rules must change, treat them as source edits in a separate task rather than immutable context.
4. Declare shared tools before use. Each profile needs a stable `resource_key`, MCP connection, read-only JSON probe, and expected instance ID. Project-bound probes must confirm the actual worker/validation worktree path. An Editor opened on the original checkout is insufficient. Explain a mismatched binding and resolve it before starting the task. Locks cover this service's jobs, not outside users.
5. Call `submit_tasks` with explicit final verification commands. Use a fresh `request_id` for each new mutation; reuse the same ID only to retransmit identical content. Save the returned run ID. Do not launch another Codex process or expose this delegation MCP to OpenCode workers.

## Supervise with bounded evidence

- Use `list_runs` to recover a run after reconnecting. Use `get_run` for a compact snapshot and `wait_run` with the returned event cursor for changes. Follow `next_cursor`; do not repeatedly load entire transcripts.
- Use `get_artifact` to inspect relevant diff hunks and command results. Follow `next_offset` for the pages needed to assess the change. An artifact reference means the response was paginated, not that its content was reviewed.
- Distinguish `model_report` from `observed_verification`. Only observed exit codes establish that a declared command ran. Missing, interrupted, cancelled or unknown evidence is not success, even if the model says tests passed.
- When OpenCode requests input, inspect the request and call `respond_to_request` only with a decision authorized by the user's scope. Answer questions with the nested `answers` array. Do not approve a broader permission merely to unblock execution.
- If delivery or process ownership is uncertain, call `reconcile_run`. Never resubmit an uncertain model/shell request or create a replacement worker while its predecessor may still be running. A persisted input response is not confirmation that OpenCode received it.
- `cancel_run` requests cancellation. Wait until it reports `cancelled` before treating processes as stopped or resource leases as free. Codex disconnection alone does not cancel work.

## Review and correct

1. Inspect the exact attempt's diff against its declared scope and acceptance criteria; inspect observed command evidence. Compare the result with repository rules. Approval requires the latest attempt ID and immutable result commit.
2. Call `review_task` with `approve` only when that evidence is sufficient. Approved changes integrate sequentially. A reported conflict requires a correction decision; approval alone does not imply successful integration.
3. For implementation/check/scope/conflict failures, use `request_changes` with concrete correction instructions and the latest attempt ID/commit (omit commit when no result was created). This creates a new attempt; the old result remains evidence. Default limit: three corrections after the first attempt. At the limit, report the failure or plan a new explicit task.
4. Integrated tasks are immutable. Submit a new dependent correction task when already-integrated behavior needs to change. Do not rewrite prior approvals or edit worker files directly.

## Validate and finalize

1. After every task is `integrated`, call `validate_run`. It fixes the task revision, integration commit, context hashes and final commands, then executes them in a separate worktree. Wait for `waiting_final_review`.
2. Review the validation artifacts. A successful task test does not substitute for final integration validation. A source edit during validation, incomplete check, or unknown exit invalidates verification.
3. Adding a task after validation invalidates the old approval. Re-run final validation after the new work is integrated. During validation, wait before adding or changing tasks.
4. Call `finalize_run` only after final review and within the user's authorized implementation scope, with the exact current validation ID, commit and task revision. The service checks the original checkout and performs a guarded fast-forward. Never update the checked-out branch pointer manually, force a merge, delete colliding ignored files, or reset user changes to make finalization pass.
5. If finalization is interrupted, use `reconcile_run`. Inspect the actual target HEAD and state. A moved target or unexpected worktree change must be reported; no automatic rollback is permitted.
6. Report implemented behavior, observed checks, commit/run identifiers and unresolved limitations. Report OpenCode usage and MCP response metrics when available. Claim a Codex token saving percentage only with actual comparative measurements.

See [the tool contract and example](references/contract.md) for input details. Default policy is two simultaneous workers, 60-minute attempt timeout and three correction retries. These are configurable; never assume a timeout proves termination.
