---
title: Vue演示业务边界｜02-素材与Agent
description: 素材、表单与 Agent 执行表现的静态审读边界。
date: 2026-11-10
status: 仅查来源
tags:
  - 策划宝
  - 演示原型
  - 审读证据
aliases:
  - Vue演示业务边界｜02-素材与Agent
---

## 素材、热点和表单

首包和第二包官方素材分支直接写固定 terminal-h5.jpg；“官方授权”“内容安全通过”等由阶段计时文案展示，并无对应真实检索/审查结果。第三包改调用 page.prepare，但前端 officialMaterialMatched 仍只是固定四种终端的字符串匹配。第三分区模拟 Agent 也只对这几种机型选同一张素材图，不能表述为已接通素材平台或内容安全服务。自有素材入口检查 JPG/PNG 的扩展名、MIME 和≤10MB，再通过 FormData 上传。[早包素材原件](<storage/source-assets/cehuabao-local/originals/277f637ffcb35b45/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/277f637ffcb35b4580048b1ef818dfa444a618dd44124d7ec0f13a65dd495ad2.md>)）；[第三包素材原件](<storage/source-assets/cehuabao-local/originals/f2fee83ad3e8bf06/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/f2fee83ad3e8bf063c70cc9255b9eb742b0a286c3079b94a5dc28c6122c21b43.md>)）；[模拟Agent审读](<storage/source-assets/cehuabao-local/review/agent-3-wechat-code/62f958e0013aa35faaf1daef48cb030db52721dcaeeb6017c03411aa3f07bb63.md>)。

热点限制1–3个，名字≤16，动作 form/stores/prize，矩形应在图像百分比边界内。预约表单最多10字段，手机号不允许关闭或设为非必填，协议要求用户同意。早包和第三包内联编辑保留标题20/标签12的上限，而第三包新弹窗标题/标签各允许30，属于同版本两处约束不一致，不能直接选其中一处作为统一产品规格。第三包弹窗保存 trim 后字段并强制手机号启用/必填；保存失败方法内未见显式恢复已提交到前端状态的值。[热点与表单原件](<storage/source-assets/cehuabao-local/originals/f2fee83ad3e8bf06/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/f2fee83ad3e8bf063c70cc9255b9eb742b0a286c3079b94a5dc28c6122c21b43.md>)）。

门店导入接受 csv/xlsx、非空且≤10MB，模板八列为门店编码、门店名称、省份、城市、地址、经度、纬度、状态。早两包 confirmUpload 不以 result.passed 真值阻断成功提示，且发布前校验会由前端补 validated=true、缺省128家和全有效记录；第三包明确在 !passed 时留在上传，并以 validateActivity(id, version) 返回结果决定是否进入人工确认。[早包导入与校验原件](<storage/source-assets/cehuabao-local/originals/277f637ffcb35b45/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/277f637ffcb35b4580048b1ef818dfa444a618dd44124d7ec0f13a65dd495ad2.md>)）；[第二包导入与校验原件](<storage/source-assets/cehuabao-local/originals/962ebb250764a4a4/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/962ebb250764a4a4b61744a0448486b299cbc1047a8e65eef0197e91db300fb6.md>)）；[第三包导入与校验原件](<storage/source-assets/cehuabao-local/originals/f2fee83ad3e8bf06/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/f2fee83ad3e8bf063c70cc9255b9eb742b0a286c3079b94a5dc28c6122c21b43.md>)）。

第三包前端修正不等于门店已逐行核验。配套 Node 模拟服务仍对 csv/xlsx 的非空上传返回固定128/126/2，nearest 校验也可补128家；未解析工作簿或查询真实系统门店。H5服务门店是生成的演示目录，距离也为固定演示值。[第三分区新版mock服务审读](<storage/source-assets/cehuabao-local/review/agent-3-wechat-code/8b92bbe349b4a9ceb7ad6edf156a6d2369850a2d43da7ecafdde9d1518955ff2.md>)。
## Agent执行、指令与取消

早两包 runAgent 只提交 phase/fields，文字流、漩涡、移动和打字动画由前端计时驱动；暂停/跳过动画不能证明取消已发接口。sendCommand 仅正则支持“活动名称改为/修改为/设置为”，其他输入只产生待处理事件。

第三包引入 AgentRunPanel 和 run 状态机：queued/running/awaiting_confirmation 为活跃，succeeded/failed/cancelled/rejected 为结束态。组件可取消、重试，以及应用/放弃建议；成功且有 applied_activity_version 后刷新活动。工作台提交 operation、当前活动版本、会话与输入，而不直接用任意用户文本 patch 活动；接收建议会清确认并按需要重新校验。业务时间线过滤内部 tick/provider 信息，按 run/sequence 去重；分析动画仍不能作为模型调用证据。[AgentRunPanel原件](<storage/source-assets/cehuabao-local/originals/4a7b1ce3c8da78ca/AgentRunPanel.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/4a7b1ce3c8da78ca6dc54607c2d8d6c72d2d4065d514ef290b6fd139a9a3eea5.md>)）；[任务操作原件](<storage/source-assets/cehuabao-local/originals/f2fee83ad3e8bf06/index.vue>)（[逐源笔记](<storage/source-assets/cehuabao-local/review/agent-2-vue/f2fee83ad3e8bf063c70cc9255b9eb742b0a286c3079b94a5dc28c6122c21b43.md>)）。

配对 agent-service 的 provider 固定 mock，没有 Dify/LLM 调用；读取任务/list/events 可按时间推进并自动应用，取消前任务可能刚好完成，因此不能承诺取消必定撤销写入。指令理解在该模拟服务里仍只支持正则改名；page.prepare 的“生成热点”文案并未对应新增热点的 patch。校验操作执行成功也可能返回业务错误，run succeeded 不等于活动可发布。[Agent状态与操作边界](<storage/source-assets/cehuabao-local/review/agent-3-wechat-code/62f958e0013aa35faaf1daef48cb030db52721dcaeeb6017c03411aa3f07bb63.md>)。
