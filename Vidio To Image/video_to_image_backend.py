"""FFmpeg 탐색·분석·이미지 추출 서비스."""

from __future__ import annotations

import atexit
import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

_ACTIVE_PROCESSES: dict[int, subprocess.Popen] = {}
_ACTIVE_PROCESSES_LOCK = threading.Lock()


def windows_creation_flags() -> int:
    """Windows에서 FFmpeg 콘솔 창이 별도로 뜨지 않도록 한다."""

    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def process_creation_flags() -> int:
    """FFmpeg를 별도 프로세스 그룹으로 실행해 종료 시 트리까지 정리한다."""

    return windows_creation_flags() | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


def _register_process(process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES[process.pid] = process


def _unregister_process(process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES.pop(process.pid, None)


def terminate_process_tree(process: Optional[subprocess.Popen]) -> None:
    """FFmpeg와 그 자식 프로세스를 종료하고 완료될 때까지 기다린다."""

    if process is None:
        return

    if process.poll() is None:
        if sys.platform == "win32":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=windows_creation_flags(),
                    check=False,
                    timeout=5,
                )
            except (OSError, subprocess.TimeoutExpired):
                # taskkill을 사용할 수 없는 환경에서는 Popen의 기본 종료로
                # 최소한 FFmpeg 본체라도 정리한다.
                try:
                    process.terminate()
                except OSError:
                    pass
        else:
            try:
                process.terminate()
            except OSError:
                pass

    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    except (OSError, subprocess.SubprocessError):
        pass


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
    """PATH 또는 imageio-ffmpeg가 제공하는 FFmpeg 실행 파일을 찾는다."""

    if getattr(sys, "frozen", False):
        executable_root = Path(sys.executable).resolve().parent
        bundle_root = Path(getattr(sys, "_MEIPASS", executable_root))
        ffmpeg_directories = (
            executable_root / "ffmpeg",
            executable_root / "_internal" / "ffmpeg",
            bundle_root / "ffmpeg",
        )
        for directory in ffmpeg_directories:
            if not directory.exists():
                continue
            candidates = sorted(directory.glob("ffmpeg*.exe"))
            if candidates:
                return str(candidates[0])

    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:
        raise RuntimeError(
            "FFmpeg를 찾을 수 없습니다. 같은 폴더의 install.ps1을 먼저 실행해 주세요."
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"FFmpeg 실행 파일을 준비하지 못했습니다: {exc}") from exc


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


def _capture(command: list[str], cancel: Optional[threading.Event], timeout: float = 30) -> tuple[int, str, str]:
    if cancel is not None and cancel.is_set():
        raise OperationCancelled()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                               creationflags=process_creation_flags())
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
    """Prefer ffprobe JSON; bundled FFmpeg alone remains sufficient for the GUI/MCP."""
    if not video_path.is_file():
        raise ValueError(f"영상 파일을 찾을 수 없습니다: {video_path}")
    sibling = Path(ffmpeg).resolve().with_name("ffprobe.exe" if sys.platform == "win32" else "ffprobe")
    ffprobe = str(sibling) if sibling.is_file() else shutil.which("ffprobe")
    if ffprobe:
        code, output, error = _capture([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
                                       "-show_format", "-show_streams", "-of", "json", str(video_path)], cancel_event)
        if code == 0:
            data = json.loads(output)
            streams = data.get("streams", [])
            video = next((s for s in streams if s.get("codec_type") == "video"
                          and not s.get("disposition", {}).get("attached_pic")), None)
            if video is None:
                raise ValueError("영상 스트림이 없는 파일입니다.")
            duration = _positive_number(video.get("duration")) or _positive_number(data.get("format", {}).get("duration"))
            rate = str(video.get("avg_frame_rate", "0/1")).split("/")
            fps = _positive_number(rate[0]) / (_positive_number(rate[1]) or 1) if len(rate) == 2 else _positive_number(rate[0])
            rotation = int(float(video.get("tags", {}).get("rotate", 0)))
            for side_data in video.get("side_data_list", []):
                if "rotation" in side_data:
                    rotation = int(float(side_data["rotation"]))
            if duration <= 0:
                raise ValueError("영상 길이를 읽지 못했습니다.")
            return VideoInfo(video_path, duration, int(video["width"]), int(video["height"]), fps,
                             any(s.get("codec_type") == "audio" for s in streams), str(video.get("codec_name", "unknown")),
                             rotation, "ffprobe", int(video["index"]))
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


def probe_duration(ffmpeg: str, video_path: Path, cancel_event: Optional[threading.Event] = None) -> float:
    return probe_video(ffmpeg, video_path, cancel_event).duration


def run_ffmpeg(command: list[str], cancel: threading.Event, duration: float,
               progress: Callable[[float, int], None], timeout: float = 3600) -> int:
    """Drain output while checking cancellation even when FFmpeg is silent."""
    if cancel.is_set():
        raise OperationCancelled()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                               creationflags=process_creation_flags())
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


