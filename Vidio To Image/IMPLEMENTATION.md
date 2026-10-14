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
| Runtime packaging lacked explicit Tcl/Tk notices | Copy toolkit license terms alongside package/Python/FFmpeg notices | Native package license inventory check |

## Requirement comparison and evidence

| Accepted goal | Implemented behavior | Direct verification |
|---|---|---|
| No end-user runtime installation | ZIP contains native GUI/MCP and their runtime/media resources | `verify_portable.py` relocates the package and removes host executable search paths |
| Common processing code and job lifecycle | `VideoService` owns common operations; separate per-process managers | Core import isolation, snapshot, cancellation and media regression tests |
| One cross-platform GUI with full editing | Shared extraction/edit tabs; numeric crop, rotation/flips/resize/speed/mute/CRF | GUI acceptance executes extraction, JPEG grid, trim/rotate/resize/speed/mute and crop/flips/CRF |
| Reliable GUI layout and input | Platform font/theme, precise scrolling, fixed progress/actions | 760×760 / 1100×900 bounds assertions plus native Mac visual audit |
| Independent packaged MCP with the original nine tools | Console entrypoint shares the GUI bundle runtime | Real SDK stdio workflow covers tool list, inspection, image output, edits, cancellation, workspace denial and clean exit |
| GUI and MCP yield equivalent results | Same requests call the same service | Relocated package compares exact frame pixels, edit dimensions, duration, FPS and audio |
| Windows settings compatibility and Mac migration | Existing keys preserved; edit settings added; OS-native storage | Round-trip and legacy Mac migration tests; packaged GUI saves and reopens editing settings |
| Portable client configuration | GUI generates command/args for native server; temporary Mac path rejected | GUI configuration generation test and portable runtime configuration tests |
| Version/provenance/license records | Python 3.14.6, PyInstaller 6.22.3, locked dependencies, manifest and notices | Build manifest, codec checks, SHA-256 sidecar, package license inventory |
| Iterate on actual problems and validate all native targets | Each failure above was repaired and rerun | CI runs source and relocated packages on Windows / Mac arm64 / Mac Intel; Linux runs source GUI under Xvfb |

Completed cross-platform baseline: [run 38366703278](https://github.com/youwonsock/tool-utility/actions/runs/38366703278), code `ad3dcfbe66d51ed8221f924bdf7afb95356a2818`: Windows, macOS arm64, macOS Intel and Linux all succeeded. Each native target passed source regression, native build/signature where applicable and relocated GUI/media/MCP acceptance.

Final verified code: `72c7c23d9eb62db576e97b8d7b0813af6dd4ba27`, [run 38375537712](https://github.com/youwonsock/tool-utility/actions/runs/38375537712). All four targets passed all 50 source tests, including GUI acceptance. Windows, macOS arm64 and macOS Intel also passed native packaging and the expanded relocated GUI/MCP acceptance gates.

| Target | Source regression | Native package and relocated acceptance | Release artifact |
|---|---|---|---|
| Windows x64 | 50 passed | Passed | [Windows ZIP and evidence](https://github.com/youwonsock/tool-utility/actions/runs/38375537712/artifacts/11801386179) |
| macOS arm64 | 50 passed | Passed | [Apple Silicon ZIP and evidence](https://github.com/youwonsock/tool-utility/actions/runs/38375537712/artifacts/11801291223) |
| macOS x86_64 | 50 passed | Passed | [Intel ZIP and evidence](https://github.com/youwonsock/tool-utility/actions/runs/38375537712/artifacts/11801276856) |
| Linux | 50 passed under Xvfb | Source development target | Source regression in the linked CI run |

Each native artifact contains its release ZIP, SHA-256 sidecar, `portable-verification.json` and `gui-portable.json`. All three reports confirm identical GUI/MCP frame pixels and matching edit geometry, duration, FPS and audio, plus GUI configuration generation, cancellation and saved-setting restoration. Release manifests identify the exact verified commit with `source_dirty=false`.

On continuation, all three CI artifacts were downloaded, their artifact digests and inner ZIP checksums were verified, and their source manifests and acceptance reports were inspected. The verified ZIPs are available in local `dist/`; the arm64 app was extracted with `ditto` and passed `codesign --verify --deep --strict`. Per-target CI reports are preserved locally under `test-output/ci-38375537712/`.

## Distribution boundary

This is internal portable distribution. macOS ad-hoc signing permits the application's initial per-app OS approval; no global protection changes are performed. Developer ID notarization, DMG/store delivery and the unrelated delegation plugin remain outside this change.
