const safeAuditPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export function readKnowledgeProfileOperatorOptions(
  env = process.env,
  argv = process.argv.slice(2),
) {
  const flags = parseFlags(argv);
  return {
    action: action(flags.action ?? env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_ACTION),
    issuer: requiredText(
      flags.issuer ?? env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_ISSUER,
      "issuer",
      512,
    ),
    subject: requiredText(
      flags.subject ?? env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_SUBJECT,
      "subject",
      512,
    ),
    authorizedBy: auditText(
      flags.authorizedBy ?? env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_AUTHORIZED_BY,
      "authorized-by",
    ),
    changeReference: auditText(
      flags.changeReference ?? env.WORKBENCH_KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE,
      "change-reference",
    ),
  };
}

export async function applyKnowledgeProfileOperatorEvent({ db, options, lockPrincipal }) {
  return db.$transaction(async (tx) => {
    const principal = await tx.principal.findUnique({
      where: { issuer_subject: { issuer: options.issuer, subject: options.subject } },
      select: { id: true, issuer: true, subject: true },
    });
    if (!principal) throw new Error("KNOWLEDGE_PROFILE_OPERATOR_PRINCIPAL_NOT_FOUND");
    await lockPrincipal(tx, principal.id);

    const replay = await tx.knowledgeProfileOperatorEvent.findUnique({
      where: { changeReference: options.changeReference },
    });
    if (replay) {
      if (
        replay.principalId !== principal.id
        || replay.action !== options.action
        || replay.authorizedBy !== options.authorizedBy
      ) {
        throw new Error("KNOWLEDGE_PROFILE_OPERATOR_CHANGE_REFERENCE_CONFLICT");
      }
      return { principal, event: replay, created: false };
    }

    const latest = await tx.knowledgeProfileOperatorEvent.findFirst({
      where: { principalId: principal.id },
      orderBy: { id: "desc" },
      select: { action: true },
    });
    if (options.action === "revoke" && latest?.action !== "grant") {
      throw new Error("KNOWLEDGE_PROFILE_OPERATOR_NOT_GRANTED");
    }

    const event = await tx.knowledgeProfileOperatorEvent.create({
      data: {
        principalId: principal.id,
        action: options.action,
        authorizedBy: options.authorizedBy,
        changeReference: options.changeReference,
      },
    });
    return { principal, event, created: true };
  });
}

function parseFlags(argv) {
  const flags = {};
  for (const argument of argv) {
    const match = /^(?:--)(action|issuer|subject|authorized-by|change-reference)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    const field = match[1] === "authorized-by"
      ? "authorizedBy"
      : match[1] === "change-reference"
        ? "changeReference"
        : match[1];
    if (Object.hasOwn(flags, field)) throw new Error(`Duplicate argument: --${match[1]}`);
    flags[field] = match[2];
  }
  return flags;
}

function action(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized !== "grant" && normalized !== "revoke") {
    throw new Error("Knowledge Profile operator action must be grant or revoke");
  }
  return normalized;
}

function requiredText(value, label, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid Knowledge Profile operator ${label}`);
  }
  return normalized;
}

function auditText(value, label) {
  const normalized = requiredText(value, label, 200);
  if (normalized.length < 3 || !safeAuditPattern.test(normalized)) {
    throw new Error(`Invalid Knowledge Profile operator ${label}`);
  }
  return normalized;
}
