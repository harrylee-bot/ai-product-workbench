import {
  prototypeDocumentSchema,
  type PrototypeDocument,
  type PrototypeNumberValue,
  type PrototypeToken,
} from "@workbench/workbench-contracts";

export type PrototypeCanvasStyleDraft = {
  theme: "dark" | "light";
  radius: number;
  motionEnabled: boolean;
  color: string;
};

const styleTokenNames = {
  foreground: "产品工作台画布前景色",
  motionDuration: "产品工作台画布动效时长",
  radius: "产品工作台画布圆角",
  surface: "产品工作台画布背景",
} as const;

const styleTokenIds = {
  foreground: "workbench.style.foreground",
  motionDuration: "workbench.style.motion-duration",
  radius: "workbench.style.radius",
  surface: "workbench.style.surface",
} as const;

export function prototypeCanvasStyleDraft(document: PrototypeDocument): PrototypeCanvasStyleDraft {
  const root = document.nodes.find((node) => (
    document.screens.some((screen) => screen.rootNodeId === node.id)
  ));
  const surface = readColorValue(document, root?.style.fill) ?? "#121315";
  const radius = readNumberValue(document, root?.style.radii.topLeft) ?? 0;
  const configuredMotion = document.tokens.find((token) => (
    token.name === styleTokenNames.motionDuration && token.type === "duration"
  ));
  const motionEnabled = configuredMotion && typeof configuredMotion.value === "number"
    ? configuredMotion.value > 0
    : document.motions.length === 0 || document.motions.some((motion) => (
        (readNumberValue(document, motion.duration) ?? 0) > 0
      ));

  return {
    theme: colorLuminance(surface) >= 0.58 ? "light" : "dark",
    radius: clampRadius(radius),
    motionEnabled,
    color: surface.toLowerCase(),
  };
}

export function normalizePrototypeCanvasStyleDraft(
  previous: PrototypeCanvasStyleDraft,
  next: PrototypeCanvasStyleDraft,
): PrototypeCanvasStyleDraft {
  if (previous.theme === next.theme || previous.color.toLowerCase() !== next.color.toLowerCase()) {
    return { ...next, radius: clampRadius(next.radius), color: normalizeColor(next.color) };
  }
  return {
    ...next,
    radius: clampRadius(next.radius),
    color: next.theme === "dark" ? "#121315" : "#f1f3f4",
  };
}

export function applyPrototypeCanvasStyle(
  document: PrototypeDocument,
  draft: PrototypeCanvasStyleDraft,
): PrototypeDocument {
  const normalized = {
    ...draft,
    radius: clampRadius(draft.radius),
    color: normalizeColor(draft.color),
  };
  const tokens = [...document.tokens];
  const usedIds = collectIrIds(document);
  const surfaceTokenId = upsertToken(tokens, usedIds, {
    id: styleTokenIds.surface,
    name: styleTokenNames.surface,
    type: "color",
    value: normalized.color,
  });
  const foregroundTokenId = upsertToken(tokens, usedIds, {
    id: styleTokenIds.foreground,
    name: styleTokenNames.foreground,
    type: "color",
    value: normalized.theme === "dark" ? "#f1f3f4" : "#202124",
  });
  const radiusTokenId = upsertToken(tokens, usedIds, {
    id: styleTokenIds.radius,
    name: styleTokenNames.radius,
    type: "radius",
    value: normalized.radius,
  });
  const motionDurationTokenId = upsertToken(tokens, usedIds, {
    id: styleTokenIds.motionDuration,
    name: styleTokenNames.motionDuration,
    type: "duration",
    value: normalized.motionEnabled ? 180 : 0,
  });
  const rootIds = new Set(document.screens.map((screen) => screen.rootNodeId));
  const radiusReference = tokenReference(radiusTokenId);

  const nodes = document.nodes.map((node) => ({
    ...node,
    style: {
      ...node.style,
      ...(rootIds.has(node.id) ? { fill: tokenReference(surfaceTokenId) } : {}),
      ...((node.kind === "text" || node.kind === "icon")
        ? { fill: tokenReference(foregroundTokenId) }
        : {}),
      radii: {
        topLeft: radiusReference,
        topRight: radiusReference,
        bottomRight: radiusReference,
        bottomLeft: radiusReference,
      },
    },
  }));
  const nodeKinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const states = document.states.map((state) => ({
    ...state,
    overrides: state.overrides.map((override) => {
      if (!override.style) return override;
      const kind = nodeKinds.get(override.nodeId);
      return {
        ...override,
        style: {
          ...override.style,
          ...(rootIds.has(override.nodeId) ? { fill: tokenReference(surfaceTokenId) } : {}),
          ...((kind === "text" || kind === "icon")
            ? { fill: tokenReference(foregroundTokenId) }
            : {}),
          radii: {
            topLeft: radiusReference,
            topRight: radiusReference,
            bottomRight: radiusReference,
            bottomLeft: radiusReference,
          },
        },
      };
    }),
  }));
  const motions = document.motions.map((motion) => ({
    ...motion,
    duration: tokenReference(motionDurationTokenId),
  }));

  return prototypeDocumentSchema.parse({
    ...document,
    revision: document.revision + 1,
    tokens,
    nodes,
    states,
    motions,
  });
}

function upsertToken(
  tokens: PrototypeToken[],
  usedIds: Set<string>,
  token: PrototypeToken,
): string {
  const existingIndex = tokens.findIndex((candidate) => (
    candidate.name === token.name && candidate.type === token.type
  ));
  if (existingIndex >= 0) {
    const id = tokens[existingIndex]!.id;
    tokens[existingIndex] = { ...token, id } as PrototypeToken;
    return id;
  }

  let id = token.id;
  for (let suffix = 1; usedIds.has(id); suffix += 1) id = `${token.id}.${suffix}`;
  usedIds.add(id);
  tokens.push({ ...token, id } as PrototypeToken);
  return id;
}

function tokenReference(tokenId: string) {
  return { kind: "token" as const, tokenId };
}

function readColorValue(
  document: PrototypeDocument,
  value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string } | null | undefined,
): string | null {
  if (!value) return null;
  if (value.kind === "literal") return value.value;
  const token = document.tokens.find((candidate) => candidate.id === value.tokenId);
  return token?.type === "color" ? token.value : null;
}

function readNumberValue(
  document: PrototypeDocument,
  value: PrototypeNumberValue | undefined,
): number | null {
  if (!value) return null;
  if (value.kind === "literal") return value.value;
  const token = document.tokens.find((candidate) => candidate.id === value.tokenId);
  return token && typeof token.value === "number" ? token.value : null;
}

function collectIrIds(document: PrototypeDocument): Set<string> {
  return new Set([
    document.documentId,
    ...document.screens.map((item) => item.id),
    ...document.nodes.map((item) => item.id),
    ...document.tokens.map((item) => item.id),
    ...document.assets.map((item) => item.id),
    ...document.states.map((item) => item.id),
    ...document.actions.map((item) => item.id),
    ...document.bindings.map((item) => item.id),
    ...document.motions.map((item) => item.id),
    ...document.nodes.flatMap((node) => node.kind === "vector"
      ? node.paths.map((path) => path.id)
      : []),
  ]);
}

function normalizeColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(normalized)) {
    throw new TypeError("Prototype canvas color must be a six- or eight-digit hex color");
  }
  return normalized;
}

function clampRadius(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(32, Math.max(0, Math.round(value)));
}

function colorLuminance(value: string): number {
  const normalized = normalizeColor(value).slice(1, 7);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
