"""Non-destructive MP4 editing shared by local agents and other Python callers."""
from __future__ import annotations

import math
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from video_tools.core.backend import OperationCancelled, VideoInfo, probe_video, publish_file, run_ffmpeg
from video_tools.core.limits import DURATION_TOLERANCE, MAX_CRF, MAX_OUTPUT_MEGAPIXELS, MAX_OUTPUT_PIXELS, MAX_SPEED, MIN_SPEED, ROTATIONS


@dataclass(frozen=True, kw_only=True)
class EditRequest:
    video_path: Path
    output_path: Path
    start: float = 0.0
    end: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    crop: Optional[tuple[int, int, int, int]] = None  # x, y, width, height
    rotation: int = 0  # clockwise, applied after crop
    flip_horizontal: bool = False
    flip_vertical: bool = False
    speed: float = 1.0
    mute: bool = False
    overwrite: bool = False
    crf: int = 20


def validate_edit(request: EditRequest, info: VideoInfo) -> tuple[float, float]:
    end = info.duration if request.end is None else request.end
    if not all(math.isfinite(v) for v in (request.start, end, request.speed)):
        raise ValueError("시간과 재생 속도는 유한한 숫자여야 합니다.")
    if request.start < 0 or end <= request.start or request.start >= info.duration or end > info.duration + DURATION_TOLERANCE:
        raise ValueError(f"구간은 영상 길이({info.duration:g}초) 안에 있어야 합니다.")
    if not MIN_SPEED <= request.speed <= MAX_SPEED:
        raise ValueError(f"재생 속도는 {MIN_SPEED:g}~{MAX_SPEED:g}배여야 합니다.")
    if request.rotation not in ROTATIONS:
        raise ValueError("회전은 시계 방향 0, 90, 180, 270도 중 하나여야 합니다.")
    if not 0 <= request.crf <= MAX_CRF:
        raise ValueError(f"CRF는 0~{MAX_CRF}이어야 합니다.")
    if request.output_path.suffix.lower() != ".mp4":
        raise ValueError("편집 결과는 .mp4 경로로 지정하세요.")
    if request.output_path.resolve() == request.video_path.resolve():
        raise ValueError("원본 영상과 결과 경로는 달라야 합니다.")
    if request.output_path.exists() and not request.overwrite:
        raise FileExistsError(f"결과 파일이 이미 있습니다: {request.output_path}")
    if (request.width is None) != (request.height is None):
        raise ValueError("너비와 높이를 함께 지정하세요.")
    width, height = info.display_size
    if request.crop is not None:
        x, y, crop_width, crop_height = request.crop
        if min(x, y) < 0 or min(crop_width, crop_height) < 1 or x + crop_width > width or y + crop_height > height:
            raise ValueError("자르기 영역이 회전 메타데이터 적용 후 영상 크기를 벗어납니다.")
        width, height = crop_width, crop_height
    if request.rotation in (90, 270):
        width, height = height, width
    if request.width is not None and request.height is not None:
        width, height = request.width, request.height
        if min(width, height) < 2 or width % 2 or height % 2:
            raise ValueError("MP4 출력 너비와 높이는 2 이상의 짝수여야 합니다.")
    if width * height > MAX_OUTPUT_PIXELS:
        raise ValueError(f"출력 영상은 {MAX_OUTPUT_MEGAPIXELS}메가픽셀 이하여야 합니다.")
    return end, (end - request.start) / request.speed


def _tempo_chain(speed: float) -> str:
    filters = []
    while speed > 2:
        filters.append("atempo=2")
        speed /= 2
    while speed < 0.5:
        filters.append("atempo=0.5")
        speed /= 0.5
    filters.append(f"atempo={speed:.9g}")
    return ",".join(filters)


def build_edit_command(ffmpeg: str, request: EditRequest, info: VideoInfo, output_path: Path) -> list[str]:
    end, output_duration = validate_edit(request, info)
    duration = end - request.start
    filters = [f"trim=start=0:end={duration:.9f}", f"setpts=(PTS-STARTPTS)/{request.speed:.9g}",
               "format=yuv444p"]
    if request.crop is not None:
        x, y, width, height = request.crop
        filters.append(f"crop={width}:{height}:{x}:{y}:exact=1")
    if request.rotation == 90:
        filters.append("transpose=clock")
    elif request.rotation == 180:
        filters.extend(("hflip", "vflip"))
    elif request.rotation == 270:
        filters.append("transpose=cclock")
    if request.flip_horizontal:
        filters.append("hflip")
    if request.flip_vertical:
        filters.append("vflip")
    if request.width is not None:
        filters.extend((f"scale={request.width}:{request.height}:force_original_aspect_ratio=decrease:force_divisible_by=2",
                        f"pad={request.width}:{request.height}:(ow-iw)/2:(oh-ih)/2:color=black"))
    else:
        filters.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")
    filters.extend(("setsar=1", "format=yuv420p"))
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-ss", f"{request.start:.9f}", "-protocol_whitelist", "file,pipe",
               "-i", str(request.video_path), "-map", f"0:{info.stream_index}", "-vf", ",".join(filters),
               "-c:v", "libx264", "-preset", "medium", "-crf", str(request.crf),
               # Explicit CFR avoids version-dependent fallback rates and
               # missing duration on the final video packet.
               "-r", f"{info.fps or 30:.12g}", "-fps_mode", "cfr"]
    if info.has_audio and not request.mute:
        command += ["-map", "0:a:0", "-af",
                    f"atrim=start=0:end={duration:.9f},asetpts=PTS-STARTPTS,{_tempo_chain(request.speed)}",
                    "-c:a", "aac", "-b:a", "192k"]
    else:
        command += ["-an"]
    return command + ["-t", f"{output_duration:.9f}", "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0",
                      "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(output_path)]


def edit_video(ffmpeg: str, request: EditRequest, cancel: Optional[threading.Event] = None,
               progress: Optional[Callable[[float, int], None]] = None) -> dict:
    cancel = cancel if cancel is not None else threading.Event()
    if cancel.is_set():
        raise OperationCancelled()
    info = probe_video(ffmpeg, request.video_path, cancel)
    _, duration = validate_edit(request, info)
    request.output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".video-edit-", dir=request.output_path.parent) as directory:
        staged = Path(directory) / "result.mp4"
        run_ffmpeg(build_edit_command(ffmpeg, request, info, staged), cancel, duration, progress or (lambda _p, _f: None))
        if cancel.is_set():
            raise OperationCancelled()
        if not staged.is_file() or not staged.stat().st_size:
            raise RuntimeError("편집 결과가 생성되지 않았습니다.")
        result_info = probe_video(ffmpeg, staged, cancel)
        if not publish_file(staged, request.output_path, request.overwrite):
            raise FileExistsError("편집 중 같은 이름의 결과 파일이 생성되었습니다. 다른 경로를 지정하세요.")
    return {"output_path": str(request.output_path), "duration": result_info.duration,
            "width": result_info.display_size[0], "height": result_info.display_size[1],
            "has_audio": result_info.has_audio, "bytes": request.output_path.stat().st_size}

