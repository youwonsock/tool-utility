# Implementation and validation

## 2026-09-22

- Created `codex/opencode-delegation` from upstream `main` (`720ca42`).
- Scaffolded the repository-local plugin and marketplace using plugin-creator, and the delegation skill using skill-creator.
- Established the approved v1 contracts in `docs/spec.md` before implementation.
- Implemented the typed MCP contract, authenticated singleton service, independent worker supervisors, durable journal/snapshots and request deduplication.
- Implemented immutable context snapshots, task worktrees, dependencies, global resource leases with read-only identity probes, OpenCode SDK integration, explicit input decisions and observed command evidence.
- Implemented immutable result commits, correction attempts, sequential integration/conflict evidence, frozen final validation and guarded fast-forward/recovery.
- Implemented bundled installation, repository-local marketplace/skill, versioned releases, update rollback, old-release retention, stop and worktree cleanup commands.
- Added a Windows/macOS Node 22 CI workflow, scoped to this tool.

### Local validation

- macOS / Node 25.2.1: TypeScript strict type checking passed.
- 23 automated tests passed in the complete suite. Tests use real temporary Git repositories and processes with a mock OpenCode HTTP server.
- Covered context exclusion, scope violations, actual nonzero exit codes versus model success claims, exact commit approvals, correction/integration conflict handling, dependency scheduling, global resource serialization and project mismatch.
- Covered dropped prompt responses, MCP disconnect, service restart, cancellation/restart, process-group termination, uncertain launch ownership, reboot-state reconciliation, interrupted result commits and recovery immediately after merge.
- Covered validation-time source edits, changed target commit/branch/working tree, ignored-file collision, task/command approval invalidation, UTF-8 response budgets/pagination/deltas and torn-journal recovery.
- Verified an installed bundle through a real MCP client after moving its source, using paths containing Korean text and spaces and no source `node_modules`.
- Verified marketplace replacement, retained prior releases, rollback after installation failure, and incompatible-format update deferral.
- Verified reattaching a project-bound resource to the same waiting task/final-validation worktree before its first dispatch. Resource leases remain held while the connection is unresolved.
- Fixed service snapshot progress tracking so dispatch intent and session details are saved even when the worker phase does not change. Unix process ownership timestamps are independent of the caller's time zone.
- Official `plugin-creator` validator and `skill-creator` validator passed. The repository's portable plugin validator also passed.
- Forward-tested the delegation Skill with a separate agent using stale approval, unknown test exit and recursive delegation permission scenarios. It refused stale finalization, distinguished reported success from observed evidence and requested the required correction/validation flow.
- Installed and updated the actual local Codex plugin from a copied user installation marketplace; the development checkout is not its runtime source.

### External validation status

- macOS OpenCode 1.18.30: local HTTP connection and default model resolution initially passed. Parallel live requests failed with provider authentication HTTP 401; no automatic fallback or success claim was made.
- The user removed that provider. A replacement model is awaiting explicit selection for a fresh live verification run.
- Windows live model access has not been tested.
- Published the branch through the repository owner's GitHub connection after Git CLI credentials lacked permission. `main` is unchanged.
- Remote macOS Node 22 CI passed. Windows path alias handling (`RUNNER~1` versus the actual user directory) and test-client cleanup were corrected. Installation explicitly uses JS traversal to avoid Node 22's native `cpSync` Unicode-directory issue ([Node fix](https://github.com/nodejs/node/pull/61950)); both Windows installation tests passed after that fix.
- Windows cancellation/restart reached confirmed cancellation after the test's former 15-second wait. Its wait now allows 60 seconds for process-tree/CIM checks and also verifies that the actual OpenCode server is no longer alive.
- The portable plugin validator accepts Windows CRLF checkouts. Local installed MCP verification exposed all 12 tools and confirmed authenticated service connection and explicit stop.
- Final code/test commit `f8bf06d59298b8d5e5cdc4035cad43bea6bdca37` passed [Windows and macOS Node 22 CI](https://github.com/youwonsock/tool-utility/actions/runs/35706776306): macOS 23 passed; Windows 22 passed, 0 failed, 1 Unix-only process-group test skipped. Windows worker cancellation tests exercise `taskkill /T`. Type checking and plugin validation passed on both systems.
- The failed live-model run was explicitly cancelled and its service stopped; evidence was retained. A new real-model parallel implementation → correction → final validation → reviewed fast-forward remains pending replacement-model selection. No Codex token-saving percentage is claimed.

## 2026-10-13

- Added literal lifecycle types and grouped transition checks for runs, tasks, attempts, validations and worker phases. Legacy names and protocol 1 remain compatible; unknown persisted states report `STATE_CORRUPT`, invalid transitions report `STATE_TRANSITION`.
- Corrections immediately make the old result unreviewable before the next scheduler tick and across restarts. Cancellation intent is saved before control delivery and overrides late validation results; uncertain termination keeps leases and slots.
- Split submission into complete preflight, owned preparation and journal publication. Durable manifests recover committed responses or clean unchanged unpublished resources. Storage uncertainty fences dispatch without replaying models; changed prepared checkouts are preserved.
- Added structured rejection evidence with tracked diffs, changed-file reasons, 64 KiB UTF-8 previews, sizes/hashes and explicit omissions for binary/authentication/symlink targets. Diagnostic failure retains the original rejection reason.
- Added 18 regression tests to the original 23. Local macOS / Node 25.2.1: `npm run check` passed strict type checking, all 41 tests, and plugin validation. Tests use mock OpenCode HTTP plus real temporary Git repositories and processes; no paid model calls or installed-plugin deployment were performed.
- Prepared Node 22 CI for `macos-15` and `windows-latest`, scoped to the delegation tool and its workflow. Remote results are recorded separately once observed.
- Initial remote Node 22 macOS CI passed all 41 tests. Windows exposed a regression-fixture restoration assumption: its checked-out file may use CRLF. The fixture now restores the exact captured bytes, preserving the production rule that changed prepared checkouts must never be removed.

## 2026-10-14 — platform extension

- Acceptance reference: docs/platform-plan.md. The supervisor remains the user's current conversation, with four host exports and four interchangeable local implementation backends.
- Added frozen platform/profile/model settings, durable native dispatch/reply/process evidence, platform permissions/questions/cancellation and a common verification runner. RPC 1 remains compatible; explicit offline migration handles storage/worker format 2.
- Added SDK/native runtime packaging and source-relocated installation checks, with root SDK/Zod pins and plugin/data paths preserved. Installed-plugin activation and paid-model work remain excluded.
- Four scripted host bindings exercise all 16 mock-backend MCP combinations. Mixed-worker scheduler/resource/correction tests and rich migration/evidence tests expand coverage beyond the original 41 regressions.
- Node 22 local full suite reached 69 passes. The final suite adds alias, resume-quiescence and complete resource-preflight checks (74 total); exact final results are recorded in the PR validation evidence after completion.
- Real model-free connections passed for OpenCode 1.18.30, Codex 0.146.0, Claude bundled 2.1.296 and Kilo 7.4.23. Default model resolution is not provider authentication or model-task validation.
- Actions run 38417136124 passed macOS automated/native checks. Windows functional command/recovery checks passed, while two installation errors identified Node 22 Unicode overwrite behavior. The fix replaces owned generated-skill targets and reduces repeated package copies. Final-source Windows/macOS checks remain mandatory.
- Issues MP-01 through MP-18 and goal/result comparison are recorded in docs/implementation-audit.md. Native IDE/desktop GUI and model-task behavior remain explicitly unconfirmed; no authored GUI was introduced.
