import fs from 'node:fs';
import path from 'node:path';

const runtimeRoots = process.argv.slice(2);
if (!runtimeRoots.length) {
  runtimeRoots.push(
    path.resolve('packages/datasheet/public'),
    path.resolve('packages/datasheet/web_build'),
  );
}

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt']);
const replacements = [
  ['深圳维格云科技有限公司', '产品工作台'],
  ['vika维格表', '产品工作台'],
  ['Vika维格表', '产品工作台'],
  ['维格云', '产品工作台'],
  ['维格表', '产品工作台'],
];
const legacyNames = replacements.map(([legacyName]) => legacyName);

const runtimeFiles = [];
const collectFiles = (entryPath) => {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(entryPath)) collectFiles(path.join(entryPath, entry));
    return;
  }
  if (textExtensions.has(path.extname(entryPath))) runtimeFiles.push(entryPath);
};

for (const runtimeRoot of runtimeRoots) collectFiles(runtimeRoot);

let changedFiles = 0;
for (const runtimeFile of runtimeFiles) {
  const original = fs.readFileSync(runtimeFile, 'utf8');
  let branded = original;
  for (const [legacyName, brandName] of replacements) {
    branded = branded.replaceAll(legacyName, brandName);
  }
  if (branded !== original) {
    fs.writeFileSync(runtimeFile, branded);
    changedFiles += 1;
  }
}

const residuals = [];
for (const runtimeFile of runtimeFiles) {
  const content = fs.readFileSync(runtimeFile, 'utf8');
  for (const legacyName of legacyNames) {
    if (content.includes(legacyName)) residuals.push(`${runtimeFile}: ${legacyName}`);
  }
}

if (residuals.length) {
  throw new Error(`Legacy product branding remains:\n${residuals.join('\n')}`);
}

console.log(`Scrubbed legacy product branding from ${changedFiles} runtime files.`);
