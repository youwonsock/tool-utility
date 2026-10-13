# Multi-platform agent delegation

Status: platform extension of the existing lifecycle baseline, 2026-10-14.

The acceptance reference is [the revised platform plan](platform-plan.md);
operational decisions and repair evidence are in [the implementation audit](implementation-audit.md).

The current conversation owns planning, review, correction instructions and final approval. This tool owns durable execution, observed verification, evidence and Git mechanics. A selected local implementation backend changes source in its worktree. Codex, OpenCode, Claude Code and Kilo can fill either role. The target repository is independent of the supervisor workspace.

## Contracts

- Node 22+, Windows/macOS. Implementation baselines are OpenCode CLI/SDK 1.18.30, Codex CLI 0.146.0, Claude Agent SDK 0.3.296 with bundled CLI 2.1.296, and Kilo CLI/SDK 7.4.23. Codex app-server is an experimental pinned integration. The existing 12 STDIO MCP tools connect to an authenticated localhost service. Each implementation attempt owns a native session/process ledger and an isolated worktree.
- Defaults: concurrency 2, timeout 60 minutes, at most 3 correction attempts after the initial attempt. No automatic model fallback or implementation retry.
- Start only on a named branch with clean tracked and untracked source files. Explicit ignored context snapshots are immutable, preserve relative paths, cannot overwrite tracked files, and cannot enter result commits.
- Tasks declare goals, dependencies, edit scope, acceptance criteria, verification argv, context files and resource keys. Dependencies require accepted and integrated predecessor commits. Resource locks span all runs owned by the service. Read-only probes must confirm instance identity and, when applicable, the actual attempt/validation project path.
- A failed resource probe exposes the allocated worktree and waits without dispatching a model request. Rebinding the resource and calling `reconcile_run` rechecks that same worktree under its existing lease; final validation remains frozen while waiting. It does not allocate a replacement worktree just to retry a connection check.
- Persist outbound intent before every native dispatch, input reply and verification command. Unknown delivery is reconciled against session messages; never blindly replay. Unknown process ownership holds locks and blocks replacements.
- Completion commits are immutable. Review binds attempt ID and commit; integration is serial. Conflicts and scope violations require supervisor instructions.
- Final validation freezes task revision, integration commit, context hash and commands. It runs in a separate worktree. Source changes invalidate it. Final approval must name the validation, commit and revision. Finalize rechecks the original checkout and uses `git merge --ff-only --no-overwrite-ignore`; recovery observes rather than resets user changes.
- Mutating MCP calls require idempotency IDs. Responses are paginated valid JSON (4 KiB); artifacts use 16 KiB pages. Observed command evidence is distinct from model claims.
- Submission validates every task/resource/context before preparing owned files and worktrees, then publishes the whole batch with its event in one journal record. Durable preparation manifests permit safe cleanup of unchanged unpublished resources or recovery of committed responses. Uncertain persistence fences dispatch until restart; no implementation request is replayed.
- Typed lifecycle rules keep existing state names and validate grouped transitions. RPC remains 1; storage and newly launched workers use format 2, with explicit offline migration of legacy storage. Corrections immediately remove the old result from review. Cancellation is one-way and overrides late verification snapshots; termination uncertainty retains leases. Rejections preserve structured reasons, changed files and bounded UTF-8 previews without reading symlink targets or authentication bodies.
- Service and workers survive MCP disconnection. Stop/cancel require confirmed termination. Install/update copies self-contained versioned bundles and a marketplace into user storage, retaining old releases. Host exports do not change global registration. Supervisor conversations are not launched by the service; no authored GUI or public marketplace publishing is included.

## Platform and recovery contracts

Run and task worker selections are fixed at submission. Task overrides replace
run selections as a whole; legacy requests default to OpenCode. Native model
and shell defaults are resolved during initial preparation and retained for
corrections. Unsupported models, policies and MCP settings fail explicitly.

HTTP workers use dedicated authenticated servers and their own pinned SDKs.
Codex uses STDIO JSON-RPC; Claude uses an isolated SDK dependency graph.
Process launch, prompt and input-reply intents precede external effects.
Unknown delivery is observed and reconciled without re-dispatch. Attempt-local
permission grants never change global native settings. Cancellation and
uncertain process termination retain slots and resource leases.

The common verifier records its actual shell argv, environment fingerprint,
worktree directory, output and exit code. It follows OpenCode 1.18.30 shell
selection/startup behavior, supports explicit trusted shell overrides, and
preserves PowerShell native exit codes. Final validation starts no model
session. Native plugin shell.env hooks are not run by the common verifier;
required environment values must be supplied through trusted env_refs.

Migration checks committed journal checksums, quiescence, ownership and
preparation records. It preserves request hashes/responses, IDs, approvals,
commits, revisions, context and artifact bytes. An incomplete migration fences
service startup and can resume or restore exact backup bytes. A diagnostic
launch without termination evidence also blocks migration.

## Acceptance evidence

Automated tests use four native fixtures, real Git repositories/processes and
four supervisor exports to exercise 16 MCP contract combinations. They also
cover mixed-worker dependencies/resources/corrections, losses, cancellation,
stale review, evidence, migration and a source-relocated standalone install.
Node 22 macOS/Windows CI runs npm ci, npm run check and pinned model-free
native connection checks. Native model tasks, provider authentication and
IDE/desktop GUI behavior remain unconfirmed until separately exercised.
Paid-model testing and installed-plugin activation are excluded from this work.
