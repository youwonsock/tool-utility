# Codex–OpenCode delegation v1

Status: implementation baseline, 2026-09-22.

Codex owns planning, review, correction instructions and final approval. This tool owns durable execution, evidence and Git mechanics. OpenCode owns implementation and shell verification. The target repository is independent of Custom Agent Loop and of the repository from which Codex is invoked.

## Contracts

- Node 22+, Windows/macOS; OpenCode 1.18.30 is the compatibility baseline. A bundled stdio MCP client talks to an authenticated, single-owner localhost service. Each attempt has a dedicated OpenCode process/session and a Git worktree.
- Defaults: concurrency 2, timeout 60 minutes, at most 3 correction attempts after the initial attempt. No automatic model fallback or implementation retry.
- Start only on a named branch with clean tracked and untracked source files. Explicit ignored context snapshots are immutable, preserve relative paths, cannot overwrite tracked files, and cannot enter result commits.
- Tasks declare goals, dependencies, edit scope, acceptance criteria, verification argv, context files and resource keys. Dependencies require accepted and integrated predecessor commits. Resource locks span all runs owned by the service. Read-only probes must confirm instance identity and, when applicable, the actual attempt/validation project path.
- A failed resource probe exposes the allocated worktree and waits without dispatching a model request. Rebinding the resource and calling `reconcile_run` rechecks that same worktree under its existing lease; final validation remains frozen while waiting. It does not allocate a replacement worktree just to retry a connection check.
- Persist outbound intent before every potentially mutating OpenCode request. Unknown delivery is reconciled against session messages; never blindly replay. Unknown process ownership holds locks and blocks replacements.
- Completion commits are immutable. Review binds attempt ID and commit; integration is serial. Conflicts and scope violations require Codex instructions.
- Final validation freezes task revision, integration commit, context hash and commands. It runs in a separate worktree. Source changes invalidate it. Final approval must name the validation, commit and revision. Finalize rechecks the original checkout and uses `git merge --ff-only --no-overwrite-ignore`; recovery observes rather than resets user changes.
- Mutating MCP calls require idempotency IDs. Responses are paginated valid JSON (4 KiB); artifacts use 16 KiB pages. Observed command evidence is distinct from model claims.
- Service and workers survive MCP disconnection. Stop/cancel require confirmed termination. Install/update copies self-contained versioned bundles and a marketplace into user storage, retaining old releases. No auto-started Codex process, GUI, or public marketplace publishing.

## Implementation order and acceptance

1. Portable installation, protocol and doctor.
2. Context, isolated execution, evidence and review/correction.
3. Durable dispatch, recovery, deduplication and cancellation.
4. Dependency scheduling, global resource locks and integration conflicts.
5. Frozen final validation, guarded finalization and recovery after merge.

Automated verification uses a fake OpenCode HTTP server, real processes, and real temporary Git repositories. CI runs on Windows and macOS. Tests cover context exclusion, resource identity, loss/restart/cancel, stale approvals, dirty/moved checkouts, ignored collisions, post-merge recovery, bounded pagination, and installation under spaces/Korean paths with the source moved. A real macOS model smoke test exercises parallel work, corrections, final validation, review and fast-forward. Record separately whether Windows live model testing was performed.
