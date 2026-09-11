/** Completion includes cleanup. A cleanup failure must never become a successful run. */
export async function withSqlSession<S extends { dispose(): Promise<void> }, T>(create: () => S, operation: (session: S) => Promise<T>): Promise<T> {
  const session = create();
  let failed = false;
  let operationError: unknown;
  let result!: T;
  try { result = await operation(session); }
  catch (error) { failed = true; operationError = error; }
  try { await session.dispose(); }
  catch (cleanupError) {
    if (failed) throw new AggregateError([operationError, cleanupError], "SQL operation and connection cleanup both failed.");
    throw new AggregateError([cleanupError], "SQL connection cleanup failed; closure could not be confirmed.");
  }
  if (failed) throw operationError;
  return result;
}
