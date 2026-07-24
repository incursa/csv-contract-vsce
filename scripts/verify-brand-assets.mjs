import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const expectedPngs = new Map([
  ["images/icon.png", [256, 256]],
  ["images/icon-128.png", [128, 128]],
  ["images/icon-64.png", [64, 64]],
  ["images/icon-32.png", [32, 32]],
  ["images/icon-16.png", [16, 16]],
  ["images/csv-contract-readme-banner.png", [960, 220]],
  ["images/workbench-column-rules.png", [1440, 1887]],
  ["images/workbench-results.png", [1440, 2078]],
  ["artifacts/brand/csv-contract-brand-sheet.png", [1200, 720]]
]);

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} must include ${JSON.stringify(expected)}.`);
}

for (const [relativePath, [expectedWidth, expectedHeight]] of expectedPngs) {
  const bytes = await readFile(resolve(root, relativePath));
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`${relativePath} is not a PNG.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`${relativePath} is ${width}x${height}; expected ${expectedWidth}x${expectedHeight}.`);
  }
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (packageJson.icon !== "images/icon.png") throw new Error("package.json must declare images/icon.png as the Marketplace icon.");

const readme = await readFile(resolve(root, "README.md"), "utf8");
requireText(readme, "![CSV Contract Workbench](images/csv-contract-readme-banner.png)", "README");
requireText(readme, "![Configure column rules in CSV Contract Workbench](images/workbench-column-rules.png)", "README");
requireText(readme, "![Review CSV validation results in CSV Contract Workbench](images/workbench-results.png)", "README");
for (const internalDetail of [
  "npm install",
  "npm run",
  "30-file",
  "30 file",
  "release runbook",
  "VSCE_PAT",
  "@incursa/ui-kit",
  "figma.com"
]) {
  if (readme.toLowerCase().includes(internalDetail.toLowerCase())) {
    throw new Error(`README contains internal release or implementation detail: ${internalDetail}`);
  }
}

const activityMark = await readFile(resolve(root, "resources/csv-contract.svg"), "utf8");
requireText(activityMark, 'stroke="currentColor"', "Activity-bar mark");
if (/#[0-9a-f]{3,8}/i.test(activityMark)) throw new Error("Activity-bar mark must remain theme-aware and monochrome.");

const iconSource = await readFile(resolve(root, "images/csv-contract-icon.svg"), "utf8");
requireText(iconSource, "#4459C6", "Icon source");
requireText(iconSource, "#FFFFFF", "Icon source");

const refinedMarkFragments = [
  "M31 52H18a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6H46a6 6 0 0 1 6 6V24",
  "M12 27H42M12 40H29M28 12V52",
  "M37 41L43 47L56 30"
];
for (const relativePath of [
  "images/csv-contract-icon.svg",
  "images/csv-contract-readme-banner.svg",
  "images/csv-contract-wordmark-vscode.svg",
  "resources/csv-contract.svg",
  "artifacts/brand/csv-contract-brand-sheet.svg"
]) {
  const source = await readFile(resolve(root, relativePath), "utf8");
  for (const fragment of refinedMarkFragments) requireText(source, fragment, relativePath);
}

const brandTerms = await readFile(resolve(root, "BRAND-ASSET-LICENSE.md"), "utf8");
for (const relativePath of [
  "images/icon.png",
  "images/csv-contract-icon.svg",
  "images/csv-contract-readme-banner.png",
  "images/csv-contract-wordmark-vscode.svg",
  "resources/csv-contract.svg",
  "artifacts/brand/csv-contract-brand-sheet.png",
  "artifacts/brand/csv-contract-brand-sheet.svg"
]) {
  requireText(brandTerms, `\`${relativePath}\``, "Brand asset terms");
}

console.log(`Brand assets verified: ${expectedPngs.size} PNGs, Marketplace metadata, README branding, and theme-aware SVG mark.`);
