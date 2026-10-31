"""FFmpeg 탐색·분석·이미지 추출 서비스."""

from __future__ import annotations

import atexit
from video_tools.platforms import current
from video_tools.runtime import bundled_ffmpeg
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

_ACTIVE_PROCESSES: dict[int, subprocess.Popen] = {}
_ACTIVE_PROCESSES_LOCK = threading.Lock()


def _register_process(process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES[process.pid] = process


def _unregister_process(process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES.pop(process.pid, None)


def terminate_process_tree(process: Optional[subprocess.Popen]) -> None:
    """FFmpeg와 그 자식 프로세스를 종료하고 완료될 때까지 기다린다."""

    if process is not None:
        current.stop_process(process, owned=process.pid in _ACTIVE_PROCESSES)


def terminate_all_processes() -> None:
    """현재 앱이 시작한 FFmpeg 프로세스를 모두 종료한다."""

    with _ACTIVE_PROCESSES_LOCK:
        processes = list(_ACTIVE_PROCESSES.values())

    for process in processes:
        terminate_process_tree(process)
        _unregister_process(process)


atexit.register(terminate_all_processes)


class OperationCancelled(Exception):
    """A requested media operation was cancelled."""


ProbeCancelled = OperationCancelled


def find_ffmpeg() -> str:
    """Use the tool folder's bundled FFmpeg, independent of the host PATH."""
    executable = bundled_ffmpeg()
    if not executable.is_file():
        raise RuntimeError(f"필수 FFmpeg 파일이 없습니다: {executable}. 저장소를 다시 clone하세요.")
    return str(executable)


@dataclass(frozen=True)
class VideoInfo:
    path: Path
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    video_codec: str
    rotation: int = 0
    probe_backend: str = "ffmpeg"
    stream_index: int = 0

    @property
    def display_size(self) -> tuple[int, int]:
        return (self.height, self.width) if abs(self.rotation) % 180 == 90 else (self.width, self.height)


def _capture(command: list[str], cancel: Optional[threading.Event], timeout: float = 30,
             binary: bool = False) -> tuple[int, str | bytes, str | bytes]:
    if cancel is not None and cancel.is_set():
        raise OperationCancelled()
    text_options = {} if binary else {"text": True, "encoding": "utf-8", "errors": "replace"}
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, **text_options, **current.process_options())
    _register_process(process)
    deadline = time.monotonic() + timeout
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise OperationCancelled()
            if time.monotonic() >= deadline:
                raise RuntimeError("영상 정보 조회 시간이 초과되었습니다.")
            try:
                stdout, stderr = process.communicate(timeout=0.1)
                return process.returncode, stdout, stderr
            except subprocess.TimeoutExpired:
                continue
    finally:
        terminate_process_tree(process)
        _unregister_process(process)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def _positive_number(value: object) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


def probe_video(ffmpeg: str, video_path: Path, cancel_event: Optional[threading.Event] = None) -> VideoInfo:
    """Read metadata with FFmpeg alone on both supported platforms."""
    if not video_path.is_file():
        raise ValueError(f"영상 파일을 찾을 수 없습니다: {video_path}")
    _, _, output = _capture([ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe",
                             "-i", str(video_path)], cancel_event)
    duration_match = re.search(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)", output)
    video_line = next((line for line in output.splitlines() if "Video:" in line and "attached pic" not in line), "")
    size = re.search(r"\b([1-9]\d{0,5})x([1-9]\d{0,5})\b", video_line)
    fps_match = re.search(r"([\d.]+) fps", video_line)
    rotation_match = re.search(r"rotation of ([-\d.]+) degrees", output)
    stream_match = re.search(r"Stream #\d+:(\d+)", video_line)
    if not duration_match or not size:
        raise ValueError("영상 정보를 읽지 못했습니다.\n" + output[-2000:])
    h, m, s = duration_match.groups()
    duration = int(h) * 3600 + int(m) * 60 + float(s)
    if duration <= 0:
        raise ValueError("영상 길이가 0초입니다.")
    return VideoInfo(video_path, duration, int(size[1]), int(size[2]),
                     float(fps_match[1]) if fps_match else 0, "Audio:" in output,
                     video_line.split("Video:", 1)[1].strip().split()[0].rstrip(","),
                     int(float(rotation_match[1])) if rotation_match else 0,
                     "ffmpeg", int(stream_match[1]) if stream_match else 0)


def probe_image(ffmpeg: str, image_path: Path) -> tuple[int, int]:
    """Read a still image's pixel size; images report no usable duration."""
    if not image_path.is_file():
        raise ValueError(f"이미지 파일을 찾을 수 없습니다: {image_path}")
    _, _, output = _capture([ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe",
                             "-i", str(image_path)], None)
    video_line = next((line for line in output.splitlines() if "Video:" in line), "")
    size = re.search(r"\b([1-9]\d{0,5})x([1-9]\d{0,5})\b", video_line)
    if not size:
        raise ValueError("이미지 정보를 읽지 못했습니다.\n" + output[-2000:])
    return int(size[1]), int(size[2])


def encode_preview_jpeg(ffmpeg: str, image_path: Path, max_size: int) -> bytes:
    """Shrink, never enlarge, an image into a max_size box and return JPEG bytes."""
    scale = (f"scale=w='min(iw,{max_size})':h='min(ih,{max_size})'"
             ":force_original_aspect_ratio=decrease,format=yuvj444p")
    code, stdout, stderr = _capture([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                                     "-protocol_whitelist", "file,pipe", "-i", str(image_path),
                                     "-vf", scale, "-frames:v", "1", "-f", "image2pipe",
                                     "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], None, binary=True)
    if code or not stdout.startswith(b"\xff\xd8\xff"):
        raise ValueError("미리보기 이미지를 만들지 못했습니다.\n" + stderr.decode("utf-8", "replace")[-2000:])
    return stdout


def run_ffmpeg(command: list[str], cancel: threading.Event, duration: float,
               progress: Callable[[float, int], None], timeout: float = 3600) -> int:
    """Drain output while checking cancellation even when FFmpeg is silent."""
    if cancel.is_set():
        raise OperationCancelled()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                               **current.process_options())
    _register_process(process)
    lines: queue.Queue[Optional[str]] = queue.Queue(maxsize=256)
    reader_stop = threading.Event()

    def read_output() -> None:
        try:
            if process.stdout is not None:
                for line in process.stdout:
                    while not reader_stop.is_set():
                        try:
                            lines.put(line, timeout=0.1)
                            break
                        except queue.Full:
                            continue
                    if reader_stop.is_set():
                        return
        finally:
            while not reader_stop.is_set():
                try:
                    lines.put(None, timeout=0.1)
                    break
                except queue.Full:
                    continue

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    errors: deque[str] = deque(maxlen=30)
    frames, output_time = 0, 0.0
    try:
        while True:
            if cancel.is_set():
                raise OperationCancelled()
            if time.monotonic() > deadline:
                raise RuntimeError("FFmpeg 처리 제한 시간(1시간)을 초과했습니다.")
            try:
                raw = lines.get(timeout=0.1)
            except queue.Empty:
                continue
            if raw is None:
                break
            line = raw.strip()
            key, separator, value = line.partition("=")
            try:
                if key == "out_time_us":
                    output_time = max(0, int(value) / 1_000_000)
                elif key == "frame":
                    frames = int(value)
                elif key == "progress":
                    progress(min(99.0, output_time / max(duration, 0.001) * 100), frames)
                elif not separator or key not in {"fps", "bitrate", "total_size", "out_time_ms", "out_time", "dup_frames", "drop_frames", "speed"} and not key.startswith("stream_"):
                    errors.append(line)
            except ValueError:
                pass
        code = process.wait(timeout=5)
        if cancel.is_set():
            raise OperationCancelled()
        if code:
            raise RuntimeError(f"FFmpeg 실패 (종료 코드 {code})\n" + "\n".join(errors)[-6000:])
        return frames
    finally:
        reader_stop.set()
        terminate_process_tree(process)
        reader.join(timeout=3)
        if process.stdout is not None:
            process.stdout.close()
        _unregister_process(process)


def publish_file(staged: Path, destination: Path, overwrite: bool) -> bool:
    """Publish a completed file. Exclusive creation preserves existing outputs."""
    if overwrite:
        os.replace(staged, destination)
        return True
    try:
        os.link(staged, destination)
        return True
    except FileExistsError:
        return False
    except OSError:
        # Some Windows/network filesystems do not support hard links.
        try:
            output = destination.open("xb")
        except FileExistsError:
            return False
        try:
            with output, staged.open("rb") as source:
                shutil.copyfileobj(source, output)
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
        return True


