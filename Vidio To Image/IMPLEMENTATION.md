# Portable GUI/MCP implementation and verification

## Accepted requirements

1. Windows x64 and macOS arm64/x86_64 portable packages, no Python/FFmpeg/MCP installation or first-run download.
2. Independent GUI and stdio MCP entrypoints sharing runtime files and all media processing/job code.
3. One GUI implementation with extraction/grid and trim/crop/rotate/flip/resize/speed/mute/CRF controls.
4. Core code imports neither Tkinter nor MCP SDK; MCP workspace boundaries remain at its adapter.
5. OS adapters handle settings, presentation, process ownership and bundle locations.
6. Preserve the nine MCP tools, source entrypoints, image sampling semantics and overwrite/cancel protections.
7. macOS legacy settings migrate; current Windows settings stay compatible; editing settings persist.
8. GUI generates client JSON for the actual portable server path, including relocation/translocation handling.
9. Pin release toolchain/dependencies and record binary provenance, capabilities, licenses and matching-source information.
10. Validate source, GUI layout/behavior, isolated relocated packages and native Windows/macOS CI. macOS internal distribution permits initial OS approval; no notarization/DMG/store distribution.

## Implementation sequence

Portable packaging feasibility → shared service/platform adapters → GUI editing → package and cross-platform verification.

## Issue / repair / verification log

Changes are isolated to the video tool, its documentation and `.github/workflows/video-tools.yml`. Untracked `codex-opencode/` and `.github/workflows/codex-opencode.yml` belong to other work and are preserved.

| Discovered problem | Repair | Verification |
|---|---|---|
| Optional SDK CLI import aborted PyInstaller discovery for missing typer | Exclude unused `mcp.cli` | Shared native runtime builds on Windows, Mac arm64 and Intel |
| Disabled notebook tabs temporarily had an empty selection | Guard empty selection; fail acceptance on callback errors | Source GUI acceptance and packaged GUI acceptance |
| Mac app inherited MCP console's background-only flag | Explicit foreground Info.plist before signing | codesign verification and actual Mac foreground screenshots |
| GUI tests hid callback failures and duplicated the polling timer | Capture exceptions and use scheduled probe/poll flow | Clean 48-test source run on all four CI OS targets |
| Frozen MCP shutdown closed process stdio and printed a traceback | SDK transport owns duplicate UTF-8 handles | Native MCP initialization/clean-shutdown test |
| Windows decoded UTF-8 reports/protocol as cp1252 | Explicit UTF-8 in reports and subprocess text decoding | Windows native CI passed after correction |
| Tk 9 precise touchpad events were unhandled; controls could change while scrolling | First application bindtag, precise-scroll adapter, notebook keyboard traversal | Regression events and actual Mac scrolling across both tabs |
| Windows packaging omitted Python and Tcl notices despite passing media checks | Search Python's installed prefix, preserve the exact Tcl release notice offline, fail builds and acceptance on missing notices | Windows/framework-layout regression tests and mandatory native package notice inventory |
| Image parity compared one pixel per frame and could miss geometry or other pixel differences | Compare ordered frame signatures containing dimensions and the full RGB pixel digest | Corner-pixel, frame-count, geometry and PNG-metadata regressions |
| Source provenance missed staged changes and new source files | Inspect Git status for the video source directory, including staged and untracked files | Isolated Git fixtures cover staged changes, new source files, ignored build outputs and unrelated sibling work |

## Requirement comparison and evidence

| Accepted goal | Implemented behavior | Direct verification |
|---|---|---|
| No end-user runtime installation | ZIP contains native GUI/MCP and their runtime/media resources | `verify_portable.py` relocates the package and removes host executable search paths |
| Common processing code and job lifecycle | `VideoService` owns common operations; separate per-process managers | Core import isolation, snapshot, cancellation and media regression tests |
| One cross-platform GUI with full editing | Shared extraction/edit tabs; numeric crop, rotation/flips/resize/speed/mute/CRF | GUI acceptance executes extraction, JPEG grid, trim/rotate/resize/speed/mute and crop/flips/CRF |
| Reliable GUI layout and input | Platform font/theme, precise scrolling, fixed progress/actions | 760×760 / 1100×900 bounds assertions plus native Mac visual audit |
| Independent packaged MCP with the original nine tools | Console entrypoint shares the GUI bundle runtime | Real SDK stdio workflow covers tool list, inspection, image output, edits, cancellation, workspace denial and clean exit |
| GUI and MCP yield equivalent results | Same requests call the same service | Relocated package compares frame count, dimensions and full RGB digests, plus edit dimensions, duration, FPS and audio |
| Windows settings compatibility and Mac migration | Existing keys preserved; edit settings added; OS-native storage | Round-trip and legacy Mac migration tests; packaged GUI saves and reopens editing settings |
| Portable client configuration | GUI generates command/args for native server; temporary Mac path rejected | GUI configuration generation test and portable runtime configuration tests |
| Version/provenance/license records | Python 3.14.6, PyInstaller 6.22.3, locked dependencies, manifest and notices | Build manifest, codec checks, SHA-256 sidecar, package license inventory |
| Iterate on actual problems and validate all native targets | Each failure above was repaired and rerun | CI runs source and relocated packages on Windows / Mac arm64 / Mac Intel; Linux runs source GUI under Xvfb |

Completed cross-platform baseline: [run 38366703278](https://github.com/youwonsock/tool-utility/actions/runs/38366703278), code `ad3dcfbe66d51ed8221f924bdf7afb95356a2818`: Windows, macOS arm64, macOS Intel and Linux all succeeded. Each native target passed source regression, native build/signature where applicable and relocated GUI/media/MCP acceptance.

Media behavior baseline: `72c7c23d9eb62db576e97b8d7b0813af6dd4ba27`, [run 38375537712](https://github.com/youwonsock/tool-utility/actions/runs/38375537712). All four targets passed all 50 source tests, including GUI acceptance. Each native target also passed the expanded relocated GUI/MCP acceptance gates and 20 packaged media/MCP tests. Inspecting the downloaded artifacts during continuation then exposed the missing Windows Python/Tcl notices, so this baseline alone is insufficient for release completion.

Latest validation and release artifacts are available from [PR #6 checks](https://github.com/youwonsock/tool-utility/pull/6/checks) and the [main branch workflow](https://github.com/youwonsock/tool-utility/actions/workflows/video-tools.yml?query=branch%3Amain). The final gates are:

| Target | Required source regression | Required native package acceptance | Artifact name |
|---|---|---|---|
| Windows x64 | All 57 tests | Relocated GUI/MCP, 20 media/MCP tests, notice inventory | `video-tools-windows-latest` |
| macOS arm64 | All 57 tests | Relocated GUI/MCP, 20 media/MCP tests, notice inventory, signature | `video-tools-macos-15` |
| macOS x86_64 | All 57 tests | Relocated GUI/MCP, 20 media/MCP tests, notice inventory, signature | `video-tools-macos-15-intel` |
| Linux | All 57 tests under Xvfb | Source development target | Source regression in the linked CI run |

Each native artifact contains its release ZIP, SHA-256 sidecar, `portable-verification.json` and `gui-portable.json`. Acceptance requires identical ordered GUI/MCP frame counts, dimensions and full RGB pixel digests, and matching edit geometry, duration, FPS and audio, plus GUI configuration generation, cancellation and saved-setting restoration. It also requires nonempty Python, Tcl, Tk and FFmpeg notices; the runtime manifest records both Tcl and Tk versions. Release manifests identify the exact source commit with `source_dirty=false`; staged changes and untracked video source files mark a developer build dirty, while ignored build outputs and unrelated sibling projects do not.

On continuation, the baseline artifacts' digests and ZIP checksums, source manifests and acceptance reports were checked. The arm64 app was extracted with `ditto`, passed `codesign --verify --deep --strict` and passed GUI acceptance locally. Baseline evidence is preserved under `test-output/ci-38375537712/`; only artifacts that also pass the mandatory notice inventory should be distributed.

## Distribution boundary

This is internal portable distribution. macOS ad-hoc signing permits the application's initial per-app OS approval; no global protection changes are performed. Developer ID notarization, DMG/store delivery and the unrelated delegation plugin remain outside this change.
