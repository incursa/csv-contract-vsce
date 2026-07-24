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
  result: {
    ...failedState.result,
    issues: [{
      level: "cell",
      code: "CELL_NOT_EQUAL",
      testId: "expected-customer-status",
      message: "Expected Inactive; found Active."
    }]
  }
};
await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), editedFailedState);
await page.locator('[data-action="run"]').click();
const lastMessage = await page.evaluate(() => window.__messages.at(-1));
if (lastMessage?.type !== "run") throw new Error("Run tests did not send the expected host message.");
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
if (qaScreenshotDir) await page.screenshot({ path: `${qaScreenshotDir}/mobile-row-test-editor.png`, fullPage: false });
if (consoleProblems.length > 0) throw new Error(`Webview console problems:\n${consoleProblems.join("\n")}`);
await browser.close();
server.close();
console.log("Webview smoke passed: images/workbench-column-rules.png and images/workbench-results.png");
