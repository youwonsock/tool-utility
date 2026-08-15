import threading
import tempfile
import unittest
from pathlib import Path

from video_to_image_domain import SizePlan
from video_to_image_media import (
    ExtractionCancelled,
    ExtractionFailed,
    ExtractionRequest,
    FFmpegExtractionService,
    build_extraction_command,
)


class VideoToImageMediaTests(unittest.TestCase):
    def test_build_extraction_command_keeps_interval_and_grid_filter(self) -> None:
        request = ExtractionRequest(
            ffmpeg_path="ffmpeg.exe",
            video_path=Path("D:/videos/sample.mp4"),
            output_dir=Path("D:/captures"),
            prefix="scene",
            extension="png",
            start=2.5,
            end=10.0,
            interval=0.5,
            overwrite=True,
            group_mode=True,
            grid_size=(2, 2),
            size_plan=SizePlan((640, 360), (1298, 738), (1298, 738)),
        )

        command = build_extraction_command(request)
        self.assertEqual(command[0], "ffmpeg.exe")
        self.assertIn("-y", command)
        self.assertEqual(command[command.index("-ss") + 1], "2.500")
        self.assertEqual(command[command.index("-t") + 1], "7.500")
        self.assertIn("fps=2", command[command.index("-vf") + 1])
        self.assertIn("scale=640:360", command[command.index("-vf") + 1])
        self.assertIn("tile=2x2:padding=6:margin=6", command[command.index("-vf") + 1])
        self.assertEqual(command[-1], "-nostats")
        self.assertEqual(command[-4], "D:\\captures\\scene_%04d.png")

    def test_build_extraction_command_uses_no_overwrite_for_individual_jpg(self) -> None:
        request = ExtractionRequest(
            ffmpeg_path="ffmpeg.exe",
            video_path=Path("sample.mp4"),
            output_dir=Path("captures"),
            prefix="frame",
            extension="jpg",
            start=0,
            end=2,
            interval=1,
            overwrite=False,
            group_mode=False,
            grid_size=(1, 1),
            size_plan=SizePlan(None, None, None),
        )

        command = build_extraction_command(request)
        self.assertIn("-n", command)
        video_filter = command[command.index("-vf") + 1]
        self.assertEqual(video_filter, "fps=1")
        self.assertNotIn("tile=", video_filter)
        self.assertEqual(command[-4], "captures\\frame_%04d.jpg")

    def test_invalid_request_is_reported_as_failure_event(self) -> None:
        request = ExtractionRequest(
            ffmpeg_path="ffmpeg.exe",
            video_path=Path("sample.mp4"),
            output_dir=Path("captures"),
            prefix="frame",
            extension="png",
            start=0,
            end=2,
            interval=0,
            overwrite=False,
            group_mode=False,
            grid_size=(1, 1),
            size_plan=SizePlan(None, None, None),
        )
        events = []
        FFmpegExtractionService(request, threading.Event(), events.append).run()
        self.assertEqual(len(events), 1)
        self.assertIsInstance(events[0], ExtractionFailed)

    def test_cancelled_request_does_not_start_ffmpeg(self) -> None:
        request = ExtractionRequest(
            ffmpeg_path="ffmpeg.exe",
            video_path=Path("sample.mp4"),
            output_dir=Path("captures"),
            prefix="frame",
            extension="png",
            start=0,
            end=2,
            interval=1,
            overwrite=False,
            group_mode=False,
            grid_size=(1, 1),
            size_plan=SizePlan(None, None, None),
        )
        cancel_event = threading.Event()
        cancel_event.set()
        events = []
        FFmpegExtractionService(request, cancel_event, events.append).run()
        self.assertEqual(events, [ExtractionCancelled()])

    def test_finished_count_ignores_unchanged_existing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_dir = Path(temporary_directory)
            request = ExtractionRequest(
                ffmpeg_path="ffmpeg.exe",
                video_path=Path("sample.mp4"),
                output_dir=output_dir,
                prefix="frame",
                extension="png",
                start=0,
                end=2,
                interval=1,
                overwrite=True,
                group_mode=False,
                grid_size=(1, 1),
                size_plan=SizePlan(None, None, None),
            )
            service = FFmpegExtractionService(request, threading.Event(), lambda _event: None)
            existing_file = output_dir / "frame_0001.png"
            existing_file.write_bytes(b"old")
            previous = service._output_file_states()
            self.assertEqual(service._changed_output_files(previous), [])
            existing_file.write_bytes(b"new-content")
            new_file = output_dir / "frame_0002.png"
            new_file.write_bytes(b"new-content")
            self.assertEqual(service._new_output_files(previous), [new_file])

    def test_output_count_uses_processed_frames_for_overwrite_mode(self) -> None:
        request = ExtractionRequest(
            ffmpeg_path="ffmpeg.exe",
            video_path=Path("sample.mp4"),
            output_dir=Path("captures"),
            prefix="frame",
            extension="png",
            start=0,
            end=4,
            interval=1,
            overwrite=True,
            group_mode=True,
            grid_size=(2, 2),
            size_plan=SizePlan((64, 36), (146, 90), (146, 90)),
        )
        service = FFmpegExtractionService(request, threading.Event(), lambda _event: None)
        self.assertEqual(service._output_count({}, 4), 1)


if __name__ == "__main__":
    unittest.main()
