# Multi-platform implementation audit

The acceptance reference is the revised plan from 2026-10-13. The supervisor
remains the user's current agent; the service starts implementation workers.
No paid model invocation or installed-plugin activation is part of this work.

## Required evidence

- Four supervisor exports and four implementation backends; all 16 MCP contract combinations.
- Existing review, cancellation, resource, submission, rejected-evidence and Git invariants.
- Frozen platform/profile/model selection and backward-compatible MCP inputs.
- Durable dispatch/reply/command intents; no uncertain automatic replay.
- Platform-specific permission/question handling and effective policy checks.
- Common observed verification and final validation without model requests.
- RPC 1, storage 2 and new worker format 2; explicit offline migration with recovery.
- Standalone releases including native SDK assets, preserved plugin identity and paths.
- Node 22 macOS/Windows checks, real model-free connection checks and honest support levels.
- No changes to unrelated folders or activation of the installed plugin.

## Issues and repair cycles

| ID | Observation | Required repair | Evidence / status |
| --- | --- | --- | --- |
| MP-01 | MCP schemas currently accept only the OpenCode model format. | Add typed optional worker selections without changing legacy request hashes. | New selection regressions added; expected to fail before implementation. |
| MP-02 | Engine and workers directly call OpenCode SDK. | Separate backend contracts and add the other three runtimes. | Pending. |
| MP-03 | Verification uses OpenCode shell requests and requires its runtime. | Add durable process-backed verification and no-model final validation. | Pending. |
| MP-04 | Storage, RPC and worker records share one version constant. | Separate formats and implement guarded offline migration. | Pending. |
| MP-05 | Release copies only a JS bundle and Codex bindings. | Include required SDK assets and four supervisor exports. | Pending. |
| MP-06 | Claude Agent SDK 0.3.296 requires Zod 4; the existing contract uses Zod 3. | Isolate SDK peers in a local runtime package, preserving root SDK and Zod versions. | Dependency resolution conflict reproduced; repair in progress. |
| MP-07 | Real model-free checks passed OpenCode, Claude and Kilo; Codex hook config comparison failed. | Compare required hook semantics while accepting native default-field normalization. | Reproduced on Codex 0.146.0; repair in progress. |

This plugin has no authored GUI. Layout checks apply to generated/documented
host configuration and skill metadata; native IDE/desktop screens must be
marked unconfirmed unless actually inspected. CLI/API connectivity is not
evidence of model-task or GUI end-to-end success.
