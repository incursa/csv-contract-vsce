import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const state = {
  type: "state",
  contractName: "contracts/customers.csvtest.yaml",
  targetNames: [
    "../exports/customers-east.csv",
    "../exports/customers-west.csv",
    "https://example.com/exports/customers.csv"
  ],
  configuredTargetCount: 3,
  usingConfiguredTargets: true,
  runs: [],
  contract: {
    version: 1,
    targets: [
      { path: "../exports/customers-east.csv" },
      { path: "../exports/customers-west.csv" },
      { url: "https://example.com/exports/customers.csv" }
    ],
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
  runs: [{
    target: "../exports/customers-east.csv",
    result: {
      valid: false,
      rowCount: 12480,
      columnCount: 5,
      testCount: 7,
      issueCount: 1,
      truncated: false,
      issues: [{ level: "cell", code: "CELL_NOT_EQUAL", testId: "expected-customer-status", message: "Expected Active; found Inactive." }]
    }
  }]
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
if ((await page.locator(".configured-target-row").count()) !== 3) throw new Error("Configured path and URL targets did not render.");
if ((await page.locator(".target-type").allTextContents()).join(",") !== "PATH,PATH,URL") {
  throw new Error("Configured target types did not render correctly.");
}
if ((await page.locator('[data-action="open-target-vscode"]').count()) !== 3
  || (await page.locator('[data-action="open-target-external"]').count()) !== 3) {
  throw new Error("Configured targets do not expose both open actions.");
}
await page.locator('[data-action="open-target-vscode"]').first().click();
let openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "openTargetInVsCode" || openMessage.index !== 0) {
  throw new Error("Open in VS Code did not send the expected host message.");
}
await page.locator('[data-action="open-target-external"]').last().click();
openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "openTargetExternally" || openMessage.index !== 2) {
  throw new Error("Open externally did not send the expected host message.");
}
await page.locator('[data-action="open-active-target-vscode"]').click();
openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "openActiveTargetInVsCode") {
  throw new Error("Opening the active test CSV in VS Code did not send the expected host message.");
}
await page.locator('[data-action="open-active-target-external"]').click();
openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "openActiveTargetExternally") {
  throw new Error("Opening the active test CSV externally did not send the expected host message.");
}
await page.locator('[data-action="generate-sql"]').click();
openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "generateSqlServerValidation") {
  throw new Error("Generating staging SQL did not send the expected host message.");
}
await page.locator('[data-action="import-sql-schema"]').click();
openMessage = await page.evaluate(() => window.__messages.at(-1));
if (openMessage?.type !== "importSqlServerSchema") {
  throw new Error("Importing a table schema did not send the expected host message.");
}
await mkdir("artifacts/runtime", { recursive: true });
await mkdir("images", { recursive: true });
await page.screenshot({ path: "images/workbench-column-rules.png", fullPage: true });

await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), failedState);
const resultsPosition = await page.evaluate(() => ({
  resultsTop: document.querySelector(".results-pane").getBoundingClientRect().top,
  columnsTop: document.querySelector(".columns-pane").getBoundingClientRect().top
}));
if (resultsPosition.resultsTop >= resultsPosition.columnsTop) {
  throw new Error(`Latest results must appear above the column editor: ${JSON.stringify(resultsPosition)}`);
}
await page.locator('[data-column="Status"]').click();
if ((await page.locator("#allowedValues").inputValue()) !== "Active\nInactive") {
  throw new Error("Column selection did not update the inspector.");
}
await page.locator('[data-row-test-index="1"]').click();
if ((await page.locator("#rowTestId").inputValue()) !== "expected-customer-status") {
  throw new Error("Row test selection did not open the expected editor.");
}
const expectedCell = page.locator("[data-cell-value]");
if ((await expectedCell.inputValue()) !== "Active") throw new Error("Cell expectation did not render for editing.");
await expectedCell.fill("Inactive");
await expectedCell.evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
let updateMessage = await page.evaluate(() => window.__messages.at(-1));
if (updateMessage?.type !== "updateContract" || updateMessage.contract.rowTests[1].expect.cells.Status.equals !== "Inactive") {
  throw new Error("Editing a cell expectation did not emit the updated contract.");
}
await page.locator('[data-action="add-selector"]').click();
if ((await page.locator("[data-selector-row]").count()) !== 2) throw new Error("Adding a row selector did not update the editor.");
await page.locator('[data-action="add-cell"]').click();
if ((await page.locator("[data-cell-row]").count()) !== 2) throw new Error("Adding a cell expectation did not update the editor.");
await page.locator('[data-action="add-row-test"]').click();
if ((await page.locator("[data-row-test-index]").count()) !== 3 || (await page.locator("#rowTestId").inputValue()) !== "row-test-3") {
  throw new Error("Adding a row test did not select an editable test.");
}
await page.locator('[data-action="delete-row-test"]').click();
if ((await page.locator("[data-row-test-index]").count()) !== 2) throw new Error("Deleting a row test did not update the list.");
const editedContract = await page.evaluate(() =>
  window.__messages.filter((message) => message.type === "updateContract").at(-1).contract
);
const editedFailedState = {
  ...failedState,
  contract: editedContract,
  runs: [{
    target: "../exports/customers-east.csv",
    result: {
      ...failedState.runs[0].result,
      issues: [{
        level: "cell",
        code: "CELL_NOT_EQUAL",
        testId: "expected-customer-status",
        message: "Expected Inactive; found Active."
      }]
    }
  }]
};
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), editedFailedState);
await page.locator('[data-action="run"]').click();
const lastMessage = await page.evaluate(() => window.__messages.at(-1));
if (lastMessage?.type !== "run") throw new Error("Run tests did not send the expected host message.");
if (!await page.locator('[data-action="run"]').isDisabled() || await page.locator(".run-spinner").count() < 2) {
  throw new Error("Run tests did not immediately show a disabled spinner state.");
}
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), {
  type: "runState",
  running: true,
  target: "../exports/customers-east.csv",
  index: 1,
  total: 3
});
if (!await page.locator(".workbench-run-status").getByText("Testing 1 of 3").isVisible()) {
  throw new Error("Run progress did not identify the active target.");
}
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), {
  type: "runState",
  running: false
});
if (await page.locator(".workbench-run-status").count() !== 0 || await page.locator('[data-action="run"]').isDisabled()) {
  throw new Error("Run progress did not clear when validation finished.");
}
await page.locator('[data-action="add-target-url"]').click();
const addUrlMessage = await page.evaluate(() => window.__messages.at(-1));
if (addUrlMessage?.type !== "addTargetUrl") throw new Error("Add URL did not send the expected host message.");
await page.screenshot({ path: "images/workbench-results.png", fullPage: true });
await page.screenshot({ path: "artifacts/runtime/webview-workbench.png", fullPage: true });

const largeColumns = Object.fromEntries(Array.from({ length: 202 }, (_, index) => {
  const name = index === 0 ? "CustomerId" : `Column_${String(index + 1).padStart(3, "0")}`;
  return [name, { presence: "required", constraints: { maxLength: 24 } }];
}));
const largeState = {
  ...state,
  csv: { headers: Object.keys(largeColumns), rowCount: 500000 },
  contract: {
    ...state.contract,
    schema: { ...state.contract.schema, columns: largeColumns },
    rowTests: [{ id: "large-row-check", select: { CustomerId: "C000123" }, expect: { count: { exact: 1 } } }]
  }
};
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), largeState);
if ((await page.locator(".columns-pane [data-column]").count()) !== 202) throw new Error("Large column list did not render completely.");
const overflow = await page.locator(".columns-scroll").evaluate((element) => ({
  clientHeight: element.clientHeight,
  scrollHeight: element.scrollHeight
}));
if (overflow.scrollHeight <= overflow.clientHeight) throw new Error("Large column list is not contained by a vertical scroller.");
const topAlignment = await page.evaluate(() => {
  const columns = document.querySelector(".columns-pane").getBoundingClientRect();
  const inspector = document.querySelector(".inspector").getBoundingClientRect();
  return Math.abs(columns.top - inspector.top);
});
if (topAlignment > 1) throw new Error(`Column inspector is not top aligned (${topAlignment}px difference).`);
await page.locator(".columns-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
await page.locator('[data-column="Column_202"]').click();
if ((await page.locator(".column-name").textContent()) !== "Column_202") {
  throw new Error("A column at the end of the overflow list could not be selected.");
}
const retainedScroll = await page.locator(".columns-scroll").evaluate((element) => element.scrollTop);
if (retainedScroll <= 0) throw new Error("Selecting a column reset the large column list to the top.");
const stickyHeader = await page.evaluate(() => {
  const scroller = document.querySelector(".columns-scroll");
  const header = document.querySelector(".columns-table-header");
  return {
    scrollerTop: scroller.getBoundingClientRect().top,
    headerBottom: header.getBoundingClientRect().bottom,
    position: getComputedStyle(header).position,
    overflow: getComputedStyle(scroller).overflow
  };
});
if (Math.abs(stickyHeader.scrollerTop - stickyHeader.headerBottom) > 1) {
  throw new Error(`Column header is not fixed above the overflow region: ${JSON.stringify(stickyHeader)}`);
}
const presenceStyle = await page.locator(".presence-label").first().evaluate((element) => {
  const style = getComputedStyle(element);
  return { color: style.color, background: style.backgroundColor, text: element.textContent };
});
if (presenceStyle.color === presenceStyle.background || presenceStyle.text !== "required") {
  throw new Error("Presence status does not render as a readable label.");
}
const qaScreenshotDir = process.env.CSV_CONTRACT_QA_SCREENSHOT_DIR;
if (qaScreenshotDir) {
  await mkdir(qaScreenshotDir, { recursive: true });
  await page.locator(".split").first().screenshot({ path: `${qaScreenshotDir}/large-column-workbench.png` });
}

await page.setViewportSize({ width: 600, height: 900 });
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), state);
const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (mobileOverflow > 1) throw new Error(`Workbench has ${mobileOverflow}px of page-level horizontal overflow at 600px.`);
await page.setViewportSize({ width: 1170, height: 900 });
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), failedState);
const compactOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (compactOverflow > 1) throw new Error(`Workbench has ${compactOverflow}px of page-level horizontal overflow at 1170px.`);
const compactLayout = await page.evaluate(() => ({
  targetColumns: getComputedStyle(document.querySelector(".workbench-target")).gridTemplateColumns,
  rowTestColumns: getComputedStyle(document.querySelector(".row-test-layout")).gridTemplateColumns
}));
if (compactLayout.targetColumns.split(" ").length !== 1 || compactLayout.rowTestColumns.split(" ").length !== 1) {
  throw new Error(`Workbench did not stack crowded controls at 1170px: ${JSON.stringify(compactLayout)}`);
}
if (qaScreenshotDir) await page.screenshot({ path: `${qaScreenshotDir}/mobile-row-test-editor.png`, fullPage: false });
if (consoleProblems.length > 0) throw new Error(`Webview console problems:\n${consoleProblems.join("\n")}`);
await browser.close();
server.close();
console.log("Webview smoke passed: images/workbench-column-rules.png and images/workbench-results.png");
