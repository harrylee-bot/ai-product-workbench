#!/usr/bin/env node

/**
 * Canonical JSON for current operational receipts and recovery plans.
 * Object keys are sorted recursively; arrays preserve their order.
 */
export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

export function canonicalJsonFile(value) {
  return `${canonicalJson(value)}\n`;
}

function normalizeCanonical(value, location = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeCanonical(entry, `${location}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${location} is not a JSON object`);
  }
  const output = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (value[key] === undefined) throw new TypeError(`${location}.${key} is undefined`);
    output[key] = normalizeCanonical(value[key], `${location}.${key}`);
  }
  return output;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
