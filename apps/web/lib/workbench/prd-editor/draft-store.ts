import { canonicalJson, prdDocumentSchema, type PrdDocument } from "@workbench/workbench-contracts";

export type PrdDraftReference = { projectId: string; artifactId: string; artifactVersionId: string };
export type PrdDraftCommit = (reference: PrdDraftReference, document: PrdDocument) => Promise<void | string>;
export type PrdDraftReplacement = PrdDraftReference & { savedArtifactVersionId: string };
export type PrdDraft = {
  reference: PrdDraftReference;
  baseline: PrdDocument;
  document: PrdDocument;
  saving: boolean;
  error: string | null;
  prepared?: PrdDocument;
};

export class PrdDraftStore {
  private drafts = new Map<string, PrdDraft>();
  private listeners = new Set<() => void>();
  private committers = new Map<string, PrdDraftCommit>();
  private pending = new Map<string, Promise<PrdDraftReplacement | null>>();

  constructor(private readonly storage?: Storage, private readonly storageKey?: string) {
    if (!storage || !storageKey) return;
    try {
      const stored: unknown = JSON.parse(storage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(stored)) return;
      for (const candidate of stored) {
        if (!candidate || typeof candidate !== "object") continue;
        const reference = candidate.reference;
        const baseline = prdDocumentSchema.safeParse(candidate.baseline);
        if (!reference || ![reference.projectId, reference.artifactId, reference.artifactVersionId]
          .every((value) => typeof value === "string" && value.length > 0) || !baseline.success) continue;
        // Drafts may temporarily contain empty required text. Validate structure
        // here and the complete business contract at the save boundary.
        const validatedDraft = prdDocumentSchema.safeParse(candidate.document);
        if (!validatedDraft.success && !hasDraftShape(candidate.document, baseline.data)) continue;
        this.drafts.set(key(reference), {
          reference,
          baseline: baseline.data,
          document: validatedDraft.success ? validatedDraft.data : candidate.document as PrdDocument,
          saving: false,
          error: null,
          prepared: prdDocumentSchema.safeParse(candidate.prepared).success ? candidate.prepared : undefined,
        });
      }
    } catch { /* A denied storage API must not prevent opening the editor. */ }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(reference: PrdDraftReference): PrdDraft | undefined {
    return this.drafts.get(key(reference));
  }

  hasDrafts(projectId?: string): boolean {
    return [...this.drafts.values()].some((draft) => !projectId || draft.reference.projectId === projectId);
  }

  update(reference: PrdDraftReference, baseline: PrdDocument, document: PrdDocument): void {
    const current = this.get(reference);
    if (current?.saving) return;
    const original = current?.baseline ?? baseline;
    if (canonicalJson(original) === canonicalJson(document)) {
      this.discard(reference);
      return;
    }
    this.drafts.set(key(reference), {
      reference: current?.reference ?? reference,
      baseline: original,
      document,
      saving: false,
      error: null,
    });
    this.changed();
  }

  discard(reference: PrdDraftReference): void {
    if (this.get(reference)?.saving) return;
    this.drafts.delete(key(reference));
    this.changed();
  }

  registerProject(projectId: string, commit: PrdDraftCommit): () => void {
    this.committers.set(projectId, commit);
    return () => {
      if (this.committers.get(projectId) === commit) this.committers.delete(projectId);
    };
  }

  async saveProject(projectId: string): Promise<PrdDraftReplacement[]> {
    const replacements: PrdDraftReplacement[] = [];
    for (const draft of [...this.drafts.values()]) {
      if (draft.reference.projectId !== projectId) continue;
      const replacement = await this.save(draft.reference);
      if (replacement) replacements.push(replacement);
    }
    return replacements;
  }

  save(reference: PrdDraftReference, fallback?: PrdDraftCommit): Promise<PrdDraftReplacement | null> {
    const draftKey = key(reference);
    const pending = this.pending.get(draftKey);
    if (pending) return pending;
    const draft = this.drafts.get(draftKey);
    if (!draft) return Promise.resolve(null);
    const operation = this.persist(draftKey, draft, this.committers.get(reference.projectId) ?? fallback)
      .finally(() => this.pending.delete(draftKey));
    this.pending.set(draftKey, operation);
    return operation;
  }

  private async persist(draftKey: string, draft: PrdDraft, commit?: PrdDraftCommit) {
    try {
      if (!commit) throw new Error("文档草稿尚未就绪，请打开原项目后保存或放弃修改。");
      const document = draft.prepared ?? prdDocumentSchema.parse({
        ...draft.document,
        revision: {
          ...draft.document.revision,
          number: Math.max(draft.document.revision.number, draft.baseline.revision.number) + 1,
          changedAt: new Date().toISOString(),
          summary: draft.document.revision.summary.trim() || "Manual PRD edit",
        },
      });
      this.drafts.set(draftKey, { ...draft, prepared: document, saving: true, error: null });
      this.changed();
      const savedArtifactVersionId = await commit(draft.reference, document);
      this.drafts.delete(draftKey);
      this.changed();
      return typeof savedArtifactVersionId === "string" ? { ...draft.reference, savedArtifactVersionId } : null;
    } catch (cause) {
      const current = this.drafts.get(draftKey) ?? draft;
      this.drafts.set(draftKey, {
        ...current,
        saving: false,
        error: cause instanceof Error ? cause.message : "PRD 保存失败，请重试",
      });
      this.changed();
      throw cause;
    }
  }

  private changed() {
    if (this.storage && this.storageKey) {
      try {
        this.storage.setItem(this.storageKey, JSON.stringify([...this.drafts.values()]));
      } catch {
        for (const [draftKey, draft] of this.drafts) {
          if (!draft.error) this.drafts.set(draftKey, { ...draft, error: "本机草稿存储不可用，请保存后再关闭页面。" });
        }
      }
    }
    for (const listener of this.listeners) listener();
  }
}

function key(reference: PrdDraftReference) {
  return JSON.stringify([reference.projectId, reference.artifactId, reference.artifactVersionId]);
}

function hasDraftShape(value: unknown, baseline: unknown): boolean {
  if (baseline === null) return value === null;
  if (Array.isArray(baseline)) return Array.isArray(value)
    && value.every((item, index) => baseline.length === 0 || hasDraftShape(item, baseline[index] ?? baseline[0]));
  if (typeof baseline !== "object") return typeof value === typeof baseline;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(baseline).every(([field, expected]) => hasDraftShape((value as Record<string, unknown>)[field], expected));
}
