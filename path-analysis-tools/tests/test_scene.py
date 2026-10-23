import copy
import unittest

from path_analysis_tools.documents import ContractError, validate
from path_analysis_tools.geometry import IDENTITY
from path_analysis_tools.paths import calculate_path
from path_analysis_tools.scene import plan_scene_edits, verify_scene_apply
from helpers import apply_operations, bindings_for, empty_snapshot, observations, points, samples


class SceneTests(unittest.TestCase):
    def setUp(self):
        self.source = empty_snapshot()
        self.plan = calculate_path(observations([[0, 0, 0], [0, 0, 5]], "edit"))
        self.edits = plan_scene_edits(self.plan, self.source)
        self.complete, self.log = apply_operations(self.edits, self.source)

    def test_fresh_preflight_is_ready(self):
        self.assertEqual(verify_scene_apply(self.edits, self.source)["status"], "ready")

    def test_exported_contract_rejects_incomplete_operations(self):
        for mutation in ('missing_node', 'invalid_snapshot'):
            edit = copy.deepcopy(self.edits)
            if mutation == 'missing_node':
                edit['operations'][0]['after'] = {}
            else:
                del edit['source_snapshot']['scope_id']
            with self.subTest(mutation=mutation), self.assertRaises(ContractError):
                validate(edit, 'EditPlan')

    def test_success_requires_final_readback(self):
        self.assertEqual(verify_scene_apply(self.edits, self.complete, self.log)["status"], "complete")
        bad = copy.deepcopy(self.complete)
        bad["nodes"][-1]["position"][0] += 1
        self.assertEqual(verify_scene_apply(self.edits, bad, self.log)["status"], "conflict")

    def test_two_external_reference_formats(self):
        for style in ["uri", "numeric"]:
            scene, log = apply_operations(self.edits, self.source, reference_style=style)
            self.assertEqual(verify_scene_apply(self.edits, scene, log)["status"], "complete")

    def test_float32_readback_allows_only_small_position_error(self):
        scene = copy.deepcopy(self.complete)
        scene["nodes"][-1]["position"][0] += 5e-7
        self.assertEqual(verify_scene_apply(self.edits, scene, self.log)["status"], "complete")
        scene["nodes"][-1]["position"][0] += 1e-3
        self.assertEqual(verify_scene_apply(self.edits, scene, self.log)["status"], "conflict")

    def test_small_roundtrip_error_does_not_create_repeated_moves(self):
        scene = copy.deepcopy(self.complete)
        scene["nodes"][-1]["position"][0] += 5e-7
        edit = plan_scene_edits(self.plan, scene, bindings_for(self.plan, scene))
        self.assertEqual(edit["operations"], [])

    def test_changed_root_frame_makes_preflight_stale(self):
        bad = copy.deepcopy(self.source)
        bad["frame_transform"][3] = 3
        self.assertEqual(verify_scene_apply(self.edits, bad)["status"], "stale")

    def test_wrong_scope_rejected(self):
        bad = copy.deepcopy(self.source)
        bad["scope_id"] = "other"
        with self.assertRaises(ContractError):
            verify_scene_apply(self.edits, bad)

    def test_partial_create_can_be_replanned_without_duplicate(self):
        partial, log = apply_operations(self.edits, self.source, count=1)
        result = verify_scene_apply(self.edits, partial, log)
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["requires_replan"])
        new = plan_scene_edits(self.plan, partial, bindings_for(self.plan, partial))
        created_ids = [op["after"]["node"]["id"] for op in new["operations"] if op["kind"] == "create_node"]
        self.assertNotIn(partial["nodes"][0]["id"], created_ids)
        final, final_log = apply_operations(new, partial)
        self.assertEqual(verify_scene_apply(new, final, final_log)["status"], "complete")

    def test_missing_creation_receipt_rejected(self):
        _, log = apply_operations(self.edits, self.source, count=1)
        del log["entries"][0]["externalRef"]
        with self.assertRaises(ContractError):
            verify_scene_apply(self.edits, self.source, log)

    def test_order_cannot_be_logged_before_creation(self):
        operation = next(op for op in self.edits["operations"] if op["kind"] == "set_order")
        log = {"schema_version": 1, "document_type": "ApplyLog", "edit_plan_id": self.edits["id"],
               "entries": [{"operation_id": operation["id"], "status": "success"}]}
        with self.assertRaises(ContractError):
            verify_scene_apply(self.edits, self.source, log)

    def test_unsupported_mcp_capability_is_reported(self):
        source = empty_snapshot()
        source["capabilities"] = ["create_node"]
        edit = plan_scene_edits(self.plan, source)
        result = verify_scene_apply(edit, source)
        self.assertEqual(result["status"], "unsupported")
        self.assertIn("set_order", result["unsupported_capabilities"])

    def test_coordinate_frame_mismatch_requires_placement(self):
        plan = copy.deepcopy(self.plan)
        plan["frame_id"] = "other"
        with self.assertRaises(ContractError):
            plan_scene_edits(plan, self.source)
        matrix = IDENTITY[:]
        matrix[3] = 100
        edited = plan_scene_edits(plan, self.source, placement=matrix)
        point_nodes = [n for n in edited["desired_nodes"] if n["kind"] == "point"]
        self.assertTrue(all(n["position"][0] == 100 for n in point_nodes))

    def test_singular_placement_rejected(self):
        with self.assertRaises(ContractError):
            plan_scene_edits(self.plan, self.source, placement=[0] * 16)

    def test_existing_middle_move_preserves_other_geometry(self):
        doc = observations([[100, 7, 200], [105, 8, 205], [110, 7, 210]], "edit")
        for sample in samples(doc):
            sample["protected"] = True
        original = calculate_path(doc)
        created = plan_scene_edits(original, self.source)
        scene, _ = apply_operations(created, self.source)
        samples(doc)[1]["position"] = [106, 9, 205]
        updated = calculate_path(doc, previous_plan=original)
        delta = plan_scene_edits(updated, scene, bindings_for(updated, scene))
        self.assertEqual([o["kind"] for o in delta["operations"]], ["update_node", "rebuild"])
        after, log = apply_operations(delta, scene)
        changed = [n["id"] for n in after["nodes"] if next(s for s in scene["nodes"] if s["id"] == n["id"])["position"] != n["position"]]
        self.assertEqual(changed, [points(original)[1]["id"]])
        self.assertEqual(verify_scene_apply(delta, after, log)["status"], "complete")

    def test_missing_existing_point_classification_rejected(self):
        with self.assertRaises(ContractError):
            plan_scene_edits(self.plan, self.complete)

    def test_delete_is_explicit_and_shared_point_is_detach_only(self):
        original_doc = observations([[0, 0, 0], [0, 0, 2], [0, 0, 5]], "edit")
        for s in samples(original_doc):
            s["protected"] = True
        original = calculate_path(original_doc)
        scene, _ = apply_operations(plan_scene_edits(original, self.source), self.source)
        removed_id = points(original)[1]["id"]
        # Keep source sample IDs of the endpoints across reanalysis.
        del samples(original_doc)[1]
        shortened = calculate_path(original_doc, previous_plan=original)
        bindings = bindings_for(shortened, scene)
        for shared in (False, True, None):
            source = copy.deepcopy(scene)
            node = next(n for n in source["nodes"] if n["id"] == removed_id)
            node["external_reference_count"] = None if shared is None else int(shared)
            delta = plan_scene_edits(shortened, source, bindings, [removed_id])
            kinds = [op["kind"] for op in delta["operations"]]
            self.assertEqual("delete_node" in kinds, shared is False)
            final, log = apply_operations(delta, source)
            self.assertEqual(verify_scene_apply(delta, final, log)["status"], "complete")
            self.assertEqual(any(n["id"] == removed_id for n in final["nodes"]), shared is not False)

    def test_duplicate_external_references_rejected(self):
        scene = copy.deepcopy(self.complete)
        scene["nodes"][1]["externalRef"] = scene["nodes"][0]["externalRef"]
        with self.assertRaises(ContractError):
            verify_scene_apply(self.edits, scene, self.log)

    def test_shared_scoped_reference_preserves_unmanaged_path_and_object(self):
        doc = observations([[0,0,0], [0,0,2], [0,0,5]], 'edit')
        for sample in samples(doc):
            sample['protected'] = True
        original = calculate_path(doc)
        scene, _ = apply_operations(plan_scene_edits(original, self.source), self.source)
        removed_id = points(original)[1]['id']
        segment = next(n for n in scene['nodes'] if n['kind'] == 'segment')
        other = dict(segment, id='unmanaged-segment', externalRef='other-provider://segment')
        scene['nodes'].append(other)
        shared_order = {'owner_id':other['id'], 'relation':'points', 'items':[removed_id, points(original)[-1]['id']]}
        scene['orders'].append(shared_order)
        del samples(doc)[1]
        shortened = calculate_path(doc, previous_plan=original)
        edit = plan_scene_edits(shortened, scene, bindings_for(shortened, scene), [removed_id])
        self.assertNotIn('delete_node', [o['kind'] for o in edit['operations']])
        self.assertIn(shared_order, edit['desired_orders'])
        final, log = apply_operations(edit, scene)
        self.assertEqual(verify_scene_apply(edit, final, log)['status'], 'complete')

    def test_failed_reference_operation_requires_replan(self):
        order_index = next(i for i, op in enumerate(self.edits["operations"]) if op["kind"] == "set_order")
        partial, log = apply_operations(self.edits, self.source, order_index)
        log["entries"].append({"operation_id": self.edits["operations"][order_index]["id"], "status": "failed", "message": "engine denied reference write"})
        result = verify_scene_apply(self.edits, partial, log)
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["requires_replan"])


if __name__ == "__main__":
    unittest.main()
