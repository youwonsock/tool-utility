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
| MP-12 | Windows Node 22 cpSync failed when generated skills overwrote source wrappers under Korean paths. | Replace the owned skills directory before copying; reuse existing immutable releases and clean failed staging directories. | Both Windows installation tests passed after repair in run 38432215456. |
| MP-13 | Resource normalization silently discarded duplicate args/environment fields and enabled disabled resources. | Reject conflicting fields and disabled declared resources in preflight. | Regression reproduced, repaired and passed. |
| MP-14 | Codex accepted a substituted native model; Claude accepted any advertised alias even with an unrelated resolved model. | Compare resolved model IDs and verify advertised alias family before dispatch. | Codex/Claude substitution regressions passed; real no-model connection checks retained. |
| MP-15 | The common verifier did not follow pinned OpenCode shell selection or Bash/Zsh initialization. | Port pinned selection/startup behavior, freeze resolved shells, preserve PowerShell exit codes and record actual argv. | Default/explicit shell checks passed on both OSes; Windows default PowerShell and explicit cmd preserve exit 7, quotes, output and cwd. |
| MP-16 | Initial platform tests did not cover mixed-worker resource/dependency/correction gates or rich migration records. | Add explicit scheduler ticks, frozen-profile corrections, reviewed/evidence/history migration and orphan diagnostic checks. | Mixed flow and richer migration regressions passed; committed preparation and corrupt/mixed journal cases are covered. |
| MP-17 | Native policy checks verified only a small subset of declared restrictions. | Compare required HTTP root/agent permissions and all overridden Codex feature flags before dispatch. | Four real model-free connections passed after tighter checks. |
| MP-18 | Packaging duplicated shared peer dependency subtrees, adding file copies to every immutable release. | Share identical packages in the isolated locked SDK graph; retain nearer nested entries for differing versions/peer graphs and current-OS native assets. | Source-relocated mock SDK and real bundled runtime initialization passed on macOS and Windows; deployment assets reduced from 512 MiB to 312 MiB locally. |
| MP-19 | Unused invalid resources could be persisted, and portable args/env keys leaked into strict HTTP-runtime native config. | Validate every resource before preparation and construct only supported native fields. | Complete-preflight and canonical-translation regressions passed on both OSes. |
| MP-20 | Resuming an interrupted migration did not recheck newly created diagnostic processes. | Recheck owned processes for both apply and rollback before writing targets. | Real current-process ownership regression passed on both OSes; startup remains fenced. |
| MP-21 | A source-only migration fixture could observe terminal task state before its scheduler tick finished collecting evidence. | Stop scheduling and await the serial tick before freezing the legacy fixture. | Deterministic barrier passed on both OSes, without success-by-sleep. |
| MP-22 | doctor compared an external Claude CLI version with its SDK baseline and reported a valid runtime as incompatible. | Compare external CLI and SDK baselines separately; assert compatible in the source-relocated SDK test. | External CLI compatibility and bundled runtime initialization passed in both source-relocated installation checks. |
| MP-23 | Authless Codex initialization returns a null configured model, which was treated as an explicit selection. | Resolve absent/null defaults from thread/start while retaining strict checks for explicit models. | Null-default regression and actual authless Codex initialization passed on both OSes. |
| MP-24 | Windows npm CLI wrappers passed version checks but produced no persistent server/STDIO responses, while the direct Claude binary initialized. | Keep POSIX process groups; avoid detaching Windows wrapper roots and continue owned taskkill /T termination. | All four native Windows connections passed after repair; POSIX native checks and Windows cancellation/restart also passed. |
| MP-25 | The daemon-restart fixture waited only 15 seconds after an arbitrary 8-second model delay; Windows CIM/verification completion exceeded that bound. | Use a physical completion gate, bounded state convergence and confirmed stop; retain exactly one prompt and cached retransmission checks. | Physical-gate fixture passed on both OSes and observed exactly one prompt after server restart. |

| MP-26 | A repeated Windows run did not reach cancelled within the former 60-second recovery window; the fixture cancelled at intent rather than confirmed native receipt. | Hold implementation with a physical gate, confirm receipt/live server before cancellation, and observe terminal state/processes with bounded diagnostics. | Repeated CI exposed the timing assumption; final recheck required without weakening uncertain-termination leases. |

## Final goal/result comparison

Code/test acceptance commit: `417028c65813e2c0dbfa5ac5247481cba60ceae8`.
[Node 22 CI evidence](https://github.com/youwonsock/tool-utility/actions/runs/38432215456):
all four regression/native jobs succeeded. Later documentation-only commits
record these observed results; PR #5 remains a draft for review.

| Requirement | Evidence | Result |
| --- | --- | --- |
| Four supervisors and four implementers | Four generated host bindings × four mock workers using real STDIO MCP, Git and processes | All 16 contract combinations passed. Real model-task behavior is unconfirmed. |
| Workflow and existing safeguards | Local/macOS 74 tests passed; Windows 71 passed, 0 failed, 3 Unix-only scenarios skipped | Passed. Review, correction, integration, cancellation, evidence and source preservation retained. |
| Mixed selection and frozen settings | Explicit scheduler ticks, shared resource contention, cross-platform dependencies, changed-profile correction and exact-commit review | Passed. No platform/model fallback. |
| Durable delivery and termination | Lost acknowledgements, owned process ledgers, input replies, cancellation/restart and no duplicate native prompt | Passed in automated contracts. Native paid-task recovery remains unconfirmed. |
| Common verification | Default/explicit shell tests, real exit codes/logs/cwd, source-change detection and model-free final validation | Passed on both OSes. Native plugin shell.env extensions require explicit env_refs. |
| Storage migration | Nine migration tests: hashes/responses, approvals/context/artifacts/history, preparation, corruption, interruption/resume/rollback and process ownership | Passed. RPC 1; storage/new worker format 2; legacy files retained. |
| Real model-free connections | OpenCode 1.18.30, Codex 0.146.0, Claude bundled 2.1.296, Kilo 7.4.23 | All four passed on macOS and Windows. Provider model authentication is unconfirmed. |
| Portable deployment | Korean/space paths, moved source, isolated SDK, actual bundled runtime initialization and marketplace rollback | Passed on both OSes. Installed plugin was not activated. |
| Plugin/skill structure | Official validators plus portable generated binding/skill checks | Passed. Existing plugin ID, folder and data paths retained. |
| CI | Separate Node 22 macos-15/windows-latest regression and native matrices; npm ci, check/build and pinned native checks | All four jobs passed at the acceptance commit. |
| GUI layout | No authored GUI; native IDE/desktop export support records unconfirmed GUI status | No authored layout to repair; native GUI unconfirmed. |
| Scope preservation | 77 source/workflow files matched the acceptance commit; changes limited to codex-opencode and its dedicated workflow | Passed. Other folders and installed-plugin registration preserved. |
| Exclusions | No implementation prompts in real connection checks; installation registration fixtures are mocked and temporary | No paid-model task, cloud implementer or installed activation was performed. |

The 16 scripted combinations and actual native initialization checks do not
establish real AI planning/review/implementation or IDE/desktop GUI success.
Those are separately scoped follow-up validations.
