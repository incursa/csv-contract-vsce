# Excel validation package benchmark

The package exporter is bounded by Excel's per-sheet limits. A target matrix is
partitioned in stable target order, then stable test/check order. When a sheet
would exceed a limit, rows are split first and columns are split in declaration
order; every shard repeats `Test files`, `Source`, and `Source row`.

The asynchronous exporter serializes one worksheet fragment at a time directly
into its ZIP entry. It does not retain worksheet XML or a list of compressed
chunks; the returned `Uint8Array` is a view over one growable archive buffer.
This bounds packaging overhead to the compressed archive plus at most one
resize copy, while the retained evidence and sheet model remain the inputs to
the export.

The benchmark command is:

```text
npm run benchmark
```

For export-specific measurements, run the bad-row test bundle with a retained
fixture covering 100,000 rows, 100 source columns, 1,000 checks, and 100 targets.
Record peak Node heap and wall time on the same Node version and machine. The
acceptable baseline is no more than 2x the retained evidence size in peak heap,
and completion within 60 seconds on the repository's standard worker. A result
that exceeds either bound should be investigated before increasing retention.

Record the Node version, retained evidence size, peak heap, elapsed time, final
`.xlsx` size, and whether cancellation removed the partial output. Repeat the
measurement for the wide-schema and many-check cases; the largest peak should
remain bounded rather than increasing by one additional full XML workbook copy.

Exports are written to a partial URI and renamed only after the ZIP is complete;
the partial URI is removed on success, failure, and cancellation. Text longer
than Excel's 32,767-character limit is truncated and reported through progress.
