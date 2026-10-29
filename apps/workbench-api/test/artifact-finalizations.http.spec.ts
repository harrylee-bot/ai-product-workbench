import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { expect, it, vi } from "vitest";
import { ArtifactFinalizationsController } from "../src/modules/artifacts/artifact-finalizations.controller.js";
import { ArtifactFinalizationsService } from "../src/modules/artifacts/artifact-finalizations.service.js";
import { IdentityService } from "../src/modules/identity/identity.service.js";
import { WorkbenchAuthGuard } from "../src/modules/identity/workbench-auth.guard.js";

it("returns JSON null for an unfinalized version and a JSON object after finalization over authenticated HTTP", async () => {
  const principal = { id: "principal_http", issuer: "urn:workbench:development", subject: "finalization-http", email: null, displayName: null, defaultWorkspaceId: "workspace_http" };
  const row = { id: "finalization_http", artifactVersionId: "version_http", projectId: "project_http", confirmedById: principal.id, checksum: "a".repeat(64), status: "confirmed", confirmedAt: new Date("2026-10-29T00:00:00Z"), withdrawnAt: null, ingestionJob: null };
  const service = { get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row) };
  const identity = { resolvePrincipal: vi.fn().mockResolvedValue(principal) };
  const config = { get: vi.fn((key: string) => key === "WORKBENCH_AUTH_MODE" ? "development" : key === "NODE_ENV" ? "test" : undefined) };
  const guard = new WorkbenchAuthGuard(config as never, identity as never);
  class FinalizationHttpModule {}
  Module({ controllers: [ArtifactFinalizationsController], providers: [
    { provide: ConfigService, useValue: config }, { provide: IdentityService, useValue: identity },
    { provide: WorkbenchAuthGuard, useValue: guard }, { provide: ArtifactFinalizationsService, useValue: service },
  ] })(FinalizationHttpModule);
  const app = await NestFactory.create<NestExpressApplication>(FinalizationHttpModule, { logger: false, abortOnError: false });
  try {
    app.setGlobalPrefix("api/v1"); await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/api/v1/artifacts/artifact_http/versions/version_http/finalization`;
    const denied = await fetch(url); expect(denied.status).toBe(401); await denied.body?.cancel(); expect(service.get).not.toHaveBeenCalled();
    const headers = { "x-workbench-dev-subject": principal.subject };
    const empty = await fetch(url, { headers });
    expect(empty.status).toBe(200); expect(empty.headers.get("content-type")).toContain("application/json");
    expect(empty.headers.get("cache-control")).toBe("private, no-store");
    expect(await empty.text()).toBe("null");
    const existing = await fetch(url, { headers });
    expect(existing.status).toBe(200); expect(existing.headers.get("content-type")).toContain("application/json");
    expect(await existing.json()).toEqual({ ...row, confirmedAt: row.confirmedAt.toISOString() });
    expect(service.get).toHaveBeenNthCalledWith(1, principal.id, "artifact_http", "version_http");
    expect(service.get).toHaveBeenNthCalledWith(2, principal.id, "artifact_http", "version_http");
  } finally { await app.close(); }
});
