import type { Prisma, PrismaClient } from "@workbench/workbench-db";
import type { RuntimeExecutionClaim } from "../src/runtime/runtime-attempt.service.js";
import type {
  RuntimeArtifactTarget,
  RuntimeDesignAsset,
  RuntimeProgressEvent,
  RuntimeSource,
} from "../src/runtime/runtime.port.js";

type PersistenceContext = {
  entryId: string;
  sources: RuntimeSource[];
  designAssets: RuntimeDesignAsset[];
  artifactTargets: RuntimeArtifactTarget[];
};

type PersistenceInternals = {
  db: PrismaClient;
  assertActiveClaimTx(tx: Prisma.TransactionClient, claim: RuntimeExecutionClaim): Promise<unknown>;
  persistRuntimeEffectsTx(
    tx: Prisma.TransactionClient,
    claim: RuntimeExecutionClaim,
    context: PersistenceContext,
    initialText: string,
    effects: RuntimeProgressEvent[],
  ): Promise<string>;
};

// Exercise the current effect dispatcher and claim fence without setting up
// a provider transport for transaction-level unit and PostgreSQL tests.
async function persistEffect(
  processor: object,
  claim: RuntimeExecutionClaim,
  context: PersistenceContext,
  initialText: string,
  event: RuntimeProgressEvent,
) {
  const internals = processor as PersistenceInternals;
  await internals.db.$transaction(async (tx) => {
    await internals.assertActiveClaimTx(tx, claim);
    await internals.persistRuntimeEffectsTx(tx, claim, context, initialText, [event]);
  });
}

export async function persistDelta(
  processor: object,
  claim: RuntimeExecutionClaim,
  entryId: string,
  fullText: string,
  delta: string,
) {
  await persistEffect(
    processor,
    claim,
    { entryId, sources: [], designAssets: [], artifactTargets: [] },
    fullText.slice(0, fullText.length - delta.length),
    { type: "text.delta", delta },
  );
}

export async function persistArtifactDraft(
  processor: object,
  claim: RuntimeExecutionClaim,
  event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
  sources: RuntimeSource[],
  designAssets: RuntimeDesignAsset[],
  artifactTargets: RuntimeArtifactTarget[] = [],
) {
  await persistEffect(
    processor,
    claim,
    { entryId: "", sources, designAssets, artifactTargets },
    "",
    event,
  );
}
