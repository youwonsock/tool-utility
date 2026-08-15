import json
import tempfile
import unittest
from pathlib import Path

from video_to_image_domain import GRID_OUTPUT_MODE, SIZE_MODES
from video_to_image_settings import AppSettings, load_settings, save_settings, settings_from_dict


class VideoToImageSettingsTests(unittest.TestCase):
    def test_settings_round_trip_preserves_current_values(self) -> None:
        settings = AppSettings(
            output="D:/captures",
            prefix="scene",
            format="JPG",
            interval="0.5",
            output_mode="개별 이미지 저장",
            grid_size="2 × 2",
            size_mode=SIZE_MODES[1],
            size_preset="사용자 지정",
            size_width="640",
            size_height="360",
            overwrite=True,
            geometry="900x700+10+20",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "settings.json"
            self.assertTrue(save_settings(settings, path))
            self.assertEqual(load_settings(path), settings)

    def test_legacy_settings_are_migrated(self) -> None:
        final_settings = settings_from_dict(
            {
                "output_mode": "9초씩 3 × 3 합치기",
                "resolution": "1920 × 1080",
                "sheet_size": "1920 × 1080 이하",
            }
        )
        self.assertEqual(final_settings.output_mode, GRID_OUTPUT_MODE)
        self.assertEqual(final_settings.size_mode, SIZE_MODES[0])
        self.assertEqual(final_settings.size_preset, "1920 × 1080")

        cell_settings = settings_from_dict(
            {
                "resolution": "640 × 360",
                "sheet_size": "제한 없음",
            }
        )
        self.assertEqual(cell_settings.size_mode, SIZE_MODES[1])
        self.assertEqual(cell_settings.size_preset, "640 × 360")

    def test_invalid_or_missing_settings_fall_back_to_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "settings.json"
            self.assertEqual(load_settings(path), AppSettings())
            path.write_text("not json", encoding="utf-8")
            self.assertEqual(load_settings(path), AppSettings())
            path.write_text(json.dumps({"grid_size": "5 × 5"}), encoding="utf-8")
            loaded = load_settings(path)
            self.assertEqual(loaded.grid_size, "3 × 3")
            path.write_bytes(b"\xff\xfe")
            self.assertEqual(load_settings(path), AppSettings())

    def test_invalid_current_values_are_normalized(self) -> None:
        settings = settings_from_dict(
            {
                "format": "bmp",
                "interval": "0",
                "size_mode": "알 수 없는 모드",
                "size_preset": "알 수 없는 크기",
            }
        )
        self.assertEqual(settings.format, "PNG")
        self.assertEqual(settings.interval, "1")
        self.assertEqual(settings.size_mode, SIZE_MODES[0])
        self.assertEqual(settings.size_preset, "1920 × 1080")

    def test_save_does_not_leave_temporary_settings_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "settings.json"
            self.assertTrue(save_settings(AppSettings(), path))
            self.assertFalse(path.with_name(f".{path.name}.tmp").exists())


if __name__ == "__main__":
    unittest.main()
