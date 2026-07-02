#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [inputFile, outputDir] = process.argv.slice(2);

if (!inputFile || !outputDir) {
  console.error("Usage: axure-rp-export-html.mjs <input.rp> <output-dir>");
  process.exit(2);
}

if (process.platform !== "darwin") {
  console.error("Axure RP HTML export automation requires macOS.");
  process.exit(2);
}

const axureAppName = process.env.AXURE_RP_APP_NAME || "Axure RP 11";
const cliclickBin = findExecutable(process.env.CLICLICK_BIN, [
  "/opt/homebrew/bin/cliclick",
  "/usr/local/bin/cliclick",
  "cliclick",
]);

const fallbackFolderButtonAt = parsePoint(process.env.AXURE_RP_FOLDER_BUTTON_AT, { x: 860, y: 400 });
const fallbackPublishButtonAt = parsePoint(process.env.AXURE_RP_PUBLISH_BUTTON_AT, { x: 760, y: 600 });
const folderButtonOffset = parsePoint(process.env.AXURE_RP_FOLDER_BUTTON_OFFSET, { x: 228, y: 120 });
const publishButtonOffset = parsePoint(process.env.AXURE_RP_PUBLISH_BUTTON_OFFSET, { x: 130, y: 318 });
const mainWindowAt = parsePoint(process.env.AXURE_RP_WINDOW_AT, { x: 130, y: 70 });
const mainWindowSize = parseSize(process.env.AXURE_RP_WINDOW_SIZE, { width: 1260, height: 820 });
const loadWaitMs = Number(process.env.AXURE_RP_LOAD_WAIT_MS || 5_000);
const dialogWaitMs = Number(process.env.AXURE_RP_DIALOG_WAIT_MS || 800);
const outputTimeoutMs = Number(process.env.AXURE_RP_OUTPUT_TIMEOUT_MS || 120_000);
const windowTimeoutMs = Number(process.env.AXURE_RP_WINDOW_TIMEOUT_MS || 45_000);

if (!existsSync(inputFile)) {
  console.error(`Input RP file does not exist: ${inputFile}`);
  process.exit(2);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

try {
  exportHtml(inputFile, outputDir);
  console.log(`Axure HTML exported: ${outputDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function exportHtml(sourcePath, targetDir) {
  hideKnownBlockingWindows();
  run("open", ["-a", axureAppName, sourcePath]);
  sleep(loadWaitMs);
  activateAxure();
  waitForAxureWindow();
  moveAxureWindowToMainDisplay();
  clickGenerateHtmlMenu();
  sleep(dialogWaitMs);
  const publishDialogOrigin = getPublishDialogOrigin();
  click(publishDialogOrigin ? addPoint(publishDialogOrigin, folderButtonOffset) : fallbackFolderButtonAt);
  sleep(700);
  chooseFolder(targetDir);
  sleep(700);
  const refreshedDialogOrigin = getPublishDialogOrigin() || publishDialogOrigin;
  click(refreshedDialogOrigin ? addPoint(refreshedDialogOrigin, publishButtonOffset) : fallbackPublishButtonAt);
  waitForExport(targetDir);
}

function activateAxure() {
  osascript(`
tell application "${escapeAppleScript(axureAppName)}" to activate
delay 0.2
tell application "System Events"
  set frontmost of process "${escapeAppleScript(axureAppName)}" to true
end tell
`);
}

function hideKnownBlockingWindows() {
  osascript(`
tell application "System Events"
  repeat with processName in {"wpsoffice", "WeChat"}
    if exists process processName then set visible of process processName to false
  end repeat
end tell
`);
}

function waitForAxureWindow() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < windowTimeoutMs) {
    const count = Number(
      osascript(`
tell application "System Events"
  if exists process "${escapeAppleScript(axureAppName)}" then
    tell process "${escapeAppleScript(axureAppName)}" to return count of windows
  end if
end tell
return 0
`).trim() || "0",
    );
    if (count > 0) return;
    sleep(1_000);
    activateAxure();
  }
  throw new Error("Timed out waiting for Axure document window.");
}

function moveAxureWindowToMainDisplay() {
  osascript(`
tell application "System Events"
  tell process "${escapeAppleScript(axureAppName)}"
    if (count of windows) > 0 then
      set position of window 1 to {${mainWindowAt.x}, ${mainWindowAt.y}}
      set size of window 1 to {${mainWindowSize.width}, ${mainWindowSize.height}}
      set frontmost to true
    end if
  end tell
end tell
`);
}

function getPublishDialogOrigin() {
  const output = osascript(`
tell application "System Events"
  tell process "${escapeAppleScript(axureAppName)}"
    repeat with windowRef in windows
      set windowName to name of windowRef
      if windowName is "发布项目" or windowName is "Publish Project" then
        set windowPosition to position of windowRef
        return ((item 1 of windowPosition) as text) & "," & ((item 2 of windowPosition) as text)
      end if
    end repeat
  end tell
end tell
return ""
`).trim();
  if (!output) return null;
  return parsePoint(output, null);
}

function clickGenerateHtmlMenu() {
  const menuScripts = [
    `
tell application "System Events"
  tell process "${escapeAppleScript(axureAppName)}"
    click menu item "生成 HTML 文件…" of menu "发布" of menu bar item "发布" of menu bar 1
  end tell
end tell
`,
    `
tell application "System Events"
  tell process "${escapeAppleScript(axureAppName)}"
    click menu item "Generate HTML Files…" of menu "Publish" of menu bar item "Publish" of menu bar 1
  end tell
end tell
`,
  ];

  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const script of menuScripts) {
      try {
        activateAxure();
        osascript(script);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    sleep(1_000);
  }
  throw new Error(`Failed to open Axure HTML publish dialog: ${lastError?.message || lastError}`);
}

function chooseFolder(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  execFileSync("pbcopy", [], { input: targetDir });
  osascript(`
tell application "System Events"
  keystroke "g" using {command down, shift down}
  delay 0.3
  keystroke "a" using command down
  delay 0.1
  keystroke "v" using command down
  delay 0.2
  key code 36
  delay 0.8
  key code 36
end tell
`);
  sleep(700);
  clickOpenButtonIfPresent();
}

function clickOpenButtonIfPresent() {
  osascript(`
tell application "System Events"
  tell process "${escapeAppleScript(axureAppName)}"
    if exists window "Open" then
      try
        click button "Open" of window "Open"
      end try
    end if
    if exists window "打开" then
      try
        click button "打开" of window "打开"
      end try
    end if
  end tell
end tell
`);
}

function waitForExport(targetDir) {
  const startedAt = Date.now();
  let stableCount = 0;
  let lastCount = -1;

  while (Date.now() - startedAt < outputTimeoutMs) {
    const files = listFiles(targetDir);
    const hasEntry = files.some((file) => {
      const lower = path.basename(file).toLowerCase();
      return lower === "index.html" || lower === "start.html";
    });

    if (hasEntry && files.length === lastCount) {
      stableCount += 1;
      if (stableCount >= 3) return;
    } else {
      stableCount = 0;
      lastCount = files.length;
    }
    sleep(1_000);
  }

  throw new Error(`Timed out waiting for Axure HTML export in ${targetDir}`);
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (dir) => {
    for (const item of readdirSync(dir)) {
      const absolutePath = path.join(dir, item);
      const info = statSync(absolutePath);
      if (info.isDirectory()) visit(absolutePath);
      else result.push(absolutePath);
    }
  };
  visit(root);
  return result;
}

function click(point) {
  run(cliclickBin, [`c:${point.x},${point.y}`]);
}

function shortcut(modifiers, key) {
  run(cliclickBin, [`kd:${modifiers}`, `t:${key}`, `ku:${modifiers}`]);
}

function typeText(text) {
  run(cliclickBin, [`t:${text}`]);
}

function press(key) {
  run(cliclickBin, [`kp:${key}`]);
}

function osascript(script) {
  return execFileSync("osascript", [], { input: script, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message || result.status}`);
  }
  return result.stdout;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parsePoint(raw, fallback) {
  if (!raw) return fallback;
  const [x, y] = raw.split(",").map((item) => Number(item.trim()));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : fallback;
}

function addPoint(left, right) {
  return { x: left.x + right.x, y: left.y + right.y };
}

function parseSize(raw, fallback) {
  if (!raw) return fallback;
  const [width, height] = raw.split(",").map((item) => Number(item.trim()));
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : fallback;
}

function findExecutable(preferred, fallbacks) {
  for (const candidate of [preferred, ...fallbacks].filter(Boolean)) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    const result = spawnSync("which", [candidate], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  console.error("cliclick is required for Axure UI automation. Install it or set CLICLICK_BIN.");
  process.exit(2);
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
