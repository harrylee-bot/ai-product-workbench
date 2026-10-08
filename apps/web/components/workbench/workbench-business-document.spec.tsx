// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchBusinessDocument } from "./workbench-business-document";
afterEach(cleanup);

describe("business document preview", () => {
  it("renders Markdown headings, lists, tables and links as readable document structure", () => {
    render(<WorkbenchBusinessDocument content={{ markdown: "# 预约需求\n\n1. 选择门店\n2. 确认预约\n\n| 渠道 | 开启 |\n| --- | --- |\n| H5 | 是 |\n\n[来源](https://example.com/source)" }} />);
    expect(screen.getByRole("heading", { name: "预约需求" })).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getByRole("link", { name: "来源" }).getAttribute("href")).toBe("https://example.com/source");
  });
  it("disables raw HTML, unsafe links and automatic remote image fetching", () => {
    const rendered = render(<WorkbenchBusinessDocument content={{ markdown: "<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![业务图](https://example.com/private.png)" }} />);
    expect(rendered.container.querySelector("script")).toBeNull();
    expect(rendered.container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "危险" })).toBeNull();
    expect(screen.getByRole("link", { name: "业务图" }).getAttribute("href")).toBe("https://example.com/private.png");
  });
});
