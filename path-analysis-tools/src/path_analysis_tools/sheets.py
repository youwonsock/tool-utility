"""Contact sheet pixel geometry, with explicit valid cells and source hashes."""
from __future__ import annotations

import hashlib
import io
import math

from PIL import Image

from .documents import fail, unique, validate

MAX_PIXELS = 67_108_864


def validate_manifest(manifest):
    validate(manifest, "SheetManifest")
    unique([s["id"] for s in manifest["sheets"]], "sheet IDs")
    for sheet in manifest["sheets"]:
        count = sheet["columns"] * sheet["rows"]
        if any(not 0 <= index < count for index in sheet["valid_cells"]):
            fail("INVALID_GRID", "Manifest valid cells exceed the grid.")
        indices = [cell["index"] for cell in sheet["cells"]]
        if sorted(indices) != sorted(sheet["valid_cells"]):
            fail("INVALID_GRID", "Manifest cells must exactly match explicit valid_cells.")
        for cell in sheet["cells"]:
            if cell["ref"] != f"{sheet['id']}:{cell['index']}" or min(cell["rect"][2:]) <= 0:
                fail("INVALID_GRID", "Invalid manifest frame reference or rectangle.")
    return manifest


def _integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        fail("INVALID_GRID", f"{name} must be an integer >= {minimum}.")
    return value


def inspect_sheets(workspace, sheets, analysis_id):
    if not sheets or not isinstance(analysis_id, str) or not analysis_id:
        fail("INVALID_GRID", "Provide analysis_id and at least one sheet.")
    result = {"schema_version": 1, "document_type": "SheetManifest", "analysis_id": analysis_id, "sheets": []}
    unique([s["id"] for s in sheets], "sheet IDs")
    for spec in sheets:
        source = workspace.resolve(spec["path"], existing=True)
        if source.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            fail("INVALID_IMAGE", "Only PNG/JPG sheets are supported.")
        with Image.open(source) as image:
            width, height = image.size
            if width * height > MAX_PIXELS:
                fail("IMAGE_TOO_LARGE", "A sheet may contain at most 64 megapixels.")
        columns, rows = spec["columns"], spec["rows"]
        if type(columns) is not int or type(rows) is not int or columns not in (2, 3) or rows not in (2, 3):
            fail("INVALID_GRID", "columns and rows must be 2 or 3.")
        margin = _integer(spec.get("margin", 6), "margin")
        padding = _integer(spec.get("padding", 6), "padding")
        count = columns * rows
        valid = spec.get("valid_cells")
        if not isinstance(valid, list) or any(type(i) is not int or not 0 <= i < count for i in valid):
            fail("INVALID_VALID_CELLS", "Explicit zero-based valid_cells are required.")
        unique(valid, "valid cell indices")
        rects = spec.get("cell_rects")
        if rects is None:
            cell_width = (width - 2 * margin - (columns - 1) * padding) // columns
            cell_height = (height - 2 * margin - (rows - 1) * padding) // rows
            if cell_width <= 0 or cell_height <= 0:
                fail("INVALID_GRID", "Image cannot contain this grid and padding.")
            tiled_width = columns * cell_width + (columns - 1) * padding + 2 * margin
            tiled_height = rows * cell_height + (rows - 1) * padding + 2 * margin
            ox, oy = margin + (width - tiled_width) // 2, margin + (height - tiled_height) // 2
            rects = [[ox + (i % columns) * (cell_width + padding),
                      oy + (i // columns) * (cell_height + padding), cell_width, cell_height] for i in range(count)]
        if not isinstance(rects, list) or len(rects) != count:
            fail("INVALID_GRID", "cell_rects must contain one rectangle per grid cell.")
        for rect in rects:
            if (not isinstance(rect, list) or len(rect) != 4 or any(type(v) is not int for v in rect)
                    or min(rect[:2]) < 0 or min(rect[2:]) <= 0
                    or rect[0] + rect[2] > width or rect[1] + rect[3] > height):
                fail("INVALID_GRID", "Cell rectangles must be positive and inside the image.")
        timed = "start_time" in spec or "interval" in spec
        if timed and not all(type(spec.get(key)) in (int, float) and math.isfinite(spec[key]) for key in ("start_time", "interval")):
            fail("INVALID_TIMING", "Provide finite start_time and interval together.")
        if timed and (spec["start_time"] < 0 or spec["interval"] <= 0):
            fail("INVALID_TIMING", "start_time >= 0 and interval > 0 are required.")
        cells = []
        for index in sorted(valid):
            cell = {"index": index, "ref": f"{spec['id']}:{index}", "rect": rects[index]}
            if timed:
                cell["timestamp"] = spec["start_time"] + index * spec["interval"]
            cells.append(cell)
        result["sheets"].append({"id": spec["id"], "path": workspace.relative(source),
                                  "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                  "columns": columns, "rows": rows, "margin": margin, "padding": padding,
                                  "valid_cells": sorted(valid), "cells": cells})
    return validate_manifest(result)


def read_frame(workspace, manifest, frame_ref, max_size=1280):
    validate_manifest(manifest)
    _integer(max_size, "max_size", 64)
    if max_size > 4096:
        fail("INVALID_SIZE", "max_size must not exceed 4096.")
    for sheet in manifest["sheets"]:
        for cell in sheet["cells"]:
            if cell["ref"] != frame_ref:
                continue
            source = workspace.resolve(sheet["path"], existing=True)
            if hashlib.sha256(source.read_bytes()).hexdigest() != sheet["sha256"]:
                fail("SOURCE_CHANGED", "Sheet content changed since inspection; inspect again.")
            x, y, width, height = cell["rect"]
            with Image.open(source) as image:
                if image.width * image.height > MAX_PIXELS:
                    fail("IMAGE_TOO_LARGE", "Sheet exceeds the pixel limit.")
                if width <= 0 or height <= 0 or x + width > image.width or y + height > image.height:
                    fail("INVALID_GRID", "Manifest rectangle is outside its image.")
                crop = image.crop((x, y, x + width, y + height)).convert("RGB")
                crop.thumbnail((max_size, max_size))
                output = io.BytesIO()
                crop.save(output, "PNG")
            return output.getvalue()
    fail("UNKNOWN_FRAME", f"No valid cell {frame_ref!r} in the manifest.")
