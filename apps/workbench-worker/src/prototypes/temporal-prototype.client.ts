export type TemporalPrototypeClientOptions = { startUrl?: string; cancelUrl?: string; fetchImpl?: typeof fetch };

export class TemporalPrototypeClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: TemporalPrototypeClientOptions = {}) { this.fetchImpl = options.fetchImpl ?? fetch; }
  get configured(): boolean { return Boolean(this.options.startUrl && this.options.cancelUrl); }
  async startGeneration(input: { projectId: string; planId: string; principalId: string }): Promise<void> { await this.post(this.options.startUrl, { workflow: "visualPrototypeGeneration", ...input }); }
  async cancelGeneration(input: { projectId: string; planId: string }): Promise<void> { await this.post(this.options.cancelUrl, { workflow: "visualPrototypeGeneration", ...input }); }
  async startExport(input: { projectId: string; exportId: string; revisionId: string; format: "html" | "react" }): Promise<void> { await this.post(this.options.startUrl, { workflow: "visualPrototypeExport", ...input }); }
  async cancelExport(input: { projectId: string; exportId: string }): Promise<void> { await this.post(this.options.cancelUrl, { workflow: "visualPrototypeExport", ...input }); }
  private async post(url: string | undefined, body: unknown): Promise<void> { if (!url) throw new Error("TEMPORAL_WORKFLOW_UNAVAILABLE"); const response = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`TEMPORAL_WORKFLOW_HTTP_${response.status}`); }
}
