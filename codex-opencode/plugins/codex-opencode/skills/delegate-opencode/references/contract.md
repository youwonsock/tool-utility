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

Use the platform's OpenCode shell syntax for `command`. Scope entries are exact paths, directories ending in `/`, directory `/**` prefixes, or `**` for all source. Context files are protected even within broad scopes. Supply an explicit `{providerID, modelID}` only to override the existing OpenCode default; unavailable selections fail without fallback.

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

The probe must query the actual tool, returning `{"instance_id":"editor-01","project_path":"/actual/project"}`. Echoing expected values is not a valid operational probe. `{{worktree}}` expands in connection/probe values. After rebinding an Editor, request a correction/retry; do not remove the identity check.

`get_run` includes attempt ID, commit, input requests, observed checks and artifact IDs. Page tasks using `next_cursor`. `wait_run` returns event deltas and the next `after` value. `get_artifact` uses byte offsets at UTF-8 boundaries and `next_offset`. Normal MCP responses stay within 4 KiB; artifact responses within 16 KiB.

After `validate_run`, use its validation ID/commit/revision only if it is still the current passed validation. `finalize_run` is the explicit supervisor approval, not a request to start tests.
