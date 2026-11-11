import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";

export async function createWorkbenchLocalTls() {
  const directory = await mkdtemp(path.join(tmpdir(), "workbench-e2e-tls-"));
  await chmod(directory, 0o700);
  const caPath = path.join(directory, "ca.crt");
  const keyPath = path.join(directory, "server.key");
  const certificatePath = path.join(directory, "server.crt");
  const openssl = (args) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  let previousCa;
  try {
    await writeFile(path.join(directory, "ca.cnf"), `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Workbench isolated E2E CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`, { mode: 0o600 });
    await writeFile(path.join(directory, "server.cnf"), `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=localhost\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2,IP:::1\n`, { mode: 0o600 });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256", "-config", "ca.cnf", "-keyout", "ca.key", "-out", "ca.crt"]);
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", "server.cnf", "-keyout", "server.key", "-out", "server.csr"]);
    openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-sha256", "-extfile", "server.cnf", "-extensions", "server", "-out", "server.crt"]);
    await chmod(keyPath, 0o600);
    await chmod(path.join(directory, "ca.key"), 0o600);
    const [key, cert, ca] = await Promise.all([readFile(keyPath), readFile(certificatePath), readFile(caPath, "utf8")]);
    const publicKey = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
    const spkiPin = createHash("sha256").update(publicKey).digest("base64");
    // The parent process also polls HTTPS readiness. Child processes trust only
    // this additional CA through NODE_EXTRA_CA_CERTS; no system trust is changed.
    if (typeof tls.setDefaultCACertificates !== "function") throw new Error("Local TLS evidence requires Node with setDefaultCACertificates");
    previousCa = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...previousCa, ca]);
    const proxies = [];
    return {
      caPath, spkiPin,
      evidence: { mode: "ephemeral-local-ca", browserTrust: "certificate-spki-pin", nodeTrust: "additional-local-ca",
        globalTlsVerificationDisabled: false, certificateSha256: createHash("sha256").update(cert).digest("hex") },
      async proxy({ port, upstreamPort, publicOrigin, listenHost = "127.0.0.1" }) {
        const authority = new URL(publicOrigin).host;
        const sockets = new Set();
        const server = https.createServer({ key, cert }, (request, response) => {
          const headers = { ...request.headers, host: authority,
            "x-forwarded-host": authority, "x-forwarded-proto": "https",
            "x-forwarded-for": "127.0.0.1", "x-workbench-client-ip": "127.0.0.1" };
          delete headers["x-workbench-edge-client-ip"];
          delete headers["x-workbench-edge-auth"];
          const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, method: request.method,
            path: request.url, headers }, (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          });
          upstream.on("error", () => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
          });
          request.on("aborted", () => upstream.destroy());
          response.on("close", () => upstream.destroy());
          request.pipe(upstream);
        });
        server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, listenHost, resolve); });
        const close = async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise((resolve) => server.close(resolve));
        };
        proxies.push(close);
        return { close };
      },
      async close() {
        await Promise.all(proxies.map((close) => close()));
        tls.setDefaultCACertificates(previousCa);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousCa) tls.setDefaultCACertificates(previousCa);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
