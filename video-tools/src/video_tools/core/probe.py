"""Read video and image information and encode previews with FFmpeg."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import threading
from typing import Optional

from video_tools.core.process import capture


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


def probe_video(ffmpeg: str, video_path: Path, cancel_event: Optional[threading.Event] = None) -> VideoInfo:
    """Read metadata with FFmpeg alone on both supported platforms."""
    if not video_path.is_file():
        raise ValueError(f"영상 파일을 찾을 수 없습니다: {video_path}")
    _, _, output = capture([ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe",
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
    _, _, output = capture([ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe",
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
    code, stdout, stderr = capture([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                                     "-protocol_whitelist", "file,pipe", "-i", str(image_path),
                                     "-vf", scale, "-frames:v", "1", "-f", "image2pipe",
                                     "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], None, binary=True)
    if code or not stdout.startswith(b"\xff\xd8\xff"):
        raise ValueError("미리보기 이미지를 만들지 못했습니다.\n" + stderr.decode("utf-8", "replace")[-2000:])
    return stdout
