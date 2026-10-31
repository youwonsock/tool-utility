import unittest

from video_tools.core.domain import (
    SIZE_MODES, SizePlan, build_video_filter, calculate_expected_output_count, calculate_final_grid_geometry,
    calculate_sheet_size, resolve_size_plan, safe_prefix,
)
from video_tools.gui.options import (
    format_time, parse_grid_layout, parse_positive_float, parse_positive_int, parse_time, resolve_preview_plan,
)

FINAL, CELL = SIZE_MODES


class ParsingTest(unittest.TestCase):
    def test_positive_numbers(self):
        self.assertEqual(parse_positive_float(" 0.5 ", "간격"), 0.5)
        self.assertEqual(parse_positive_int("12", "너비"), 12)
        for text in ("", "0", "-1", "abc", "inf", "nan"):
            with self.subTest(text), self.assertRaises(ValueError):
                parse_positive_float(text, "간격")
        for text in ("", "0", "-1", "1.5"):
            with self.subTest(text), self.assertRaises(ValueError):
                parse_positive_int(text, "너비")

    def test_time_formats(self):
        self.assertEqual(parse_time("90.5"), 90.5)
        self.assertEqual(parse_time("01:30"), 90)
        self.assertEqual(parse_time("01:00:00.5"), 3600.5)
        for text in ("", "1:2:3:4", "00:60", "00:00:60", "-1:00", "a:b"):
            with self.subTest(text), self.assertRaises(ValueError):
                parse_time(text)

    def test_time_display(self):
        self.assertEqual(format_time(3661), "01:01:01")
        self.assertEqual(format_time(1.5), "00:00:01.500")
        self.assertEqual(parse_time(format_time(3723.25)), 3723.25)

    def test_grid_layout(self):
        self.assertEqual(parse_grid_layout("2 × 2"), (2, 2))
        self.assertEqual(parse_grid_layout("3 × 3"), (3, 3))
        with self.assertRaises(ValueError):
            parse_grid_layout("4 × 4")

    def test_prefix_is_safe_for_every_supported_file_system(self):
        self.assertEqual(safe_prefix('a<b>:c"d/e\\f|g?h*', "x"), "a_b__c_d_e_f_g_h_")
        self.assertEqual(safe_prefix("  ", "대체"), "대체")
        self.assertEqual(safe_prefix("...", "x"), "frame")


class GeometryTest(unittest.TestCase):
    def test_sheet_adds_padding_and_margin(self):
        self.assertEqual(calculate_sheet_size((100, 50), (2, 2)), (218, 118))

    def test_final_size_fits_the_cells(self):
        cell, tiled = calculate_final_grid_geometry((1920, 1080), (3, 3))
        self.assertEqual(cell, (632, 352))
        self.assertLessEqual(tiled[0], 1920)
        self.assertLessEqual(tiled[1], 1080)

    def test_final_size_too_small(self):
        with self.assertRaises(ValueError):
            calculate_final_grid_geometry((20, 20), (3, 3))

    def test_individual_images_ignore_the_mode(self):
        for mode in SIZE_MODES:
            self.assertEqual(resolve_size_plan(mode, (64, 36), False, (1, 1)), SizePlan((64, 36), None, (64, 36)))

    def test_final_mode_keeps_the_requested_output(self):
        plan = resolve_size_plan(FINAL, (1920, 1080), True, (3, 3))
        self.assertEqual(plan.output_size, (1920, 1080))
        self.assertEqual(plan.frame_size, (632, 352))

    def test_final_mode_needs_a_size(self):
        with self.assertRaises(ValueError):
            resolve_size_plan(FINAL, None, True, (3, 3))

    def test_cell_mode_grows_the_output(self):
        self.assertEqual(resolve_size_plan(CELL, (100, 50), True, (2, 2)), SizePlan((100, 50), (218, 118), (218, 118)))
        self.assertEqual(resolve_size_plan(CELL, None, True, (2, 2)), SizePlan(None, None, None))

    def test_unknown_mode(self):
        with self.assertRaises(ValueError):
            resolve_size_plan("없는 모드", (1, 1), False, (1, 1))

    def test_preview_uses_a_sample_for_original_sizes(self):
        self.assertTrue(resolve_preview_plan(CELL, None, True, (2, 2)).uses_sample_size)
        plan = resolve_preview_plan(FINAL, (1920, 1080), False, (3, 3))
        self.assertEqual((plan.grid_size, plan.output_size, plan.uses_sample_size), ((1, 1), (1920, 1080), False))


class CountTest(unittest.TestCase):
    def test_samples_round_up(self):
        self.assertEqual(calculate_expected_output_count(0, 2, .5, False, (1, 1)), 4)
        self.assertEqual(calculate_expected_output_count(0, 2.1, .5, False, (1, 1)), 5)
        self.assertEqual(calculate_expected_output_count(1, 1.1, 5, False, (1, 1)), 1)

    def test_grids_round_up(self):
        self.assertEqual(calculate_expected_output_count(0, 5, 1, True, (2, 2)), 2)
        self.assertEqual(calculate_expected_output_count(0, 9, 1, True, (3, 3)), 1)


class FilterTest(unittest.TestCase):
    def test_trim_precedes_sampling_so_the_last_sheet_stays_in_range(self):
        text = build_video_filter(.5, True, (2, 2), SizePlan(None, None, None), 2)
        self.assertLess(text.index("trim=start=0:end=2.000000000"), text.index("fps=2"))
        self.assertIn("trim=end_frame=4", text)
        self.assertLess(text.index("trim=end_frame=4"), text.index("tile=2x2"))

    def test_scale_keeps_the_aspect_ratio_inside_the_cell(self):
        text = build_video_filter(1, False, (1, 1), SizePlan((64, 36), None, (64, 36)))
        self.assertIn("scale=64:36:force_original_aspect_ratio=decrease,pad=64:36", text)
        self.assertNotIn("tile=", text)

    def test_original_size_adds_no_scale(self):
        self.assertNotIn("scale=", build_video_filter(1, False, (1, 1), SizePlan(None, None, None)))

    def test_final_pad_only_when_the_tiled_size_differs(self):
        plan = resolve_size_plan(FINAL, (1921, 1081), True, (3, 3))
        self.assertTrue(build_video_filter(1, True, (3, 3), plan).endswith(":color=0xeeeeee"))
        self.assertIn("pad=1921:1081", build_video_filter(1, True, (3, 3), plan))
        exact = SizePlan((10, 10), (44, 44), (44, 44))
        self.assertNotIn("pad=44:44", build_video_filter(1, True, (3, 3), exact))
