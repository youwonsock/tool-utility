import unittest

from video_to_image import (
    PREVIEW_SAMPLE_CELL_SIZE,
    PreviewPlan,
    SIZE_MODES,
    SizePlan,
    build_video_filter,
    calculate_expected_output_count,
    calculate_final_grid_geometry,
    calculate_sheet_size,
    parse_positive_float,
    parse_positive_int,
    resolve_preview_plan,
    resolve_size_plan,
)


class VideoToImageGeometryTests(unittest.TestCase):
    def test_positive_float_and_integer_validation(self) -> None:
        self.assertEqual(parse_positive_float("0.5", "간격"), 0.5)
        self.assertEqual(parse_positive_int("640", "너비"), 640)
        for value in ("", "0", "-1", "nan", "inf", "문자"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    parse_positive_float(value, "간격")
        for value in ("", "0", "-1", "1.5", "문자"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    parse_positive_int(value, "너비")

    def test_final_grid_geometry_for_3_by_3(self) -> None:
        cell_size, tiled_size = calculate_final_grid_geometry((1920, 1080), (3, 3))
        self.assertEqual(cell_size, (632, 352))
        self.assertEqual(tiled_size, (1920, 1080))

    def test_final_grid_geometry_for_2_by_2(self) -> None:
        cell_size, tiled_size = calculate_final_grid_geometry((1920, 1080), (2, 2))
        self.assertEqual(cell_size, (951, 531))
        self.assertEqual(tiled_size, (1920, 1080))

    def test_cell_size_determines_sheet_size(self) -> None:
        self.assertEqual(calculate_sheet_size((640, 360), (3, 3)), (1944, 1104))
        plan = resolve_size_plan(SIZE_MODES[1], (640, 360), True, (2, 2))
        self.assertEqual(plan.output_size, (1298, 738))

    def test_odd_final_size_adds_final_padding(self) -> None:
        cell_size, tiled_size = calculate_final_grid_geometry((1000, 1000), (3, 3))
        self.assertEqual(cell_size, (325, 325))
        self.assertEqual(tiled_size, (999, 999))
        plan = resolve_size_plan(SIZE_MODES[0], (1000, 1000), True, (3, 3))
        video_filter = build_video_filter(0.5, True, (3, 3), plan)
        self.assertIn("pad=1000:1000", video_filter)

    def test_individual_original_mode_has_no_resize_or_tile(self) -> None:
        plan = resolve_size_plan(SIZE_MODES[1], None, False, (1, 1))
        self.assertEqual(plan, SizePlan(None, None, None))
        video_filter = build_video_filter(2, False, (1, 1), plan)
        self.assertEqual(video_filter, "fps=0.5")
        self.assertNotIn("tile=", video_filter)

    def test_grid_filter_uses_interval_and_auto_cell_size(self) -> None:
        plan = resolve_size_plan(SIZE_MODES[0], (1920, 1080), True, (3, 3))
        video_filter = build_video_filter(0.5, True, (3, 3), plan)
        self.assertIn("fps=2", video_filter)
        self.assertIn("scale=632:352", video_filter)
        self.assertIn("pad=632:352", video_filter)
        self.assertIn("tile=3x3:padding=6:margin=6", video_filter)

    def test_final_size_must_fit_grid(self) -> None:
        with self.assertRaises(ValueError):
            calculate_final_grid_geometry((20, 20), (3, 3))

    def test_preview_plan_matches_final_resolution_geometry(self) -> None:
        plan = resolve_preview_plan(SIZE_MODES[0], (1920, 1080), True, (3, 3))
        self.assertEqual(
            plan,
            PreviewPlan((3, 3), (632, 352), (1920, 1080), False),
        )

    def test_preview_plan_matches_cell_size_geometry(self) -> None:
        plan = resolve_preview_plan(SIZE_MODES[1], (640, 360), True, (3, 3))
        self.assertEqual(plan, PreviewPlan((3, 3), (640, 360), (1944, 1104), False))

    def test_preview_plan_uses_sample_size_for_original_mode(self) -> None:
        individual_plan = resolve_preview_plan(SIZE_MODES[1], None, False, (3, 3))
        self.assertEqual(
            individual_plan,
            PreviewPlan((1, 1), PREVIEW_SAMPLE_CELL_SIZE, PREVIEW_SAMPLE_CELL_SIZE, True),
        )

        grid_plan = resolve_preview_plan(SIZE_MODES[1], None, True, (2, 2))
        self.assertEqual(grid_plan.grid_size, (2, 2))
        self.assertEqual(grid_plan.cell_size, PREVIEW_SAMPLE_CELL_SIZE)
        self.assertEqual(grid_plan.output_size, (658, 378))
        self.assertTrue(grid_plan.uses_sample_size)

    def test_expected_output_count_groups_frames_by_grid(self) -> None:
        self.assertEqual(calculate_expected_output_count(0, 4, 0.5, False, (1, 1)), 8)
        self.assertEqual(calculate_expected_output_count(0, 4, 0.5, True, (2, 2)), 2)
        self.assertEqual(calculate_expected_output_count(0, 4.1, 1, True, (3, 3)), 1)


if __name__ == "__main__":
    unittest.main()
