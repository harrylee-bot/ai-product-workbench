export const WORKBENCH_TOOL_GROUP = Object.freeze({ name: "workbench" });

export const WORKBENCH_TRUSTED_TOOLS = Object.freeze([
  Object.freeze({
    name: "workbench_artifact_draft_publish",
    group: "workbench",
    use: "deerflow_workbench_tools.artifact_draft_tool:workbench_artifact_draft_publish",
  }),
  Object.freeze({
    name: "workbench_generation_stage_update",
    group: "workbench",
    use: "deerflow_workbench_tools.generation_stage_tool:workbench_generation_stage_update",
  }),
  Object.freeze({
    name: "workbench_prototype_patch_publish",
    group: "workbench",
    use: "deerflow_workbench_tools.prototype_patch_tool:workbench_prototype_patch_publish",
  }),
  Object.freeze({
    name: "workbench_knowledge_retrieve",
    group: "workbench",
    use: "deerflow_workbench_tools.knowledge_tool:workbench_knowledge_retrieve",
  }),
  Object.freeze({
    name: "workbench_runtime_result_submit",
    group: "workbench",
    use: "deerflow_workbench_tools.runtime_result_tool:workbench_runtime_result_submit",
  }),
]);

export const WORKBENCH_CANVAS_TOOLS = Object.freeze([
  Object.freeze({
    name: "get_visible_screens",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:get_visible_screens",
  }),
  Object.freeze({
    name: "get_selected_screens",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:get_selected_screens",
  }),
  Object.freeze({
    name: "view_screen",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:view_screen",
  }),
  Object.freeze({
    name: "select_screen",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:select_screen",
  }),
  Object.freeze({
    name: "quick_edit",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:quick_edit",
  }),
  Object.freeze({
    name: "duplicate_screen",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:duplicate_screen",
  }),
  Object.freeze({
    name: "rename_screen",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:rename_screen",
  }),
  Object.freeze({
    name: "navigate_canvas",
    group: "workbench",
    use: "deerflow_workbench_tools.canvas_tool:navigate_canvas",
  }),
]);

export const WORKBENCH_RUNTIME_TOOLS = Object.freeze([
  ...WORKBENCH_TRUSTED_TOOLS,
  ...WORKBENCH_CANVAS_TOOLS,
]);

export const WORKBENCH_RUNTIME_TOOL_NAMES = Object.freeze(
  WORKBENCH_RUNTIME_TOOLS.map((tool) => tool.name),
);

export const WORKBENCH_SKILL_ALLOWED_TOOLS = Object.freeze([
  "task",
  ...WORKBENCH_RUNTIME_TOOL_NAMES,
  "bash",
  "ls",
  "read_file",
  "write_file",
  "str_replace",
  "present_file",
  "ask_clarification",
]);
