import type { CsvOptions, OrderedCheck, OrderedRule, ValidationIssue } from "./model";

export interface OrderedRow { row: number; values: Record<string, string> }

export function orderedColumns(rule: OrderedRule): string[] {
  return [...new Set([...(rule.partitionBy ?? []), ...rule.orderBy.map(key => key.column), rule.event.actionColumn,
    ...(rule.event.reasonColumn ? [rule.event.reasonColumn] : [])])];
}

export function orderedChecks(rule: OrderedRule): OrderedCheck[] {
  return [rule.duplicateOrder, rule.invalidOrder, rule.event.unmapped, rule.initial, rule.invalidTransition, rule.invalidFinal,
    ...rule.transitions, ...(rule.cardinality ?? []), ...(rule.adjacency ?? [])];
}

export function validateOrderedDefinition(rule: OrderedRule, declared: Set<string>): void {
  for (const column of orderedColumns(rule)) if (!declared.has(column)) throw new Error(`Sequence ${rule.id} references undeclared column ${column}.`);
  const ids = new Set<string>();
  for (const check of orderedChecks(rule)) {
    if (ids.has(check.id)) throw new Error(`Sequence ${rule.id} repeats rule id ${check.id}.`);
    ids.add(check.id);
  }
  if (rule.orderBy.length === 0) throw new Error(`Ordered rule ${rule.id} needs order keys.`);
  if (!rule.transitions.some(t => t.from === rule.initial.state && t.event === rule.initial.event)) throw new Error(`Sequence ${rule.id} has no initial event transition.`);
  const strictKeys = (check: OrderedCheck, extra: string[] = []): void => {
    const unknown = Object.keys(check).filter(key => !["id", "message", ...extra].includes(key));
    if (unknown.length) throw new Error(`Ordered check ${check.id} has unknown fields ${unknown.join(", ")}. Quote YAML messages that contain commas.`);
  };
  strictKeys(rule.duplicateOrder); strictKeys(rule.invalidOrder); strictKeys(rule.event.unmapped);
  strictKeys(rule.initial, ["state", "event"]); strictKeys(rule.invalidTransition); strictKeys(rule.invalidFinal);
  rule.transitions.forEach(t => strictKeys(t, ["from", "event", "to"]));
  rule.cardinality?.forEach(c => strictKeys(c, ["event", "exact", "min", "max"]));
  rule.adjacency?.forEach(a => strictKeys(a, ["event", "preceding", "following", "dateRelation", "allowFinal"]));
  if (rule.event.reasonColumn) for (const mapping of rule.event.mappings) {
    if (!mapping.reasonCodes && mapping.reasonPolicy !== "any") throw new Error(`Ordered rule ${rule.id} must explicitly map or ignore reason codes for ${mapping.event}.`);
  }
}

function normalized(value: string, options: CsvOptions): string {
  const trimmed = options.trimValues ? value.trim() : value;
  return options.caseSensitive === false ? trimmed.toLowerCase() : trimmed;
}

function dateValue(raw: string, format: "yyyy/MM/dd" | "iso" = "iso"): number | undefined {
  const value = format === "yyyy/MM/dd" ? raw.replace(/\//g, "-") : raw;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return undefined;
  const date = Date.parse(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value.slice(0, 10) ? date : undefined;
}

function typed(raw: string, type: "date" | "number" | "string", format?: "yyyy/MM/dd" | "iso"): string | number | undefined {
  if (type === "string") return raw;
  if (type === "number") return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  return dateValue(raw, format);
}

function sortValue(raw: string, key: OrderedRule["orderBy"][number]): string | number | undefined {
  const value = typed(raw, key.type, key.format);
  if (key.type === "number" && typeof value === "number" &&
    (key.integer && !Number.isSafeInteger(value) || key.minimum !== undefined && value < key.minimum)) return undefined;
  return value;
}

export function compareOrderedRows(a: OrderedRow, b: OrderedRow, rule: OrderedRule, options: CsvOptions): number {
  for (const column of rule.partitionBy ?? []) {
    const cmp = normalized(a.values[column] ?? "", options).localeCompare(normalized(b.values[column] ?? "", options));
    if (cmp) return cmp;
  }
  for (const key of rule.orderBy) {
    const left = sortValue(a.values[key.column] ?? "", key);
    const right = sortValue(b.values[key.column] ?? "", key);
    if (left === undefined || right === undefined) {
      if (left === undefined && right !== undefined) return -1;
      if (right === undefined && left !== undefined) return 1;
    } else if (left < right) return -1;
    else if (left > right) return 1;
  }
  return a.row - b.row;
}

function partitionKey(row: OrderedRow, rule: OrderedRule, options: CsvOptions): string {
  return JSON.stringify((rule.partitionBy ?? []).map(c => normalized(row.values[c] ?? "", options)));
}

function orderKey(row: OrderedRow, rule: OrderedRule): string {
  return JSON.stringify(rule.orderBy.map(k => sortValue(row.values[k.column] ?? "", k)));
}

export class OrderedRuleEvaluator {
  private partition?: string;
  private state = "";
  private first?: OrderedRow;
  private previous?: OrderedRow;
  private previousEvent?: string;
  private counts = new Map<string, number>();
  private ordinal = 0;
  private priorOrder?: string;
  private outcomes = new Map<string, { id: string; selected: number; passed: number; failed: number }>();

  public constructor(private readonly rule: OrderedRule, private readonly options: CsvOptions,
    private readonly issue: (issue: ValidationIssue) => void) {
    validateOrderedDefinition(rule, new Set(orderedColumns(rule)));
    for (const check of orderedChecks(rule)) this.outcomes.set(check.id, { id: check.id, selected: 0, passed: 0, failed: 0 });
  }

  public get ruleOutcomes(): { id: string; selected: number; passed: number; failed: number }[] { return [...this.outcomes.values()]; }

  private check(check: OrderedCheck, ok: boolean, row: OrderedRow, detail = "", relatedRows: number[] = []): void {
    const outcome = this.outcomes.get(check.id)!;
    outcome.selected++;
    if (ok) { outcome.passed++; return; }
    outcome.failed++;
    this.issue({ level: "row", code: "ORDERED_RULE_FAILED", testId: check.id, row: row.row, relatedRows,
      actual: JSON.stringify(Object.fromEntries(orderedColumns(this.rule).map(c => [c, row.values[c] ?? ""]))).slice(0, 240),
      message: `${check.message}${detail ? ` ${detail}` : ""}` });
  }

  private eventFor(row: OrderedRow): string | undefined {
    const action = normalized(row.values[this.rule.event.actionColumn] ?? "", this.options);
    const reason = this.rule.event.reasonColumn ? normalized(row.values[this.rule.event.reasonColumn] ?? "", this.options) : "";
    const reserved = this.rule.event.reservedReasonCodes?.some(c => normalized(c, this.options) === reason) ?? false;
    const matches = this.rule.event.mappings.filter(m => m.actionCodes.some(c => normalized(c, this.options) === action) &&
      (m.reasonCodes?.some(c => normalized(c, this.options) === reason) ||
        !m.reasonCodes && (!this.rule.event.reasonColumn || m.reasonPolicy === "any" && !reserved)));
    this.check(this.rule.event.unmapped, matches.length > 0, row,
      `Action=${row.values[this.rule.event.actionColumn] ?? ""}; reason=${this.rule.event.reasonColumn ? row.values[this.rule.event.reasonColumn] ?? "" : ""}.`);
    return matches[0]?.event;
  }

  public add(row: OrderedRow): void {
    const key = partitionKey(row, this.rule, this.options);
    if (key !== this.partition) { this.finishPartition(); this.partition = key; this.state = this.rule.initial.state; this.ordinal = 0; this.counts.clear(); this.first = row; this.priorOrder = undefined; }
    this.ordinal++;
    for (const sort of this.rule.orderBy) this.check(this.rule.invalidOrder,
      sortValue(row.values[sort.column] ?? "", sort) !== undefined, row,
      `Invalid ${sort.type} sort value in ${sort.column}.`);
    const currentOrder = orderKey(row, this.rule);
    if (this.previous && this.priorOrder === currentOrder) this.check(this.rule.duplicateOrder, false, row, "Sort key matches another row.", [this.previous.row]);
    else this.check(this.rule.duplicateOrder, true, row);
    const event = this.eventFor(row);
    if (this.ordinal === 1) this.check(this.rule.initial, event === this.rule.initial.event, row);
    if (event) {
      this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
      const transition = this.rule.transitions.find(t => t.from === this.state && t.event === event);
      this.check(this.rule.invalidTransition, !!transition, row, `Event ${event} is not allowed in state ${this.state}.`);
      if (transition) { this.check(transition, true, row); this.state = transition.to; }
      for (const adjacency of this.rule.adjacency ?? []) {
        if (adjacency.event !== event || !adjacency.preceding) continue;
        this.check(adjacency, this.previousEvent === adjacency.preceding, row,
          `Expected ${adjacency.preceding} immediately before ${event}.`);
      }
    }
    if (this.previous && this.previousEvent) this.checkFollowing(this.previous, this.previousEvent, row, event);
    this.previous = row;
    this.previousEvent = event;
    this.priorOrder = currentOrder;
  }

  private checkFollowing(previous: OrderedRow, previousEvent: string, row?: OrderedRow, event?: string): void {
    for (const adjacency of this.rule.adjacency ?? []) {
      if (adjacency.event !== previousEvent || !adjacency.following) continue;
      if (!row && adjacency.allowFinal) { this.check(adjacency, true, previous); continue; }
      let ok = event === adjacency.following;
      if (ok && adjacency.dateRelation && row) {
        const dateKey = this.rule.orderBy.find(k => k.type === "date");
        const from = dateKey ? dateValue(previous.values[dateKey.column] ?? "", dateKey.format) : undefined;
        const to = dateKey ? dateValue(row.values[dateKey.column] ?? "", dateKey.format) : undefined;
        ok = from !== undefined && to !== undefined && (adjacency.dateRelation === "nextDay" ? to - from === 86400000 :
          adjacency.dateRelation === "later" ? to > from : to === from);
      }
      this.check(adjacency, ok, previous, `Expected ${adjacency.following}${adjacency.dateRelation ? ` (${adjacency.dateRelation})` : ""} immediately after ${previousEvent}.`, row ? [row.row] : []);
    }
  }

  private finishPartition(): void {
    if (!this.first || !this.previous) return;
    if (this.previousEvent) this.checkFollowing(this.previous, this.previousEvent);
    this.check(this.rule.invalidFinal, this.rule.finalStates.includes(this.state), this.previous, `Final state is ${this.state}.`);
    for (const check of this.rule.cardinality ?? []) {
      const count = this.counts.get(check.event) ?? 0;
      this.check(check, (check.exact === undefined || count === check.exact) &&
        (check.min === undefined || count >= check.min) && (check.max === undefined || count <= check.max),
      this.first, `Found ${count} ${check.event} events.`);
    }
    this.previous = undefined;
    this.previousEvent = undefined;
    this.first = undefined;
  }

  public finish(): void { this.finishPartition(); }
}
