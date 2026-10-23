"""Observation-to-control-point calculation, without model or engine access."""
from __future__ import annotations

import copy
import json
import math
import uuid

from .documents import fail, unique, validate
from .geometry import distance, length, simplify


def stable_id(*parts):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(parts, ensure_ascii=False, separators=(",", ":"))))


def iter_paths(plan):
    for target in plan["targets"]:
        for run in target["runs"]:
            for segment in run["segments"]:
                yield target, run, segment


def validate_path(plan):
    validate(plan, "PathPlan")
    ids = []
    for target in plan["targets"]:
        ids.append(target["id"])
        for run in target["runs"]:
            ids.append(run["id"])
            last = None
            for segment in run["segments"]:
                ids.append(segment["id"])
                if length(segment["points"]) <= 0:
                    fail("ZERO_LENGTH", f"Segment {segment['id']} has no measurable movement.")
                if last is not None and distance(last, segment["points"][0]["position"]) > 1e-7:
                    fail("DISCONTINUOUS_RUN", "Disconnected segments must be separate runs.")
                last = segment["points"][-1]["position"]
                ids.extend(p["id"] for p in segment["points"])
    unique(ids, "path IDs")
    return plan


def calculate_path(observations, simplify_ratio=0.005, target_length=10.0, previous_plan=None, protected_point_ids=None):
    validate(observations, "ObservationSet")
    if type(simplify_ratio) not in (int, float) or not math.isfinite(simplify_ratio) or not 0 <= simplify_ratio <= 1:
        fail("INVALID_SETTINGS", "simplify_ratio must be in 0..1.")
    if type(target_length) not in (int, float) or not math.isfinite(target_length) or target_length <= 0:
        fail("INVALID_SETTINGS", "target_length must be positive and finite.")
    previous = {}
    if previous_plan is not None:
        validate_path(previous_plan)
        if previous_plan["analysis_id"] != observations["analysis_id"]:
            fail("ANALYSIS_MISMATCH", "previous_plan must belong to the same analysis.")
        for target, run, segment in iter_paths(previous_plan):
            for point in segment["points"]:
                key = (target["id"], run["source_run_id"], segment["source_segment_id"], point["sample_id"])
                if key in previous:
                    fail("AMBIGUOUS_ID", "Previous sample identity is ambiguous.")
                previous[key] = point
    protected_ids = set(protected_point_ids or [])
    if protected_ids and not protected_ids <= {p["id"] for p in previous.values()}:
        fail("UNKNOWN_PROTECTED_POINT", "Protected point IDs require their previous plan.")
    result = {"schema_version": 1, "document_type": "PathPlan", "analysis_id": observations["analysis_id"],
              "mode": observations["mode"], "frame_id": observations["frame_id"],
              "settings": {"simplify_ratio": simplify_ratio, "target_length": target_length},
              "targets": [], "excluded": [], "warnings": []}
    unique([t["id"] for t in observations["targets"]], "target IDs")
    for target in observations["targets"]:
        out_target = {"id": target["id"], "label": target["label"], "runs": []}
        run_metrics = {}
        unique([r["id"] for r in target["runs"]], "source run IDs")
        for run in target["runs"]:
            unique([s["id"] for s in run["segments"]], "source segment IDs")
            chunks, active_segments = [], []
            for segment in run["segments"]:
                unique([s["id"] for s in segment["samples"]], "sample IDs within a segment")
                points = []

                def finish_segment():
                    nonlocal points
                    if not points:
                        return
                    points[0]["protected"] = points[-1]["protected"] = True
                    if length(points) > 0:
                        active_segments.append({"id": stable_id("segment", observations["analysis_id"], target["id"], run["id"], segment["id"], points[0]["sample_id"]),
                                                "source_segment_id": segment["id"], "label": segment["label"], "points": points})
                    else:
                        result["warnings"].append(f"NO_MOVEMENT: {target['id']}/{run['id']}/{segment['id']}")
                    points = []

                for sample in segment["samples"]:
                    if sample["status"] != "estimated":
                        if sample["position"] is not None:
                            fail("INVALID_OBSERVATION", "unresolved/excluded positions must be null.")
                        finish_segment()
                        if active_segments:
                            chunks.append(active_segments)
                            active_segments = []
                        result["excluded"].append({"target_id": target["id"], "run_id": run["id"], "segment_id": segment["id"],
                                                   "sample_id": sample["id"], "status": sample["status"],
                                                   "frame_refs": sample["frame_refs"], "note": sample.get("note", "")})
                        continue
                    if sample["position"] is None:
                        fail("INVALID_OBSERVATION", "estimated positions require finite XYZ.")
                    key = (target["id"], run["id"], segment["id"], sample["id"])
                    old = previous.get(key)
                    point_id = old["id"] if old else stable_id("point", observations["analysis_id"], *key)
                    point = {"id": point_id, "sample_id": sample["id"], "position": list(sample["position"]),
                             "frame_refs": sample["frame_refs"],
                             "protected": bool(sample.get("protected") or sample.get("existing_ref") or point_id in protected_ids
                                               or (old and (old.get("existing_ref") or old.get("protected"))))}
                    if sample.get("existing_ref") or (old and old.get("existing_ref")):
                        point["existing_ref"] = sample.get("existing_ref", old.get("existing_ref") if old else None)
                    if sample.get("note"):
                        point["note"] = sample["note"]
                    if points and distance(points[-1]["position"], point["position"]) <= 1e-10 and not point["protected"]:
                        continue
                    points.append(point)
                finish_segment()
            if active_segments:
                chunks.append(active_segments)
            for chunk in chunks:
                previous_end = None
                for segment in chunk:
                    if previous_end is not None and distance(previous_end, segment["points"][0]["position"]) > 1e-7:
                        fail("DISCONTINUOUS_RUN", "Adjacent action segments must share a boundary position; otherwise split the source run.")
                    previous_end = segment["points"][-1]["position"]
                total = sum(length(s["points"]) for s in chunk)
                origin = chunk[0]["points"][0]["position"][:]
                theta = 0
                for point in (p for s in chunk for p in s["points"]):
                    dx, dz = point["position"][0] - origin[0], point["position"][2] - origin[2]
                    if math.hypot(dx, dz) > 1e-10:
                        theta = math.atan2(dx, dz)
                        break
                for segment in chunk:
                    segment["points"] = simplify(segment["points"], total * simplify_ratio)
                first = chunk[0]["points"][0]
                run_id = stable_id("run", observations["analysis_id"], target["id"], run["id"], chunk[0]["source_segment_id"], first["sample_id"])
                run_metrics[run_id] = (total, origin, theta)
                out_target["runs"].append({"id": run_id,
                                           "source_run_id": run["id"], "segments": chunk,
                                           "normalization": {"origin": [0, 0, 0], "yaw_radians": 0, "scale": 1}})
        if observations["mode"] == "create" and out_target["runs"]:
            maximum = max(run_metrics[r["id"]][0] for r in out_target["runs"])
            scale = target_length / maximum
            for run in out_target["runs"]:
                _, origin, theta = run_metrics[run["id"]]
                all_points = [p for s in run["segments"] for p in s["points"]]
                cosine, sine = math.cos(theta), math.sin(theta)
                for point in all_points:
                    x, y, z = [v - o for v, o in zip(point["position"], origin)]
                    point["position"] = [scale * (cosine * x - sine * z), scale * y, scale * (sine * x + cosine * z)]
                run["normalization"] = {"origin": origin, "yaw_radians": -theta, "scale": scale}
        result["targets"].append(out_target)
    return validate_path(result)
