import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderSuiteWorkbench } from "../src/suite-workbench";
import type { LoadedSuite } from "../src/core/suite";

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
  document.querySelector<HTMLButtonElement>('[data-index="1"]')!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "run" }, { type: "member", index: 1 }]);
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
