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

function render(): void {
  if (!contract) {
    app.innerHTML = `<div class="workbench-loading">Loading contract…</div>`;
    return;
  }
  const names = Object.keys(contract.schema.columns);
  if (!selectedColumn || !contract.schema.columns[selectedColumn]) selectedColumn = names[0] ?? "";
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
        <div class="inc-table-responsive">
          <table class="inc-table">
            <thead><tr><th>Presence</th><th>Column</th><th>Constraints</th></tr></thead>
            <tbody>
              ${names.map((name) => {
                const definition = contract!.schema.columns[name];
                return `<tr class="${name === selectedColumn ? "inc-table__row--selected" : ""}" data-column="${escape(name)}">
                  <td><span class="inc-badge ${definition.presence === "required" ? "inc-badge--primary" : ""}">${escape(definition.presence)}</span></td>
                  <td><code>${escape(name)}</code></td>
                  <td>${escape(columnSummary(name))}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
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
      <article class="inc-card pane">
        <div class="pane-heading"><div><h2>Row &amp; cell tests</h2><p>Selectors use declared columns and exact raw string values.</p></div><button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-row-test">Add test</button></div>
        <div class="test-list">
          ${(contract.rowTests ?? []).map((test) => `<div class="test-row"><code>${escape(test.id)}</code><span>${escape(Object.entries(test.select).map(([key, value]) => `${key} = "${value}"`).join(" · "))}</span></div>`).join("") || `<p class="empty">No row tests yet.</p>`}
        </div>
      </article>
      <article class="inc-card pane">
        <div class="pane-heading"><div><h2>Latest results</h2><p>${result ? `${result.valid ? "Passed" : "Failed"} · ${result.rowCount} rows scanned` : "Run the contract to see results."}</p></div></div>
        <div class="results">
          ${result ? (issues.length ? issues.slice(0, 10).map((issue) => `<div class="result result--fail"><span>FAIL</span><code>${escape(issue.testId ?? issue.code)}</code><p>${escape(issue.message)}</p></div>`).join("") : `<div class="result result--pass"><span>PASS</span><code>all-tests</code><p>All configured checks passed.</p></div>`) : ""}
        </div>
      </article>
    </section>`;
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

function bind(): void {
  app.querySelectorAll<HTMLElement>("[data-column]").forEach((row) => row.addEventListener("click", () => {
    selectedColumn = row.dataset.column ?? selectedColumn;
    render();
  }));
  ["presence", "notNull", "unique", "maxLength", "allowedValues", "matches"].forEach((id) =>
    document.querySelector(`#${id}`)?.addEventListener("change", saveSelected)
  );
  app.querySelector('[data-action="choose-csv"]')?.addEventListener("click", () => vscode.postMessage({ type: "chooseCsv" }));
  app.querySelector('[data-action="open-yaml"]')?.addEventListener("click", () => vscode.postMessage({ type: "openYaml" }));
  app.querySelector('[data-action="run"]')?.addEventListener("click", () => vscode.postMessage({ type: "run" }));
  app.querySelector('[data-action="add-row-test"]')?.addEventListener("click", () => {
    if (!contract) return;
    const id = `row-test-${(contract.rowTests?.length ?? 0) + 1}`;
    contract.rowTests ??= [];
    contract.rowTests.push({ id, select: { [selectedColumn]: "" }, expect: { count: { exact: 1 } } });
    vscode.postMessage({ type: "updateContract", contract });
  });
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
