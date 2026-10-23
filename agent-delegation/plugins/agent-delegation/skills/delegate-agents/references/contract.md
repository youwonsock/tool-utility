# Tool inputs

Read tool schemas as authoritative. The 12 tools and inputs are unchanged. Mutations (`submit_tasks`, `review_task`, `respond_to_request`, `reconcile_run`, `cancel_run`, `validate_run`, `finalize_run`) require a unique `request_id`. Identical retries return progress or recorded final results; a conflicting payload is rejected. An unresolved intent requires reconciliation, not blind retry with a fresh ID.

Long mutations can return `{in_progress:true, operation_id, operation_status:"running", run_id?}` after one second. The operation remains reserved and is not yet a completed request. Reuse the same ID and payload for its eventual result; `get_run.operations` exposes `{id,kind,status,updated}`. Restart marks unowned operations uncertain until actual process/Git effects are reconciled. Do not resubmit a new ID to repeat them.

Example initial submission:

```json
{
  "request_id": "project-feature-001",
  "repo": "/absolute/path/to/project",
  "context_files": ["AGENTS.md", ".specs/feature/spec.md"],
  "tasks": [{
    "id": "implement-parser",
    "goal": "Implement the parser described in the supplied specification.",
    "dependencies": [],
    "scope": ["src/parser/**", "test/parser.test.ts"],
    "acceptance": ["Invalid input returns the documented error"],
    "verification": [{"command": "npm test -- parser", "timeout_ms": 600000}],
    "context_files": [],
    "resources": []
  }],
  "final_verification": [{"command": "npm test && npm run build"}]
}
```

Verification runs in the common command runner. Its default selection and Bash/Zsh startup follow OpenCode 1.18.30. A valid configured shell or SHELL is preferred; fallback is Zsh on macOS and PowerShell, Git Bash, then cmd on Windows. PowerShell invocation preserves native exit codes. A trusted execution profile may override the shell. Each execution records the actual shell and environment fingerprint. Scope entries are exact paths, directories ending in `/`, directory `/**` prefixes, or `**` for all source. Context files are protected even within broad scopes.

`submit_tasks.worker` selects the run default; `tasks[].worker` replaces that selection for one task. Both accept `{platform, model?, profile?}`. Platforms are `opencode`, `codex`, `claude-code`, and `kilo`. OpenCode/Kilo models use `{providerID, modelID}`; Codex/Claude models use a string. Missing worker uses OpenCode. Models are selected only through worker.model. Run defaults are immutable on append. Native model selections are fixed for corrections, with no automatic fallback.

Local profiles.json contains `{profiles: {name: {platform, executable, args?, sdk_root?, native_profile?, env_refs?, shell?}}}`. sdk_root is the absolute SDK package directory. native_profile is Codex-only. env_refs maps target variable names to existing environment variable names and cannot disable the worker recursion guard. Profiles are snapshotted at submission; they contain configuration, not copied credential files. A per-platform `<platform>-default` profile overrides its builtin default. Claude defaults to the user-installed claude command.

Users install their own SDK/CLI/GUI runtimes. OpenCode and Kilo require their CLI plus @opencode-ai/sdk or @kilocode/sdk; Claude requires its CLI plus @anthropic-ai/claude-agent-sdk. Codex app-server requires only its CLI. SDK resolution is profile sdk_root → platform SDK_ROOT environment → selected CLI package → current Node/npm global SDK. Project/worktree and other tools' private dependencies are not searched. Invalid explicit paths and incompatible candidates stop without substitution. Platform SDKs load only in owned workers/diagnostic processes. Neither installation nor build downloads them.

Required APIs and policies determine compatibility. `doctor.compatible` reports model-free initialization, effective policy, session creation and confirmed process termination. `baseline` is the test reference; `backend_version` is the actual CLI runtime. `runtime` records CLI and SDK identities/versions/paths. Configuration errors return SDK_NOT_FOUND, SDK_INCOMPATIBLE, CLI_NOT_FOUND or CLI_INCOMPATIBLE with platform/path/required API and setup guidance. A successful diagnostic does not verify paid model execution or provider credentials.

Runtime changes during an existing attempt record RUNTIME_CHANGED and block replay. New corrections recheck the current installation while keeping worker configuration/model fixed. Initialization failures do not spend the correction limit; model dispatch intents, including uncertain delivery, do. Core MCP startup, records/review/cancellation and final verification work without platform SDKs. Only owned processes/sessions are stopped; user GUI applications and installation directories are preserved.

A resource profile is supplied on initial `submit_tasks`:

```json
{
  "resource_key": "unity-editor-01",
  "connection": {"name": "unity", "config": {"type": "remote", "url": "http://127.0.0.1:8080/mcp"}},
  "probe": {"executable": "/path/to/read-only-probe", "args": ["--project", "{{worktree}}"], "read_only": true},
  "expected_instance": "editor-01",
  "project_bound": true
}
```

The probe must query the actual tool, returning `{"instance_id":"editor-01","project_path":"/actual/project"}`. Echoing expected values is not a valid operational probe. `{{worktree}}` expands in connection/probe values. After rebinding an Editor to the reported directory, call `reconcile_run` to recheck the same waiting attempt; no new worktree or model request has been started. Do not remove the identity check.

`get_run` includes attempt ID, commit, input requests, observed checks and artifact IDs. Page tasks using `next_cursor`. `wait_run` returns event deltas and the next `after` value. `get_artifact` uses byte offsets at UTF-8 boundaries and `next_offset`. Normal MCP responses stay within 4 KiB; artifact responses within 16 KiB.

After `validate_run`, use its validation ID/commit/revision only if it is still the current passed validation. `finalize_run` is the explicit supervisor approval, not a request to start tests.

Review additionally requires the task to be `needs_review`. A correction immediately makes the old result unreviewable, including before dispatch and after restart. New request IDs cannot approve or request changes on that queued result; identical retransmissions retain the original idempotent response.

Cancellation intent is persisted before termination waiting and wins over late verification snapshots. Cancelled validations use `cancelled`; the run remains `cancelling` until termination is confirmed. Unknown ownership continues to hold leases. Cancellation accepted before the durable `finalizing` boundary prevents final application; after it `cancel_run` returns `RUN_FROZEN`.

Submission preflight failure publishes no partial task set. Prepared metadata and owned worktrees are recorded under the service's `submissions/` directory. An uncertain journal/snapshot write returns `REQUEST_UNCERTAIN` and fences new dispatch until restart and reconciliation. Restart may recover a committed submission response without replaying implementation. `STATE_TRANSITION` identifies an invalid internal transition; `STATE_CORRUPT` identifies an unknown persisted state. The current service RPC remains version 1.

Rejected results include `rejected-result.json` alongside the tracked diff. It preserves the error code/details and changed-file list, plus at most 64 KiB of UTF-8 preview for an untracked ordinary file. Check `truncated`, size, and SHA-256; binary, authentication, and symlink targets are not text previews. Collection errors do not replace the original rejection.

The service RPC is version 1. Storage and new submission preparations use format 4; workers use format 2. Stopped format 2/3 storage is backed up with original state, journal and archives and migrated before execution; interrupted migration and prepared submissions remain recoverable. Existing format 3 ages/IDs/archive checksums are preserved. Only missing legacy ages start at migration time. Missing or unknown formats are rejected. Rollback requires stopped service/workers and preservation of the entire current data root, then matched backup state/journal/archives at the original absolute data location with referenced jobs/worktrees/context/evidence retained. Only after preservation remove format 4 manifest/generations and migration marker from that restored location. New format 4 runs/preparations cannot be resumed by old releases; reverse conversion and data-root relocation are not provided. The exported skill is delegate-agents; model settings use worker.model.

Permission requests include supported_decisions. General model shell/exec/write_stdin asks the supervisor by default. "always" binds the exact native command/input, cwd, attempt and scope/context policy hash and never saves global native rules. Delegation/background/Git ownership changes and hard path denials cannot be elevated. Every direct edit/delete/rename/patch checks all paths, including both rename endpoints; protected context/Git metadata and symlink/junction/alias escapes are denied. Unknown native mutation payloads fail closed. Native policies/hooks/APIs must be confirmed before model dispatch. Reply delivery remains uncertain until an acknowledgement or causally subsequent native result is observed; late replies recheck pending input and policy. get_run exposes platform/profile/model/version, while credentials and raw native connection configuration remain private.

The worker independently monitors filesystem/Git/context through implementation and declared verification. Ignored build output is allowed except protected context. Stale/missing monitor health fails closed. Violations preserve `scope-violation.json` and original files, stop owned processes and become unapprovable `scope_or_context_error` only after termination proof. Uncertain stop retains the worker monitor and leases; a crashed monitor requires explicit reconciliation with no model replay. Approved arbitrary programs are not isolated from all OS side effects. Declared verification is a separate frozen trusted command runner and freezes source/context.

Codex uses an owned non-ephemeral thread to support `thread/read(includeTurns:true)` after accepted dispatch. Observation/reconciliation never resends the prompt.

Native plugin shell.env hooks are not executed by the common verifier. Declare required environment mappings with env_refs. Ambiguous command/args or env/environment combinations and disabled resources fail preflight. Claude aliases must resolve to their advertised model family; use a resolved ID for unverifiable aliases.

Agent Delegation settings use AGENT_DELEGATION_HOME, AGENT_DELEGATION_INSTALL_ROOT, AGENT_DELEGATION_CONCURRENCY and per-platform AGENT_DELEGATION_{OPENCODE,CODEX,CLAUDE,KILO}_EXECUTABLE / _EXECUTABLE_ARGS. Worker recursion is guarded by AGENT_DELEGATION_WORKER. There are no aliases for prior settings or inputs.

External SDK roots use AGENT_DELEGATION_{OPENCODE,CLAUDE,KILO}_SDK_ROOT. The SDK path points to the package directory, not its parent node_modules. GUI supervisors use MCP; GUI implementer automation is outside the contract.

Completed/cancelled runs and completed request responses are archived after seven days. list_runs includes hot and archived summaries sorted by creation time/ID. list_runs and get_run add archived, archived_at and ended_at. get_run, wait_run, get_artifact and cleanup still work for archived runs. New archived-run mutations return RUN_ARCHIVED; identical request_id retries first return the original response from either store. Missing/corrupt archive data returns STATE_CORRUPT and must never be treated as a new request. Global event sequences remain monotonic after archival. No records/evidence/logs are automatically deleted.

Typed revision-linked journal deltas commit state, responses and events together. At 256 records or max(32 MiB, four latest-record bytes), checkpoints rotate journal generations and publish a manifest without dropping concurrent tails. Large checkpoint/archive serialization runs in a storage worker. New archive manifests use paged task/attempt/event chunks; old archives remain readable. Startup/listing do not hydrate archived bodies; get_artifact reads only requested byte ranges with UTF-8 boundaries. For backup preserve the entire stopped data root, including checkpoint.json and referenced checkpoints/journals/archives; state.json alone is not a current snapshot.
