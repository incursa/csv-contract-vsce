import * as vscode from "vscode";
import { activate as activateShared, deactivate, sqlConnectionSecretKey } from "../extension";
import { compareCsvFilesDesktop } from "./semantic-comparison";
import { SqlServerValidationSession } from "./sql-server-validator";
import { withSqlSession } from "./sql-lifecycle";

export function activate(context: vscode.ExtensionContext): void {
  const createSession = () => new SqlServerValidationSession(async (profile) => {
    const secret = await context.secrets.get(sqlConnectionSecretKey(profile));
    const environmentName = `CSV_CONTRACT_SQLSERVER_${profile.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const connectionString = secret ?? process.env[environmentName];
    if (!connectionString) {
      throw new Error(`SQL Server connection profile '${profile}' is not configured. Run “CSV Contract: Configure SQL Server Connection” or set ${environmentName}.`);
    }
    return connectionString;
  });
  activateShared(context, compareCsvFilesDesktop, async (contract, target, signal, preview) => {
    let scopeValue: string | undefined;
    if (target.scope && !target.scope.valueEnvironment) {
      scopeValue = await vscode.window.showInputBox({
        title: `Scope ${target.schema}.${target.table}`,
        prompt: `Value for @${target.scope.parameter}. It is bound as a query parameter and is not stored.`,
        password: true,
        ignoreFocusOut: true
      });
      if (scopeValue === undefined) throw new Error("SQL Server validation was cancelled because no scope value was supplied.");
    }
    return withSqlSession(createSession, session => session.validate(contract, target, { scopeValue, signal, preview }));
  }, profile => withSqlSession(createSession, session => session.listObjects(profile)),
  target => withSqlSession(createSession, session => session.captureSchema(target)),
  (plan, signal) => withSqlSession(createSession, session => session.validateCross(plan, signal)));
}

export { deactivate };
