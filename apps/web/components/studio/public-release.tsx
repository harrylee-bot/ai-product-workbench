"use client";
import { useState } from "react";
import type { JsonValue, PublicShare } from "@workbench/workbench-contracts";
import { useWorkbenchPublicSharedArtifactVersion } from "@/lib/workbench/features/public-shares";
import { useWorkbenchPublicSharesApi } from "@/lib/studio/api";
import { publicShareTokenScope } from "@/lib/workbench/features/public-shares";
import {
  StructuredContent,
  VerifiedBlobContent,
  PrototypeArtifactPreview,
} from "./content";

export function PublicRelease({
  share,
  token,
}: {
  share: PublicShare;
  token: string;
}) {
  const [selected, setSelected] = useState("");
  const pins = share.release.artifactPins,
    pin = pins.find((p) => p.artifactVersionId === selected) ?? pins[0];
  return (
    <div className="studio-public-release">
      <header className="studio-topbar">
        <strong>共享项目 · 发布 {share.release.version}</strong>
        <span>只读 · {pins.length} 个产物</span>
      </header>
      <nav aria-label="发布内容">
        {pins.map((pin) => (
          <button
            key={pin.artifactVersionId}
            aria-pressed={
              (selected || pins[0]?.artifactVersionId) === pin.artifactVersionId
            }
            onClick={() => setSelected(pin.artifactVersionId)}
          >
            {pin.title}
          </button>
        ))}
      </nav>
      <main className="studio-view">
        {pin ? (
          <PublicArtifact
            key={pin.artifactVersionId}
            token={token}
            artifactId={pin.artifactId}
            versionId={pin.artifactVersionId}
            title={pin.title}
          />
        ) : (
          <p>此发布没有可预览产物。</p>
        )}
      </main>
    </div>
  );
}
function PublicArtifact({
  token,
  artifactId,
  versionId,
  title,
}: {
  token: string;
  artifactId: string;
  versionId: string;
  title: string;
}) {
  const api = useWorkbenchPublicSharesApi();
  const query = useWorkbenchPublicSharedArtifactVersion(
      token,
      artifactId,
      versionId,
    ),
    value = query.data?.value;
  if (query.isPending) return <p role="status">正在加载…</p>;
  if (query.error || !value)
    return (
      <p role="alert">
        此分享内容不可用或已失效。
        <button onClick={() => void query.refetch()}>重试</button>
      </p>
    );
  if (value.contentMode === "blob")
    return (
      <VerifiedBlobContent
        cacheKey={[
          "public",
          publicShareTokenScope(token),
          artifactId,
          versionId,
        ]}
        metadata={value.blob}
        load={() =>
          api.getPublicSharedArtifactVersionContent(
            token,
            artifactId,
            versionId,
          )
        }
        title={title}
      />
    );
  if (value.kind === "prototype" && value.contentMode === "inline")
    return (
      <PrototypeArtifactPreview
        cacheKey={[
          "public",
          publicShareTokenScope(token),
          artifactId,
          versionId,
        ]}
        title={title}
        create={() =>
          api.createSourcePrototypePreviewToken(token, artifactId, versionId)
        }
      />
    );
  return (
    <article className="studio-document">
      <StructuredContent value={value.content as unknown as JsonValue} />
    </article>
  );
}
