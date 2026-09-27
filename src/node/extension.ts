import * as vscode from "vscode";
import { activate as activateShared, deactivate, sqlConnectionSecretKey } from "../extension";
import { compareCsvFilesDesktop } from "./semantic-comparison";
import { SqlServerValidationSession } from "./sql-server-validator";
import { withSqlSession } from "./sql-lifecycle";
import { runSqlWorker } from "./sql-worker-client";
import { validateCsvFile } from "./streaming-validator";

export function activate(context: vscode.ExtensionContext): void {
  let scopePromptTail = Promise.resolve();
  const createSession = () => new SqlServerValidationSession(async (profile) => {
    const secret = await context.secrets.get(sqlConnectionSecretKey(profile));
    const environmentName = `CSV_CONTRACT_SQLSERVER_${profile.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const connectionString = secret ?? process.env[environmentName];
    if (!connectionString) {
      throw new Error(`SQL Server connection profile '${profile}' is not configured. Run “CSV Contract: Configure SQL Server Connection” or set ${environmentName}.`);
    }
    return connectionString;
  });
  activateShared(context, compareCsvFilesDesktop, async (contract, target, signal, preview, onProgress, maxIssues) => {
    let scopeValue: string | undefined;
    if (target.scope && !target.scope.valueEnvironment) {
      const previous = scopePromptTail;
      let release!: () => void;
      scopePromptTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        signal?.throwIfAborted();
        scopeValue = await vscode.window.showInputBox({
          title: `Scope ${target.schema}.${target.table}`,
          prompt: `Value for @${target.scope.parameter}. It is bound as a query parameter and is not stored.`,
          password: true,
          ignoreFocusOut: true
        });
      } finally { release(); }
      if (scopeValue === undefined) throw new Error("SQL Server validation was cancelled because no scope value was supplied.");
    }
    if (target.integratedConnection) return runSqlWorker({ kind: "validate", contract, target, options: { scopeValue, preview, maxIssues } }, signal,
      undefined, 5000, onProgress);
    return withSqlSession(createSession, session => session.validate(contract, target, { scopeValue, signal, preview, onProgress, maxIssues }));
  }, profile => withSqlSession(createSession, session => session.listObjects(profile)),
  target => target.integratedConnection ? runSqlWorker({ kind: "schema", target }) : withSqlSession(createSession, session => session.captureSchema(target)),
  (plan, signal) => plan.from.integratedConnection ? runSqlWorker({ kind: "cross", plan }, signal) : withSqlSession(createSession, session => session.validateCross(plan, signal)),
  async (contract, source, target, signal, onProgress, maxIssues) => {
    if (typeof target.source === "string" || target.source.scheme !== "file") return undefined;
    const specPath = vscode.Uri.parse(source).fsPath;
    const output = await validateCsvFile(target.source.fsPath, [{ spec: specPath, contract }],
      { signal, progressInterval: 1000, onRunProgress: onProgress, maxIssues });
    return output.runs[0].result;
  });
}

export { deactivate };
