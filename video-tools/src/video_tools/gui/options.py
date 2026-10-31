"""GUI 선택지·기본값과 입력 문구 해석. Tk에 의존하지 않는다."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from video_tools.core.domain import calculate_sheet_size, resolve_size_plan
from video_tools.core.limits import GRID_SIZES

APP_TITLE = "영상 이미지 추출 · 편집"
INDIVIDUAL_OUTPUT_MODE = "개별 이미지 저장"
GRID_OUTPUT_MODE = "격자 합치기"
OUTPUT_MODES = (INDIVIDUAL_OUTPUT_MODE, GRID_OUTPUT_MODE)
GRID_SIZE_PRESETS: dict[str, tuple[int, int]] = {f"{size} × {size}": (size, size) for size in GRID_SIZES}
DEFAULT_GRID_SIZE = "3 × 3"
CUSTOM_SIZE_LABEL = "사용자 지정"
FINAL_SIZE_PRESETS: dict[str, tuple[int, int]] = {
    "1920 × 1080": (1920, 1080),
    "2048 × 2048": (2048, 2048),
    "4096 × 4096": (4096, 4096),
}
DEFAULT_FINAL_SIZE = "1920 × 1080"
CELL_SIZE_PRESETS: dict[str, Optional[tuple[int, int]]] = {
    "원본": None,
    "1920 × 1080": (1920, 1080),
    "1280 × 720": (1280, 720),
    "854 × 480": (854, 480),
    "640 × 360": (640, 360),
}
DEFAULT_CELL_SIZE = "원본"
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

    milliseconds = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, fraction = divmod(remainder, 1000)
    suffix = f".{fraction:03d}" if fraction else ""
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}{suffix}"
