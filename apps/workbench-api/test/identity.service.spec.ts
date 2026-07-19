import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { IdentityService } from "../src/modules/identity/identity.service.js";

const principal = {
  id: "principal-1",
  issuer: "https://identity.example.test",
  subject: "subject-1",
  email: "owner@example.test",
  displayName: "Owner",
  status: "active" as const,
};

describe("IdentityService", () => {
  it("resolves an active Principal without changing an existing Workspace membership", async () => {
    const tx = {
      principal: { upsert: vi.fn().mockResolvedValue(principal) },
      workspaceMember: {
        findFirst: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }),
        upsert: vi.fn(),
      },
      workspace: { upsert: vi.fn() },
    };
    const service = identityService(tx);

    await expect(service.resolvePrincipal({
      issuer: principal.issuer,
      subject: principal.subject,
      email: principal.email,
      displayName: principal.displayName,
    })).resolves.toEqual({
      id: principal.id,
      issuer: principal.issuer,
      subject: principal.subject,
      email: principal.email,
      displayName: principal.displayName,
      defaultWorkspaceId: "workspace-1",
    });
    expect(tx.workspace.upsert).not.toHaveBeenCalled();
    expect(tx.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it("rejects a disabled Principal before reading or provisioning Workspace access", async () => {
    const tx = {
      principal: {
        upsert: vi.fn().mockResolvedValue({ ...principal, status: "disabled" as const }),
      },
      workspaceMember: { findFirst: vi.fn(), upsert: vi.fn() },
      workspace: { upsert: vi.fn() },
    };
    const service = identityService(tx);

    await expect(service.resolvePrincipal({
      issuer: principal.issuer,
      subject: principal.subject,
      email: principal.email,
      displayName: principal.displayName,
    })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.workspaceMember.findFirst).not.toHaveBeenCalled();
    expect(tx.workspace.upsert).not.toHaveBeenCalled();
    expect(tx.workspaceMember.upsert).not.toHaveBeenCalled();
  });
});

function identityService(tx: object) {
  return new IdentityService({
    $transaction: vi.fn(async (operation: (client: object) => unknown) => operation(tx)),
  } as never);
}
