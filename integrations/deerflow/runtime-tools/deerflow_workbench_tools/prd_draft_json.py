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


def decode_prd_page_links_repair(raw):
    """Recover a single uniquely decodable page-links add without changing its text."""
    if not isinstance(raw, str) or not 0 < len(raw.encode("utf-8")) <= 65_536:
        return None
    try:
        json.loads(raw, object_pairs_hook=_unique_object)
    except json.JSONDecodeError as error:
        if error.msg != "Expecting ',' delimiter":
            return None
        failure_offset = error.pos
    except (ValueError, RecursionError):
        return None
    else:
        return None

    recovered = {}
    for token in _TOKENS.finditer(raw):
        offset = token.start()
        if offset > failure_offset:
            break
        if not offset or offset < failure_offset - 2 or token[0] not in ("}", "]") or raw[offset - 1] not in ("}", "]"):
            continue
        for closing in ("]}", "}]"):
            try:
                args = json.loads(raw[:offset] + closing + raw[offset:], object_pairs_hook=_unique_object)
                if not _is_page_links_repair(args):
                    continue
                identity = json.dumps(args, sort_keys=True, allow_nan=False)
            except (ValueError, RecursionError):
                continue
            recovered.setdefault(identity, (args, [{"offset": offset, "closing": closing}]))
    return next(iter(recovered.values())) if len(recovered) == 1 else None


def _is_page_links_repair(args):
    if (not isinstance(args, dict) or set(args) != {"artifact_index", "repair"}
            or type(args["artifact_index"]) is not int or args["artifact_index"] != 0):
        return False
    repair = args["repair"]
    if (not isinstance(repair, dict) or set(repair) != {"baseCandidateChecksum", "operations"}
            or not isinstance(repair["baseCandidateChecksum"], str)
            or re.fullmatch(r"[0-9a-f]{64}", repair["baseCandidateChecksum"]) is None):
        return False
    operations = repair["operations"]
    if not isinstance(operations, list) or len(operations) != 1 or not isinstance(operations[0], dict):
        return False
    operation = operations[0]
    if (set(operation) != {"op", "path", "value"} or operation["op"] != "add"
            or operation["path"] != "/content/sections/businessRequirements/pageLinks"):
        return False
    value = operation["value"]
    return (isinstance(value, dict) and set(value) == {"title", "blocks"}
            and value["title"] == "2.1页面链接" and isinstance(value["blocks"], list) and bool(value["blocks"]))
