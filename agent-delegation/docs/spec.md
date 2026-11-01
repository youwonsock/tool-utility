# Multi-platform agent delegation

Status: current Agent Delegation contract.

The current conversation owns planning, review, correction instructions and final approval. This tool owns durable execution, observed verification, evidence and Git mechanics. A selected local implementation backend changes source in its worktree. Codex, OpenCode, Claude Code and Kilo can fill either role. The target repository is independent of the supervisor workspace.

## Contracts

- Node 22+, Windows/macOS. Users install, update and authenticate their CLI, SDK and GUI applications. Platform SDKs/CLIs are never bundled, installed or substituted by the tool. Required APIs and policies determine compatibility; version strings identify the runtime. Codex app-server is experimental. The 14 STDIO MCP tools connect to an authenticated localhost service. Each implementation attempt owns its native session/process ledger and isolated worktree.
- Defaults: concurrency 2, timeout 60 minutes, at most 3 corrections after the initial model dispatch. Configuration/initialization failures do not spend this budget; uncertain dispatch intents do. No automatic model fallback or implementation retry.
- Start only on a named branch with clean tracked and untracked source files. Explicit ignored context snapshots are immutable, preserve relative paths, cannot overwrite tracked files, and cannot enter result commits.
- Tasks declare goals, dependencies, edit scope, acceptance criteria, at least one verification command, context files and resource keys. Dependencies require accepted and integrated predecessor commits. Resource locks span all runs owned by the service. Read-only probes must confirm instance identity and, when applicable, the actual attempt/validation project path.
- A failed resource probe exposes the allocated worktree and waits without dispatching a model request. Rebinding the resource and calling `reconcile_run` rechecks that same worktree under its existing lease; final validation remains frozen while waiting. It does not allocate a replacement worktree just to retry a connection check.
- Persist outbound intent before every native dispatch, input reply and verification command. Unknown delivery is reconciled against session messages; never blindly replay. Unknown process ownership holds locks and blocks replacements.
- Completion commits are immutable. Review binds attempt ID and commit; integration is serial. Conflicts and scope violations require supervisor instructions. A correction reapplies the latest committed attempt; conflicted files are named in its prompt, and a result that leaves them marked or unchanged becomes conflict_unresolved and cannot be approved. A failed apply stops before dispatch and spends no correction.
- Final validation freezes task revision, integration commit, context hash and commands. It runs in a separate worktree. Source changes invalidate it. Final approval must name the validation, commit and revision. Finalize rechecks the original checkout and uses `git merge --ff-only --no-overwrite-ignore`; recovery observes rather than resets user changes.
- Mutating MCP calls require idempotency IDs. Calls taking longer than one second may return {in_progress:true, operation_id, operation_status:"running", run_id?}; identical retries follow progress or the final result, never duplicate execution. get_run adds operations with id/kind/status/updated. Responses are paginated valid JSON (4 KiB); artifacts use 16 KiB pages. Observed command evidence is distinct from model claims.
- Submission validates every task/resource/context before preparing owned files and worktrees, then publishes the whole batch with its event in one journal record. Durable preparation manifests permit safe cleanup of unchanged unpublished resources or recovery of committed responses. Uncertain persistence fences dispatch until restart; no implementation request is replayed.
- Typed lifecycle rules validate grouped transitions. Data with a different format number is rejected without conversion and blocks startup and installation switching. Corrections immediately remove the old result from review. Cancellation is one-way and overrides late verification snapshots; termination uncertainty retains leases. Rejections preserve structured reasons, changed files and bounded UTF-8 previews without reading symlink targets or authentication bodies.
- Service and workers survive MCP disconnection. Stop/cancel require confirmed termination. Install/update copies self-contained versioned bundles and a marketplace into user storage, retaining old releases. Host exports do not change global registration. Supervisor conversations are not launched by the service; no authored GUI or public marketplace publishing is included.

## Platform and recovery contracts

Run and task worker selections are fixed at submission. Task overrides replace
run selections as a whole; create_run and doctor require a selection. Native model
and shell defaults are resolved during initial preparation and retained for
corrections. Unsupported models, policies and MCP settings fail explicitly.

OpenCode and Kilo require their user-installed CLI and public SDK v2/client.
Codex requires only its CLI and uses STDIO JSON-RPC. Claude requires its CLI
and user-installed Agent SDK query API, always passing the selected CLI.
SDK resolution uses absolute profile sdk_root, platform SDK_ROOT environment,
the selected CLI's own package, then the current Node/npm global root. Explicit
bad paths and incompatible candidates stop without fallback. Project/worktree
and unrelated tool dependencies are never automatically searched. SDK exports
use ESM conditions and file URLs; original dependencies remain in place.
Only owned worker/diagnostic processes import platform SDKs. Core MCP,
installer, recovery observation, review, cancellation and verification do not.
Native version strings identify the actual runtime and do not determine compatibility.
Doctor checks initialization, effective policy, session creation and confirmed
process termination without sending a model prompt. Its compatible flag reports
those checks; full model execution and provider authentication need separate tests.
Process launch, prompt and input-reply intents precede external effects.
Unknown delivery is observed and reconciled without re-dispatch. Attempt-local
permission grants never change global native settings. Cancellation and
uncertain process termination retain slots and resource leases.

Only short admission, reservation, intent and result writes use the serial
control queue. Diagnostic/probe/Git/termination effects run outside it with
immutable inputs and owned operation IDs. Slots/resources and per-run/target
reservations precede dispatch. Completion rechecks ownership, revision and cancel
generation; stale successful effects cannot resurrect cancelled work. Unowned
intents after restart become uncertain and require process/Git reconciliation,
never blind effect replay. cancel_run persists intent before asynchronous stop
waiting. A durable finalizing barrier rejects later cancellation with RUN_FROZEN;
cancel accepted before it prevents target application.

Every direct write/edit/delete/rename/patch validates every native path, including
both rename endpoints. Scope uses exact files, directory / or /** and ** semantics.
Protected context, Git metadata and parent directory removal remain hard denied.
Existing-parent realpaths, case/short-name aliases, traversal, alternate streams
and symlink/junction paths cannot escape protection. Opaque mutation payloads
fail closed. HTTP runtimes confirm effective edit/bash ask policies and permission
APIs; Codex discovers its sole owned synchronous PreToolUse hook with hooks/list,
relaunches with only that entry's exact key/currentHash trusted in invocation
overrides, and verifies trusted status, features, approval policy and the
workspace-write sandbox before model dispatch. It enables code_mode_host for
guarded execution without changing global hook trust. Claude confirms hook
registration and SDK permission callbacks before model dispatch.

Model shell/exec/write_stdin requests ask the supervisor by default. Codex blocks
native shell/exec/write_stdin and uses the owned delegate_run_command dynamic
tool for foreground commands. The app-server tool call stays pending while the
existing supervisor permission request is answered; command intent, receipt,
bounded output and owned-process termination are recorded without replacing or
stopping the model server. delegate_read_file reads at most 64 KiB of regular
UTF-8 text per call, restricted to task scope or exact protected context paths.
Native apply_patch uses canonical tool_input.command and checks all patch paths.
The native request_user_input question tool retains the existing supervisor
question/answer route. The owned Codex hook emits only allow/deny: its current ask decision is unsupported
and can fail open. Unknown tools and native MCP calls, including declared tools
that would require ask, are explicitly denied; the dynamic gateway does not yet
provide MCP tool approval.
Delegation,
background and Git ownership mutations remain denied. Grants bind exact native
command/input, cwd, attempt and scope/context policy hash; always remains local
to that attempt and cannot override hard path denial. Late replies revalidate
pending native input and policy. Approved arbitrary programs still have ordinary
process side effects: these controls are not OS isolation.

A worker-owned filesystem watcher and periodic Git/head/ref/context inspector
continue through implementation and declared verification after service/MCP
disconnection. Verification freezes tracked and nonignored source; ignored build
outputs are allowed unless protected context. Missing/stale/unknown monitor health
blocks dispatch and native permission delivery. A violation preserves bounded
evidence, stops only owned execution and never resets/deletes files. Evidence
collection errors do not replace its original reason. scope_or_context_error is
reported only after termination proof and cannot be approved. Uncertain stops
retain the live worker/monitor and bounded confirmation retries without replay.
A crashed worker requires explicit ownership reconciliation and retains leases.

Codex owns a non-ephemeral thread because ephemeral thread/read(includeTurns)
is rejected after accepted dispatch. The same owned thread is read to reconcile
messages; observation failure never resends a model prompt. During the first
30 seconds after dispatch, only the exact empty-rollout metadata error for that
accepted owned session may be observed again on the next normal polling cycle.
Other errors and expiration remain failures, and cancellation does not wait for
rollout materialization.

Submission checks only the actual task workers before preparing artifacts.
Runtime identities retain real executable/SDK paths, argument-file identities,
versions and hashes. Workers compare the submitted identity before startup
and model dispatch. New correction attempts discover the current compatible
installation under the frozen configuration/model; existing attempts do not
reload a different runtime. Missing/changed identity records RUNTIME_CHANGED
without model replay. Missing/other record formats remain unsupported. Missing
process-ledger evidence cannot prove termination and must retain uncertainty and leases. A live old service or leased
attempt blocks installation switching with UPDATE_PENDING.

The common verifier records its actual shell argv, environment fingerprint,
worktree directory, output and exit code. It follows OpenCode 1.18.30 shell
selection/startup behavior, supports explicit trusted shell overrides, and
preserves PowerShell native exit codes. Final validation starts no model
session. Native plugin shell.env hooks are not run by the common verifier;
required environment values must be supplied through trusted env_refs.

## Acceptance evidence

Automated tests use four native fixtures, real Git repositories/processes and
four supervisor exports to exercise 16 MCP contract combinations. They also
cover mixed-worker dependencies/resources/corrections, losses, cancellation,
stale review, evidence and a source-relocated standalone install.
Node 22 macOS/Windows CI runs npm ci, npm run check and reference model-free
native connection checks. Real CLI/SDK fixtures are explicitly installed into
a separate temporary prefix; ordinary install/build/update never prepares them.
SDK-free installation, missing/API-incompatible diagnostics, mutable external
runtime recovery and non-dispatch retry budgeting are regression requirements.
Native model tasks, provider authentication and
IDE/desktop GUI behavior remain unconfirmed until separately exercised.
Paid-model testing is separate from the model-free checks. Installation activation is performed only when requested by the user.

## Naming and inputs

The package, plugin and MCP server are agent-delegation. Only delegate-agents is exported. Model selection uses worker.model. Task worker overrides replace the run selection. Runtime configuration uses AGENT_DELEGATION environment variables.

## Seven-day archives

Runs retain their first terminal ended_at; completed/cancelled runs and done request responses move to checksummed cold files after seven days. Startup/hourly scans perform one move per serialized scheduler tick. Leased/unconfirmed processes and unresolved submission preparations block run archival. Request intents remain hot; archived response hashes and results preserve idempotency. Summaries, resource fingerprints and the global event sequence remain in the hot checkpoint. list_runs includes both stores ordered by created time/ID; get_run/wait_run/artifacts and cleanup retain access. New archived-run mutations return RUN_ARCHIVED, after idempotency lookup. Responses add archived/archived_at/ended_at without new tools or inputs.

Archive files publish before index/removal commits. Uncertain commit/checkpoint delivery fences dispatch; missing/corrupt archives never become fresh requests. Run manifests split task/attempt/history and bounded event chunks, so paged reads do not hydrate the entire archive. Artifact reads use requested byte ranges plus UTF-8 boundary lookaround, not full-file reads.

Storage appends typed revision-linked checksummed deltas, atomically combining
state changes, request results and events. Full snapshots are checkpoints rather
than per-write output. At 256 records or max(32 MiB, four current-record sizes), a
durable new journal tail is rotated before a storage worker serializes immutable
prior generations into checkpoints/<id>/state.json. Atomic checkpoint.json
publication retains concurrent tails; obsolete files retire after read leases.
Recovery streams journal records. state.json remains the initial format guard;
backup must include the manifest and its referenced generations, not only that file.

Back up the entire stopped data root, including its manifest, referenced
checkpoint/journal generations, archives, jobs, worktrees and context/evidence.
Preserve the current root before restoring a consistent whole backup at its
original absolute location with a matching release. Data-root relocation and
mixing snapshots/journals from different generations are unsupported.
Evidence, logs, worktrees and backups are not automatically removed.
