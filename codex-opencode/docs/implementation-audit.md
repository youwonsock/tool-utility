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
| MP-09 | macOS CI hit the old 30-second installer timeout after adding native SDK assets. | Use copy-on-write cloning where available and a 120-second bounded install check. | macOS installation passed after the timeout/copy repair; the subsequent Windows overwrite failure is tracked as MP-12. |
| MP-10 | Windows cmd re-quoted command text: exit(7) appeared as exit 0, and source-changing/gated scripts did not execute correctly. | Use cmd's outer command quoting with verbatim Windows arguments; keep exit/source-change regressions mandatory. | Exit-code, source-edit and gated-verification regressions passed on Windows in Actions run 38417136124; dedicated shell variants remain mandatory. |
| MP-11 | The installer fixture performs several large immutable-release copies and exceeded the old file-level 180-second test deadline. | Keep per-install 120-second bounds and raise file-level integration deadline to 600 seconds. | Windows run 38417136124 completed every test file without cancellation; two installation errors were independently identified as MP-12. |

| MP-12 | Windows Node 22 cpSync failed when generated skills overwrote source wrappers under Korean paths. | Replace the owned skills directory before copying; reuse existing immutable releases and clean failed staging directories. | Reproduced in two Windows installation tests; exact Windows CI recheck required. |
| MP-13 | Resource normalization silently discarded duplicate args/environment fields and enabled disabled resources. | Reject conflicting fields and disabled declared resources in preflight. | Regression reproduced, repaired and passed. |
| MP-14 | Codex accepted a substituted native model; Claude accepted any advertised alias even with an unrelated resolved model. | Compare resolved model IDs and verify advertised alias family before dispatch. | Codex/Claude substitution regressions passed; real no-model connection checks retained. |
| MP-15 | The common verifier did not follow pinned OpenCode shell selection or Bash/Zsh initialization. | Port pinned selection/startup behavior, freeze resolved shells, preserve PowerShell exit codes and record actual argv. | Default/explicit shell regression checks passed locally; Windows default and cmd are checked separately in CI. |
| MP-16 | Initial platform tests did not cover mixed-worker resource/dependency/correction gates or rich migration records. | Add explicit scheduler ticks, frozen-profile corrections, reviewed/evidence/history migration and orphan diagnostic checks. | Mixed flow and richer migration regressions passed; committed preparation and corrupt/mixed journal cases are covered. |
| MP-17 | Native policy checks verified only a small subset of declared restrictions. | Compare required HTTP root/agent permissions and all overridden Codex feature flags before dispatch. | Four real model-free connections passed after tighter checks. |
| MP-18 | Packaging duplicated shared peer dependency subtrees, adding file copies to every immutable release. | Share identical packages in the isolated locked SDK graph; retain nearer nested entries for differing versions/peer graphs and current-OS native assets. | Source-relocated SDK/binary initialization and installation remain required validation gates. |

| MP-19 | Unused invalid resources could be persisted, and portable args/env keys leaked into strict HTTP-runtime native config. | Validate every resource before preparation and construct only supported native fields. | Added complete-preflight and canonical-translation regressions. |
| MP-20 | Resuming an interrupted migration did not recheck newly created diagnostic processes. | Recheck owned processes for both apply and rollback before writing targets. | Added a real current-process ownership regression; startup remains fenced. |

| MP-21 | A source-only migration fixture could observe terminal task state before its scheduler tick finished collecting evidence. | Stop scheduling and await the serial tick before freezing the legacy fixture. | Reproduced on macOS CI; deterministic barrier added without success-by-sleep. |
| MP-22 | doctor compared an external Claude CLI version with its SDK baseline and reported a valid runtime as incompatible. | Compare external CLI and SDK baselines separately; assert compatible in the source-relocated SDK test. | Regression assertion added to installation validation. |

| MP-23 | Authless Codex initialization returns a null configured model, which was treated as an explicit selection. | Resolve absent/null defaults from thread/start while retaining strict checks for explicit models. | Native CI reproduced the error after all 73 regressions passed; a null-default regression was added. |

## Goal/result comparison (current evidence)

| Requirement | Evidence | Status |
| --- | --- | --- |
| Four platforms in both roles | host-matrix.test.mjs: four host exports × four mock backends, actual MCP/Git/process workflow | Automated contract passed; model behavior unconfirmed by design. |
| Existing workflow and safety conditions | Node 22 suite: 69 tests passed before the final alias/packaging audit; final suite has 74 tests including review/cancel/submission/evidence/lease scenarios | Final exact check is recorded in PROGRESS.md and the PR validation results. |
| Real model-free native connections | connection-check.mjs on Node 22: OpenCode 1.18.30, Codex 0.146.0, Claude bundled 2.1.296, Kilo 7.4.23 | All four passed; provider model authentication unconfirmed. |
| Portable installation | Installed CLI, isolated SDK and native binary used after source relocation | Final exact check is recorded in PROGRESS.md and the PR validation results. |
| Plugin/skill structure | Official plugin-creator and skill-creator validators; generated binding checks | Passed. |
| macOS/Windows CI | Draft PR #5; earlier macOS run 38417136124 passed; Windows exposed MP-12 | Final-head CI is required after all repairs; results are recorded on PR #5. |
| GUI layout | No authored GUI; native IDE/desktop interfaces are unchanged and export support marks them unconfirmed | Not applicable to authored layout; native GUI unconfirmed. |
| Paid models and installed activation | Connection checks never dispatch prompts; registration tests use temporary mocked installers | Excluded and not performed. |

This plugin has no authored GUI. Layout checks apply to generated/documented
host configuration and skill metadata; native IDE/desktop screens must be
marked unconfirmed unless actually inspected. CLI/API connectivity is not
evidence of model-task or GUI end-to-end success.
