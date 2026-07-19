import type {
  ArtifactVersionDetail,
  PrototypeScreen,
} from "@workbench/workbench-contracts";

export type ScreenContextPhase = "idle" | "generating" | "refining" | "complete";

export type ScreenContextReference = {
  artifactId: string;
  artifactVersionId: string;
  projectId: string;
  screenId: string;
};

export type ScreenContextTarget = {
  id: string;
  persisted: boolean;
  phase: ScreenContextPhase;
  reference: ScreenContextReference;
  size: {
    height: number;
    width: number;
  };
  title: string;
  version: ArtifactVersionDetail | null;
};

export type ScreenContextCapabilities = {
  canEdit: boolean;
  canExport: boolean;
  canPreview: boolean;
  canRun: boolean;
};

export type ScreenContextEnvironment = {
  activeRun: boolean;
  capabilities: ScreenContextCapabilities;
  directEditAvailable: boolean;
  editArtifactTargetsValid: boolean;
  editModelAvailable: boolean;
  generatePrototypeTargetsValid: boolean;
};

export type ScreenContextBlockReason =
  | "active-run"
  | "artifact-mismatch"
  | "artifact-not-inline-prototype"
  | "artifact-not-ready"
  | "artifact-unavailable"
  | "duplicate-screen-targets"
  | "edit-model-unavailable"
  | "edit-targets-invalid"
  | "export-unavailable"
  | "generate-targets-invalid"
  | "insufficient-selection"
  | "preview-unavailable"
  | "read-only"
  | "run-unavailable"
  | "screen-unavailable"
  | "target-not-complete"
  | "target-not-persisted";

export type ScreenContextAvailability =
  | { enabled: true; reason: null }
  | { enabled: false; reason: ScreenContextBlockReason };

export type PrototypeScreenRuntimeAnalysis =
  | {
      actionCount: number;
      kind: "runnable";
      reason: null;
      screen: PrototypeScreen;
    }
  | {
      actionCount: 0;
      kind: "non-interactive";
      reason: "screen-has-no-actions";
      screen: PrototypeScreen;
    }
  | {
      actionCount: 0;
      kind: "blocked";
      reason: Extract<
        ScreenContextBlockReason,
        | "artifact-not-inline-prototype"
        | "artifact-not-ready"
        | "artifact-unavailable"
        | "screen-unavailable"
      >;
      screen: null;
    };

export type ScreenModifyDisposition =
  | { kind: "direct-edit"; reason: null }
  | { kind: "agent-edit"; reason: null }
  | { kind: "blocked"; reason: ScreenContextBlockReason };

export type ScreenPreviewDisposition =
  | {
      kind: "open-existing";
      reason: null;
      reference: ScreenContextReference;
    }
  | {
      kind: "generate-required";
      reason: "screen-has-no-actions";
      reference: ScreenContextReference;
    }
  | {
      kind: "blocked";
      reason: ScreenContextBlockReason;
    };

export type MultipleScreenPreviewDisposition =
  | {
      kind: "open-existing";
      reason: null;
      references: ScreenContextReference[];
    }
  | {
      kind: "generate-required";
      reason: "screen-has-no-actions";
      references: ScreenContextReference[];
    }
  | {
      kind: "blocked";
      reason: ScreenContextBlockReason;
    };

export type SingleScreenContextAvailability = {
  delete: ScreenContextAvailability;
  duplicate: ScreenContextAvailability;
  export: ScreenContextAvailability;
  favourite: ScreenContextAvailability;
  generate: ScreenContextAvailability;
  modify: ScreenContextAvailability;
  more: ScreenContextAvailability;
  preview: ScreenContextAvailability;
  rename: ScreenContextAvailability;
  versionHistory: ScreenContextAvailability;
};

export type MultipleScreenContextAvailability = {
  align: ScreenContextAvailability;
  delete: ScreenContextAvailability;
  distribute: ScreenContextAvailability;
  duplicate: ScreenContextAvailability;
  export: ScreenContextAvailability;
  generateVariants: ScreenContextAvailability;
  preview: ScreenContextAvailability;
};

export type ScreenContextState =
  | {
      availability: Record<never, never>;
      kind: "none";
      targets: [];
    }
  | {
      availability: SingleScreenContextAvailability;
      kind: "single";
      modifyDisposition: ScreenModifyDisposition;
      previewDisposition: ScreenPreviewDisposition;
      target: ScreenContextTarget;
      targets: [ScreenContextTarget];
    }
  | {
      availability: MultipleScreenContextAvailability;
      kind: "multiple";
      previewDisposition: MultipleScreenPreviewDisposition;
      targets: ScreenContextTarget[];
    };

/**
 * A static Prototype screen is not an existing interactive Preview. Actions
 * are resolved per screen so behavior on a sibling screen cannot make the
 * selected screen appear runnable.
 */
export function analyzePrototypeScreenRuntime(
  version: ArtifactVersionDetail | null,
  screenId: string,
): PrototypeScreenRuntimeAnalysis {
  if (!version) return blockedRuntime("artifact-unavailable");
  if (version.status !== "ready") return blockedRuntime("artifact-not-ready");
  if (
    version.kind !== "prototype"
    || version.schemaVersion !== 1
    || version.contentMode !== "inline"
  ) {
    return blockedRuntime("artifact-not-inline-prototype");
  }

  const screen = version.content.screens.find((candidate) => candidate.id === screenId);
  if (!screen) return blockedRuntime("screen-unavailable");
  const screenNodeIds = new Set(
    version.content.nodes
      .filter((node) => node.screenId === screenId)
      .map((node) => node.id),
  );
  const actionCount = version.content.actions.filter((action) => (
    screenNodeIds.has(action.nodeId)
  )).length;
  if (actionCount === 0) {
    return {
      actionCount: 0,
      kind: "non-interactive",
      reason: "screen-has-no-actions",
      screen,
    };
  }
  return { actionCount, kind: "runnable", reason: null, screen };
}

export function deriveScreenContextState(
  targets: readonly ScreenContextTarget[],
  environment: ScreenContextEnvironment,
): ScreenContextState {
  if (targets.length === 0) {
    return { availability: {}, kind: "none", targets: [] };
  }
  if (targets.length > 1) {
    const selectedTargets = [...targets];
    const previewDisposition = resolveMultiplePreviewDisposition(selectedTargets, environment);
    return {
      availability: multipleAvailability(selectedTargets, environment, previewDisposition),
      kind: "multiple",
      previewDisposition,
      targets: selectedTargets,
    };
  }

  const target = targets[0]!;
  const modifyDisposition = resolveModifyDisposition(target, environment);
  const previewDisposition = resolvePreviewDisposition(target, environment);
  const placementReason = placementTargetBlockReason(target);
  const runtimeReason = screenTargetBlockReason(target);
  const write = writeAvailability(placementReason, environment);
  const generate = runAvailability(runtimeReason, environment);
  const versionHistory = availabilityFromReason(placementReason);
  const exportAction = placementReason
    ? disabled(placementReason)
    : environment.capabilities.canExport
      ? enabled()
      : disabled("export-unavailable");

  return {
    availability: {
      delete: write,
      duplicate: write,
      export: exportAction,
      favourite: write,
      generate,
      modify: dispositionAvailability(modifyDisposition),
      more: versionHistory,
      preview: dispositionAvailability(previewDisposition),
      rename: write,
      versionHistory,
    },
    kind: "single",
    modifyDisposition,
    previewDisposition,
    target,
    targets: [target],
  };
}

function resolveModifyDisposition(
  target: ScreenContextTarget,
  environment: ScreenContextEnvironment,
): ScreenModifyDisposition {
  const targetReason = screenTargetBlockReason(target);
  if (targetReason) return { kind: "blocked", reason: targetReason };
  if (!environment.capabilities.canEdit) return { kind: "blocked", reason: "read-only" };
  if (environment.activeRun) return { kind: "blocked", reason: "active-run" };
  if (environment.directEditAvailable) return { kind: "direct-edit", reason: null };
  if (!environment.capabilities.canRun) return { kind: "blocked", reason: "run-unavailable" };
  if (!environment.editModelAvailable) {
    return { kind: "blocked", reason: "edit-model-unavailable" };
  }
  if (!environment.editArtifactTargetsValid) {
    return { kind: "blocked", reason: "edit-targets-invalid" };
  }
  return { kind: "agent-edit", reason: null };
}

function resolvePreviewDisposition(
  target: ScreenContextTarget,
  environment: ScreenContextEnvironment,
): ScreenPreviewDisposition {
  const targetReason = screenTargetBlockReason(target);
  if (targetReason) return { kind: "blocked", reason: targetReason };
  if (!environment.capabilities.canPreview) {
    return { kind: "blocked", reason: "preview-unavailable" };
  }

  const analysis = analyzePrototypeScreenRuntime(
    target.version,
    target.reference.screenId,
  );
  if (analysis.kind === "runnable") {
    return {
      kind: "open-existing",
      reason: null,
      reference: target.reference,
    };
  }
  if (analysis.kind === "blocked") {
    return { kind: "blocked", reason: analysis.reason };
  }
  if (!environment.capabilities.canEdit) return { kind: "blocked", reason: "read-only" };
  if (environment.activeRun) return { kind: "blocked", reason: "active-run" };
  if (!environment.capabilities.canRun) {
    return { kind: "blocked", reason: "run-unavailable" };
  }
  if (!environment.generatePrototypeTargetsValid) {
    return { kind: "blocked", reason: "generate-targets-invalid" };
  }
  return {
    kind: "generate-required",
    reason: analysis.reason,
    reference: target.reference,
  };
}

function multipleAvailability(
  targets: readonly ScreenContextTarget[],
  environment: ScreenContextEnvironment,
  previewDisposition: MultipleScreenPreviewDisposition,
): MultipleScreenContextAvailability {
  const placementReason = firstPlacementBlockReason(targets);
  const write = writeAvailability(placementReason, environment);
  const distribute = targets.length < 3 ? disabled("insufficient-selection") : write;
  const exportAction = placementReason
    ? disabled(placementReason)
    : environment.capabilities.canExport
      ? enabled()
      : disabled("export-unavailable");
  const variants = generateVariantsAvailability(targets, environment);
  return {
    align: write,
    delete: write,
    distribute,
    duplicate: write,
    export: exportAction,
    generateVariants: variants,
    preview: dispositionAvailability(previewDisposition),
  };
}

function resolveMultiplePreviewDisposition(
  targets: readonly ScreenContextTarget[],
  environment: ScreenContextEnvironment,
): MultipleScreenPreviewDisposition {
  const targetReason = firstTargetBlockReason(targets);
  if (targetReason) return { kind: "blocked", reason: targetReason };
  const screenTargets = new Set(targets.map((target) => screenTargetKey(target.reference)));
  if (screenTargets.size !== targets.length) {
    return { kind: "blocked", reason: "duplicate-screen-targets" };
  }

  const analyses = targets.map((target) => analyzePrototypeScreenRuntime(
    target.version,
    target.reference.screenId,
  ));
  const references = targets.map((target) => ({ ...target.reference }));
  if (analyses.every((analysis) => analysis.kind === "runnable")) {
    return environment.capabilities.canPreview
      ? { kind: "open-existing", reason: null, references }
      : { kind: "blocked", reason: "preview-unavailable" };
  }

  const generation = generatePrototypeAvailability(targets, environment);
  if (!generation.enabled) return { kind: "blocked", reason: generation.reason };
  return {
    kind: "generate-required",
    reason: "screen-has-no-actions",
    references,
  };
}

function generatePrototypeAvailability(
  targets: readonly ScreenContextTarget[],
  environment: ScreenContextEnvironment,
): ScreenContextAvailability {
  const targetReason = firstTargetBlockReason(targets);
  if (targetReason) return disabled(targetReason);
  const screenTargets = new Set(targets.map((target) => screenTargetKey(target.reference)));
  if (screenTargets.size !== targets.length) return disabled("duplicate-screen-targets");
  if (!environment.capabilities.canPreview) return disabled("preview-unavailable");
  const run = runAvailability(null, environment);
  if (!run.enabled) return run;
  return environment.generatePrototypeTargetsValid
    ? enabled()
    : disabled("generate-targets-invalid");
}

function generateVariantsAvailability(
  targets: readonly ScreenContextTarget[],
  environment: ScreenContextEnvironment,
): ScreenContextAvailability {
  if (targets.length < 2) return disabled("insufficient-selection");
  const targetReason = firstTargetBlockReason(targets);
  if (targetReason) return disabled(targetReason);
  const nodeIds = new Set(targets.map((target) => target.id));
  const screenTargets = new Set(targets.map((target) => screenTargetKey(target.reference)));
  if (nodeIds.size !== targets.length || screenTargets.size !== targets.length) {
    return disabled("duplicate-screen-targets");
  }
  const run = runAvailability(null, environment);
  if (!run.enabled) return run;
  if (!environment.editModelAvailable) return disabled("edit-model-unavailable");
  if (!environment.editArtifactTargetsValid) return disabled("edit-targets-invalid");
  return enabled();
}

function firstPlacementBlockReason(
  targets: readonly ScreenContextTarget[],
): ScreenContextBlockReason | null {
  for (const target of targets) {
    const reason = placementTargetBlockReason(target);
    if (reason) return reason;
  }
  return null;
}

function placementTargetBlockReason(
  target: ScreenContextTarget,
): ScreenContextBlockReason | null {
  if (!target.persisted) return "target-not-persisted";
  if (target.phase !== "complete") return "target-not-complete";
  return null;
}

function firstTargetBlockReason(
  targets: readonly ScreenContextTarget[],
): ScreenContextBlockReason | null {
  for (const target of targets) {
    const reason = screenTargetBlockReason(target);
    if (reason) return reason;
  }
  return null;
}

function screenTargetBlockReason(
  target: ScreenContextTarget,
): ScreenContextBlockReason | null {
  const placementReason = placementTargetBlockReason(target);
  if (placementReason) return placementReason;
  const version = target.version;
  if (!version) return "artifact-unavailable";
  if (
    version.artifactId !== target.reference.artifactId
    || version.artifactVersionId !== target.reference.artifactVersionId
  ) {
    return "artifact-mismatch";
  }
  const analysis = analyzePrototypeScreenRuntime(version, target.reference.screenId);
  return analysis.kind === "blocked" ? analysis.reason : null;
}

function writeAvailability(
  targetReason: ScreenContextBlockReason | null,
  environment: ScreenContextEnvironment,
): ScreenContextAvailability {
  if (targetReason) return disabled(targetReason);
  if (!environment.capabilities.canEdit) return disabled("read-only");
  if (environment.activeRun) return disabled("active-run");
  return enabled();
}

function runAvailability(
  targetReason: ScreenContextBlockReason | null,
  environment: ScreenContextEnvironment,
): ScreenContextAvailability {
  const write = writeAvailability(targetReason, environment);
  if (!write.enabled) return write;
  return environment.capabilities.canRun ? enabled() : disabled("run-unavailable");
}

function dispositionAvailability(
  disposition: ScreenModifyDisposition | ScreenPreviewDisposition | MultipleScreenPreviewDisposition,
): ScreenContextAvailability {
  return disposition.kind === "blocked" ? disabled(disposition.reason) : enabled();
}

function availabilityFromReason(
  reason: ScreenContextBlockReason | null,
): ScreenContextAvailability {
  return reason ? disabled(reason) : enabled();
}

function screenTargetKey(reference: ScreenContextReference): string {
  return `${reference.artifactId}:${reference.artifactVersionId}:${reference.screenId}`;
}

function enabled(): ScreenContextAvailability {
  return { enabled: true, reason: null };
}

function disabled(reason: ScreenContextBlockReason): ScreenContextAvailability {
  return { enabled: false, reason };
}

function blockedRuntime(
  reason: Extract<
    ScreenContextBlockReason,
    | "artifact-not-inline-prototype"
    | "artifact-not-ready"
    | "artifact-unavailable"
    | "screen-unavailable"
  >,
): PrototypeScreenRuntimeAnalysis {
  return { actionCount: 0, kind: "blocked", reason, screen: null };
}
