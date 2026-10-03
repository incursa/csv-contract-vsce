import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderSuiteWorkbench, type SuiteRunProgress } from "../src/suite-workbench";
import type { LoadedSuite, SuiteRun } from "../src/core/suite";
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
  assert.match(document.querySelector('[data-action="color-mode"]')!.textContent!, /Red \/ green/);
  const filter = document.querySelector<HTMLInputElement>("#filter")!;
  filter.value = "departments"; filter.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelector<HTMLElement>('[data-member="employees"]')!.hidden, true);
  assert.equal(document.querySelector<HTMLElement>('[data-member="departments"]')!.hidden, false);
  document.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-action="member"][data-index="1"]')!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "run" }, { type: "member", index: 1 }]);
  dom.window.close();
});

test("suite run view rolls up a 17-file suite and keeps target progress compact", () => {
  const messages: unknown[] = [];
  const members = Array.from({ length: 17 }, (_, memberIndex) => ({
    id: `catalog-${memberIndex + 1}`,
    source: `file:///catalog-${memberIndex + 1}.csvtest.yaml`,
    status: memberIndex === 0 ? "running" as const : "queued" as const,
    targets: Array.from({ length: 6 }, (_, targetIndex) => ({
      label: `staging.Dataset${memberIndex + 1}_${targetIndex + 1}`,
      status: memberIndex === 0 && targetIndex === 0 ? "running" as const : "queued" as const,
      ...(memberIndex === 0 && targetIndex === 0 ? { progress: { phase: "reading" as const, rowsRead: 250, totalRows: 1000 } } : {})
    }))
  }));
  const dom = new JSDOM(renderSuiteWorkbench({ suite, runView: true, runProgress: { running: true, members } }, "test"), {
    runScripts: "dangerously",
    beforeParse(window) { Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }) }); }
  });
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("[data-run-member]").length, 17);
  assert.equal(document.querySelectorAll("[data-run-target]").length, 102);
  assert.equal(document.querySelectorAll("progress").length, 120, "one suite bar, 17 member bars, and one bar per target");
  assert.match(document.body.textContent!, /0 of 17 test files complete/);
  assert.match(document.body.textContent!, /250 rows read of 1,000/);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "suiteRunReady" }]);
  const update = structuredClone({ running: true, members }) as SuiteRunProgress;
  update.members[0].targets[0] = { label: "staging.Dataset1_1", status: "PASS", rows: 1000 };
  update.members[0].status = "running";
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "suiteRunProgress", run: update } }));
  assert.equal(document.querySelector('[data-run-target="catalog-1:0"] [data-target-phase]')!.textContent, "PASS");
  assert.equal(document.querySelector('[data-run-member="catalog-1"] [data-member-count]')!.textContent, "1 / 6 targets");
  document.querySelector<HTMLButtonElement>('[data-action="show-results"]')!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "suiteRunReady" }, { type: "show-results" }]);
  dom.window.close();
});

test("completed suite runs can rerun only failed test files", () => {
  const messages: unknown[] = [];
  const members = suite.members.map((member, index) => ({ id: member.id, source: member.source,
    status: index === 0 ? "FAIL" as const : "PASS" as const,
    targets: [{ label: `stage.Dataset${index + 1}`, status: index === 0 ? "FAIL" as const : "PASS" as const }] }));
  const dom = new JSDOM(renderSuiteWorkbench({ suite, runView: true, runProgress: { running: false, status: "FAIL", members } }, "test"), {
    runScripts: "dangerously",
    beforeParse(window) { Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }) }); }
  });
  const button = dom.window.document.querySelector<HTMLButtonElement>('[data-action="failed"]')!;
  assert.match(button.textContent!, /Rerun 1 failed/);
  button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "suiteRunReady" }, { type: "failed" }]);
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

test("suite CSV ordering is independent of the caller run order", () => {
  const makeRun = (member: string): SuiteRun => ({ suite: "hcm", member, spec: `${member}.yaml`, status: "PASS", target: `${member}.csv`, result: {
    valid: true, rowCount: 1, columnCount: 1, testCount: 1, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: []
  } });
  const first = makeRun("employees");
  const second = makeRun("departments");
  assert.equal(suiteErrorsCsv([first, second], "selected"), suiteErrorsCsv([second, first], "selected"));
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

test("suite Workbench shows graded health without changing failure status", async () => {
  const report = await runSuite(suite, async () => ({ valid: false, rowCount: 1000, columnCount: 1, testCount: 10,
    issueCount: 1, errorCount: 1, warningCount: 0, truncated: false,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "value-valid", message: "Review this value." }] }));
  const dom = new JSDOM(renderSuiteWorkbench({ suite, runs: report.runs, resultColorMode: "graded" }, "test"));
  assert.match(dom.window.document.querySelector(".overview .badge")!.textContent!, /FAIL · (Limited|Moderate|High) impact/);
  assert.match(dom.window.document.querySelector(".overview .badge")!.getAttribute("title")!, /Health score \d+\/100/);
  assert.equal(dom.window.document.querySelectorAll(".health-perfect").length, 0);
  assert.match(dom.window.document.body.textContent!, /FAIL · (Limited|Moderate|High) impact/);
  dom.window.close();
});
