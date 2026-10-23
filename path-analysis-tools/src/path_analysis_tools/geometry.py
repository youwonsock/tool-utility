"""Pure 3D geometry, protected RDP and explicit affine placement."""
from __future__ import annotations

import math

from .documents import fail

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def distance(a, b):
    return math.dist(a, b)


def length(points):
    return sum(distance(a["position"], b["position"]) for a, b in zip(points, points[1:]))


def simplify(points, tolerance):
    if len(points) <= 2:
        return list(points)
    anchors = [0, *[i for i in range(1, len(points) - 1) if points[i]["protected"]], len(points) - 1]
    keep = set(anchors)
    for left, right in zip(anchors, anchors[1:]):
        stack = [(left, right)]
        while stack:
            start, end = stack.pop()
            a, b = points[start]["position"], points[end]["position"]
            delta = [y - x for x, y in zip(a, b)]
            denominator = sum(x * x for x in delta)
            maximum, index = -1, None
            for i in range(start + 1, end):
                p = points[i]["position"]
                t = 0 if denominator == 0 else max(0, min(1, sum((v - x) * d for v, x, d in zip(p, a, delta)) / denominator))
                error = distance(p, [x + t * d for x, d in zip(a, delta)])
                if error > maximum:
                    maximum, index = error, i
            if index is not None and maximum > tolerance:
                keep.add(index)
                stack.extend([(start, index), (index, end)])
    return [p for i, p in enumerate(points) if i in keep]


def transform(position, matrix):
    if not isinstance(matrix, list) or len(matrix) != 16 or any(type(x) not in (int, float) or not math.isfinite(x) for x in matrix):
        fail("INVALID_PLACEMENT", "placement must be a finite row-major 4x4 affine matrix.")
    if matrix[12:] != [0, 0, 0, 1]:
        fail("INVALID_PLACEMENT", "placement must have last row [0,0,0,1].")
    determinant = (matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
                   - matrix[1] * (matrix[4] * matrix[10] - matrix[6] * matrix[8])
                   + matrix[2] * (matrix[4] * matrix[9] - matrix[5] * matrix[8]))
    if abs(determinant) <= 1e-12:
        fail("INVALID_PLACEMENT", "placement must be invertible.")
    return [sum(matrix[row * 4 + col] * position[col] for col in range(3)) + matrix[row * 4 + 3] for row in range(3)]
