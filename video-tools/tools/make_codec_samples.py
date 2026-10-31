"""Write short sample videos covering the supported input codecs.

Encoding them needs a full-featured FFmpeg (libx265, libvpx, libaom, libopus,
libvorbis, libmp3lame), such as the build the runtime bundled before
tools/build_ffmpeg.py; the minimal build only decodes these formats.
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

SOURCE = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=2",
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"]
SAMPLES = {
    "h264_aac.mp4": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    "hevc_ac3.mp4": ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "ac3"],
    "vp9_opus.webm": ["-c:v", "libvpx-vp9", "-c:a", "libopus"],
    "vp8_vorbis.webm": ["-c:v", "libvpx", "-c:a", "libvorbis"],
    "av1_opus.mkv": ["-c:v", "libaom-av1", "-cpu-used", "8", "-c:a", "libopus"],
    "prores_pcm.mov": ["-c:v", "prores_ks", "-c:a", "pcm_s16le"],
    "prores_pcm24be.mov": ["-c:v", "prores_ks", "-c:a", "pcm_s24be"],
    "mjpeg_pcm.avi": ["-c:v", "mjpeg", "-q:v", "3", "-c:a", "pcm_s16le"],
    "mpeg4_mp3.avi": ["-c:v", "mpeg4", "-c:a", "libmp3lame"],
    "mpeg2_eac3.mkv": ["-c:v", "mpeg2video", "-c:a", "eac3"],
    "mpeg2_mp2.mkv": ["-c:v", "mpeg2video", "-c:a", "mp2"],
    "h264_flac.mkv": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "flac"],
    "h264_alac.m4v": ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "alac"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ffmpeg", type=Path, help="Full-featured FFmpeg used only to encode the samples")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    # Windows does not resolve a relative executable path written with slashes.
    base = [str(args.ffmpeg.resolve()), "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    for name, codec in SAMPLES.items():
        subprocess.run(base + SOURCE + codec + ["-shortest", str(args.output / name)], check=True)
    # Display-matrix rotation exercises probe rotation and FFmpeg's autorotate filters.
    subprocess.run(base + ["-display_rotation:v", "90", "-i", str(args.output / "h264_aac.mp4"), "-c", "copy",
                           str(args.output / "rotated_h264.mov")], check=True)


if __name__ == "__main__":
    main()
