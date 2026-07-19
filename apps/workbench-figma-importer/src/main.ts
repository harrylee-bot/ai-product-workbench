import { emit, on, showUI } from "@create-figma-plugin/utilities";

import { FigmaImportArchiveError, verifyFigmaImportPayload } from "./archive";
import { officialFigmaImportApi, applyFigmaImportPlan } from "./figma-adapter";
import { buildFigmaImportPlan } from "./import-plan";
import {
  FIGMA_IMPORT_EVENTS,
  type FigmaImportPayload,
  type ImportCompletedEvent,
  type ImportDocumentEvent,
  type ImportFailedEvent,
  type ImportProgressEvent,
} from "./types";

let importing = false;

on<ImportDocumentEvent>(FIGMA_IMPORT_EVENTS.document, async (payload: FigmaImportPayload) => {
  if (importing) {
    emit<ImportFailedEvent>(FIGMA_IMPORT_EVENTS.failed, {
      code: "IMPORT_IN_PROGRESS",
      message: "已有导入任务正在执行",
    });
    return;
  }
  importing = true;
  try {
    emit<ImportProgressEvent>(FIGMA_IMPORT_EVENTS.progress, {
      phase: "validating",
      completed: 0,
      total: 1,
      message: "正在复核导入合同与资产校验和",
    });
    const verified = await verifyFigmaImportPayload(payload);
    const plan = buildFigmaImportPlan(verified.document, verified.assets);
    const result = await applyFigmaImportPlan(plan, officialFigmaImportApi, (progress) => {
      emit<ImportProgressEvent>(FIGMA_IMPORT_EVENTS.progress, progress);
    });
    emit<ImportCompletedEvent>(FIGMA_IMPORT_EVENTS.completed, {
      pageCount: result.pageCount,
      screenCount: result.screenCount,
      nodeCount: result.nodeCount,
    });
    figma.closePlugin(`产品工作台已导入 ${result.screenCount} 个页面`);
  } catch (error) {
    const failure = toFailure(error);
    emit<ImportFailedEvent>(FIGMA_IMPORT_EVENTS.failed, failure);
  } finally {
    importing = false;
  }
});

showUI({ width: 420, height: 480 });

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FigmaImportArchiveError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message.trim()) return { code: "IMPORT_FAILED", message: error.message };
  return { code: "IMPORT_FAILED", message: "产品工作台导入失败" };
}
