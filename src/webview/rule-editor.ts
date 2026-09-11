import type { Predicate, PredicateLeaf, PredicateOperator } from "../core/model";
const escape = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const operators: PredicateOperator[] = ["equals", "notEquals", "in", "notIn", "isNull", "notNull", "isBlank", "notBlank", "equalsColumn", "notEqualsColumn", "contains", "notContains", "startsWith", "endsWith", "matches", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "dateOnOrAfter", "dateOnOrBefore", "dateAfter", "dateBefore"];
/** Nested predicates use the same ordinary contract structure; Apply is a single undoable edit. */
export function renderPredicate(predicate: Predicate, columns: string[]): string {
  const controls = `<div class="predicate-actions"><button type="button" data-predicate-action="wrap">Wrap in group</button><button type="button" data-predicate-action="remove">Remove branch</button><button type="button" data-predicate-action="up">Move up</button><button type="button" data-predicate-action="down">Move down</button></div>`;
  if ("all" in predicate || "any" in predicate) {
    const kind = "all" in predicate ? "all" : "any";
    const children = "all" in predicate ? predicate.all : predicate.any;
    return `<fieldset data-predicate="group"><legend>Combined conditions</legend><label>Match <select data-field="group"><option ${kind === "all" ? "selected" : ""}>all</option><option ${kind === "any" ? "selected" : ""}>any</option></select></label>${controls}<button type="button" data-predicate-action="add">Add condition</button>${children.map(p => renderPredicate(p, columns)).join("")}</fieldset>`;
  }
  const options = (values: string[], current: string) => [...new Set([current, ...values])].map(v => `<option ${v === current ? "selected" : ""}>${escape(v)}</option>`).join("");
  return `<fieldset data-predicate="leaf"><legend>Condition</legend>
    <label>Column <select data-field="column">${options(columns, predicate.column)}</select></label>
    <label>Operator <select data-field="operator">${options(operators, predicate.operator)}</select></label>
    <label>Literal <input data-field="value" value="${escape(predicate.value)}" data-original="${escape(JSON.stringify(predicate.value ?? ""))}"></label>
    <label>Comparison column (optional) <select data-field="otherColumn">${options(["", ...columns], predicate.otherColumn ?? "")}</select></label>
    <label>List literals, one per line <textarea data-field="values">${escape(predicate.values?.join("\n") ?? "")}</textarea></label>
    <label>Literal type <select data-field="valueType">${options(["", "string", "number", "boolean"], predicate.valueType ?? "")}</select></label>
    <label>Case policy (blank inherits) <select data-field="caseSensitive">${options(["", "true", "false"], predicate.caseSensitive === undefined ? "" : String(predicate.caseSensitive))}</select></label>
    <label>Max decimal places <input type="number" min="0" max="15" data-field="decimalPlaces" value="${escape(predicate.decimalPlaces)}"></label>
    <label>Relative date anchor <select data-field="dateAnchor">${options(["", "today", "now"], predicate.relativeDate?.anchor ?? "")}</select></label>
    <label>Relative days <input type="number" data-field="relativeDays" value="${escape(predicate.relativeDate?.days ?? 0)}"></label>
    ${controls}</fieldset>`;
}
export function editPredicateTree(button: HTMLElement, columns: string[]): void {
  const node = button.closest<HTMLElement>("fieldset[data-predicate]")!;
  const action = button.dataset.predicateAction;
  const parent = node.parentElement!;
  const branch = { column: columns[0], operator: "notNull" as const };
  if (!branch.column) throw new Error("Declare a column before adding predicates.");
  if (action === "add") node.insertAdjacentHTML("beforeend", renderPredicate(branch, columns));
  else if (action === "wrap") node.outerHTML = renderPredicate({ all: [readPredicate(node)] }, columns);
  else if (action === "remove") {
    if (!parent.matches('fieldset[data-predicate="group"]') || parent.querySelectorAll(":scope > fieldset").length < 2) throw new Error("A predicate must retain at least one condition. Remove its enclosing branch instead.");
    node.remove();
  } else if (action === "up" && node.previousElementSibling?.matches("fieldset")) parent.insertBefore(node, node.previousElementSibling);
  else if (action === "down" && node.nextElementSibling?.matches("fieldset")) parent.insertBefore(node.nextElementSibling, node);
}
export function readPredicate(element: Element): Predicate {
  if (element.getAttribute("data-predicate") === "group") {
    const kind = element.querySelector<HTMLSelectElement>(':scope > label > select')!.value;
    const children = Array.from(element.querySelectorAll(":scope > fieldset")).map(readPredicate);
    return kind === "all" ? { all: children } : { any: children };
  }
  const value = (key: string) => element.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!.value;
  const operator = value("operator") as PredicateOperator;
  const leaf: PredicateLeaf = { column: value("column"), operator };
  if (value("valueType")) leaf.valueType = value("valueType") as PredicateLeaf["valueType"];
  if (value("caseSensitive")) leaf.caseSensitive = value("caseSensitive") === "true";
  if (value("decimalPlaces") !== "") leaf.decimalPlaces = Number(value("decimalPlaces"));
  if (value("dateAnchor") && operator.startsWith("date")) return { ...leaf, relativeDate: { anchor: value("dateAnchor") as "today" | "now", days: Number(value("relativeDays")) } };
  if (["isNull", "notNull", "isBlank", "notBlank"].includes(operator)) return leaf;
  if (["in", "notIn"].includes(operator)) return { ...leaf, values: value("values").split(/\r?\n/) };
  if (operator.endsWith("Column") || (/^(greater|less|date)/.test(operator) && value("otherColumn"))) {
    if (!value("otherColumn")) throw new Error("Choose a comparison column.");
    return { ...leaf, otherColumn: value("otherColumn") };
  }
  const original: string | number = JSON.parse(element.querySelector<HTMLElement>('[data-field="value"]')!.dataset.original!);
  return { ...leaf, value: String(original) === value("value") ? original : value("value") };
}
