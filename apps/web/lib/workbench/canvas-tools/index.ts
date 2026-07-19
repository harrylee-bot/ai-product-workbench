import type { ArtifactVersionDetail } from "@workbench/workbench-contracts";

/** The interaction state of the board. Panels are intentionally not tools. */
export type CanvasInteractionMode =
  | "select"
  | "marquee"
  | "direct-edit"
  | "pan"
  | "frame-create"
  | "freehand";

/** A side panel which may be open independently of the interaction mode. */
export type CanvasPanel = "media" | "design-system" | "favourites" | null;

export type CanvasPrimaryInteractionMode = Exclude<CanvasInteractionMode, "frame-create" | "freehand">;
export type CanvasMainCommand = CanvasPrimaryInteractionMode | Exclude<CanvasPanel, null>;
export type CanvasMoreCommand = Extract<CanvasInteractionMode, "frame-create" | "freehand">;

export const canvasMainCommands = [
  "select",
  "marquee",
  "direct-edit",
  "pan",
  "media",
  "design-system",
  "favourites",
] as const satisfies readonly CanvasMainCommand[];

export const canvasMoreCommands = ["frame-create", "freehand"] as const satisfies readonly CanvasMoreCommand[];

export type CanvasTargetPhase = "idle" | "generating" | "refining" | "complete";

/** The persisted selection projection needed by Direct edit. */
export type CanvasSelectionTarget = {
  nodeId: string;
  persisted: boolean;
  phase: CanvasTargetPhase;
  screenId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  artifactVersion: ArtifactVersionDetail | null;
};

export type CanvasToolEnvironment = {
  activeRun: boolean;
  canEdit: boolean;
  projectId: string | null;
  selection: readonly CanvasSelectionTarget[];
};

export type CanvasToolsState = {
  interactionMode: CanvasInteractionMode;
  panel: CanvasPanel;
  projectId: string | null;
};

export type CanvasInteractionBlockReason =
  | "active-run"
  | "read-only"
  | CanvasDirectEditBlockReason;

export type CanvasDirectEditBlockReason =
  | "selection-count"
  | "target-not-persisted"
  | "target-not-complete"
  | "artifact-unavailable"
  | "artifact-mismatch"
  | "artifact-not-ready"
  | "artifact-not-inline-prototype"
  | "screen-unavailable";

export type CanvasInteractionAvailability =
  | { enabled: true; reason: null }
  | { enabled: false; reason: CanvasInteractionBlockReason };

export type CanvasPanelAccess =
  | { enabled: false; mode: "disabled"; reason: "active-run" | "read-only" }
  | { enabled: true; mode: "read-only" | "interactive"; reason: null };

export type CanvasToolsCommand =
  | { type: "main-command"; command: CanvasMainCommand }
  | { type: "more-command"; command: CanvasMoreCommand };

export type CanvasToolsReducerEvent =
  | (CanvasToolsCommand & { environment: CanvasToolEnvironment })
  | { type: "environment-changed"; environment: CanvasToolEnvironment };

export type CanvasSelectionEffect = "preserve";

export type CanvasToolsTransition = {
  state: CanvasToolsState;
  selectionEffect: CanvasSelectionEffect;
  blockedReason: CanvasInteractionBlockReason | null;
};

export function createCanvasToolsState(projectId: string | null = null): CanvasToolsState {
  return { interactionMode: "select", panel: null, projectId };
}

/**
 * Returns the strict Direct edit guard. Keeping the checks here prevents UI
 * components from accidentally editing a draft, blob, or stale screen.
 */
export function canvasDirectEditAvailability(
  environment: CanvasToolEnvironment,
): CanvasInteractionAvailability {
  if (!environment.canEdit) return { enabled: false, reason: "read-only" };
  if (environment.activeRun) return { enabled: false, reason: "active-run" };
  if (environment.selection.length !== 1) return { enabled: false, reason: "selection-count" };

  const target = environment.selection[0]!;
  if (!target.persisted) return { enabled: false, reason: "target-not-persisted" };
  if (target.phase !== "complete") return { enabled: false, reason: "target-not-complete" };
  if (!target.artifactVersion) return { enabled: false, reason: "artifact-unavailable" };

  const version = target.artifactVersion;
  if (
    target.artifactId === null
    || target.artifactVersionId === null
    || version.artifactId !== target.artifactId
    || version.artifactVersionId !== target.artifactVersionId
  ) {
    return { enabled: false, reason: "artifact-mismatch" };
  }
  if (version.status !== "ready") return { enabled: false, reason: "artifact-not-ready" };
  if (version.contentMode !== "inline" || version.kind !== "prototype") {
    return { enabled: false, reason: "artifact-not-inline-prototype" };
  }
  if (
    target.screenId === null
    || !version.content.screens.some((screen) => screen.id === target.screenId)
  ) {
    return { enabled: false, reason: "screen-unavailable" };
  }
  return { enabled: true, reason: null };
}

export function canvasInteractionAvailability(
  mode: CanvasInteractionMode,
  environment: CanvasToolEnvironment,
): CanvasInteractionAvailability {
  if (mode === "select" || mode === "pan") {
    return { enabled: true, reason: null };
  }
  if (!environment.canEdit) return { enabled: false, reason: "read-only" };
  if (environment.activeRun) return { enabled: false, reason: "active-run" };
  if (mode === "marquee") return { enabled: true, reason: null };
  if (mode === "direct-edit") return canvasDirectEditAvailability(environment);
  return { enabled: true, reason: null };
}

export function canvasPanelAccess(
  panel: Exclude<CanvasPanel, null>,
  environment: CanvasToolEnvironment,
): CanvasPanelAccess {
  if (panel === "media") {
    if (!environment.canEdit) return { enabled: false, mode: "disabled", reason: "read-only" };
    if (environment.activeRun) return { enabled: false, mode: "disabled", reason: "active-run" };
    return { enabled: true, mode: "interactive", reason: null };
  }
  return {
    enabled: true,
    mode: environment.canEdit && !environment.activeRun ? "interactive" : "read-only",
    reason: null,
  };
}

/**
 * Reconciles ephemeral canvas presentation with durable project/run/selection
 * state. A project boundary always starts from Select so a stale target can
 * never leak into the next project.
 */
export function normalizeCanvasToolsState(
  state: CanvasToolsState,
  environment: CanvasToolEnvironment,
): CanvasToolsState {
  if (state.projectId !== environment.projectId) {
    return {
      interactionMode: "select",
      panel: null,
      projectId: environment.projectId,
    };
  }

  const interaction = canvasInteractionAvailability(state.interactionMode, environment);
  const panel = state.panel === null
    ? null
    : canvasPanelAccess(state.panel, environment).enabled
      ? state.panel
      : null;
  const interactionMode = interaction.enabled ? state.interactionMode : "select";

  if (
    interactionMode === state.interactionMode
    && panel === state.panel
    && state.projectId === environment.projectId
  ) {
    return state;
  }
  return { interactionMode, panel, projectId: environment.projectId };
}

/** Reducer-shaped entry point for React state containers. */
export function reduceCanvasToolsState(
  state: CanvasToolsState,
  event: CanvasToolsReducerEvent,
): CanvasToolsState {
  if (event.type === "environment-changed") {
    return normalizeCanvasToolsState(state, event.environment);
  }
  return transitionCanvasTools(state, event, event.environment).state;
}

export function transitionCanvasTools(
  state: CanvasToolsState,
  command: CanvasToolsCommand,
  environment: CanvasToolEnvironment,
): CanvasToolsTransition {
  const normalized = normalizeCanvasToolsState(state, environment);
  if (command.type === "main-command") {
    if (isCanvasPrimaryInteraction(command.command)) {
      const availability = canvasInteractionAvailability(command.command, environment);
      if (!availability.enabled) {
        return {
          state: normalized,
          selectionEffect: "preserve",
          blockedReason: availability.reason,
        };
      }
      return {
        state: {
          interactionMode: command.command,
          panel: null,
          projectId: environment.projectId,
        },
        selectionEffect: "preserve",
        blockedReason: null,
      };
    }

    const panel = command.command;
    const access = canvasPanelAccess(panel, environment);
    if (!access.enabled) {
      return {
        state: normalized,
        selectionEffect: "preserve",
        blockedReason: access.reason,
      };
    }
    return {
      state: {
        ...normalized,
        panel: normalized.panel === panel ? null : panel,
      },
      selectionEffect: "preserve",
      blockedReason: null,
    };
  }

  const availability = canvasInteractionAvailability(command.command, environment);
  if (!availability.enabled) {
    return {
      state: normalized,
      selectionEffect: "preserve",
      blockedReason: availability.reason,
    };
  }
  return {
    state: {
      interactionMode: command.command,
      panel: null,
      projectId: environment.projectId,
    },
    selectionEffect: "preserve",
    blockedReason: null,
  };
}

function isCanvasPrimaryInteraction(command: CanvasMainCommand): command is CanvasPrimaryInteractionMode {
  return command === "select"
    || command === "marquee"
    || command === "direct-edit"
    || command === "pan";
}
