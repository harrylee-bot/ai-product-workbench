# Final Action Contract

The final action is the only instruction AI Product Workbench will persist from DeerFlow. It must be valid JSON inside a fenced block named `ai_product_workbench_final_action`.

## Common Fields

```json
{
  "type": "answer | review_prd | review_prototype | ask_clarification | download_export",
  "message": "Chinese user-facing summary",
  "intent": "optional UserIntent label",
  "requirementMode": "historical_extension | new_capability | brand_new_system | one_sentence_completion",
  "knowledgeRefsUsed": ["optional knowledge paths or titles used for reasoning"],
  "externalRefsUsed": ["optional public reference title + URL strings"],
  "externalResearchStatus": "completed | skipped_not_needed | skipped_tools_unavailable | failed_non_blocking",
  "enrichmentNotes": ["user-safe knowledge/model/web enrichment notes"],
  "assumptions": ["optional inferred product facts, especially for one-sentence requirements"],
  "consistencyStrategy": "optional prototype/PRD consistency strategy",
  "qualitySelfCheck": {
    "passed": true,
    "missing": [],
    "stateCoverage": ["checked design-state groups"],
    "prdChecks": ["checked PRD requirements"],
    "prototypeChecks": ["checked prototype requirements"],
    "knowledgeChecks": ["checked knowledge requirements"]
  },
  "artifacts": []
}
```

For every `review_prd` or `review_prototype`, `designStateDraft` is mandatory. When PRD and prototype are requested together, the same final action must also include `prdDocumentDraft`, `prototypeSpec`, and one `prototype_html` artifact. The backend rejects missing structured payloads; do not rely on Nest to infer them from prose or HTML.

For every `prototype_html`, `prototypeChecks` must explicitly cover a valid viewport, a mobile breakpoint no wider than 768px, page-level overflow protection, real click behavior for key actions, and successful desktop plus 390x844 rendering. The standalone HTML must implement those checks; listing them in JSON without executable behavior does not count.

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
  "message": "还缺少两个会改变业务方案的关键信息，请补充后继续生成。",
  "intent": "new_requirement",
  "questions": [
    "目标用户是谁？",
    "决定核心操作成功结果的业务条件是什么？"
  ]
}
```

## PRD Review

Use when a requirement or PRD should be reviewed before prototype work.

```ai_product_workbench_final_action
{
  "type": "review_prd",
  "message": "已生成完整需求说明书，请查看并评审。",
  "intent": "generate_prd",
  "requirementMode": "one_sentence_completion",
  "knowledgeRefsUsed": ["<文档规范>", "<当前业务知识>"],
  "assumptions": ["<可评审业务假设>"],
  "qualitySelfCheck": {
    "passed": true,
    "missing": [],
    "stateCoverage": ["全部设计状态分组已检查"],
    "prdChecks": ["固定结构、唯一渠道表与正文一致性、流程图、架构图、验收、降级、21 行安全基线及敏感项证据已检查"],
    "prototypeChecks": ["本轮未要求原型"],
    "knowledgeChecks": ["文档规范和当前业务知识已落实"]
  },
  "designStateDraft": {
    "title": "<需求名称>",
    "summary": "<本次需求范围和业务闭环>",
    "businessGoal": "<目标对象、期望变化和可衡量结果>",
    "targetUsers": [{"id":"target-1","name":"<目标用户>","description":"<用户职责>"}],
    "userScenarios": [{"id":"scenario-1","title":"<核心场景>","description":"<触发和结果>"}],
    "pages": [{"id":"page-1","name":"<页面名称>","description":"<页面职责>"}],
    "features": [{"id":"feature-1","name":"<功能名称>","description":"<成功结果>"}],
    "backendConfigs": [{"id":"config-1","name":"<后台配置>","description":"<字段和校验>"}],
    "frontendRules": [{"id":"front-rule-1","title":"<前台规则>","description":"<页面反馈>"}],
    "businessRules": [{"id":"business-rule-1","title":"<业务规则>","description":"<触发和边界>"}],
    "stateRules": [{"id":"state-1","name":"<关键状态>","description":"<进入条件和允许动作>"}],
    "exceptionScenarios": [{"id":"exception-1","title":"<异常场景>","expectedBehavior":"<提示和恢复动作>"}],
    "acceptanceCriteria": [{"id":"acceptance-1","title":"<验收项>","description":"<可测试标准>"}]
  },
  "prdDocumentDraft": {
    "title": "<需求名称>需求说明书",
    "sections": [
      {
        "id": "background",
        "title": "1.1 项目背景",
        "type": "background",
        "level": 2,
        "order": 1,
        "content": "<具体业务背景>"
      },
      {
        "id": "core_flow_state",
        "title": "2.3 核心流程/状态/页面要求",
        "type": "flow",
        "level": 2,
        "order": 10,
        "content": "<页面、流程、状态和异常要求>",
        "blocks": [
          {"id":"flow","type":"diagram","title":"产品流程图","diagramSyntax":"mermaid","content":"flowchart TD\n  A[<开始>] --> B[<结果>]"},
          {"id":"architecture","type":"diagram","title":"产品架构图","diagramSyntax":"mermaid","content":"flowchart LR\n  A[<页面层>] --> B[<能力层>]"}
        ]
      }
    ]
  }
}
```

## Prototype Review

Use when generated artifacts should be shown to the user. Include the full `designStateDraft` above. When PRD and prototype are generated together, include the complete `prdDocumentDraft` in this same action as well.

```ai_product_workbench_final_action
{
  "type": "review_prototype",
  "message": "已生成完整需求说明书和高保真原型，请查看。",
  "intent": "generate_prd_and_prototype",
  "requirementMode": "one_sentence_completion",
  "designStateDraft": {"title":"<需求名称>","summary":"<范围>","businessGoal":"<目标>","targetUsers":[{"id":"target-1","name":"<目标用户>"}],"userScenarios":[{"id":"scenario-1","title":"<场景>"}],"pages":[{"id":"page-1","name":"<后台页面>"},{"id":"page-2","name":"<前台页面>"}],"features":[{"id":"feature-1","name":"<功能>"}],"backendConfigs":[{"id":"config-1","name":"<配置>"}],"frontendRules":[{"id":"front-1","title":"<前台规则>"}],"businessRules":[{"id":"rule-1","title":"<业务规则>"}],"stateRules":[{"id":"state-1","name":"<状态>"}],"exceptionScenarios":[{"id":"exception-1","title":"<异常>"}],"acceptanceCriteria":[{"id":"acceptance-1","title":"<验收项>"}]},
  "prdDocumentDraft": {"title":"<需求名称>需求说明书","sections":["<完整固定结构章节对象>"]},
  "prototypeSpec": {
    "title": "<需求名称>原型",
    "targetDevice": "both",
    "styleGuide": {"tone":"business","layoutDensity":"compact","borderRadius":"small"},
    "pages": [
      {"id":"page-1","name":"<后台页面>","device":"responsive","layout":"dashboard","components":[{"id":"component-1","name":"<配置表单>","type":"form","sourcePaths":["backendConfigs"]}],"states":[{"id":"state-1","name":"<正常/异常状态>","description":"<页面表现>","sourcePaths":["stateRules"]}],"sourcePaths":["pages"],"order":1},
      {"id":"page-2","name":"<前台页面>","device":"responsive","layout":"mobile_page","components":[{"id":"component-2","name":"<核心操作>","type":"button","sourcePaths":["features"]}],"states":[{"id":"state-2","name":"<结果状态>","description":"<结果反馈>","sourcePaths":["exceptionScenarios"]}],"sourcePaths":["pages"],"order":2}
    ],
    "navigation": [],
    "interactions": [
      {"id":"interaction-save","trigger":"点击保存","action":"校验表单并显示保存成功或字段错误"},
      {"id":"interaction-primary","trigger":"点击核心操作","action":"更新按钮、状态文案或页面内容并提供可见反馈"}
    ]
  },
  "artifacts": [
    {
      "kind": "prototype_html",
      "title": "<需求名称>高保真原型",
      "path": "mnt/user-data/outputs/index.html",
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
