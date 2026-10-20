import { fork, type ForkOptions } from "node:child_process";
import { join } from "node:path";
import type { CsvContract, ValidationResult } from "../core/model";
import type { SchemaBaseline } from "../core/baseline";
import type { ResolvedSqlServerTarget } from "../core/sql-server-targets";
import type { SqlCrossPlan } from "../core/cross-checks";
import type { SqlServerValidationOptions } from "./sql-server-validator";
import type { ValidationProgress } from "../core/run-progress";

export type SqlWorkerOperation =
  | { kind: "validate"; contract: CsvContract; target: ResolvedSqlServerTarget; options: Omit<SqlServerValidationOptions, "signal" | "onProgress"> }
  | { kind: "schema"; target: ResolvedSqlServerTarget }
  | { kind: "cross"; plan: SqlCrossPlan };
export interface SqlWorkerReply { ok: boolean; result?: ValidationResult | SchemaBaseline; error?: string }
export interface SqlWorkerProgress { kind: "progress"; progress: ValidationProgress }

/** Native ODBC pooling is process-global. Wait for process exit, not just pool.close(). */
export function runSqlWorker<T extends ValidationResult | SchemaBaseline>(operation: SqlWorkerOperation, signal?: AbortSignal,
  workerPath = join(__dirname, "sql-worker.cjs"), cancelGraceMs = 5000,
  onProgress?: (progress: ValidationProgress) => void): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const options: ForkOptions & { windowsHide: boolean } = { windowsHide: true, execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] };
    const child = fork(workerPath, [], options);
    let reply: SqlWorkerReply | undefined;
    let processError: Error | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const forceStop = (): void => { child.kill(); };
    const abort = () => {
      if (child.connected) child.send({ kind: "cancel" }, () => {});
      cancelTimer ??= setTimeout(forceStop, cancelGraceMs);
    };
    child.on("message", message => {
      if (signal?.aborted) return;
      if ((message as SqlWorkerProgress).kind === "progress") {
        try { onProgress?.((message as SqlWorkerProgress).progress); }
        catch (error) {
          processError = error instanceof Error ? error : new Error(String(error));
          forceStop();
        }
        return;
      }
      reply = message as SqlWorkerReply;
    });
    child.on("error", error => { processError = error; });
    child.on("disconnect", () => {
      if (reply || signal?.aborted) return;
      cancelTimer ??= setTimeout(() => {
        if (!reply) {
          processError ??= new Error("SQL worker disconnected before returning a complete result.");
          forceStop();
        }
      }, cancelGraceMs);
    });
    child.on("close", code => {
      if (cancelTimer) clearTimeout(cancelTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { reject(new Error("SQL operation canceled; worker exited and its native resources were released.")); return; }
      if (processError) { reject(processError); return; }
      if (code !== 0 || !reply?.ok || !reply.result) { reject(new Error(reply?.error ?? `SQL worker exited without a complete result (exit ${code}).`)); return; }
      resolve(reply.result as T);
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.send(operation, error => { if (error) { processError = error; child.kill(); } });
    if (signal?.aborted) abort();
  });
}
