from __future__ import annotations

import hashlib
import inspect
from pathlib import Path
import sys
from types import MappingProxyType, ModuleType, SimpleNamespace
from typing import get_args, get_type_hints
import unittest
from unittest.mock import patch


def _tool(*args: object, **kwargs: object):
    def decorate(function):
        function.func = function
        function.name = args[0] if args else function.__name__
        function.tool_options = kwargs
        return function

    return decorate


langchain = ModuleType("langchain")
langchain_tools = ModuleType("langchain.tools")
langchain_tools.tool = _tool
deerflow = ModuleType("deerflow")
deerflow_tools = ModuleType("deerflow.tools")
deerflow_tool_types = ModuleType("deerflow.tools.types")
deerflow_tool_types.Runtime = object
sys.modules.update({
    "langchain": langchain,
    "langchain.tools": langchain_tools,
    "deerflow": deerflow,
    "deerflow.tools": deerflow_tools,
    "deerflow.tools.types": deerflow_tool_types,
})

from deerflow_workbench_tools import prd_reference_tool


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_SOURCES = {
    "/mnt/skills/public/requirement-doc-template/SKILL.md": (
        ROOT / "integrations/deerflow/skills/requirement-doc-template/SKILL.md"
    ),
    "/mnt/skills/public/requirement-doc-template/references/structure.md": (
        ROOT / "integrations/deerflow/skills/requirement-doc-template/references/structure.md"
    ),
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md": (
        ROOT / "integrations/deerflow/skills/requirement-doc-template/references/quality-standards.md"
    ),
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json": (
        ROOT / "integrations/deerflow/skills/workbench/references/prd-runtime-result.schema.json"
    ),
}
EXPECTED_PHYSICAL_PATHS = {
    "/mnt/skills/public/requirement-doc-template/SKILL.md": (
        Path("/app/skills/public/requirement-doc-template/SKILL.md")
    ),
    "/mnt/skills/public/requirement-doc-template/references/structure.md": (
        Path("/app/skills/public/requirement-doc-template/references/structure.md")
    ),
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md": (
        Path("/app/skills/public/requirement-doc-template/references/quality-standards.md")
    ),
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json": (
        Path("/app/skills/public/workbench/references/prd-runtime-result.schema.json")
    ),
}


class PrdReferenceToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(
            context={"workbench": {"requestedArtifactKinds": ["prd"]}},
        )

    def test_schema_is_named_read_file_and_allows_only_four_complete_paths(self) -> None:
        tool = prd_reference_tool.workbench_prd_reference_read
        signature = inspect.signature(tool.func)
        path_type = get_type_hints(tool.func)["path"]

        self.assertEqual(tool.name, "read_file")
        self.assertEqual(tool.tool_options, {"parse_docstring": True})
        self.assertEqual(tuple(signature.parameters), ("runtime", "description", "path"))
        self.assertEqual(get_args(path_type), tuple(REFERENCE_SOURCES))
        self.assertNotIn("start_line", signature.parameters)
        self.assertNotIn("end_line", signature.parameters)
        with self.assertRaisesRegex(TypeError, "unexpected keyword argument 'start_line'"):
            tool.func(
                self.runtime,
                "Read the complete reference",
                next(iter(REFERENCE_SOURCES)),
                start_line=1,
            )

    def test_reads_each_exact_static_path_and_returns_complete_utf8_unchanged(self) -> None:
        self.assertEqual(
            set(prd_reference_tool.PRD_REFERENCE_FILES),
            set(REFERENCE_SOURCES),
        )
        for virtual_path, source_path in REFERENCE_SOURCES.items():
            with self.subTest(path=virtual_path):
                content = source_path.read_bytes()
                reference = prd_reference_tool.PRD_REFERENCE_FILES[virtual_path]
                self.assertEqual(reference.physical_path, EXPECTED_PHYSICAL_PATHS[virtual_path])
                self.assertEqual(hashlib.sha256(content).hexdigest(), reference.sha256)
                with patch.object(
                    Path,
                    "read_bytes",
                    autospec=True,
                    return_value=content,
                ) as read_bytes:
                    result = prd_reference_tool.workbench_prd_reference_read.func(
                        self.runtime,
                        "Read the complete pinned PRD reference",
                        virtual_path,
                    )
                self.assertEqual(result, content.decode("utf-8", errors="strict"))
                read_bytes.assert_called_once_with(reference.physical_path)

    def test_rejects_aliases_traversal_and_non_path_alias_parameters(self) -> None:
        invalid_paths = (
            "/app/skills/public/requirement-doc-template/SKILL.md",
            "requirement-doc-template/SKILL.md",
            "/mnt/skills/public/requirement-doc-template/./SKILL.md",
            "/mnt/skills/public/requirement-doc-template/references/../SKILL.md",
        )
        for invalid_path in invalid_paths:
            with self.subTest(path=invalid_path):
                with self.assertRaisesRegex(
                    ValueError,
                    "WORKBENCH_PRD_REFERENCE_PATH_INVALID",
                ):
                    prd_reference_tool.workbench_prd_reference_read.func(
                        self.runtime,
                        "Read a PRD reference",
                        invalid_path,
                    )
        with self.assertRaisesRegex(TypeError, "unexpected keyword argument 'file_path'"):
            prd_reference_tool.workbench_prd_reference_read.func(
                self.runtime,
                "Read a PRD reference",
                file_path=next(iter(REFERENCE_SOURCES)),
            )

    def test_rejects_missing_malformed_and_non_prd_scope(self) -> None:
        virtual_path = next(iter(REFERENCE_SOURCES))
        cases = (
            ({}, "WORKBENCH_RUNTIME_SCOPE_MISSING"),
            ({"workbench": {}}, "WORKBENCH_REQUESTED_ARTIFACT_KINDS_INVALID"),
            (
                {"workbench": {"requestedArtifactKinds": ("prd",)}},
                "WORKBENCH_REQUESTED_ARTIFACT_KINDS_INVALID",
            ),
            (
                {"workbench": {"requestedArtifactKinds": ["prd", 1]}},
                "WORKBENCH_REQUESTED_ARTIFACT_KINDS_INVALID",
            ),
            (
                {"workbench": {"requestedArtifactKinds": ["prototype"]}},
                "WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED",
            ),
        )
        for context, error_code in cases:
            with self.subTest(context=context):
                runtime = SimpleNamespace(context=context)
                with self.assertRaisesRegex(ValueError, error_code):
                    prd_reference_tool.workbench_prd_reference_read.func(
                        runtime,
                        "Read a PRD reference",
                        virtual_path,
                    )

    def test_allows_linked_prd_and_prototype_scope(self) -> None:
        runtime = SimpleNamespace(
            context={"workbench": {"requestedArtifactKinds": ["prd", "prototype"]}},
        )
        for virtual_path, source_path in REFERENCE_SOURCES.items():
            content = source_path.read_bytes()
            with patch.object(Path, "read_bytes", return_value=content):
                self.assertEqual(
                    prd_reference_tool.workbench_prd_reference_read.func(
                        runtime, "Read the linked PRD reference", virtual_path,
                    ),
                    content.decode("utf-8"),
                )

    def test_maps_missing_and_unreadable_files_to_stable_error_codes(self) -> None:
        virtual_path = next(iter(REFERENCE_SOURCES))
        for error, error_code in (
            (FileNotFoundError(), "WORKBENCH_PRD_REFERENCE_FILE_MISSING"),
            (PermissionError(), "WORKBENCH_PRD_REFERENCE_FILE_UNREADABLE"),
        ):
            with self.subTest(error_code=error_code):
                with patch.object(Path, "read_bytes", side_effect=error):
                    with self.assertRaisesRegex(ValueError, error_code):
                        prd_reference_tool.workbench_prd_reference_read.func(
                            self.runtime,
                            "Read a PRD reference",
                            virtual_path,
                        )

    def test_rejects_content_that_does_not_match_the_pinned_sha256(self) -> None:
        virtual_path = next(iter(REFERENCE_SOURCES))
        with patch.object(Path, "read_bytes", return_value=b"tampered"):
            with self.assertRaisesRegex(
                ValueError,
                "WORKBENCH_PRD_REFERENCE_SHA256_MISMATCH",
            ):
                prd_reference_tool.workbench_prd_reference_read.func(
                    self.runtime,
                    "Read a PRD reference",
                    virtual_path,
                )

    def test_rejects_non_utf8_after_the_pinned_byte_hash_matches(self) -> None:
        virtual_path = next(iter(REFERENCE_SOURCES))
        invalid_utf8 = b"\xff\xfe"
        original = prd_reference_tool.PRD_REFERENCE_FILES[virtual_path]
        test_reference = prd_reference_tool.PrdReferenceSpec(
            physical_path=original.physical_path,
            sha256=hashlib.sha256(invalid_utf8).hexdigest(),
        )
        references = MappingProxyType({virtual_path: test_reference})
        with patch.object(prd_reference_tool, "PRD_REFERENCE_FILES", references):
            with patch.object(Path, "read_bytes", return_value=invalid_utf8):
                with self.assertRaisesRegex(
                    ValueError,
                    "WORKBENCH_PRD_REFERENCE_UTF8_INVALID",
                ):
                    prd_reference_tool.workbench_prd_reference_read.func(
                        self.runtime,
                        "Read a PRD reference",
                        virtual_path,
                    )


if __name__ == "__main__":
    unittest.main()
