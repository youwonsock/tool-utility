from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import build_ffmpeg

ITEM = {"url": "https://upstream.example/x264.tar.bz2", "sha256": "abc"}
MIRRORED = build_ffmpeg.json.loads(build_ffmpeg.MIRROR.read_text(encoding="utf-8"))["base_url"] + "x264.tar.bz2"


class FetchSourceTest(unittest.TestCase):
    def test_upstream_is_used_when_it_works(self):
        with mock.patch.object(build_ffmpeg, "download", return_value=Path("a")) as download:
            self.assertEqual(build_ffmpeg.fetch_source(ITEM), Path("a"))
        download.assert_called_once_with(ITEM["url"], "abc")

    def test_mirror_keeps_the_pinned_hash(self):
        for failure in (RuntimeError("checksum"), subprocess.CalledProcessError(22, "curl")):
            with self.subTest(failure), mock.patch.object(build_ffmpeg, "download", side_effect=[failure, Path("b")]) as download:
                self.assertEqual(build_ffmpeg.fetch_source(ITEM), Path("b"))
                download.assert_called_with(MIRRORED, "abc")

    def test_mirror_failure_is_reported(self):
        with mock.patch.object(build_ffmpeg, "download", side_effect=RuntimeError("checksum")):
            with self.assertRaises(RuntimeError):
                build_ffmpeg.fetch_source(ITEM)
