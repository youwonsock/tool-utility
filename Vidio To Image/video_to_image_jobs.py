"""Bounded background jobs for local MCP clients."""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from video_to_image_backend import OperationCancelled

Operation = Callable[[threading.Event, Callable[[float, int], None]], dict]
TERMINAL = {"completed", "failed", "cancelled"}


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    progress: float = 0
    frames: int = 0
    created_at: float = field(default_factory=time.time)
    result: dict | None = None
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class JobManager:
    def __init__(self, workers: int = 2, max_pending: int = 8, max_history: int = 100) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="video-job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._max_pending = max_pending
        self._max_history = max_history
        self._closed = False

    def submit(self, kind: str, operation: Operation) -> dict:
        with self._lock:
            if self._closed:
                raise RuntimeError("서버가 종료 중입니다.")
            if sum(job.status not in TERMINAL for job in self._jobs.values()) >= self._max_pending:
                raise ValueError("대기/실행 작업이 8개입니다. 기존 작업이 끝난 뒤 다시 요청하세요.")
            while len(self._jobs) >= self._max_history:
                old = next((key for key, job in self._jobs.items() if job.status in TERMINAL), None)
                if old is None:
                    break
                del self._jobs[old]
            job = Job(uuid.uuid4().hex, kind)
            self._jobs[job.id] = job
            self._executor.submit(self._run, job, operation)
            return self.get(job.id)

    def _run(self, job: Job, operation: Operation) -> None:
        def progress(percent: float, frames: int) -> None:
            with self._lock:
                job.progress = max(job.progress, min(99, percent))
                job.frames = frames
        try:
            with self._lock:
                if job.cancel.is_set():
                    raise OperationCancelled()
                job.status = "running"
            result = operation(job.cancel, progress)
            with self._lock:
                # A cancellation arriving after publication must not disguise
                # successfully committed outputs as a cancelled operation.
                job.result, job.status, job.progress = result, "completed", 100
        except OperationCancelled:
            with self._lock:
                job.status = "cancelled"
        except Exception as exc:
            with self._lock:
                job.status, job.error = "failed", str(exc)[-6000:]

    def _job(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise ValueError("작업 ID를 찾을 수 없습니다. 서버 재시작 시 작업 기록은 초기화됩니다.") from exc

    def get(self, job_id: str) -> dict:
        with self._lock:
            job = self._job(job_id)
            return {"job_id": job.id, "kind": job.kind, "status": job.status,
                    "progress_percent": job.progress, "output_frames": job.frames,
                    "created_at": job.created_at, "result": job.result, "error": job.error}

    def list(self) -> list[dict]:
        with self._lock:
            return [self.get(job.id) for job in reversed(list(self._jobs.values()))]

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            job = self._job(job_id)
            accepted = job.status not in TERMINAL
            if accepted:
                job.cancel.set()
                job.status = "cancelling"
            return {"accepted": accepted, **self.get(job_id)}

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                if job.status not in TERMINAL:
                    job.cancel.set()
        self._executor.shutdown(wait=True)

