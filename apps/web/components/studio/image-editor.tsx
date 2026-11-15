"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  studioRecordKey,
  useStudioStoredRecord,
} from "@/lib/studio/stored-record";
import Cropper, { type Area } from "react-easy-crop";
import { useQueryClient } from "@tanstack/react-query";
import {
  maximumUserUploadByteSize,
  type Artifact,
} from "@workbench/workbench-contracts";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import {
  createWorkbenchMultipartUpload,
  useWorkbenchFileTransferService,
  type WorkbenchMultipartUpload,
} from "@/lib/workbench/features/files";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { cropStudioImage } from "@/lib/studio/image-edit";
import type { WorkbenchUploadSnapshot } from "@/lib/workbench/files/uppy-multipart";

const imageWriteRecordSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
    fileAssetId: z.string().min(1),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new"), title: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal("version"),
          artifactId: z.string().min(1),
          baseVersionId: z.string().min(1),
          etag: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();
type ImageWriteRecord = z.infer<typeof imageWriteRecordSchema>;

export function ImageEditor({
  projectId,
  source,
  onClose,
}: {
  projectId: string;
  source?: {
    artifact: Artifact;
    versionId: string;
    blob: Blob;
    fileName: string;
  };
  onClose: () => void;
}) {
  const api = useWorkbenchArtifactsApi(),
    service = useWorkbenchFileTransferService(),
    client = useQueryClient();
  const { user } = useWorkbenchAuth();
  const local = useStudioStoredRecord(
    studioRecordKey(
      user?.id,
      projectId,
      "image-write",
      source?.artifact.id ?? "new",
      source?.versionId ?? "new",
    ),
    imageWriteRecordSchema,
  );
  const [file, setFile] = useState<File | null>(() =>
    source
      ? new File([source.blob], source.fileName, { type: source.blob.type })
      : null,
  );
  const [title, setTitle] = useState(source?.artifact.title ?? "");
  const [resource, setResource] = useState<{ file: File; url: string } | null>(
    null,
  );
  const [cropping, setCropping] = useState(false),
    [crop, setCrop] = useState({ x: 0, y: 0 }),
    [zoom, setZoom] = useState(1),
    [aspect, setAspect] = useState(1);
  const [area, setArea] = useState<Area | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<WorkbenchUploadSnapshot | null>(
      null,
    ),
    [phase, setPhase] = useState(""),
    [saved, setSaved] = useState<{
      artifactId: string;
      versionId: string;
    } | null>(null);
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<WorkbenchMultipartUpload | null>(null),
    cancelRequested = useRef(false);
  const pending = useRef<{
    identity: string;
    fileIdentity: string;
    file: File;
    fileAssetId: string | null;
    key: string;
    writeStarted: boolean;
  } | null>(null);
  const expected = useRef(
    source
      ? { versionId: source.versionId, revision: source.artifact.revision }
      : null,
  );
  useEffect(() => {
    alive.current = true;
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
      alive.current = false;
      controller.current?.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setResource({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const write = async (command: ImageWriteRecord) => {
    if (!alive.current || !local.isCurrent()) return;
    const target = command.target;
    if (
      target.kind === "version" &&
      (target.artifactId !== source?.artifact.id ||
        target.baseVersionId !== source.versionId)
    )
      throw new Error("保存记录与当前图片版本不匹配，请重新打开原版本");
    const result =
      target.kind === "version"
        ? {
            artifactId: target.artifactId,
            versionId: (
              await api.createArtifactVersion(
                target.artifactId,
                {
                  kind: "image",
                  baseArtifactVersionId: target.baseVersionId,
                  source: { kind: "file", fileAssetId: command.fileAssetId },
                },
                target.etag,
                command.key,
              )
            ).value.artifactVersionId,
          }
        : await api
            .createArtifact(
              projectId,
              {
                kind: "image",
                title: target.title,
                source: { kind: "file", fileAssetId: command.fileAssetId },
              },
              command.key,
            )
            .then((value) => ({
              artifactId: value.artifact.id,
              versionId: value.artifactVersion.artifactVersionId,
            }));
    if (!alive.current || !local.isCurrent()) return;
    local.clear();
    setSaved(result);
    setPhase("图片已保存");
    controller.current?.destroy();
    controller.current = null;
    await Promise.all([
      client.invalidateQueries({
        queryKey: workbenchQueryKeys.artifacts(projectId),
      }),
      client.invalidateQueries({
        queryKey: workbenchQueryKeys.bootstraps(projectId),
      }),
      client.invalidateQueries({
        queryKey: ["studio", "artifact-versions", result.artifactId],
      }),
      client.invalidateQueries({
        queryKey: ["studio", "pinned-artifact", projectId, result.artifactId],
      }),
    ]);
  };
  const recover = async () => {
    if (!local.value || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setPhase("正在确认上次图片保存");
    try {
      await write(local.value);
    } catch (cause) {
      if (alive.current && local.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "确认失败，请重试");
        setPhase("");
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = async (asVersion: boolean) => {
    if (!file || working.current || saved) return;
    working.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setError("");
    setPhase("正在准备图片");
    const fileIdentity = JSON.stringify(cropping ? area : null);
    const identity = JSON.stringify({
      title: asVersion ? null : title.trim(),
      crop: cropping ? area : null,
      asVersion,
      expected: asVersion ? expected.current : null,
    });
    try {
      if (!title.trim()) throw new Error("请填写图片名称");
      if (cropping && !area) throw new Error("图片尚未准备好，请稍后保存");
      if (pending.current?.fileIdentity !== fileIdentity) {
        controller.current?.destroy();
        controller.current = null;
        const output = cropping ? await cropStudioImage(file, area!) : file;
        if (!alive.current || !local.isCurrent() || cancelRequested.current)
          return;
        pending.current = {
          identity,
          fileIdentity,
          file: output,
          fileAssetId: null,
          key: `studio-image:${crypto.randomUUID()}`,
          writeStarted: false,
        };
      }
      if (pending.current.identity !== identity) {
        pending.current.identity = identity;
        pending.current.key = `studio-image:${crypto.randomUUID()}`;
        pending.current.writeStarted = false;
      }
      const intent = pending.current;
      if (!intent.fileAssetId) {
        if (!controller.current) {
          const upload = await createWorkbenchMultipartUpload({
            projectId,
            file: intent.file,
            service,
            requestExtraction: false,
          });
          if (!alive.current || !local.isCurrent() || cancelRequested.current) {
            upload.destroy();
            return;
          }
          controller.current = upload;
          upload.subscribe((value) => {
            if (alive.current) setSnapshot(value);
          });
        }
        setPhase("正在上传和校验图片");
        const upload = controller.current;
        const result = await (upload.getSnapshot().phase === "failed"
          ? upload.retry()
          : upload.start());
        if (!alive.current || !local.isCurrent() || cancelRequested.current)
          return;
        if (result.phase !== "ready" || !result.fileAssetId)
          throw new Error(result.error?.message ?? "图片尚未完成上传校验");
        intent.fileAssetId = result.fileAssetId;
      }
      if (!alive.current || !local.isCurrent() || cancelRequested.current)
        return;
      setPhase("正在保存图片版本");
      intent.writeStarted = true;
      const command: ImageWriteRecord = {
        version: 1,
        key: intent.key,
        fileAssetId: intent.fileAssetId,
        target:
          asVersion && source && expected.current
            ? {
                kind: "version",
                artifactId: source.artifact.id,
                baseVersionId: expected.current.versionId,
                etag: `"${expected.current.revision}"`,
              }
            : { kind: "new", title: title.trim() },
      };
      local.save(command);
      await write(command);
    } catch (cause) {
      if (!alive.current || !local.isCurrent() || cancelRequested.current)
        return;
      if (isWorkbenchApiError(cause) && [409, 412].includes(cause.status)) {
        setError(
          "图片版本或文件状态已变化。已保留当前编辑，请刷新版本信息后核对；也可另存为新图片。",
        );
      } else
        setError(cause instanceof Error ? cause.message : "保存失败，请重试");
      setPhase("");
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const cancel = async () => {
    const upload = controller.current;
    if (!upload) return;
    cancelRequested.current = true;
    try {
      await upload.cancel();
      if (!alive.current) return;
      upload.destroy();
      controller.current = null;
      pending.current = null;
      setSnapshot(null);
      setPhase("上传已取消");
      setError("");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "取消未完成，请重试取消",
        );
    } finally {
      if (alive.current) {
        setBusy(false);
        working.current = false;
      }
    }
  };
  const recoveryOnly = !!local.value && !pending.current;
  const url = resource?.file === file ? resource.url : "";
  const replayVersionWrite =
    pending.current?.writeStarted &&
    pending.current.identity ===
      JSON.stringify({
        title: null,
        crop: cropping ? area : null,
        asVersion: true,
        expected: expected.current,
      });
  const cancellable =
    !!snapshot &&
    ["queued", "preparing", "uploading", "paused"].includes(snapshot.phase);
  return (
    <section
      className="studio-image-editor"
      aria-label={source ? "图片编辑" : "添加图片"}
    >
      <h2>{source ? "编辑图片" : "添加图片"}</h2>
      {source &&
        source.artifact.currentVersion?.artifactVersionId !==
          source.versionId && (
          <p>此为历史版本，可另存为新图片；保存为新版本需打开当前版本。</p>
        )}
      {!source && (
        <label>
          选择图片
          <input
            aria-label="选择图片文件"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={busy || !!saved || recoveryOnly}
            onChange={(e) => {
              const next = e.target.files?.[0];
              if (!next) return;
              if (next.size > maximumUserUploadByteSize) {
                setError("图片不能超过 25 MiB，请缩小文件后重试");
                return;
              }
              if (
                ![
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "image/gif",
                ].includes(next.type)
              ) {
                setError("请选择 PNG、JPEG、WebP 或 GIF 图片");
                return;
              }
              controller.current?.destroy();
              controller.current = null;
              pending.current = null;
              setFile(next);
              setTitle(next.name.replace(/\.[^.]+$/, ""));
              setCrop({ x: 0, y: 0 });
              setZoom(1);
              setArea(null);
              setError("");
              setSnapshot(null);
            }}
          />
        </label>
      )}
      <label>
        {source ? "另存图片名称" : "图片名称"}
        <input
          aria-label="图片名称"
          value={title}
          maxLength={240}
          disabled={busy || !!saved || recoveryOnly}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {file && (
        <>
          <label>
            <input
              type="checkbox"
              checked={cropping}
              disabled={busy || !!saved || recoveryOnly}
              onChange={(e) => setCropping(e.target.checked)}
            />
            裁剪图片
          </label>
          {cropping ? (
            <>
              <p>裁剪结果保存为静态 PNG，源图片版本保持不变。</p>
              <div className="studio-crop-area" aria-label="图片裁剪预览">
                {url && (
                  <Cropper
                    image={url}
                    crop={crop}
                    zoom={zoom}
                    aspect={aspect}
                    onCropChange={(value) => {
                      if (!busy && !saved && !recoveryOnly) setCrop(value);
                    }}
                    onZoomChange={(value) => {
                      if (!busy && !saved && !recoveryOnly) setZoom(value);
                    }}
                    onCropComplete={(_, pixels) => setArea(pixels)}
                  />
                )}
              </div>
              <label>
                裁剪比例
                <select
                  aria-label="裁剪比例"
                  value={aspect}
                  disabled={busy || !!saved || recoveryOnly}
                  onChange={(e) => setAspect(Number(e.target.value))}
                >
                  <option value={1}>正方形</option>
                  <option value={4 / 3}>4:3</option>
                  <option value={16 / 9}>16:9</option>
                  <option value={3 / 4}>3:4</option>
                </select>
              </label>
              <label>
                放大
                <input
                  aria-label="裁剪缩放"
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={zoom}
                  disabled={busy || !!saved || recoveryOnly}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              {area && (
                <p>
                  保存尺寸：{Math.round(area.width)} × {Math.round(area.height)}{" "}
                  像素
                </p>
              )}
            </>
          ) : (
            url && <img className="studio-media" src={url} alt="待保存的图片" />
          )}
        </>
      )}
      {local.error && <p role="alert">{local.error}</p>}
      {local.value && !saved && (
        <div role="status">
          <p>
            上次保存的图片已完成上传校验。可以确认同一次保存，无需重新上传；服务器可能已经保存成功。
          </p>
          <button disabled={busy} onClick={() => void recover()}>
            确认上次图片保存
          </button>
          <button
            disabled={busy}
            onClick={() => {
              local.clear();
              pending.current = null;
              setError("");
            }}
          >
            清除本地恢复记录
          </button>
          <p>清除记录不会删除服务器上的图片；重新保存会发起一次新的操作。</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {phase && <p role="status">{phase}</p>}
      {snapshot && !saved && (
        <p>
          文件状态：
          {
            {
              queued: "等待上传",
              preparing: "准备上传",
              uploading: "上传中",
              paused: "已暂停",
              verifying: "校验中",
              extracting: "解析中",
              ready: "已校验",
              failed: "失败",
              cancelled: "已取消",
            }[snapshot.phase]
          }
          {snapshot.phase === "uploading"
            ? ` · ${Math.round(snapshot.uploadPercent)}%`
            : ""}
        </p>
      )}
      <div className="studio-actions">
        {!saved && (
          <>
            <button
              disabled={busy || recoveryOnly || !file || !title.trim()}
              onClick={() => void save(false)}
            >
              {source ? "另存为新图片" : "保存图片"}
            </button>
            {source && (
              <button
                disabled={
                  busy ||
                  recoveryOnly ||
                  !file ||
                  expected.current?.versionId !== source.versionId ||
                  (source.artifact.currentVersion?.artifactVersionId !==
                    source.versionId &&
                    !replayVersionWrite)
                }
                onClick={() => void save(true)}
              >
                保存为新版本
              </button>
            )}
            {source && error && (
              <button
                disabled={busy}
                onClick={() =>
                  void api
                    .getArtifact(source.artifact.id)
                    .then((result) => {
                      if (!alive.current) return;
                      expected.current = {
                        versionId:
                          result.value.currentVersion?.artifactVersionId ?? "",
                        revision: result.value.revision,
                      };
                      setError(
                        expected.current.versionId === source.versionId
                          ? "版本信息已刷新，可以重试保存。"
                          : "当前图片已有更新版本。当前编辑仍基于原版本，请另存为新图片或重新打开最新版本。",
                      );
                    })
                    .catch((cause) => {
                      if (alive.current)
                        setError(
                          cause instanceof Error ? cause.message : "刷新失败",
                        );
                    })
                }
              >
                刷新版本信息
              </button>
            )}
            {snapshot?.phase === "uploading" && (
              <button onClick={() => controller.current?.pause()}>
                暂停图片上传
              </button>
            )}
            {snapshot?.phase === "paused" && (
              <button onClick={() => controller.current?.resume()}>
                继续图片上传
              </button>
            )}
            {cancellable && (
              <button onClick={() => void cancel()}>取消图片上传</button>
            )}
            {snapshot?.error?.code === "UPLOAD_CANCEL_FAILED" && (
              <button onClick={() => void cancel()}>重试取消上传</button>
            )}
          </>
        )}
        {saved && (
          <a
            href={`/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "documents", artifact: saved.artifactId, artifactVersion: saved.versionId })}`}
          >
            查看已保存图片
          </a>
        )}
        <button disabled={busy} onClick={onClose}>
          {saved ? "完成" : "关闭图片编辑"}
        </button>
      </div>
    </section>
  );
}
