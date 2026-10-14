"""Parity must detect geometry, count and pixels outside the old sample point."""
import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

from media_test_support import image_signature
from verify_portable import compare_frame_signatures


@unittest.skipUnless(importlib.util.find_spec('PIL'), 'Install requirements-mcp.txt for image verification tests')
class ImageParityTests(unittest.TestCase):
    def test_count_geometry_and_corner_pixel_mismatches_are_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new('RGB', (64, 36), (5, 5, 5))
            baseline = root / 'baseline.png'
            image.save(baseline)
            changed = image.copy()
            changed.putpixel((0, 0), (255, 0, 0))
            self.assertEqual(image.getpixel((32, 18)), changed.getpixel((32, 18)))
            corner = root / 'corner.png'
            changed.save(corner)
            larger = root / 'larger.png'
            Image.new('RGB', (128, 72), (5, 5, 5)).save(larger)
            expected = [image_signature(baseline)]
            compare_frame_signatures([image_signature(baseline)], expected)
            with self.assertRaisesRegex(RuntimeError, 'pixel mismatch'):
                compare_frame_signatures([image_signature(corner)], expected)
            with self.assertRaisesRegex(RuntimeError, 'geometry mismatch'):
                compare_frame_signatures([image_signature(larger)], expected)
            with self.assertRaisesRegex(RuntimeError, 'count mismatch'):
                compare_frame_signatures(expected * 2, expected)

    def test_png_container_metadata_does_not_change_rgb_signature(self):
        from PIL import Image, PngImagePlugin
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new('RGB', (3, 3), (17, 25, 40))
            first, second = root / 'first.png', root / 'second.png'
            image.save(first, compress_level=0)
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text('note', 'same pixels in a different PNG container')
            image.save(second, compress_level=9, pnginfo=metadata)
            self.assertNotEqual(first.read_bytes(), second.read_bytes())
            signature = {'size': [3, 3], 'rgb_sha256': hashlib.sha256(bytes([17, 25, 40]) * 9).hexdigest()}
            self.assertEqual(image_signature(first), signature)
            self.assertEqual(image_signature(second), signature)
