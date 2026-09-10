import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderSuiteWorkbench } from "../src/suite-workbench";
import type { LoadedSuite } from "../src/core/suite";
import { runSuite, yamlDocument } from "../src/core/suite";
import { errorDetails } from "../src/core/error-details";
import { suiteErrorsCsv, updateSuiteConnection } from "../src/suite-actions";

const suite: LoadedSuite = { id: "hcm", source: "file:///suite.csvsuite.yaml", isSuite: true, members: [
  { id: "employees", source: "file:///employees.yaml", contract: { version: 1, schema: { columns: { EmployeeId: { presence: "required", constraints: { notNull: true } } } }, sqlServer: { connection: "local", schema: "staging", table: "Employees" } } },
  { id: "departments", source: "file:///suite.csvsuite.yaml", contract: { version: 1, schema: { columns: { DepartmentCode: { presence: "required" } } }, sqlServer: { connection: "local", schema: "staging", table: "Departments" } } }
] };

test("suite Workbench shows independent members, filters, and sends actions only on clicks", () => {
  const messages: unknown[] = [];
  const dom = new JSDOM(renderSuiteWorkbench({ suite, references: ["./employees.yaml", undefined] }, "test"), {
    runScripts: "dangerously",
    beforeParse(window) { Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => undefined, setState: () => {} }) }); }
  });
  const document = dom.window.document;
  assert.equal(messages.length, 0, "Opening a suite must never run a database test");
  assert.match(document.querySelector("h1")!.textContent!, /hcm/);
  assert.equal(document.querySelectorAll("[data-member]").length, 2);
  assert.match(document.body.textContent!, /EmployeeId/);
  assert.match(document.body.textContent!, /DepartmentCode/);
  const filter = document.querySelector<HTMLInputElement>("#filter")!;
  filter.value = "departments"; filter.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelector<HTMLElement>('[data-member="employees"]')!.hidden, true);
  assert.equal(document.querySelector<HTMLElement>('[data-member="departments"]')!.hidden, false);
  document.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-action="member"][data-index="1"]')!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "run" }, { type: "member", index: 1 }]);
  dom.window.close();
});

test("ODBC objects retain diagnostics through execution, rendering and CSV export", async () => {
  const report = await runSuite(suite, async () => { throw { message: "Login failed", sqlstate: "28000", code: 18456, originalError: new Error("ODBC denied access"), password: "never-export" }; });
  assert.equal(report.status, "ERROR");
  assert.match(report.runs[0].error!, /Login failed/);
  assert.match(report.runs[0].error!, /28000/);
  assert.match(report.runs[0].error!, /ODBC denied access/);
  assert.doesNotMatch(report.runs[0].error!, /never-export|\[object Object\]/);
  const dom = new JSDOM(renderSuiteWorkbench({ suite, runs: report.runs }, "test"));
  assert.match(dom.window.document.querySelector("pre.error")!.textContent!, /18456/);
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-action="export"]')!.disabled, false);
  const csv = suiteErrorsCsv(report.runs);
  assert.match(csv, /hcm.*employees.*staging.Employees.*ERROR/);
  assert.match(csv, /Login failed/);
  dom.window.close();
  const circular: Record<string, unknown> = { message: "Pwd=secret; failed" }; circular.cause = circular;
  assert.doesNotMatch(errorDetails(circular), /secret/);
  assert.match(errorDetails(circular), /Circular/);
});

test("connection edits replace alternatives only at selected scope and preserve rules and comments", () => {
  const text = '# keep comment\nsuiteVersion: 1\nid: x\ndefaults: {connection: old}\nmembers:\n  - id: one\n    contract:\n      version: 1\n      schema: {columns: {Id: {presence: required}}}\n      sqlServer:\n        connection: member\n        targets: [{schema: dbo, table: A, connection: target}]\n';
  const changed = updateSuiteConnection(text, ["defaults"], { integratedConnection: { server: "localhost", database: "synthetic" } });
  assert.match(changed, /# keep comment/);
  const original = yamlDocument(text).toJS(); const updated = yamlDocument(changed).toJS();
  assert.deepEqual(updated.members, original.members);
  assert.equal(updated.defaults.connection, undefined);
  const targetChanged = updateSuiteConnection(changed, ["members", 0, "contract", "sqlServer", "targets", 0], { integratedConnection: { server: "other", database: "db" } });
  const target = yamlDocument(targetChanged).toJS().members[0].contract.sqlServer.targets[0];
  assert.equal(target.connection, undefined); assert.equal(target.table, "A");
  const inherited = updateSuiteConnection(targetChanged, ["members", 0, "contract", "sqlServer", "targets", 0], {});
  assert.deepEqual(yamlDocument(inherited).toJS().members[0].contract.sqlServer.targets[0], { schema: "dbo", table: "A" });
});

test("suite connection, credential and export controls dispatch explicit actions", () => {
  const messages: unknown[] = [];
  const dom = new JSDOM(renderSuiteWorkbench({ suite, runs: [] }, "test"), { runScripts: "dangerously", beforeParse(window) {
    Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => undefined, setState: () => {} }) });
  } });
  for (const selector of ['[data-action="connection"]:not([data-index])', '[data-action="connection"][data-index="0"]', '[data-action="credentials"]', '[data-action="export"]']) dom.window.document.querySelector<HTMLButtonElement>(selector)!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "connection" }, { type: "connection", index: 0 }, { type: "credentials" }, { type: "export" }]);
  dom.window.close();
});

test("suite Workbench renders execution failures, escapes content and disables duplicate runs", () => {
  const dom = new JSDOM(renderSuiteWorkbench({ suite, running: true, runs: [{ suite: "hcm", member: "employees", spec: "x", table: "staging.Employees", status: "ERROR", error: '<img src=x onerror="attack()">' }] }, "test"));
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-action="run"]')!.disabled, true);
  assert.equal(dom.window.document.querySelectorAll("img").length, 0);
  assert.match(dom.window.document.body.textContent!, /ERROR/);
  assert.match(dom.window.document.body.textContent!, /<img/);
  const invalid = new JSDOM(renderSuiteWorkbench({ error: "Invalid suite YAML" }, "test"));
  assert.equal(invalid.window.document.querySelector<HTMLButtonElement>('[data-action="run"]')!.disabled, true);
  assert.equal(invalid.window.document.querySelector<HTMLButtonElement>('[data-action="yaml"]')!.disabled, false);
  dom.window.close(); invalid.window.close();
});
