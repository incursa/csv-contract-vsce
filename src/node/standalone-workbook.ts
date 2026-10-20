import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactIssueExportRuns } from "../core/evidence-redaction";
import type { ValidationReviewPackage } from "../core/review-package";
import type { StandaloneHttpResponse } from "./standalone-http";
import { writeBadRowsXlsxFile } from "./xlsx-stream";

/** Export only retained aggregate evidence. This never opens a validation source. */
export async function createStandaloneWorkbookDownload(
  review: ValidationReviewPackage,
  signal: AbortSignal
): Promise<StandaloneHttpResponse> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "validation-workbench-export-"));
  const destination = join(directory, "validation-review.xlsx");
  try {
    const runs = redactIssueExportRuns(review.targets, { mode: "aggregate-only" }).runs;
    await writeBadRowsXlsxFile(runs, {
      title: "Validation review (aggregate only)",
      testLabel: review.source.reference
    }, destination, { signal });
    signal.throwIfAborted();
    const info = await stat(destination);
    const stream = createReadStream(destination);
    // Install these before the first read so even a pre-stream disconnect is safe.
    const closed = new Promise<void>(resolve => stream.once("close", resolve));
    stream.on("error", () => { /* The async iterator propagates read errors to HTTP. */ });
    let cleanup: Promise<void> | undefined;
    return {
      stream,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(info.size),
        "Content-Disposition": 'attachment; filename="validation-review.xlsx"'
      },
      cleanup: () => cleanup ??= (async () => {
        stream.destroy();
        await closed;
        await rm(directory, { recursive: true, force: true });
      })()
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
