from __future__ import annotations

import copy
import unittest

from deerflow_workbench_tools.prototype_runtime_normalizer import (
    normalize_prototype_layout_aliases,
    normalize_runtime_result_prototype_layout_aliases,
)


class PrototypeRuntimeNormalizerTests(unittest.TestCase):
    def test_maps_supported_layout_aliases_without_mutating_the_artifact(self) -> None:
        artifact = {
            "kind": "prototype",
            "content": {
                "nodes": [
                    {"layout": {"justify": "space-between", "align": "flex-end"}},
                    {"layout": {"justify": "space_around", "align": "flex-start"}},
                    {"layout": {"justify": "space_between", "align": "start"}},
                    {"layout": {"justify": "space-around", "align": "end"}},
                    {"layout": {"justify": "flex-start"}},
                    {"layout": {"justify": "flex-end"}},
                ],
            },
        }
        original = copy.deepcopy(artifact)

        normalized, repairs = normalize_prototype_layout_aliases(artifact)

        self.assertEqual(artifact, original)
        self.assertEqual(
            [node["layout"] for node in normalized["content"]["nodes"]],
            [
                {"justify": "spaceBetween", "align": "end"},
                {"justify": "spaceAround", "align": "start"},
                {"justify": "spaceBetween", "align": "start"},
                {"justify": "spaceAround", "align": "end"},
                {"justify": "start"},
                {"justify": "end"},
            ],
        )
        self.assertEqual(len(repairs), 8)
        self.assertEqual(
            (repairs[0]["path"], repairs[0]["from"], repairs[0]["to"]),
            (["content", "nodes", 0, "layout", "align"], "flex-end", "end"),
        )

    def test_prefixes_repairs_for_a_runtime_result(self) -> None:
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [{
                "kind": "prototype",
                "content": {"nodes": [{"layout": {"justify": "space-between"}}]},
            }],
        }

        normalized, repairs = normalize_runtime_result_prototype_layout_aliases(candidate)

        self.assertEqual(
            normalized["artifacts"][0]["content"]["nodes"][0]["layout"]["justify"],
            "spaceBetween",
        )
        self.assertEqual(
            repairs[0]["path"],
            ["artifacts", 0, "content", "nodes", 0, "layout", "justify"],
        )
        self.assertEqual(
            candidate["artifacts"][0]["content"]["nodes"][0]["layout"]["justify"],
            "space-between",
        )

    def test_repairs_observed_prototype_result_compatibility_gaps(self) -> None:
        artifact = {
            "kind": "prototype",
            "content": {
                "protocol": "workbench.prototype.v1",
                "nodes": [
                    {
                        "kind": "text",
                        "layout": {},
                        "style": {"typography": {"align": "left"}},
                        "textStyle": {"align": "left", "color": "#111111"},
                    },
                    {
                        "kind": "input",
                        "layout": {},
                        "style": {"typography": None},
                        "fieldName": "email",
                        "optionValue": None,
                        "required": True,
                    },
                ],
                "motions": [{"trigger": "mount"}],
            },
        }
        original = copy.deepcopy(artifact)

        normalized, repairs = normalize_prototype_layout_aliases(artifact)

        content = normalized["content"]
        self.assertEqual(artifact, original)
        self.assertIsNone(content["nodes"][0]["maxLines"])
        self.assertNotIn("textStyle", content["nodes"][0])
        self.assertEqual(content["motions"][0]["trigger"], "enter")
        self.assertEqual(
            {field: content[field] for field in (
                "tokens",
                "assets",
                "variables",
                "states",
                "actions",
                "bindings",
            )},
            {
                "tokens": [],
                "assets": [],
                "variables": [],
                "states": [],
                "actions": [],
                "bindings": [],
            },
        )
        self.assertEqual(content["nodes"][1]["fieldName"], "email")
        self.assertIsNone(content["nodes"][1]["optionValue"])
        self.assertTrue(content["nodes"][1]["required"])
        self.assertGreaterEqual(len(repairs), 9)

    def test_preserves_existing_invalid_values_but_removes_unsupported_text_style(self) -> None:
        artifact = {
            "kind": "prototype",
            "content": {
                "protocol": "workbench.prototype.v1",
                "nodes": [{
                    "kind": "text",
                    "style": {"typography": None},
                    "textStyle": {"align": "left"},
                    "maxLines": "three",
                }],
                "tokens": {"invalid": True},
            },
        }

        normalized, _ = normalize_prototype_layout_aliases(artifact)

        self.assertNotIn("textStyle", normalized["content"]["nodes"][0])
        self.assertEqual(normalized["content"]["nodes"][0]["maxLines"], "three")
        self.assertEqual(normalized["content"]["tokens"], {"invalid": True})

    def test_leaves_non_prototype_artifacts_unchanged(self) -> None:
        artifact = {
            "kind": "prd",
            "content": {"nodes": [{"layout": {"justify": "space-between"}}]},
        }

        normalized, repairs = normalize_prototype_layout_aliases(artifact)

        self.assertEqual(normalized, artifact)
        self.assertIsNot(normalized, artifact)
        self.assertEqual(repairs, [])

    def test_handles_unhashable_model_values_without_raising(self) -> None:
        artifact = {
            "kind": "prototype",
            "content": {
                "protocol": "workbench.prototype.v1",
                "screens": [{"initialStateId": []}],
                "nodes": [
                    {"kind": []},
                    {
                        "id": "input-one",
                        "screenId": "screen-one",
                        "kind": "input",
                        "inputType": "radio",
                        "fieldName": "choice",
                        "bindingIds": [[], "binding-one", "binding-two"],
                    },
                ],
                "variables": [{"path": "choice", "initialValue": None}],
                "bindings": [
                    {
                        "id": "binding-one",
                        "nodeId": "input-one",
                        "property": "value",
                        "source": {"kind": "variable", "path": []},
                    },
                    {"id": []},
                    {
                        "id": "binding-two",
                        "nodeId": "input-one",
                        "property": "value",
                        "source": {"kind": "variable", "path": "choice"},
                    },
                ],
            },
        }

        normalized, repairs = normalize_prototype_layout_aliases(artifact)

        content = normalized["content"]
        self.assertIsNone(content["screens"][0]["initialStateId"])
        self.assertEqual(len(content["nodes"]), 1)
        self.assertEqual(content["nodes"][0]["kind"], "input")
        self.assertEqual(content["nodes"][0]["bindingIds"], ["binding-two"])
        repaired_path = next(
            binding["source"]["path"]
            for binding in content["bindings"]
            if isinstance(binding.get("id"), str)
        )
        self.assertIsInstance(repaired_path, str)
        self.assertIn(repaired_path, {variable["path"] for variable in content["variables"]})
        self.assertGreaterEqual(len(repairs), 3)


if __name__ == "__main__":
    unittest.main()
