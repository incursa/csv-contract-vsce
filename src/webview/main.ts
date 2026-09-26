import { renderResults, type DisplayRun } from "../results-view";
import { coverageDiagnostics } from "../core/coverage";
import "@incursa/ui-kit/dist/inc-design-language.css";
import "./workbench.css";
import type { CsvContract, SqlServerIntegratedConnection } from "../core/model";
import { predicateDescription } from "../core/predicate";
import { renderPredicate, readPredicate, editPredicateTree } from "./rule-editor";
import { insertPreset, presetCatalog, type PresetInput } from "../core/presets";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();
let documentVersion: number | undefined;
const vscode = { postMessage: (message: { type: string; [key: string]: unknown }) => api.postMessage({ ...message, documentVersion }) };
const app = document.querySelector<HTMLElement>("#app")!;
app.addEventListener("click", event => {
  const treeButton = (event.target as HTMLElement).closest<HTMLElement>("[data-predicate-action]");
  if (treeButton && contract) {
    try { editPredicateTree(treeButton, Object.keys(contract.schema.columns)); }
    catch (error) { treeButton.closest("form")!.querySelector('[data-rule-error]')!.textContent = String(error); }
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="jump-rule"]');
  if (button) vscode.postMessage({ type: "jumpRule", ruleId: button.dataset.rule });
});
let contract: CsvContract | undefined;
let contractName = "contract.csvtest.yaml";
let targetNames: string[] = [];
let connectionOverview: string[] = [];
let fileTargetCount = 0;
let configuredTargetCount = 0;
let usingConfiguredTargets = false;
let runs: DisplayRun[] = [];
let stale = false;
let live = false;
let resultFilter = "";
let runNotice = "";
let watchInputs = false;
let dirty = false;
let parseError = "";
let running = false;
let runningTarget = "";
let runningTargetIndex = 0;
let runningTargetCount = 0;
let selectedColumn = "";
let selectedRowTestIndex = -1;
let columnsScrollTop = 0;

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}

function configuredSqlTargets(value: CsvContract): Array<{
  connection?: string;
  integratedConnection?: SqlServerIntegratedConnection;
  schema: string;
  table: string;
  objectType?: "table" | "view";
  columnMap?: Record<string, string>;
}> {
  if (value.sqlServer?.targets?.length) return value.sqlServer.targets;
  if (value.sqlServer?.schema && value.sqlServer.table) {
    return [{
      connection: value.sqlServer.connection ?? "",
      integratedConnection: value.sqlServer.integratedConnection,
      schema: value.sqlServer.schema,
      table: value.sqlServer.table,
      objectType: value.sqlServer.objectType,
      columnMap: value.sqlServer.columnMap
    }];
  }
  return [];
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
      <div class="row-test-editor__actions">
        <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="preview-rule" data-rule="${escape(test.id)}">Run preview</button>
        <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm danger-button" data-action="delete-row-test">Delete</button>
      </div>
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
  const toolsOpen = app.querySelector(".workbench-tools")?.hasAttribute("open") ?? false;
  if (!contract) {
    app.innerHTML = parseError ? `<div role="alert">${escape(parseError)}</div>` : `<div class="workbench-loading">Loading contract…</div>`;
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
  const configuredTargets = contract.targets ?? [];
  const sqlTargets = configuredSqlTargets(contract);
  const conditionalRules = [...(contract.rules ?? []), ...(contract.sqlServer?.conditionalRules ?? [])];
  const groupRules = contract.groupRules ?? [];
  const errorCount = runs.reduce((total, run) => total + (run.result?.errorCount ?? 0), 0);
  const warningCount = runs.reduce((total, run) => total + (run.result?.warningCount ?? 0), 0);
  const issueCount = runs.reduce((total, run) => total + (run.result?.issueCount ?? 0), 0);
  const rowCount = runs.length > 0
    ? runs.reduce((total, run) => total + (run.result?.rowCount ?? 0), 0)
    : "—";
  const sourceLabel = targetNames.length === 0
    ? "No test target selected"
    : targetNames.length === 1
      ? targetNames[0]
      : `${targetNames.length} test targets`;
  const runningDetail = runningTarget
    ? `Testing ${runningTargetIndex} of ${runningTargetCount}: ${runningTarget}`
    : `Preparing ${runningTargetCount || targetNames.length} test target${(runningTargetCount || targetNames.length) === 1 ? "" : "s"}…`;
  app.setAttribute("aria-busy", String(running));
  app.innerHTML = `
    ${parseError ? `<div role="alert" class="inc-alert inc-alert--danger">Invalid draft; execution paused: ${escape(parseError)}</div>` : ""}
    <header class="workbench-header">
      <h1>CSV Contract Workbench</h1>
      <p>Build, inspect, and run reusable YAML contracts against CSV exports and SQL Server tables.</p>
    </header>
    <section class="inc-card workbench-target">
      <div class="target-overview">
        <div>
          <h2>Test target</h2>
          <span class="field-label">TARGET</span>
          <code>${escape(sourceLabel)}</code>
        </div>
        <div>
          <span class="field-label">CONTRACT</span>
          <code>${escape(contractName)}</code><span class="target-save-state">${dirty ? "Unsaved draft" : "Saved"}</span>
        </div>
      </div>
      <div class="workbench-actions">
        <button class="inc-btn inc-btn--outline-secondary" data-action="choose-csv">Select test CSV</button>
        <button class="inc-btn inc-btn--outline-secondary" data-action="open-yaml">Open YAML</button>
        ${running ? `<button class="inc-btn inc-btn--outline-secondary" data-action="cancel">Cancel execution</button>` : ""}
        <button class="inc-btn inc-btn--primary run-button" data-action="run" ${running ? "disabled aria-busy=\"true\"" : ""}>
          ${running ? `<span class="run-spinner run-spinner--button" aria-hidden="true"></span><span>Running…</span>` : "Run tests"}
        </button>
      </div>
      <details class="workbench-tools" ${toolsOpen ? "open" : ""}>
        <summary>More tools and settings</summary>
        <div class="workbench-tools__groups">
          <div class="workbench-tools__group"><h3>Sources and connections</h3>
            ${configuredTargetCount > 0 && !usingConfiguredTargets ? `<button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="use-configured-targets">Use configured targets</button>` : ""}
            ${fileTargetCount > 0 ? `<button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="open-active-target-vscode">Open CSV in VS Code</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="open-active-target-external">Open CSV externally</button>` : ""}
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="configure-sql">Configure SQL connection</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="edit-connection">Edit connection</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="preflight">Test connection / preflight</button>
          </div>
          <div class="workbench-tools__group"><h3>Contract design</h3>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="insert-template">Insert rule template</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="import-sql-schema">Import table schema</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="generate-sql">Generate staging SQL</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="create-baseline">Create schema baseline</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="review-baseline">Review schema drift</button>
          </div>
          <div class="workbench-tools__group"><h3>Runs and updates</h3>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="history">Run history</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="live">${live ? "Pause live tests" : "Enable live tests"}</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="watch-inputs">${watchInputs ? "Stop watching CSV input" : "Watch CSV input changes"}</button>
          </div>
        </div>
      </details>
      ${running ? `<div class="workbench-run-status" role="status" aria-live="polite">
        <span class="run-spinner" aria-hidden="true"></span>
        <div><strong>Running contract tests</strong><span title="${escape(runningTarget)}">${escape(runningDetail)}</span></div>
      </div>` : ""}
      <div class="configured-targets">
        <div class="configured-targets__heading">
          <div><span class="field-label">CONFIGURED TEST CSVs</span><p>Saved in this contract. Relative paths resolve from the contract file.</p></div>
          <div class="configured-targets__actions">
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-target-files">Add file paths</button>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-target-url">Add URL</button>
          </div>
        </div>
        <div class="configured-target-list">
          ${configuredTargets.map((target, index) => {
            const type = target.url !== undefined ? "URL" : "PATH";
            const value = target.url ?? target.path;
            return `<div class="configured-target-row">
              <span class="target-type">${type}</span>
              <code title="${escape(value)}">${escape(value)}</code>
              <div class="configured-target-row__actions">
                <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="open-target-vscode" data-index="${index}">Open in VS Code</button>
                <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="open-target-external" data-index="${index}">Open externally</button>
              </div>
              <button type="button" class="icon-button" data-action="remove-target" data-index="${index}" aria-label="Remove ${type.toLowerCase()} target">×</button>
            </div>`;
          }).join("") || `<p class="empty compact-empty">No saved targets. You can still select CSVs for this session.</p>`}
        </div>
      </div>
      <div class="configured-targets">
        <div class="configured-targets__heading">
          <div><span class="field-label">CONFIGURED SQL SERVER TARGETS</span><p>SQL-login secrets remain in Secret Storage. Windows-integrated targets store only server and database names.</p></div>
          <div class="configured-targets__actions">
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="add-sql-target">Add table or view</button>
          </div>
        </div>
        <div class="configured-target-list sql-target-list">
          ${sqlTargets.map((target, index) => {
            const type = (target.objectType ?? "table").toUpperCase();
            const mappingCount = Object.keys(target.columnMap ?? {}).length;
            const connectionLabel = target.integratedConnection
              ? `${target.integratedConnection.server}/${target.integratedConnection.database} (Windows)`
              : target.connection || "unconfigured";
            const value = connectionOverview[index] ?? `${connectionLabel}:${target.schema}.${target.table}`;
            return `<div class="configured-target-row sql-target-row">
              <span class="target-type">${type}</span>
              <code title="${escape(value)}">${escape(value)}</code>
              <span class="target-mapping-count">${mappingCount ? `${mappingCount} mapped` : "exact names"}</span>
              <button type="button" class="icon-button" data-action="remove-sql-target" data-index="${index}" aria-label="Remove SQL ${type.toLowerCase()} target">×</button>
            </div>`;
          }).join("") || `<p class="empty compact-empty">No SQL Server targets. Add a table or view from a configured read-only connection.</p>`}
        </div>
      </div>
    </section>
    <section class="metrics" aria-label="Contract metrics">
      ${[
        ["Targets", targetNames.length || "—"],
        ["Columns", names.length],
        ["Rows scanned", rowCount],
        ["Rules", names.length + (contract.rowTests?.length ?? 0) + (contract.rules?.length ?? 0) + (contract.groupRules?.length ?? 0)],
        ["Errors / warnings", runs.length > 0 ? `${errorCount} / ${warningCount}` : "—"]
      ].map(([label, value]) => `<article class="inc-card metric"><span>${label}</span><strong>${escape(value)}</strong></article>`).join("")}
    </section>
    <section class="inc-card pane results-pane">
      <p role="status">${stale ? "STALE — definitions or sources changed. " : ""}${live ? "Live tests active. " : ""}${escape(runNotice)}</p>
      <label>Search failures<input id="result-filter" type="search" class="form-control" value="${escape(resultFilter)}"></label>
      <div class="pane-heading">
        <div><h2>Latest results</h2><p>${runs.length > 0 ? `${runs.filter((run) => run.result?.valid && run.result.preview?.scope !== "sample").length} of ${runs.length} targets passed` : "Run the contract to see results."}</p></div>
        ${runs.length > 0 ? `<button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="export-issues">Export results${issueCount > 0 ? ` (${issueCount.toLocaleString()} issues)` : ""}</button>` : ""}
      </div>
      <div class="results">
        ${renderResults(runs, resultFilter, stale) || `<p>No test results yet.</p>`}
      </div>
    </section>
    <section class="inc-card pane advanced-rules-pane">
      <details><summary>Coverage and execution diagnostics</summary><ul>${coverageDiagnostics(contract).map(d => `<li>${escape(d)}</li>`).join("") || "<li>No known coverage gaps.</li>"}</ul></details>
      <details><summary>Add validation</summary>
        <p>Creates ordinary editable rules. Literals preserve leading zeros. Rules use this contract's trim, case and null settings. Date and regex SQL checks require client fallback.</p>
        <form id="preset-form">
          <label>Preset<select id="preset-kind" class="form-select">${presetCatalog.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          <label>Stable rule ID<input id="preset-id" class="form-control" required placeholder="employee-id-required"></label>
          <label>Column<select id="preset-column" class="form-select">${columnOptions(names, selectedColumn)}</select></label>
          <label>Literal / pattern / condition value<input id="preset-value" class="form-control"></label>
          <label>Allowed/prohibited values (one literal per line)<textarea id="preset-values" class="form-control"></textarea></label>
          <label>Minimum (also minimum population)<input id="preset-min" class="form-control"></label>
          <label>Maximum<input id="preset-max" class="form-control"></label>
          <label>Date bounds<select id="preset-date-anchor" class="form-select"><option value="">Fixed ISO dates</option><option value="today">Day offsets from today (UTC)</option><option value="now">Day offsets from execution instant</option></select></label>
          <label>Literal type<select id="preset-value-type" class="form-select"><option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean (true/false)</option></select></label>
          <label>Case policy<select id="preset-case" class="form-select"><option value="">Use contract setting</option><option value="true">Case sensitive</option><option value="false">Case insensitive</option></select></label>
          <label>Maximum decimal places (optional)<input id="preset-decimals" type="number" min="0" max="15" class="form-control"></label>
          <label>Composite identity columns (one per line; blank uses selected column)<textarea id="preset-columns" class="form-control"></textarea></label>
          <label>Duplicate policy<select id="preset-duplicates" class="form-select"><option value="reject">Reject duplicate keys</option><option value="allow">Allow duplicates</option></select></label>
          <label><input type="checkbox" id="preset-exclusive"> Exclude range endpoints</label>
          <label>Other / condition column<select id="preset-other" class="form-select">${columnOptions(names, names[0] ?? "")}</select></label>
          <label>Column comparison<select id="preset-comparison" class="form-select">${["equalsColumn", "notEqualsColumn", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].map(v => `<option>${v}</option>`).join("")}</select></label>
          <label>Null treatment<select id="preset-nulls" class="form-select"><option value="fail">Fail</option><option value="allow">Allow</option><option value="ignore">Ignore (exclude from selected rows)</option></select></label>
          <p>Uniqueness creates an identity. Allow nulls treats configured null markers as equal; Ignore excludes null-containing keys. Population sets schema.rowCount.min.</p>
          <button class="inc-btn inc-btn--primary" type="submit">Add validation</button><p id="preset-error" role="alert"></p>
        </form>
      </details>
      <div class="pane-heading">
        <div><h2>Conditional &amp; group rules</h2><p>${conditionalRules.length} conditional · ${groupRules.length} grouped</p></div>
        <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="open-yaml">Edit advanced rules in YAML</button>
      </div>
      <div class="rule-list">
        ${conditionalRules.map((rule) => `<article class="rule-card">
          <div class="rule-card__heading"><div class="rule-card__identity">
            <span class="rule-card__type">${escape((rule.severity ?? "error").toUpperCase())}</span><code>${escape(rule.id)}</code>
          </div><button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="preview-rule" data-rule="${escape(rule.id)}">Run preview</button></div>
          <p class="rule-card__summary">${escape(`${rule.when ? `When ${predicateDescription(rule.when)}, ` : "For every row, "}expect ${predicateDescription(rule.expect)}.`)}</p>
          <details class="visual-rule"><summary>Edit conditions</summary><form data-rule-editor="${escape(rule.id)}">
            <button type="button" class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-toggle-when>${rule.when ? "Remove condition selector" : "Add condition selector"}</button>
            <div data-rule-when>${rule.when ? `<h3>When</h3>${renderPredicate(rule.when, names)}` : ""}</div>
            <div data-rule-expect><h3>Expect</h3>${renderPredicate(rule.expect, names)}</div>
            <p>Literal values remain strings unless an unchanged existing literal is numeric. Changes apply to the draft; save normally.</p>
            <div class="rule-card__footer"><button type="submit" class="inc-btn inc-btn--primary inc-btn--sm">Apply rule changes</button><p role="alert" data-rule-error></p></div>
          </form></details>
        </article>`).join("")}
        ${groupRules.map((rule) => `<article class="rule-card">
          <div class="rule-card__heading"><div class="rule-card__identity"><span class="rule-card__type">GROUP</span><code>${escape(rule.id)}</code></div>
            <button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="preview-rule" data-rule="${escape(rule.id)}">Run preview</button></div>
          <p class="rule-card__summary">${escape(`Group by ${rule.groupBy.join(", ")}; require ${[...(rule.require.values ?? []), ...(rule.require.contains ?? []).map((value) => `contains ${value}`)].join(", ")} in ${rule.require.column}.`)}</p>
        </article>`).join("")}
        ${conditionalRules.length + groupRules.length === 0 ? `<p class="empty compact-empty">No conditional or grouped rules configured.</p>` : ""}
      </div>
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
    <section class="lower">
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
  app.querySelectorAll<HTMLElement>("[data-toggle-when]").forEach(button => button.addEventListener("click", () => {
    const holder = button.closest("form")!.querySelector("[data-rule-when]")!;
    if (holder.children.length) { holder.innerHTML = ""; button.textContent = "Add condition selector"; }
    else if (contract) { holder.innerHTML = `<h3>When</h3>${renderPredicate({ column: Object.keys(contract.schema.columns)[0], operator: "notNull" }, Object.keys(contract.schema.columns))}`; button.textContent = "Remove condition selector"; }
  }));
  app.querySelectorAll<HTMLFormElement>("[data-rule-editor]").forEach(form => form.addEventListener("submit", event => {
    event.preventDefault();
    try {
      if (!contract) return;
      const rule = contract.rules?.find(r => r.id === form.dataset.ruleEditor) ?? contract.sqlServer?.conditionalRules?.find(r => r.id === form.dataset.ruleEditor);
      if (!rule) throw new Error("Rule no longer exists.");
      const expect = readPredicate(form.querySelector('[data-rule-expect] > fieldset')!);
      const whenNode = form.querySelector('[data-rule-when] > fieldset');
      Object.assign(rule, { expect, when: whenNode ? readPredicate(whenNode) : undefined });
      vscode.postMessage({ type: "updateContract", contract });
    } catch (error) { form.querySelector('[data-rule-error]')!.textContent = String(error); }
  }));
  app.querySelector('[data-action="watch-inputs"]')?.addEventListener("click", () => vscode.postMessage({ type: "watchInputs" }));
  app.querySelector('[data-action="history"]')?.addEventListener("click", () => vscode.postMessage({ type: "history" }));
  app.querySelector('[data-action="insert-template"]')?.addEventListener("click", () => vscode.postMessage({ type: "insertTemplate" }));
  app.querySelector('[data-action="edit-connection"]')?.addEventListener("click", () => vscode.postMessage({ type: "editConnection" }));
  app.querySelector('[data-action="preflight"]')?.addEventListener("click", () => vscode.postMessage({ type: "preflight" }));
  app.querySelector('[data-action="live"]')?.addEventListener("click", () => vscode.postMessage({ type: "live" }));
  app.querySelector('[data-action="cancel"]')?.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  app.querySelectorAll<HTMLElement>('[data-action="preview-rule"]').forEach(button => button.addEventListener("click", () => vscode.postMessage({ type: "preview", ruleId: button.dataset.rule })));
  app.querySelector<HTMLInputElement>("#result-filter")?.addEventListener("input", event => {
    resultFilter = (event.target as HTMLInputElement).value;
    app.querySelector(".results")!.innerHTML = renderResults(runs, resultFilter, stale);
  });
  app.querySelector("#preset-form")?.addEventListener("submit", event => {
    event.preventDefault();
    if (!contract) return;
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    try {
      contract = insertPreset(contract, { kind: value("preset-kind"), id: value("preset-id"), column: value("preset-column"), value: value("preset-value"),
        dateAnchor: value("preset-date-anchor") || undefined, valueType: value("preset-value-type"), caseSensitive: value("preset-case") ? value("preset-case") === "true" : undefined,
        decimalPlaces: value("preset-decimals") === "" ? undefined : Number(value("preset-decimals")), columns: value("preset-columns").split(/\r?\n/).filter(Boolean), duplicates: value("preset-duplicates"),
        values: value("preset-values").split(/\r?\n/), minimum: value("preset-min"), maximum: value("preset-max"), otherColumn: value("preset-other"),
        exclusive: (document.getElementById("preset-exclusive") as HTMLInputElement).checked, comparison: value("preset-comparison"), nulls: value("preset-nulls") } as PresetInput);
      vscode.postMessage({ type: "updateContract", contract });
      render();
    } catch (e) { document.getElementById("preset-error")!.textContent = String(e); }
  });
  app.querySelector('[data-action="create-baseline"]')?.addEventListener("click", () => vscode.postMessage({ type: "createBaseline" }));
  app.querySelector('[data-action="review-baseline"]')?.addEventListener("click", () => vscode.postMessage({ type: "reviewBaseline" }));
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
  app.querySelector('[data-action="use-configured-targets"]')?.addEventListener("click", () => vscode.postMessage({ type: "useConfiguredTargets" }));
  app.querySelector('[data-action="open-active-target-vscode"]')?.addEventListener("click", () =>
    vscode.postMessage({ type: "openActiveTargetInVsCode" })
  );
  app.querySelector('[data-action="open-active-target-external"]')?.addEventListener("click", () =>
    vscode.postMessage({ type: "openActiveTargetExternally" })
  );
  app.querySelector('[data-action="add-target-files"]')?.addEventListener("click", () => vscode.postMessage({ type: "addTargetFiles" }));
  app.querySelector('[data-action="add-target-url"]')?.addEventListener("click", () => vscode.postMessage({ type: "addTargetUrl" }));
  app.querySelector('[data-action="add-sql-target"]')?.addEventListener("click", () => vscode.postMessage({ type: "addSqlServerTarget" }));
  app.querySelector('[data-action="generate-sql"]')?.addEventListener("click", () => vscode.postMessage({ type: "generateSqlServerValidation" }));
  app.querySelector('[data-action="configure-sql"]')?.addEventListener("click", () => vscode.postMessage({ type: "configureSqlServerConnection" }));
  app.querySelector('[data-action="import-sql-schema"]')?.addEventListener("click", () => vscode.postMessage({ type: "importSqlServerSchema" }));
  app.querySelectorAll<HTMLElement>('[data-action="open-target-vscode"]').forEach((button) => button.addEventListener("click", () =>
    vscode.postMessage({ type: "openTargetInVsCode", index: Number(button.dataset.index) })
  ));
  app.querySelectorAll<HTMLElement>('[data-action="open-target-external"]').forEach((button) => button.addEventListener("click", () =>
    vscode.postMessage({ type: "openTargetExternally", index: Number(button.dataset.index) })
  ));
  app.querySelectorAll<HTMLElement>('[data-action="remove-target"]').forEach((button) => button.addEventListener("click", () => {
    if (!contract?.targets) return;
    contract.targets.splice(Number(button.dataset.index), 1);
    if (contract.targets.length === 0) contract.targets = undefined;
    render();
    vscode.postMessage({ type: "updateContract", contract });
  }));
  app.querySelectorAll<HTMLElement>('[data-action="remove-sql-target"]').forEach((button) => button.addEventListener("click", () => {
    if (!contract?.sqlServer) return;
    const index = Number(button.dataset.index);
    if (contract.sqlServer.targets?.length) {
      contract.sqlServer.targets.splice(index, 1);
      if (contract.sqlServer.targets.length === 0) contract.sqlServer.targets = undefined;
    } else if (index === 0) {
      contract.sqlServer.connection = undefined;
      contract.sqlServer.integratedConnection = undefined;
      contract.sqlServer.schema = undefined;
      contract.sqlServer.table = undefined;
      contract.sqlServer.objectType = undefined;
      contract.sqlServer.columnMap = undefined;
    }
    if (Object.values(contract.sqlServer).every((value) => value === undefined)) contract.sqlServer = undefined;
    render();
    vscode.postMessage({ type: "updateContract", contract });
  }));
  app.querySelector('[data-action="open-yaml"]')?.addEventListener("click", () => vscode.postMessage({ type: "openYaml" }));
  app.querySelector('[data-action="export-issues"]')?.addEventListener("click", () => vscode.postMessage({ type: "exportIssues", filter: resultFilter, selectedIssues: Array.from(app.querySelectorAll<HTMLElement>('[data-issue-selection]:checked')).map(input => input.dataset.issueSelection) }));
  app.querySelector('[data-action="run"]')?.addEventListener("click", () => {
    if (running) return;
    running = true;
    runningTarget = "";
    runningTargetIndex = 0;
    runningTargetCount = targetNames.length;
    render();
    vscode.postMessage({ type: "run" });
  });
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
    parseError = "";
    documentVersion = message.documentVersion;
    dirty = message.dirty ?? false; watchInputs = message.watchInputs ?? false;
    contract = message.contract;
    contractName = message.contractName;
    targetNames = message.targetNames ?? [];
    connectionOverview = message.connectionOverview ?? [];
    fileTargetCount = message.fileTargetCount ?? targetNames.length;
    configuredTargetCount = message.configuredTargetCount ?? 0;
    usingConfiguredTargets = message.usingConfiguredTargets ?? false;
    runs = message.runs ?? [];
    stale = message.stale ?? false; live = message.live ?? false; runNotice = message.runNotice ?? "";
    render();
  } else if (message.type === "runState") {
    running = message.running === true;
    runningTarget = running ? message.target ?? "" : "";
    runningTargetIndex = running ? message.index ?? 0 : 0;
    runningTargetCount = running ? message.total ?? targetNames.length : 0;
    render();
  } else if (message.type === "error") {
    parseError = message.message; stale = true; running = false; render();
  }
});

vscode.postMessage({ type: "ready" });
