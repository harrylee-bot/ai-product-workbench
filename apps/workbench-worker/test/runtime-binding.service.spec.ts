import { runtimeBindingTransportOwnerId } from "../src/runtime/runtime-binding.service.js";

describe("Runtime binding transport owner", () => {
  it("reads the stable provider owner from binding metadata", () => {
    expect(runtimeBindingTransportOwnerId({
      metadata: { workbenchPrincipalId: "principal-thread-owner" },
    })).toBe("principal-thread-owner");
  });

  it.each([
    null,
    [],
    {},
    { workbenchPrincipalId: "" },
    { workbenchPrincipalId: " principal-1" },
    { workbenchPrincipalId: "principal/1" },
    { workbenchPrincipalId: 1 },
  ])("rejects invalid binding metadata %#", (metadata) => {
    expect(() => runtimeBindingTransportOwnerId({ metadata }))
      .toThrow("RUNTIME_BINDING_TRANSPORT_OWNER_INVALID");
  });
});
