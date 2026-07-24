import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const state = {
  type: "state",
  contractName: "contracts/customers.csvtest.yaml",
  csvName: "samples/customers.csv",
  csv: { headers: ["CustomerId", "CustomerName", "Email", "Status", "Notes"], rowCount: 12480 },
  contract: {
    version: 1,
    csv: { nullValues: [""], trimValues: false, caseSensitive: true },
    schema: {
      allowAdditionalColumns: true,
      columns: {
        CustomerId: { presence: "required", constraints: { notNull: true, unique: true, maxLength: 12, matches: "^C\\d+$" } },
        CustomerName: { presence: "required", constraints: { notNull: true, maxLength: 120 } },
        Email: { presence: "required", constraints: { notNull: true, maxLength: 254, matches: "^[^@]+@[^@]+$" } },
        Status: { presence: "required", constraints: { allowedValues: ["Active", "Inactive"] } },
        Notes: { presence: "optional", constraints: { maxLength: 250 } }
      }
    },
    rowTests: [
      { id: "expected-customer-exists", select: { CustomerId: "C000123" }, expect: { count: { exact: 1 } } },
      { id: "expected-customer-status", select: { CustomerId: "C000123" }, expect: { cells: { Status: { equals: "Active" } } } }
    ]
  },
  result: undefined
};

const failedState = {
  ...state,
  result: {
    valid: false,
    rowCount: 12480,
    columnCount: 5,
    testCount: 7,
    issueCount: 1,
    truncated: false,
    issues: [{ level: "cell", code: "CELL_NOT_EQUAL", testId: "expected-customer-status", message: "Expected Active; found Inactive." }]
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
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>CSV Contract Workbench</title><link rel="stylesheet" href="/webview.css"><script>window.__messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m)});</script></head><body><main id="app"></main><script src="/webview.js"></script></body></html>`);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Smoke server did not start.");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const consoleProblems = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") consoleProblems.push(`${message.type()}: ${message.text()}`);
});
await page.goto(`http://127.0.0.1:${address.port}`);
if ((await page.title()) !== "CSV Contract Workbench") throw new Error("Unexpected webview page title.");
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), state);
await page.locator("text=CSV Contract Workbench").waitFor();
await page.locator("text=CustomerId").first().click();
if (await page.locator(".metrics").count() !== 1) throw new Error("Metric layout did not render.");
await mkdir("artifacts/runtime", { recursive: true });
await mkdir("images", { recursive: true });
await page.screenshot({ path: "images/workbench-column-rules.png", fullPage: true });

await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), failedState);
await page.locator("text=Status").first().click();
if ((await page.locator("#allowedValues").inputValue()) !== "Active\nInactive") {
  throw new Error("Column selection did not update the inspector.");
}
await page.locator('[data-action="run"]').click();
const lastMessage = await page.evaluate(() => window.__messages.at(-1));
if (lastMessage?.type !== "run") throw new Error("Run tests did not send the expected host message.");
await page.screenshot({ path: "images/workbench-results.png", fullPage: true });
await page.screenshot({ path: "artifacts/runtime/webview-workbench.png", fullPage: true });
if (consoleProblems.length > 0) throw new Error(`Webview console problems:\n${consoleProblems.join("\n")}`);
await browser.close();
server.close();
console.log("Webview smoke passed: images/workbench-column-rules.png and images/workbench-results.png");
