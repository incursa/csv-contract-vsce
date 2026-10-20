# Scalable Excel export

`createBadRowsXlsxPlan` is the shared workbook plan used by both export paths:

- `badRowsXlsx(runs, options)` keeps browser and virtual-workspace compatibility. It is synchronous and enforces a 64 MiB uncompressed serialization budget by default. Callers should direct larger exports to the streamed path.
- `writeBadRowsXlsxFile(runs, options, destination, controls)` incrementally generates worksheet XML, compresses ZIP entries, honors writable-stream backpressure, and publishes from a completed temporary file. Overwrite mode uses rename; `controls.overwrite: false` uses atomic hard-link creation to avoid replacing a destination created during serialization. Cancellation and write/commit failure remove the temporary file.

The writer applies Excel's standard 1,048,576-row and 16,384-column sheet limits. Oversized logical sheets are deterministically split by rows and columns. Every physical shard repeats its header and the available frozen trace columns; bad-row sheets therefore retain test, source, and source-row identity context. Smaller limits may be injected through `options.limits` for deterministic tests.

Streaming bounds **serialization** memory to the ZIP compressor and output chunks. It does not make the complete operation constant-memory: the caller still owns the validation results, and workbook planning indexes retained evidence to consolidate rows and checks. Planning is proportional to retained evidence and does not query the source again.

Callers should normally construct exports from aggregate-only, redacted review-package targets. Detailed evidence must be an explicit user choice because bad-row, identity, joined, and group sheets can contain source detail.

The destination directory must already exist. `controls.temporaryDirectory` is optional; atomic publication requires it to be on the same filesystem as the destination. The default is a sibling temporary file. No-clobber mode requires a filesystem supporting hard links and fails safely otherwise. Cancellation is honored until publication begins.

Desktop VS Code uses the streamed writer for file destinations with a cancellable
progress notification. Aggregate-only Excel is available alongside the explicitly
confirmed sensitive-detail option. Web/virtual workspaces use the capped
synchronous path.

The standalone browser's **Download Excel (aggregate)** streams to a user-selected
file when the browser supports a streaming save picker. Its fallback download is
limited to 64 MiB of compressed XLSX data. This download cap is separate from the
web extension's 64 MiB uncompressed serialization cap. CLI exports have neither
buffering cap and remain constrained by retained evidence, disk capacity, Excel
limits, and the available filesystem.
