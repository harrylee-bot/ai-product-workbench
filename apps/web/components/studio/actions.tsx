"use client";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isWorkbenchApiError } from "@/lib/workbench/api";

export function useStudioAction() {
  const active = useRef(false),
    client = useQueryClient();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>, success = "操作完成") => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setMessage(success);
    } catch (e) {
      if (isWorkbenchApiError(e) && [409, 412].includes(e.status)) {
        await client.invalidateQueries();
        setError(
          "内容已被其他操作更新，请核对最新状态后重试。输入内容已保留。",
        );
      } else setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    run,
    notice: (
      <>
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="studio-error">
            {error}
          </p>
        )}
      </>
    ),
  };
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function verifyDownload(
  blob: Blob,
  expected: { sha256: string; size: number },
) {
  if (blob.size !== expected.size)
    throw new Error("文件大小校验失败，请重新下载");
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const checksum = Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (checksum !== expected.sha256.toLowerCase())
    throw new Error("文件内容校验失败，请重新下载");
  return blob;
}
