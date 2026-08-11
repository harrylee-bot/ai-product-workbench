import { isSafePrototypeOpenUrl } from "@workbench/workbench-contracts";

const safePrototypeOpenUrlRuntimeSource = isSafePrototypeOpenUrl.toString();

export const browserRuntimeSource = String.raw`(() => {
  ${safePrototypeOpenUrlRuntimeSource}
  const dataNode = document.getElementById("workbench-export-data");
  const root = document.getElementById("workbench-export-root");
  if (!dataNode || !root) return;
  const data = JSON.parse(dataNode.textContent || "{}");
  install(root, data, root.querySelector(".wb-export--preview") !== null);

  function install(scope, runtime, preview) {
    for (const model of runtime.prototypes || []) installPrototype(scope, model, preview);
  }

  function installPrototype(scope, model, preview) {
    const host = scope.querySelector('[data-wb-prototype="' + cssEscape(model.id) + '"]');
    if (!host) return;
    if (host.dataset.wbRuntimeInstalled === "true") return;
    host.dataset.wbRuntimeInstalled = "true";
    const byNode = (nodeId) => host.querySelector('[data-wb-node="' + cssEscape(nodeId) + '"]');
    const screens = new Map((model.screens || []).map((screen) => [screen.id, screen]));
    let activeScreenId = null;
    const previewStage = preview ? host.querySelector(".wb-prototype__stage") : null;
    const fitPreviewScreens = () => {
      if (!previewStage) return;
      const stageWidth = previewStage.clientWidth;
      const stageHeight = previewStage.clientHeight;
      if (stageWidth <= 0 || stageHeight <= 0) return;
      for (const element of host.querySelectorAll("[data-wb-screen]")) {
        const screen = screens.get(element.dataset.wbScreen);
        if (!screen) continue;
        const scale = Math.min(
          1,
          stageWidth / screen.viewport.width,
          stageHeight / screen.viewport.height,
        );
        element.style.transform = "translate(-50%, -50%) scale(" + String(scale) + ")";
        element.dataset.previewScale = String(scale);
      }
      const active = activeScreenId ? screens.get(activeScreenId) : null;
      const activeScale = active ? Math.min(1, stageWidth / active.viewport.width, stageHeight / active.viewport.height) : 1;
      previewStage.dataset.previewScale = String(activeScale);
    };
    const previewResizeObserver = preview && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => fitPreviewScreens())
      : null;
    if (previewStage && previewResizeObserver) previewResizeObserver.observe(previewStage);
    if (preview) window.addEventListener("resize", fitPreviewScreens);
    const states = new Map((model.states || []).map((state) => [state.id, state]));
    const bindings = new Map((model.bindings || []).map((binding) => [binding.id, binding]));
    const initialVariables = new Map((model.variables || []).map((variable) => [variable.path, variable.initialValue]));
    const variables = new Map(initialVariables);
    const imageAssets = new Map((model.imageAssets || []).map((asset) => [asset.id, asset.src]));
    const activeStates = new Map();
    const base = new Map();
    const animations = new Map();
    let transition = Promise.resolve();
    let actionQueue = Promise.resolve();
    const pendingSubmitActions = new Set();

    for (const element of host.querySelectorAll("[data-wb-node]")) {
      const content = contentTarget(element);
      base.set(element.dataset.wbNode, {
        style: element.getAttribute("style"),
        hidden: element.hidden,
        disabled: "disabled" in element ? element.disabled : undefined,
        content: content ? content.textContent : undefined,
        src: element instanceof HTMLImageElement ? element.src : undefined,
        value: isFormControl(element) ? element.value : undefined,
        checked: element instanceof HTMLInputElement && isCheckable(element) ? element.checked : undefined,
      });
    }

    const screenIdFor = (element) => element.closest("[data-wb-screen]")?.dataset.wbScreen || null;

    const resetScreenState = (screenId) => {
      for (const [nodeId, snapshot] of base) {
        const element = byNode(nodeId);
        if (!element || screenIdFor(element) !== screenId) continue;
        snapshot.style === null ? element.removeAttribute("style") : element.setAttribute("style", snapshot.style);
        element.hidden = snapshot.hidden;
        if (snapshot.disabled !== undefined && "disabled" in element) element.disabled = snapshot.disabled;
        const content = contentTarget(element);
        if (content && snapshot.content !== undefined) content.textContent = snapshot.content;
        if (snapshot.src !== undefined && element instanceof HTMLImageElement) element.src = snapshot.src;
        if (isFormControl(element) && hasStateValueBinding(nodeId)) {
          if (snapshot.value !== undefined) element.value = snapshot.value;
          if (snapshot.checked !== undefined && element instanceof HTMLInputElement) element.checked = snapshot.checked;
        }
      }
    };

    const resolveBinding = (binding) => {
      if (binding.source.kind === "literal") return binding.source.value;
      if (binding.source.kind === "variable") return variables.get(binding.source.path);
      const state = states.get(binding.source.stateId);
      if (!state || activeStates.get(state.screenId) !== state.id) return undefined;
      return state.values[binding.source.field];
    };

    const applyBinding = (binding) => {
      const element = byNode(binding.nodeId);
      if (!element) return;
      const value = resolveBinding(binding);
      if (value === undefined) return;
      setProperty(element, binding.property, value, imageAssets);
    };

    const applyBindings = (screenId, variablePath) => {
      for (const binding of model.bindings || []) {
        const element = byNode(binding.nodeId);
        if (!element || (screenId && screenIdFor(element) !== screenId)) continue;
        if (variablePath && (binding.source.kind !== "variable" || binding.source.path !== variablePath)) continue;
        applyBinding(binding);
      }
    };

    const applyState = async (stateId) => {
      const state = states.get(stateId);
      if (!state) return;
      activeStates.set(state.screenId, state.id);
      resetScreenState(state.screenId);
      for (const override of state.overrides) {
        const element = byNode(override.nodeId);
        if (!element) continue;
        if (override.visible !== undefined) element.hidden = !override.visible;
        if (override.enabled !== undefined && "disabled" in element) element.disabled = !override.enabled;
        if (override.text !== undefined) setText(element, override.text);
        if (override.style !== undefined) element.setAttribute("style", override.style);
        if (override.src !== undefined && element instanceof HTMLImageElement) element.src = override.src;
      }
      applyBindings(state.screenId);
      await runMotions("stateChange", { stateId, screenId: state.screenId });
    };

    const clearState = (screenId) => {
      activeStates.set(screenId, null);
      resetScreenState(screenId);
      applyBindings(screenId);
    };

    const resetForm = (form) => {
      const controlNodeIds = new Set();
      for (const element of form.querySelectorAll("input[data-wb-node],textarea[data-wb-node],select[data-wb-node]")) {
        const snapshot = base.get(element.dataset.wbNode);
        if (!snapshot) continue;
        controlNodeIds.add(element.dataset.wbNode);
        if (snapshot.value !== undefined) element.value = snapshot.value;
        if (snapshot.checked !== undefined && element instanceof HTMLInputElement) element.checked = snapshot.checked;
      }
      const variablePaths = new Set();
      for (const binding of bindings.values()) {
        if (
          controlNodeIds.has(binding.nodeId)
          && binding.property === "value"
          && binding.source.kind === "variable"
        ) variablePaths.add(binding.source.path);
      }
      for (const path of variablePaths) {
        if (initialVariables.has(path)) variables.set(path, initialVariables.get(path));
      }
      applyBindings(null);
    };

    const showScreenNow = async (screenId) => {
      const next = screens.get(screenId);
      if (!next) return;
      const previousId = activeScreenId;
      if (previousId && previousId !== screenId) {
        await runMotions("exit", { screenId: previousId });
      }
      for (const screen of host.querySelectorAll("[data-wb-screen]")) {
        screen.hidden = screen.dataset.wbScreen !== screenId;
      }
      for (const button of host.querySelectorAll("[data-wb-screen-target]")) {
        button.setAttribute("aria-selected", String(button.dataset.wbScreenTarget === screenId));
      }
      activeScreenId = screenId;
      fitPreviewScreens();
      if (next.initialStateId) await applyState(next.initialStateId);
      else clearState(screenId);
      await runMotions("enter", { screenId });
    };

    const showScreen = (screenId) => {
      transition = transition.catch(() => {}).then(() => showScreenNow(screenId));
      return transition;
    };

    async function runMotions(trigger, options = {}) {
      const selected = (model.motions || []).filter((motion) => {
        if (motion.trigger !== trigger) return false;
        if (options.nodeId && motion.nodeId !== options.nodeId) return false;
        if (motion.stateId !== null && motion.stateId !== options.stateId) return false;
        if (motion.actionId !== null && motion.actionId !== options.actionId) return false;
        const element = byNode(motion.nodeId);
        return Boolean(element && (!options.screenId || screenIdFor(element) === options.screenId));
      });
      await Promise.all(selected.map((motion) => animateMotion(motion, options.reverse === true, options.persist === true)));
    }

    async function animateMotion(motion, reverse, persist) {
      const element = byNode(motion.nodeId);
      if (!element || typeof element.animate !== "function") return;
      const key = motion.trigger + ":" + motion.id;
      const previous = animations.get(key);
      if (previous) {
        previous.cancel();
        animations.delete(key);
      }
      const from = reverse ? motion.to : motion.from;
      const to = reverse ? motion.from : motion.to;
      const animation = element.animate([motionFrame(motion.property, from), motionFrame(motion.property, to)], {
        duration: motion.duration,
        delay: reverse ? 0 : motion.delay,
        easing: easing(motion.easing),
        fill: persist ? "both" : "none",
      });
      animation.id = "workbench:" + motion.id;
      animations.set(key, animation);
      try {
        await animation.finished;
      } catch {
        return;
      }
      if (!persist && animations.get(key) === animation) {
        animation.cancel();
        animations.delete(key);
      }
    }

    const invokeAction = async (action, element) => {
      await runMotions("action", { actionId: action.id, screenId: screenIdFor(element) });
      if (action.kind === "openUrl") {
        if (!isSafePrototypeOpenUrl(action.url)) return;
        if (action.target === "newWindow") window.open(action.url, "_blank", "noopener,noreferrer");
        else window.location.assign(action.url);
        return;
      }
      if (action.kind === "submit") {
        const detail = submitDetail(action, element);
        element.dispatchEvent(new CustomEvent("workbench:prototype-submit", {
          bubbles: true,
          composed: true,
          detail,
        }));
        if (action.successStateId) await applyState(action.successStateId);
        return;
      }
      if (action.kind === "navigate") await showScreen(action.targetScreenId);
      if (action.kind === "setState") await applyState(action.targetStateId);
    };

    const submitDetail = (action, element) => ({
      protocol: "workbench.prototype-submit.v1",
      kind: "submit",
      documentId: model.documentId,
      actionId: action.id,
      formNodeId: action.nodeId,
      screenId: screenIdFor(element),
      values: [...action.bindingIds].sort(compareStrings).flatMap((bindingId) => {
        const binding = bindings.get(bindingId);
        const bindingElement = binding ? byNode(binding.nodeId) : null;
        if (
          !binding
          || binding.property !== "value"
          || !bindingElement
          || !("name" in bindingElement)
          || !bindingElement.name
        ) return [];
        return [{
          bindingId,
          nodeId: binding.nodeId,
          fieldName: bindingElement.name,
          value: runtimeValue(resolveBinding(binding)),
        }];
      }),
    });

    const syncVariableControl = (element) => {
      const nodeId = element.dataset.wbNode;
      if (!nodeId) return;
      for (const binding of model.bindings || []) {
        if (
          binding.nodeId !== nodeId
          || binding.property !== "value"
          || binding.source.kind !== "variable"
        ) continue;
        const value = runtimeValue(readControl(element));
        if (element instanceof HTMLInputElement && element.type === "radio" && value === null) continue;
        variables.set(binding.source.path, value);
        applyBindings(null, binding.source.path);
      }
    };

    for (const element of host.querySelectorAll("input[data-wb-node],textarea[data-wb-node],select[data-wb-node]")) {
      element.addEventListener("input", () => syncVariableControl(element));
      element.addEventListener("change", () => syncVariableControl(element));
    }
    for (const form of host.querySelectorAll("form[data-wb-node]")) {
      form.addEventListener("reset", (browserEvent) => {
        browserEvent.preventDefault();
        resetForm(form);
      });
    }
    for (const button of host.querySelectorAll("[data-wb-screen-target]")) {
      button.addEventListener("click", () => void showScreen(button.dataset.wbScreenTarget));
    }
    for (const action of model.actions || []) {
      const element = byNode(action.nodeId);
      if (!element) continue;
      const event = actionEvent(action);
      element.addEventListener(event, (browserEvent) => {
        if (event === "submit") browserEvent.preventDefault();
        const submitActionId = action.kind === "submit" ? action.id : null;
        if (submitActionId && pendingSubmitActions.has(submitActionId)) return;
        if (submitActionId) pendingSubmitActions.add(submitActionId);
        const execution = actionQueue.catch(() => {}).then(() => invokeAction(action, element));
        actionQueue = execution.finally(() => {
          if (submitActionId) pendingSubmitActions.delete(submitActionId);
        });
      });
    }
    const interactiveMotionNodes = new Set();
    for (const motion of (model.motions || []).filter((candidate) => candidate.trigger === "hover" || candidate.trigger === "press")) {
      const interactiveKey = motion.trigger + ":" + motion.nodeId;
      if (interactiveMotionNodes.has(interactiveKey)) continue;
      interactiveMotionNodes.add(interactiveKey);
      const element = byNode(motion.nodeId);
      if (!element) continue;
      if (motion.trigger === "hover") {
        element.addEventListener("pointerenter", () => void runMotions("hover", { nodeId: motion.nodeId, persist: true }));
        element.addEventListener("pointerleave", () => void runMotions("hover", { nodeId: motion.nodeId, reverse: true }));
      } else {
        const press = () => void runMotions("press", { nodeId: motion.nodeId, persist: true });
        const release = () => void runMotions("press", { nodeId: motion.nodeId, reverse: true });
        element.addEventListener("pointerdown", press);
        element.addEventListener("pointerup", release);
        element.addEventListener("pointercancel", release);
        element.addEventListener("keydown", (event) => {
          if (!event.repeat && (event.key === "Enter" || event.key === " ")) press();
        });
        element.addEventListener("keyup", (event) => {
          if (event.key === "Enter" || event.key === " ") release();
        });
      }
    }
    void showScreen(model.initialScreenId);
    fitPreviewScreens();
    if (preview) {
      window.addEventListener("pagehide", () => {
        previewResizeObserver?.disconnect();
        window.removeEventListener("resize", fitPreviewScreens);
      }, { once: true });
    }

    function hasStateValueBinding(nodeId) {
      return (model.bindings || []).some((binding) => (
        binding.nodeId === nodeId
        && binding.property === "value"
        && binding.source.kind === "state"
      ));
    }
  }

  function actionEvent(action) {
    if (action.event === "press") return "click";
    return action.event;
  }

  function motionFrame(property, value) {
    if (property === "opacity") return { opacity: value };
    const transform = property === "x" ? "translateX(" + value + "px)" :
      property === "y" ? "translateY(" + value + "px)" :
      property === "scale" ? "scale(" + value + ")" : "rotate(" + value + "deg)";
    return { transform, composite: "add" };
  }

  function contentTarget(element) {
    if (element.dataset.wbText === "true") return element;
    return element.querySelector(":scope > [data-wb-content]");
  }

  function setText(element, value) {
    const target = contentTarget(element);
    if (target) target.textContent = String(value ?? "");
  }

  function setProperty(element, property, value, imageAssets) {
    if (property === "text") setText(element, value);
    if (property === "value" && isFormControl(element)) {
      if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = value === true;
      else if (element instanceof HTMLInputElement && element.type === "radio") element.checked = typeof value === "string" && value === element.value;
      else element.value = String(value ?? "");
    }
    if (property === "visible") element.hidden = !value;
    if (property === "enabled" && "disabled" in element) element.disabled = !value;
    if (property === "imageAssetId" && element instanceof HTMLImageElement && typeof value === "string") {
      const src = imageAssets.get(value);
      if (src) element.src = src;
    }
  }

  function isFormControl(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  }

  function isCheckable(element) {
    return element.type === "checkbox" || element.type === "radio";
  }

  function readControl(element) {
    if (element instanceof HTMLInputElement && element.type === "checkbox") return element.checked;
    if (element instanceof HTMLInputElement && element.type === "radio") return element.checked ? element.value : null;
    if (element instanceof HTMLInputElement && element.type === "number" && element.value !== "" && Number.isFinite(element.valueAsNumber)) {
      return element.valueAsNumber;
    }
    return element.value;
  }

  function runtimeValue(value) {
    if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  }

  function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function easing(value) {
    return value === "easeIn" ? "ease-in" : value === "easeOut" ? "ease-out" : value === "easeInOut" ? "ease-in-out" : value === "spring" ? "cubic-bezier(.2,.8,.2,1)" : "linear";
  }

  function cssEscape(value) {
    return globalThis.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
  }
})();`;

export function reactRuntimeModuleSource() {
  const body = browserRuntimeSource
    .replace(/^\(\(\) => \{\n/, "")
    .replace(/\n\}\)\(\);$/, "")
    .replace(/  const dataNode[\s\S]*?  install\(root, data, root\.querySelector\("\.wb-export--preview"\) !== null\);\n\n/, "")
    .replace(
      "  function install(scope, runtime, preview) {",
      "export function installWorkbenchRuntime(scope, runtime, preview = false) {",
    );
  return body.trimStart();
}
