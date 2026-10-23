"""Standard MCP transport only; vision and engine calls remain with the caller."""
from __future__ import annotations

import argparse
import json
import os

import anyio
from mcp.server.fastmcp import FastMCP, Image
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.stdio import stdio_server
from mcp.types import ToolAnnotations

from .service import Service, TOOLS
from .documents import ContractError


class PathAnalysisMCP(FastMCP):
    async def run_stdio_async(self):
        with os.fdopen(os.dup(0), "r", encoding="utf-8", errors="replace") as incoming, \
             os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1) as outgoing:
            async with stdio_server(anyio.wrap_file(incoming), anyio.wrap_file(outgoing)) as (reader, writer):
                await self._mcp_server.run(reader, writer, self._mcp_server.create_initialization_options())


DESCRIPTIONS = {
    "inspect_sheets": "Inspect PNG/JPG contact sheets. request: analysis_id, sheets[{id,path,columns,rows,valid_cells,margin?,padding?,cell_rects?}], output?. Cells are zero-based row-major; explicit valid cells required.",
    "read_frame": "Return one valid cell as MCP image content. request: manifest (document or workspace path), frame_ref, max_size?, output?. Caller interprets images; no vision model is invoked.",
    "calculate_path": "Calculate a relative 3D PathPlan. request: observations (ObservationSet or path), simplify_ratio?=.005, target_length?=10, previous_plan?, protected_point_ids?, output?. Caller supplies estimated XYZ in a common run frame. unresolved/excluded null positions split runs. mode=edit preserves frame and scale. Use existing_ref or protected_point_ids for all reused points.",
    "preview_path": "Render top/side PNG rows for independent runs. request: path_plan (document or path), size?, output?. Review geometry before requesting engine edits.",
    "plan_scene_edits": "Create neutral operations, never execute them. request: path_plan, snapshot (documents or paths), bindings? {desired_id: scoped_node_id}, remove_point_ids?, placement? (row-major affine 4x4), output?. Explicitly classify every existing point; bound points must be protected. Caller checks available engine capabilities and applies operations in dependency order.",
    "verify_scene_apply": "Check preflight or read-back from the caller's current SceneSnapshot. request: edit_plan, snapshot, apply_log? (documents or paths), output?. Creation receipts must contain node_id and externalRef. partial/stale/conflict/failed require a fresh plan, never blind replay.",
}


def create_server(workspace):
    service = Service(workspace)
    server = PathAnalysisMCP("path-analysis-tools", instructions=(
        "Independent path analysis. Start with server_info. inspect_sheets/read_frame provide images to YOUR vision model; "
        "supply ObservationSet XYZ estimates to calculate_path, review preview_path, obtain a scene snapshot via YOUR engine tools, "
        "then plan_scene_edits. This server never connects to Unity or AI providers. Preserve logical IDs and write output artifacts "
        "inside workspace. Apply only ready plans through available engine tools; record actual references; verify_scene_apply after application. "
        "Read the bundled schemas and workflow examples for exact v1 fields."), log_level="WARNING")

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
    def server_info() -> dict:
        """Describe capabilities, workspace and the host-neutral workflow."""
        return service.info()

    def register(name):
        def invoke(request: dict):
            try:
                result = service.call(name, request)
                return Image(data=result, format="png") if isinstance(result, bytes) else result
            except (ContractError, ValueError, OSError, KeyError, TypeError) as error:
                raise ToolError(json.dumps({"error": {"code": getattr(error, "code", "INVALID_REQUEST"),
                                                     "message": str(error)}}, ensure_ascii=False)) from error
        invoke.__name__ = name
        invoke.__doc__ = DESCRIPTIONS[name]
        server.add_tool(invoke, name=name, description=DESCRIPTIONS[name],
                        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))

    for name in TOOLS:
        register(name)
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    create_server(args.workspace).run(transport="stdio")


if __name__ == "__main__":
    main()
