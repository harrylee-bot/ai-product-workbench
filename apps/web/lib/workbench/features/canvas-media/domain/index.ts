export type WorkbenchCanvasMediaBoardSize = {
  height: number;
  width: number;
};

export type WorkbenchCanvasMediaUploadProgressSnapshot = {
  hashPercent: number;
  phase: string;
  uploadPercent: number;
};

export async function workbenchCanvasMediaBoardSize(
  file: File,
): Promise<WorkbenchCanvasMediaBoardSize> {
  if (typeof createImageBitmap !== "function") return { width: 480, height: 320 };
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, 520 / bitmap.width, 420 / bitmap.height);
    return {
      width: Math.max(120, Math.round(bitmap.width * scale)),
      height: Math.max(90, Math.round(bitmap.height * scale)),
    };
  } finally {
    bitmap.close();
  }
}

export function workbenchCanvasMediaArtifactTitle(fileName: string): string {
  const title = fileName.replace(/\.[^.]+$/, "").trim() || "图片";
  return title.slice(0, 160);
}

export function workbenchCanvasMediaUploadProgress(
  snapshot: WorkbenchCanvasMediaUploadProgressSnapshot,
): number {
  if (snapshot.phase === "ready") return 96;
  if (snapshot.phase === "verifying") return 92;
  if (snapshot.phase === "uploading" || snapshot.phase === "paused") {
    return Math.min(
      90,
      Math.max(snapshot.hashPercent * 0.15, 10 + (snapshot.uploadPercent * 0.8)),
    );
  }
  return Math.min(10, snapshot.hashPercent * 0.1);
}
