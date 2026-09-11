import type { Predicate, PredicateLeaf, PredicateOperator } from "../core/model";
const escape = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const operators: PredicateOperator[] = ["equals", "notEquals", "in", "notIn", "isNull", "notNull", "isBlank", "notBlank", "equalsColumn", "notEqualsColumn", "contains", "notContains", "startsWith", "endsWith", "matches", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "dateOnOrAfter", "dateOnOrBefore", "dateAfter", "dateBefore"];
/** Nested predicates use the same ordinary contract structure; Apply is a single undoable edit. */
export function renderPredicate(predicate: Predicate, columns: string[]): string {
  if ("all" in predicate || "any" in predicate) {
    const kind = "all" in predicate ? "all" : "any";
    const children = "all" in predicate ? predicate.all : predicate.any;
    return `<fieldset data-predicate="group"><legend>Combined conditions</legend><label>Match <select data-field="group"><option ${kind === "all" ? "selected" : ""}>all</option><option ${kind === "any" ? "selected" : ""}>any</option></select></label>${children.map(p => renderPredicate(p, columns)).join("")}</fieldset>`;
  }
  const options = (values: string[], current: string) => [...new Set([current, ...values])].map(v => `<option ${v === current ? "selected" : ""}>${escape(v)}</option>`).join("");
  return `<fieldset data-predicate="leaf"><legend>Condition</legend>
    <label>Column <select data-field="column">${options(columns, predicate.column)}</select></label>
    <label>Operator <select data-field="operator">${options(operators, predicate.operator)}</select></label>
    <label>Literal <input data-field="value" value="${escape(predicate.value)}" data-original="${escape(JSON.stringify(predicate.value ?? ""))}"></label>
    <label>Comparison column (optional) <select data-field="otherColumn">${options(["", ...columns], predicate.otherColumn ?? "")}</select></label>
    <label>List literals, one per line <textarea data-field="values">${escape(predicate.values?.join("\n") ?? "")}</textarea></label>
    </fieldset>`;
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
  if (["isNull", "notNull", "isBlank", "notBlank"].includes(operator)) return leaf;
  if (["in", "notIn"].includes(operator)) return { ...leaf, values: value("values").split(/\r?\n/) };
  if (operator.endsWith("Column") || (/^(greater|less|date)/.test(operator) && value("otherColumn"))) {
    if (!value("otherColumn")) throw new Error("Choose a comparison column.");
    return { ...leaf, otherColumn: value("otherColumn") };
  }
  const original: string | number = JSON.parse(element.querySelector<HTMLElement>('[data-field="value"]')!.dataset.original!);
  return { ...leaf, value: String(original) === value("value") ? original : value("value") };
}
