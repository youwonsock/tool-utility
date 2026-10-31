import unittest
from dataclasses import replace
from pathlib import Path

from video_tools.core.domain import SizePlan
from video_tools.core.media import ExtractionRequest, build_extraction_command, validate_request

REQUEST = ExtractionRequest(
    ffmpeg_path="ffmpeg", video_path=Path("source.mp4"), output_dir=Path("staged"), prefix="frame %d [1]",
    extension="png", start=0, end=10, interval=1, overwrite=False, group_mode=False, grid_size=(1, 1),
    size_plan=SizePlan(None, None, None),
)


class ValidationTest(unittest.TestCase):
    def rejected(self, **changes):
        with self.assertRaises(ValueError):
            validate_request(replace(REQUEST, **changes))

    def test_returns_the_sample_count(self):
        self.assertEqual(validate_request(REQUEST), 10)

    def test_invalid_times(self):
        for changes in ({"start": -1}, {"start": 10}, {"end": 0}, {"interval": .0009},
                        {"end": float("inf")}, {"interval": float("nan")}):
            with self.subTest(changes):
                self.rejected(**changes)

    def test_format_and_grid(self):
        self.rejected(extension="webp")
        self.rejected(group_mode=True, grid_size=(4, 4))
        validate_request(replace(REQUEST, group_mode=True, grid_size=(3, 3)))

    def test_pixel_limit_per_image(self):
        self.rejected(size_plan=SizePlan((8193, 8192), None, (8193, 8192)))
        self.rejected(size_plan=SizePlan((0, 10), None, (0, 10)))
        validate_request(replace(REQUEST, size_plan=SizePlan((8192, 8192), None, (8192, 8192))))

    def test_sample_limit(self):
        validate_request(replace(REQUEST, end=10000))
        self.rejected(end=10001)


class CommandTest(unittest.TestCase):
    def test_user_text_stays_out_of_the_image_pattern(self):
        command = build_extraction_command(REQUEST)
        self.assertEqual(Path(command[-1]).name, "frame_%06d.png")
        self.assertFalse(any("[1]" in part for part in command))

    def test_stream_selection(self):
        self.assertEqual(build_extraction_command(REQUEST)[build_extraction_command(REQUEST).index("-map") + 1], "0:v:0")
        command = build_extraction_command(REQUEST, 2)
        self.assertEqual(command[command.index("-map") + 1], "0:2")

    def test_pixel_format_follows_the_extension(self):
        command = build_extraction_command(REQUEST)
        self.assertEqual(command[command.index("-pix_fmt") + 1], "rgb24")
        command = build_extraction_command(replace(REQUEST, extension="jpg"))
        self.assertEqual(command[command.index("-pix_fmt") + 1], "yuvj444p")

    def test_only_local_protocols_are_allowed(self):
        command = build_extraction_command(REQUEST)
        self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file,pipe")
