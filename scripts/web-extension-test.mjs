import { runTests } from "@vscode/test-web";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

await runTests({
  browserType: "chromium",
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, "dist", "web", "test", "index.js"),
  folderPath: resolve(root, "test", "web", "workspace"),
  headless: true,
  quality: "stable",
  testRunnerDataDir: resolve(root, ".vscode-test-web")
});
