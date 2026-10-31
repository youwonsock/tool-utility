"""Start, watch and stop FFmpeg processes."""

from __future__ import annotations

import atexit
from collections import deque
import queue
import subprocess
import threading
import time
from typing import Callable, Optional

from video_tools.platforms import current
from video_tools.runtime import bundled_ffmpeg

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


def find_ffmpeg() -> str:
    """Use the tool folder's bundled FFmpeg, independent of the host PATH."""
    executable = bundled_ffmpeg()
    if not executable.is_file():
        raise RuntimeError(f"필수 FFmpeg 파일이 없습니다: {executable}. 저장소를 다시 clone하세요.")
    return str(executable)


def capture(command: list[str], cancel: Optional[threading.Event], timeout: float = 30,
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
