import * as esbuild from "esbuild";
import { mkdir } from "node:fs/promises";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

await mkdir("dist/web", { recursive: true });
await mkdir("dist/cli", { recursive: true });
await mkdir("dist/test", { recursive: true });

const builds = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/web/extension.js",
    format: "cjs",
    platform: "browser",
    external: ["vscode"]
  },
  {
    ...shared,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/web/webview.js",
    format: "iife",
    platform: "browser",
    loader: { ".css": "css" }
  },
  {
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli/csv-contract.cjs",
    format: "cjs",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" }
  },
  {
    ...shared,
    entryPoints: ["test/core.test.ts", "test/generator.test.ts"],
    outdir: "dist/test",
    entryNames: "[name]",
    outExtension: { ".js": ".cjs" },
    format: "cjs",
    platform: "node"
  }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching extension, webview, CLI, and tests.");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
