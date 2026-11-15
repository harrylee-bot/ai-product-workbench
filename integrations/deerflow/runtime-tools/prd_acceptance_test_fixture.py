"""Anonymous test construction for the observed acceptance matching shape."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json"


def anonymous_acceptance_collision() -> dict:
    """Rebuild the observed four-row matrix using only the public test fixture.

    The observed failure had visibility=[3], rules=[2,3], state=[0,1,2,3],
    failureRecovery=[2], across two sections. No live business text is retained.
    """
    draft = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))["artifacts"][0]
    sections = draft["content"]["sections"]
    functions = sections["businessRequirements"]["functionSections"]
    template = copy.deepcopy(functions[2]["blocks"][0])
    table = functions[2]["blocks"][1]
    # Narrow this synthetic fixture's body to the observed four dimensions;
    # this is test-data construction, not production keyword matching.
    replacements = {"权限": "资格", "授权": "资格确认", "无权": "未取得资格", "角色": "人员",
                    "空状态": "初始界面", "空态": "初始界面", "暂无": "未包含", "无数据": "未包含内容", "尚未提交": "尚未操作"}

    def narrow(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if isinstance(child, str):
                    for old, new in replacements.items():
                        child = child.replace(old, new)
                    value[key] = child
                else:
                    narrow(child)
        elif isinstance(value, list):
            for child in value:
                narrow(child)

    for value in (sections["introduction"], sections["businessRequirements"], sections["degradation"]):
        narrow(value)
    criteria = []
    for index, (given, when) in enumerate((
        ("已有任务", "点击提交"), ("已有另一记录", "点击提交"),
        ("输入校验失败", "点击重试"), ("页面输入表单可用", "点击提交"),
    )):
        criterion = copy.deepcopy(template)
        criterion.update(
            id="criterion-main" if index == 0 else f"criterion-repair-{index}",
            given=[{"type": "text", "text": given, "marks": []}],
            when=[{"type": "text", "text": when, "marks": []}],
            then=copy.deepcopy(table["rows"][index]["cells"][2]["content"]),
        )
        criteria.append(criterion)
    functions[0]["blocks"][1]["acceptanceCriterionIds"] = [criterion["id"] for criterion in criteria]
    functions[0]["blocks"].extend(criteria[:3])
    functions[2]["blocks"] = criteria[3:]
    return draft
