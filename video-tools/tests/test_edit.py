import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from video_tools.core.backend import VideoInfo
from video_tools.core.edit import EditRequest, _tempo_chain, build_edit_command, validate_edit


class EditTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "source.mp4"
        self.source.touch()
        self.info = VideoInfo(self.source, 10, 1280, 720, 30, True, "h264")
        self.request = EditRequest(video_path=self.source, output_path=self.root / "out.mp4")

    def rejected(self, **changes):
        with self.assertRaises((ValueError, FileExistsError)):
            validate_edit(replace(self.request, **changes), self.info)

    def test_full_range_by_default(self):
        self.assertEqual(validate_edit(self.request, self.info), (10, 10))

    def test_speed_changes_the_output_duration(self):
        self.assertEqual(validate_edit(replace(self.request, start=2, end=6, speed=2), self.info), (6, 2))

    def test_invalid_ranges(self):
        for changes in ({"start": -1}, {"start": 10}, {"start": 5, "end": 5}, {"start": 5, "end": 4},
                        {"end": 10.1}, {"start": float("nan")}, {"end": float("inf")}):
            with self.subTest(changes):
                self.rejected(**changes)

    def test_duration_tolerance(self):
        validate_edit(replace(self.request, end=10.05), self.info)

    def test_speed_limits(self):
        validate_edit(replace(self.request, speed=.25), self.info)
        validate_edit(replace(self.request, speed=4), self.info)
        for speed in (.24, 4.1, 0):
            with self.subTest(speed):
                self.rejected(speed=speed)

    def test_rotation_and_crf_limits(self):
        for rotation in (0, 90, 180, 270):
            validate_edit(replace(self.request, rotation=rotation), self.info)
        self.rejected(rotation=45)
        self.rejected(crf=-1)
        self.rejected(crf=52)

    def test_output_path_rules(self):
        self.rejected(output_path=self.root / "out.mov")
        self.rejected(output_path=self.source)
        existing = self.root / "existing.mp4"
        existing.touch()
        self.rejected(output_path=existing)
        validate_edit(replace(self.request, output_path=existing, overwrite=True), self.info)

    def test_explicit_size_rules(self):
        self.rejected(width=640)
        self.rejected(height=360)
        self.rejected(width=641, height=360)
        self.rejected(width=640, height=361)
        self.rejected(width=0, height=360)
        validate_edit(replace(self.request, width=640, height=360), self.info)

    def test_output_pixel_limit(self):
        self.rejected(width=8194, height=8192)
        validate_edit(replace(self.request, width=8192, height=8192), self.info)

    def test_crop_stays_inside_the_oriented_frame(self):
        validate_edit(replace(self.request, crop=(0, 0, 1280, 720)), self.info)
        for crop in ((-1, 0, 10, 10), (0, 0, 0, 10), (1, 0, 1280, 720), (0, 1, 1280, 720)):
            with self.subTest(crop):
                self.rejected(crop=crop)
        rotated = replace(self.info, rotation=90)
        validate_edit(replace(self.request, crop=(0, 0, 720, 1280)), rotated)
        with self.assertRaises(ValueError):
            validate_edit(replace(self.request, crop=(0, 0, 1280, 720)), rotated)

    def test_tempo_chain_stays_within_atempo_limits(self):
        self.assertEqual(_tempo_chain(1), "atempo=1")
        self.assertEqual(_tempo_chain(4), "atempo=2,atempo=2")
        self.assertEqual(_tempo_chain(.25), "atempo=0.5,atempo=0.5")

    def command(self, **changes):
        return build_edit_command("ffmpeg", replace(self.request, **changes), self.info, self.root / "staged.mp4")

    def video_filter(self, **changes):
        command = self.command(**changes)
        return command[command.index("-vf") + 1]

    def test_filter_order_is_crop_rotate_flip_resize(self):
        text = self.video_filter(crop=(0, 0, 100, 100), rotation=90, flip_horizontal=True, width=64, height=36)
        positions = [text.index(part) for part in ("crop=100:100:0:0", "transpose=clock", "hflip", "scale=64:36", "pad=64:36")]
        self.assertEqual(positions, sorted(positions))

    def test_rotation_filters(self):
        self.assertIn("transpose=cclock", self.video_filter(rotation=270))
        self.assertIn("hflip,vflip", self.video_filter(rotation=180))

    def test_output_is_even_without_an_explicit_size(self):
        self.assertIn("pad=ceil(iw/2)*2:ceil(ih/2)*2", self.video_filter())

    def test_audio_follows_mute_and_source(self):
        self.assertIn("aac", self.command())
        self.assertIn("-an", self.command(mute=True))
        self.assertNotIn("-an", self.command())
        silent = build_edit_command("ffmpeg", self.request, replace(self.info, has_audio=False), self.root / "staged.mp4")
        self.assertIn("-an", silent)

    def test_output_duration_and_target(self):
        command = self.command(start=2, end=6, speed=2)
        self.assertEqual(float(command[command.index("-t") + 1]), 2)
        self.assertEqual(command[-1], str(self.root / "staged.mp4"))
