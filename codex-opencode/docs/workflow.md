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
3. Call submit_tasks with a unique request_id, bounded goals, scope,
   dependencies, acceptance criteria, declared verification commands and
   explicit context/resources. Select worker.platform and optionally model or
   a trusted local profile. Missing selection retains the OpenCode default.
4. Discover existing work with list_runs. Inspect get_run and use wait_run with
   its returned event cursor; consume every next_cursor. Follow get_artifact
   next_offset to inspect bounded diffs, observed checks and model reports.
5. Answer pending questions or permission requests with respond_to_request.
   Honor supported_decisions. Permission "always" is restricted to this
   attempt. An uncertain reply is reconciled, never blindly sent again.
6. Review only the latest stopped needs_review attempt. Compare its actual
   commit, bounded diff, observed exit codes, context and acceptance criteria.
   A model report is not verification evidence. Use review_task to approve
   that exact commit or request_changes with concrete correction instructions.
7. After a correction, its old result cannot be approved, including before
   dispatch and after restart. Keep the selected worker/profile/model for the
   correction. Integrated tasks are immutable. There are no autonomous retries.
8. Use reconcile_run to compare durable state, actual processes, resource
   identity and Git evidence. Keep resource leases for uncertain launches or
   termination. A waiting resource is rebound to the same worktree and attempt.
9. Use cancel_run to request cancellation. "cancelling" remains until process
   termination is confirmed; preserve integrated work and evidence. Never
   start another worker to resolve uncertain delivery.
10. Once the accepted tasks are integrated, call validate_run. It freezes the
    revision, commit, context and commands, then executes checks in a dedicated
    worktree without a model request. Inspect the observed verification.
11. Call finalize_run only with the current passed validation ID, exact commit
    and revision. This is supervisor approval. Source changes and ignored-file
    collisions block the fast-forward and remain preserved.

Identical request_id retries return the recorded response. A changed payload
with that ID is rejected. REQUEST_UNCERTAIN requires evidence reconciliation,
not a new ID or repeat model invocation.

Native runtime constraints and tool capabilities differ. Use declared MCP
resources only; preflight rejects unsupported transport/configuration. The
same service owns scheduling, Git, states, leases and evidence for all workers.
