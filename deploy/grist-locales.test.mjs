import assert from "node:assert/strict";
import test from "node:test";

import {
  deepMerge,
  findMissingLeaves,
  validateLocale,
} from "./grist-locales.mjs";

test("deepMerge preserves the upstream locale and applies nested overrides", () => {
  const base = {Menu: {Open: "打开", Close: "关闭"}};
  const result = deepMerge(base, {Menu: {Open: "开启", Save: "保存"}});

  assert.deepEqual(result, {
    Menu: {Open: "开启", Close: "关闭", Save: "保存"},
  });
  assert.equal(base.Menu.Open, "打开");
});

test("findMissingLeaves reports absent and empty translations", () => {
  const source = {Menu: {Open: "Open", Close: "Close", Save: "Save"}};
  const locale = {Menu: {Open: "打开", Close: ""}};

  assert.deepEqual(findMissingLeaves(source, locale), [
    ["Menu", "Close"],
    ["Menu", "Save"],
  ]);
});

test("validateLocale rejects changed interpolation and Markdown targets", () => {
  const source = {
    Menu: {Help: "Open [help]({{helpUrl}}) for {{name}}"},
  };
  const overrides = {
    Menu: {Help: "打开[帮助]({{otherUrl}})，了解 {{name}}"},
  };

  assert.throws(
    () => validateLocale(source, overrides, overrides),
    /Protected tokens changed/,
  );
});

test("validateLocale accepts a complete translation with intact tokens", () => {
  const source = {
    Menu: {Help: "Open [help]({{helpUrl}}) for {{name}}"},
  };
  const overrides = {
    Menu: {Help: "打开[帮助]({{helpUrl}})，了解 {{name}}"},
  };

  assert.doesNotThrow(() => validateLocale(source, overrides, overrides));
});

