import importlib.util
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from video_to_image_backend import OperationCancelled, probe_video, run_ffmpeg
from video_to_image_domain import SIZE_MODES, resolve_size_plan
from video_to_image_edit import EditRequest, edit_video
from video_to_image_jobs import JobManager
from video_to_image_media import ExtractionRequest, extract_images
from media_test_support import make_video, test_ffmpeg

HAS_PIL = importlib.util.find_spec("PIL") is not None


@unittest.skipUnless(HAS_PIL, "Install requirements-mcp.txt for image integration tests")
class MediaIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.ffmpeg = test_ffmpeg()
        cls.source = cls.root / "source.mp4"
        make_video(cls.source, cls.ffmpeg)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.output = Path(tempfile.mkdtemp(dir=self.root))

    def request(self, **changes):
        request = ExtractionRequest(self.ffmpeg, self.source, self.output, "frame", "png",
                                    0, 4, 1, False, False, (1, 1),
                                    resolve_size_plan(SIZE_MODES[1], None, False, (1, 1)))
        return replace(request, **changes)

    def pixel(self, path, xy=(32, 18)):
        from PIL import Image
        with Image.open(path) as image:
            return image.convert("RGB").getpixel(xy)

    def test_sampling_selects_target_frames_and_excludes_end(self):
        result = extract_images(self.request())
        self.assertEqual(result.count, 4)
        self.assertEqual([self.pixel(p)[0] for p in result.files], [5, 55, 105, 155])

    def test_non_aligned_start_does_not_shift_later_targets(self):
        result = extract_images(self.request(start=0.35, end=1.35, interval=0.5))
        self.assertEqual([self.pixel(p)[0] for p in result.files], [25, 45])

    def test_grid_does_not_read_past_end_and_pads_missing_cells(self):
        plan = resolve_size_plan(SIZE_MODES[1], None, True, (2, 2))
        result = extract_images(self.request(end=1, group_mode=True, grid_size=(2, 2), size_plan=plan))
        self.assertEqual(result.count, 1)
        self.assertEqual(self.pixel(result.files[0], (38, 24)), (5, 5, 5))
        for xy in ((108, 24), (38, 66), (108, 66)):
            self.assertEqual(self.pixel(result.files[0], xy), (238, 238, 238))

    def test_overwrite_and_special_prefixes_report_real_saved_count(self):
        request = self.request(prefix="장면[1]%test")
        initial = extract_images(request)
        initial.files[0].write_bytes(b"preserve me")
        repeated = extract_images(request)
        self.assertEqual((repeated.count, repeated.skipped), (0, 4))
        self.assertEqual(initial.files[0].read_bytes(), b"preserve me")
        replaced = extract_images(replace(request, overwrite=True))
        self.assertEqual((replaced.count, replaced.skipped), (4, 0))
        self.assertEqual(self.pixel(initial.files[0])[0], 5)

    def test_grid_count_is_output_images_not_input_frames(self):
        plan = resolve_size_plan(SIZE_MODES[1], None, True, (2, 2))
        result = extract_images(self.request(interval=0.5, group_mode=True, grid_size=(2, 2),
                                             size_plan=plan, overwrite=True))
        self.assertEqual((result.count, result.generated), (2, 2))

    def test_jpg_odd_cell_geometry_keeps_requested_final_size(self):
        from PIL import Image
        plan = resolve_size_plan(SIZE_MODES[0], (1920, 1080), True, (2, 2))
        result = extract_images(self.request(extension="jpg", group_mode=True, grid_size=(2, 2), size_plan=plan))
        with Image.open(result.files[0]) as image:
            self.assertEqual(image.size, (1920, 1080))

    def test_short_video_retains_a_sample(self):
        short = self.output / "short.mp4"
        subprocess.run([self.ffmpeg, "-v", "error", "-y", "-i", str(self.source), "-t", "0.2",
                        "-c:v", "libx264rgb", "-crf", "0", "-an", str(short)],
                       check=True, capture_output=True, timeout=15)
        result = extract_images(self.request(video_path=short, end=0.2))
        self.assertEqual(result.count, 1)

    def test_ffmpeg_only_metadata_fallback(self):
        is_file = Path.is_file
        def without_ffprobe(path):
            return False if path.name in {"ffprobe", "ffprobe.exe"} else is_file(path)
        with patch("video_to_image_backend.shutil.which", return_value=None), \
             patch.object(Path, "is_file", without_ffprobe):
            info = probe_video(self.ffmpeg, self.source)
        self.assertEqual(info.probe_backend, "ffmpeg")
        self.assertEqual(info.display_size, (64, 36))
        self.assertAlmostEqual(info.duration, 4, delta=0.05)
        self.assertTrue(info.has_audio)

    def test_ffmpeg_only_rotation_metadata_and_oriented_crop(self):
        rotated = self.output / 'metadata-rotation.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-display_rotation', '90', '-i', str(self.source),
                        '-c', 'copy', str(rotated)], check=True, capture_output=True, timeout=30)
        with patch.dict('os.environ', {'VIDEO_TOOLS_FFMPEG_ONLY': '1'}):
            info = probe_video(self.ffmpeg, rotated)
            self.assertEqual(info.display_size, (36, 64))
            self.assertEqual(abs(info.rotation), 90)
            result = edit_video(EditRequest(self.ffmpeg, rotated, self.output / 'oriented.mp4',
                                           end=1, crop=(1, 1, 20, 30), mute=True))
        self.assertEqual((result['width'], result['height']), (20, 30))

    def test_ffmpeg_only_fractional_frame_rate(self):
        fractional = self.output / 'fractional.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-i', str(self.source), '-r', '30000/1001',
                        '-c:v', 'libx264', '-an', str(fractional)], check=True, capture_output=True, timeout=30)
        with patch.dict('os.environ', {'VIDEO_TOOLS_FFMPEG_ONLY': '1'}):
            info = probe_video(self.ffmpeg, fractional)
        self.assertEqual(info.probe_backend, 'ffmpeg')
        self.assertAlmostEqual(info.fps, 30000 / 1001, delta=.01)
        self.assertAlmostEqual(info.duration, 4, delta=.15)

    def test_edit_trim_resize_rotate_speed_and_audio(self):
        output = self.output / "edited.mp4"
        result = edit_video(EditRequest(self.ffmpeg, self.source, output, start=1, end=3,
                                       width=128, height=72, rotation=90, speed=2))
        self.assertAlmostEqual(result["duration"], 1, delta=0.12)
        self.assertEqual((result["width"], result["height"], result["has_audio"]), (128, 72, True))

    def test_edit_crop_mute_and_protect_source_and_existing_output(self):
        output = self.output / "crop.mp4"
        request = EditRequest(self.ffmpeg, self.source, output, end=1, crop=(0, 0, 32, 20), mute=True)
        result = edit_video(request)
        self.assertEqual((result["width"], result["height"], result["has_audio"]), (32, 20, False))
        original = output.read_bytes()
        with self.assertRaises(FileExistsError):
            edit_video(request)
        self.assertEqual(output.read_bytes(), original)
        with self.assertRaises(ValueError):
            edit_video(replace(request, output_path=self.source, overwrite=True))
        with self.assertRaises(ValueError):
            edit_video(replace(request, crop=(60, 0, 32, 20), output_path=self.output/"bad.mp4"))

    def test_rotation_changes_dimensions_and_flip_changes_image_content(self):
        rotated = edit_video(EditRequest(self.ffmpeg, self.source, self.output/"rotated.mp4",
                                        end=1, rotation=90, mute=True))
        self.assertEqual((rotated["width"], rotated["height"]), (36, 64))
        source = self.output / "two-halves.mp4"
        frame = (bytes([20]) * (32 * 3) + bytes([180]) * (32 * 3)) * 36
        subprocess.run([self.ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
                        "-video_size", "64x36", "-framerate", "10", "-i", "pipe:0",
                        "-c:v", "libx264rgb", "-crf", "0", str(source)],
                       input=frame*10, check=True, capture_output=True, timeout=15)
        flipped = self.output / "flipped.mp4"
        edit_video(EditRequest(self.ffmpeg, source, flipped, flip_horizontal=True, mute=True))
        metadata = probe_video(self.ffmpeg, flipped)
        self.assertAlmostEqual(metadata.fps, 10, delta=0.01)
        self.assertAlmostEqual(metadata.duration, 1, delta=0.02)
        image = extract_images(self.request(video_path=flipped, end=1)).files[0]
        self.assertGreater(self.pixel(image, (8, 18))[0], 160)
        self.assertLess(self.pixel(image, (56, 18))[0], 40)

    def test_audio_speed_limits_produce_expected_duration(self):
        for speed in (0.25, 4):
            with self.subTest(speed=speed):
                result = edit_video(EditRequest(self.ffmpeg, self.source, self.output/f"speed-{speed}.mp4",
                                               end=1, speed=speed))
                self.assertAlmostEqual(result["duration"], 1/speed, delta=0.15)
                self.assertTrue(result["has_audio"])

    def test_encoding_failure_retains_ffmpeg_error_and_preserves_existing_file(self):
        request = self.request(overwrite=True)
        existing = self.output / "frame_0001.png"
        existing.write_bytes(b"keep")
        with patch("video_to_image_media.run_ffmpeg", side_effect=RuntimeError("encoder failure")), self.assertRaisesRegex(RuntimeError, "encoder failure"):
            extract_images(request)
        self.assertEqual(existing.read_bytes(), b"keep")
        self.assertFalse(list(self.output.glob(".video-to-image-*")))


class CancellationTests(unittest.TestCase):
    def test_process_error_preserves_stderr_detail(self):
        with self.assertRaisesRegex(RuntimeError, "intentional encoder error"):
            run_ffmpeg([sys.executable, "-c", "import sys; sys.stderr.write('intentional encoder error'); sys.exit(7)"],
                       threading.Event(), 1, lambda *_: None)

    def test_silent_process_is_cancelled_without_waiting_for_stdout(self):
        cancel = threading.Event()
        timer = threading.Timer(0.15, cancel.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(OperationCancelled):
                run_ffmpeg([sys.executable, "-c", "import time; time.sleep(30)"], cancel, 30, lambda *_: None)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 5)

    def test_queued_and_running_jobs_cancel_and_shutdown(self):
        jobs = JobManager(workers=1)
        def operation(cancel, progress):
            cancel.wait(5)
            if cancel.is_set():
                raise OperationCancelled()
            return {}
        first = jobs.submit("test", operation)
        second = jobs.submit("test", operation)
        jobs.cancel(second["job_id"])
        jobs.cancel(first["job_id"])
        jobs.close()
        self.assertEqual(jobs.get(first["job_id"])["status"], "cancelled")
        self.assertEqual(jobs.get(second["job_id"])["status"], "cancelled")

