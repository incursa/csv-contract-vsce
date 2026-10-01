import { rm } from "node:fs/promises";

try {
  await rm("dist", { recursive: true, force: true });
} catch (error) {
  const lockedDriver = ["EPERM", "EBUSY"].includes(error?.code)
    && String(error?.path ?? "").replaceAll("\\", "/").includes("/dist/node_modules/msnodesqlv8/");
  if (!lockedDriver) throw error;
  // A running extension host can hold the native driver open on Windows. Clean
  // every replaceable output while retaining that byte-identical binary.
  await Promise.all(["web", "node", "cli", "test"].map(name => rm(`dist/${name}`, { recursive: true, force: true })));
  // Keep the loaded driver tree in place. The build copies current runtime
  // files over it and avoids replacing the native binary when it is identical.
}
