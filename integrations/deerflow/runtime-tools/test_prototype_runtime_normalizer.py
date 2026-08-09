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

    def test_leaves_non_prototype_artifacts_unchanged(self) -> None:
        artifact = {
            "kind": "prd",
            "content": {"nodes": [{"layout": {"justify": "space-between"}}]},
        }

        normalized, repairs = normalize_prototype_layout_aliases(artifact)

        self.assertEqual(normalized, artifact)
        self.assertIsNot(normalized, artifact)
        self.assertEqual(repairs, [])


if __name__ == "__main__":
    unittest.main()
