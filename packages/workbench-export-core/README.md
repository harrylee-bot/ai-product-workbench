# 产品工作台导出核心

`@workbench/workbench-export-core` consumes immutable Project Release pins and emits standalone HTML, editable React, MCP, or a deterministic `workbench.figma-export.v1` package for the fixed 产品工作台 Figma Importer. Prototype HTML and React exports share the same generated runtime and do not fetch runtime code, icons, fonts, images, or data from the network.

## Prototype runtime

- `form`, `input`, `textarea`, `select`, checkbox, and radio nodes are emitted as native form controls. Select options, radio `optionValue`, and button `buttonType` values are taken directly from the Prototype document.
- Every input has exactly one variable-backed value binding. Checkbox variables are boolean; radio fields share one string-or-null variable across explicit option values; select values must match their declared options.
- `click`, `press`, `change`, `focus`, `blur`, and `submit` actions use browser events and one serialized action queue. `press` shares the native `click` activation slot so keyboard activation remains available without duplicate actions.
- Literal and variable bindings are always active. A state binding is applied only while its referenced state is the active state for that screen.
- A form control whose `value` binding reads a variable writes changes back to that variable and refreshes every binding that reads the same path.
- A native reset button restores only the variables owned by that form, restores its controls, and reapplies active bindings. Sibling forms keep their state.
- Lucide assets are rendered from the pinned local `lucide-react` dependency. Unknown icon names fail export instead of producing a text placeholder.
- Transform motions use additive Web Animations keyframes and are cancelled after transient playback. Static `style.rotation` remains the node's authoritative resting transform.

## Submit event

A Prototype submit action dispatches a bubbling, composed `workbench:prototype-submit` `CustomEvent` before applying `successStateId`. Its deterministic detail is:

```json
{
  "protocol": "workbench.prototype-submit.v1",
  "kind": "submit",
  "documentId": "prototype-document",
  "actionId": "action-submit",
  "formNodeId": "form-node",
  "screenId": "screen-id",
  "values": [
    {
      "bindingId": "binding-email",
      "nodeId": "input-email",
      "fieldName": "email",
      "value": "person@example.com"
    }
  ]
}
```

`values` is sorted by `bindingId` and contains at most one entry for each form field. Values come from the synchronized variable fact source, so Web, standalone HTML, and React exports emit the same payload. Missing or inactive runtime values are emitted as `null`.

## Verification

```bash
npm --workspace @workbench/workbench-contracts run build
npm --workspace @workbench/workbench-export-core run build
npm --workspace @workbench/workbench-export-core run typecheck
npm --workspace @workbench/workbench-export-core run test
```

The Chromium tests abort HTTP, HTTPS, and WSS requests and exercise both standalone HTML and the prebuilt React `dist/index.html`.
