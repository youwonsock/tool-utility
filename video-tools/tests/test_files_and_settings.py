import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from video_tools.core.backend import publish_file
from video_tools.core.settings import AppSettings, EditingSettings, load_settings, save_settings, settings_from_dict
from video_tools.mcp.server import Workspace


class TemporaryFolderTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()


class PublishTest(TemporaryFolderTest):
    def setUp(self):
        super().setUp()
        self.staged = self.root / "staged"
        self.staged.write_text("new", encoding="utf-8")
        self.target = self.root / "target"

    def test_new_file(self):
        self.assertTrue(publish_file(self.staged, self.target, False))
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new")

    def test_existing_file_is_kept(self):
        self.target.write_text("old", encoding="utf-8")
        self.assertFalse(publish_file(self.staged, self.target, False))
        self.assertEqual(self.target.read_text(encoding="utf-8"), "old")

    def test_overwrite_replaces_it(self):
        self.target.write_text("old", encoding="utf-8")
        self.assertTrue(publish_file(self.staged, self.target, True))
        self.assertEqual(self.target.read_text(encoding="utf-8"), "new")


class WorkspaceTest(TemporaryFolderTest):
    def setUp(self):
        super().setUp()
        self.workspace = Workspace(self.root / "작업 폴더")

    def test_relative_and_inner_absolute_paths(self):
        expected = self.workspace.root / "a" / "b.mp4"
        self.assertEqual(self.workspace.resolve("a/b.mp4"), expected)
        self.assertEqual(self.workspace.resolve(str(expected)), expected)
        self.assertEqual(self.workspace.relative(expected), "a/b.mp4")

    def test_outside_paths_are_refused(self):
        for path in ("../outside.mp4", "a/../../outside.mp4", str(self.root / "outside.mp4"), "", "  "):
            with self.subTest(path), self.assertRaises(ValueError):
                self.workspace.resolve(path)

    def test_links_leaving_the_workspace_are_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, self.workspace.root / "link", target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"Symbolic links are unavailable: {exc}")
        with self.assertRaises(ValueError):
            self.workspace.resolve("link/file.mp4")

    def test_existing_requires_a_file(self):
        with self.assertRaises(ValueError):
            self.workspace.resolve("missing.mp4", existing=True)
        (self.workspace.root / "present.mp4").touch()
        self.workspace.resolve("present.mp4", existing=True)


class SettingsTest(TemporaryFolderTest):
    def test_round_trip(self):
        path = self.root / "folder" / "settings.json"
        settings = replace(AppSettings(), prefix="이름", interval="0.5", overwrite=True,
                           editing=replace(EditingSettings(), rotation="90", mute=True))
        self.assertTrue(save_settings(settings, path))
        self.assertEqual(load_settings(path), settings)
        self.assertEqual([item.name for item in path.parent.iterdir()], ["settings.json"])

    def test_unreadable_files_use_defaults(self):
        self.assertEqual(load_settings(self.root / "missing.json"), AppSettings())
        for text in ("not json", "[1]"):
            path = self.root / "settings.json"
            path.write_text(text, encoding="utf-8")
            self.assertEqual(load_settings(path), AppSettings())

    def test_invalid_values_use_defaults(self):
        raw = {"format": "webp", "interval": "-1", "output_mode": "없음", "grid_size": "9 × 9", "size_mode": "없음",
               "size_preset": "없음", "overwrite": "yes", "geometry": 3, "prefix": True,
               "editing": {"rotation": "45", "mute": "yes", "crf": 20}}
        settings = settings_from_dict(raw)
        defaults = AppSettings()
        for name in ("format", "interval", "output_mode", "grid_size", "size_mode", "size_preset",
                     "overwrite", "geometry", "prefix"):
            self.assertEqual(getattr(settings, name), getattr(defaults, name), name)
        self.assertEqual(settings.editing, EditingSettings())

    def test_preset_must_belong_to_the_mode(self):
        cell_only = settings_from_dict({"size_mode": AppSettings().size_mode, "size_preset": "원본"})
        self.assertEqual(cell_only.size_preset, AppSettings().size_preset)

    def test_unknown_keys_are_ignored(self):
        path = self.root / "settings.json"
        path.write_text(json.dumps({"removed_option": 1, "prefix": "유지"}), encoding="utf-8")
        self.assertEqual(load_settings(path).prefix, "유지")
