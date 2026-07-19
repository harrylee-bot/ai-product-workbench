import dns from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { RetryableImportError, TerminalImportError } from "../errors.js";

export type SafeHttpResponse = {
  url: string;
  status: number;
  mediaType: string | null;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
};

type SafeHttpOptions = {
  maximumBytes: number;
  timeoutMs: number;
  maximumRedirects: number;
  allowedHosts?: readonly string[];
  allowedMediaTypes?: readonly RegExp[];
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
};

type Lookup = (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
type RequestTransport = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type RequestTransportResolver = (protocol: "http:" | "https:") => RequestTransport;

const defaultLookup: Lookup = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

const defaultTransport: RequestTransportResolver = (protocol) => protocol === "https:" ? httpsRequest : httpRequest;

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

export class SafeHttpClient {
  constructor(
    private readonly lookup: Lookup = defaultLookup,
    private readonly transport: RequestTransportResolver = defaultTransport,
  ) {}

  async get(url: string, options: SafeHttpOptions): Promise<SafeHttpResponse> {
    let current = validateUrl(url);
    for (let redirect = 0; ; redirect += 1) {
      const response = await this.getOnce(current, options);
      if (response.status >= 300 && response.status < 400) {
        if (redirect >= options.maximumRedirects) throw new TerminalImportError("IMPORT_REDIRECT_LIMIT", "The source URL exceeded the redirect limit");
        const location = response.headers.location;
        if (!location) throw new TerminalImportError("IMPORT_REDIRECT_LOCATION_MISSING", "The source redirected without a location");
        const next = validateUrl(new URL(location, current).toString());
        if (current.protocol === "https:" && next.protocol !== "https:") throw new TerminalImportError("IMPORT_HTTPS_DOWNGRADE", "A secure source redirected to an insecure URL");
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.status === 403) throw new TerminalImportError("IMPORT_REMOTE_AUTH_REQUIRED", "The remote source requires authentication");
        if (response.status === 404) throw new TerminalImportError("IMPORT_REMOTE_NOT_FOUND", "The remote source was not found");
        if (response.status >= 500) throw new RetryableImportError("IMPORT_REMOTE_SERVER_ERROR", "The remote source returned a temporary error");
        throw new TerminalImportError("IMPORT_REMOTE_HTTP_ERROR", `The remote source returned HTTP ${response.status}`);
      }
      return response;
    }
  }

  private async getOnce(url: URL, options: SafeHttpOptions): Promise<SafeHttpResponse> {
    const hostname = networkHostname(url.hostname);
    if (options.allowedHosts && !options.allowedHosts.some((host) => host.toLowerCase() === hostname.toLowerCase())) {
      throw new TerminalImportError("IMPORT_HOST_NOT_ALLOWED", "The remote source host is not allowed for this provider");
    }
    const addresses = await this.lookup(hostname).catch((error) => {
      throw new RetryableImportError("IMPORT_DNS_FAILED", "The source hostname could not be resolved", { cause: error });
    });
    const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address));
    if (publicAddresses.length === 0) throw new TerminalImportError("IMPORT_PRIVATE_ADDRESS", "The source resolves to a private or reserved network address");
    const pinned = publicAddresses[0]!;
    const requestImpl = this.transport(url.protocol as "http:" | "https:");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = requestImpl({
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/html,application/json,application/octet-stream;q=0.8,*/*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "ProductWorkbenchImport/1.0",
          ...options.headers,
        },
        timeout: options.timeoutMs,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        servername: hostname,
      }, (response) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[key.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
        }
        const mediaType = parseMediaType(headers["content-type"] ?? null);
        const contentLength = headers["content-length"] ? Number(headers["content-length"]) : null;
        if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > options.maximumBytes)) {
          response.resume();
          fail(new TerminalImportError("IMPORT_SIZE_LIMIT", "The remote source is larger than the import limit"));
          return;
        }
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && options.allowedMediaTypes && (!mediaType || !options.allowedMediaTypes.some((pattern) => pattern.test(mediaType)))) {
          response.resume();
          fail(new TerminalImportError("IMPORT_MEDIA_TYPE_UNSUPPORTED", "The remote source media type is not supported"));
          return;
        }
        readLimited(response, options.maximumBytes, options.signal).then((body) => {
          if (settled) return;
          settled = true;
          resolve({ url: url.toString(), status: response.statusCode ?? 0, mediaType, headers, body });
        }).catch(fail);
      });
      req.once("timeout", () => req.destroy(new RetryableImportError("IMPORT_REMOTE_TIMEOUT", "The remote source timed out")));
      req.once("error", fail);
      const abort = () => req.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("IMPORT_ABORTED"));
      options.signal?.addEventListener("abort", abort, { once: true });
      req.once("close", () => options.signal?.removeEventListener("abort", abort));
      req.end();
    });
  }
}

export function validateUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TerminalImportError("IMPORT_URL_INVALID", "The source URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TerminalImportError("IMPORT_URL_INVALID", "Import sources must use HTTP(S) without credentials or fragments");
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new TerminalImportError("IMPORT_PORT_NOT_ALLOWED", "Import sources may use only HTTP or HTTPS ports");
  return url;
}

function networkHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  return !nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function parseMediaType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

async function readLimited(stream: Readable, maximumBytes: number, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of stream) {
      if (signal?.aborted) throw signal.reason;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) throw new TerminalImportError("IMPORT_SIZE_LIMIT", "The remote source is larger than the import limit");
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
}
