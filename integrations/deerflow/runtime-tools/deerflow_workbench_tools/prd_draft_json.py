"""Decode missing closing delimiters at fixed PRD v3 document boundaries."""

import json
import re

# String tokens consume escaped quotes and punctuation inside business text.
_TOKENS = re.compile(r'"(?:\\.|[^"\\])*"|[][{}:,]')
_OBJECT_VALUE = re.compile(r"\s*:\s*\{")
_SECTIONS = ('"introduction"', '"businessRequirements"', '"degradation"', '"safetyBaseline"')
_SPINE = [("{", None), ("{", '"draft"'), ("{", '"content"'), ("{", '"sections"')]
_CLOSE = {"{": "}", "[": "]"}


def _unique_object(items):
    result = dict(items)
    if len(result) != len(items):
        raise ValueError("duplicate object key")
    return result


def decode_prd_draft_sections(raw):
    """Never add fields or values. Close sections before known siblings, and
    close a section block list before the containing object ends.

    The raw call remains invalid if the section order or nesting is ambiguous.
    Its decoded arguments still have to pass the ordinary Draft tool and all
    schema, evidence and generation-stage checks before anything is accepted.
    """
    if not isinstance(raw, str) or not 0 < len(raw) <= 200_000:
        return None
    stack = []
    seen_sections = []
    edits = []
    prev = before_prev = None
    prev_offset = 0
    for token in _TOKENS.finditer(raw):
        value = token[0]
        if value in _SECTIONS and stack[:4] == _SPINE and prev in ("{", ",") and _OBJECT_VALUE.match(raw, token.end()):
            if len(seen_sections) >= len(_SECTIONS) or value != _SECTIONS[len(seen_sections)]:
                return None
            if seen_sections and len(stack) > 4:
                if prev != "," or stack[4] != ("{", seen_sections[-1]):
                    return None
                edits.append((prev_offset, "".join(_CLOSE[t] for t, _ in reversed(stack[4:]))))
                del stack[4:]
            seen_sections.append(value)
        if value in ("{", "["):
            stack.append((value, before_prev if prev == ":" else None))
            if len(stack) > 160:
                return None
        elif value in ("}", "]"):
            # A section's block list may end with an object followed directly
            # by the containing section object's closing delimiter.
            if (
                value == "}" and prev == "}" and len(stack) >= 7
                and stack[:4] == _SPINE and stack[4][1] in _SECTIONS
                and stack[-2][0] == "{" and stack[-1] == ("[", '"blocks"')
            ):
                edits.append((token.start(), "]"))
                stack.pop()
            if not stack or _CLOSE[stack.pop()[0]] != value:
                return None
        before_prev, prev, prev_offset = prev, value, token.start()
    if not edits or stack or tuple(seen_sections) != _SECTIONS:
        return None
    corrected = raw
    for offset, closing in reversed(edits):
        corrected = corrected[:offset] + closing + corrected[offset:]
    try:
        args = json.loads(corrected, object_pairs_hook=_unique_object)
    except (ValueError, RecursionError):
        return None
    if not isinstance(args, dict) or set(args) != {"artifact_index", "draft"} or type(args["artifact_index"]) is not int or args["artifact_index"] != 0:
        return None
    draft = args["draft"]
    if not isinstance(draft, dict) or draft.get("kind") != "prd" or draft.get("schemaVersion") != 3:
        return None
    content = draft.get("content")
    if not isinstance(content, dict) or content.get("protocol") != "workbench.prd.v3":
        return None
    return args, [{"offset": at, "closing": closing} for at, closing in edits]
