import { describe, expect, it } from "vitest";
import {
  projectInvitationAcceptPath,
  projectInvitationAcceptUrl,
  projectInvitationTokenFromHash,
  projectInvitationTokenScope,
} from "./project-invitation-link";

const token = `wbi_${Buffer.from("00000000-0000-4000-8000-000000000000").toString("base64url")}.${"a".repeat(43)}`;

describe("Project invitation links", () => {
  it("builds a same-product acceptance URL without accepting arbitrary origins", () => {
    expect(projectInvitationAcceptPath(token)).toBe(`/invitations/accept#token=${token}`);
    expect(projectInvitationAcceptUrl(token, "https://workbench.example.com"))
      .toBe(`https://workbench.example.com/invitations/accept#token=${token}`);
    expect(() => projectInvitationAcceptUrl(token, "https://user@example.com"))
      .toThrow("Invitation link origin must be an HTTP(S) origin");
  });

  it("reads only a contract-valid token from a URL fragment", () => {
    expect(projectInvitationTokenFromHash(`#token=${token}`)).toBe(token);
    expect(projectInvitationTokenFromHash("#token=invalid")).toBeNull();
    expect(projectInvitationTokenFromHash("#other=value")).toBeNull();
  });

  it("scopes client cache by the non-secret invitation payload", () => {
    expect(projectInvitationTokenScope(token)).toBe(token.slice(4, token.indexOf(".")));
    expect(projectInvitationTokenScope(token)).not.toContain("a".repeat(43));
  });
});
