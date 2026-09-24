import os
import unittest
from unittest.mock import patch

from docx import Document
from docx.oxml.ns import qn

from render_prd_docx import Renderer, append_bookmark, export_link_target, paragraph_format


class RendererRegressionTests(unittest.TestCase):
    def test_bookmark_follows_paragraph_properties(self):
        document = Document()
        paragraph = document.add_paragraph("Heading", style="Heading 1")
        append_bookmark(paragraph, "section_1", 1)
        self.assertEqual([element.tag for element in paragraph._p][:2], [qn("w:pPr"), qn("w:bookmarkStart")])

    def test_bookmark_without_paragraph_properties(self):
        paragraph = Document().add_paragraph("Body")
        append_bookmark(paragraph, "section_1", 1)
        self.assertEqual(paragraph._p[0].tag, qn("w:bookmarkStart"))

    def test_heading_properties_keep_schema_order_and_values(self):
        renderer = Renderer.__new__(Renderer)
        renderer.doc = Document()
        renderer.font = "Arial"
        renderer.bookmark_number = 0
        paragraph = renderer.heading("1 Heading", 1, "section_1")
        paragraph_format(paragraph, keep=True)
        props = paragraph._p.pPr
        tags = [element.tag for element in props]
        self.assertEqual(paragraph._p[0].tag, qn("w:pPr"))
        self.assertLess(tags.index(qn("w:numPr")), tags.index(qn("w:snapToGrid")))
        self.assertLess(tags.index(qn("w:snapToGrid")), tags.index(qn("w:spacing")))
        self.assertEqual(props.numPr.numId.val, 0)
        self.assertEqual(len(props.findall(qn("w:snapToGrid"))), 1)
        self.assertEqual(props.find(qn("w:snapToGrid")).get(qn("w:val")), "0")

    def test_root_relative_links_resolve_against_configured_origin(self):
        with patch.dict(os.environ, {"WORKBENCH_WEB_ORIGIN": "https://workbench.test/"}):
            self.assertEqual(export_link_target("/projects/current?view=prd#details"), "https://workbench.test/projects/current?view=prd#details")
            self.assertEqual(export_link_target("//docs.vendor.test/guide"), "https://docs.vendor.test/guide")

    def test_absolute_links_preserve_source_destination(self):
        with patch.dict(os.environ, {"WORKBENCH_WEB_ORIGIN": ""}):
            for href in ("https://docs.vendor.test/guide?q=one#part", "HTTP://docs.vendor.test/Guide", "mailto:product@vendor.test"):
                with self.subTest(href=href):
                    self.assertEqual(export_link_target(href), href)

    def test_unconfigured_or_invalid_origins_do_not_make_local_links(self):
        for origin in ("", "file:///tmp", "https://", "https://user:password@workbench.test", "https://workbench.test/path", "https://workbench.test?q=one"):
            with self.subTest(origin=origin), patch.dict(os.environ, {"WORKBENCH_WEB_ORIGIN": origin}):
                self.assertIsNone(export_link_target("/projects/current"))

    def test_unknown_fragment_does_not_become_an_external_file_link(self):
        with patch.dict(os.environ, {"WORKBENCH_WEB_ORIGIN": "https://workbench.test"}):
            self.assertIsNone(export_link_target("#unknown-source-fragment"))


if __name__ == "__main__":
    unittest.main()
