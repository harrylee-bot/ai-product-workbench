# DOCX Renderer Implementation TODO

## Current Status: ❌ Architecture Issue

The current implementation in `prd-docx-renderer.ts` attempts to **generate a new document from scratch** using `doc.add_heading()`, `doc.add_table()`, etc.

However, the template file already contains:
- Complete document structure
- 3 pre-formatted tables with correct headers
- TOC placeholders
- Section headings

## Verification Results

✅ Template exists: `integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx`
✅ Template structure verified:
  - Table 0: Version history (4r x 5c, headers: ["版本/状态", "作者", "参与者", "起止日期", "备注"])
  - Table 1: Channel table (4r x 3c, headers: ["序号", "活动投放的可选渠道", "是否投放"])
  - Table 2: Safety baseline (22r x 4c, headers: ["序号", "需求安全基线内容", "范围", "是否涉及"])
✅ Test script successfully filled template: `/tmp/test-template-fill.py`
✅ Generated valid DOCX: `/tmp/test-filled.docx` (460K)

## Correct Implementation Approach

Instead of generating new content, the renderer should:

1. **Load the template** document
2. **Replace title** in first paragraph
3. **Fill version history table** (Table 0) with actual data
4. **Fill channel table** (Table 1) using correct channel labels:
   - `inApp` → "端内渠道"
   - `wapH5` → "WAP/H5端外渠道"  
   - `miniProgram` → "小程序"
5. **Fill safety baseline table** (Table 2) rows 1-21 with applicability values
6. **Replace section content** by finding existing headings and updating paragraphs
7. **Update TOC** if needed

## Reference Implementation

See `/tmp/test-template-fill.py` for a working proof-of-concept that:
- Successfully loads the template
- Fills all 3 tables with fixture data
- Generates a valid 460K DOCX file

## Action Items

- [ ] Rewrite `generatePythonRenderer()` to use template-filling approach
- [ ] Remove all `doc.add_*` calls (add_heading, add_table, add_paragraph for content)
- [ ] Keep template loading: `doc = Document(template_path)`
- [ ] Iterate existing `doc.tables[i]` and `doc.paragraphs[j]` to fill data
- [ ] Use correct channel labels from `prdChannelLabels`
- [ ] Verify against quality check script: `integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py`
