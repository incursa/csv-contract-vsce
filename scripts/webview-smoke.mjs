import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const state = {
  type: "state",
  contractName: "contracts/employee-export.csvtest.yaml",
  csvName: "exports/employees-2026-07-23.csv",
  csv: { headers: ["Company", "EmployeeId", "EmployeeName", "Status", "OptionalComment"], rowCount: 30214 },
  contract: {
    version: 1,
    csv: { nullValues: [""], trimValues: false, caseSensitive: true },
    schema: {
      allowAdditionalColumns: true,
      columns: {
        Company: { presence: "required", constraints: { notNull: true, maxLength: 2 } },
        EmployeeId: { presence: "required", constraints: { notNull: true, unique: true, maxLength: 12, matches: "^\\d+$" } },
        EmployeeName: { presence: "required", constraints: { notNull: true, maxLength: 120 } },
        Status: { presence: "required", constraints: { allowedValues: ["Active", "Inactive"] } },
        OptionalComment: { presence: "optional", constraints: { maxLength: 250 } }
      }
    },
    rowTests: [
      { id: "expected-employee-exists", select: { Company: "01", EmployeeId: "000123" }, expect: { count: { exact: 1 } } },
      { id: "expected-employee-status", select: { EmployeeId: "000123" }, expect: { cells: { Status: { equals: "Active" } } } }
    ]
  },
  result: {
    valid: false,
    rowCount: 30214,
    columnCount: 5,
    testCount: 7,
    issues: [{ level: "cell", code: "CELL_NOT_EQUAL", testId: "expected-employee-status", message: "Expected Active; found Inactive." }]
  }
};

const server = createServer(async (request, response) => {
  if (request.url === "/webview.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(await readFile("dist/web/webview.js"));
  } else if (request.url === "/webview.css") {
    response.setHeader("content-type", "text/css");
    response.end(await readFile("dist/web/webview.css"));
  } else {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css"><script>window.__messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m)});</script></head><body><main id="app"></main><script src="/webview.js"></script></body></html>`);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Smoke server did not start.");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${address.port}`);
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), state);
await page.locator("text=CSV Contract Workbench").waitFor();
await page.locator("text=EmployeeId").first().click();
if (await page.locator(".metrics").count() !== 1) throw new Error("Metric layout did not render.");
await mkdir("artifacts/runtime", { recursive: true });
await page.screenshot({ path: "artifacts/runtime/webview-workbench.png", fullPage: true });
await browser.close();
server.close();
console.log("Webview smoke passed: artifacts/runtime/webview-workbench.png");
