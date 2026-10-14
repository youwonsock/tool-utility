# Tool inputs

Read tool schemas as authoritative. Mutations (`submit_tasks`, `review_task`, `respond_to_request`, `reconcile_run`, `cancel_run`, `validate_run`, `finalize_run`) require a unique `request_id`. Identical retries return recorded results; a conflicting payload is rejected. An unresolved intent requires reconciliation, not blind retry with a fresh ID.

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

Local profiles.json contains `{profiles: {name: {platform, executable, args?, native_profile?, env_refs?, shell?}}}`. native_profile is Codex-only. env_refs maps target variable names to existing environment variable names and cannot disable the worker recursion guard. Profiles are snapshotted at submission; they contain configuration, not copied credential files. A per-platform `<platform>-default` profile overrides its builtin default.

SDK dependencies are pinned; installed native CLI versions are accepted when required APIs and policies work. `doctor.compatible` reports model-free initialization, effective policy, session creation and confirmed process termination. `baseline` is the test reference; `backend_version` is the actual runtime. A successful diagnostic does not verify paid model execution or provider credentials.

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

Cancellation intent wins over late verification snapshots. Cancelled validations use `cancelled`; the run remains `cancelling` until termination is confirmed. Unknown ownership continues to hold leases.

Submission preflight failure publishes no partial task set. Prepared metadata and owned worktrees are recorded under the service's `submissions/` directory. An uncertain journal/snapshot write returns `REQUEST_UNCERTAIN` and fences new dispatch until restart and reconciliation. Restart may recover a committed submission response without replaying implementation. `STATE_TRANSITION` identifies an invalid internal transition; `STATE_CORRUPT` identifies an unknown persisted state. The current service RPC remains version 1.

Rejected results include `rejected-result.json` alongside the tracked diff. It preserves the error code/details and changed-file list, plus at most 64 KiB of UTF-8 preview for an untracked ordinary file. Check `truncated`, size, and SHA-256; binary, authentication, and symlink targets are not text previews. Collection errors do not replace the original rejection.

The service RPC is version 1. Storage, submission preparations and workers use format 2 only. Missing or other record formats are rejected. The exported skill is delegate-agents; model settings use worker.model.

Permission requests include supported_decisions. "always" applies only within the current attempt and does not save global native permission rules. Reply delivery remains uncertain until an acknowledgement or causally subsequent native result is observed. get_run exposes platform/profile/model/version, while credentials and raw native connection configuration remain private.

Native plugin shell.env hooks are not executed by the common verifier. Declare required environment mappings with env_refs. Ambiguous command/args or env/environment combinations and disabled resources fail preflight. Claude aliases must resolve to their advertised model family; use a resolved ID for unverifiable aliases.

Agent Delegation settings use AGENT_DELEGATION_HOME, AGENT_DELEGATION_INSTALL_ROOT, AGENT_DELEGATION_CONCURRENCY and per-platform AGENT_DELEGATION_{OPENCODE,CODEX,CLAUDE,KILO}_EXECUTABLE / _EXECUTABLE_ARGS. Worker recursion is guarded by AGENT_DELEGATION_WORKER. There are no aliases for prior settings or inputs.
