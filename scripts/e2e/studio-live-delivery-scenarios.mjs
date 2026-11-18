import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { tsImport } from "tsx/esm/api";
import { unzipSync } from "fflate";
import { PrismaClient } from "@workbench/workbench-db";
import { canonicalJson } from "@workbench/workbench-contracts";
import { prdDocumentV3Example as prd } from "@workbench/workbench-contracts/test-fixtures";
import { buildFrozenPrototypeHtml } from "@workbench/workbench-build-worker";
import { renderPrototypeDocumentPages } from "@workbench/workbench-export-core";
import { PrototypeArtifactStorage } from "../../apps/workbench-worker/dist/prototypes/prototype-artifact-storage.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checksum = (value) => digest(canonicalJson(value));

async function seedFrozen({
  db,
  projectId,
  principalId,
  chromiumPath,
  s3,
  bucket,
}) {
  const { interactivePrototypeFixture } = await tsImport(
    "../../packages/workbench-export-core/test/fixtures.ts",
    import.meta.url,
  );
  const prototype = interactivePrototypeFixture();
  const pages = renderPrototypeDocumentPages(prototype);
  const revisionId = randomUUID();
  const built = await buildFrozenPrototypeHtml(
    revisionId,
    prototype.title,
    pages,
    { sourceDocument: prototype, chromiumExecutablePath: chromiumPath },
  );
  const storage = new PrototypeArtifactStorage({
    bucket,
    prefix: "studio-live",
    client: s3,
  });
  const frozen = await storage.putImmutable(
    {
      key: projectId + "/" + revisionId + "/preview.html",
      mediaType: "text/html; charset=utf-8",
      byteSize: built.byteSize,
      sha256: built.htmlSha256,
    },
    Buffer.from(built.html),
  );
  return db.$transaction(async (tx) => {
    async function version(kind, document, schemaVersion, sourcePrdVersionId) {
      const artifact = await tx.artifact.create({
        data: { projectId, kind, title: document.title },
      });
      const version = await tx.artifactVersion.create({
        data: {
          projectId,
          artifactId: artifact.id,
          version: 1,
          schemaVersion,
          status: "ready",
          content: document,
          checksum: checksum(document),
          citations: [],
          sourcePrdVersionId,
        },
      });
      await tx.artifact.update({
        where: { id: artifact.id },
        data: { currentVersionId: version.id },
      });
      return {
        artifactId: artifact.id,
        artifactVersionId: version.id,
        checksum: version.checksum,
      };
    }
    const sourcePrd = await version("prd", prd, 3);
    const sourcePrototype = await version(
      "prototype",
      prototype,
      1,
      sourcePrd.artifactVersionId,
    );
    const plan = await tx.prototypePlan.create({
      data: {
        projectId,
        createdById: principalId,
        title: prototype.title,
        prompt: "Fixed artifact delivery fixture",
        idempotencyKey: randomUUID(),
        requestHash: checksum(prototype),
      },
    });
    const revision = await tx.prototypeRevision.create({
      data: {
        id: revisionId,
        projectId,
        planId: plan.id,
        createdById: principalId,
        title: prototype.title,
        status: "ready",
        pages,
        sourceDocument: prototype,
        documentSha256: checksum(pages),
        idempotencyKey: randomUUID(),
        requestHash: checksum(prototype),
        builtArtifactKey: frozen.key,
        builtArtifactSha256: frozen.sha256,
        builtArtifactMediaType: frozen.mediaType,
        builtArtifactByteSize: frozen.byteSize,
      },
      select: { sourceDocument: true },
    });
    const sourceDocumentSha256 = checksum(revision.sourceDocument);
    assert.equal(sourceDocumentSha256, sourcePrototype.checksum);
    return {
      sourcePrd,
      sourcePrototype,
      revisionId,
      sourceDocumentSha256,
      previewSha256: frozen.sha256,
    };
  });
}

// Poppler can extract correct Unicode from a PDF whose visible glyphs are all
// missing-font rectangles. Check the rendered strokes inside the CJK cover title.
async function inspectCover(pdf, image) {
  const bbox = execFileSync(
    process.env.WORKBENCH_STUDIO_LIVE_PDFTOTEXT_BIN || "pdftotext",
    ["-f", "1", "-l", "1", "-bbox", pdf, "-"],
    { encoding: "utf8" },
  );
  const words = [
    ...bbox.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
    ),
  ];
  assert.ok(words.length, "The PDF cover contains no extractable title");
  const line = words.filter((word) => word[2] === words[0][2]);
  assert.equal(line.map((word) => word[5]).join(""), prd.title);
  const { data, info } = await sharp(image)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const densities = [];
  for (const [, xMin, yMin, xMax, yMax, word] of line) {
    const glyphs = [...word].length;
    const advance = (xMax - xMin) / glyphs;
    const height = yMax - yMin;
    for (let glyph = 0; glyph < glyphs; glyph++) {
      let samples = 0,
        ink = 0;
      for (
        let y = Math.ceil(+yMin + 0.3 * height);
        y < +yMin + 0.75 * height;
        y++
      ) {
        for (
          let x = Math.ceil(+xMin + (glyph + 0.25) * advance);
          x < +xMin + (glyph + 0.75) * advance;
          x++
        ) {
          samples++;
          if (data[y * info.width + x] < 160) ink++;
        }
      }
      densities.push(Math.round((100 * ink) / samples));
    }
  }
  const sorted = [...densities].sort((a, b) => a - b);
  assert.ok(
    sorted[Math.floor(sorted.length / 2)] > 12 &&
      sorted.at(-1) - sorted[0] >= 6,
    "Chinese title did not render with distinct interior strokes. Check the renderer's CJK fonts.",
  );
  return densities;
}

async function interact(page) {
  const field = page.locator('[data-wb-node="input-email"]');
  await field.fill("frozen@example.test");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-wb-node="text-mirror"]')?.textContent ===
      "frozen@example.test",
  );
  await page.locator('[data-wb-node="input-plan"]').selectOption("basic");
  await page.locator('[data-wb-node="input-terms"]').check();
  await page.locator('[data-wb-node="button-submit"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-wb-node="text-state"]')?.textContent ===
      "Submitted",
  );
  await page.locator('[data-wb-node="button-navigate"]').click();
  await page
    .locator('[data-wb-screen="screen-success"]')
    .waitFor({ state: "visible" });
}

async function openStandalone(directory, entry, browser, screenshot) {
  const server = http.createServer(async (req, res) => {
    try {
      const filename = path.resolve(
        directory,
        "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
      );
      assert.ok(filename.startsWith(directory + path.sep));
      const mime =
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          path.extname(filename)
        ] || "application/octet-stream";
      const content = await readFile(filename);
      res.writeHead(200, { "content-type": mime }).end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const page = await browser.newPage();
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/" + entry);
    await interact(page);
    await page.screenshot({ path: screenshot });
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runStudioDeliveryFixture({
  page,
  browser,
  webOrigin,
  previewOrigin,
  outDir,
  runId,
  dbUrl,
  waitUntil,
  evidence,
  step,
  s3,
  bucket,
  chromiumPath,
  runCmd,
}) {
  const db = new PrismaClient({ datasourceUrl: dbUrl });
  assert.match(new URL(dbUrl).pathname, /_test_/);
  const result = {
    scope:
      "Repository contract and interaction fixtures in a dedicated project. No generation or model calls.",
    files: {},
  };
  const save = () =>
    writeFile(
      path.join(outDir, "artifact-results.json"),
      JSON.stringify(result, null, 2),
    );
  const api = (method, endpoint, body, etag) =>
    page.evaluate(
      async ({ method, endpoint, body, etag, key }) => {
        const r = await fetch("/api/v1" + endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            ...(etag && { "If-Match": etag }),
          },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok)
          throw new Error("HTTP " + r.status + " " + (data.code ?? ""));
        return data;
      },
      { method, endpoint, body, etag, key: randomUUID() },
    );
  async function download(endpoint, filename, sha256, size) {
    const event = page.waitForEvent("download");
    await page.evaluate((url) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      a.click();
    }, "/api/v1" + endpoint);
    const target = path.join(outDir, filename);
    await (await event).saveAs(target);
    const bytes = await readFile(target);
    assert.equal(bytes.length, Number(size));
    assert.equal(digest(bytes), sha256);
    result.files[filename] = { sha256, byteSize: bytes.length };
    await save();
    return bytes;
  }
  try {
    await page.goto(webOrigin + "/register");
    await waitUntil(
      async () => (await page.locator("#username").count()) === 1,
      "Registration form",
    );
    await page.locator("#username").fill("export_" + runId);
    await page.locator("#email").fill("export_" + runId + "@example.test");
    await page
      .locator("#password")
      .fill(randomBytes(24).toString("hex") + "!1Aa");
    await page.getByRole("button", { name: "创建工作台", exact: true }).click();
    await page.waitForURL(webOrigin + "/");
    await page
      .getByRole("textbox", { name: "新项目名称" })
      .fill("冻结产物导出验收 " + runId);
    await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
    await page.waitForURL(/\/studio\//);
    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    const projectBase = "/projects/" + projectId;
    const identity = await api("GET", "/identity/me");
    step(
      "Freeze repository source fixtures with the production builder and record exact version hashes",
    );
    const source = await seedFrozen({
      db,
      projectId,
      principalId: identity.id,
      chromiumPath,
      s3,
      bucket,
    });
    result.source = {
      ...source,
      projectId,
      fixtureCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
      }).trim(),
      prdFixture:
        "packages/workbench-contracts/src/prd-example.ts#prdDocumentV3Example",
      prototypeFixture:
        "packages/workbench-export-core/test/fixtures.ts#interactivePrototypeFixture",
    };
    const boot = await api("GET", projectBase + "/bootstrap");
    const release = await api(
      "POST",
      projectBase + "/releases",
      { boardId: boot.board.id, boardRevision: boot.board.revision },
      '"' + boot.board.revision + '"',
    );
    for (const item of [source.sourcePrd, source.sourcePrototype])
      assert.ok(
        release.artifactPins.some(
          (pin) =>
            pin.artifactVersionId === item.artifactVersionId &&
            pin.checksum === item.checksum,
        ),
      );
    result.source.releaseId = release.id;
    await save();
    step("Download DOCX and PDF from their frozen project release");
    async function releaseExport(format, selection) {
      const job = await api("POST", projectBase + "/exports", {
        releaseId: release.id,
        format,
        packaging: "single_file",
        selection: {
          kind: "artifact",
          artifactId: selection.artifactId,
          artifactVersionId: selection.artifactVersionId,
        },
      });
      return waitUntil(
        async () => {
          const row = await api("GET", "/exports/" + job.id);
          if (row.status === "failed")
            throw Object.assign(
              new Error("Export " + format + " " + row.failure?.code),
              { fatal: true },
            );
          return row.status === "succeeded" ? row : false;
        },
        "Export " + format,
        120000,
      );
    }
    for (const format of ["docx", "pdf"]) {
      const job = await releaseExport(format, source.sourcePrd);
      const bytes = await download(
        "/exports/" + job.id + "/content",
        "document." + format,
        job.output.sha256,
        job.output.byteSize,
      );
      if (format === "docx")
        assert.ok(
          Buffer.from(unzipSync(bytes)["word/document.xml"])
            .toString()
            .includes(prd.title),
        );
      else assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    }
    const renderDir = path.join(outDir, "render");
    await mkdir(renderDir, { recursive: true });
    execFileSync(
      process.env.WORKBENCH_STUDIO_LIVE_OFFICE_BIN || "soffice",
      [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        renderDir,
        path.join(outDir, "document.docx"),
      ],
      { timeout: 120000 },
    );
    for (const [format, pdf] of [
      ["docx", path.join(renderDir, "document.pdf")],
      ["pdf", path.join(outDir, "document.pdf")],
    ]) {
      const info = execFileSync(
        process.env.WORKBENCH_STUDIO_LIVE_PDFINFO_BIN || "pdfinfo",
        [pdf],
        { encoding: "utf8" },
      );
      const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      assert.ok(pages > 0);
      execFileSync(
        process.env.WORKBENCH_STUDIO_LIVE_PDFTOPPM_BIN || "pdftoppm",
        ["-r", "72", "-png", pdf, path.join(renderDir, format)],
        { timeout: 120000 },
      );
      const file = result.files["document." + format];
      file.pages = pages;
      const firstPage =
        format + "-" + "1".padStart(String(pages).length, "0") + ".png";
      file.coverGlyphInkPercent = await inspectCover(
        pdf,
        path.join(renderDir, firstPage),
      );
    }
    await save();
    step(
      "Open the release through the real Preview service and download the V2 revision through Temporal exports",
    );
    const htmlJob = await releaseExport("html", source.sourcePrototype);
    const preview = await api(
      "POST",
      "/exports/" + htmlJob.id + "/preview-token",
    );
    assert.equal(new URL(preview.url).origin, previewOrigin);
    const previewPage = await browser.newPage();
    try {
      const response = await previewPage.goto(preview.url).catch(() => {
        throw new Error("Could not open the signed release preview");
      });
      assert.equal(response.status(), 200);
      await interact(previewPage);
      result.releasePreview = true;
    } finally {
      await previewPage.close();
    }
    const base = projectBase + "/prototype-v2";
    const frozenToken = await api(
      "POST",
      base + "/revisions/" + source.revisionId + "/preview-token",
    );
    const frozenPage = await browser.newPage();
    try {
      const response = await frozenPage.goto(frozenToken.url).catch(() => {
        throw new Error("Could not open the signed frozen preview");
      });
      assert.equal(response.status(), 200);
      assert.equal(digest(await response.body()), source.previewSha256);
      await interact(frozenPage);
      result.frozenPreview = true;
    } finally {
      await frozenPage.close();
    }
    for (const format of ["html", "react"]) {
      const request = await api("POST", base + "/exports", {
        revisionId: source.revisionId,
        format,
      });
      const row = await waitUntil(
        async () => {
          const job = await api("GET", base + "/exports/" + request.id);
          if (job.status === "failed")
            throw Object.assign(
              new Error("Prototype export " + format + " " + job.failure?.code),
              { fatal: true },
            );
          return job.status === "succeeded" ? job : false;
        },
        "Prototype " + format,
        180000,
      );
      if (format === "html")
        assert.equal(row.artifact.artifactSha256, source.previewSha256);
      await download(
        base + "/exports/" + row.id + "/download",
        format === "html" ? "prototype.html" : "react.zip",
        row.artifact.artifactSha256,
        row.artifact.byteSize,
      );
    }
    await openStandalone(
      outDir,
      "prototype.html",
      browser,
      path.join(outDir, "html-navigation.png"),
    );
    step(
      "Install and build only the downloaded React sources in an empty directory and exercise the resulting pages",
    );
    const temp = await mkdtemp(path.join(tmpdir(), "studio-delivery-react-"));
    try {
      const files = unzipSync(await readFile(path.join(outDir, "react.zip")));
      assert.ok(files["package.json"] && files["src/main.jsx"]);
      for (const [name, bytes] of Object.entries(files)) {
        if (name.startsWith("dist/")) continue;
        const target = path.resolve(temp, name);
        assert.ok(target.startsWith(temp + path.sep));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const env = {
        PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
        NPM_CONFIG_USERCONFIG: "/dev/null",
        NPM_CONFIG_CACHE: path.join(temp, ".npm-cache"),
      };
      const npm = process.env.WORKBENCH_STUDIO_LIVE_NPM_CLI;
      await runCmd(
        "standalone-install",
        [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"],
        temp,
        env,
      );
      await runCmd(
        "standalone-build",
        [npm, "run", "build", "--", "--base=./"],
        temp,
        env,
      );
      await openStandalone(
        path.join(temp, "dist"),
        "index.html",
        browser,
        path.join(outDir, "react-navigation.png"),
      );
      result.reactIndependentSourceBuild = true;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    assert.equal(await db.run.count({ where: { projectId } }), 0);
    await save();
    evidence.checks.fixedArtifactDelivery = result;
  } finally {
    await db.$disconnect();
  }
}
