import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("contributes the workspace test Activity Bar view and commands", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const commands = new Set(manifest.contributes.commands.map((entry: { command: string }) => entry.command));
  assert.ok(commands.has("csv-contract-vsce.runSelectedContracts"));
  assert.ok(commands.has("csv-contract-vsce.showWorkspaceReport"));
  assert.ok(commands.has("csv-contract-vsce.refreshExplorer"));
  assert.ok(commands.has("csv-contract-vsce.openTargetInVsCode"));
  assert.ok(commands.has("csv-contract-vsce.openTargetExternally"));
  assert.ok(commands.has("csv-contract-vsce.generateSqlServerValidation"));
  assert.ok(commands.has("csv-contract-vsce.importSqlServerSchema"));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "csvContractExplorer");
  assert.equal(manifest.contributes.views.csvContractExplorer[0].id, "csvContractExplorer.contracts");
  assert.ok(manifest.activationEvents.includes("onView:csvContractExplorer.contracts"));
  for (const command of manifest.contributes.commands.filter((entry: { category?: string }) => entry.category === "CSV Contract")) {
    assert.equal(command.title.startsWith("CSV Contract:"), false, `command palette title duplicated category: ${command.title}`);
  }
  const titleCommands = manifest.contributes.menus["view/title"].map((entry: { command: string }) => entry.command);
  assert.ok(titleCommands.includes("csv-contract-vsce.runSelectedContracts"));
  const itemCommands = manifest.contributes.menus["view/item/context"].map((entry: { command: string }) => entry.command);
  assert.ok(itemCommands.includes("csv-contract-vsce.openTargetInVsCode"));
  assert.ok(itemCommands.includes("csv-contract-vsce.openTargetExternally"));
});

test("Marketplace README explains how to run the installed PowerShell wrapper", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /code --locate-extension incursa\.csv-contract-vsce/);
  assert.match(readme, /scripts\\Test-CsvContract\.ps1/);
  assert.match(readme, /Run workspace test suites/);
  assert.match(readme, /Generate SQL Server staging validation/);
  assert.match(readme, /Import a known staging schema/);
});
