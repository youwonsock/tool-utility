from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from check_updates import newest, parse_lock, parse_npm_lock, report_body, version_key


class CheckUpdatesTest(unittest.TestCase):
    def test_lock_entries_without_hashes_or_comments(self):
        text = "# comment\nannotated-types==0.8.0 \\\n    --hash=sha256:abc\nPillow==12.3.0\n"
        self.assertEqual(parse_lock(text), {"annotated-types": "0.8.0", "pillow": "12.3.0"})

    def test_environment_markers_are_not_part_of_the_version(self):
        self.assertEqual(parse_lock('pywin32==312; sys_platform == "win32" \\\n'), {"pywin32": "312"})

    def test_npm_lock_keeps_nested_copies_and_skips_the_root(self):
        text = """{"packages": {"": {"version": "1.0.0"},
            "node_modules/@scope/a": {"version": "2.0.0"},
            "node_modules/@scope/a/node_modules/b": {"version": "1.0.0"},
            "node_modules/b": {"version": "3.0.0"}}}"""
        self.assertEqual(parse_npm_lock(text), [("@scope/a", "2.0.0"), ("b", "1.0.0"), ("b", "3.0.0")])

    def test_versions_compare_as_numbers(self):
        self.assertEqual(newest(["7.1.9", "7.1.10", "7.1.5"]), "7.1.10")
        self.assertIsNone(newest([]))
        self.assertGreater(version_key("1.3.2"), version_key("1.3"))

    def test_the_report_lists_only_sections_with_items(self):
        body = report_body(["`a` 1: X"], [], ["zlib: 실패"])
        self.assertIn("## 취약점이 보고된 패키지", body)
        self.assertIn("- zlib: 실패", body)
        self.assertNotIn("새 버전", body)
