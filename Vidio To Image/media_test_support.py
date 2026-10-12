"""Small deterministic videos for actual-encoder regression tests."""
import os
import subprocess
from pathlib import Path
from video_to_image_backend import find_ffmpeg


def test_ffmpeg():
    return os.environ.get("VIDEO_TOOLS_TEST_FFMPEG") or find_ffmpeg()


def make_video(path: Path, ffmpeg: str, seconds: int = 4, audio: bool = True):
    raw = b"".join(bytes([5 + 5 * (index % 40)]) * (64 * 36 * 3) for index in range(seconds * 10))
    command = [ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
               "-video_size", "64x36", "-framerate", "10", "-i", "pipe:0"]
    if audio:
        command += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    command += ["-c:v", "libx264rgb", "-crf", "0"]
    if audio:
        command += ["-c:a", "aac"]
    command += ["-t", str(seconds), str(path)]
    subprocess.run(command, input=raw, check=True, capture_output=True, timeout=30)

