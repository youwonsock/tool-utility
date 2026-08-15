"""FFmpeg 탐색·분석·이미지 추출 서비스."""

from __future__ import annotations

import atexit
import math
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Union

from video_to_image_domain import SizePlan, build_video_filter


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
                )
            except OSError:
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


class ProbeCancelled(Exception):
    """영상 길이 분석이 앱 종료 또는 취소로 중단되었음을 나타낸다."""


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


def probe_duration(
    ffmpeg: str,
    video_path: Path,
    cancel_event: Optional[threading.Event] = None,
) -> float:
    """FFmpeg 출력에서 영상 길이를 읽는다."""

    if cancel_event is not None and cancel_event.is_set():
        raise ProbeCancelled()

    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-i", str(video_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=process_creation_flags(),
    )
    _register_process(process)
    try:
        if cancel_event is not None and cancel_event.is_set():
            raise ProbeCancelled()

        stderr_output = ""
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise ProbeCancelled()
            try:
                _, stderr_output = process.communicate(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                continue

        if cancel_event is not None and cancel_event.is_set():
            raise ProbeCancelled()

        match = re.search(r"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)", stderr_output or "")
        if not match:
            raise RuntimeError("영상 길이를 읽지 못했습니다. MP4 파일이 손상되지 않았는지 확인해 주세요.")

        hours, minutes, seconds = match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        if duration <= 0:
            raise RuntimeError("영상 길이가 0초입니다.")
        return duration
    finally:
        terminate_process_tree(process)
        if process.stderr is not None:
            process.stderr.close()
        _unregister_process(process)


@dataclass(frozen=True)
class ProbeCompleted:
    video_path: Path
    ffmpeg_path: str
    duration: float


@dataclass(frozen=True)
class ProbeFailed:
    video_path: Path
    error: str


@dataclass(frozen=True)
class ExtractionRequest:
    ffmpeg_path: str
    video_path: Path
    output_dir: Path
    prefix: str
    extension: str
    start: float
    end: float
    interval: float
    overwrite: bool
    group_mode: bool
    grid_size: tuple[int, int]
    size_plan: SizePlan


@dataclass(frozen=True)
class ExtractionProgress:
    percent: float
    frames: int


@dataclass(frozen=True)
class ExtractionFinished:
    count: int
    output_dir: Path


@dataclass(frozen=True)
class ExtractionCancelled:
    pass


@dataclass(frozen=True)
class ExtractionFailed:
    error: str


MediaEvent = Union[
    ProbeCompleted,
    ProbeFailed,
    ExtractionProgress,
    ExtractionFinished,
    ExtractionCancelled,
    ExtractionFailed,
]
EventSink = Callable[[MediaEvent], None]


def build_extraction_command(request: ExtractionRequest) -> list[str]:
    """추출 요청을 재현 가능한 FFmpeg 명령 인자로 변환한다."""

    duration = request.end - request.start
    if (
        not math.isfinite(request.start)
        or not math.isfinite(request.end)
        or request.start < 0
        or duration <= 0
    ):
        raise ValueError("추출 끝 시간은 시작 시간보다 커야 합니다.")
    if not math.isfinite(request.interval) or request.interval <= 0:
        raise ValueError("추출 간격은 0보다 커야 합니다.")
    pattern = request.output_dir / f"{request.prefix}_%04d.{request.extension}"
    video_filter = build_video_filter(
        request.interval,
        request.group_mode,
        request.grid_size,
        request.size_plan,
    )
    return [
        request.ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y" if request.overwrite else "-n",
        "-ss",
        f"{request.start:.3f}",
        "-i",
        str(request.video_path),
        "-t",
        f"{duration:.3f}",
        "-vf",
        video_filter,
        "-fps_mode",
        "vfr",
        "-q:v",
        "2",
        str(pattern),
        "-progress",
        "pipe:1",
        "-nostats",
    ]


class FFmpegExtractionService:
    """백그라운드에서 FFmpeg를 실행하고 타입이 지정된 이벤트를 발행한다."""

    def __init__(
        self,
        request: ExtractionRequest,
        cancel_event: threading.Event,
        event_sink: EventSink,
    ) -> None:
        self.request = request
        self.cancel_event = cancel_event
        self.event_sink = event_sink
        self._process: Optional[subprocess.Popen[str]] = None
        self._process_lock = threading.Lock()

    @property
    def process(self) -> Optional[subprocess.Popen[str]]:
        with self._process_lock:
            return self._process

    @process.setter
    def process(self, value: Optional[subprocess.Popen[str]]) -> None:
        with self._process_lock:
            self._process = value

    def terminate(self) -> None:
        """현재 추출용 FFmpeg 프로세스와 자식 프로세스를 종료한다."""

        terminate_process_tree(self.process)

    def run(self) -> None:
        process: Optional[subprocess.Popen[str]] = None
        try:
            if self.cancel_event.is_set():
                self.event_sink(ExtractionCancelled())
                return
            command = build_extraction_command(self.request)
            previous_files = self._output_file_states()
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=process_creation_flags(),
            )
            _register_process(process)
            self.process = process
            if self.cancel_event.is_set():
                self.terminate()
            output_time = 0.0
            frame_count = 0
            if process.stdout is not None:
                for raw_line in process.stdout:
                    if self.cancel_event.is_set():
                        self.terminate()
                        break
                    line = raw_line.strip()
                    if line.startswith("out_time_us="):
                        try:
                            output_time = max(0.0, int(line.split("=", 1)[1]) / 1_000_000)
                        except ValueError:
                            pass
                    elif line.startswith("frame="):
                        try:
                            frame_count = int(line.split("=", 1)[1])
                        except ValueError:
                            pass
                    elif line.startswith("progress="):
                        duration = self.request.end - self.request.start
                        percent = min(99.0, max(0.0, output_time / duration * 100))
                        self.event_sink(ExtractionProgress(percent, frame_count))

            return_code = process.wait()
            if self.cancel_event.is_set():
                self.event_sink(ExtractionCancelled())
            elif return_code != 0:
                self.event_sink(ExtractionFailed("FFmpeg가 이미지 추출에 실패했습니다.\n" + self._last_output_hint()))
            else:
                output_count = self._output_count(previous_files, frame_count)
                self.event_sink(ExtractionFinished(output_count, self.request.output_dir))
        except FileNotFoundError:
            self.event_sink(ExtractionFailed("FFmpeg 실행 파일을 찾지 못했습니다. install.ps1을 실행해 주세요."))
        except Exception as exc:
            self.event_sink(ExtractionFailed(str(exc)))
        finally:
            self.terminate()
            if process is not None and process.stdout is not None:
                process.stdout.close()
            if process is not None:
                _unregister_process(process)
            self.process = None

    @staticmethod
    def _last_output_hint() -> str:
        return "저장 폴더, 파일명, 시간 범위가 올바른지 확인해 주세요."

    def _output_file_states(self) -> dict[Path, tuple[int, int]]:
        states: dict[Path, tuple[int, int]] = {}
        pattern = f"{self.request.prefix}_*.{self.request.extension}"
        for path in self.request.output_dir.glob(pattern):
            try:
                stat = path.stat()
            except OSError:
                continue
            states[path] = (stat.st_size, stat.st_mtime_ns)
        return states

    def _changed_output_files(self, previous_files: dict[Path, tuple[int, int]]) -> list[Path]:
        current_files = self._output_file_states()
        return sorted(
            path
            for path, state in current_files.items()
            if previous_files.get(path) != state
        )

    def _output_count(self, previous_files: dict[Path, tuple[int, int]], frame_count: int) -> int:
        if not self.request.overwrite:
            return len(self._new_output_files(previous_files))
        changed_count = len(self._changed_output_files(previous_files))
        if frame_count <= 0:
            return changed_count
        if not self.request.group_mode:
            return frame_count
        columns, rows = self.request.grid_size
        return (frame_count + columns * rows - 1) // (columns * rows)

    def _new_output_files(self, previous_files: dict[Path, tuple[int, int]]) -> list[Path]:
        current_files = self._output_file_states()
        return sorted(path for path in current_files if path not in previous_files)
