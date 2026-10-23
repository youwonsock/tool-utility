"""Create synthetic visual observations and ready-to-call request documents.

This is a reproducible example, not evidence of analysis of a user's video.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from PIL import Image, ImageDraw
from path_analysis_tools.geometry import IDENTITY


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    def save(name, value):
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Target-centered frames with changing relative landmarks; the sixth frame
    # represents a camera shot away from the player, followed by a new run.
    positions = [[0, 0, 0], [0, 0, 2], [0, 0, 4], [2, 1, 4], [4, 2, 4], None, [10, 2, 4], [10, 2, 6]]
    cell_width, cell_height, margin, padding = 256, 192, 6, 6
    sheet = Image.new("RGB", (3 * cell_width + 2 * padding + 2 * margin + 2,
                              3 * cell_height + 2 * padding + 2 * margin + 1), "#eeeeee")
    for index, position in enumerate(positions):
        cell = Image.new("RGB", (cell_width, cell_height), "#f0e6d2")
        draw = ImageDraw.Draw(cell)
        draw.text((8, 8), f"Synthetic frame {index}", fill="#222222")
        if position is None:
            draw.rectangle((60, 70, 210, 160), fill="#777777")
            draw.text((65, 90), "CAMERA AWAY", fill="white")
        else:
            x, y, z = position
            # Ground markers move opposite to the target's projected movement.
            for bx, bz in [(-2, 0), (2, 2), (4, 6), (8, 4), (12, 8)]:
                px, py = 128 + (bx - x) * 14 - (bz - z) * 5, 125 + (bz - z) * 8 + (bx - x) * 4 + y * 12
                draw.rectangle((px - 9, py - 9, px + 9, py + 9), fill="#42885c", outline="#183c20")
                draw.text((px - 6, py + 10), f"{bx},{bz}", fill="#333333")
            draw.ellipse((119, 80, 137, 98), fill="#e53935")
            draw.line((128, 98, 128, 124), fill="#d32f2f", width=7)
            draw.line((128, 124, 118, 140), fill="#d32f2f", width=4)
            draw.line((128, 124, 138, 140), fill="#d32f2f", width=4)
            draw.text((8, 168), f"relative height level {y}", fill="#222222")
        sheet.paste(cell, (7 + (index % 3) * (cell_width + padding), 6 + (index // 3) * (cell_height + padding)))
    sheet.save(args.output / "synthetic-grid.png")
    samples = [{"id": f"frame-{i}", "status": "excluded" if position is None else "estimated", "position": position,
                "frame_refs": [f"synthetic:{i}"], "protected": i in (2, 3, 4),
                "note": "camera away" if position is None else "synthetic ground truth fixture"} for i, position in enumerate(positions)]
    observations = {"schema_version": 1, "document_type": "ObservationSet", "analysis_id": "synthetic-example",
                    "frame_id": "draft-local", "mode": "create", "targets": [{"id": "player", "label": "Player",
                    "runs": [{"id": "recording", "segments": [{"id": "travel", "label": "Travel", "samples": samples}]}]}]}
    save("observations.json", observations)
    save("snapshot-empty.json", {"schema_version": 1, "document_type": "SceneSnapshot", "scene_id": "replace-with-scene-id",
         "scope_id": "replace-with-selected-root", "frame_id": "draft-local", "frame_transform": IDENTITY,
         "capabilities": ["create_node", "update_node", "set_order", "delete_node", "rebuild"], "nodes": [], "orders": []})
    save("inspect-request.json", {"analysis_id": "synthetic-example", "sheets": [{"id": "synthetic", "path": "synthetic-grid.png",
         "columns": 3, "rows": 3, "valid_cells": list(range(8))}], "output": "manifest.json"})
    save("frame-request.json", {"manifest": "manifest.json", "frame_ref": "synthetic:3", "output": "frame-3.png"})
    save("calculate-request.json", {"observations": "observations.json", "output": "path-plan.json"})
    save("preview-request.json", {"path_plan": "path-plan.json", "output": "preview.png"})
    save("edit-request.json", {"path_plan": "path-plan.json", "snapshot": "snapshot-empty.json", "output": "edit-plan.json"})
    save("verify-request.json", {"edit_plan": "edit-plan.json", "snapshot": "snapshot-empty.json", "output": "preflight.json"})
    print(args.output)


if __name__ == "__main__":
    main()
