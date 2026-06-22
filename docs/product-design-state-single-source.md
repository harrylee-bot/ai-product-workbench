# ProductDesignState 唯一事实源

## 核心规则

`ProductDesignState` 是 Vibe Coding 的唯一事实源。PRD、PrototypeSpec、HTML Prototype、Patch、QA 都不能各自维护业务事实。

正式需求必须先规划，再进入 `ProductDesignState`：

```text
Formal Requirement
  -> ProductBuildPlan
  -> ProductDesignState draft/new version
  -> PRD regenerated from ProductDesignState
  -> PrototypeSpec regenerated from ProductDesignState
  -> HTML regenerated from PrototypeSpec
  -> QA checks the same ProductDesignState bundle
```

局部修改必须先进入 `PatchPlan`，再进入 `ProductDesignState`：

```text
Selected Region + User Change
  -> PatchPlan / State PatchOperation
  -> ProductDesignState new version
  -> PRD regenerated from ProductDesignState
  -> PrototypeSpec regenerated from ProductDesignState
  -> HTML regenerated from PrototypeSpec
  -> QA checks the same ProductDesignState bundle
```

## 已固化的代码约束

- PRD 生成只读取 `ProductDesignState`，公共生成入口会把生成后的 PRD 快照同步回 State。
- Prototype 生成只读取 `ProductDesignState`，公共生成入口会把生成后的 PrototypeSpec 快照同步回 State。
- 正式需求必须先生成 `ProductBuildPlan`，再由 Product Designer Agent 写入 `ProductDesignState`。
- Patch 只能输出作用于 `ProductDesignState` 路径的 operations，应用后重新生成 PRD、Prototype 和 QA。
- QA 优先读取 `ProductDesignState.prdDocument` 与 `ProductDesignState.prototypeSpec`，项目指针只作为同源 fallback。
- 当前 PRD / Prototype 读取会过滤和当前 State 不匹配的旧项目指针，避免展示过期产物。

## 禁止

- 禁止直接修改 PRD 后绕过 `ProductDesignState`。
- 禁止直接修改 HTML 后绕过 `ProductDesignState` 和 `PrototypeSpec`。
- 禁止正式需求绕过 `ProductBuildPlan` 直接散落到 PRD、Prototype 或 QA。
- 禁止 QA 混用当前 State 与旧 PRD / 旧 Prototype。
- 禁止 Patch 直接作用于 PRD section 或 HTML DOM；Patch 必须先转换成 State path operation。
