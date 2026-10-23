import copy

from path_analysis_tools.geometry import IDENTITY

CAPABILITIES = ["create_node", "update_node", "set_order", "delete_node", "rebuild"]


def observations(positions=None, mode="create"):
    positions = positions if positions is not None else [[0, 0, 0], [0, 0, 5], [5, 2, 5]]
    samples = [{"id": f"sample-{i}", "status": "estimated", "position": position,
                "frame_refs": [f"sheet:{i}"], "protected": False} for i, position in enumerate(positions)]
    return {"schema_version": 1, "document_type": "ObservationSet", "analysis_id": "fixture", "frame_id": "root-local",
            "mode": mode, "targets": [{"id": "player", "label": "Player", "runs": [
                {"id": "continuous-a", "segments": [{"id": "move", "label": "Move", "samples": samples}]}]}]}


def samples(document):
    return document["targets"][0]["runs"][0]["segments"][0]["samples"]


def points(plan):
    return plan["targets"][0]["runs"][0]["segments"][0]["points"]


def empty_snapshot():
    return {"schema_version": 1, "document_type": "SceneSnapshot", "scene_id": "fixture-scene", "scope_id": "scope",
            "frame_id": "root-local", "frame_transform": IDENTITY[:], "capabilities": CAPABILITIES[:], "nodes": [], "orders": []}


def apply_operations(edit_plan, source, count=None, reference_style="uri"):
    """Fake caller: records engine receipts, not part of product implementation."""
    snapshot = copy.deepcopy(source)
    reference_offset = len(snapshot["nodes"])
    log = {"schema_version": 1, "document_type": "ApplyLog", "edit_plan_id": edit_plan["id"], "entries": []}
    for index, operation in enumerate(edit_plan["operations"][:count]):
        kind = operation["kind"]
        entry = {"operation_id": operation["id"], "status": "success"}
        if kind == "create_node":
            node = copy.deepcopy(operation["after"]["node"])
            reference = f"provider://node/{reference_offset + index}" if reference_style == "uri" else str(900000 + reference_offset + index)
            node["externalRef"] = reference
            snapshot["nodes"].append(node)
            entry.update(node_id=node["id"], externalRef=reference)
        elif kind == "update_node":
            node = operation["after"]["node"]
            current = next(n for n in snapshot["nodes"] if n["id"] == node["id"])
            current.update(copy.deepcopy(node))
        elif kind == "set_order":
            order = operation["after"]["order"]
            snapshot["orders"] = [o for o in snapshot["orders"] if (o["owner_id"], o["relation"]) != (order["owner_id"], order["relation"])]
            snapshot["orders"].append(copy.deepcopy(order))
        elif kind == "delete_node":
            snapshot["nodes"] = [n for n in snapshot["nodes"] if n["id"] != operation["after"]["absent_node_id"]]
        log["entries"].append(entry)
    return snapshot, log


def bindings_for(plan, snapshot):
    ids = {r["id"] for t in plan["targets"] for r in t["runs"]}
    ids |= {s["id"] for t in plan["targets"] for r in t["runs"] for s in r["segments"]}
    ids |= {p["id"] for t in plan["targets"] for r in t["runs"] for s in r["segments"] for p in s["points"]}
    return {n["id"]: n["id"] for n in snapshot["nodes"] if n["id"] in ids}
