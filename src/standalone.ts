import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { runCli } from "./cli";
import { StandaloneHttpError, type StandaloneHttpResponse } from "./node/standalone-http";
import { inspectStandaloneDefinition, runStandaloneDefinition, type StandaloneDefinition, type StandaloneRunProgress, type StandaloneRunResult } from "./node/standalone-runner";
import { startStandaloneServer, type StandaloneRoute, type StandaloneServerHandle } from "./node/standalone-server";
import { prepareStandaloneNativeRuntime } from "./node/standalone-native";
import { renderStandaloneUi } from "./node/standalone-ui";
import { createStandaloneWorkbookDownload } from "./node/standalone-workbook";
import packageJson from "../package.json";
import { redactSecrets } from "./core/evidence-redaction";

const standaloneNativeRuntime = prepareStandaloneNativeRuntime();

export const standaloneUsage = `Validation Workbench Standalone Runner

Usage:
  validation-runner [serve] [--open <definition-or-suite>] [--no-browser]
  validation-runner --help
  validation-runner <command> [options]
  validation-runner export --source <validation-review.json> --out <report.xlsx>

With no command, the runner opens a minimal browser UI on a random loopback-only port.
Legacy commands include test, dbtest, init, sql, schema, combine, and split.
Offline commands include review, diff, export, fixtures, and explain.
Run commands with --help for their CLI options. Administrator privileges are not required.
`;

type RunStatus = "queued" | "running" | "PASS" | "FAIL" | "ERROR" | "CANCELED" | "SKIPPED" | "SAMPLED";
interface AppRun {
  id: string;
  path: string;
  status: RunStatus;
  progress?: StandaloneRunProgress;
  message?: string;
  error?: string;
  controller: AbortController;
  completion?: Promise<void>;
  result?: StandaloneRunResult;
}

export interface StandaloneAppOptions {
  initialPath?: string;
  openBrowser?: boolean;
}

export interface StandaloneAppHandle extends StandaloneServerHandle {
  selected(): StandaloneDefinition | undefined;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StandaloneHttpError(400, "invalid_body", "A JSON object is required.");
  return body as Record<string, unknown>;
}

function publicRun(run: AppRun) {
  return { id: run.id, runId: run.id, status: run.status, progress: run.progress, message: run.message, error: run.error,
    hasReview: !!run.result, ...(run.result ? { summary: run.result.report.summary } : {}) };
}

function download(body: string, contentType: string, filename: string): StandaloneHttpResponse {
  return { body, headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename.replaceAll('"', "")}"` } };
}

export async function startStandaloneApp(options: StandaloneAppOptions = {}): Promise<StandaloneAppHandle> {
  let selected: StandaloneDefinition | undefined;
  const runs = new Map<string, AppRun>();
  let closing = false;
  let workbookActive = false;
  const routes: StandaloneRoute[] = [
    { method: "GET", path: "/api/state", handle: () => ({ selectedPath: selected?.path, name: selected?.id, kind: selected?.kind, fingerprint: selected?.fingerprint, targets: selected?.targets ?? [] }) },
    { method: "POST", path: "/api/open", handle: async ({ body }) => {
      if ([...runs.values()].some((run) => run.status === "queued" || run.status === "running")) {
        throw new StandaloneHttpError(409, "run_active", "Cancel or wait for the active run before opening another definition.");
      }
      const value = objectBody(body).path;
      if (typeof value !== "string" || !value.trim()) throw new StandaloneHttpError(400, "invalid_path", "A non-empty local definition or suite path is required.");
      selected = await inspectStandaloneDefinition(value.trim());
      return { selectedPath: selected.path, name: selected.id, kind: selected.kind, fingerprint: selected.fingerprint, targets: selected.targets, errors: selected.errors };
    } },
    { method: "POST", path: "/api/runs", handle: ({ body }) => {
      if (closing) throw new StandaloneHttpError(503, "server_closing", "The standalone runner is shutting down.");
      if (!selected) throw new StandaloneHttpError(409, "definition_not_open", "Open a definition or suite before starting a run.");
      if ([...runs.values()].some((run) => run.status === "queued" || run.status === "running")) {
        throw new StandaloneHttpError(409, "run_active", "Wait for the active run to finish or cancel it before starting another.");
      }
      while (runs.size >= 20) runs.delete(runs.keys().next().value!);
      const targetIds = objectBody(body).targetIds;
      if (!Array.isArray(targetIds) || targetIds.some((id) => typeof id !== "string")) throw new StandaloneHttpError(400, "invalid_targets", "targetIds must be a string array.");
      const id = randomUUID();
      const controller = new AbortController();
      const path = selected.path;
      const run: AppRun = { id, path, status: "queued", controller };
      runs.set(id, run);
      const expectedFingerprint = selected.fingerprint;
      run.completion = (async () => {
        run.status = "running";
        try {
          run.result = await runStandaloneDefinition(path, {
            targetIds, signal: controller.signal, toolVersion: packageJson.version, expectedFingerprint,
            onProgress: (progress) => { run.progress = progress; }
          });
          run.status = run.result.report.status;
          run.message = `${run.result.report.runs.length} validation result(s).`;
        } catch (error) {
          if (controller.signal.aborted) {
            run.status = "CANCELED";
            run.message = "Cancellation completed; partial results were discarded.";
          } else {
            run.status = "ERROR";
            run.error = redactSecrets(error instanceof Error ? error.message : String(error));
          }
        }
      })();
      return { status: 202, body: publicRun(run) };
    } },
    { method: "GET", path: /^\/api\/runs\/(?<id>[^/]+)$/, handle: ({ params }) => {
      const run = runs.get(params.id);
      if (!run) throw new StandaloneHttpError(404, "run_not_found", "The run was not found.");
      return publicRun(run);
    } },
    { method: "DELETE", path: /^\/api\/runs\/(?<id>[^/]+)$/, handle: ({ params }) => {
      const run = runs.get(params.id);
      if (!run) throw new StandaloneHttpError(404, "run_not_found", "The run was not found.");
      if (run.status === "queued" || run.status === "running") {
        run.controller.abort();
        run.message = "Cancellation requested; waiting for the active executor to stop.";
      }
      return publicRun(run);
    } },
    { method: "GET", path: /^\/api\/runs\/(?<id>[^/]+)\/review\.json$/, handle: ({ params }) => {
      const run = runs.get(params.id);
      if (!run?.result) throw new StandaloneHttpError(409, "review_unavailable", "The review package is not available for this run.");
      return download(run.result.reviewJson, "application/json; charset=utf-8", `${basename(run.path)}-review.json`);
    } },
    { method: "GET", path: /^\/api\/runs\/(?<id>[^/]+)\/review\.html$/, handle: ({ params }) => {
      const run = runs.get(params.id);
      if (!run?.result) throw new StandaloneHttpError(409, "report_unavailable", "The offline report is not available for this run.");
      return download(run.result.reportHtml, "text/html; charset=utf-8", `${basename(run.path)}-review.html`);
    } },
    { method: "GET", path: /^\/api\/runs\/(?<id>[^/]+)\/review\.xlsx$/, handle: async ({ params, signal }) => {
      if (closing) throw new StandaloneHttpError(503, "server_closing", "The standalone runner is shutting down.");
      const run = runs.get(params.id);
      if (!run?.result) throw new StandaloneHttpError(409, "report_unavailable", "The Excel report is not available for this run.");
      if (workbookActive) throw new StandaloneHttpError(409, "export_active", "Wait for the current Excel export to finish or cancel its download.");
      workbookActive = true;
      try {
        const artifact = await createStandaloneWorkbookDownload(run.result.reviewPackage, signal);
        return { ...artifact, cleanup: async () => {
          try { await artifact.cleanup?.(); }
          finally { workbookActive = false; }
        } };
      } catch (error) {
        workbookActive = false;
        throw error;
      }
    } }
  ];
  if (options.initialPath) selected = await inspectStandaloneDefinition(options.initialPath);
  const server = await startStandaloneServer({ routes, indexHtml: (token) => renderStandaloneUi({ csrfToken: token, title: "Validation Workbench" }) });
  let closingPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    closingPromise = (async () => {
      for (const run of runs.values()) if (run.status === "queued" || run.status === "running") run.controller.abort();
      await Promise.allSettled([...runs.values()].flatMap((run) => run.completion ? [run.completion] : []));
      await server.close();
    })();
    return closingPromise;
  };
  const handle: StandaloneAppHandle = { ...server, close, selected: () => selected };
  if (options.openBrowser !== false) openBrowser(server.url);
  return handle;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function runStandaloneMain(argv: string[]): Promise<number> {
  if (argv[0] === "--native-smoke") {
    if (!standaloneNativeRuntime) throw new Error("Native SQL runtime smoke testing requires the packaged standalone executable.");
    const nativeDriver = (await import("msnodesqlv8")).default;
    if (typeof nativeDriver?.open !== "function") throw new Error("The embedded native SQL driver did not expose its open function.");
    console.log(`Native SQL runtime: PASS (${standaloneNativeRuntime.assetKeys.length} embedded assets)`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(standaloneUsage);
    return 0;
  }
  if (argv.length === 0 || argv[0] === "serve") {
    const rest = argv[0] === "serve" ? argv.slice(1) : argv;
    let initialPath: string | undefined;
    let open = true;
    while (rest.length) {
      const token = rest.shift();
      if (token === "--no-browser") { open = false; continue; }
      if (token === "--open" && rest.length) { initialPath = rest.shift(); continue; }
      throw new Error(`Unknown serve option: ${token ?? ""}\n\n${standaloneUsage}`);
    }
    const app = await startStandaloneApp({ initialPath, openBrowser: open });
    console.log(`Validation Workbench is listening at ${app.url}`);
    const stop = async () => { await app.close(); process.exitCode = 0; };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
    return 0;
  }
  return runCli(argv);
}
