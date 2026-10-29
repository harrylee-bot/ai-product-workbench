"use client";

import Cropper, { type Area, type Point } from "react-easy-crop";
import { ImageIcon, UploadIcon, XIcon } from "lucide-react";
import { motion } from "framer-motion";
import { nanoid } from "nanoid";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import {
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";

const mediaTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maximumMediaBytes = 25 * 1024 ** 2;
const workbenchEase = [0.16, 1, 0.3, 1] as const;

export function WorkbenchCanvasMediaPanel({
  busy = false,
  error = null,
  onClose,
  onInsert,
  progress = null,
  projectId,
}: {
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onInsert: (file: File, operationId: string) => Promise<void>;
  progress?: number | null;
  projectId: string;
}) {
  const session = useWorkbenchProjectSession(projectId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useWorkbenchProjectState<File | null>(session, () => null);
  const [objectUrl, setObjectUrl] = useWorkbenchProjectState<string | null>(session, () => null);
  const [crop, setCrop] = useWorkbenchProjectState<Point>(session, () => ({ x: 0, y: 0 }));
  const [zoom, setZoom] = useWorkbenchProjectState(session, () => 1);
  const [aspect, setAspect] = useWorkbenchProjectState(session, () => 1);
  const [pixels, setPixels] = useWorkbenchProjectState<Area | null>(session, () => null);
  const [localError, setLocalError] = useWorkbenchProjectState<string | null>(session, () => null);
  const [operationId, setOperationId] = useWorkbenchProjectState(
    session,
    () => `media:${nanoid(24)}`,
  );

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file, setObjectUrl]);

  const chooseFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!mediaTypes.has(candidate.type)) {
      setLocalError("请选择 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (candidate.size <= 0 || candidate.size > maximumMediaBytes) {
      setLocalError("图片大小必须在 25 MB 以内");
      return;
    }
    setLocalError(null);
    setFile(candidate);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setPixels(null);
    setOperationId(`media:${nanoid(24)}`);
  };

  return (
    <motion.aside
      animate={{ opacity: 1, scale: 1, x: 0, y: "-50%" }}
      aria-busy={busy}
      aria-label="Media"
      className="absolute right-[80px] top-1/2 z-50 w-[320px] overflow-hidden rounded-[20px] border border-white/[0.12] bg-[#202124]/98 p-[13px] text-[#f1f3f4] shadow-[0_26px_80px_-36px_rgba(0,0,0,0.98)] backdrop-blur-xl max-sm:right-[64px] max-sm:w-[min(320px,calc(100vw-80px))]"
      data-workbench-canvas-media-panel
      initial={{ opacity: 0, scale: 0.97, x: 8, y: "-50%" }}
      transition={{ duration: 0.18, ease: workbenchEase }}
    >
      <header className="flex h-[42px] items-center gap-[10px] px-[2px]">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-[#f1f3f4] text-[#202124]">
          <ImageIcon className="size-[17px]" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block text-[14px] font-semibold leading-[18px]">Media</strong>
          <span className="block truncate text-[13px] leading-[17px] text-[#aeb3bb]">
            {file?.name ?? "图片素材"}
          </span>
        </span>
        <button
          aria-label="关闭 Media"
          className="grid size-[30px] place-items-center rounded-full text-[#b5bac2] transition-colors hover:bg-white/[0.07] hover:text-white"
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-[16px]" />
        </button>
      </header>

      <input
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={busy}
        onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
        ref={inputRef}
        type="file"
      />

      <section className="relative mt-[10px] aspect-[4/3] overflow-hidden rounded-[14px] border border-white/[0.09] bg-[#151618]">
        {objectUrl ? (
          <Cropper
            aspect={aspect}
            crop={crop}
            image={objectUrl}
            onCropChange={setCrop}
            onCropComplete={(_, area) => setPixels(area)}
            onZoomChange={setZoom}
            showGrid={false}
            zoom={zoom}
          />
        ) : (
          <button
            className="grid h-full w-full place-items-center text-[#aeb3bb] transition-colors hover:bg-white/[0.03] hover:text-white"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            <UploadIcon className="size-[28px]" />
            <span className="sr-only">选择图片</span>
          </button>
        )}
      </section>

      <div className="mt-[10px] flex items-center justify-between gap-[8px]">
        <div className="flex h-[30px] items-center rounded-full border border-white/[0.08] bg-[#17181a] p-[2px]">
          {[
            { label: "1:1", value: 1 },
            { label: "4:3", value: 4 / 3 },
            { label: "16:9", value: 16 / 9 },
          ].map((item) => (
            <button
              aria-pressed={aspect === item.value}
              className={cn(
                "h-[24px] rounded-full px-[9px] text-[12px] font-semibold transition-colors",
                aspect === item.value ? "bg-[#4a4c51] text-white" : "text-[#9da2aa] hover:text-white",
              )}
              disabled={busy || !file}
              key={item.label}
              onClick={() => setAspect(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-[7px]">
          <span className="text-[12px] font-medium text-[#9da2aa]">Zoom</span>
          <input
            aria-label="Zoom"
            className="h-[3px] min-w-0 flex-1 accent-[#c9b3ff]"
            disabled={busy || !file}
            max={3}
            min={1}
            onChange={(event) => setZoom(Number(event.currentTarget.value))}
            step={0.05}
            type="range"
            value={zoom}
          />
        </label>
      </div>

      {(localError || error) && (
        <p className="mt-[10px] rounded-[10px] border border-[#d96868]/35 bg-[#6e2525]/18 px-[10px] py-[8px] text-[12px] leading-[16px] text-[#f0aaaa]" role="alert">
          {localError ?? error}
        </p>
      )}

      <div className="mt-[12px] flex items-center gap-[8px]">
        <button
          className="grid size-[34px] place-items-center rounded-full border border-white/[0.10] text-[#d8dce2] transition-colors hover:bg-white/[0.06] disabled:opacity-45"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          title="选择图片"
          type="button"
        >
          <UploadIcon className="size-[15px]" />
        </button>
        <button
          className="h-[34px] min-w-0 flex-1 rounded-full bg-[#e8eaed] px-[14px] text-[13px] font-semibold text-[#202124] transition hover:bg-white disabled:opacity-45"
          disabled={busy || !file}
          onClick={() => {
            if (!file) return;
            setLocalError(null);
            void cropImageFile(file, pixels)
              .then((croppedFile) => {
                if (!session.isCurrent()) return;
                return onInsert(croppedFile, operationId);
              })
              .catch((cause) => {
                if (session.isCurrent()) {
                  setLocalError(cause instanceof Error ? cause.message : "图片处理失败");
                }
              });
          }}
          type="button"
        >
          {busy
            ? progress === null ? "正在插入..." : `正在插入 ${Math.round(progress)}%`
            : "插入图片"}
        </button>
      </div>
    </motion.aside>
  );
}

export async function cropImageFile(file: File, area: Area | null): Promise<File> {
  if (!area || area.width <= 0 || area.height <= 0) return file;
  if (typeof createImageBitmap !== "function") {
    throw new Error("当前浏览器无法处理图片裁剪");
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const width = Math.max(1, Math.round(area.width));
    const height = Math.max(1, Math.round(area.height));
    if (width > 16_384 || height > 16_384 || width * height > 100_000_000) {
      throw new Error("裁剪区域尺寸过大");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理图片裁剪");
    context.drawImage(
      bitmap,
      Math.round(area.x),
      Math.round(area.y),
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("图片裁剪失败")),
        file.type,
        file.type === "image/png" ? undefined : 0.92,
      );
    });
    return new File([blob], file.name, { type: file.type, lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}
