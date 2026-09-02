import { createGatewayServer } from "./gateway.mjs";

const host = process.env.GRIST_GATEWAY_HOST?.trim() || "127.0.0.1";
const port = integerEnv("GRIST_GATEWAY_PORT", 8484);
const server = createGatewayServer({
  gristUpstream: process.env.GRIST_UPSTREAM?.trim() || "http://127.0.0.1:8485",
  workbenchOrigin: process.env.WORKBENCH_ORIGIN?.trim() || "http://localhost:3000",
  gristPublicOrigin: process.env.GRIST_PUBLIC_ORIGIN?.trim() || "http://localhost:8484",
  ssoSecret: process.env.WORKBENCH_GRIST_SSO_SECRET?.trim() || undefined,
  defaultLocale: process.env.GRIST_DEFAULT_USER_LOCALE?.trim() || undefined,
});

server.listen(port, host, () => {
  console.log(`Grist auth gateway listening at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}
