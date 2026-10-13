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

Implementation started on `codex/video-tools-portable-gui`. No completion is claimed until each requirement has direct verification evidence. The existing untracked `codex-opencode/` folder is outside this change.

| Issue | Repair plan | Current evidence |
|---|---|---|
| SDK submodule discovery imported its optional CLI and aborted for missing `typer` | Exclude the unused `mcp.cli` namespace rather than add a product dependency | Native Mac shared-runtime build succeeded |
| Disabling all notebook tabs temporarily leaves no selected tab and triggers a Tk callback error | Ignore empty selection; make callback errors fail GUI acceptance | Fix applied; revalidation pending |
| Mac bundle inherited the console entrypoint's background-only metadata | Explicitly set GUI foreground metadata before final signing | Fix applied; revalidation pending |
| GUI self-test passed despite Tk callback exceptions | Record callback errors and assert none occurred | Fix applied; revalidation pending |
| Frozen MCP exited successfully but emitted an I/O-on-closed-stdout traceback | Give the SDK owned duplicate stdio handles and test clean shutdown | Fix applied; source and native revalidation pending |

| Windows CI read UTF-8 MCP/report output as cp1252 | Explicitly decode protocol and reports as UTF-8 | Fix applied; native CI revalidation pending |
| GUI acceptance manually invoked its polling callback and left a second timer chain behind | Use the same scheduled event flow as real GUI use | Fix applied; revalidation pending |

## Requirement evidence

| Mac Tk 9 uses precise touchpad events; scrolling over native controls can change values/tabs | Bind an application scroll tag before widget classes, handle precise deltas in OS adapter, add keyboard traversal | Fix applied; visual and native revalidation pending |

Pending implementation and verification.
