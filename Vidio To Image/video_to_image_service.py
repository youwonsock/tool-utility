"""Shared video operations and job ownership. Independent of GUI and MCP SDK."""
from dataclasses import replace
from pathlib import Path
from typing import Callable
import threading

from video_to_image_backend import find_ffmpeg, probe_video
from video_to_image_edit import EditRequest, edit_video
from video_to_image_jobs import JobManager
from video_to_image_media import ExtractionRequest, extract_images

class VideoService:
    def __init__(self, ffmpeg: str | None = None, workers: int = 2):
        self.ffmpeg = ffmpeg or find_ffmpeg()
        self.jobs = JobManager(workers=workers)

    def inspect(self, path: Path, cancel: threading.Event | None = None):
        return probe_video(self.ffmpeg, path, cancel)

    def start_extraction(self, request: ExtractionRequest | Callable):
        def operation(cancel, progress):
            prepared = request(cancel) if callable(request) else request
            result = extract_images(replace(prepared, ffmpeg_path=self.ffmpeg), cancel, progress)
            return {"saved_count": result.count, "skipped_count": result.skipped,
                    "generated_count": result.generated, "files": [str(p.resolve()) for p in result.files],
                    "output_directory": str(result.output_dir.resolve())}
        return self.jobs.submit("extract_frames", operation)

    def start_edit(self, request: EditRequest | Callable):
        def operation(cancel, progress):
            prepared = request(cancel) if callable(request) else request
            return edit_video(replace(prepared, ffmpeg_path=self.ffmpeg), cancel, progress)
        return self.jobs.submit("edit_video", operation)

    def close(self, wait: bool = True):
        self.jobs.close(wait=wait)

