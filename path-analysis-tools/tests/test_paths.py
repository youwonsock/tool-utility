import copy
import math
import unittest

from path_analysis_tools.documents import ContractError
from path_analysis_tools.geometry import length
from path_analysis_tools.paths import calculate_path
from helpers import observations, points, samples


class PathTests(unittest.TestCase):
    def test_create_aligns_horizontal_heading_and_scales(self):
        plan = calculate_path(observations([[100, 7, 20], [105, 7, 20], [105, 9, 25]]), simplify_ratio=0)
        path = points(plan)
        self.assertEqual(path[0]["position"], [0, 0, 0])
        self.assertAlmostEqual(path[1]["position"][0], 0)
        self.assertGreater(path[1]["position"][2], 0)
        self.assertGreater(path[2]["position"][1], 0)
        self.assertAlmostEqual(length(path), 10)

    def test_edit_preserves_origin_and_scale(self):
        raw = [[100, 20, 300], [105, 22, 305], [110, 20, 300]]
        plan = calculate_path(observations(raw, "edit"), simplify_ratio=0)
        self.assertEqual([p["position"] for p in points(plan)], raw)

    def test_simplification_cannot_change_normalization_frame_or_scale(self):
        document = observations([[0, 0, 0], [1, 0, 0], [1, 0, 10]])
        detailed = calculate_path(document, simplify_ratio=0)
        simple = calculate_path(document, simplify_ratio=1)
        first = detailed["targets"][0]["runs"][0]
        second = simple["targets"][0]["runs"][0]
        self.assertEqual(first["normalization"], second["normalization"])
        self.assertEqual(first["segments"][0]["points"][-1]["position"], second["segments"][0]["points"][-1]["position"])
        self.assertAlmostEqual(second["normalization"]["scale"], 10 / 11)

    def test_reordering_samples_preserves_reused_point_ids(self):
        document = observations(mode="edit")
        first = calculate_path(document, simplify_ratio=0)
        samples(document).reverse()
        second = calculate_path(document, simplify_ratio=0, previous_plan=first)
        self.assertEqual([p["id"] for p in points(second)], [p["id"] for p in reversed(points(first))])

    def test_vertical_path_needs_no_horizontal_heading(self):
        path = points(calculate_path(observations([[1, 2, 3], [1, 4, 3], [1, 7, 3]])))
        self.assertEqual(path[-1]["position"], [0, 10, 0])

    def test_unresolved_and_excluded_split_without_bridges(self):
        document = observations([[0, 0, 0], [0, 0, 1], None, [0, 0, 4], [0, 0, 5], None, [2, 0, 9], [2, 0, 10]])
        samples(document)[2]["status"] = "excluded"
        samples(document)[5]["status"] = "unresolved"
        plan = calculate_path(document)
        self.assertEqual(len(plan["targets"][0]["runs"]), 3)
        self.assertEqual(len(plan["excluded"]), 2)

    def test_action_boundary_preserved_as_two_distinct_points(self):
        document = observations([[0, 0, 0], [0, 0, 2]])
        run = document["targets"][0]["runs"][0]
        second = copy.deepcopy(run["segments"][0])
        second["id"], second["label"] = "after-action", "After action"
        second["samples"][0]["position"] = [0, 0, 2]
        second["samples"][1]["position"] = [2, 1, 2]
        run["segments"].append(second)
        plan = calculate_path(document)
        first, second = plan["targets"][0]["runs"][0]["segments"]
        self.assertEqual(first["points"][-1]["position"], second["points"][0]["position"])
        self.assertNotEqual(first["points"][-1]["id"], second["points"][0]["id"])

    def test_disconnected_actions_are_rejected(self):
        document = observations()
        segment = copy.deepcopy(document["targets"][0]["runs"][0]["segments"][0])
        segment["id"] = "other"
        document["targets"][0]["runs"][0]["segments"].append(segment)
        with self.assertRaisesRegex(ContractError, "Adjacent"):
            calculate_path(document)

    def test_simplifies_straight_samples_but_protects_anchors(self):
        document = observations([[0, 0, i] for i in range(7)])
        samples(document)[3]["protected"] = True
        plan = calculate_path(document)
        self.assertEqual([p["sample_id"] for p in points(plan)], ["sample-0", "sample-3", "sample-6"])

    def test_binding_protects_existing_middle_point(self):
        document = observations([[0, 0, 0], [0, 0, 1], [0, 0, 2]], "edit")
        samples(document)[1]["existing_ref"] = "arbitrary-provider-ref"
        self.assertEqual(len(points(calculate_path(document))), 3)

    def test_reanalysis_protects_explicit_previous_binding(self):
        document = observations([[0, 0, 0], [0, 0, 1], [0, 0, 2]], "edit")
        first = calculate_path(document, simplify_ratio=0)
        bound = points(first)[1]["id"]
        second = calculate_path(document, previous_plan=first, protected_point_ids=[bound])
        self.assertIn(bound, [p["id"] for p in points(second)])

    def test_identity_survives_insert_and_rename(self):
        document = observations(mode="edit")
        first = calculate_path(document, simplify_ratio=0)
        middle = copy.deepcopy(samples(document)[1])
        middle.update(id="inserted", position=[0, 0, 2])
        samples(document).insert(1, middle)
        document["targets"][0]["runs"][0]["segments"][0]["label"] = "Renamed"
        second = calculate_path(document, simplify_ratio=0, previous_plan=first)
        by_sample = {p["sample_id"]: p["id"] for p in points(second)}
        self.assertTrue(all(by_sample[p["sample_id"]] == p["id"] for p in points(first)))

    def test_retracing_path_keeps_nonconsecutive_return(self):
        plan = calculate_path(observations([[0, 0, 0], [0, 0, 2], [0, 0, 0]]), simplify_ratio=0)
        self.assertEqual(len(points(plan)), 3)

    def test_stationary_run_is_not_generated(self):
        plan = calculate_path(observations([[1, 0, 1], [1, 0, 1]]))
        self.assertEqual(plan["targets"][0]["runs"], [])
        self.assertIn("NO_MOVEMENT", plan["warnings"][0])

    def test_nonfinite_numbers_rejected(self):
        for value in [float("nan"), float("inf"), -float("inf")]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                calculate_path(observations([[0, 0, 0], [value, 0, 2]]))

    def test_missing_height_not_filled_with_zero(self):
        with self.assertRaises(ContractError):
            calculate_path(observations([[0, 0, 0], [1, None, 2]]))

    def test_excluded_position_cannot_sneak_into_geometry(self):
        document = observations()
        samples(document)[1]["status"] = "excluded"
        with self.assertRaises(ContractError):
            calculate_path(document)

    def test_source_ids_must_be_unique(self):
        document = observations()
        samples(document)[1]["id"] = samples(document)[0]["id"]
        with self.assertRaises(ContractError):
            calculate_path(document)


if __name__ == "__main__":
    unittest.main()
