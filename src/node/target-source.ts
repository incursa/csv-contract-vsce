import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isHttpTarget } from "./target-plan";

export interface MaterializedTargetOptions {
  tempDirectory?: string;
}

export async function withMaterializedTarget<T>(
  source: string,
  options: MaterializedTargetOptions,
  action: (localPath: string) => Promise<T>
): Promise<T> {
  if (!isHttpTarget(source)) return action(source);

  const baseDirectory = resolve(options.tempDirectory ?? tmpdir());
  await mkdir(baseDirectory, { recursive: true });
  const workingDirectory = await mkdtemp(join(baseDirectory, "csv-contract-target-"));
  const localPath = join(workingDirectory, "target.csv");
  try {
    const response = await fetch(source, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Unable to download ${source}: HTTP ${response.status} ${response.statusText}.`);
    }
    if (!response.body) throw new Error(`Unable to download ${source}: the response body is empty.`);
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      createWriteStream(localPath, { flags: "wx" })
    );
    return await action(localPath);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
