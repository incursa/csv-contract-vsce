import { createWriteStream } from "node:fs";
import { link, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Zip, ZipDeflate } from "fflate";
import { createBadRowsXlsxPlan, type BadRowsOptions, type BadRowsRun } from "../bad-rows-xlsx";

export interface XlsxStreamControls {
  signal?: AbortSignal;
  /** Defaults to the destination directory. Atomic rename still requires the same filesystem. */
  temporaryDirectory?: string;
  /** Defaults to true for existing callers. False publishes atomically only when destination is absent. */
  overwrite?: boolean;
}

export interface XlsxWriteResult {
  path: string;
  sheets: number;
  rows: number;
  bytes: number;
}

function abortError(): Error {
  const error = new Error("Excel export was canceled.");
  error.name = "AbortError";
  return error;
}

/**
 * Stream a workbook to a sibling temporary file and publish it with one rename.
 * This bounds serialization memory to ZIP/chunk buffers; the supplied validation
 * results and the workbook's retained-evidence row plans remain caller-owned memory.
 */
export async function writeBadRowsXlsxFile(
  runs: BadRowsRun[], options: BadRowsOptions, destination: string, controls: XlsxStreamControls = {}
): Promise<XlsxWriteResult> {
  if (controls.signal?.aborted) throw abortError();
  const finalPath = resolve(destination);
  const temporaryDirectory = resolve(controls.temporaryDirectory ?? dirname(finalPath));
  const temporaryPath = join(temporaryDirectory, `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`);
  const plan = createBadRowsXlsxPlan(runs, options);
  if (controls.signal?.aborted) throw abortError();
  const output = createWriteStream(temporaryPath, { flags: "wx" });
  let zip: Zip | undefined;
  let bytes = 0;
  let writeFailure: unknown;
  let pendingDrain: Promise<void> = Promise.resolve();
  const finished = new Promise<void>((accept, reject) => {
    output.once("finish", accept);
    output.once("error", reject);
  });
  // Keep early stream errors observed even before the producer reaches its final await.
  void finished.catch(() => undefined);
  const closed = new Promise<void>(accept => output.once("close", () => accept()));
  const abort = () => {
    writeFailure = abortError();
    zip?.terminate();
    output.destroy(writeFailure as Error);
  };
  controls.signal?.addEventListener("abort", abort, { once: true });
  try {
    zip = new Zip((error, data, final) => {
      if (error) {
        writeFailure = error;
        output.destroy(error);
        return;
      }
      if (data.length) {
        bytes += data.length;
        if (!output.write(data)) pendingDrain = Promise.race([once(output, "drain").then(() => undefined), finished]);
      }
      if (final) output.end();
    });
    for (const part of plan.parts()) {
      if (controls.signal?.aborted) throw abortError();
      const file = new ZipDeflate(part.path, { level: 6 });
      zip.add(file);
      const iterator = part.chunks()[Symbol.iterator]();
      let current = iterator.next();
      if (current.done) file.push(new Uint8Array(), true);
      while (!current.done) {
        if (controls.signal?.aborted) throw abortError();
        const next = iterator.next();
        file.push(current.value, next.done);
        await pendingDrain;
        if (writeFailure) throw writeFailure;
        current = next;
      }
    }
    zip.end();
    await finished;
    if (writeFailure) throw writeFailure;
    if (controls.signal?.aborted) throw abortError();
    await closed;
    controls.signal?.removeEventListener("abort", abort);
    if (controls.overwrite === false) {
      // Linking a completed sibling temp file is an atomic create-if-absent operation.
      // Unlike rename on POSIX, it cannot replace a destination created during serialization.
      await link(temporaryPath, finalPath);
      await unlink(temporaryPath).catch(() => undefined);
    } else {
      await rename(temporaryPath, finalPath);
    }
    return { path: finalPath, sheets: plan.sheets, rows: plan.rows, bytes };
  } catch (error) {
    zip?.terminate();
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!output.destroyed) output.destroy(failure);
    // A stream destroyed without reaching finish may emit only close. Waiting on
    // either terminal signal prevents synchronous ZIP/serialization failures hanging.
    await Promise.race([finished.catch(() => undefined), closed]);
    await closed;
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    controls.signal?.removeEventListener("abort", abort);
  }
}
