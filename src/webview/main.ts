import "@incursa/ui-kit/dist/inc-design-language.css";
import "./workbench.css";
import type { CsvContract, ValidationResult } from "../core/model";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.querySelector<HTMLElement>("#app")!;
let contract: CsvContract | undefined;
let contractName = "contract.csvtest.yaml";
let csvName = "Choose a CSV file";
let csv: { headers: string[]; rowCount: number } | undefined;
let result: ValidationResult | undefined;
let selectedColumn = "";
let selectedRowTestIndex = -1;
let columnsScrollTop = 0;

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}

function columnSummary(name: string): string {
  const c = contract!.schema.columns[name].constraints ?? {};
  return [
    c.notNull ? "not null" : undefined,
    c.unique ? "unique" : undefined,
    c.maxLength !== undefined ? `max ${c.maxLength}` : undefined,
    c.matches ? "regex" : undefined,
    c.allowedValues?.length ? `${c.allowedValues.length} allowed` : undefined
  ].filter(Boolean).join(" · ") || "No constraints";
}

function columnOptions(names: string[], selected: string): string {
  return names.map((name) =>
    `<option value="${escape(name)}" ${name === selected ? "selected" : ""}>${escape(name)}</option>`
  ).join("");
}

function rowTestSummary(test: NonNullable<CsvContract["rowTests"]>[number]): string {
  const selectors = Object.entries(test.select).map(([key, value]) => `${key} = "${value}"`).join(" · ");
  const cellCount = Object.keys(test.expect.cells ?? {}).length;
  const expectation = cellCount > 0
    ? `${cellCount} cell ${cellCount === 1 ? "check" : "checks"}`
    : test.expect.count?.exact !== undefined
      ? `exactly ${test.expect.count.exact} ${test.expect.count.exact === 1 ? "match" : "matches"}`
      : "row count";
  return `${selectors} · ${expectation}`;
}

function renderRowTestEditor(names: string[]): string {
  const rowTests = contract?.rowTests ?? [];
  const test = rowTests[selectedRowTestIndex];
  if (!test) {
    return `<div class="row-test-editor row-test-editor--empty">
      <h3>No test selected</h3>
      <p>Add a row test to define a selector, expected match count, or exact cell values.</p>
    </div>`;
  }
  const selectors = Object.entries(test.select);
  const cells = Object.entries(test.expect.cells ?? {});
  const count = test.expect.count ?? {};
  return `<div class="row-test-editor" aria-label="Edit row and cell test">
    <div class="row-test-editor__heading">
      <div><span class="editor-eyebrow">Selected test</span><h3>Edit row &amp; cell test</h3></div>
      <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm danger-button" data-action="delete-row-test">Delete</button>
    </div>
    <div class="row-test-basics">
      <label>Test ID
        <input id="rowTestId" class="form-control" required pattern="[a-z0-9][a-z0-9._-]*" value="${escape(test.id)}">
      </label>
      <label>Display name
        <input id="rowTestName" class="form-control" value="${escape(test.name ?? "")}" placeholder="Optional description">
      </label>
    </div>
    <fieldset class="test-editor-section">
      <legend>Find rows where</legend>
      <p>Every selector must match the raw CSV value.</p>
      <div class="test-editor-rows">
        ${selectors.map(([column, value], index) => `<div class="test-editor-row" data-selector-row>
          <label><span class="sr-only">Selector column</span><select class="form-select" data-selector-column>${columnOptions(names, column)}</select></label>
          <label><span class="sr-only">Selector value</span><input class="form-control" data-selector-value value="${escape(value)}" placeholder="Exact value"></label>
          <button type="button" class="icon-button" data-action="remove-selector" data-index="${index}" aria-label="Remove selector" ${selectors.length === 1 ? "disabled" : ""}>×</button>
        </div>`).join("")}
      </div>
      <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-selector" ${selectors.length >= names.length ? "disabled" : ""}>Add selector</button>
    </fieldset>
    <fieldset class="test-editor-section">
      <legend>Expected matching rows</legend>
      <p>Use exact for row existence (1) or absence (0), or set a range.</p>
      <div class="count-grid">
        <label>Exact<input id="countExact" class="form-control" type="number" min="0" value="${escape(count.exact ?? "")}" placeholder="—"></label>
        <label>Minimum<input id="countMin" class="form-control" type="number" min="0" value="${escape(count.min ?? "")}" placeholder="—"></label>
        <label>Maximum<input id="countMax" class="form-control" type="number" min="0" value="${escape(count.max ?? "")}" placeholder="—"></label>
      </div>
    </fieldset>
    <fieldset class="test-editor-section">
      <legend>Expected cell values</legend>
      <p>Check exact values on every matching row.</p>
      <div class="test-editor-rows">
        ${cells.map(([column, expectation], index) => `<div class="test-editor-row" data-cell-row>
          <label><span class="sr-only">Cell column</span><select class="form-select" data-cell-column>${columnOptions(names, column)}</select></label>
          <label><span class="sr-only">Expected cell value</span><input class="form-control" data-cell-value value="${escape(expectation.equals)}" placeholder="Expected value"></label>
          <button type="button" class="icon-button" data-action="remove-cell" data-index="${index}" aria-label="Remove cell expectation">×</button>
        </div>`).join("") || `<p class="empty compact-empty">No exact cell checks configured.</p>`}
      </div>
      <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-cell" ${cells.length >= names.length ? "disabled" : ""}>Add cell check</button>
    </fieldset>
  </div>`;
}

function render(): void {
  if (!contract) {
    app.innerHTML = `<div class="workbench-loading">Loading contract…</div>`;
    return;
  }
  const names = Object.keys(contract.schema.columns);
  if (!selectedColumn || !contract.schema.columns[selectedColumn]) selectedColumn = names[0] ?? "";
  const rowTests = contract.rowTests ?? [];
  if (rowTests.length === 0) {
    selectedRowTestIndex = -1;
  } else if (selectedRowTestIndex < 0 || selectedRowTestIndex >= rowTests.length) {
    selectedRowTestIndex = 0;
  }
  const selected = contract.schema.columns[selectedColumn];
  const constraints = selected?.constraints ?? {};
  const issues = result?.issues ?? [];
  app.innerHTML = `
    <header class="workbench-header">
      <h1>CSV Contract Workbench</h1>
      <p>Build, inspect, and run reusable YAML contracts against CSV exports.</p>
    </header>
    <section class="inc-card workbench-target">
      <div>
        <h2>Test target</h2>
        <span class="field-label">SOURCE CSV</span>
        <code>${escape(csvName)}</code>
      </div>
      <div>
        <span class="field-label">CONTRACT</span>
        <code>${escape(contractName)}</code>
      </div>
      <div class="workbench-actions">
        <button class="inc-btn inc-btn--outline-secondary" data-action="choose-csv">Import CSV</button>
        <button class="inc-btn inc-btn--outline-secondary" data-action="open-yaml">Open YAML</button>
        <button class="inc-btn inc-btn--primary" data-action="run">Run tests</button>
      </div>
    </section>
    <section class="metrics" aria-label="Contract metrics">
      ${[
        ["Columns", csv?.headers.length ?? names.length],
        ["Rows", csv?.rowCount ?? "—"],
        ["Tests", names.length + (contract.rowTests?.length ?? 0)],
        ["Failures", result ? issues.length : "—"]
      ].map(([label, value]) => `<article class="inc-card metric"><span>${label}</span><strong>${escape(value)}</strong></article>`).join("")}
    </section>
    <section class="split">
      <article class="inc-card pane columns-pane">
        <div class="pane-heading"><div><h2>Imported columns</h2><p>${names.length} declared columns</p></div></div>
        <div class="columns-table-overflow">
          <div class="columns-table-shell" role="table" aria-label="Declared columns" aria-rowcount="${names.length + 1}">
            <div class="columns-table-header columns-grid" role="row">
              <span role="columnheader">Presence</span><span role="columnheader">Column</span><span role="columnheader">Constraints</span>
            </div>
            <div class="columns-scroll" role="rowgroup" tabindex="0" aria-label="Scrollable declared columns">
              ${names.map((name, index) => {
                const definition = contract!.schema.columns[name];
                return `<div class="column-row columns-grid ${name === selectedColumn ? "column-row--selected" : ""}" role="row" aria-rowindex="${index + 2}" aria-selected="${name === selectedColumn}" tabindex="0" data-column="${escape(name)}">
                  <span role="cell"><span class="presence-label presence-label--${escape(definition.presence)}">${escape(definition.presence)}</span></span>
                  <span role="cell"><code>${escape(name)}</code></span>
                  <span role="cell">${escape(columnSummary(name))}</span>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
      </article>
      <article class="inc-card pane inspector">
        <h2>Column inspector</h2>
        <code class="column-name">${escape(selectedColumn)}</code>
        <label>Presence
          <select id="presence" class="form-select">
            <option value="required" ${selected?.presence === "required" ? "selected" : ""}>Required</option>
            <option value="optional" ${selected?.presence === "optional" ? "selected" : ""}>Optional</option>
          </select>
        </label>
        <label class="check"><input id="notNull" type="checkbox" ${constraints.notNull ? "checked" : ""}> <span><strong>Not null</strong><small>Reject configured null values</small></span></label>
        <label class="check"><input id="unique" type="checkbox" ${constraints.unique ? "checked" : ""}> <span><strong>Unique</strong><small>No duplicate non-null values</small></span></label>
        <label>Maximum length<input id="maxLength" class="form-control" type="number" min="0" value="${escape(constraints.maxLength ?? "")}"></label>
        <label>Allowed values<textarea id="allowedValues" class="form-control" rows="3" placeholder="One value per line">${escape(constraints.allowedValues?.join("\n") ?? "")}</textarea></label>
        <label>Regex pattern<input id="matches" class="form-control" value="${escape(constraints.matches ?? "")}" placeholder="^\\d+$"></label>
      </article>
    </section>
    <section class="split lower">
      <article class="inc-card pane row-tests-pane">
        <div class="pane-heading"><div><h2>Row &amp; cell tests</h2><p>Selectors use declared columns and exact raw string values.</p></div><button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-row-test">Add test</button></div>
        <div class="row-test-layout">
          <div class="test-list" role="listbox" aria-label="Row and cell tests">
            ${rowTests.map((test, index) => `<button type="button" class="test-row ${index === selectedRowTestIndex ? "test-row--selected" : ""}" data-row-test-index="${index}" role="option" aria-selected="${index === selectedRowTestIndex}">
              <span class="test-row__title"><code>${escape(test.id)}</code><span class="test-row__action">Edit</span></span>
              <span>${escape(rowTestSummary(test))}</span>
            </button>`).join("") || `<p class="empty">No row tests yet.</p>`}
          </div>
          ${renderRowTestEditor(names)}
        </div>
      </article>
      <article class="inc-card pane">
        <div class="pane-heading"><div><h2>Latest results</h2><p>${result ? `${result.valid ? "Passed" : "Failed"} · ${result.rowCount} rows scanned` : "Run the contract to see results."}</p></div></div>
        <div class="results">
          ${result ? (issues.length ? issues.slice(0, 10).map((issue) => `<div class="result result--fail"><span>FAIL</span><code>${escape(issue.testId ?? issue.code)}</code><p>${escape(issue.message)}</p></div>`).join("") : `<div class="result result--pass"><span>PASS</span><code>all-tests</code><p>All configured checks passed.</p></div>`) : ""}
        </div>
      </article>
    </section>`;
  const columnsScroll = app.querySelector<HTMLElement>(".columns-scroll");
  if (columnsScroll) columnsScroll.scrollTop = columnsScrollTop;
  bind();
}

function saveSelected(): void {
  if (!contract || !selectedColumn) return;
  const definition = contract.schema.columns[selectedColumn];
  definition.presence = (document.querySelector<HTMLSelectElement>("#presence")?.value ?? "required") as "required" | "optional";
  definition.constraints ??= {};
  definition.constraints.notNull = document.querySelector<HTMLInputElement>("#notNull")?.checked ?? false;
  definition.constraints.unique = document.querySelector<HTMLInputElement>("#unique")?.checked ?? false;
  const maxLength = document.querySelector<HTMLInputElement>("#maxLength")?.value;
  definition.constraints.maxLength = maxLength ? Number(maxLength) : undefined;
  const matches = document.querySelector<HTMLInputElement>("#matches")?.value.trim();
  definition.constraints.matches = matches || undefined;
  const allowed = document.querySelector<HTMLTextAreaElement>("#allowedValues")?.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  definition.constraints.allowedValues = allowed?.length ? allowed : undefined;
  vscode.postMessage({ type: "updateContract", contract });
}

function optionalCount(id: string): number | undefined {
  const value = document.querySelector<HTMLInputElement>(`#${id}`)?.value;
  return value === undefined || value === "" ? undefined : Math.max(0, Number.parseInt(value, 10));
}

function saveSelectedRowTest(post = true): void {
  const test = contract?.rowTests?.[selectedRowTestIndex];
  if (!test) return;
  test.id = document.querySelector<HTMLInputElement>("#rowTestId")?.value.trim() || test.id;
  const name = document.querySelector<HTMLInputElement>("#rowTestName")?.value.trim();
  test.name = name || undefined;
  test.select = Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>("[data-selector-row]")).map((row) => [
      row.querySelector<HTMLSelectElement>("[data-selector-column]")!.value,
      row.querySelector<HTMLInputElement>("[data-selector-value]")!.value
    ])
  );
  const exact = optionalCount("countExact");
  const min = optionalCount("countMin");
  const max = optionalCount("countMax");
  const count = { exact, min, max };
  test.expect.count = Object.values(count).some((value) => value !== undefined) ? count : undefined;
  const cells = Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>("[data-cell-row]")).map((row) => [
      row.querySelector<HTMLSelectElement>("[data-cell-column]")!.value,
      { equals: row.querySelector<HTMLInputElement>("[data-cell-value]")!.value }
    ])
  );
  test.expect.cells = Object.keys(cells).length > 0 ? cells : undefined;
  if (!test.expect.count && !test.expect.cells) test.expect.count = { exact: 1 };
  if (post) vscode.postMessage({ type: "updateContract", contract });
}

function firstUnusedColumn(used: string[]): string | undefined {
  return Object.keys(contract?.schema.columns ?? {}).find((name) => !used.includes(name));
}

function bind(): void {
  app.querySelectorAll<HTMLElement>("[data-column]").forEach((row) => row.addEventListener("click", () => {
    columnsScrollTop = row.closest<HTMLElement>(".columns-scroll")?.scrollTop ?? columnsScrollTop;
    selectedColumn = row.dataset.column ?? selectedColumn;
    render();
  }));
  app.querySelectorAll<HTMLElement>("[data-column]").forEach((row) => row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    row.click();
  }));
  app.querySelector<HTMLElement>(".columns-scroll")?.addEventListener("scroll", (event) => {
    columnsScrollTop = (event.currentTarget as HTMLElement).scrollTop;
  });
  ["presence", "notNull", "unique", "maxLength", "allowedValues", "matches"].forEach((id) =>
    document.querySelector(`#${id}`)?.addEventListener("change", saveSelected)
  );
  app.querySelectorAll<HTMLElement>("[data-row-test-index]").forEach((row) => row.addEventListener("click", () => {
    selectedRowTestIndex = Number(row.dataset.rowTestIndex);
    render();
  }));
  ["rowTestId", "rowTestName", "countExact", "countMin", "countMax"].forEach((id) =>
    document.querySelector(`#${id}`)?.addEventListener("change", () => saveSelectedRowTest())
  );
  app.querySelectorAll("[data-selector-column], [data-selector-value], [data-cell-column], [data-cell-value]").forEach((field) =>
    field.addEventListener("change", () => saveSelectedRowTest())
  );
  app.querySelector('[data-action="choose-csv"]')?.addEventListener("click", () => vscode.postMessage({ type: "chooseCsv" }));
  app.querySelector('[data-action="open-yaml"]')?.addEventListener("click", () => vscode.postMessage({ type: "openYaml" }));
  app.querySelector('[data-action="run"]')?.addEventListener("click", () => vscode.postMessage({ type: "run" }));
  app.querySelector('[data-action="add-row-test"]')?.addEventListener("click", () => {
    if (!contract) return;
    const id = `row-test-${(contract.rowTests?.length ?? 0) + 1}`;
    contract.rowTests ??= [];
    contract.rowTests.push({ id, select: { [selectedColumn]: "" }, expect: { count: { exact: 1 } } });
    selectedRowTestIndex = contract.rowTests.length - 1;
    render();
    vscode.postMessage({ type: "updateContract", contract });
  });
  app.querySelector('[data-action="delete-row-test"]')?.addEventListener("click", () => {
    if (!contract?.rowTests || selectedRowTestIndex < 0) return;
    contract.rowTests.splice(selectedRowTestIndex, 1);
    selectedRowTestIndex = Math.min(selectedRowTestIndex, contract.rowTests.length - 1);
    render();
    vscode.postMessage({ type: "updateContract", contract });
  });
  app.querySelector('[data-action="add-selector"]')?.addEventListener("click", () => {
    const test = contract?.rowTests?.[selectedRowTestIndex];
    if (!test) return;
    saveSelectedRowTest(false);
    const column = firstUnusedColumn(Object.keys(test.select));
    if (!column) return;
    test.select[column] = "";
    render();
    vscode.postMessage({ type: "updateContract", contract });
  });
  app.querySelectorAll<HTMLElement>('[data-action="remove-selector"]').forEach((button) => button.addEventListener("click", () => {
    const test = contract?.rowTests?.[selectedRowTestIndex];
    if (!test || Object.keys(test.select).length <= 1) return;
    saveSelectedRowTest(false);
    const key = Object.keys(test.select)[Number(button.dataset.index)];
    delete test.select[key];
    render();
    vscode.postMessage({ type: "updateContract", contract });
  }));
  app.querySelector('[data-action="add-cell"]')?.addEventListener("click", () => {
    const test = contract?.rowTests?.[selectedRowTestIndex];
    if (!test) return;
    saveSelectedRowTest(false);
    test.expect.cells ??= {};
    const column = firstUnusedColumn(Object.keys(test.expect.cells));
    if (!column) return;
    test.expect.cells[column] = { equals: "" };
    render();
    vscode.postMessage({ type: "updateContract", contract });
  });
  app.querySelectorAll<HTMLElement>('[data-action="remove-cell"]').forEach((button) => button.addEventListener("click", () => {
    const test = contract?.rowTests?.[selectedRowTestIndex];
    if (!test) return;
    saveSelectedRowTest(false);
    const key = Object.keys(test.expect.cells ?? {})[Number(button.dataset.index)];
    if (key) delete test.expect.cells?.[key];
    render();
    vscode.postMessage({ type: "updateContract", contract });
  }));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") {
    contract = message.contract;
    contractName = message.contractName;
    csvName = message.csvName ?? "Choose a CSV file";
    csv = message.csv;
    result = message.result;
    render();
  } else if (message.type === "error") {
    app.innerHTML = `<div class="inc-alert inc-alert--danger">${escape(message.message)}</div>`;
  }
});

vscode.postMessage({ type: "ready" });
