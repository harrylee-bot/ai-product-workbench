#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = process.argv[2]
  ? path.resolve(repoRoot, process.argv[2])
  : null;
const appDirectory = path.join(repoRoot, "apps/web/app");
const socialDirectory = path.join(appDirectory, "(workbench)");
const brandDirectory = path.join(repoRoot, "apps/web/public/brand");
const canvasPreviewPath = path.join(brandDirectory, "workbench-canvas-preview.png");
const socialSize = { width: 1200, height: 630 };

await mkdir(brandDirectory, { recursive: true });
const canvasPreview = await loadCanvasPreview();
await Promise.all([
  renderSocialImage(path.join(socialDirectory, "opengraph-image.png"), canvasPreview),
  renderSocialImage(path.join(socialDirectory, "twitter-image.png"), canvasPreview),
  renderIcon(path.join(appDirectory, "icon.png")),
]);

async function loadCanvasPreview() {
  if (sourcePath) {
    const preview = await sharp(sourcePath)
      .extract({ left: 360, top: 65, width: 850, height: 500 })
      .resize(630, 400, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    await writeFile(canvasPreviewPath, preview);
    return preview;
  }
  return sharp(canvasPreviewPath)
    .resize(630, 400, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

async function renderSocialImage(outputPath, screenshot) {
  await sharp({
    create: {
      ...socialSize,
      channels: 4,
      background: "#131314",
    },
  })
    .composite([
      {
        input: Buffer.from(`
          <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
            <rect x="538" y="109" width="634" height="404" rx="8" fill="#242629" stroke="#4a4b50" stroke-width="2"/>
          </svg>
        `),
      },
      { input: screenshot, left: 540, top: 111 },
      {
        input: Buffer.from(`
          <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
            <style>
              .brand { font-family: "PingFang SC", "Heiti SC", sans-serif; }
            </style>
            <rect x="66" y="84" width="12" height="54" rx="4" fill="#7467f6"/>
            <rect x="86" y="84" width="12" height="54" rx="4" fill="#00b8c8"/>
            <text class="brand" x="66" y="242" font-size="72" font-weight="700" fill="#f1f3f4">产品工作台</text>
            <text class="brand" x="68" y="302" font-size="25" font-weight="500" fill="#c9c5ce">从需求与知识，到原型与交付</text>
            <line x1="68" y1="354" x2="450" y2="354" stroke="#3a3b40" stroke-width="2"/>
            <text class="brand" x="68" y="414" font-size="21" font-weight="500" fill="#9fa0a8">需求  ·  知识  ·  原型  ·  交付</text>
            <text class="brand" x="68" y="518" font-size="18" font-weight="500" fill="#73747d">DeerFlow 驱动的产品协作空间</text>
          </svg>
        `),
      },
    ])
    .png({ compressionLevel: 9, palette: true })
    .toFile(outputPath);
}

async function renderIcon(outputPath) {
  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: "#1e1e20",
    },
  })
    .composite([{
      input: Buffer.from(`
        <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
          <style>
            .mark { font-family: "PingFang SC", "Heiti SC", sans-serif; }
          </style>
          <rect x="58" y="58" width="396" height="396" rx="72" fill="#282a2d" stroke="#55565d" stroke-width="8"/>
          <rect x="86" y="86" width="18" height="92" rx="7" fill="#7467f6"/>
          <rect x="114" y="86" width="18" height="92" rx="7" fill="#00b8c8"/>
          <text class="mark" x="256" y="350" text-anchor="middle" font-size="254" font-weight="700" fill="#f1f3f4">品</text>
        </svg>
      `),
    }])
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}
