import { createHash } from "node:crypto";
import {
  canonicalJson,
  type RuntimeProgressEvent,
} from "@workbench/workbench-contracts";
import { PrototypePatchService } from "../src/runs/prototype-patch.service.js";

type PatchEvent = Extract<RuntimeProgressEvent, { type: "artifact.prototype.patch" }>;

function patchEvent(resultingChecksum = "a".repeat(64)): PatchEvent {
  return {
    type: "artifact.prototype.patch",
    sourceEventId: "source-terminal-replay",
    patch: {
      protocol: "workbench.runtime.prototype-patch.v1",
      artifactIndex: 0,
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: [{ kind: "remove_state", stateId: "state-obsolete" }],
      resultingChecksum,
    },
  };
}

function requestSha256(event: PatchEvent) {
  return createHash("sha256").update(canonicalJson({
    sourceEventId: event.sourceEventId,
    patch: event.patch,
  })).digest("hex");
}

function replayHarness(event: PatchEvent) {
  const receipt = {
    id: "patch-application-1",
    runId: "run-1",
    outcome: "applied",
    requestSha256: requestSha256(event),
    runEventId: "run-event-1",
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ status: "failed" }]),
    prototypePatchApplication: {
      findUnique: vi.fn().mockResolvedValue(receipt),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    receipt,
    service: new PrototypePatchService(db as never),
    tx,
  };
}

describe("PrototypePatchService terminal receipt replay", () => {
  it("returns the immutable receipt after the Run becomes terminal", async () => {
    const event = patchEvent();
    const { receipt, service, tx } = replayHarness(event);

    await expect(service.persistPatch("run-1", "attempt-1", event)).resolves.toEqual({
      created: false,
      ...receipt,
    });

    expect(tx.prototypePatchApplication.findUnique).toHaveBeenCalledWith({
      where: {
        runtimeAttemptId_sourceEventId: {
          runtimeAttemptId: "attempt-1",
          sourceEventId: event.sourceEventId,
        },
      },
      select: {
        id: true,
        runId: true,
        outcome: true,
        requestSha256: true,
        runEventId: true,
      },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects the same source key with a different request hash", async () => {
    const original = patchEvent();
    const { service, tx } = replayHarness(original);

    await expect(service.persistPatch(
      "run-1",
      "attempt-1",
      patchEvent("b".repeat(64)),
    )).rejects.toThrow("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects replaying an exact attempt/source receipt under another Run", async () => {
    const event = patchEvent();
    const { service, tx } = replayHarness(event);

    await expect(service.persistPatch("run-2", "attempt-1", event))
      .rejects.toThrow("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns the winner receipt after a concurrent first delivery", async () => {
    const event = patchEvent();
    const { receipt, service, tx } = replayHarness(event);
    tx.prototypePatchApplication.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt);
    tx.$queryRaw.mockResolvedValueOnce([{ locked: null }]);

    await expect(service.persistPatch("run-1", "attempt-1", event)).resolves.toEqual({
      created: false,
      ...receipt,
    });

    expect(tx.prototypePatchApplication.findUnique).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
