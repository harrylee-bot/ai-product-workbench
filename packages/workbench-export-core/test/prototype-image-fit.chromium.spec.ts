import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { chromium, type Browser } from "playwright-core";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { PrototypeImageNode } from "@workbench/workbench-contracts";
import { renderPrototypeDocumentHtml } from "../src/html-renderer.js";
import { prototypeDocumentReactOutput } from "../src/react-export.js";
import { prototypeFixture } from "./fixtures.js";

const executablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();
const cases = [] as { format: "html" | "react"; fit: "cover" | "contain" | "none"; shape: "wide" | "tall" }[];
for (const format of ["html", "react"] as const)
  for (const fit of ["cover", "contain", "none"] as const)
    for (const shape of ["wide", "tall"] as const) cases.push({ format, fit, shape });
describe.runIf(existsSync(executablePath))(
  "Image fit through actual HTML and compiled React runtimes",
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: false,
        args: ["--no-sandbox", "--disable-background-networking"],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it.each(cases)(
      "$format preserves $fit for a $shape image through state and viewport changes",
      async ({ format, fit, shape }) => {
        const width = shape === "wide" ? 200 : 50,
          height = shape === "wide" ? 50 : 200;
        const bytes = await sharp({ create: { width, height, channels: 4, background: "#ff0000" } })
          .png()
          .toBuffer();
        const document = prototypeFixture(),
          root = document.nodes.find((node) => node.id === "root-home")!;
        if (root.kind !== "frame") throw Error("ROOT_FRAME_REQUIRED");
        const { kind: _kind, childIds: _children, clipContent: _clip, ...base } = structuredClone(root);
        const asset = {
          id: "fit-image",
          kind: "image" as const,
          name: "Ratio fixture",
          blobId: "fit-blob",
          mediaType: "image/png" as const,
          byteSize: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          width,
          height,
        };
        const image: PrototypeImageNode = {
          ...base,
          id: "image-fit",
          parentId: root.id,
          name: "Image fit",
          kind: "image",
          assetId: asset.id,
          fit,
          alt: "Ratio test",
          layout: {
            ...base.layout,
            x: { kind: "literal", value: 24 },
            y: { kind: "literal", value: 100 },
            width: { kind: "literal", value: 120 },
            height: { kind: "literal", value: 120 },
          },
        };
        const button = document.nodes.find((node) => node.id === "button-next")!;
        if (button.kind !== "button") throw Error("BUTTON_REQUIRED");
        button.motionIds = [];
        button.actionIds = ["action-fit"];
        button.style.rotation = 0;
        const reset = {
          ...structuredClone(button),
          id: "button-fit-reset",
          name: "Reset",
          label: "Reset",
          actionIds: ["action-fit-reset"],
          layout: { ...button.layout, x: { kind: "literal" as const, value: 180 } },
        };
        root.childIds.push(image.id, reset.id);
        document.nodes.push(image, reset);
        document.assets = [asset];
        document.motions = [];
        document.screens[0]!.initialStateId = "fit-base";
        document.states = [
          {
            id: "fit-base",
            screenId: "screen-home",
            name: "Base",
            values: {},
            overrides: [{ nodeId: image.id, style: image.style }],
          },
          {
            id: "fit-changed",
            screenId: "screen-home",
            name: "Changed",
            values: {},
            overrides: [{ nodeId: image.id, style: { ...image.style, opacity: 0.65 } }],
          },
        ];
        document.actions = [
          {
            id: "action-fit",
            nodeId: button.id,
            event: "click",
            kind: "setState",
            targetStateId: "fit-changed",
          },
          {
            id: "action-fit-reset",
            nodeId: reset.id,
            event: "click",
            kind: "setState",
            targetStateId: "fit-base",
          },
        ];
        const assets = [
          {
            assetId: asset.id,
            kind: asset.kind,
            blobId: asset.blobId,
            mediaType: asset.mediaType,
            byteSize: asset.byteSize,
            sha256: asset.sha256,
            bytes,
          },
        ];
        const rendered = renderPrototypeDocumentHtml(document, { assets });
        const imageTag = rendered.document.match(/<img\b[^>]*data-wb-node="image-fit"[^>]*>/u)![0];
        expect(imageTag.match(/\sstyle=/gu)).toHaveLength(1);
        const html =
          format === "html"
            ? rendered.document
            : Buffer.from(
                (await prototypeDocumentReactOutput(document, { assets })).validationBytes,
              ).toString("utf8");
        const context = await browser.newContext({
          viewport: { width: 800, height: 900 },
          serviceWorkers: "block",
        });
        const network: string[] = [],
          errors: string[] = [];
        await context.route(/^(?:https?|wss?):/u, (route) => {
          network.push(route.request().url());
          return route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.setContent(html, { waitUntil: "load" });
          const node = page.locator('[data-wb-node="image-fit"]');
          await node.evaluate(async (element) => {
            await (element as HTMLImageElement).decode();
          });
          const computed = () =>
            node.evaluate((element) => ({
              fit: getComputedStyle(element).objectFit,
              opacity: getComputedStyle(element).opacity,
            }));
          expect(await computed()).toEqual({ fit, opacity: "1" });
          expect(
            await node.evaluate((element) => [
              (element as HTMLImageElement).naturalWidth,
              (element as HTMLImageElement).naturalHeight,
            ]),
          ).toEqual([width, height]);
          const pixels = await sharp(await node.screenshot())
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const rgb = (x: number, y: number) => [
            ...pixels.data.subarray((y * pixels.info.width + x) * 4, (y * pixels.info.width + x) * 4 + 3),
          ];
          expect(rgb(60, 60)).toEqual([255, 0, 0]);
          expect(rgb(8, 8)).toEqual(fit === "cover" ? [255, 0, 0] : [255, 255, 255]);
          await page.locator('[data-wb-node="button-next"]').click();
          expect(await computed()).toEqual({ fit, opacity: "0.65" });
          await page.setViewportSize({ width: 320, height: 700 });
          expect(await computed()).toEqual({ fit, opacity: "0.65" });
          await page.locator('[data-wb-node="button-fit-reset"]').click();
          expect(await computed()).toEqual({ fit, opacity: "1" });
          expect(network).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
      30000,
    );
  },
);
