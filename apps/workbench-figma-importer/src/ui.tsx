import {
  Button,
  Container,
  FileUploadButton,
  Muted,
  Text,
  VerticalSpace,
  render,
} from "@create-figma-plugin/ui";
import { emit, on } from "@create-figma-plugin/utilities";
import { Fragment, h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import { FigmaImportArchiveError, parseFigmaExportArchive } from "./archive";
import {
  FIGMA_IMPORT_EVENTS,
  type ImportCompletedEvent,
  type ImportFailedEvent,
  type ImportProgressEvent,
  type FigmaImportPayload,
} from "./types";

type UiState =
  | { phase: "idle"; message: string }
  | { phase: "validating"; message: string }
  | { phase: "importing"; message: string; completed: number; total: number }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

function Plugin() {
  const [state, setState] = useState<UiState>({ phase: "idle", message: "选择产品工作台 Figma 导出 ZIP" });

  useEffect(() => {
    const offProgress = on<ImportProgressEvent>(FIGMA_IMPORT_EVENTS.progress, (progress) => {
      if (progress.phase === "validating") {
        setState({ phase: "validating", message: progress.message });
      } else if (progress.phase === "finished") {
        setState({ phase: "done", message: progress.message });
      } else {
        setState({
          phase: "importing",
          message: progress.message,
          completed: progress.completed,
          total: progress.total,
        });
      }
    });
    const offCompleted = on<ImportCompletedEvent>(FIGMA_IMPORT_EVENTS.completed, (result) => {
      setState({ phase: "done", message: `已导入 ${result.pageCount} 个 Page、${result.screenCount} 个 Screen` });
    });
    const offFailed = on<ImportFailedEvent>(FIGMA_IMPORT_EVENTS.failed, (failure) => {
      setState({ phase: "error", message: `${failure.code}: ${failure.message}` });
    });
    return () => {
      offProgress();
      offCompleted();
      offFailed();
    };
  }, []);

  const handleSelectedFiles = useCallback(async (files: Array<File>) => {
    const file = files[0];
    if (!file) return;
    setState({ phase: "validating", message: "正在解压并校验导出包" });
    try {
      const payload = await parseFigmaExportArchive(await file.arrayBuffer());
      const screenCount = payload.document.prototypes.reduce(
        (count, prototype) => count + prototype.selectedScreenIds.length,
        0,
      );
      setState({ phase: "importing", message: `已校验 ${screenCount} 个 Screen，正在交给 Figma 主线程`, completed: 0, total: screenCount });
      emit<{ name: typeof FIGMA_IMPORT_EVENTS.document; handler: (payload: FigmaImportPayload) => void }>(
        FIGMA_IMPORT_EVENTS.document,
        payload,
      );
    } catch (error) {
      setState({ phase: "error", message: archiveErrorMessage(error) });
    }
  }, []);

  const busy = state.phase === "validating" || state.phase === "importing";
  return (
    <Container space="medium">
      <VerticalSpace space="large" />
      <Text><strong>产品工作台 Importer</strong></Text>
      <VerticalSpace space="small" />
      <Text><Muted>读取 figma-export.json，并通过官方 Figma Plugin API 创建可编辑节点。</Muted></Text>
      <VerticalSpace space="medium" />
      <FileUploadButton
        acceptedFileTypes={[".zip", "application/zip"]}
        disabled={busy}
        fullWidth
        onSelectedFiles={handleSelectedFiles}
      >
        选择导出 ZIP
      </FileUploadButton>
      <VerticalSpace space="medium" />
      <Text>{state.message}</Text>
      {state.phase === "importing" && (
        <Text><Muted>{state.completed}/{state.total}</Muted></Text>
      )}
      {state.phase === "error" && (
        <>
          <VerticalSpace space="small" />
          <Button fullWidth secondary onClick={() => setState({ phase: "idle", message: "选择产品工作台 Figma 导出 ZIP" })}>
            重新选择
          </Button>
        </>
      )}
    </Container>
  );
}

export default render(Plugin);

function archiveErrorMessage(error: unknown): string {
  if (error instanceof FigmaImportArchiveError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "导出包校验失败，请重新导出后再试";
}
