import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SafeHttpClient, isPublicAddress, validateUrl } from "../src/fetch/safe-http-client.js";

const publicAddress = "93.184.216.34";

describe("SafeHttpClient", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1%lo0",
    "ff02::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", publicAddress, "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "accepts globally routable address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("blocks SSRF before opening a connection, including IPv4-mapped IPv6", async () => {
    const transport = vi.fn();
    const client = new SafeHttpClient(
      async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
      transport as never,
    );

    await expect(client.get("http://metadata.test/latest", options())).rejects.toMatchObject({
      code: "IMPORT_PRIVATE_ADDRESS",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes bracketed IPv6 URL literals before DNS and SSRF checks", async () => {
    const lookup = vi.fn(async (hostname: string) => [{ address: hostname, family: 6 as const }]);
    const transport = vi.fn();
    const client = new SafeHttpClient(lookup, transport as never);

    await expect(client.get("http://[::ffff:127.0.0.1]/latest", options()))
      .rejects.toMatchObject({ code: "IMPORT_PRIVATE_ADDRESS" });
    expect(lookup).toHaveBeenCalledWith("::ffff:7f00:1");
    expect(transport).not.toHaveBeenCalled();
  });

  it("pins the selected DNS address and resolves every redirect hop again", async () => {
    const lookup = vi.fn(async (hostname: string) => [{
      address: hostname === "first.test" ? publicAddress : "93.184.216.35",
      family: 4 as const,
    }]);
    const captured: HttpsRequestOptions[] = [];
    const client = new SafeHttpClient(lookup, fixtureTransport((request) => request.path === "/start"
      ? { status: 302, headers: { location: "http://second.test/final" } }
      : { headers: { "content-type": "text/plain; charset=utf-8" }, body: "frozen" }, captured));

    await expect(client.get("http://first.test/start", options())).resolves.toMatchObject({
      url: "http://second.test/final",
      status: 200,
      mediaType: "text/plain",
      body: Buffer.from("frozen"),
    });

    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual(["first.test", "second.test"]);
    expect(await pinnedAddress(captured[0]!)).toEqual({ address: publicAddress, family: 4 });
    expect(await pinnedAddress(captured[1]!)).toEqual({ address: "93.184.216.35", family: 4 });
  });

  it("rechecks host allowlists and private addresses after redirects", async () => {
    const lookup = vi.fn(async (hostname: string) => [{
      address: hostname === "private.test" ? "127.0.0.1" : publicAddress,
      family: 4 as const,
    }]);
    const client = new SafeHttpClient(lookup, fixtureTransport(() => ({
      status: 302,
      headers: { location: "http://private.test/secret" },
    })));

    await expect(client.get("http://public.test/start", options())).rejects.toMatchObject({
      code: "IMPORT_PRIVATE_ADDRESS",
    });
    await expect(client.get("http://public.test/start", {
      ...options(),
      allowedHosts: ["public.test"],
    })).rejects.toMatchObject({ code: "IMPORT_HOST_NOT_ALLOWED" });
  });

  it("rejects redirect overflow, missing locations, and HTTPS downgrade", async () => {
    const client = new SafeHttpClient(async () => [{ address: publicAddress, family: 4 }], fixtureTransport((request) => ({
      status: 302,
      headers: request.path === "/missing"
        ? {}
        : { location: request.path === "/downgrade" ? "http://public.test/final" : "/again" },
    })));

    await expect(client.get("http://public.test/start", { ...options(), maximumRedirects: 0 }))
      .rejects.toMatchObject({ code: "IMPORT_REDIRECT_LIMIT" });
    await expect(client.get("http://public.test/missing", options()))
      .rejects.toMatchObject({ code: "IMPORT_REDIRECT_LOCATION_MISSING" });
    await expect(client.get("https://public.test/downgrade", options()))
      .rejects.toMatchObject({ code: "IMPORT_HTTPS_DOWNGRADE" });
  });

  it("enforces declared and streamed byte limits", async () => {
    const client = new SafeHttpClient(async () => [{ address: publicAddress, family: 4 }], fixtureTransport((request) => request.path === "/declared"
      ? { headers: { "content-type": "text/plain", "content-length": "100" }, body: "x" }
      : { headers: { "content-type": "text/plain" }, chunks: ["ab", "cd"] }));

    await expect(client.get("http://public.test/declared", { ...options(), maximumBytes: 3 }))
      .rejects.toMatchObject({ code: "IMPORT_SIZE_LIMIT" });
    await expect(client.get("http://public.test/streamed", { ...options(), maximumBytes: 3 }))
      .rejects.toMatchObject({ code: "IMPORT_SIZE_LIMIT" });
  });

  it("fails closed for missing or unsupported media types", async () => {
    const client = new SafeHttpClient(async () => [{ address: publicAddress, family: 4 }], fixtureTransport((request) => ({
      headers: request.path === "/binary" ? { "content-type": "application/octet-stream" } : {},
      body: "content",
    })));
    const restricted = { ...options(), allowedMediaTypes: [/^text\/plain$/u] };

    await expect(client.get("http://public.test/missing", restricted))
      .rejects.toMatchObject({ code: "IMPORT_MEDIA_TYPE_UNSUPPORTED" });
    await expect(client.get("http://public.test/binary", restricted))
      .rejects.toMatchObject({ code: "IMPORT_MEDIA_TYPE_UNSUPPORTED" });
  });

  it("classifies authentication and temporary upstream failures", async () => {
    const client = new SafeHttpClient(async () => [{ address: publicAddress, family: 4 }], fixtureTransport((request) => ({
      status: request.path === "/auth" ? 403 : 503,
    })));

    await expect(client.get("http://public.test/auth", options()))
      .rejects.toMatchObject({ code: "IMPORT_REMOTE_AUTH_REQUIRED" });
    await expect(client.get("http://public.test/temporary", options()))
      .rejects.toMatchObject({ code: "IMPORT_REMOTE_SERVER_ERROR" });
  });

  it("rejects malformed, credentialed, fragmented, and nonstandard-port URLs", () => {
    for (const value of [
      "not-a-url",
      "ftp://example.test/file",
      "https://user:secret@example.test/file",
      "https://example.test/file#fragment",
    ]) {
      expect(() => validateUrl(value)).toThrow("IMPORT_URL_INVALID");
    }
    expect(() => validateUrl("https://example.test:8443/file")).toThrow("IMPORT_PORT_NOT_ALLOWED");
  });
});

function options() {
  return {
    maximumBytes: 1_024,
    timeoutMs: 1_000,
    maximumRedirects: 3,
  };
}

type ResponseFixture = {
  status?: number;
  headers?: Record<string, string | undefined>;
  body?: string | Buffer;
  chunks?: Array<string | Buffer>;
};

function fixtureTransport(
  fixture: (options: HttpsRequestOptions) => ResponseFixture,
  captured: HttpsRequestOptions[] = [],
) {
  return (_protocol: "http:" | "https:") => (
    options: HttpsRequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    captured.push(options);
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      const result = fixture(options);
      const chunks = result.chunks ?? [result.body ?? Buffer.alloc(0)];
      const response = Readable.from(chunks) as IncomingMessage;
      response.statusCode = result.status ?? 200;
      response.headers = result.headers ?? {};
      callback(response);
    }) as ClientRequest["end"];
    request.destroy = ((error?: Error) => {
      if (error) request.emit("error", error);
      request.emit("close");
      return request;
    }) as ClientRequest["destroy"];
    return request;
  };
}

async function pinnedAddress(options: HttpsRequestOptions) {
  return new Promise<{ address: string; family: number }>((resolve, reject) => {
    const lookup = options.lookup;
    if (!lookup) return reject(new Error("missing pinned lookup"));
    (lookup as Function)("ignored.test", {}, (error: Error | null, address: string, family: number) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}
