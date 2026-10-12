import tempfile
import threading
import unittest
from pathlib import Path
from dataclasses import replace

from video_to_image_backend import publish_file
from video_to_image_domain import SizePlan
from video_to_image_media import (
    ExtractionCancelled, ExtractionFailed, ExtractionRequest, FFmpegExtractionService,
    validate_request,
)


class VideoToImageMediaTests(unittest.TestCase):
    def request(self, **changes):
        base = ExtractionRequest("ffmpeg", Path("source.mp4"), Path("captures"),
                                 "frame", "png", 0, 2, 1, False, False, (1, 1), SizePlan(None, None, None))
        return replace(base, **changes)

    def test_invalid_request_is_reported_without_starting_ffmpeg(self):
        events = []
        FFmpegExtractionService(self.request(interval=0), threading.Event(), events.append).run()
        self.assertIsInstance(events[-1], ExtractionFailed)

    def test_cancelled_request_does_not_start_ffmpeg(self):
        cancel = threading.Event()
        cancel.set()
        events = []
        FFmpegExtractionService(self.request(), cancel, events.append).run()
        self.assertEqual(events, [ExtractionCancelled()])

    def test_unbounded_or_invalid_requests_are_rejected(self):
        for change in ({"interval": float("nan")}, {"start": -1}, {"end": 0},
                       {"interval": 0.0001}, {"end": 10001}, {"extension": "exe"},
                       {"size_plan": SizePlan((100000, 100000), None, None)}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_request(self.request(**change))

    def test_publication_preserves_existing_file_and_can_explicitly_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, target = Path(directory)/"stage", Path(directory)/"result"
            staged.write_bytes(b"new")
            target.write_bytes(b"old")
            self.assertFalse(publish_file(staged, target, False))
            self.assertEqual(target.read_bytes(), b"old")
            self.assertTrue(publish_file(staged, target, True))
            self.assertEqual(target.read_bytes(), b"new")

