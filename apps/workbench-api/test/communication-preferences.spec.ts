import type { Response } from "express";
import { Prisma } from "@workbench/workbench-db";
import { CommunicationPreferencesService } from "../src/modules/identity/communication-preferences.service.js";
import { IdentityController } from "../src/modules/identity/identity.controller.js";

const now = new Date("2026-07-14T08:30:00.000Z");
const savedPreferences = {
  principalId: "principal_1",
  productUpdatesEmail: true,
  researchInvitations: false,
  revision: 1,
  createdAt: now,
  updatedAt: now,
};

describe("CommunicationPreferencesService", () => {
  it("returns a virtual revision-zero opt-out state without creating a row", async () => {
    const db = {
      principalCommunicationPreference: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const service = new CommunicationPreferencesService(db as never);

    await expect(service.get("principal_1")).resolves.toEqual({
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
    expect(db.principalCommunicationPreference.findUnique).toHaveBeenCalledWith({
      where: { principalId: "principal_1" },
    });
  });

  it("creates revision one only when the virtual revision zero still matches", async () => {
    const tx = {
      principalCommunicationPreference: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue(savedPreferences),
        findUniqueOrThrow: vi.fn(),
      },
    };
    const db = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new CommunicationPreferencesService(db as never);

    await expect(service.update("principal_1", 0, {
      productUpdatesEmail: true,
      researchInvitations: false,
    })).resolves.toEqual({
      productUpdatesEmail: true,
      researchInvitations: false,
      revision: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(tx.principalCommunicationPreference.create).toHaveBeenCalledWith({
      data: {
        principalId: "principal_1",
        productUpdatesEmail: true,
        researchInvitations: false,
        revision: 1,
      },
    });
  });

  it("updates only the matching principal revision with compare-and-swap", async () => {
    const updated = { ...savedPreferences, revision: 4, researchInvitations: true };
    const tx = {
      principalCommunicationPreference: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
        create: vi.fn(),
      },
    };
    const db = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new CommunicationPreferencesService(db as never);

    await expect(service.update("principal_1", 3, {
      productUpdatesEmail: true,
      researchInvitations: true,
    })).resolves.toMatchObject({ revision: 4, researchInvitations: true });
    expect(tx.principalCommunicationPreference.updateMany).toHaveBeenCalledWith({
      where: { principalId: "principal_1", revision: 3 },
      data: {
        productUpdatesEmail: true,
        researchInvitations: true,
        revision: { increment: 1 },
      },
    });
    expect(tx.principalCommunicationPreference.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { principalId: "principal_1" },
    });
    expect(tx.principalCommunicationPreference.create).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and concurrent zero-to-create races", async () => {
    const staleTx = {
      principalCommunicationPreference: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(),
      },
    };
    const staleDb = {
      $transaction: vi.fn((callback: (client: typeof staleTx) => unknown) => callback(staleTx)),
    };
    await expect(new CommunicationPreferencesService(staleDb as never).update(
      "principal_1",
      2,
      { productUpdatesEmail: false, researchInvitations: false },
    )).rejects.toMatchObject({ status: 412 });
    expect(staleTx.principalCommunicationPreference.create).not.toHaveBeenCalled();

    const raceDb = {
      $transaction: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "test" },
      )),
    };
    await expect(new CommunicationPreferencesService(raceDb as never).update(
      "principal_1",
      0,
      { productUpdatesEmail: true, researchInvitations: true },
    )).rejects.toMatchObject({ status: 412 });
  });
});

describe("IdentityController communication preferences", () => {
  it("sets the default and updated revision ETags for the authenticated principal", async () => {
    const preferences = {
      get: vi.fn().mockResolvedValue({
        productUpdatesEmail: false,
        researchInvitations: false,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      }),
      update: vi.fn().mockResolvedValue({
        productUpdatesEmail: true,
        researchInvitations: false,
        revision: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    };
    const controller = new IdentityController(preferences as never);
    const getResponse = { setHeader: vi.fn() };
    const putResponse = { setHeader: vi.fn() };

    await expect(controller.getPreferences(
      { id: "principal_current" } as never,
      getResponse as unknown as Response,
    )).resolves.toMatchObject({ revision: 0 });
    expect(preferences.get).toHaveBeenCalledWith("principal_current");
    expect(getResponse.setHeader).toHaveBeenCalledWith("ETag", '"0"');

    await expect(controller.updatePreferences(
      { id: "principal_current" } as never,
      '"0"',
      { productUpdatesEmail: true, researchInvitations: false },
      putResponse as unknown as Response,
    )).resolves.toMatchObject({ revision: 1 });
    expect(preferences.update).toHaveBeenCalledWith(
      "principal_current",
      0,
      { productUpdatesEmail: true, researchInvitations: false },
    );
    expect(putResponse.setHeader).toHaveBeenCalledWith("ETag", '"1"');
  });

  it("requires a strong If-Match validator before writing", async () => {
    const preferences = { update: vi.fn() };
    const controller = new IdentityController(preferences as never);

    await expect(controller.updatePreferences(
      { id: "principal_current" } as never,
      undefined,
      { productUpdatesEmail: false, researchInvitations: false },
      { setHeader: vi.fn() } as unknown as Response,
    )).rejects.toMatchObject({ status: 428 });
    expect(preferences.update).not.toHaveBeenCalled();
  });
});
