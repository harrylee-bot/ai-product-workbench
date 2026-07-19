export const previewDeviceModes = [
  "mobile",
  "phone-landscape",
  "tablet",
  "desktop",
  "responsive",
  "custom",
] as const;

export type PreviewDeviceMode = (typeof previewDeviceModes)[number];

export type PreviewCustomViewport = {
  width: number;
  height: number;
};

export type PreviewResolvedViewport = PreviewCustomViewport & {
  renderedWidth: number;
  renderedHeight: number;
  scale: number;
  fixed: boolean;
};

export const previewCustomViewportBounds = {
  minWidth: 240,
  maxWidth: 2_560,
  minHeight: 240,
  maxHeight: 1_600,
} as const;

export const previewDevicePresets: Readonly<Record<Exclude<PreviewDeviceMode, "responsive" | "custom">, PreviewCustomViewport>> = {
  mobile: { width: 390, height: 844 },
  "phone-landscape": { width: 844, height: 390 },
  tablet: { width: 768, height: 1_024 },
  desktop: { width: 1_440, height: 900 },
};

export function normalizePreviewCustomViewport(
  viewport: PreviewCustomViewport,
): PreviewCustomViewport {
  return {
    width: clampInteger(
      viewport.width,
      previewCustomViewportBounds.minWidth,
      previewCustomViewportBounds.maxWidth,
    ),
    height: clampInteger(
      viewport.height,
      previewCustomViewportBounds.minHeight,
      previewCustomViewportBounds.maxHeight,
    ),
  };
}

export function resolvePreviewViewport(
  mode: PreviewDeviceMode,
  customViewport: PreviewCustomViewport,
  available: PreviewCustomViewport,
): PreviewResolvedViewport {
  const availableWidth = Math.max(1, Math.floor(available.width));
  const availableHeight = Math.max(1, Math.floor(available.height));
  if (mode === "responsive") {
    return {
      width: availableWidth,
      height: availableHeight,
      renderedWidth: availableWidth,
      renderedHeight: availableHeight,
      scale: 1,
      fixed: false,
    };
  }

  const viewport = mode === "custom"
    ? normalizePreviewCustomViewport(customViewport)
    : previewDevicePresets[mode];
  const scale = Math.min(
    1,
    availableWidth / viewport.width,
    availableHeight / viewport.height,
  );
  return {
    ...viewport,
    renderedWidth: viewport.width * scale,
    renderedHeight: viewport.height * scale,
    scale,
    fixed: true,
  };
}

function clampInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
