import { SqlServerValidationSession } from "./sql-server-validator";
import { withSqlSession } from "./sql-lifecycle";
import { errorDetails } from "../core/error-details";
import type { SqlWorkerOperation, SqlWorkerReply } from "./sql-worker-client";

const controller = new AbortController();
let started = false;
const finish = (reply: SqlWorkerReply) => {
  if (!process.send) { process.exit(1); return; }
  process.send(reply, () => { process.exit(reply.ok ? 0 : 1); });
};
process.on("disconnect", () => { process.exit(1); });
process.on("message", (message: SqlWorkerOperation | { kind: "cancel" }) => {
  if (message.kind === "cancel") { controller.abort(); return; }
  if (started) return;
  started = true;
  void withSqlSession(() => new SqlServerValidationSession(() => { throw new Error("The isolated SQL worker accepts integrated connections only."); }), async session => {
    if (message.kind === "schema") return session.captureSchema(message.target);
    if (message.kind === "cross") return session.validateCross(message.plan, controller.signal);
    return session.validate(message.contract, message.target, { ...message.options, signal: controller.signal });
  }).then(result => finish({ ok: true, result }), error => finish({ ok: false, error: errorDetails(error) }));
});
