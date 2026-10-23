"""The shared six-tool facade. All filesystem access is workspace scoped."""
from __future__ import annotations

import os
import tempfile

from . import __version__
from .documents import Workspace, fail, load, validate
from .paths import calculate_path
from .preview import preview_path
from .scene import plan_scene_edits, verify_scene_apply
from .sheets import inspect_sheets, read_frame

TOOLS = ("inspect_sheets", "read_frame", "calculate_path", "preview_path", "plan_scene_edits", "verify_scene_apply")


class Service:
    def __init__(self, workspace):
        self.workspace = Workspace(workspace)

    def _document(self, value, kind):
        document = load(self.workspace.resolve(value, existing=True)) if isinstance(value, str) else value
        return validate(document, kind)

    def info(self):
        return {"version": __version__, "schema_version": 1, "workspace": str(self.workspace.root),
                "tools": list(TOOLS), "scene_io": False, "model_io": False,
                "workflow": "inspect_sheets -> read_frame -> caller vision observations -> calculate_path -> preview_path -> caller scene snapshot -> plan_scene_edits -> caller engine execution -> verify_scene_apply"}

    def call(self, tool, request):
        if not isinstance(request, dict):
            fail("INVALID_REQUEST", "Tool input must be a JSON object.")
        if tool == "inspect_sheets":
            result = inspect_sheets(self.workspace, request["sheets"], request["analysis_id"])
        elif tool == "read_frame":
            result = read_frame(self.workspace, self._document(request["manifest"], "SheetManifest"),
                                request["frame_ref"], request.get("max_size", 1280))
        elif tool == "calculate_path":
            previous = self._document(request["previous_plan"], "PathPlan") if request.get("previous_plan") is not None else None
            result = calculate_path(self._document(request["observations"], "ObservationSet"), request.get("simplify_ratio", 0.005),
                                    request.get("target_length", 10), previous, request.get("protected_point_ids"))
        elif tool == "preview_path":
            result = preview_path(self._document(request["path_plan"], "PathPlan"), request.get("size", 1100))
        elif tool == "plan_scene_edits":
            result = plan_scene_edits(self._document(request["path_plan"], "PathPlan"), self._document(request["snapshot"], "SceneSnapshot"),
                                      request.get("bindings"), request.get("remove_point_ids"), request.get("placement"))
        elif tool == "verify_scene_apply":
            log = self._document(request["apply_log"], "ApplyLog") if request.get("apply_log") is not None else None
            result = verify_scene_apply(self._document(request["edit_plan"], "EditPlan"), self._document(request["snapshot"], "SceneSnapshot"), log)
        else:
            fail("UNKNOWN_TOOL", f"Unknown tool: {tool}")
        if "output" in request:
            if isinstance(result, bytes):
                destination = self.workspace.resolve(request["output"])
                if destination.suffix.lower() != ".png":
                    fail("INVALID_OUTPUT", "Image output must use .png.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination = self.workspace.resolve(request["output"])
                descriptor, temporary = tempfile.mkstemp(prefix=".path-analysis-", dir=destination.parent)
                try:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(result)
                    os.replace(temporary, destination)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
                return {"path": self.workspace.relative(destination), "mime_type": "image/png"}
            self.workspace.write(request["output"], result)
        return result
