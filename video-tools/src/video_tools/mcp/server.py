"""Local stdio MCP server for video inspection, extraction and editing."""
from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
import anyio
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations
from mcp.server.stdio import stdio_server
from PIL import Image as PillowImage

from video_tools.core.backend import probe_video
from video_tools.core.domain import SIZE_MODES, resolve_size_plan
from video_tools.core.edit import EditRequest
from video_tools.core.service import VideoService
from video_tools.core.media import MAX_OUTPUT_PIXELS, ExtractionRequest

MEDIA_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".png", ".jpg", ".jpeg"}


class VideoToolsMCP(FastMCP):
    async def run_stdio_async(self) -> None:
        # Own the stdio handles so SDK shutdown leaves the process streams usable.
        with os.fdopen(os.dup(sys.stdin.fileno()), 'r', encoding='utf-8', errors='replace') as incoming, \
             os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1) as outgoing:
            async with stdio_server(anyio.wrap_file(incoming), anyio.wrap_file(outgoing)) as (read, write):
                await self._mcp_server.run(read, write, self._mcp_server.create_initialization_options())


class Workspace:
    """Resolve relative/absolute paths under an explicitly configured root."""

    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.root.is_dir():
            raise ValueError("작업 폴더가 디렉터리가 아닙니다.")

    def resolve(self, value: str, *, existing: bool = False) -> Path:
        if not value.strip():
            raise ValueError("빈 경로는 사용할 수 없습니다.")
        path = Path(value).expanduser()
        path = (path if path.is_absolute() else self.root / path).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("경로는 설정된 작업 폴더 안에 있어야 합니다.")
        if existing and not path.is_file():
            raise ValueError(f"파일을 찾을 수 없습니다: {value}")
        return path

    def relative(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()


def create_server(workspace: Path, ffmpeg_path: str | None = None) -> FastMCP:
    scope = Workspace(workspace)
    service = VideoService(ffmpeg_path)
    ffmpeg = service.ffmpeg
    jobs = service.jobs

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield None
        finally:
            await asyncio.to_thread(jobs.close)

    server = VideoToolsMCP(
        "video-tools",
        instructions="로컬 영상 도구. server_info와 list_media로 작업 폴더를 확인하세요. "
                     "경로는 이 폴더 기준입니다. start_*는 작업 ID를 반환합니다. "
                     "get_job을 적당한 간격으로 조회하고 completed 결과 경로를 사용하세요. "
                     "원본은 보존하며 overwrite 기본값은 false입니다. "
                     "프레임 추출 후 read_image로 결과를 확인할 수 있습니다.",
        lifespan=lifespan, log_level="WARNING",
    )
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    writes = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False)

    def present(job):
        result = job.get("result")
        if result:
            for key in ("output_path", "output_directory"):
                if key in result:
                    result[key] = scope.relative(Path(result[key]))
            if "files" in result:
                result["files"] = [scope.relative(Path(p)) for p in result["files"]]
        return job

    @server.tool(annotations=read_only)
    def server_info() -> dict[str, Any]:
        """Show workspace, limits, editing operations and sampling behavior."""
        return {"workspace": str(scope.root), "transport": "stdio", "ffmpeg": ffmpeg,
                "max_active_jobs": 2, "max_pending_jobs": 8, "max_sampled_frames": 10000,
                "editing": ["trim", "crop", "resize_letterbox", "rotate", "flip", "speed", "mute"],
                "sampling": "start+n*interval < end; latest frame at/before target, first available frame at the start boundary"}

    @server.tool(annotations=read_only)
    def list_media(directory: str = ".", limit: int = 100) -> dict[str, Any]:
        """List immediate subdirectories and media files inside the workspace."""
        if not 1 <= limit <= 500:
            raise ValueError("limit은 1~500이어야 합니다.")
        folder = scope.resolve(directory)
        if not folder.is_dir():
            raise ValueError("목록 경로가 폴더가 아닙니다.")
        items = []
        truncated = False
        for entry in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith(".") or not entry.resolve().is_relative_to(scope.root):
                continue
            if not entry.is_dir() and entry.suffix.lower() not in MEDIA_EXTENSIONS:
                continue
            if len(items) >= limit:
                truncated = True
                break
            items.append({"path": scope.relative(entry), "kind": "directory" if entry.is_dir() else "file",
                          "bytes": entry.stat().st_size if entry.is_file() else None})
        return {"entries": items, "truncated": truncated}

    @server.tool(annotations=read_only)
    async def inspect_video(video_path: str) -> dict[str, Any]:
        """Read duration, dimensions, frame rate, audio and rotation metadata."""
        info = await asyncio.to_thread(probe_video, ffmpeg, scope.resolve(video_path, existing=True))
        result = asdict(info)
        result.update(path=scope.relative(info.path), display_width=info.display_size[0], display_height=info.display_size[1])
        return result

    @server.tool(annotations=writes)
    def start_frame_extraction(
        video_path: str, output_directory: str, start: float = 0, end: float | None = None,
        interval: float = 1, grid_size: Literal[1, 2, 3] = 1,
        width: int | None = None, height: int | None = None,
        image_format: Literal["png", "jpg"] = "png", prefix: str = "frame", overwrite: bool = False,
    ) -> dict[str, Any]:
        """Start frame extraction. End is exclusive; null uses video duration.
        grid_size=1 saves individuals; 2/3 makes square sheets. Width/height are
        the FINAL image dimensions, not cell dimensions; omit both for original
        frame/cell size. Existing outputs are skipped unless overwrite=true.
        """
        source = scope.resolve(video_path, existing=True)
        output = scope.resolve(output_directory)
        if (width is None) != (height is None):
            raise ValueError("width와 height를 함께 지정하세요.")
        plan = resolve_size_plan(SIZE_MODES[0] if width is not None else SIZE_MODES[1],
                                 (width, height) if width is not None and height is not None else None,
                                 grid_size > 1, (grid_size, grid_size))

        def prepare(cancel):
            # Re-resolve before work to also catch moved/replaced parent links.
            info = probe_video(ffmpeg, scope.resolve(str(source), existing=True), cancel)
            request = ExtractionRequest(ffmpeg, source, scope.resolve(str(output)), prefix, image_format,
                                        start, info.duration if end is None else end, interval, overwrite,
                                        grid_size > 1, (grid_size, grid_size), plan)
            return request
        return present(service.start_extraction(prepare))

    @server.tool(annotations=writes)
    def start_video_edit(
        video_path: str, output_path: str, start: float = 0, end: float | None = None,
        width: int | None = None, height: int | None = None,
        crop: list[int] | None = None, rotation: Literal[0, 90, 180, 270] = 0,
        flip_horizontal: bool = False, flip_vertical: bool = False,
        speed: float = 1, mute: bool = False, overwrite: bool = False, crf: int = 20,
    ) -> dict[str, Any]:
        """Create an H.264/AAC MP4; input is never replaced.
        Order: trim, crop [x,y,width,height], clockwise rotation, flips, resize
        with letterboxing, speed adjustment. Crop uses auto-oriented input
        pixels. Explicit output sizes must be even. Speed is 0.25..4; audio
        tempo follows speed while preserving pitch. Null end means video end.
        """
        source = scope.resolve(video_path, existing=True)
        output = scope.resolve(output_path)
        if crop is not None and len(crop) != 4:
            raise ValueError("crop은 [x, y, width, height]여야 합니다.")

        def prepare(cancel):
            request = EditRequest(ffmpeg, scope.resolve(str(source), existing=True), scope.resolve(str(output)),
                                  start, end, width, height, tuple(crop) if crop is not None else None,
                                  rotation, flip_horizontal, flip_vertical, speed, mute, overwrite, crf)
            return request
        return present(service.start_edit(prepare))

    @server.tool(annotations=read_only)
    def get_job(job_id: str) -> dict[str, Any]:
        """Get queued/running/cancelling/completed/failed/cancelled status and outputs."""
        return present(jobs.get(job_id))

    @server.tool(annotations=read_only)
    def list_jobs() -> dict[str, Any]:
        """List up to 100 recent jobs; history is cleared on server restart."""
        return {"jobs": [present(job) for job in jobs.list()]}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
    def cancel_job(job_id: str) -> dict[str, Any]:
        """Request cancellation. Poll get_job until a terminal state.
        Cancellation before publication discards staged output. If publication
        already started, the job may complete and returns the committed files.
        """
        return present(jobs.cancel(job_id))

    @server.tool(annotations=read_only)
    async def read_image(image_path: str, max_width: int = 1280) -> Image:
        """Return a PNG/JPG preview as MCP image content so the agent can inspect it."""
        if not 64 <= max_width <= 2048:
            raise ValueError("max_width는 64~2048이어야 합니다.")
        path = scope.resolve(image_path, existing=True)
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            raise ValueError("PNG/JPG 파일만 미리 볼 수 있습니다.")

        def encode():
            with PillowImage.open(path) as source:
                if source.width * source.height > MAX_OUTPUT_PIXELS:
                    raise ValueError("미리보기 원본은 64메가픽셀 이하여야 합니다.")
                source.thumbnail((max_width, max_width))
                converted = source.convert("RGB")
                output = io.BytesIO()
                converted.save(output, format="JPEG", quality=85)
                return output.getvalue()
        return Image(data=await asyncio.to_thread(encode), format="jpeg")

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Local video tools MCP server (stdio)")
    parser.add_argument("--workspace", type=Path, required=True, help="Allowed input/output root folder")
    parser.add_argument("--ffmpeg", help="Optional explicit FFmpeg executable path")
    args = parser.parse_args()
    create_server(args.workspace, args.ffmpeg).run(transport="stdio")


if __name__ == "__main__":
    main()

