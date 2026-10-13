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
| MP-01 | MCP schemas accepted only the OpenCode model format. | Typed optional worker selections; preserve legacy hashing. | Four selection regressions and legacy migration retransmission passed. |
| MP-02 | Engine and workers directly called OpenCode SDK. | Separate backend contracts and add three runtimes. | Four worker flows and 16 MCP contract combinations passed on Node 22. |
| MP-03 | Verification depended on OpenCode shell requests. | Durable command-host with real receipts/logs and no-model final validation. | Existing lifecycle/recovery conditions passed. Final validation has no native session. |
| MP-04 | Storage, RPC and workers shared a version constant. | RPC 1; storage/worker 2; guarded explicit offline migration. | Four migration tests passed, including interrupted apply, rollback and changed-file preservation. |
| MP-05 | Releases copied only JS and Codex bindings. | Package SDK/native assets and export four hosts. | Source-moved installation, isolated Claude SDK initialization and bundled native binary version check passed. |
| MP-06 | Claude SDK requires Zod 4 while the existing contract uses Zod 3. | Isolate SDK peers in a local runtime package. | npm dependency resolution and strict type checking passed; original SDK/Zod pins preserved. |
| MP-07 | Codex added default fields to its effective hook configuration. | Compare required command/matcher/synchronous semantics. | Real Codex 0.146.0 initialization passed after correction. |
| MP-08 | A regression depended on the removed native final-verification question mechanism. | Test answered implementation input, verification command continuation and service recovery using real process gates. | Rewritten regression passed without fixed sleeps deciding success. |
| MP-09 | macOS CI hit the old 30-second installer timeout after adding native SDK assets. | Use copy-on-write cloning where available and a 120-second bounded install check. | Two CI installation failures reproduced; repair validation in progress. |

## Goal/result comparison (current evidence)

| Requirement | Evidence | Status |
| --- | --- | --- |
| Four platforms in both roles | host-matrix.test.mjs: four host exports × four mock backends, actual MCP/Git/process workflow | Automated contract passed; model behavior unconfirmed by design. |
| Existing workflow and safety conditions | Node 22 suite: 57 tests passed, including original review/cancel/submission/evidence/lease scenarios | Passed locally. |
| Real model-free native connections | connection-check.mjs on Node 22: OpenCode 1.18.30, Codex 0.146.0, Claude bundled 2.1.296, Kilo 7.4.23 | All four passed; provider model authentication unconfirmed. |
| Portable installation | Installed CLI, isolated SDK and native binary used after source relocation | Passed locally. |
| Plugin/skill structure | Official plugin-creator and skill-creator validators; generated binding checks | Passed. |
| macOS/Windows CI | Draft PR #5, commit 5bed65ccc0e26234177ee65c7f35dc4c442fe3d5, Actions run 38395587763 | Running; completion is not yet claimed. |
| GUI layout | No authored GUI; native IDE/desktop interfaces are unchanged and export support marks them unconfirmed | Not applicable to authored layout; native GUI unconfirmed. |
| Paid models and installed activation | Connection checks never dispatch prompts; registration tests use temporary mocked installers | Excluded and not performed. |

This plugin has no authored GUI. Layout checks apply to generated/documented
host configuration and skill metadata; native IDE/desktop screens must be
marked unconfirmed unless actually inspected. CLI/API connectivity is not
evidence of model-task or GUI end-to-end success.
