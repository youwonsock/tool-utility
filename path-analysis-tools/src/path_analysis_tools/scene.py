"""Provider-neutral scene diff and read-back verification. No scene I/O."""
from __future__ import annotations

import copy

from .documents import fail, fingerprint, unique, validate
from .geometry import distance, transform
from .paths import stable_id, validate_path

# Scene engines commonly store float32 transforms. This is a numeric read-back
# allowance in frame units, independent of the path simplification error.
POSITION_TOLERANCE = 1e-5


def validate_snapshot(snapshot):
    validate(snapshot, "SceneSnapshot")
    nodes = {n["id"]: n for n in snapshot["nodes"]}
    unique([n["id"] for n in snapshot["nodes"]], "snapshot node IDs")
    unique([n["externalRef"] for n in snapshot["nodes"]], "external references")
    if snapshot["scope_id"] in nodes:
        fail("INVALID_SCOPE", "scope_id is the boundary, not an editable node.")
    transform([0, 0, 0], snapshot["frame_transform"])
    for node in nodes.values():
        if node["parent_id"] != snapshot["scope_id"] and node["parent_id"] not in nodes:
            fail("OUTSIDE_SCOPE", f"Unknown parent: {node['parent_id']}")
        visited = set()
        cursor = node
        while cursor["parent_id"] in nodes:
            if cursor["id"] in visited:
                fail("PARENT_CYCLE", "Snapshot contains a parent cycle.")
            visited.add(cursor["id"])
            cursor = nodes[cursor["parent_id"]]
    unique([(o["owner_id"], o["relation"]) for o in snapshot["orders"]], "order owners")
    for order in snapshot["orders"]:
        owner = nodes.get(order["owner_id"])
        expected_kind = "run" if order["relation"] == "segments" else "segment"
        item_kind = "segment" if order["relation"] == "segments" else "point"
        if owner is None or owner["kind"] != expected_kind:
            fail("INVALID_ORDER", "Order owner kind does not match its relation.")
        if any(item not in nodes or nodes[item]["kind"] != item_kind for item in order["items"]):
            fail("INVALID_ORDER", "Orders must refer to scoped nodes of the correct kind.")
    return snapshot


def state_node(node):
    return {k: copy.deepcopy(v) for k, v in node.items() if k != "externalRef"}


def _orders(snapshot):
    return {(o["owner_id"], o["relation"]): copy.deepcopy(o) for o in snapshot["orders"]}


def plan_scene_edits(path_plan, snapshot, bindings=None, remove_point_ids=None, placement=None):
    validate_path(path_plan)
    validate_snapshot(snapshot)
    bindings, removals = dict(bindings or {}), set(remove_point_ids or [])
    if remove_point_ids is not None:
        unique(remove_point_ids, "removed point IDs")
    if path_plan["frame_id"] != snapshot["frame_id"] and placement is None:
        fail("PLACEMENT_REQUIRED", "Different coordinate frames require explicit affine placement.")
    if placement is not None:
        transform([0, 0, 0], placement)
    old = {n["id"]: n for n in snapshot["nodes"]}
    desired = {key: state_node(n) for key, n in old.items()}
    orders = _orders(snapshot)
    points_by_id, roles = {}, {}
    for target in path_plan["targets"]:
        for run in target["runs"]:
            roles[run["id"]] = "run"
            for segment in run["segments"]:
                roles[segment["id"]] = "segment"
                for point in segment["points"]:
                    roles[point["id"]] = "point"
                    points_by_id[point["id"]] = point
    if any(key not in roles or node_id not in old for key, node_id in bindings.items()):
        fail("INVALID_BINDING", "Bindings must map desired logical IDs to explicit scoped node IDs.")
    unique(list(bindings.values()), "binding destinations")
    for logical_id, node_id in bindings.items():
        if old[node_id]["kind"] != roles[logical_id]:
            fail("INVALID_BINDING", "Bound node kind differs from the desired role.")
    for node_id in removals:
        if node_id not in old or old[node_id]["kind"] != "point":
            fail("INVALID_REMOVAL", "Only explicitly scoped point nodes may be removed.")
    bound_points = {value for key, value in bindings.items() if roles[key] == "point"}
    existing_points = {key for key, node in old.items() if node["kind"] == "point"}
    if bound_points & removals:
        fail("INVALID_REMOVAL", "A point cannot be both reused and removed.")
    if existing_points != bound_points | removals:
        fail("UNRESOLVED_BINDING", "Classify every scoped existing point as reused or explicitly removed.")
    for point_id, node_id in bindings.items():
        point = points_by_id.get(point_id)
        if point and not point["protected"]:
            fail("UNPROTECTED_BINDING", "Reused points must be protected during calculation.")
        if point and point.get("existing_ref") and point["existing_ref"] != old[node_id]["externalRef"]:
            fail("INVALID_BINDING", "Point existing_ref differs from its snapshot reference.")
    if set(roles) & (set(old) - set(bindings)):
        # An unbound desired ID must not accidentally replace an existing ID.
        collisions = {key for key in roles if key in old and bindings.get(key) != key}
        if collisions:
            fail("ID_COLLISION", "Explicitly bind desired IDs already present in the scene.")
    operations, create_ids, update_ids, warnings = [], {}, [], []
    managed_orders = set()

    def add(kind, expected, after, dependencies=()):
        operation = {"id": stable_id(fingerprint(snapshot), kind, fingerprint(expected), fingerprint(after)),
                     "kind": kind, "depends_on": list(dict.fromkeys(dependencies)),
                     "expected": expected, "after": after}
        operations.append(operation)
        return operation["id"]

    def ensure(logical_id, kind, label, parent_id, position):
        node_id = bindings.get(logical_id, logical_id)
        if logical_id in bindings:
            node = desired[node_id]
            if kind == "point" and (distance(node["position"], position) > POSITION_TOLERANCE or node["parent_id"] != parent_id):
                after = copy.deepcopy(node)
                after.update(position=position, parent_id=parent_id)
                update_ids.append(add("update_node", {"node": copy.deepcopy(node)}, {"node": after},
                                      [create_ids[parent_id]] if parent_id in create_ids else []))
                desired[node_id] = after
        else:
            if node_id in desired:
                fail("ID_COLLISION", "New desired ID collides with an existing node.")
            node = {"id": node_id, "kind": kind, "label": label, "parent_id": parent_id,
                    "position": position, "owned": True, "external_reference_count": 0}
            desired[node_id] = node
            create_ids[node_id] = add("create_node", {"absent_node_id": node_id}, {"node": node},
                                      [create_ids[parent_id]] if parent_id in create_ids else [])
        return node_id

    for target in path_plan["targets"]:
        for run in target["runs"]:
            run_id = ensure(run["id"], "run", target["label"], snapshot["scope_id"], [0, 0, 0])
            segment_ids = []
            for segment in run["segments"]:
                segment_id = ensure(segment["id"], "segment", segment["label"], run_id, [0, 0, 0])
                segment_ids.append(segment_id)
                point_ids = []
                for index, point in enumerate(segment["points"]):
                    position = transform(point["position"], placement) if placement is not None else point["position"][:]
                    label = "PathPointStart" if index == 0 else "PathPointEnd" if index == len(segment["points"]) - 1 else f"PathPoint_{index:03d}"
                    point_ids.append(ensure(point["id"], "point", label, segment_id, position))
                orders[(segment_id, "points")] = {"owner_id": segment_id, "relation": "points", "items": point_ids}
                managed_orders.add((segment_id, "points"))
            orders[(run_id, "segments")] = {"owner_id": run_id, "relation": "segments", "items": segment_ids}
            managed_orders.add((run_id, "segments"))

    deletions = []
    for node_id in sorted(removals):
        for key in managed_orders:
            orders[key]["items"] = [item for item in orders[key]["items"] if item != node_id]
        node = old[node_id]
        has_children = any(n["parent_id"] == node_id for n in old.values())
        shared = sum(node_id in order["items"] for order in snapshot["orders"]) > 1
        still_referenced = any(node_id in order["items"] for order in orders.values())
        if node["owned"] and node["external_reference_count"] == 0 and not has_children and not shared and not still_referenced:
            deletions.append(node_id)
            del desired[node_id]
        else:
            warnings.append(f"DETACH_ONLY: {node_id} has shared/unknown ownership, preserved references or children.")

    structure_dependencies = [*create_ids.values(), *update_ids]
    # All creates and geometry updates finish before any reference list changes.
    order_operations = []
    original_orders = _orders(snapshot)
    for key, order in sorted(orders.items()):
        before = original_orders.get(key)
        if before != order:
            order_operations.append(add("set_order", {"order": before}, {"order": order}, structure_dependencies))
    delete_operations = []
    for node_id in deletions:
        delete_operations.append(add("delete_node", {"node": state_node(old[node_id])}, {"absent_node_id": node_id},
                                     [*structure_dependencies, *order_operations]))
    if operations:
        owner_ids = sorted({o["owner_id"] for o in orders.values()})
        add("rebuild", {}, {"owner_ids": owner_ids}, [op["id"] for op in operations])
    required = sorted({op["kind"] for op in operations})
    result = {"schema_version": 1, "document_type": "EditPlan",
              "id": stable_id(fingerprint(snapshot), fingerprint(path_plan), fingerprint(bindings), fingerprint(sorted(removals)), fingerprint(placement)),
              "scene_id": snapshot["scene_id"], "scope_id": snapshot["scope_id"], "frame_id": snapshot["frame_id"],
              "source_snapshot_hash": fingerprint(snapshot), "source_snapshot": copy.deepcopy(snapshot),
              "path_plan": copy.deepcopy(path_plan), "bindings": bindings,
              "required_capabilities": required, "unsupported_capabilities": sorted(set(required) - set(snapshot["capabilities"])),
              "operations": operations, "desired_nodes": sorted(desired.values(), key=lambda n: n["id"]),
              "desired_orders": [value for _, value in sorted(orders.items())], "warnings": warnings}
    return validate(result, "EditPlan")


def _snapshot_state(snapshot):
    return {"nodes": sorted([state_node(n) for n in snapshot["nodes"]], key=lambda n: n["id"]),
            "orders": sorted(snapshot["orders"], key=lambda o: (o["owner_id"], o["relation"]))}


def _same_state(actual, expected):
    if actual["orders"] != expected["orders"] or len(actual["nodes"]) != len(expected["nodes"]):
        return False
    for left, right in zip(actual["nodes"], expected["nodes"]):
        if {k: v for k, v in left.items() if k != "position"} != {k: v for k, v in right.items() if k != "position"}:
            return False
        if distance(left["position"], right["position"]) > POSITION_TOLERANCE:
            return False
    return True


def verify_scene_apply(edit_plan, snapshot, apply_log=None):
    validate(edit_plan, "EditPlan")
    validate_snapshot(edit_plan["source_snapshot"])
    validate_path(edit_plan["path_plan"])
    validate_snapshot(snapshot)
    if fingerprint(edit_plan["source_snapshot"]) != edit_plan["source_snapshot_hash"]:
        fail("INVALID_EDIT_PLAN", "Embedded source snapshot does not match its fingerprint.")
    if any(snapshot[key] != edit_plan[key] for key in ("scene_id", "scope_id", "frame_id")):
        fail("SCOPE_MISMATCH", "Snapshot belongs to a different scene, scope or coordinate frame.")
    operations = {op["id"]: op for op in edit_plan["operations"]}
    unique(list(op["id"] for op in edit_plan["operations"]), "operation IDs")
    seen = set()
    for operation in edit_plan["operations"]:
        if not set(operation["depends_on"]) <= seen:
            fail("INVALID_EDIT_PLAN", "Operations must be topologically ordered.")
        seen.add(operation["id"])
    log = apply_log or {"schema_version": 1, "document_type": "ApplyLog", "edit_plan_id": edit_plan["id"], "entries": []}
    validate(log, "ApplyLog")
    if log["edit_plan_id"] != edit_plan["id"]:
        fail("LOG_MISMATCH", "ApplyLog belongs to another EditPlan.")
    unique([e["operation_id"] for e in log["entries"]], "logged operation IDs")
    successful, failures, receipts = set(), [], {}
    for entry in log["entries"]:
        operation = operations.get(entry["operation_id"])
        if operation is None:
            fail("UNKNOWN_OPERATION", "ApplyLog contains an unknown operation.")
        if not set(operation["depends_on"]) <= successful:
            fail("DEPENDENCY_VIOLATION", "Log entries must satisfy operation dependencies.")
        if failures:
            fail("INVALID_APPLY_LOG", "Stop after a failed operation; replan from a fresh snapshot.")
        if entry["status"] == "failed":
            failures.append(operation["id"])
            continue
        if operation["kind"] == "create_node":
            node_id = operation["after"]["node"]["id"]
            if entry.get("node_id") != node_id or not entry.get("externalRef"):
                fail("MISSING_RECEIPT", "Successful creation requires its logical node_id and actual externalRef.")
            receipts[node_id] = entry["externalRef"]
        successful.add(operation["id"])
    unique(list(receipts.values()), "created external references")
    if set(receipts.values()) & {n["externalRef"] for n in edit_plan["source_snapshot"]["nodes"]}:
        fail("REFERENCE_COLLISION", "A created node cannot reuse an existing external reference.")
    current = {n["id"]: n for n in snapshot["nodes"]}
    expected = {n["id"]: state_node(n) for n in edit_plan["source_snapshot"]["nodes"]}
    expected_orders = _orders(edit_plan["source_snapshot"])
    for operation in edit_plan["operations"]:
        if operation["id"] not in successful:
            continue
        if operation["kind"] in ("create_node", "update_node"):
            node = operation["after"]["node"]
            expected[node["id"]] = copy.deepcopy(node)
        elif operation["kind"] == "delete_node":
            expected.pop(operation["after"]["absent_node_id"], None)
        elif operation["kind"] == "set_order":
            order = operation["after"]["order"]
            expected_orders[(order["owner_id"], order["relation"])] = copy.deepcopy(order)
    conflicts = []
    if snapshot["frame_transform"] != edit_plan["source_snapshot"]["frame_transform"]:
        conflicts.append("Coordinate frame transform changed.")
    expected_state = {"nodes": sorted(expected.values(), key=lambda n: n["id"]),
                      "orders": [o for _, o in sorted(expected_orders.items())]}
    if not _same_state(_snapshot_state(snapshot), expected_state):
        conflicts.append("Read-back geometry, hierarchy, ownership or reference order differs from successful receipts.")
    for node_id, external_ref in receipts.items():
        if node_id in expected and (node_id not in current or current[node_id]["externalRef"] != external_ref):
            conflicts.append(f"Created reference mismatch: {node_id}")
    for node in edit_plan["source_snapshot"]["nodes"]:
        if node["id"] in expected and (node["id"] not in current or current[node["id"]]["externalRef"] != node["externalRef"]):
            conflicts.append(f"Existing reference changed: {node['id']}")
    unsupported = sorted(set(edit_plan["required_capabilities"]) - set(snapshot["capabilities"]))
    complete = len(successful) == len(operations)
    desired_state = {"nodes": edit_plan["desired_nodes"], "orders": edit_plan["desired_orders"]}
    if complete and not _same_state(_snapshot_state(snapshot), desired_state):
        conflicts.append("Final state does not match the desired scene.")
    if conflicts:
        status = "conflict" if log["entries"] else "stale"
    elif unsupported:
        status = "unsupported"
    elif failures:
        status = "partial" if successful else "failed"
    elif complete:
        status = "complete"
    elif successful:
        status = "partial"
    else:
        status = "ready"
    return {"schema_version": 1, "status": status, "can_apply": status == "ready", "requires_replan": status in ("partial", "failed", "stale", "conflict"),
            "successful_operations": len(successful), "total_operations": len(operations),
            "unsupported_capabilities": unsupported, "conflicts": conflicts,
            "created_bindings": receipts, "pending_operations": [op for op in operations if op not in successful]}
