import assert from "node:assert/strict";
import test from "node:test";
import {
  applyKnowledgeProfileOperatorEvent,
  readKnowledgeProfileOperatorOptions,
} from "./workbench-knowledge-profile-operator-lib.mjs";

test("requires an explicit audited operator action", () => {
  assert.deepEqual(readKnowledgeProfileOperatorOptions({}, [
    "--action=grant",
    "--issuer=https://identity.example.com",
    "--subject=operator-1",
    "--authorized-by=security.lead",
    "--change-reference=CHG-2026-0715",
  ]), {
    action: "grant",
    issuer: "https://identity.example.com",
    subject: "operator-1",
    authorizedBy: "security.lead",
    changeReference: "CHG-2026-0715",
  });
  assert.throws(() => readKnowledgeProfileOperatorOptions({}, [
    "--action=grant",
    "--issuer=https://identity.example.com",
    "--subject=operator-1",
    "--authorized-by=security lead",
    "--change-reference=CHG-2026-0715",
  ]), /authorized-by/u);
});

test("grants an existing OIDC principal and replays the same change idempotently", async () => {
  const principal = { id: "principal_1", issuer: "issuer", subject: "subject" };
  const event = {
    id: 1n,
    principalId: principal.id,
    action: "grant",
    authorizedBy: "security.lead",
    changeReference: "CHG-1",
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  };
  const tx = {
    principal: { findUnique: async () => principal },
    knowledgeProfileOperatorEvent: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => event,
    },
  };
  const db = { $transaction: (callback) => callback(tx) };
  const lockPrincipal = async () => undefined;
  const options = {
    action: "grant",
    issuer: principal.issuer,
    subject: principal.subject,
    authorizedBy: event.authorizedBy,
    changeReference: event.changeReference,
  };

  assert.deepEqual(
    await applyKnowledgeProfileOperatorEvent({ db, options, lockPrincipal }),
    { principal, event, created: true },
  );
  tx.knowledgeProfileOperatorEvent.findUnique = async () => event;
  assert.deepEqual(
    await applyKnowledgeProfileOperatorEvent({ db, options, lockPrincipal }),
    { principal, event, created: false },
  );
});

test("refuses a revoke before any grant and rejects reused change references", async () => {
  const principal = { id: "principal_1", issuer: "issuer", subject: "subject" };
  const tx = {
    principal: { findUnique: async () => principal },
    knowledgeProfileOperatorEvent: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => assert.fail("must not create"),
    },
  };
  const db = { $transaction: (callback) => callback(tx) };
  const base = {
    action: "revoke",
    issuer: "issuer",
    subject: "subject",
    authorizedBy: "security.lead",
    changeReference: "CHG-2",
  };
  await assert.rejects(
    applyKnowledgeProfileOperatorEvent({ db, options: base, lockPrincipal: async () => undefined }),
    /NOT_GRANTED/u,
  );

  tx.knowledgeProfileOperatorEvent.findUnique = async () => ({
    principalId: "different",
    action: "grant",
    authorizedBy: "security.lead",
  });
  await assert.rejects(
    applyKnowledgeProfileOperatorEvent({
      db,
      options: { ...base, action: "grant" },
      lockPrincipal: async () => undefined,
    }),
    /CHANGE_REFERENCE_CONFLICT/u,
  );
});
