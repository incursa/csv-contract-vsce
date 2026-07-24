import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkspaceReportHtml, type WorkspaceReportView } from "../src/workspace-report";

const report: WorkspaceReportView = {
  completedAt: new Date("2026-07-24T18:30:00Z"),
  durationMs: 12_450,
  selectedContracts: 2,
  targets: 2,
  valid: false,
  entries: [
    {
      contractLabel: "contracts/payroll<east>.csvtest.yaml",
      target: "../exports/payroll-east.csv",
      durationMs: 4_125,
      result: {
        valid: true,
        rowCount: 18_340,
        columnCount: 35,
        testCount: 42,
        issueCount: 0,
        truncated: false,
        issues: []
      }
    },
    {
      contractLabel: "contracts/payroll-west.csvtest.yaml",
      target: "../exports/payroll-west.csv",
      durationMs: 8_325,
      result: {
        valid: false,
        rowCount: 17_920,
        columnCount: 35,
        testCount: 42,
        issueCount: 1,
        truncated: false,
        issues: [{
          level: "cell",
          code: "CELL_NOT_EQUAL",
          testId: "expected-payroll-status",
          column: "Status",
          row: 17,
          message: "Expected Active; found <script>alert(1)</script>."
        }]
      }
    }
  ]
};

test("renders a complete workspace report and selected successful run", () => {
  const html = renderWorkspaceReportHtml(report, {
    cspSource: "vscode-webview:",
    styleUri: "vscode-webview://extension/webview.css",
    selectedEntryIndex: 0
  });

  assert.match(html, /CSV Contract Test Report/);
  assert.match(html, /1 passed · 1 failed/);
  assert.match(html, /All 42 tests passed/);
  assert.match(html, /18,340 rows/);
  assert.match(html, /payroll&lt;east&gt;\.csvtest\.yaml/);
  assert.match(html, /id="run-1"[^>]* open/);
  assert.match(html, /id="run-2"[^>]* open/);
});

test("renders failure diagnostics without allowing report data to inject HTML", () => {
  const html = renderWorkspaceReportHtml(report, {
    cspSource: "vscode-webview:",
    styleUri: "vscode-webview://extension/webview.css"
  });

  assert.match(html, /CELL_NOT_EQUAL/);
  assert.match(html, /Status · record 17 · expected-payroll-status/);
  assert.match(html, /Expected Active; found &lt;script&gt;alert\(1\)&lt;\/script&gt;\./);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /12 sec/);
});
