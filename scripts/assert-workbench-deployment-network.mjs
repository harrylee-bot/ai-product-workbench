#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const root = new URL("../", import.meta.url);
const base = readYaml("deploy/workbench-compose.yml");
const validation = readYaml("deploy/workbench-server-validation-compose.yml");
const ingressName = "workbench-ingress";

assert(base.networks?.["workbench-internal"]?.internal === true, "workbench-internal must stay internal");
assert(base.networks?.[ingressName], `${ingressName} must be declared`);
assert(base.networks[ingressName].driver === "bridge", `${ingressName} must use the bridge driver`);
assert(base.networks[ingressName].internal === false, `${ingressName} must allow host ingress`);
assert(
  base.networks[ingressName].driver_opts?.["com.docker.network.bridge.enable_ip_masquerade"] === "false",
  `${ingressName} must not grant general Internet egress through IP masquerading`,
);

assertPublishedServicesUseIngress(base.services, "deploy/workbench-compose.yml");
assertPublishedServicesUseIngress(validation.services, "deploy/workbench-server-validation-compose.yml");

for (const serviceName of ["gateway", "preview-gateway", "object-storage"]) {
  assertUsesIngress(base.services?.[serviceName], serviceName);
}
assertUsesIngress(validation.services?.oidc, "oidc");
assertOnlyExpectedServicesUseIngress(base.services, ["gateway", "preview-gateway", "object-storage"]);
assertOnlyExpectedServicesUseIngress(validation.services, ["oidc"]);
assertExactNetworks(
  base.services?.["workbench-import-worker"],
  "workbench-import-worker",
  ["workbench-internal", "workbench-egress"],
);

console.log("Workbench deployment network contract passed.");

function assertPublishedServicesUseIngress(services = {}, source) {
  for (const [serviceName, service] of Object.entries(services)) {
    if ((service?.ports?.length ?? 0) > 0) {
      assertUsesIngress(service, `${serviceName} in ${source}`);
      for (const port of service.ports) {
        assert(isLoopbackBinding(port), `${serviceName} in ${source} must bind published ports to 127.0.0.1`);
      }
    }
  }
}

function assertUsesIngress(service, label) {
  const networks = Array.isArray(service?.networks)
    ? service.networks
    : Object.keys(service?.networks ?? {});
  assert(networks.includes(ingressName), `${label} publishes a host port and must use ${ingressName}`);
  assert(networks.includes("workbench-internal"), `${label} must keep its internal service network`);
}

function assertOnlyExpectedServicesUseIngress(services = {}, expectedNames) {
  const actualNames = Object.entries(services)
    .filter(([, service]) => serviceNetworks(service).includes(ingressName))
    .map(([name]) => name)
    .sort();
  assert(
    JSON.stringify(actualNames) === JSON.stringify([...expectedNames].sort()),
    `only ${expectedNames.join(", ")} may use ${ingressName}; found ${actualNames.join(", ")}`,
  );
}

function assertExactNetworks(service, label, expectedNetworks) {
  const actualNetworks = serviceNetworks(service).sort();
  const expected = [...expectedNetworks].sort();
  assert(
    JSON.stringify(actualNetworks) === JSON.stringify(expected),
    `${label} must use exactly ${expected.join(", ")}; found ${actualNetworks.join(", ")}`,
  );
}

function serviceNetworks(service) {
  return Array.isArray(service?.networks)
    ? service.networks
    : Object.keys(service?.networks ?? {});
}

function isLoopbackBinding(port) {
  if (typeof port === "string") {
    return port.startsWith("127.0.0.1:") || port.includes(":-127.0.0.1}");
  }
  return port?.host_ip === "127.0.0.1";
}

function readYaml(path) {
  return YAML.parse(readFileSync(new URL(path, root), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
