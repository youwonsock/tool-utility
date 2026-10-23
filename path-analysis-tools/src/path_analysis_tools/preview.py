"""Deterministic top and side raster previews for vision-capable callers."""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from .documents import fail
from .paths import validate_path

COLORS = ["#1976d2", "#e65100", "#7b1fa2", "#00897b", "#c2185b", "#455a64"]


def preview_path(plan, size=1100):
    validate_path(plan)
    if type(size) is not int or not 512 <= size <= 4096:
        fail("INVALID_SIZE", "Preview size must be an integer in 512..4096.")
    runs = [(t, r) for t in plan["targets"] for r in t["runs"]]
    if not runs:
        fail("EMPTY_PATH", "No measurable path to preview.")
    # Separate runs occupy separate rows so camera cuts are never drawn as bridges.
    height = max(260, len(runs) * 280 + 65)
    if height * size > 32_000_000:
        fail("PREVIEW_TOO_LARGE", "Select fewer runs or a smaller preview size.")
    image = Image.new("RGB", (size, height), "white")
    draw = ImageDraw.Draw(image)
    draw.text((16, 12), "Path Analysis Tools | separate runs; arrows = movement | top: X/Z | side: Z/Y", fill="#222222")
    for row, (target, run) in enumerate(runs):
        points = [p for s in run["segments"] for p in s["points"]]
        draw.text((16, 45 + row * 280), f"{target['label']} / {run['source_run_id']} ({run['id'][:8]})", fill="#222222")
        for pane, (horizontal, vertical, title) in enumerate([(0, 2, "TOP X/Z"), (2, 1, "SIDE Z/Y")]):
            left, top = 20 + pane * (size // 2), 80 + row * 280
            pane_width, pane_height = size // 2 - 40, 210
            xs, ys = [p["position"][horizontal] for p in points], [p["position"][vertical] for p in points]
            minimum_x, maximum_x = min(xs), max(xs)
            minimum_y, maximum_y = min(ys), max(ys)
            scale = min((pane_width - 40) / max(maximum_x - minimum_x, 1e-6),
                        (pane_height - 40) / max(maximum_y - minimum_y, 1e-6))

            def pixel(point):
                position = point["position"]
                return (left + pane_width / 2 + (position[horizontal] - (minimum_x + maximum_x) / 2) * scale,
                        top + pane_height / 2 - (position[vertical] - (minimum_y + maximum_y) / 2) * scale)

            draw.rectangle((left, top, left + pane_width, top + pane_height), outline="#cccccc")
            draw.text((left + 5, top + 5), title, fill="#555555")
            for index, segment in enumerate(run["segments"]):
                color = COLORS[index % len(COLORS)]
                coordinates = [pixel(p) for p in segment["points"]]
                draw.line(coordinates, fill=color, width=3)
                for a, b in zip(coordinates, coordinates[1:]):
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    magnitude = (dx * dx + dy * dy) ** 0.5
                    if magnitude > 12:
                        x, y = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                        ux, uy = dx / magnitude, dy / magnitude
                        draw.polygon([(x, y), (x - 9 * ux + 4 * uy, y - 9 * uy - 4 * ux),
                                      (x - 9 * ux - 4 * uy, y - 9 * uy + 4 * ux)], fill=color)
                for point, (x, y) in zip(segment["points"], coordinates):
                    radius = 4 if point["protected"] else 2
                    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
                    if point.get("note"):
                        draw.rectangle((x - 6, y - 6, x + 6, y + 6), outline="red", width=2)
                x, y = coordinates[0]
                draw.text((x + 6, y + 4), f"S{index + 1}", fill=color)
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()
