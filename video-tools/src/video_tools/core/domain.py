"""크기 계획과 FFmpeg 필터를 만드는 UI 비의존 로직."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Optional


SIZE_MODES = ("최종 이미지 해상도", "격자 셀 이미지 크기")
GRID_PADDING = 6
GRID_MARGIN = 6
GRID_COLOR = "0xeeeeee"


@dataclass(frozen=True)
class SizePlan:
    """FFmpeg에 전달할 프레임·격자·최종 출력 크기 계획."""

    frame_size: Optional[tuple[int, int]]
    tiled_size: Optional[tuple[int, int]]
    output_size: Optional[tuple[int, int]]


def calculate_sheet_size(
    cell_size: tuple[int, int],
    grid_size: tuple[int, int],
    padding: int = GRID_PADDING,
    margin: int = GRID_MARGIN,
) -> tuple[int, int]:
    """셀 크기와 격자 설정으로 최종 타일 영역의 크기를 계산한다."""

    cell_width, cell_height = cell_size
    columns, rows = grid_size
    return (
        columns * cell_width + (columns - 1) * padding + 2 * margin,
        rows * cell_height + (rows - 1) * padding + 2 * margin,
    )


def calculate_final_grid_geometry(
    final_size: tuple[int, int],
    grid_size: tuple[int, int],
    padding: int = GRID_PADDING,
    margin: int = GRID_MARGIN,
) -> tuple[tuple[int, int], tuple[int, int]]:
    """전체 출력 크기에 맞는 셀 크기와 타일 영역 크기를 계산한다."""

    final_width, final_height = final_size
    columns, rows = grid_size
    available_width = final_width - 2 * margin - (columns - 1) * padding
    available_height = final_height - 2 * margin - (rows - 1) * padding
    if available_width < columns or available_height < rows:
        raise ValueError("선택한 최종 해상도가 격자와 여백을 담기에 너무 작습니다.")

    cell_size = (available_width // columns, available_height // rows)
    tiled_size = calculate_sheet_size(cell_size, grid_size, padding, margin)
    return cell_size, tiled_size


def resolve_size_plan(
    size_mode: str,
    requested_size: Optional[tuple[int, int]],
    group_mode: bool,
    grid_size: tuple[int, int],
) -> SizePlan:
    """선택한 크기 모드와 출력 방식에 따른 실제 크기 계획을 만든다."""

    if size_mode not in SIZE_MODES:
        raise ValueError("이미지 크기 모드를 선택해 주세요.")
    if not group_mode:
        return SizePlan(requested_size, None, requested_size)

    if size_mode == SIZE_MODES[0]:
        if requested_size is None:
            raise ValueError("최종 이미지 해상도를 선택해 주세요.")
        cell_size, tiled_size = calculate_final_grid_geometry(requested_size, grid_size)
        return SizePlan(cell_size, tiled_size, requested_size)

    tiled_size = calculate_sheet_size(requested_size, grid_size) if requested_size else None
    return SizePlan(requested_size, tiled_size, tiled_size)


def build_video_filter(
    interval: float,
    group_mode: bool,
    grid_size: tuple[int, int],
    size_plan: SizePlan,
    duration: Optional[float] = None,
) -> str:
    """선택값을 FFmpeg 비디오 필터 문자열로 변환한다."""

    frame_rate = 1 / interval
    # Input seeking leaves timestamps relative to the requested start. Trim
    # before fps/tile so the last sheet cannot consume out-of-range frames.
    video_filter = f"trim=start=0:end={duration:.9f}," if duration is not None else ""
    video_filter += f"fps={frame_rate:.12g}:start_time=0:round=up:eof_action=pass"
    if duration is not None:
        count = calculate_expected_output_count(0, duration, interval, False, (1, 1))
        video_filter += f",trim=end_frame={count}"
    # RGB geometry supports odd cell sizes; JPEG conversion happens only after
    # padding and tiling, avoiding chroma-subsampling alignment failures.
    video_filter += ",format=rgb24"
    if size_plan.frame_size is not None:
        width, height = size_plan.frame_size
        video_filter += (
            f",scale={width}:{height}:force_original_aspect_ratio=decrease"
            f",pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={GRID_COLOR}"
        )
    if group_mode:
        columns, rows = grid_size
        video_filter += (
            f",tile={columns}x{rows}:padding={GRID_PADDING}:margin={GRID_MARGIN}:color={GRID_COLOR}"
        )
        if size_plan.output_size is not None and size_plan.tiled_size is not None:
            if size_plan.output_size != size_plan.tiled_size:
                width, height = size_plan.output_size
                video_filter += f",pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={GRID_COLOR}"
    return video_filter


def calculate_expected_output_count(
    start: float,
    end: float,
    interval: float,
    group_mode: bool,
    grid_size: tuple[int, int],
) -> int:
    """추출 구간과 격자 설정으로 예상 파일 수를 계산한다."""

    sample_count = max(1, math.ceil((end - start) / interval - 1e-9))
    if not group_mode:
        return sample_count
    columns, rows = grid_size
    return math.ceil(sample_count / (columns * rows))


def safe_prefix(value: str, fallback: str) -> str:
    """파일명으로 쓸 수 없는 문자를 제거한다."""

    prefix = value.strip() or fallback
    prefix = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", prefix)
    prefix = prefix.strip(" .")
    return prefix or "frame"
