import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { projectInvitationTokenSchema } from "@workbench/workbench-contracts";

const TOKEN_CONTEXT = "workbench.project-invitation.v1";

type InvitationTokenKey = Readonly<{
  id: string;
  secret: Buffer;
}>;

@Injectable()
export class ProjectInvitationTokenService {
  private readonly current: InvitationTokenKey;
  private readonly keys: ReadonlyMap<string, InvitationTokenKey>;

  constructor(config: ConfigService) {
    const current = parseSecret(
      requiredConfig(config, "WORKBENCH_INVITATION_TOKEN_SECRET"),
      "WORKBENCH_INVITATION_TOKEN_SECRET",
    );
    const previous = optionalSecrets(
      config.get<string>("WORKBENCH_INVITATION_TOKEN_PREVIOUS_SECRETS"),
    );
    const byId = new Map<string, InvitationTokenKey>();
    for (const key of [current, ...previous]) {
      if (byId.has(key.id)) {
        throw new Error("Project invitation token secrets must be distinct");
      }
      byId.set(key.id, key);
    }
    this.current = current;
    this.keys = byId;
  }

  issue(invitationId: string, keyId = this.current.id) {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Project invitation token key ${keyId} is no longer configured`);
    }
    const payload = Buffer.from(invitationId, "utf8").toString("base64url");
    if (payload.length < 48 || payload.length > 128) {
      throw new Error("Project invitation IDs must encode to 48-128 base64url characters");
    }
    const signature = sign(payload, key.secret);
    return {
      keyId: key.id,
      token: projectInvitationTokenSchema.parse(`wbi_${payload}.${signature}`),
    };
  }

  verify(token: string): { invitationId: string; keyId: string } | null {
    const parsed = projectInvitationTokenSchema.safeParse(token);
    if (!parsed.success) return null;
    const match = /^wbi_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(parsed.data);
    if (!match) return null;
    const payload = match[1]!;
    const actual = Buffer.from(match[2]!, "base64url");
    if (actual.byteLength !== 32) return null;

    let invitationId: string;
    try {
      invitationId = Buffer.from(payload, "base64url").toString("utf8");
      if (Buffer.from(invitationId, "utf8").toString("base64url") !== payload) return null;
    } catch {
      return null;
    }

    for (const key of this.keys.values()) {
      const expected = Buffer.from(sign(payload, key.secret), "base64url");
      if (timingSafeEqual(actual, expected)) return { invitationId, keyId: key.id };
    }
    return null;
  }

  hash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
}

function sign(payload: string, secret: Buffer) {
  return createHmac("sha256", secret)
    .update(`${TOKEN_CONTEXT}:${payload}`)
    .digest("base64url");
}

function parseSecret(value: string, name: string): InvitationTokenKey {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must use unpadded base64url encoding`);
  }
  const secret = Buffer.from(value, "base64url");
  if (secret.byteLength < 32) throw new Error(`${name} must decode to at least 32 bytes`);
  if (secret.toString("base64url") !== value) {
    throw new Error(`${name} must use canonical unpadded base64url encoding`);
  }
  return {
    id: createHash("sha256").update(secret).digest("hex").slice(0, 16),
    secret,
  };
}

function optionalSecrets(value?: string) {
  if (!value?.trim()) return [];
  const raw = value.split(",").map((entry) => entry.trim());
  if (raw.some((entry) => !entry)) {
    throw new Error("WORKBENCH_INVITATION_TOKEN_PREVIOUS_SECRETS contains a blank entry");
  }
  if (raw.length > 4) {
    throw new Error("WORKBENCH_INVITATION_TOKEN_PREVIOUS_SECRETS supports at most four keys");
  }
  return raw.map((entry, index) => parseSecret(
    entry,
    `WORKBENCH_INVITATION_TOKEN_PREVIOUS_SECRETS[${index}]`,
  ));
}

function requiredConfig(config: ConfigService, name: string) {
  const value = config.get<string>(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
