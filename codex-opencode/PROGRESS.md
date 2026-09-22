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
- 22 automated tests passed (21 in the complete suite plus the added installer-update regression). Tests use real temporary Git repositories and processes with a mock OpenCode HTTP server.
- Covered context exclusion, scope violations, actual nonzero exit codes versus model success claims, exact commit approvals, correction/integration conflict handling, dependency scheduling, global resource serialization and project mismatch.
- Covered dropped prompt responses, MCP disconnect, service restart, cancellation/restart, process-group termination, uncertain launch ownership, reboot-state reconciliation, interrupted result commits and recovery immediately after merge.
- Covered validation-time source edits, changed target commit/branch/working tree, ignored-file collision, task/command approval invalidation, UTF-8 response budgets/pagination/deltas and torn-journal recovery.
- Verified an installed bundle through a real MCP client after moving its source, using paths containing Korean text and spaces and no source `node_modules`.
- Verified marketplace replacement, retained prior releases, rollback after installation failure, and incompatible-format update deferral.
- Official `plugin-creator` validator and `skill-creator` validator passed. The repository's portable plugin validator also passed.
- Forward-tested the delegation Skill with a separate agent using stale approval, unknown test exit and recursive delegation permission scenarios. It refused stale finalization, distinguished reported success from observed evidence and requested the required correction/validation flow.
- Installed and updated the actual local Codex plugin from a copied user installation marketplace; the development checkout is not its runtime source.

### External validation status

- macOS OpenCode 1.18.30: local HTTP connection and default model resolution initially passed. Parallel live requests failed with provider authentication HTTP 401; no automatic fallback or success claim was made.
- The user removed that provider. A replacement model is awaiting explicit selection for a fresh live verification run.
- Windows live model access has not been tested.
- Git CLI publication was denied for its current account. The connected GitHub account is the repository owner with write permission; publication and remote CI verification are pending via that connection.
