"""MP4 이미지 추출기의 UI 비의존 도메인 로직."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Optional


APP_TITLE = "MP4 → 이미지 추출기"
INDIVIDUAL_OUTPUT_MODE = "개별 이미지 저장"
GRID_OUTPUT_MODE = "격자 합치기"
OUTPUT_MODES = (INDIVIDUAL_OUTPUT_MODE, GRID_OUTPUT_MODE)
GRID_SIZE_PRESETS: dict[str, tuple[int, int]] = {
    "2 × 2": (2, 2),
    "3 × 3": (3, 3),
}
SIZE_MODES = ("최종 이미지 해상도", "격자 셀 이미지 크기")
CUSTOM_SIZE_LABEL = "사용자 지정"
FINAL_SIZE_PRESETS: dict[str, tuple[int, int]] = {
    "1920 × 1080": (1920, 1080),
    "2048 × 2048": (2048, 2048),
    "4096 × 4096": (4096, 4096),
}
CELL_SIZE_PRESETS: dict[str, Optional[tuple[int, int]]] = {
    "원본": None,
    "1920 × 1080": (1920, 1080),
    "1280 × 720": (1280, 720),
    "854 × 480": (854, 480),
    "640 × 360": (640, 360),
}
GRID_PADDING = 6
GRID_MARGIN = 6
GRID_COLOR = "0xeeeeee"
PREVIEW_SAMPLE_CELL_SIZE = (320, 180)
PREVIEW_CANVAS_HEIGHT = 260
PREVIEW_INSET = 16
PREVIEW_SAMPLE_COLORS: tuple[tuple[str, str], ...] = (
    ("#2563eb", "#60a5fa"),
    ("#7c3aed", "#a78bfa"),
    ("#db2777", "#f472b6"),
    ("#ea580c", "#fb923c"),
    ("#16a34a", "#4ade80"),
    ("#0891b2", "#22d3ee"),
    ("#ca8a04", "#facc15"),
    ("#475569", "#94a3b8"),
    ("#be123c", "#fb7185"),
)


@dataclass(frozen=True)
class SizePlan:
    """FFmpeg에 전달할 프레임·격자·최종 출력 크기 계획."""

    frame_size: Optional[tuple[int, int]]
    tiled_size: Optional[tuple[int, int]]
    output_size: Optional[tuple[int, int]]


@dataclass(frozen=True)
class PreviewPlan:
    """미리보기에서 사용할 셀·격자·최종 출력 크기 계획."""

    grid_size: tuple[int, int]
    cell_size: tuple[int, int]
    output_size: tuple[int, int]
    uses_sample_size: bool


def parse_positive_float(value: str, label: str) -> float:
    """양의 유한 실수를 읽는다."""

    text = value.strip()
    if not text:
        raise ValueError(f"{label}을(를) 입력해 주세요.")
    try:
        number = float(text)
    except ValueError as exc:
        raise ValueError(f"{label}은(는) 0보다 큰 숫자여야 합니다.") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{label}은(는) 0보다 큰 숫자여야 합니다.")
    return number


def parse_positive_int(value: str, label: str) -> int:
    """양의 정수를 읽는다."""

    text = value.strip()
    if not text:
        raise ValueError(f"{label}을(를) 입력해 주세요.")
    try:
        number = int(text)
    except ValueError as exc:
        raise ValueError(f"{label}은(는) 1 이상의 정수여야 합니다.") from exc
    if number <= 0:
        raise ValueError(f"{label}은(는) 1 이상의 정수여야 합니다.")
    return number


def parse_grid_layout(value: str) -> tuple[int, int]:
    """격자 선택값을 열·행 튜플로 변환한다."""

    layout = GRID_SIZE_PRESETS.get(value)
    if layout is None:
        raise ValueError("격자 크기를 선택해 주세요.")
    return layout


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


def resolve_preview_plan(
    size_mode: str,
    requested_size: Optional[tuple[int, int]],
    group_mode: bool,
    grid_size: tuple[int, int],
) -> PreviewPlan:
    """실제 크기 계획을 미리보기용 크기로 보완한다."""

    effective_grid_size = grid_size if group_mode else (1, 1)
    size_plan = resolve_size_plan(size_mode, requested_size, group_mode, effective_grid_size)
    if size_plan.frame_size is None or size_plan.output_size is None:
        cell_size = PREVIEW_SAMPLE_CELL_SIZE
        output_size = calculate_sheet_size(cell_size, effective_grid_size) if group_mode else cell_size
        return PreviewPlan(effective_grid_size, cell_size, output_size, True)
    return PreviewPlan(effective_grid_size, size_plan.frame_size, size_plan.output_size, False)


def build_video_filter(
    interval: float,
    group_mode: bool,
    grid_size: tuple[int, int],
    size_plan: SizePlan,
) -> str:
    """선택값을 FFmpeg 비디오 필터 문자열로 변환한다."""

    frame_rate = 1 / interval
    video_filter = f"fps={frame_rate:.12g}"
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


def parse_time(value: str) -> float:
    """초 또는 HH:MM:SS(.mmm) 형식의 시간을 초 단위로 변환한다."""

    text = value.strip()
    if not text:
        raise ValueError("시간을 입력해 주세요.")

    if ":" not in text:
        seconds = float(text)
    else:
        pieces = text.split(":")
        if len(pieces) not in (2, 3):
            raise ValueError("시간 형식은 초 또는 HH:MM:SS 형식이어야 합니다.")
        try:
            numbers = [float(piece) for piece in pieces]
        except ValueError as exc:
            raise ValueError("시간 형식은 초 또는 HH:MM:SS 형식이어야 합니다.") from exc
        if any(number < 0 for number in numbers):
            raise ValueError("시간은 0 이상이어야 합니다.")
        if len(numbers) == 2:
            minutes, seconds_part = numbers
            hours = 0
        else:
            hours, minutes, seconds_part = numbers
        if minutes >= 60 or seconds_part >= 60:
            raise ValueError("분과 초는 60보다 작아야 합니다.")
        seconds = hours * 3600 + minutes * 60 + seconds_part

    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("시간은 0 이상의 유효한 숫자여야 합니다.")
    return seconds


def format_time(seconds: float) -> str:
    """초를 읽기 쉬운 HH:MM:SS 형식으로 표시한다."""

    seconds = max(0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    remaining = seconds % 60
    if abs(remaining - round(remaining)) < 0.001:
        return f"{hours:02d}:{minutes:02d}:{int(round(remaining)):02d}"
    return f"{hours:02d}:{minutes:02d}:{remaining:06.3f}"


def safe_prefix(value: str, fallback: str) -> str:
    """파일명으로 쓸 수 없는 문자를 제거한다."""

    prefix = value.strip() or fallback
    prefix = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", prefix)
    prefix = prefix.strip(" .")
    return prefix or "frame"
