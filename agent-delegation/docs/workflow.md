# Shared delegation workflow

The current conversation's agent is the supervisor. It plans, delegates,
reviews and approves. Implementation workers change code in isolated Git
worktrees. Keep this division when changing either platform.

1. Read repository rules and discover a clean named Git checkout. Read-only
   analysis is allowed in the supervisor; delegate implementation and command
   execution. Identify the relevant instruction files, including ignored
   AGENTS.md, CLAUDE.md and platform rules, and include them in context_files.
2. Call doctor with the selected worker. Resolve version, policy, installation
   or connection problems before submitting tasks. Doctor does not test model
   credentials or perform a paid model invocation.
   Users install/configure their CLI and SDK themselves. Missing SDKs do not
   prevent MCP connection, review, cancellation or final command verification.
3. Call submit_tasks with a unique request_id, bounded goals, scope,
   dependencies, acceptance criteria, declared verification commands and
   explicit context/resources. Select worker.platform and optionally model or
   a trusted local profile. Missing selection retains the OpenCode default.
4. Discover existing work with list_runs. Inspect get_run and use wait_run with
   its returned event cursor; consume every next_cursor. Follow get_artifact
   next_offset to inspect bounded diffs, observed checks and model reports.
5. Answer pending questions or permission requests with respond_to_request.
   Honor supported_decisions. Permission "always" is restricted to this
   attempt's exact command, cwd and policy/scope hash. Hard path protections,
   delegation/background execution and Git ownership restrictions cannot be
   elevated by a grant. An uncertain reply is reconciled, never blindly sent again.
6. Review only the latest stopped needs_review attempt. Compare its actual
   commit, bounded diff, observed exit codes, context and acceptance criteria.
   A model report is not verification evidence. Use review_task to approve
   that exact commit or request_changes with concrete correction instructions.
7. After a correction, its old result cannot be approved, including before
   dispatch and after restart. Keep the selected worker/profile/model for the
   correction. Integrated tasks are immutable. There are no autonomous retries.
   Configuration/initialization checks do not spend the model correction limit;
   a recorded dispatch intent does, including uncertain delivery.
8. Use reconcile_run to compare durable state, actual processes, resource
   identity and Git evidence. Keep resource leases for uncertain launches or
   termination. A waiting resource is rebound to the same worktree and attempt.
   RUNTIME_CHANGED requires inspection or cancellation of the same attempt;
   never load a replacement SDK or replay its model request.
9. Use cancel_run to request cancellation. "cancelling" remains until process
   termination is confirmed; preserve integrated work and evidence. Never
   start another worker to resolve uncertain delivery. Cancellation is persisted
   before termination waiting. A durable finalizing barrier rejects later cancel
   with RUN_FROZEN; a cancellation accepted before it prevents final application.
10. Once the accepted tasks are integrated, call validate_run. It freezes the
    revision, commit, context and commands, then executes checks in a dedicated
    worktree without a model request. Inspect the observed verification.
11. Call finalize_run only with the current passed validation ID, exact commit
    and revision. This is supervisor approval. Source changes and ignored-file
    collisions block the fast-forward and remain preserved.

Long mutations can first return {in_progress:true, operation_id,
operation_status:"running", run_id?}. Follow get_run.operations and retry the
same request ID/payload for its eventual result; never submit a replacement ID
to speed it up. Unowned effects after restart remain uncertain until reconciled.
Identical request_id retries return progress or the recorded final response. A changed payload
with that ID is rejected. REQUEST_UNCERTAIN requires evidence reconciliation,
not a new ID or repeat model invocation.

Native runtime constraints and tool capabilities differ. Use declared MCP
resources only; preflight rejects unsupported transport/configuration. The
same service owns scheduling, Git, states, leases and evidence for all workers.

Direct edits/delete/rename/patches are checked against every native path before
execution. The worker owns an independent filesystem/Git/context monitor, including
declared verification. It survives service disconnection, preserves violation
files/evidence, stops owned execution and keeps leases until confirmed stopped.
Missing or stale monitor health fails closed; scope_or_context_error cannot be
approved. Do not describe these guards as OS isolation for arbitrary supervisor-
approved programs. Only storage/submission format 4, RPC 1 and worker format 2
are supported; the 12 MCP inputs remain unchanged. Old formats and unfinished
migration records are preserved and rejected without conversion. Use operations
for whole-root backup/restore or starting a separate empty current data root.
