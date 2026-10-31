"""GUI와 MCP가 공유하는 프레임 추출."""
from __future__ import annotations

import math
import tempfile
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Optional

from video_tools.core.domain import (
    SizePlan, build_video_filter, calculate_expected_output_count, safe_prefix,
)
from video_tools.core.backend import OperationCancelled, probe_video, publish_file, run_ffmpeg
from video_tools.core.limits import (
    DURATION_TOLERANCE, GRID_SIZES, IMAGE_FORMATS, MAX_OUTPUT_IMAGES, MAX_OUTPUT_MEGAPIXELS, MAX_OUTPUT_PIXELS,
)


@dataclass(frozen=True, kw_only=True)
class ExtractionRequest:
    video_path: Path
    output_dir: Path
    prefix: str
    extension: str
    start: float
    end: Optional[float]  # None means the end of the video
    interval: float
    overwrite: bool
    group_mode: bool
    grid_size: tuple[int, int]
    size_plan: SizePlan


@dataclass(frozen=True)
class ExtractionFinished:
    count: int
    output_dir: Path
    skipped: int = 0
    files: tuple[Path, ...] = ()
    generated: int = 0



def validate_request(request: ExtractionRequest) -> int:
    duration = request.end - request.start
    if not all(math.isfinite(v) for v in (request.start, request.end, request.interval)):
        raise ValueError("시간과 간격은 유한한 숫자여야 합니다.")
    if request.start < 0 or duration <= 0:
        raise ValueError("추출 끝 시간은 시작 시간보다 커야 합니다.")
    if request.interval < 0.001:
        raise ValueError("추출 간격은 0.001초 이상이어야 합니다.")
    if request.extension not in IMAGE_FORMATS:
        raise ValueError("이미지 형식은 png 또는 jpg여야 합니다.")
    if request.group_mode and request.grid_size not in {(size, size) for size in GRID_SIZES}:
        raise ValueError("격자는 2×2 또는 3×3이어야 합니다.")
    for size in (request.size_plan.frame_size, request.size_plan.output_size):
        if size is not None and (min(size) < 1 or size[0] * size[1] > MAX_OUTPUT_PIXELS):
            raise ValueError(f"출력 크기는 양수이고 이미지당 {MAX_OUTPUT_MEGAPIXELS}메가픽셀 이하여야 합니다.")
    samples = calculate_expected_output_count(request.start, request.end, request.interval, False, (1, 1))
    if samples > MAX_OUTPUT_IMAGES:
        raise ValueError(f"한 번에 최대 {MAX_OUTPUT_IMAGES}개 프레임을 추출할 수 있습니다. 구간이나 간격을 조정하세요.")
    return samples


def build_extraction_command(ffmpeg: str, request: ExtractionRequest, stream_index: Optional[int] = None) -> list[str]:
    validate_request(request)
    # The service supplies a private staging directory. User text never enters
    # FFmpeg's image sequence pattern, so %, [] and Unicode prefixes are literal.
    pattern = request.output_dir / f"frame_%06d.{request.extension}"
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", f"{request.start:.9f}", "-protocol_whitelist", "file,pipe",
        "-i", str(request.video_path), "-map", f"0:{stream_index}" if stream_index is not None else "0:v:0", "-an",
        "-vf", build_video_filter(request.interval, request.group_mode, request.grid_size,
                                  request.size_plan, request.end - request.start),
        "-fps_mode", "passthrough", "-pix_fmt", "yuvj444p" if request.extension == "jpg" else "rgb24",
        "-q:v", "2", "-progress", "pipe:1", "-nostats", str(pattern),
    ]


def extract_images(ffmpeg: str, request: ExtractionRequest, cancel: Optional[threading.Event] = None,
                   progress: Optional[Callable[[float, int], None]] = None) -> ExtractionFinished:
    cancel = cancel if cancel is not None else threading.Event()
    on_progress = progress or (lambda _percent, _frames: None)
    if cancel.is_set():
        raise OperationCancelled()
    info = probe_video(ffmpeg, request.video_path, cancel)
    request = replace(request, end=info.duration if request.end is None else request.end)
    validate_request(request)
    if request.start >= info.duration or request.end > info.duration + DURATION_TOLERANCE:
        raise ValueError(f"추출 구간이 영상 길이({info.duration:g}초)를 벗어납니다.")
    if request.size_plan.frame_size is None:
        columns, rows = request.grid_size if request.group_mode else (1, 1)
        width, height = info.display_size
        if (width * columns + 24) * (height * rows + 24) > MAX_OUTPUT_PIXELS:
            raise ValueError("원본 크기의 합성 이미지가 너무 큽니다. 출력 크기를 지정하세요.")
    request.output_dir.mkdir(parents=True, exist_ok=True)
    prefix = safe_prefix(request.prefix, request.video_path.stem + "_frame")
    if len(prefix) > 160:
        raise ValueError("파일명 앞부분은 160자 이하여야 합니다.")
    with tempfile.TemporaryDirectory(prefix=".video-to-image-", dir=request.output_dir) as directory:
        staged_request = replace(request, output_dir=Path(directory))
        run_ffmpeg(build_extraction_command(ffmpeg, staged_request, info.stream_index), cancel, request.end - request.start, on_progress)
        staged_files = sorted(Path(directory).glob(f"frame_*.{request.extension}"))
        if cancel.is_set():
            raise OperationCancelled()
        saved: list[Path] = []
        skipped = 0
        # Publish only after successful encoding. Do not cancel halfway through
        # this short commit phase: the terminal result must describe all writes.
        for index, staged in enumerate(staged_files, 1):
            destination = request.output_dir / f"{prefix}_{index:04d}.{request.extension}"
            if destination.resolve() == request.video_path.resolve():
                raise ValueError("원본 영상에 덮어쓸 수 없습니다.")
            if publish_file(staged, destination, request.overwrite):
                saved.append(destination)
            else:
                skipped += 1
        on_progress(100.0, len(staged_files))
        return ExtractionFinished(len(saved), request.output_dir, skipped, tuple(saved), len(staged_files))

