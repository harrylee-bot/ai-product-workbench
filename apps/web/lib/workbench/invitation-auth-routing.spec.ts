import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "../../proxy";

describe("产品工作台邀请认证路由", () => {
  it("lets the invitation shell preserve a URL fragment before client-side login", () => {
    const response = proxy(new NextRequest("https://workbench.example.test/invitations/accept"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps Project routes protected by the server-side session gate", () => {
    const response = proxy(new NextRequest("https://workbench.example.test/projects/project-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location"))
      .toBe("https://workbench.example.test/login?next=%2Fprojects%2Fproject-1");
  });
});
