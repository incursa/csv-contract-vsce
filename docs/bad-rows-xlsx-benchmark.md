# Bad-row Excel export benchmark

The export benchmark is intended to catch regressions in the retained-evidence
path. Run it in a production build with Node's heap and GC telemetry enabled:

```sh
node --expose-gc --trace-gc scripts/benchmark-bad-rows-xlsx.mjs
```

The fixture contains 10,000 targets, 50 retained rows per target, 100 source
columns, 20 related columns, and 200 check columns. It is deliberately larger
than the normal interactive export while remaining repeatable on a developer
machine.

The baseline acceptance envelope is:

* elapsed time no greater than 30 seconds on the repository's CI runner;
* peak `heapUsed` growth no greater than 256 MiB over the post-fixture baseline;
* cancellation requested halfway through generation completes within 2 seconds;
* no `.partial-*` file remains after success, failure, or cancellation.

The async exporter must report estimate, build, and package progress, and must
observe cancellation between rows/sheets. Excel hard limits are deterministic:
1,048,575 data rows, 16,384 columns, and 32,767 UTF-16 characters per cell.
When a matrix exceeds a row or column limit it is split in row-major then
column-major order; `Test files`, `Source`, and `Source row` are repeated on
every shard. Truncated or sampled evidence is reported in the estimate and
the Read Me sheet.

The benchmark is a performance guardrail rather than a correctness test. The
automated stress tests in `test/bad-rows-xlsx.test.ts` cover the same shape at
small limits so they can run on every change.
