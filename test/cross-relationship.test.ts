import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/core/contract";
import { evaluateCsvCrossCheck, planCrossCheck, type CrossCheck } from "../src/core/cross-checks";
import type { CsvContract } from "../src/core/model";
import { parseSuite } from "../src/core/suite";

const paymentColumns = { RecordId: { presence: "required" as const }, Amount: { presence: "required" as const }, EffectiveDate: { presence: "required" as const } };
const classificationColumns = { RecordId: { presence: "required" as const }, Category: { presence: "required" as const }, ChangedAt: { presence: "required" as const }, Sequence: { presence: "required" as const } };

const relationship = (expectAmount: number, category: string): CrossCheck => ({
  id: `${category.toLowerCase()}-amount`, kind: "relationship", from: "payments", to: "classifications",
  keys: [{ from: "RecordId", to: "RecordId" }],
  lookup: { orderBy: [{ column: "ChangedAt", type: "date", direction: "desc" }, { column: "Sequence", type: "number", direction: "desc" }] },
  when: { side: "to", column: "Category", operator: "equals", value: category },
  expect: { side: "from", column: "Amount", operator: category === "Special" ? "equals" : "notEquals", value: expectAmount, valueType: "number" },
  nulls: "fail", missing: "fail"
});

test("relationship cross-checks select a deterministic CSV lookup row and return aggregate-only failures", () => {
  const payments: CsvContract = { version: 1, targets: [{ path: "payments.csv" }], schema: { columns: paymentColumns } };
  const classifications: CsvContract = { version: 1, targets: [{ path: "classifications.csv" }], schema: { columns: classificationColumns } };
  const check = relationship(1, "Special");
  const plan = planCrossCheck(check, [{ id: "payments", source: "C:/portable/payments.csvtest.yaml", contract: payments }, { id: "classifications", source: "C:/portable/classifications.csvtest.yaml", contract: classifications }]);
  assert.equal(plan.mode, "csv");
  if (plan.mode !== "csv") throw new Error("Expected CSV plan.");
  const from = parseCsv("RecordId,Amount,EffectiveDate\nA,1,2025-01-01\nB,2,2025-01-01\nC,1,2025-01-01\nD,3,2025-01-01\n");
  const to = parseCsv("RecordId,Category,ChangedAt,Sequence\nA,Standard,2024-01-01,1\nA,Special,2025-01-01,1\nB,Special,2025-01-01,1\nC,Standard,2025-01-01,1\n");
  const result = evaluateCsvCrossCheck(plan, from, to);
  assert.equal(result.issueCount, 2);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /Aggregate only/);
  assert.doesNotMatch(JSON.stringify(result), /RecordId|2025-01-01/);

  const greater = relationship(1, "Special");
  greater.id = "special-amount-greater-than-one";
  greater.expect = { side: "from", column: "Amount", operator: "greaterThan", value: 1, valueType: "number" };
  const greaterPlan = planCrossCheck(greater, [{ id: "payments", source: "C:/portable/payments.csvtest.yaml", contract: payments }, { id: "classifications", source: "C:/portable/classifications.csvtest.yaml", contract: classifications }]);
  assert.equal(greaterPlan.mode, "csv");
  if (greaterPlan.mode !== "csv") throw new Error("Expected CSV plan.");
  assert.equal(evaluateCsvCrossCheck(greaterPlan, from, to).issueCount, 2);
});

test("relationship SQL uses the same generic lookup, typed predicates, and aggregate-only result", () => {
  const payments: CsvContract = { version: 1, schema: { columns: paymentColumns }, sqlServer: { connection: "portable", schema: "left", table: "Payments" } };
  const classifications: CsvContract = { version: 1, schema: { columns: classificationColumns }, sqlServer: { connection: "portable", schema: "right", table: "Classifications" } };
  const plan = planCrossCheck(relationship(1, "Special"), [{ id: "payments", contract: payments }, { id: "classifications", contract: classifications }]);
  assert.equal(plan.mode, "sql");
  if (plan.mode !== "sql") throw new Error("Expected SQL plan.");
  assert.match(plan.sql, /OUTER APPLY \(SELECT TOP \(1\)/);
  assert.match(plan.sql, /TRY_CONVERT\(datetime2, candidate\.\[ChangedAt\]\) DESC/);
  assert.match(plan.sql, /TRY_CONVERT\(decimal\(38,10\), candidate\.\[Sequence\]\) DESC/);
  assert.match(plan.sql, /TRY_CONVERT\(decimal\(38,10\), a\.\[Amount\]\) = TRY_CONVERT/);
  assert.match(plan.sql, /^SELECT COUNT_BIG\(\*\) AS FailureCount/);
  assert.doesNotMatch(plan.sql, /DROP|DELETE|UPDATE/);
});

test("suite parsing rejects ambiguous relationship predicates and nondeterministic lookups", () => {
  const prefix = "suiteVersion: 1\nid: portable\nmembers: [{id: payments, ref: payments.yaml}, {id: classifications, ref: classifications.yaml}]\n";
  assert.throws(() => parseSuite(`${prefix}crossChecks: [{id: bad, kind: relationship, from: payments, to: classifications, keys: [{from: RecordId, to: RecordId}], expect: {side: from, column: Amount, operator: equals, value: 1}}]\n`), /lookup and expectation/);
  assert.throws(() => parseSuite(`${prefix}crossChecks: [{id: bad, kind: relationship, from: payments, to: classifications, keys: [{from: RecordId, to: RecordId}], lookup: {orderBy: [{column: ChangedAt, type: date}]}, expect: {side: from, column: Amount, operator: equals, value: 1, other: {side: to, column: Sequence}}}]\n`), /ambiguous/);
});
