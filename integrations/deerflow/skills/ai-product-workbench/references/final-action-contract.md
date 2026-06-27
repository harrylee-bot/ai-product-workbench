# Final Action Contract

The final action is the only instruction AI Product Workbench will persist from DeerFlow. It must be valid JSON inside a fenced block named `ai_product_workbench_final_action`.

## Common Fields

```json
{
  "type": "answer | review_prd | review_prototype | ask_clarification | download_export",
  "message": "Chinese user-facing summary",
  "intent": "optional UserIntent-compatible label",
  "requirementMode": "historical_extension | new_capability | one_sentence_completion",
  "knowledgeRefsUsed": ["optional knowledge paths or titles used for reasoning"],
  "assumptions": ["optional inferred product facts, especially for one-sentence requirements"],
  "consistencyStrategy": "optional prototype/PRD consistency strategy",
  "artifacts": []
}
```

The backend currently stores unknown extra fields in `raw`; future appliers can use them. Include structured product payloads when useful, but do not rely on Nest to infer missing intent.

## Direct Answer

Use for greetings, status, and general questions.

```ai_product_workbench_final_action
{"type":"answer","message":"你好，我在。你可以继续描述要做的产品或页面。","intent":"general_question"}
```

## Clarification

Use when product output would require guessing.

```ai_product_workbench_final_action
{
  "type": "ask_clarification",
  "message": "还缺少两个关键信息：目标用户是谁？活动奖励规则是什么？",
  "intent": "new_requirement",
  "questions": [
    "目标用户是谁？",
    "活动奖励规则是什么？"
  ]
}
```

## PRD Review

Use when a requirement or PRD should be reviewed before prototype work.

```ai_product_workbench_final_action
{
  "type": "review_prd",
  "message": "已整理签到活动 PRD，请先确认需求范围。",
  "intent": "generate_prd",
  "requirementMode": "one_sentence_completion",
  "knowledgeRefsUsed": ["01-产品架构/产品能力地图", "02-业务域知识/活动发布与模板配置"],
  "assumptions": ["默认使用活动发布后台、前台活动页、预览审核和活动报表闭环"],
  "productDesignStateDraft": {
    "title": "签到活动",
    "summary": "通过每日签到提升活跃和留存"
  },
  "prdDocumentDraft": {
    "title": "签到活动 PRD",
    "sections": []
  }
}
```

## Prototype Review

Use when generated artifacts should be shown to the user.

```ai_product_workbench_final_action
{
  "type": "review_prototype",
  "message": "已生成签到活动原型，请查看页面和交互。",
  "intent": "generate_prototype",
  "requirementMode": "historical_extension",
  "consistencyStrategy": "沿用历史活动配置页导航、字段分组和预览审核流程，只新增签到规则配置区和前台签到反馈态。",
  "prototypeSpec": {
    "title": "签到活动原型",
    "targetDevice": "mobile"
  },
  "artifacts": [
    {
      "kind": "prototype_html",
      "title": "签到活动原型",
      "path": "mnt/user-data/outputs/checkin-prototype/index.html",
      "contentType": "text/html"
    }
  ]
}
```

## Export

Use when a downloadable file is ready.

```ai_product_workbench_final_action
{
  "type": "download_export",
  "message": "已准备导出文件。",
  "intent": "export_html",
  "artifacts": [
    {
      "kind": "prototype_html",
      "title": "HTML 原型",
      "path": "mnt/user-data/outputs/checkin-prototype.zip",
      "contentType": "application/zip"
    }
  ]
}
```
