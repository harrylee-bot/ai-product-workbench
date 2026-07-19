"use client";

import { useCallback, useRef } from "react";

import {
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "../project-session";

import {
  captureWorkbenchScreen,
  WorkbenchScreenCaptureUnavailableError,
} from "./screen-capture";

export type WorkbenchComposerAttachmentKind = "document" | "file" | "image" | "screen";

const documentAccept = [
  ".csv",
  ".doc",
  ".docx",
  ".html",
  ".htm",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip",
].join(",");

export function useWorkbenchComposerAttachments(projectId = "") {
  const session = useWorkbenchProjectSession(projectId);
  const [selectedFiles, setSelectedFiles] = useWorkbenchProjectState<File[]>(session, () => []);
  const [screenCaptureBusy, setScreenCaptureBusy] = useWorkbenchProjectState(
    session,
    () => false,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openAttachment = useCallback(async (kind: WorkbenchComposerAttachmentKind) => {
    if (kind !== "screen") {
      const input = fileInputRef.current;
      if (!input) return;
      input.accept = attachmentAccept(kind);
      input.click();
      return;
    }

    if (screenCaptureBusy) return;
    setScreenCaptureBusy(true);
    try {
      const capture = await captureWorkbenchScreen();
      if (session.isCurrent()) setSelectedFiles((current) => [...current, capture]);
    } catch (error) {
      if (session.isCurrent()) throw error;
    } finally {
      setScreenCaptureBusy(false);
    }
  }, [screenCaptureBusy, session, setScreenCaptureBusy, setSelectedFiles]);

  const selectFiles = useCallback((files: FileList | null) => {
    setSelectedFiles(Array.from(files ?? []));
  }, [setSelectedFiles]);

  const removeFirstFile = useCallback(() => {
    setSelectedFiles((current) => current.slice(1));
  }, [setSelectedFiles]);

  const clearFiles = useCallback(() => setSelectedFiles([]), [setSelectedFiles]);

  return {
    clearFiles,
    fileInputRef,
    openAttachment,
    removeFirstFile,
    screenCaptureBusy,
    selectedFiles,
    selectFiles,
  };
}

export function workbenchScreenCaptureErrorMessage(error: unknown): string {
  if (error instanceof WorkbenchScreenCaptureUnavailableError) {
    return "当前浏览器不支持屏幕截图";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "未获得屏幕共享权限，无法添加截图";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "屏幕截图已取消";
  }
  return "屏幕截图失败，请重试";
}

function attachmentAccept(kind: Exclude<WorkbenchComposerAttachmentKind, "screen">): string {
  if (kind === "image") return "image/*";
  if (kind === "document") return documentAccept;
  return "";
}
