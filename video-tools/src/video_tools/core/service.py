"""Shared video operations and job ownership. Independent of GUI and MCP SDK."""
from pathlib import Path
from typing import Callable
import threading

from video_tools.core.edit import EditRequest, edit_video
from video_tools.core.jobs import JobManager
from video_tools.core.limits import MAX_ACTIVE_JOBS
from video_tools.core.extraction import ExtractionRequest, extract_images
from video_tools.core.probe import encode_preview_jpeg, probe_image, probe_video
from video_tools.core.process import find_ffmpeg, terminate_all_processes


class VideoService:
    def __init__(self, ffmpeg: str | None = None, workers: int = MAX_ACTIVE_JOBS):
        self.ffmpeg = ffmpeg or find_ffmpeg()
        self.jobs = JobManager(workers=workers)

    def inspect(self, path: Path, cancel: threading.Event | None = None):
        return probe_video(self.ffmpeg, path, cancel)

    def image_size(self, path: Path) -> tuple[int, int]:
        return probe_image(self.ffmpeg, path)

    def image_preview(self, path: Path, max_size: int) -> bytes:
        return encode_preview_jpeg(self.ffmpeg, path, max_size)

    def start_extraction(self, request: ExtractionRequest | Callable[[], ExtractionRequest]):
        def operation(cancel, progress):
            prepared = request() if callable(request) else request
            result = extract_images(self.ffmpeg, prepared, cancel, progress)
            return {"saved_count": result.count, "skipped_count": result.skipped,
                    "generated_count": result.generated, "files": [str(p.resolve()) for p in result.files],
                    "output_directory": str(result.output_dir.resolve())}
        return self.jobs.submit("extract_frames", operation)

    def start_edit(self, request: EditRequest | Callable[[], EditRequest]):
        def operation(cancel, progress):
            prepared = request() if callable(request) else request
            return edit_video(self.ffmpeg, prepared, cancel, progress)
        return self.jobs.submit("edit_video", operation)

    def job(self, job_id: str) -> dict:
        return self.jobs.get(job_id)

    def list_jobs(self) -> list[dict]:
        return self.jobs.list()

    def cancel_job(self, job_id: str) -> dict:
        return self.jobs.cancel(job_id)

    def stop_processes(self) -> None:
        terminate_all_processes()

    def close(self, wait: bool = True):
        self.jobs.close(wait=wait)
