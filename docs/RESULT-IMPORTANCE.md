# Result importance and health

Rule importance changes only the optional graded health heuristic. It never changes whether validation passes or fails, rule severity, finding counts, execution status, or review-package acceptance.

## Contract and outcome hook

An author may assign `importance` from `0.1` through `10` to `rowTests[]`, `rules[]`, `groupRules[]`, `orderedRules[]`, individual ordered checks, `groupTests[]`, and `sqlServer.conditionalRules[]`. Omitted importance is `1`. An ordered check overrides its parent ordered rule's importance. Parsers must reject zero, negative, non-finite, and out-of-range values rather than silently correcting them.

The execution layer should copy the configured value onto the matching stable `checkOutcomes[]` identity:

```ts
{
  id: "customer-status",
  status: "fail",
  severity: "error",
  importance: 5
}
```

Until that metadata is carried by the outcome, a caller can pass `importanceByCheckId` and `severityByCheckId` as the fourth `resultHealth` argument. Outcome metadata takes precedence over the default; an explicit options map takes precedence over outcome metadata.

## Calculation boundaries

Only explicit `pass` and `fail` check outcomes enter the importance denominator. `not-applicable` checks are excluded. `unknown` and `not-evaluated` checks are never treated as passes. A sampled run, an outcome inventory marked `evaluationComplete: false`, an indeterminate check inventory, or a run with no evaluated checks returns `available: false`; consumers must show “Health unavailable” and must not display its numeric compatibility placeholder. Row-detail truncation alone does not make a trustworthy aggregate incomplete.

A failed warning contributes one quarter of its importance, preserving the existing warning severity treatment. A failed error contributes its full importance. The weighted failure rate replaces only the check-rate component of the existing graded heuristic; finding frequency and the 85-point cap for non-clean results remain unchanged.

Legacy calls with no configured importance continue to use the existing score exactly. Binary PASS/FAIL mode is unchanged and ignores importance.
