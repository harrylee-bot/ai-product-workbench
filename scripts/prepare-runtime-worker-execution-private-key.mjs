#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;
const KEY_ID = /^sha256:[a-f0-9]{64}$/u;

export async function prepareRuntimeWorkerExecutionPrivateKey({
  privateKeyPath,
  uid,
  gid,
  expectedKeyId,
} = {}) {
  const resolvedPath = absolutePath(privateKeyPath);
  const ownerUid = numericId(uid);
  const ownerGid = numericId(gid);
  const trustedKeyId = exactKeyId(expectedKeyId);
  const before = await lstat(resolvedPath).catch(() => null);
  if (
    !before?.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > MAXIMUM_PRIVATE_KEY_BYTES
  ) throw invalidPrivateKey();

  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) throw invalidPrivateKey();
    const keyBytes = await readExact(handle, opened.size);
    if (keyId(keyBytes) !== trustedKeyId) throw invalidPrivateKey();
    await handle.chown(ownerUid, ownerGid);
    await handle.chmod(0o400);
    const prepared = await handle.stat();
    const preparedKeyBytes = await readExact(handle, prepared.size);
    if (
      prepared.uid !== ownerUid
      || prepared.gid !== ownerGid
      || (prepared.mode & 0o777) !== 0o400
      || prepared.dev !== opened.dev
      || prepared.ino !== opened.ino
      || !preparedKeyBytes.equals(keyBytes)
      || keyId(preparedKeyBytes) !== trustedKeyId
    ) throw invalidPrivateKey();
  } catch {
    throw invalidPrivateKey();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return Object.freeze({ path: resolvedPath, uid: ownerUid, gid: ownerGid, mode: "0400" });
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--private-key", "privateKeyPath"],
    ["--uid", "uid"],
    ["--gid", "gid"],
    ["--expected-key-id", "expectedKeyId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const key = names.get(name);
    if (!key || Object.prototype.hasOwnProperty.call(options, key)) throw invalidPrivateKey();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw invalidPrivateKey();
    options[key] = value;
    index += 1;
  }
  if (Object.keys(options).length !== names.size) throw invalidPrivateKey();
  return options;
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4_096) {
    throw invalidPrivateKey();
  }
  return value;
}

function numericId(value) {
  const source = typeof value === "number" ? String(value) : value;
  if (typeof source !== "string" || !/^[1-9][0-9]{0,9}$/u.test(source)) throw invalidPrivateKey();
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > 4_294_967_294) throw invalidPrivateKey();
  return parsed;
}

function exactKeyId(value) {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw invalidPrivateKey();
  return value;
}

async function readExact(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead < 1) throw invalidPrivateKey();
    offset += result.bytesRead;
  }
  return bytes;
}

function keyId(bytes) {
  try {
    const privateKey = createPrivateKey(bytes);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      throw invalidPrivateKey();
    }
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(publicKey).digest("hex")}`;
  } catch {
    throw invalidPrivateKey();
  }
}

function invalidPrivateKey() {
  return new Error("RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_INVALID");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await prepareRuntimeWorkerExecutionPrivateKey(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("runtime worker execution private key: RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_INVALID\n");
    process.exitCode = 1;
  }
}
