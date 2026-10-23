"""Single source for the distributed Draft 2020-12 document schemas."""
from __future__ import annotations

S = {"type": "string", "minLength": 1}
STRINGS = {"type": "array", "items": S, "uniqueItems": True}
NUMBER = {"type": "number"}
VEC = {"type": "array", "items": NUMBER, "minItems": 3, "maxItems": 3}
MATRIX = {"type": "array", "items": NUMBER, "minItems": 16, "maxItems": 16}


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def array(item, minimum=0):
    return {"type": "array", "items": item, "minItems": minimum}


def document(name, properties, required):
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"urn:path-analysis-tools:v1:{name}", "title": name,
            **obj({"schema_version": {"const": 1}, "document_type": {"const": name}, **properties},
                  ["schema_version", "document_type", *required])}


RECT = {"type": "array", "items": {"type": "integer", "minimum": 0}, "minItems": 4, "maxItems": 4}
CELL = obj({"index": {"type": "integer", "minimum": 0}, "ref": S, "rect": RECT,
            "timestamp": {"type": "number", "minimum": 0}}, ["index", "ref", "rect"])
SHEET = obj({"id": S, "path": S, "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
             "columns": {"enum": [2, 3]}, "rows": {"enum": [2, 3]},
             "margin": {"type": "integer", "minimum": 0}, "padding": {"type": "integer", "minimum": 0},
             "valid_cells": {"type": "array", "items": {"type": "integer", "minimum": 0}, "uniqueItems": True},
             "cells": array(CELL)}, ["id", "path", "sha256", "columns", "rows", "margin", "padding", "valid_cells", "cells"])
SAMPLE = obj({"id": S, "status": {"enum": ["estimated", "unresolved", "excluded"]},
              "position": {"anyOf": [VEC, {"type": "null"}]}, "frame_refs": STRINGS,
              "protected": {"type": "boolean"}, "existing_ref": S, "note": {"type": "string"}},
             ["id", "status", "position", "frame_refs"])
OBS_SEGMENT = obj({"id": S, "label": S, "samples": array(SAMPLE)}, ["id", "label", "samples"])
OBS_RUN = obj({"id": S, "segments": array(OBS_SEGMENT, 1)}, ["id", "segments"])
OBS_TARGET = obj({"id": S, "label": S, "runs": array(OBS_RUN, 1)}, ["id", "label", "runs"])
POINT = obj({"id": S, "sample_id": S, "position": VEC, "frame_refs": STRINGS,
             "protected": {"type": "boolean"}, "existing_ref": S, "note": {"type": "string"}},
            ["id", "sample_id", "position", "frame_refs", "protected"])
SEGMENT = obj({"id": S, "source_segment_id": S, "label": S, "points": array(POINT, 2)},
              ["id", "source_segment_id", "label", "points"])
NORMALIZATION = obj({"origin": VEC, "yaw_radians": NUMBER, "scale": {"type": "number", "exclusiveMinimum": 0}},
                    ["origin", "yaw_radians", "scale"])
RUN = obj({"id": S, "source_run_id": S, "segments": array(SEGMENT, 1), "normalization": NORMALIZATION},
          ["id", "source_run_id", "segments", "normalization"])
TARGET = obj({"id": S, "label": S, "runs": array(RUN)}, ["id", "label", "runs"])
EXCLUSION = obj({"target_id": S, "run_id": S, "segment_id": S, "sample_id": S,
                 "status": {"enum": ["unresolved", "excluded"]}, "frame_refs": STRINGS, "note": {"type": "string"}},
                ["target_id", "run_id", "segment_id", "sample_id", "status", "frame_refs"])
NODE = obj({"id": S, "externalRef": S, "kind": {"enum": ["run", "segment", "point"]},
            "parent_id": S, "label": S, "position": VEC, "owned": {"type": "boolean"},
            "external_reference_count": {"type": ["integer", "null"], "minimum": 0}},
           ["id", "externalRef", "kind", "parent_id", "label", "position", "owned", "external_reference_count"])
ORDER = obj({"owner_id": S, "relation": {"enum": ["segments", "points"]}, "items": STRINGS},
            ["owner_id", "relation", "items"])
# Expected state deliberately omits provider references for newly created nodes.
STATE_NODE = obj({k: v for k, v in NODE["properties"].items() if k != "externalRef"},
                 [k for k in NODE["required"] if k != "externalRef"])
OP = obj({"id": S, "kind": {"enum": ["create_node", "update_node", "set_order", "delete_node", "rebuild"]},
          "depends_on": STRINGS, "expected": {"type": "object"}, "after": {"type": "object"}},
         ["id", "kind", "depends_on", "expected", "after"])
ENTRY = obj({"operation_id": S, "status": {"enum": ["success", "failed"]}, "node_id": S,
             "externalRef": S, "message": {"type": "string"}}, ["operation_id", "status"])

SCHEMAS = {
    "SheetManifest": document("SheetManifest", {"analysis_id": S, "sheets": array(SHEET, 1)}, ["analysis_id", "sheets"]),
    "ObservationSet": document("ObservationSet", {"analysis_id": S, "frame_id": S, "mode": {"enum": ["create", "edit"]},
                                                 "targets": array(OBS_TARGET, 1)}, ["analysis_id", "frame_id", "mode", "targets"]),
    "PathPlan": document("PathPlan", {"analysis_id": S, "frame_id": S, "mode": {"enum": ["create", "edit"]},
                                     "settings": obj({"simplify_ratio": {"type": "number", "minimum": 0, "maximum": 1},
                                                      "target_length": {"type": "number", "exclusiveMinimum": 0}},
                                                     ["simplify_ratio", "target_length"]),
                                     "targets": array(TARGET, 1), "excluded": array(EXCLUSION), "warnings": array({"type": "string"})},
                         ["analysis_id", "frame_id", "mode", "settings", "targets", "excluded", "warnings"]),
    "SceneSnapshot": document("SceneSnapshot", {"scene_id": S, "scope_id": S, "frame_id": S, "frame_transform": MATRIX,
                                               "capabilities": STRINGS, "nodes": array(NODE), "orders": array(ORDER)},
                              ["scene_id", "scope_id", "frame_id", "frame_transform", "capabilities", "nodes", "orders"]),
    "EditPlan": document("EditPlan", {"id": S, "scene_id": S, "scope_id": S, "frame_id": S,
                                     "source_snapshot_hash": S, "source_snapshot": {"type": "object"},
                                     "path_plan": {"type": "object"}, "bindings": {"type": "object", "additionalProperties": S},
                                     "required_capabilities": STRINGS, "unsupported_capabilities": STRINGS,
                                     "operations": array(OP), "desired_nodes": array(STATE_NODE), "desired_orders": array(ORDER),
                                     "warnings": array({"type": "string"})},
                         ["id", "scene_id", "scope_id", "frame_id", "source_snapshot_hash", "source_snapshot", "path_plan",
                          "bindings", "required_capabilities", "unsupported_capabilities", "operations", "desired_nodes", "desired_orders", "warnings"]),
    "ApplyLog": document("ApplyLog", {"edit_plan_id": S, "entries": array(ENTRY)}, ["edit_plan_id", "entries"]),
}

SCHEMAS["EditPlan"]["properties"]["source_snapshot"] = SCHEMAS["SceneSnapshot"]
SCHEMAS["EditPlan"]["properties"]["path_plan"] = SCHEMAS["PathPlan"]
OP["oneOf"] = [
    {"properties": {"kind": {"const": kind}, "expected": before, "after": after}}
    for kind, before, after in [
        ("create_node", obj({"absent_node_id": S}, ["absent_node_id"]), obj({"node": STATE_NODE}, ["node"])),
        ("update_node", obj({"node": STATE_NODE}, ["node"]), obj({"node": STATE_NODE}, ["node"])),
        ("set_order", obj({"order": {"anyOf": [ORDER, {"type": "null"}]}}, ["order"]), obj({"order": ORDER}, ["order"])),
        ("delete_node", obj({"node": STATE_NODE}, ["node"]), obj({"absent_node_id": S}, ["absent_node_id"])),
        ("rebuild", obj({}), obj({"owner_ids": STRINGS}, ["owner_ids"])),
    ]
]
