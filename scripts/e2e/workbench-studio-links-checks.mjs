import assert from "node:assert/strict";

export async function runStudioLinkChecks({
  page,
  origin,
  projectId,
  output,
  results,
  artifacts,
  versions,
  files,
  createVersion,
  addLink,
  artifactLinks,
  linkWrites,
  writeKeys,
  controls,
  counts,
}) {
  const fixed = (artifactId, version) => ({
    artifactId,
    artifactVersionId: `${artifactId}-v${version}`,
  });
  const base = fixed("image-1", 1);
  const copy = fixed("image-2", 1);
  const go = async ({ artifactId, artifactVersionId }) => {
    const query = new URLSearchParams({
      view: "documents",
      artifact: artifactId,
      artifactVersion: artifactVersionId,
    });
    await page.goto(`${origin}/studio/${projectId}?${query}`, {
      waitUntil: "networkidle",
    });
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const section = page.getByRole("region", { name: "固定版本产物关联" });
  const link = (endpoint) =>
    section.locator(`a[href*="artifactVersion=${endpoint.artifactVersionId}"]`);
  controls.setRole("owner");
  controls.allowUpload();
  controls.loseCreation();
  await go(base);
  await button("编辑图片").click();
  await page.getByLabel("图片名称", { exact: true }).fill("来源固定的副本");
  const before = counts();
  await button("另存为新图片").click();
  await page.getByRole("alert").filter({ hasText: "Response lost" }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await button("编辑图片").click();
  await button("确认上次图片保存").click();
  await page.getByRole("link", { name: "查看已保存图片", exact: true }).click();
  await section.getByText("派生产物 · 图片另存", { exact: true }).waitFor();
  assert.deepEqual(writeKeys.at(-2), writeKeys.at(-1));
  assert.deepEqual(writeKeys.at(-1).body.derivedFrom, base);
  assert.equal(counts().uploadCount, before.uploadCount + 1);
  assert.equal(counts().artifactWrites, before.artifactWrites + 1);
  assert.equal(artifactLinks.length, 1);
  assert.deepEqual(
    versions.get(copy.artifactVersionId).bytes,
    versions.get(base.artifactVersionId).bytes,
  );
  await link(base).click();
  await page.waitForURL(
    new RegExp(`artifactVersion=${base.artifactVersionId}`),
  );
  await link(copy).waitFor();
  results.checks.push(
    "historical image save-as recovers the same body and key after reload, keeps one copy and fixed bidirectional lineage",
  );

  const sourceArtifact = artifacts[0];
  // Put an older target version and an artifact beyond the initial 30-item windows.
  for (let i = 3; i <= 33; i++) {
    createVersion(sourceArtifact, files.get("file-1"), i);
    const artifact = {
      ...sourceArtifact,
      id: `candidate-${i}`,
      title: `备选产物 ${i}`,
    };
    createVersion(artifact, files.get("file-1"), 1);
    artifacts.push(artifact);
  }
  const candidate = fixed("candidate-33", 1);
  await go(copy);
  await button("添加产物关联").click();
  await button("加载更多可选产物").click();
  await page
    .getByLabel("关联产物", { exact: true })
    .selectOption(candidate.artifactId);
  await page
    .getByLabel("关联固定版本", { exact: true })
    .selectOption(candidate.artifactVersionId);
  await page
    .getByLabel("关联产物", { exact: true })
    .selectOption(base.artifactId);
  await button("加载更多可选版本").click();
  await page
    .getByLabel("关联固定版本", { exact: true })
    .selectOption(base.artifactVersionId);
  await page.getByLabel("关联方向").selectOption("incoming");
  await page.getByLabel("关联类型").selectOption("reference");
  await page.getByLabel("关联说明（选填）").fill("从固定原图引用");
  controls.loseLink();
  await button("保存产物关联").click();
  await section
    .getByRole("alert")
    .filter({ hasText: "Link response lost" })
    .waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await button("确认上次关联操作").click();
  const manual = section
    .getByRole("listitem")
    .filter({ hasText: "从固定原图引用" });
  await manual.waitFor();
  assert.deepEqual(linkWrites[0], linkWrites[1]);
  assert.deepEqual(linkWrites[0].body, {
    source: base,
    target: copy,
    kind: "reference",
    label: "从固定原图引用",
  });
  assert.equal(artifactLinks.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await button("专注预览").click();
  await section.scrollIntoViewIfNeeded();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: new URL("artifact-links-mobile.png", output).pathname,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  results.checks.push(
    "artifact and version selectors paginate, incoming manual link holds its old source despite 32 later versions, and same-key retry survives reload",
  );

  controls.loseRemoval();
  await manual.getByRole("button", { name: "移除关联" }).click();
  await section
    .getByRole("alert")
    .filter({ hasText: "Remove response lost" })
    .waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await button("确认上次关联操作").click();
  await section.getByText("此关联已移除，两个产物及其版本仍然保留。").waitFor();
  assert.equal(await manual.count(), 0);
  await section.getByLabel("显示已移除关联").check();
  await manual.getByText(/已移除/).waitFor();
  assert.equal(
    artifactLinks.find((item) => item.label === "从固定原图引用").revision,
    1,
  );
  results.checks.push(
    "lost removal response replays the original revision, active list excludes removed link, and history retains both fixed endpoints",
  );

  for (let i = 0; i < 33; i++)
    addLink({
      source: base,
      target: copy,
      kind: "related",
      label: `分页记录 ${i}`,
    });
  controls.setRole("viewer");
  await go(copy);
  await section.getByText("相关产物 · 分页记录 32", { exact: true }).waitFor();
  assert.equal(await section.getByRole("listitem").count(), 30);
  controls.failLinkPage();
  await button("加载更多产物关联").click();
  // React Query may retry a transient page request automatically.
  await section
    .getByText("相关产物 · 分页记录 0", { exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(await section.getByRole("listitem").count(), 34);
  assert.equal(await button("添加产物关联").count(), 0);
  assert.equal(
    await section.getByRole("button", { name: "移除关联" }).count(),
    0,
  );
  results.checks.push(
    "viewer reads all paged links after a transient page error without create or remove controls",
  );
}
