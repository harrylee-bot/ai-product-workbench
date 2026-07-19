import type { IncomingHttpHeaders } from "node:http";

export function hasAmbientCredentials(headers: IncomingHttpHeaders) {
  return headers.cookie !== undefined
    || headers.authorization !== undefined
    || headers["proxy-authorization"] !== undefined;
}
