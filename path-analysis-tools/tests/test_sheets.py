import hashlib
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from path_analysis_tools.documents import ContractError, Workspace, load, loads, validate
from path_analysis_tools.preview import preview_path
from path_analysis_tools.schema_catalog import SCHEMAS
from path_analysis_tools.sheets import inspect_sheets, read_frame
from path_analysis_tools.paths import calculate_path
from helpers import observations


class SheetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Workspace(self.temporary.name)
        self.image = Image.new("RGB", (326, 326), "#eeeeee")
        self.colors = [(30 * i, 0, 255 - 20 * i) for i in range(9)]
        for i, color in enumerate(self.colors):
            x, y = 7 + (i % 3) * 106, 7 + (i // 3) * 106
            self.image.paste(color, (x, y, x + 100, y + 100))
        self.image.save(Path(self.temporary.name) / "sheet.png")
        self.spec = {"id": "sheet", "path": "sheet.png", "columns": 3, "rows": 3, "valid_cells": list(range(8))}

    def tearDown(self):
        self.temporary.cleanup()

    def test_padding_and_final_centering_crop_exact_pixels(self):
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        self.assertEqual(manifest["sheets"][0]["cells"][0]["rect"], [7, 7, 100, 100])
        for index in range(8):
            with Image.open(io.BytesIO(read_frame(self.workspace, manifest, f"sheet:{index}"))) as image:
                self.assertEqual(image.size, (100, 100))
                self.assertEqual(image.getpixel((0, 0)), self.colors[index])
                self.assertEqual(image.getpixel((99, 99)), self.colors[index])

    def test_last_unused_cell_cannot_be_read(self):
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        with self.assertRaises(ContractError):
            read_frame(self.workspace, manifest, "sheet:8")

    def test_explicit_black_cell_stays_valid(self):
        self.image.paste("black", (7, 7, 107, 107))
        self.image.save(Path(self.temporary.name) / "sheet.png")
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        with Image.open(io.BytesIO(read_frame(self.workspace, manifest, "sheet:0"))) as image:
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))

    def test_two_by_two_jpeg_and_last_valid_cell(self):
        sheet = Image.new('RGB', (219, 219), 'black')
        for i in range(3):
            x, y = 6+(i%2)*106, 6+(i//2)*106
            sheet.paste(self.colors[i], (x,y,x+100,y+100))
        sheet.save(self.workspace.root / 'sheet.jpg', quality=95)
        spec = {'id':'jpeg', 'path':'sheet.jpg', 'columns':2, 'rows':2, 'valid_cells':[0,1,2]}
        manifest = inspect_sheets(self.workspace, [spec], 'test')
        with Image.open(io.BytesIO(read_frame(self.workspace, manifest, 'jpeg:2'))) as cell:
            self.assertEqual(cell.size, (100,100))
            self.assertLessEqual(max(abs(a-b) for a,b in zip(cell.getpixel((50,50)), self.colors[2])), 3)
        with self.assertRaises(ContractError):
            read_frame(self.workspace, manifest, 'jpeg:3')

    def test_manifest_cannot_reintroduce_an_invalid_cell(self):
        manifest = inspect_sheets(self.workspace, [self.spec], 'test')
        manifest['sheets'][0]['valid_cells'].remove(7)
        with self.assertRaises(ContractError):
            read_frame(self.workspace, manifest, 'sheet:7')

    def test_explicit_rectangles_override_grid_formula(self):
        self.spec["cell_rects"] = [[7, 7, 10, 10] for _ in range(9)]
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        with Image.open(io.BytesIO(read_frame(self.workspace, manifest, "sheet:1"))) as image:
            self.assertEqual(image.size, (10, 10))
            self.assertEqual(image.getpixel((0, 0)), self.colors[0])

    def test_no_auto_valid_cell_guess(self):
        del self.spec["valid_cells"]
        with self.assertRaises(ContractError):
            inspect_sheets(self.workspace, [self.spec], "test")

    def test_source_change_requires_new_manifest(self):
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        self.image.paste("green", (7, 7, 107, 107))
        self.image.save(Path(self.temporary.name) / "sheet.png")
        with self.assertRaisesRegex(ContractError, "changed"):
            read_frame(self.workspace, manifest, "sheet:0")

    def test_timestamp_only_when_supplied(self):
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        self.assertNotIn("timestamp", manifest["sheets"][0]["cells"][0])
        self.spec.update(start_time=4, interval=0.5)
        manifest = inspect_sheets(self.workspace, [self.spec], "test")
        self.assertEqual(manifest["sheets"][0]["cells"][2]["timestamp"], 5)

    def test_outside_workspace_rejected(self):
        for path in ["../outside.json", "/etc/passwd"]:
            with self.subTest(path=path), self.assertRaises(ContractError):
                self.workspace.resolve(path)

    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as other:
            try:
                (Path(self.temporary.name) / "outside").symlink_to(other, target_is_directory=True)
            except OSError:
                self.skipTest("Symlink creation unavailable")
            with self.assertRaises(ContractError):
                self.workspace.write("outside/escaped.json", {})

    def test_atomic_json_write_is_readable(self):
        path = self.workspace.write("analysis/plan.json", {"x": [1, 2, 3]})
        self.assertEqual(load(self.workspace.resolve(path)), {"x": [1, 2, 3]})
        self.assertEqual(list(self.workspace.root.rglob(".path-analysis-*")), [])

    def test_duplicate_keys_and_nonfinite_json_rejected(self):
        for content in ['{"a":1,"a":2}', '{"a":NaN}']:
            path = self.workspace.root / "bad.json"
            path.write_text(content)
            with self.assertRaises(ContractError):
                load(path)
            with self.assertRaises(ContractError):
                loads(content)

    def test_schema_version_and_unknown_fields_rejected(self):
        document = observations()
        document["schema_version"] = 2
        with self.assertRaises(ContractError):
            validate(document)
        document["schema_version"] = 1
        document["secret_engine_connection"] = "not accepted"
        with self.assertRaises(ContractError):
            validate(document)

    def test_preview_has_top_and_side_image(self):
        with Image.open(io.BytesIO(preview_path(calculate_path(observations())))) as image:
            self.assertEqual(image.width, 1100)
            self.assertGreater(image.height, 250)


if __name__ == "__main__":
    unittest.main()
