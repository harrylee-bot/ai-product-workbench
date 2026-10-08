"use client";

import {
  isSafePrototypeOpenUrl,
  prdChannelLabels,
  prdSafetyBaselineItems,
  prdSectionKeys,
  type PrdBlock,
  type PrdDocument,
  type PrdDocumentV1,
  type PrdDocumentV2,
  type PrdInline,
  type PrototypeAction,
  type PrototypeDocument,
  type PublicPrototypeDocument,
  type PrototypeNode,
  type PrototypeState,
} from "@workbench/workbench-contracts";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWorkbenchPrdDraftStore } from "../../lib/workbench/prd-editor/draft-context";

import {
  useWorkbenchArtifactVersion,
  useWorkbenchArtifactVersionContent,
  useWorkbenchArtifactVersionAsset,
} from "../../lib/workbench/features/artifacts";
import {
  usePrototypePatchProjection,
  usePrototypePatchProjector,
} from "../../lib/workbench/features/prototype-patches";
import {
  useWorkbenchPublicSharedArtifactAsset,
  useWorkbenchPublicSharedArtifactContent,
  useWorkbenchPublicSharedArtifactVersion,
} from "../../lib/workbench/features/public-shares";
import { workbenchQueryKeys } from "../../lib/workbench/query/keys";
import { WorkbenchPrdArtifactEditor } from "./workbench-prd-editor";
import { WorkbenchBusinessDocument } from "./workbench-business-document";
import { WorkbenchPrdDiagramCanvas, type PrdDiagram } from "./workbench-prd-diagram-canvas";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";

export type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import {
  PROTOTYPE_NODE_ID_ATTRIBUTE,
  PROTOTYPE_SELECTABLE_TARGET,
  applyPrototypeTransformPatchBatch,
  centeredPrototypeRendererTransform,
  patchBatchFromTransformCommand,
  prototypeNodeDomProps,
  type PrototypeEditorResult,
  type PrototypeTransformBatchCommand,
} from "../../lib/workbench/prototype-editor/model";
import { PrototypeEditorKernelAdapter } from "../../lib/workbench/prototype-editor/react-kernel-adapter";
import {
  applyPrototypeRuntimeAction,
  createPrototypeRuntimeState,
  projectPrototypeRuntimeNode,
  prototypeRuntimeActions,
  prototypeRuntimeInputValue,
  prototypeRuntimeMotions,
  reconcilePrototypeRuntimeState,
  resetPrototypeRuntimeForm,
  updatePrototypeRuntimeInput,
  workbenchPrototypeSubmitEventName,
  type PrototypeRuntimeDocument,
  type PrototypeRuntimeState,
} from "../../lib/workbench/prototype-runtime";
import { WorkbenchPrototypeIcon } from "./workbench-prototype-icon";

type RenderablePrototypeDocument = PrototypeDocument | PublicPrototypeDocument;
type RenderablePrototypeAsset = RenderablePrototypeDocument["assets"][number];

type PrototypeRuntimeContextValue = {
  document: PrototypeRuntimeDocument;
  editable: boolean;
  onInputValue: (
    node: Extract<PrototypeNode, { kind: "input" }>,
    value: string | number | boolean | null,
  ) => void;
  onInteractionEnd: (nodeId: string) => void;
  onInteractionStart: (nodeId: string, trigger: "hover" | "press") => void;
  onNodeEvent: (
    node: PrototypeNode,
    event: PrototypeAction["event"] | readonly PrototypeAction["event"][],
  ) => void;
  onReset: (formNodeId: string) => void;
  registerNode: (nodeId: string, element: HTMLElement | SVGSVGElement | null) => void;
  runtime: PrototypeRuntimeState;
};

const PrototypeRuntimeContext = createContext<PrototypeRuntimeContextValue | null>(null);

function usePrototypeRuntime() {
  const value = useContext(PrototypeRuntimeContext);
  if (!value) throw new Error("Prototype runtime context is missing");
  return value;
}

export function WorkbenchArtifactContent({
  editable = false,
  editingBusy = false,
  onArtifactTitleChange,
  onArtifactVersionStateChange,
  onDocumentCommit,
  onPrdDocumentCommit,
  pendingContent,
  reference,
}: {
  editable?: boolean;
  editingBusy?: boolean;
  onArtifactTitleChange?: (title: string) => void;
  onArtifactVersionStateChange?: (state: "error" | "pending" | "ready") => void;
  onDocumentCommit?: (
    reference: WorkbenchArtifactReference,
    document: PrototypeDocument,
  ) => Promise<void>;
  onPrdDocumentCommit?: (
    reference: WorkbenchArtifactReference,
    document: PrdDocument,
  ) => Promise<void | string>;
  pendingContent?: ReactNode;
  reference: WorkbenchArtifactReference;
}) {
  const isPublic = Boolean(reference.shareToken);
  const queryClient = useQueryClient();
  const prototypePatchProjector = usePrototypePatchProjector();
  const prototypeProjection = usePrototypePatchProjection(
    reference.artifactVersionId,
    reference.screenId,
  );
  const activePrototypeProjection = isPublic ? null : prototypeProjection;
  const privateQuery = useWorkbenchArtifactVersion(
    reference.projectId,
    reference.artifactId,
    reference.artifactVersionId,
    !isPublic,
  );
  const publicQuery = useWorkbenchPublicSharedArtifactVersion(
    reference.shareToken ?? "",
    reference.artifactId,
    reference.artifactVersionId,
    isPublic,
  );
  const query = isPublic ? publicQuery : privateQuery;
  const version = query.data?.value;
  const artifactVersionState = query.isPending
    ? "pending"
    : query.isError || !version
      ? "error"
      : "ready";
  const readyQueryOwnsProjection = activePrototypeProjection?.phase === "finalized"
    && activePrototypeProjection.documentChecksum !== null
    && version?.status === "ready"
    && version.kind === "prototype"
    && version.contentMode === "inline"
    && version.checksum === activePrototypeProjection.documentChecksum;

  useEffect(() => {
    onArtifactVersionStateChange?.(artifactVersionState);
  }, [artifactVersionState, onArtifactVersionStateChange]);

  const resolvedPrdTitle = version?.kind === "prd"
    && version.contentMode === "inline"
    ? version.content.title
    : null;

  useEffect(() => {
    if (resolvedPrdTitle) onArtifactTitleChange?.(resolvedPrdTitle);
  }, [onArtifactTitleChange, resolvedPrdTitle]);

  useEffect(() => {
    if (
      !readyQueryOwnsProjection
      || !privateQuery.data
      || !prototypePatchProjector
    ) return;
    queryClient.setQueryData(
      workbenchQueryKeys.artifactVersion(
        reference.projectId,
        reference.artifactId,
        reference.artifactVersionId,
      ),
      privateQuery.data,
    );
    prototypePatchProjector.releaseFinalized(reference.artifactVersionId);
  }, [
    privateQuery.data,
    prototypePatchProjector,
    queryClient,
    readyQueryOwnsProjection,
    reference.artifactId,
    reference.artifactVersionId,
    reference.projectId,
  ]);

  if (activePrototypeProjection && !readyQueryOwnsProjection) {
    const projectedDocument = activePrototypeProjection.document;
    if (!projectedDocument) {
      return <ArtifactStatus>Generating artifact...</ArtifactStatus>;
    }
    if (
      reference.screenId !== undefined
      && !projectedDocument.screens.some((screen) => screen.id === reference.screenId)
    ) {
      return <ArtifactStatus>Artifact screen unavailable</ArtifactStatus>;
    }
    return (
      <PrototypeArtifact
        document={projectedDocument}
        editable={editable && Boolean(onDocumentCommit)}
        editingBusy={editingBusy}
        initialScreenId={reference.screenId}
        onDocumentCommit={onDocumentCommit}
        reference={reference}
      />
    );
  }

  if (query.isPending) {
    return pendingContent === undefined
      ? <ArtifactStatus>Loading artifact...</ArtifactStatus>
      : pendingContent;
  }
  if (query.isError || !version) {
    return (
      <ArtifactStatus onRetry={() => void query.refetch()}>
        Artifact unavailable
      </ArtifactStatus>
    );
  }
  if (
    reference.screenId !== undefined
    && (
      version.contentMode !== "inline"
      || version.kind !== "prototype"
      || !version.content.screens.some((screen) => screen.id === reference.screenId)
    )
  ) {
    return <ArtifactStatus>Artifact screen unavailable</ArtifactStatus>;
  }
  if (version.contentMode === "blob") {
    return isPublic ? (
      <PublicBlobArtifact
        kind={version.kind}
        reference={reference}
      />
    ) : (
      <PrivateBlobArtifact
        kind={version.kind}
        reference={reference}
      />
    );
  }
  if (version.kind === "prd") {
    if (
      editable
      && !isPublic
      && onPrdDocumentCommit
    ) {
      return (
        <div className="nowheel h-full w-full">
          <WorkbenchPrdArtifactEditor
            document={version.content}
            editingBusy={editingBusy}
            onDocumentCommit={onPrdDocumentCommit}
            reference={reference}
          />
        </div>
      );
    }
    return isPublic ? <PrdArtifact document={version.content} /> : <PrdDraftArtifact document={version.content} reference={reference} />;
  }
  if (version.kind === "prototype") {
    return (
      <PrototypeArtifact
        document={version.content}
        editable={editable && !isPublic && Boolean(onDocumentCommit)}
        editingBusy={editingBusy}
        initialScreenId={reference.screenId}
        onDocumentCommit={onDocumentCommit}
        reference={reference}
      />
    );
  }
  if (version.kind === "document") return <WorkbenchBusinessDocument content={version.content} />;
  return (
    <pre className="h-full w-full overflow-auto whitespace-pre-wrap p-[24px] text-[14px] leading-[22px] text-[#e8eaed]">
      {JSON.stringify(version.content, null, 2)}
    </pre>
  );
}

function ArtifactStatus({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center gap-[10px] bg-[#1d1d1f] text-[16px] font-medium text-[#c7cad0]">
      <span>{children}</span>
      {onRetry && (
        <button
          aria-label="重试加载产物"
          className="grid size-[30px] place-items-center rounded-[6px] text-[#c7cad0] transition-colors hover:bg-white/[0.08] hover:text-white"
          onClick={onRetry}
          title="重试加载产物"
          type="button"
        >
          <RefreshCwIcon aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}

function PrivateBlobArtifact({
  kind,
  reference,
}: {
  kind: "prd" | "prototype" | "image" | "code" | "document" | "data";
  reference: WorkbenchArtifactReference;
}) {
  const contentQuery = useWorkbenchArtifactVersionContent(
    reference.projectId,
    reference.artifactId,
    reference.artifactVersionId,
  );
  if (contentQuery.isPending) return <ArtifactStatus>Loading artifact...</ArtifactStatus>;
  if (contentQuery.isError || !contentQuery.data) {
    return (
      <ArtifactStatus onRetry={() => void contentQuery.refetch()}>
        Artifact content unavailable
      </ArtifactStatus>
    );
  }
  return <BlobArtifact kind={kind} blob={contentQuery.data} />;
}

function PublicBlobArtifact({
  kind,
  reference,
}: {
  kind: "prd" | "prototype" | "image" | "code" | "document" | "data";
  reference: WorkbenchArtifactReference;
}) {
  const contentQuery = useWorkbenchPublicSharedArtifactContent(
    reference.shareToken ?? "",
    reference.artifactId,
    reference.artifactVersionId,
  );
  if (contentQuery.isPending) return <ArtifactStatus>Loading artifact...</ArtifactStatus>;
  if (contentQuery.isError || !contentQuery.data) {
    return (
      <ArtifactStatus onRetry={() => void contentQuery.refetch()}>
        Artifact content unavailable
      </ArtifactStatus>
    );
  }
  return <BlobArtifact kind={kind} blob={contentQuery.data} />;
}

function BlobArtifact({
  blob,
  kind,
}: {
  blob: Blob;
  kind: "prd" | "prototype" | "image" | "code" | "document" | "data";
}) {
  if (kind === "image") {
    return <BlobImageArtifact blob={blob} />;
  }
  if (kind === "code" || kind === "document" || kind === "data") {
    return <BlobTextArtifact blob={blob} />;
  }
  return <ArtifactStatus>Binary artifact preview</ArtifactStatus>;
}

function BlobImageArtifact({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const nextUrl = URL.createObjectURL(blob);
    setFailed(false);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);
  if (failed) return <ArtifactStatus>Image preview unavailable</ArtifactStatus>;
  return url ? (
    <div className="grid h-full w-full place-items-center overflow-hidden bg-[#111214]">
      <img
        alt="图片产物"
        className="block h-full w-full object-contain"
        onError={() => setFailed(true)}
        src={url}
      />
    </div>
  ) : <ArtifactStatus>Loading artifact...</ArtifactStatus>;
}

function BlobTextArtifact({ blob }: { blob: Blob }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setText(null);
    setFailed(false);
    void readBlobTextPreview(blob).then((value) => {
      if (active) setText(value);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [blob]);
  if (failed) return <ArtifactStatus>Text preview unavailable</ArtifactStatus>;
  if (text === null) return <ArtifactStatus>Loading artifact...</ArtifactStatus>;
  return (
    <pre className="h-full w-full overflow-auto whitespace-pre-wrap bg-[#111214] p-[24px] text-[13px] leading-[20px] text-[#e8eaed]">
      {text}
      {blob.size > 1_000_000 ? "\n\n[预览已截断]" : ""}
    </pre>
  );
}

function readBlobTextPreview(blob: Blob): Promise<string> {
  const preview = blob.slice(0, 1_000_000);
  if (typeof preview.text === "function") return preview.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("BLOB_TEXT_READ_FAILED"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("BLOB_TEXT_READ_FAILED"));
    };
    reader.readAsText(preview);
  });
}

function PrdDraftArtifact({ document, reference }: { document: PrdDocument; reference: WorkbenchArtifactReference }) {
  const store = useWorkbenchPrdDraftStore();
  const draft = useSyncExternalStore(store?.subscribe ?? (() => () => {}), () => store?.get(reference), () => undefined);
  if (!draft) return <PrdArtifact document={document} />;
  return <div className="flex h-full flex-col">
    <div className="flex flex-wrap items-center gap-[12px] bg-[#2b2548] px-[18px] py-[10px] text-[13px]" role="status">
      <span>{draft.saving ? "正在保存 PRD…" : "未保存草稿 · 预览、导出和离开项目前会自动保存"}</span>
      <button disabled={draft.saving} onClick={() => { void store?.save(reference).catch(() => undefined); }} type="button">保存 PRD</button>
      <button disabled={draft.saving} onClick={() => store?.discard(reference)} type="button">放弃修改</button>
      {draft.error && <span className="text-[#f2a6a6]">{draft.error}</span>}
    </div>
    <div className="min-h-0 flex-1"><PrdArtifact document={draft.document} /></div>
  </div>;
}

function PrdArtifact({ document }: { document: PrdDocument }) {
  return document.protocol === "workbench.prd.v2"
    ? <PrdArtifactV2 document={document} />
    : <PrdArtifactV1 document={document} />;
}

function PrdArtifactV1({ document }: { document: PrdDocumentV1 }) {
  return (
    <article className="nowheel h-full w-full overflow-auto break-words bg-[#1d1d1f] px-[38px] py-[34px] text-[#e8eaed] [overflow-wrap:anywhere]">
      <h2 className="mb-[42px] text-[50px] font-semibold leading-none tracking-normal text-[#f1f3f4]">
        {document.title}
      </h2>
      {prdSectionKeys.map((key, sectionIndex) => {
        const section = document.sections[key];
        return (
          <section className="mb-[46px] text-[22px] leading-[36px]" key={key}>
            <h3 className="mb-[22px] text-[35px] font-semibold leading-none text-[#f1f3f4]">
              {formatPrdSectionTitle(section.title, sectionIndex + 1)}
            </h3>
            <div className="space-y-[18px]">
              {section.blocks.map((block) => <PrdBlockView block={block} key={block.id} />)}
            </div>
          </section>
        );
      })}
    </article>
  );
}

function PrdArtifactV2({ document }: { document: PrdDocumentV2 }) {
  const { businessRequirements, degradation, introduction, safetyBaseline } = document.sections;
  return (
    <article
      className="nowheel h-full w-full overflow-auto break-words bg-[#1d1d1f] px-[20px] py-[28px] text-[16px] leading-[27px] text-[#e8eaed] [overflow-wrap:anywhere] sm:px-[38px] sm:py-[34px]"
      data-prd-protocol={document.protocol}
    >
      <div className="mx-auto w-full max-w-[1120px]">
        <header
          className="flex min-h-[320px] flex-col justify-center border-b border-white/[0.12] py-[48px]"
          data-prd-cover
        >
          <p className="mb-[14px] text-[13px] font-semibold text-[#aeb4bd]">{document.cover.workOrderName}</p>
          <h1 className="max-w-[900px] text-[42px] font-semibold leading-[1.16] tracking-normal text-[#f1f3f4]">
            {document.cover.title}
          </h1>
          <dl className="mt-[34px] flex flex-wrap gap-x-[32px] gap-y-[8px] text-[14px] text-[#c7cad0]">
            <div className="flex gap-[8px]"><dt>文档版本</dt><dd>V{document.revision.number}</dd></div>
            <div className="flex gap-[8px]"><dt>文档状态</dt><dd>{prdRevisionStatusLabel(document.revision.status)}</dd></div>
            <div className="flex gap-[8px]"><dt>修订时间</dt><dd>{formatPrdDate(document.revision.changedAt)}</dd></div>
          </dl>
          <p className="mt-[10px] max-w-[760px] text-[14px] text-[#aeb4bd]">{document.revision.summary}</p>
        </header>

        <section className="border-b border-white/[0.12] py-[42px]" aria-labelledby="prd-version-history">
          <h2 className="mb-[20px] text-[28px] font-semibold text-[#f1f3f4]" id="prd-version-history">版 本 历 史</h2>
          <div className="overflow-x-auto border border-white/[0.12]">
            <table className="w-full border-collapse text-[14px] leading-[22px]">
              <thead className="bg-white/[0.05] text-[#f1f3f4]">
                <tr>
                  {[
                    "版本/状态", "作者", "参与者", "起止日期", "备注",
                  ].map((label) => <th className="border-b border-white/[0.12] px-[12px] py-[10px] text-left font-semibold" key={label}>{label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.08]">
                {document.versionHistory.map((entry, index) => (
                  <tr key={`${entry.startDate}-${entry.author}-${index}`}>
                    <td className="px-[12px] py-[10px]">{entry.status}</td>
                    <td className="px-[12px] py-[10px]">{entry.author}</td>
                    <td className="px-[12px] py-[10px]">{entry.participants.join("、")}</td>
                    <td className="px-[12px] py-[10px]">{entry.startDate} 至 {entry.endDate}</td>
                    <td className="px-[12px] py-[10px]">{entry.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <nav className="border-b border-white/[0.12] py-[42px]" aria-label="需求说明书目录">
          <h2 className="mb-[20px] text-center text-[28px] font-semibold text-[#f1f3f4]">{document.tableOfContents.title}</h2>
          <ol className="mx-auto grid max-w-[760px] gap-x-[40px] gap-y-[8px] text-[15px] text-[#d8dce2] sm:grid-cols-2">
            {document.tableOfContents.entries.map((entry) => (
              <li className="border-b border-white/[0.07] py-[7px]" key={entry}>
                {entry}
              </li>
            ))}
          </ol>
        </nav>

        <section className="border-b border-white/[0.12] py-[46px]" aria-labelledby="prd-v2-introduction">
          <h2 className="text-[30px] font-semibold text-[#f1f3f4]" id="prd-v2-introduction">{introduction.title}</h2>
          <PrdV2BlockSection section={introduction.background} />
          <PrdV2BlockSection section={introduction.scope} />
          <PrdV2BlockSection section={introduction.usageScenarios}>
            <PrdChannelTable table={introduction.usageScenarios.channelTable} />
          </PrdV2BlockSection>
        </section>

        <section className="border-b border-white/[0.12] py-[46px]" aria-labelledby="prd-v2-business-requirements">
          <h2 className="text-[30px] font-semibold text-[#f1f3f4]" id="prd-v2-business-requirements">{businessRequirements.title}</h2>
          <p className="mt-[16px] max-w-[900px] text-[#d8dce2]">{renderPrdInlines(businessRequirements.summary)}</p>
          <PrdV2BlockSection section={businessRequirements.pageLinks} />
          <PrdV2BlockSection section={businessRequirements.coreRules} />
          <PrdV2BlockSection section={businessRequirements.flowAndPages}>
            <div className="mt-[26px] space-y-[34px]">
              {businessRequirements.flowAndPages.diagrams.map((diagram) => (
                <PrdDiagramView diagram={diagram} key={diagram.id} />
              ))}
            </div>
          </PrdV2BlockSection>
          <PrdV2BlockSection section={businessRequirements.acceptanceCriteria} />
          {businessRequirements.additionalSections.map((section) => (
            <PrdV2BlockSection section={section} key={section.title} />
          ))}
        </section>

        <section className="border-b border-white/[0.12] py-[46px]" aria-labelledby="prd-v2-degradation">
          <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[6px]">
            <h2 className="text-[30px] font-semibold text-[#f1f3f4]" id="prd-v2-degradation">{degradation.title}</h2>
            <span className="text-[13px] font-semibold text-[#aeb4bd]">{degradation.applicable ? "适用" : "不涉及"}</span>
          </div>
          <p className="mt-[18px] max-w-[920px] text-[#d8dce2]">{renderPrdInlines(degradation.content)}</p>
        </section>

        <section className="py-[46px]" aria-labelledby="prd-v2-safety-baseline">
          <h2 className="text-[30px] font-semibold text-[#f1f3f4]" id="prd-v2-safety-baseline">{safetyBaseline.title}</h2>
          <p className="mt-[18px] max-w-[980px] whitespace-pre-line text-[14px] leading-[24px] text-[#c7cad0]">{safetyBaseline.intro}</p>
          <PrdSafetyBaselineTable rows={safetyBaseline.rows} />
        </section>
        {(document.assumptions.length > 0 || document.citations.length > 0) && (
          <section className="border-t border-white/[0.12] py-[46px]" aria-labelledby="prd-evidence">
            <h2 className="text-[30px] font-semibold text-[#f1f3f4]" id="prd-evidence">假设与来源</h2>
            {document.assumptions.length > 0 && (
              <div className="mt-[20px] rounded-[8px] border border-[#e6a05a]/30 bg-[#e6a05a]/[0.06] p-[18px]">
                <h3 className="font-semibold text-[#f1f3f4]">假设与未决事项</h3>
                <ul className="mt-[10px] ml-[24px] list-disc">
                  {document.assumptions.map((assumption) => (
                    <li key={assumption.id}>
                      {assumption.statement}（{assumption.status}，影响：{assumption.impact}
                      {assumption.owner ? `，负责人：${assumption.owner}` : ""}）
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {document.citations.length > 0 && (
              <ol className="mt-[20px] space-y-[12px]">
                {document.citations.map((citation) => (
                  <li className="border-b border-white/[0.08] pb-[10px]" key={citation.id}>
                    <div className="font-semibold text-[#f1f3f4]">{citation.title ?? citation.sourcePath}</div>
                    <div className="text-[13px] text-[#aeb4bd]">{citation.sourcePath}</div>
                    {citation.quote && <div className="mt-[4px] text-[14px] text-[#d8dce2]">{citation.quote}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </article>
  );
}

type PrdV2BlockSectionValue =
  | PrdDocumentV2["sections"]["introduction"]["background"]
  | PrdDocumentV2["sections"]["introduction"]["scope"]
  | PrdDocumentV2["sections"]["introduction"]["usageScenarios"]
  | PrdDocumentV2["sections"]["businessRequirements"]["pageLinks"]
  | PrdDocumentV2["sections"]["businessRequirements"]["coreRules"]
  | PrdDocumentV2["sections"]["businessRequirements"]["flowAndPages"]
  | PrdDocumentV2["sections"]["businessRequirements"]["acceptanceCriteria"]
  | PrdDocumentV2["sections"]["businessRequirements"]["additionalSections"][number];

function PrdV2BlockSection({
  children,
  section,
}: {
  children?: ReactNode;
  section: PrdV2BlockSectionValue;
}) {
  return (
    <section className="mt-[34px]">
      <h3 className="mb-[16px] text-[22px] font-semibold text-[#f1f3f4]">{section.title}</h3>
      <div className="space-y-[14px]">
        {section.blocks.map((block) => <PrdBlockView block={block} key={block.id} />)}
      </div>
      {children}
    </section>
  );
}

function PrdChannelTable({
  table,
}: {
  table: PrdDocumentV2["sections"]["introduction"]["usageScenarios"]["channelTable"];
}) {
  return (
    <div className="mt-[24px] overflow-x-auto border border-white/[0.12]" data-prd-channel-table>
      <table className="w-full border-collapse text-[14px] leading-[22px]">
        <caption className="border-b border-white/[0.12] bg-white/[0.05] px-[12px] py-[10px] text-left font-semibold text-[#f1f3f4]">
          {table.title}
        </caption>
        <thead>
          <tr>
            <th className="w-[72px] border-b border-white/[0.10] px-[12px] py-[10px] text-left">序号</th>
            <th className="border-b border-white/[0.10] px-[12px] py-[10px] text-left">活动投放的可选渠道</th>
            <th className="w-[120px] border-b border-white/[0.10] px-[12px] py-[10px] text-left">是否投放</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.08]">
          {table.rows.map((row) => (
            <tr key={row.channel}>
              <td className="px-[12px] py-[10px] tabular-nums">{row.sequence}</td>
              <td className="px-[12px] py-[10px]">{prdChannelLabels[row.channel]}</td>
              <td className="px-[12px] py-[10px]">{row.enabled ? "☑是 □否" : "□是 ☑否"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrdDiagramView({ diagram }: { diagram: PrdDiagram }) {
  const nodeLabels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
  const hasRenderableGraph = diagram.nodes.length > 0
    && diagram.edges.some((edge) => nodeLabels.has(edge.from) && nodeLabels.has(edge.to));
  return (
    <figure className="border-y border-white/[0.12] py-[24px]" data-prd-diagram={diagram.kind}>
      <figcaption>
        <h4 className="text-[18px] font-semibold text-[#f1f3f4]">{diagram.title}</h4>
        <p className="mt-[6px] max-w-[880px] text-[14px] leading-[23px] text-[#aeb4bd]">{diagram.description}</p>
      </figcaption>
      {hasRenderableGraph ? (
        <WorkbenchPrdDiagramCanvas diagram={diagram} />
      ) : (
        <div className="mt-[18px] border border-dashed border-[#d97706]/50 bg-[#d97706]/[0.08] px-[14px] py-[12px] text-[13px] text-[#f3c78b]" data-prd-diagram-empty>
          图表数据不完整，暂时无法绘制可视化关系。请重新生成文档。
        </div>
      )}
      <div className="mt-[20px]">
        <h5 className="mb-[6px] text-[13px] font-semibold text-[#aeb4bd]">节点关系</h5>
        <ol className="divide-y divide-white/[0.08] border-t border-white/[0.08]">
          {diagram.edges.map((edge) => (
            <li className="grid grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)] items-center gap-[8px] py-[10px] text-[14px]" data-prd-diagram-edge key={edge.id}>
              <span className="min-w-0 font-medium text-[#edf0f4]">{nodeLabels.get(edge.from) ?? edge.from}</span>
              <ArrowRightIcon aria-hidden="true" className="size-[15px] text-[#8f96a0]" />
              <span className="min-w-0 font-medium text-[#edf0f4]">{nodeLabels.get(edge.to) ?? edge.to}</span>
              {edge.label && <span className="col-span-3 text-[12px] text-[#aeb4bd]">{edge.label}</span>}
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}

function PrdSafetyBaselineTable({
  rows,
}: {
  rows: PrdDocumentV2["sections"]["safetyBaseline"]["rows"];
}) {
  return (
    <div className="mt-[24px] overflow-x-auto border border-white/[0.12]" data-prd-safety-table>
      <table className="w-full border-collapse text-[13px] leading-[20px]">
        <thead className="bg-white/[0.05] text-[#f1f3f4]">
          <tr>
            <th className="w-[58px] border-b border-white/[0.12] px-[10px] py-[10px] text-left">序号</th>
            <th className="border-b border-white/[0.12] px-[10px] py-[10px] text-left">需求安全基线内容</th>
            <th className="w-[210px] border-b border-white/[0.12] px-[10px] py-[10px] text-left">范围</th>
            <th className="w-[90px] border-b border-white/[0.12] px-[10px] py-[10px] text-left">是否涉及</th>
            <th className="w-[180px] border-b border-white/[0.12] px-[10px] py-[10px] text-left">备注</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.08]">
          {rows.map((row, index) => {
            const baseline = prdSafetyBaselineItems[index];
            if (!baseline) return null;
            return (
              <tr data-prd-safety-row key={row.sequence}>
                <td className="px-[10px] py-[10px] align-top tabular-nums">{baseline.sequence}</td>
                <td className="px-[10px] py-[10px] align-top">{baseline.requirement}</td>
                <td className="px-[10px] py-[10px] align-top text-[#c7cad0]">{baseline.scope}</td>
                <td className="px-[10px] py-[10px] align-top font-semibold">{row.applicability}</td>
                <td className="px-[10px] py-[10px] align-top text-[#c7cad0]">{row.remarks ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatPrdSectionTitle(title: string, sectionNumber: number) {
  return /^\s*\d+(?:\.\d+)*(?:[.)、]|\s|(?=[\u3400-\u9fff]))/u.test(title)
    ? title
    : `${sectionNumber}. ${title}`;
}

function prdRevisionStatusLabel(status: PrdDocument["revision"]["status"]) {
  if (status === "approved") return "已批准";
  if (status === "inReview") return "评审中";
  return "草稿";
}

function formatPrdDate(value: string) {
  return value.slice(0, 10);
}

function PrdBlockView({ block }: { block: PrdBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p>{renderPrdInlines(block.content)}</p>;
    case "heading":
      return block.level === 2
        ? <h4 className="text-[28px] font-semibold text-[#f1f3f4]">{renderPrdInlines(block.content)}</h4>
        : <h5 className="text-[24px] font-semibold text-[#f1f3f4]">{renderPrdInlines(block.content)}</h5>;
    case "bulletList":
    case "orderedList": {
      const List = block.type === "bulletList" ? "ul" : "ol";
      return (
        <List className={block.type === "bulletList" ? "ml-[30px] list-disc" : "ml-[30px] list-decimal"}>
          {block.items.map((item) => <li key={item.id}>{renderPrdInlines(item.content)}</li>)}
        </List>
      );
    }
    case "goal":
      return (
        <div className="rounded-[8px] border border-white/[0.10] bg-white/[0.04] p-[18px]">
          <div className="font-semibold text-[#f1f3f4]">{block.title}</div>
          <p>{renderPrdInlines(block.description)}</p>
          <p className="text-[18px] text-[#c7cad0]">成功指标：{block.successMetric} · 优先级：{block.priority}</p>
        </div>
      );
    case "requirement":
      return (
        <div className="rounded-[8px] border border-white/[0.10] bg-white/[0.04] p-[18px]">
          <div className="font-semibold text-[#f1f3f4]">{block.title}</div>
          <p>{renderPrdInlines(block.description)}</p>
          <p className="text-[18px] text-[#c7cad0]">优先级：{block.priority}</p>
        </div>
      );
    case "persona":
      return (
        <div className="rounded-[8px] border border-white/[0.10] bg-white/[0.04] p-[18px]">
          <div className="font-semibold text-[#f1f3f4]">{block.name}</div>
          <p>{renderPrdInlines(block.description)}</p>
          <p className="mt-[10px] text-[18px] text-[#c7cad0]">{block.needs.join(" · ")}</p>
          <p className="mt-[10px] text-[18px] text-[#c7cad0]">痛点：{block.painPoints.join(" · ")}</p>
        </div>
      );
    case "acceptanceCriterion":
      return (
        <div className="rounded-[8px] border border-white/[0.10] bg-white/[0.04] p-[18px]">
          <div><strong>前置条件：</strong>{renderPrdInlines(block.given)}</div>
          <div><strong>触发操作：</strong>{renderPrdInlines(block.when)}</div>
          <div><strong>预期结果：</strong>{renderPrdInlines(block.then)}</div>
        </div>
      );
    case "flow":
      return (
        <div>
          <div className="font-semibold text-[#f1f3f4]">{block.title}</div>
          <p className="text-[18px] text-[#c7cad0]">角色：{block.actor} · 触发：{block.trigger}</p>
          <ol className="ml-[30px] list-decimal">
            {block.steps.map((step) => <li key={step.id}>{step.text}</li>)}
          </ol>
          <p className="text-[18px] text-[#c7cad0]">结果：{block.outcome}</p>
        </div>
      );
    case "risk":
      return (
        <div className="rounded-[8px] border border-[#e6a05a]/30 bg-[#e6a05a]/[0.06] p-[18px]">
          <p>{renderPrdInlines(block.description)}</p>
          <p className="text-[18px] text-[#c7cad0]">可能性：{block.likelihood} · 影响：{block.impact}</p>
          <p className="text-[18px] text-[#c7cad0]">缓解措施：{renderPrdInlines(block.mitigation)}</p>
        </div>
      );
    case "callout":
      return (
        <div className="rounded-[8px] border border-[#7467f6]/35 bg-[#7467f6]/[0.08] p-[18px]">
          {block.title && <div className="font-semibold text-[#f1f3f4]">{block.title}</div>}
          <p>{renderPrdInlines(block.content)}</p>
        </div>
      );
    case "table":
      return (
        <div className="overflow-auto rounded-[8px] border border-white/[0.10]">
          <table className="w-full border-collapse text-[16px] leading-[24px]">
            <thead><tr>{block.columns.map((column) => <th className="border-b border-white/[0.10] p-[10px] text-left" key={column.id}>{column.label}</th>)}</tr></thead>
            <tbody>{block.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <td className="border-b border-white/[0.06] p-[10px]" key={cell.columnId}>{renderPrdInlines(cell.content)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

function renderPrdInlines(inlines: readonly PrdInline[]): ReactNode[] {
  return inlines.map((inline, index) => {
    const key = `${inline.type}-${index}`;
    if (inline.type === "link") {
      return <a className="underline" href={inline.href} key={key}>{inline.text}</a>;
    }
    if (inline.type === "citation") {
      return (
        <span data-prd-citation-id={inline.citationId} key={key} title={`Citation ${inline.citationId}`}>
          {inline.label ?? `[${inline.citationId}]`}
        </span>
      );
    }
    if (inline.type === "reference") {
      return (
        <span
          data-prd-reference-id={inline.targetId}
          data-prd-reference-type={inline.targetType}
          key={key}
        >
          {inline.label ?? inline.targetId}
        </span>
      );
    }

    let content: ReactNode = inline.text;
    for (const mark of inline.marks) {
      if (mark === "strong") content = <strong>{content}</strong>;
      else if (mark === "emphasis") content = <em>{content}</em>;
      else if (mark === "code") content = <code>{content}</code>;
      else content = <del>{content}</del>;
    }
    return <span key={key}>{content}</span>;
  });
}

function PrototypeArtifact({
  document,
  editable,
  editingBusy,
  initialScreenId,
  onDocumentCommit,
  reference,
}: {
  document: RenderablePrototypeDocument;
  editable: boolean;
  editingBusy: boolean;
  initialScreenId?: string;
  onDocumentCommit?: (
    reference: WorkbenchArtifactReference,
    document: PrototypeDocument,
  ) => Promise<void>;
  reference: WorkbenchArtifactReference;
}) {
  const [renderDocument, setRenderDocument] = useState<RenderablePrototypeDocument>(document);
  const [localCommitBusy, setLocalCommitBusy] = useState(false);
  const [runtime, setRuntime] = useState(() => (
    createPrototypeRuntimeState(document, initialScreenId)
  ));
  const nodeElements = useRef(new Map<string, HTMLElement | SVGSVGElement>());
  const nodeAnimations = useRef(new Map<string, Animation[]>());
  const previousRuntime = useRef<PrototypeRuntimeState | null>(null);
  const runtimeRef = useRef(runtime);
  const runtimeActionQueue = useRef<Promise<void>>(Promise.resolve());
  const runtimeGeneration = useRef(0);
  const pendingSubmitActions = useRef(new Set<string>());
  const appliedDocument = useRef<RenderablePrototypeDocument>(document);
  const incomingDocument = useRef<RenderablePrototypeDocument>(document);
  incomingDocument.current = document;
  const hardIdentity = `${reference.artifactVersionId}\u0000${document.documentId}\u0000${initialScreenId ?? ""}`;
  const screen = renderDocument.screens.find((candidate) => candidate.id === runtime.screenId)
    ?? renderDocument.screens[0];
  const assets = useMemo(
    () => new Map(renderDocument.assets.map((asset) => [asset.id, asset])),
    [renderDocument.assets],
  );

  const stopNodeMotions = useCallback((nodeId: string) => {
    for (const animation of nodeAnimations.current.get(nodeId) ?? []) animation.cancel();
    nodeAnimations.current.delete(nodeId);
  }, []);

  const runMotions = useCallback((
    trigger: "enter" | "exit" | "hover" | "press" | "stateChange" | "action",
    options: { actionId?: string; nodeId?: string; screenId?: string; stateId?: string | null },
  ) => {
    const completions: Promise<unknown>[] = [];
    for (const motion of prototypeRuntimeMotions(renderDocument, trigger, options)) {
      const element = nodeElements.current.get(motion.nodeId);
      if (!element || typeof element.animate !== "function") continue;
      if (trigger === "hover" || trigger === "press") stopNodeMotions(motion.nodeId);
      const node = renderDocument.nodes.find((candidate) => candidate.id === motion.nodeId);
      const animation = element.animate(
        prototypeMotionFrames(motion, node?.style.rotation ?? 0),
        {
          delay: motion.delayMs,
          duration: motion.durationMs,
          easing: prototypeMotionEasing(motion.easing),
          fill: "both",
        },
      );
      const active = nodeAnimations.current.get(motion.nodeId) ?? [];
      active.push(animation);
      nodeAnimations.current.set(motion.nodeId, active);
      completions.push(animation.finished.catch(() => undefined));
    }
    return Promise.all(completions);
  }, [renderDocument, stopNodeMotions]);

  useEffect(() => {
    const nextDocument = incomingDocument.current;
    runtimeGeneration.current += 1;
    for (const animations of nodeAnimations.current.values()) {
      for (const animation of animations) animation.cancel();
    }
    nodeAnimations.current.clear();
    nodeElements.current.clear();
    previousRuntime.current = null;
    appliedDocument.current = nextDocument;
    setRenderDocument(nextDocument);
    const nextRuntime = createPrototypeRuntimeState(nextDocument, initialScreenId);
    runtimeRef.current = nextRuntime;
    runtimeActionQueue.current = Promise.resolve();
    pendingSubmitActions.current.clear();
    setRuntime(nextRuntime);
    return () => {
      runtimeGeneration.current += 1;
    };
  }, [hardIdentity, initialScreenId]);

  useEffect(() => {
    const previousDocument = appliedDocument.current;
    if (previousDocument === document) return;
    appliedDocument.current = document;
    runtimeGeneration.current += 1;
    runtimeActionQueue.current = Promise.resolve();
    pendingSubmitActions.current.clear();
    const nextNodeIds = new Set(document.nodes.map((node) => node.id));
    for (const nodeId of nodeAnimations.current.keys()) {
      if (!nextNodeIds.has(nodeId)) stopNodeMotions(nodeId);
    }
    const nextRuntime = reconcilePrototypeRuntimeState(
      previousDocument,
      document,
      runtimeRef.current,
      initialScreenId,
    );
    setRenderDocument(document);
    runtimeRef.current = nextRuntime;
    setRuntime(nextRuntime);
  }, [document, initialScreenId, stopNodeMotions]);

  useEffect(() => {
    runtimeRef.current = runtime;
    const previous = previousRuntime.current;
    previousRuntime.current = runtime;
    if (!previous || previous.screenId !== runtime.screenId) {
      void (async () => {
        if (runtime.stateId !== null) {
          await runMotions("stateChange", {
            screenId: runtime.screenId,
            stateId: runtime.stateId,
          });
        }
        await runMotions("enter", { screenId: runtime.screenId, stateId: runtime.stateId });
      })();
    } else if (previous.stateId !== runtime.stateId && runtime.stateId !== null) {
      void runMotions("stateChange", {
        screenId: runtime.screenId,
        stateId: runtime.stateId,
      });
    }
  }, [runMotions, runtime]);

  const handleNodeEvent = useCallback((
    node: PrototypeNode,
    event: PrototypeAction["event"] | readonly PrototypeAction["event"][],
  ) => {
    if (editable) return;
    const actions = prototypeRuntimeActions(renderDocument, node, event);
    if (actions.length === 0) return;
    const submitActionId = actions.length === 1 && actions[0]?.kind === "submit"
      ? actions[0].id
      : null;
    if (submitActionId && pendingSubmitActions.current.has(submitActionId)) return;
    if (submitActionId) pendingSubmitActions.current.add(submitActionId);
    const generation = runtimeGeneration.current;
    const execution = runtimeActionQueue.current.catch(() => undefined).then(async () => {
      if (generation !== runtimeGeneration.current) return;
      let nextRuntime = runtimeRef.current;
      for (const action of actions) {
        await runMotions("action", {
          actionId: action.id,
          screenId: nextRuntime.screenId,
          stateId: nextRuntime.stateId,
        });
        if (generation !== runtimeGeneration.current) return;
        if (action.kind === "navigate") {
          await runMotions("exit", {
            screenId: nextRuntime.screenId,
            stateId: nextRuntime.stateId,
          });
          if (generation !== runtimeGeneration.current) return;
        }
        nextRuntime = { ...nextRuntime, variables: runtimeRef.current.variables };
        const result = applyPrototypeRuntimeAction(renderDocument, nextRuntime, action);
        nextRuntime = result.state;
        if (result.effect?.kind === "openUrl") {
          if (!isSafePrototypeOpenUrl(result.effect.url)) continue;
          if (result.effect.target === "newWindow") {
            window.open(result.effect.url, "_blank", "noopener,noreferrer");
          } else {
            window.location.assign(result.effect.url);
          }
        } else if (result.effect?.kind === "submit") {
          nodeElements.current.get(result.effect.formNodeId)?.dispatchEvent(
            new CustomEvent(workbenchPrototypeSubmitEventName, {
              bubbles: true,
              composed: true,
              detail: result.effect,
            }),
          );
        }
      }
      if (generation !== runtimeGeneration.current) return;
      runtimeRef.current = nextRuntime;
      setRuntime(nextRuntime);
    });
    runtimeActionQueue.current = execution.finally(() => {
      if (submitActionId) pendingSubmitActions.current.delete(submitActionId);
    });
  }, [editable, renderDocument, runMotions]);

  const commitDocument = useCallback(async (nextDocument: PrototypeDocument) => {
    if (!editable || !onDocumentCommit || localCommitBusy || editingBusy) return;
    setRenderDocument(nextDocument);
    setLocalCommitBusy(true);
    try {
      await onDocumentCommit(reference, nextDocument);
    } catch (error) {
      setRenderDocument(document);
      throw error;
    } finally {
      setLocalCommitBusy(false);
    }
  }, [document, editable, editingBusy, localCommitBusy, onDocumentCommit, reference]);

  const previewDocument = useCallback((nextDocument: PrototypeDocument) => {
    if (!editable || localCommitBusy || editingBusy) return;
    setRenderDocument(nextDocument);
  }, [editable, editingBusy, localCommitBusy]);

  return <>
    {renderDocument.assets.map((asset) => asset.kind === "font"
      ? <PrototypeFontLoader asset={asset} key={asset.id} reference={reference} />
      : null)}
    <PrototypeScreenCanvas
      assets={assets}
      document={renderDocument}
      editable={editable && !editingBusy && !localCommitBusy}
      editorDocument={editable ? document as PrototypeDocument : null}
      onDocumentCommit={commitDocument}
      onDocumentPreview={previewDocument}
      onInputValue={(node, value) => {
        const nextRuntime = updatePrototypeRuntimeInput(
          renderDocument,
          runtimeRef.current,
          node,
          value,
        );
        runtimeRef.current = nextRuntime;
        setRuntime(nextRuntime);
      }}
      onInteractionEnd={stopNodeMotions}
      onInteractionStart={(nodeId, trigger) => {
        void runMotions(trigger, {
          nodeId,
          screenId: runtime.screenId,
          stateId: runtime.stateId,
        });
      }}
      onNodeEvent={handleNodeEvent}
      onReset={(formNodeId) => {
        const nextRuntime = resetPrototypeRuntimeForm(
          renderDocument,
          runtimeRef.current,
          formNodeId,
        );
        runtimeRef.current = nextRuntime;
        setRuntime(nextRuntime);
      }}
      registerNode={(nodeId, element) => {
        if (element) nodeElements.current.set(nodeId, element);
        else nodeElements.current.delete(nodeId);
      }}
      reference={reference}
      runtime={runtime}
      screenId={screen.id}
    />
  </>;
}

function PrototypeScreenCanvas({
  assets,
  document,
  editable,
  editorDocument,
  onDocumentCommit,
  onDocumentPreview,
  onInputValue,
  onInteractionEnd,
  onInteractionStart,
  onNodeEvent,
  onReset,
  registerNode,
  reference,
  runtime,
  screenId,
}: {
  assets: Map<string, RenderablePrototypeAsset>;
  document: RenderablePrototypeDocument;
  editable: boolean;
  editorDocument: PrototypeDocument | null;
  onDocumentCommit: (document: PrototypeDocument) => Promise<void>;
  onDocumentPreview: (document: PrototypeDocument) => void;
  onInputValue: PrototypeRuntimeContextValue["onInputValue"];
  onInteractionEnd: PrototypeRuntimeContextValue["onInteractionEnd"];
  onInteractionStart: PrototypeRuntimeContextValue["onInteractionStart"];
  onNodeEvent: PrototypeRuntimeContextValue["onNodeEvent"];
  onReset: PrototypeRuntimeContextValue["onReset"];
  registerNode: PrototypeRuntimeContextValue["registerNode"];
  reference: WorkbenchArtifactReference;
  runtime: PrototypeRuntimeState;
  screenId: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [selectedNodeIds, setSelectedNodeIds] = useState<readonly string[]>([]);
  const screen = document.screens.find((candidate) => candidate.id === screenId)
    ?? document.screens[0];
  const nodes = useMemo(() => new Map(document.nodes.map((node) => [node.id, node])), [document.nodes]);
  const tokens = useMemo(() => tokenMap(document), [document]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const resize = () => {
      const size = { width: host.clientWidth, height: host.clientHeight };
      setHostSize(size);
      setScale(Math.min(
        size.width / screen.viewport.width,
        size.height / screen.viewport.height,
      ));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [screen.viewport.height, screen.viewport.width]);

  useEffect(() => {
    setSelectedNodeIds([]);
  }, [editorDocument, screenId]);

  const root = nodes.get(screen.rootNodeId);
  const rendererTransform = hostSize.width > 0 && hostSize.height > 0
    ? centeredPrototypeRendererTransform(hostSize, screen.viewport, scale)
    : null;
  const resolveTarget = useCallback((nodeId: string) => {
    const host = hostRef.current;
    if (!host) return null;
    return Array.from(host.querySelectorAll<HTMLElement | SVGElement>(PROTOTYPE_SELECTABLE_TARGET))
      .find((target) => target.getAttribute(PROTOTYPE_NODE_ID_ATTRIBUTE) === nodeId)
      ?? null;
  }, []);
  const applyTransform = useCallback((
    result: PrototypeEditorResult<PrototypeTransformBatchCommand>,
  ): PrototypeDocument | null => {
    if (!result.ok || !editorDocument) return null;
    const patches = patchBatchFromTransformCommand(editorDocument, result.value);
    return patches.ok ? applyPrototypeTransformPatchBatch(editorDocument, patches.value) : null;
  }, [editorDocument]);
  const runtimeContext = useMemo<PrototypeRuntimeContextValue>(() => ({
    document,
    editable,
    onInputValue,
    onInteractionEnd,
    onInteractionStart,
    onNodeEvent,
    onReset,
    registerNode,
    runtime,
  }), [
    document,
    editable,
    onInputValue,
    onInteractionEnd,
    onInteractionStart,
    onNodeEvent,
    onReset,
    registerNode,
    runtime,
  ]);
  return (
    <PrototypeRuntimeContext.Provider value={runtimeContext}>
    <div
      className={`relative h-full w-full overflow-hidden${editable ? " nodrag nopan" : ""}`}
      data-prototype-editor={editable ? "active" : undefined}
      ref={hostRef}
    >
      <div
        className="absolute left-1/2 top-1/2 origin-center overflow-hidden"
        data-canvas-artifact-id={reference.artifactId}
        data-canvas-artifact-version-id={reference.artifactVersionId}
        data-canvas-screen-id={screen.id}
        data-canvas-visual-screen
        style={{
          width: screen.viewport.width,
          height: screen.viewport.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {root && (
          <PrototypeNodeView
            assets={assets}
            node={root}
            nodes={nodes}
            reference={reference}
            tokens={tokens}
          />
        )}
      </div>
      {editable && editorDocument && rendererTransform && (
        <PrototypeEditorKernelAdapter
          container={hostRef.current}
          document={editorDocument}
          onSelectionChange={(selection) => setSelectedNodeIds(selection.nodeIds)}
          onTransformCommit={(result) => {
            const next = applyTransform(result);
            if (next) void onDocumentCommit(next).catch(() => undefined);
          }}
          onTransformPreview={(result) => {
            const next = applyTransform(result);
            if (next) onDocumentPreview(next);
          }}
          rendererTransform={rendererTransform}
          resolveTarget={resolveTarget}
          screenId={screen.id}
          selectedNodeIds={selectedNodeIds}
        />
      )}
    </div>
    </PrototypeRuntimeContext.Provider>
  );
}

type TokenMap = Map<string, string | number>;
type PrototypeVectorCommand = Extract<PrototypeNode, { kind: "vector" }>["paths"][number]["commands"][number];

function tokenMap(document: RenderablePrototypeDocument): TokenMap {
  return new Map(document.tokens.flatMap((token) => (
    typeof token.value === "string" || typeof token.value === "number"
      ? [[token.id, token.value] as const]
      : []
  )));
}

function PrototypeNodeView({
  assets,
  node,
  nodes,
  reference,
  tokens,
}: {
  assets: Map<string, RenderablePrototypeAsset>;
  node: PrototypeNode;
  nodes: Map<string, PrototypeNode>;
  reference: WorkbenchArtifactReference;
  tokens: TokenMap;
}) {
  const runtime = usePrototypeRuntime();
  const projection = projectPrototypeRuntimeNode(runtime.document, runtime.runtime, node);
  if (!projection.visible) return null;
  const style = nodeStyle(node, projection.stateOverride?.style, tokens);
  const dispatch = (
    events: PrototypeAction["event"] | readonly PrototypeAction["event"][],
  ) => {
    if (runtime.editable) return;
    if (prototypeRuntimeActions(runtime.document, node, events).length === 0) return;
    runtime.onNodeEvent(node, events);
  };
  const onClick = () => dispatch(["click", "press"]);
  const onPointerEnter = () => {
    if (!runtime.editable) runtime.onInteractionStart(node.id, "hover");
  };
  const onPointerLeave = () => runtime.onInteractionEnd(node.id);
  const onPointerDown = () => {
    if (runtime.editable) return;
    runtime.onInteractionStart(node.id, "press");
  };
  const onPointerUp = () => runtime.onInteractionEnd(node.id);
  const registerNode = (element: HTMLElement | SVGSVGElement | null) => {
    runtime.registerNode(node.id, element);
  };
  const children = node.kind === "frame" || node.kind === "form" || node.kind === "button"
    ? node.childIds.map((childId) => nodes.get(childId)).filter((child): child is PrototypeNode => Boolean(child))
    : [];
  const editorProps = runtime.editable ? prototypeNodeDomProps(node.id) : {};

  if (node.kind === "text") {
    return (
      <div
        {...editorProps}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        ref={registerNode}
        style={style}
      >
        {projection.text}
      </div>
    );
  }
  if (node.kind === "input") {
    const value = projection.value === null ? "" : String(projection.value);
    const common = {
      "aria-label": node.label,
      className: "h-full w-full border-0 bg-transparent px-[10px] outline-none",
      disabled: runtime.editable || !projection.enabled,
      maxLength: ["text", "email", "password", "search", "textarea"].includes(node.inputType)
        ? 10_000
        : undefined,
      name: node.fieldName,
      onBlur: () => dispatch("blur"),
      onClick,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const target = event.currentTarget;
        const nextValue = prototypeRuntimeInputValue(
          node,
          target.value,
          "checked" in target ? target.checked : false,
        );
        runtime.onInputValue(node, nextValue);
        runtime.onNodeEvent(node, "change");
      },
      onFocus: () => dispatch("focus"),
      placeholder: node.placeholder,
      required: node.required,
    };
    return (
      <label
        {...editorProps}
        className="nodrag nopan"
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        ref={registerNode}
        style={style}
      >
        {node.inputType === "textarea"
          ? <textarea {...common} value={value} />
          : node.inputType === "select"
            ? (
                <select {...common} value={value}>
                  {projection.value === "" && <option value="">{node.placeholder}</option>}
                  {node.options.map((option) => (
                    <option disabled={option.disabled} key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )
            : node.inputType === "checkbox"
              ? <input {...common} checked={projection.checked} type="checkbox" value="true" />
              : node.inputType === "radio"
                ? <input {...common} checked={projection.checked} type="radio" value={node.optionValue ?? ""} />
              : <input {...common} type={node.inputType} value={value} />}
      </label>
    );
  }
  if (node.kind === "button") {
    return (
      <button
        {...editorProps}
        aria-label={projection.text ?? node.label}
        className="nodrag nopan"
        disabled={runtime.editable || !projection.enabled}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        ref={registerNode}
        style={style}
        type={node.buttonType}
      >
        <span data-wb-content="label">{projection.text}</span>
        {children.map((child) => <PrototypeNodeView assets={assets} key={child.id} node={child} nodes={nodes} reference={reference} tokens={tokens} />)}
      </button>
    );
  }
  if (node.kind === "form") {
    return (
      <form
        {...editorProps}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        onReset={(event) => {
          event.preventDefault();
          if (!runtime.editable) runtime.onReset(node.id);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          dispatch("submit");
        }}
        ref={registerNode}
        style={style}
      >
        {children.map((child) => <PrototypeNodeView assets={assets} key={child.id} node={child} nodes={nodes} reference={reference} tokens={tokens} />)}
      </form>
    );
  }
  if (node.kind === "image") {
    const asset = projection.assetId ? assets.get(projection.assetId) : undefined;
    if (!asset || asset.kind !== "image") {
      return <PrototypeImagePlaceholder alt={node.alt} editable={runtime.editable} nodeId={node.id} style={style} />;
    }
    return (
      <PrototypeImageNode
        alt={node.alt}
        asset={asset}
        editable={runtime.editable}
        fit={node.fit}
        nodeId={node.id}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        reference={reference}
        registerNode={registerNode}
        style={style}
      />
    );
  }
  if (node.kind === "icon") {
    const asset = projection.assetId ? assets.get(projection.assetId) : undefined;
    return (
      <span
        {...editorProps}
        aria-label={node.accessibilityLabel ?? asset?.name ?? node.name}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        ref={registerNode}
        style={style}
      >
        {asset?.kind === "icon"
          ? <WorkbenchPrototypeIcon iconName={asset.iconName} />
          : <span aria-hidden="true">{node.name}</span>}
      </span>
    );
  }
  if (node.kind === "vector") {
    return (
      <svg
        {...editorProps}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        ref={registerNode}
        style={style}
        viewBox={`${node.viewBox.minX} ${node.viewBox.minY} ${node.viewBox.width} ${node.viewBox.height}`}
      >
        {node.paths.map((path) => <path d={vectorPath(path.commands)} fillRule={path.fillRule} key={path.id} />)}
      </svg>
    );
  }
  return (
    <div
      {...editorProps}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      ref={registerNode}
      style={style}
    >
      {children.map((child) => <PrototypeNodeView assets={assets} key={child.id} node={child} nodes={nodes} reference={reference} tokens={tokens} />)}
    </div>
  );
}

function PrototypeImageNode({
  alt,
  asset,
  editable,
  fit,
  nodeId,
  onClick,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerUp,
  reference,
  registerNode,
  style,
}: {
  alt: string;
  asset: Extract<RenderablePrototypeAsset, { kind: "image" }>;
  editable: boolean;
  fit: Extract<PrototypeNode, { kind: "image" }>["fit"];
  nodeId: string;
  onClick: (event: ReactMouseEvent) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerUp: () => void;
  reference: WorkbenchArtifactReference;
  registerNode: (element: HTMLElement | SVGSVGElement | null) => void;
  style: CSSProperties;
}) {
  const isPublic = Boolean(reference.shareToken);
  const privateQuery = useWorkbenchArtifactVersionAsset(
    reference.projectId,
    reference.artifactId,
    reference.artifactVersionId,
    asset.id,
    !isPublic,
  );
  const publicQuery = useWorkbenchPublicSharedArtifactAsset(
    reference.shareToken ?? "",
    reference.artifactId,
    reference.artifactVersionId,
    asset.id,
    isPublic,
  );
  const query = isPublic ? publicQuery : privateQuery;
  const [failedContent, setFailedContent] = useState<Blob | null>(null);
  const content = query.data && query.data !== failedContent ? query.data : undefined;
  const objectUrl = useBlobObjectUrl(content);
  const imageFailed = query.isError || Boolean(query.data && query.data === failedContent);

  if (imageFailed || !objectUrl) {
    return (
      <PrototypeImagePlaceholder
        alt={alt}
        editable={editable}
        failed={imageFailed}
        nodeId={nodeId}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        onRetry={() => {
          setFailedContent(null);
          void query.refetch();
        }}
        registerNode={registerNode}
        style={style}
      />
    );
  }
  return (
    <img
      {...(editable ? prototypeNodeDomProps(nodeId) : {})}
      alt={alt}
      onClick={onClick}
      onError={() => {
        if (query.data) setFailedContent(query.data);
      }}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      ref={registerNode}
      src={objectUrl}
      style={{ ...style, objectFit: fit }}
    />
  );
}

function PrototypeImagePlaceholder({
  alt,
  editable,
  failed = false,
  nodeId,
  onClick,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerUp,
  onRetry,
  registerNode,
  style,
}: {
  alt: string;
  editable: boolean;
  failed?: boolean;
  nodeId: string;
  onClick?: (event: ReactMouseEvent) => void;
  onPointerDown?: (event: ReactPointerEvent) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onPointerUp?: () => void;
  onRetry?: () => void;
  registerNode?: (element: HTMLElement | SVGSVGElement | null) => void;
  style: CSSProperties;
}) {
  return (
    <div
      {...(editable ? prototypeNodeDomProps(nodeId) : {})}
      aria-label={alt}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      ref={registerNode}
      style={{
        ...style,
        background: "repeating-conic-gradient(#d8dce2 0 25%,#b8bcc4 0 50%) 0 / 16px 16px",
      }}
    >
      {failed && onRetry && (
        <div
          aria-label={`${alt} 加载失败`}
          className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center gap-[6px] overflow-hidden bg-[#111214]/65 p-[6px] text-center text-white"
          role="alert"
        >
          <span className="min-w-0 truncate text-[11px] font-medium leading-[14px]">
            图片加载失败
          </span>
          <button
            aria-label={`重试加载图片：${alt}`}
            className="grid size-[28px] shrink-0 place-items-center rounded-[6px] border border-white/20 bg-[#1d1d1f]/85 text-white transition-colors hover:bg-[#303033] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            title="重试加载图片"
            type="button"
          >
            <RefreshCwIcon aria-hidden="true" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function PrototypeFontLoader({
  asset,
  reference,
}: {
  asset: Extract<RenderablePrototypeAsset, { kind: "font" }>;
  reference: WorkbenchArtifactReference;
}) {
  const isPublic = Boolean(reference.shareToken);
  const privateQuery = useWorkbenchArtifactVersionAsset(
    reference.projectId,
    reference.artifactId,
    reference.artifactVersionId,
    asset.id,
    !isPublic,
  );
  const publicQuery = useWorkbenchPublicSharedArtifactAsset(
    reference.shareToken ?? "",
    reference.artifactId,
    reference.artifactVersionId,
    asset.id,
    isPublic,
  );
  const query = isPublic ? publicQuery : privateQuery;
  const [failedContent, setFailedContent] = useState<Blob | null>(null);
  const content = query.data && query.data !== failedContent ? query.data : undefined;
  const objectUrl = useBlobObjectUrl(content);

  useEffect(() => {
    if (!content || !objectUrl || typeof FontFace === "undefined" || !document.fonts) return;
    const format = asset.mediaType === "font/woff2" ? "woff2" : "woff";
    let face: FontFace;
    try {
      face = new FontFace(
        asset.family,
        `url(${JSON.stringify(objectUrl)}) format("${format}")`,
        { style: asset.style, weight: String(asset.weight) },
      );
    } catch {
      setFailedContent(content);
      return;
    }
    let active = true;
    let registeredFace: FontFace | null = null;
    void face.load().then((loadedFace) => {
      if (!active) return;
      document.fonts.add(loadedFace);
      registeredFace = loadedFace;
    }).catch(() => {
      if (active) setFailedContent(content);
    });
    return () => {
      active = false;
      if (registeredFace) document.fonts.delete(registeredFace);
    };
  }, [asset.family, asset.mediaType, asset.style, asset.weight, content, objectUrl]);

  return null;
}

function useBlobObjectUrl(content: Blob | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!content || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(content);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [content]);
  return objectUrl;
}

type ResolvedPrototypeMotion = ReturnType<typeof prototypeRuntimeMotions>[number];

function prototypeMotionFrames(
  motion: ResolvedPrototypeMotion,
  staticRotation: number,
): [Keyframe, Keyframe] {
  if (motion.property === "opacity") {
    return [{ opacity: motion.from }, { opacity: motion.to }];
  }
  if (motion.property === "rotation") {
    return [
      { transform: `rotate(${motion.from}deg)` },
      { transform: `rotate(${motion.to}deg)` },
    ];
  }
  const transform = (value: number) => {
    if (motion.property === "x") return `translateX(${value}px) rotate(${staticRotation}deg)`;
    if (motion.property === "y") return `translateY(${value}px) rotate(${staticRotation}deg)`;
    return `scale(${value}) rotate(${staticRotation}deg)`;
  };
  return [{ transform: transform(motion.from) }, { transform: transform(motion.to) }];
}

function prototypeMotionEasing(easing: ResolvedPrototypeMotion["easing"]) {
  if (easing === "easeIn") return "ease-in";
  if (easing === "easeOut") return "ease-out";
  if (easing === "easeInOut") return "ease-in-out";
  if (easing === "spring") return "cubic-bezier(.2,.8,.2,1)";
  return "linear";
}

function nodeStyle(
  node: PrototypeNode,
  override: PrototypeState["overrides"][number]["style"] | undefined,
  tokens: TokenMap,
): CSSProperties {
  const layout = node.layout;
  const visual = override ?? node.style;
  const style: CSSProperties = {
    boxSizing: "border-box",
    opacity: visual.opacity,
    transform: `rotate(${visual.rotation}deg)`,
    transformBox: "border-box",
    transformOrigin: `${visual.transformOrigin.x * 100}% ${visual.transformOrigin.y * 100}%`,
    overflow: layout.overflow,
    position: layout.mode === "absolute" ? "absolute" : "relative",
    left: layout.mode === "absolute" ? numberValue(layout.x, tokens) : undefined,
    top: layout.mode === "absolute" ? numberValue(layout.y, tokens) : undefined,
    width: numberValue(layout.width, tokens),
    height: numberValue(layout.height, tokens),
    display: layout.display,
    flexDirection: layout.display === "flex" ? layout.direction : undefined,
    gap: numberValue(layout.gap, tokens),
    padding: `${numberValue(layout.padding.top, tokens)}px ${numberValue(layout.padding.right, tokens)}px ${numberValue(layout.padding.bottom, tokens)}px ${numberValue(layout.padding.left, tokens)}px`,
    alignItems: layout.align === "start" ? "flex-start" : layout.align === "end" ? "flex-end" : layout.align,
    justifyContent: layout.justify === "spaceBetween" ? "space-between" : layout.justify === "spaceAround" ? "space-around" : layout.justify === "start" ? "flex-start" : layout.justify === "end" ? "flex-end" : layout.justify,
    gridTemplateColumns: layout.display === "grid" && layout.gridColumns ? `repeat(${layout.gridColumns}, minmax(0, 1fr))` : undefined,
    backgroundColor: node.kind !== "text" && visual.fill ? stringValue(visual.fill, tokens) : undefined,
    color: node.kind === "text" && visual.fill ? stringValue(visual.fill, tokens) : undefined,
    borderColor: visual.stroke ? stringValue(visual.stroke.color, tokens) : undefined,
    borderStyle: visual.stroke?.style,
    borderWidth: visual.stroke ? numberValue(visual.stroke.width, tokens) : undefined,
    borderRadius: `${numberValue(visual.radii.topLeft, tokens)}px ${numberValue(visual.radii.topRight, tokens)}px ${numberValue(visual.radii.bottomRight, tokens)}px ${numberValue(visual.radii.bottomLeft, tokens)}px`,
    fontFamily: visual.typography ? stringValue(visual.typography.fontFamily, tokens) : undefined,
    fontSize: visual.typography ? numberValue(visual.typography.fontSize, tokens) : undefined,
    fontWeight: visual.typography ? numberValue(visual.typography.fontWeight, tokens) : undefined,
    lineHeight: visual.typography ? `${numberValue(visual.typography.lineHeight, tokens)}px` : undefined,
    letterSpacing: visual.typography ? numberValue(visual.typography.letterSpacing, tokens) : undefined,
    textAlign: visual.typography?.align,
    textTransform: visual.typography?.transform === "none" ? undefined : visual.typography?.transform,
    textDecoration: visual.typography?.decoration === "lineThrough" ? "line-through" : visual.typography?.decoration,
  };
  return style;
}

function numberValue(value: { kind: "literal"; value: number } | { kind: "token"; tokenId: string }, tokens: TokenMap): number {
  const resolved = value.kind === "literal" ? value.value : tokens.get(value.tokenId);
  return typeof resolved === "number" ? resolved : 0;
}

function stringValue(value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string }, tokens: TokenMap): string {
  const resolved = value.kind === "literal" ? value.value : tokens.get(value.tokenId);
  return typeof resolved === "string" ? resolved : "";
}

function vectorPath(commands: readonly PrototypeVectorCommand[]): string {
  return commands.map((command) => {
    switch (command.command) {
      case "moveTo": return `M ${command.x} ${command.y}`;
      case "lineTo": return `L ${command.x} ${command.y}`;
      case "horizontalTo": return `H ${command.x}`;
      case "verticalTo": return `V ${command.y}`;
      case "curveTo": return `C ${command.control1X} ${command.control1Y} ${command.control2X} ${command.control2Y} ${command.x} ${command.y}`;
      case "quadraticTo": return `Q ${command.controlX} ${command.controlY} ${command.x} ${command.y}`;
      case "close": return "Z";
      default: return "";
    }
  }).join(" ");
}
