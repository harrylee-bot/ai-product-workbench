import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";

import { createWorkbenchLocalTls } from "./workbench-local-tls.mjs";

test("local TLS uses a scoped CA, preserves streaming, sanitizes proxy headers, and removes private material", async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "x-observed-host": request.headers.host,
      "x-observed-proto": request.headers["x-forwarded-proto"],
      "x-observed-ip": request.headers["x-workbench-client-ip"],
      "x-observed-edge-auth": request.headers["x-workbench-edge-auth"] ?? "absent" });
    response.write("event: first\ndata: 1\n\n");
    setTimeout(() => response.end("event: last\ndata: 2\n\n"), 25);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const local = await createWorkbenchLocalTls();
  const directory = path.dirname(local.caPath);
  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "server.key"))).mode & 0o777, 0o600);
    const certificate = new X509Certificate(await readFile(path.join(directory, "server.crt")));
    for (const ip of ["127.0.0.1", "127.0.0.2", "::1"]) assert.equal(certificate.checkIP(ip), ip);
    assert.equal(certificate.checkHost("localhost"), "localhost");
    assert.match(local.spkiPin, /^[A-Za-z0-9+/]{43}=$/u);
    assert.equal(local.evidence.globalTlsVerificationDisabled, false);
    const origin = `https://127.0.0.1:${port}`;
    await local.proxy({ port, upstreamPort: upstream.address().port, publicOrigin: origin });
    const response = await fetch(origin, { headers: { "x-forwarded-proto": "http", "x-forwarded-host": "attacker.test",
      "x-workbench-client-ip": "attacker", "x-workbench-edge-auth": "untrusted" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-observed-host"), `127.0.0.1:${port}`);
    assert.equal(response.headers.get("x-observed-proto"), "https");
    assert.equal(response.headers.get("x-observed-ip"), "127.0.0.1");
    assert.equal(response.headers.get("x-observed-edge-auth"), "absent");
    assert.match(await response.text(), /event: first[\s\S]*event: last/u);
    // An explicitly empty trust store must still reject this certificate.
    await assert.rejects(new Promise((resolve, reject) => {
      https.get(origin, { ca: [] }, resolve).once("error", reject);
    }), /certificate|issuer|self.signed/iu);
    const source = await readFile(new URL("../workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");
    assert.match(source, /"next", "build"/u);
    assert.match(source, /"next", "start"/u);
    assert.doesNotMatch(source, /"next", "dev"|ignoreHTTPSErrors|NODE_TLS_REJECT_UNAUTHORIZED/u);
  } finally {
    await local.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
  await assert.rejects(access(directory), { code: "ENOENT" });
});
