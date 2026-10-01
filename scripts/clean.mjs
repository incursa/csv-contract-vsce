import { rm } from "node:fs/promises";

try {
  await rm("dist", { recursive: true, force: true });
} catch (error) {
  const lockedNative = ["EPERM", "EBUSY"].includes(error?.code)
    && String(error?.path ?? "").replaceAll("\\", "/").endsWith("/dist/node_modules/msnodesqlv8/build/Release/sqlserver.node");
  if (!lockedNative) throw error;
  // A running extension host can hold the native driver open on Windows. Clean
  // every replaceable output while retaining that byte-identical binary.
  await Promise.all(["web", "node", "cli", "test"].map(name => rm(`dist/${name}`, { recursive: true, force: true })));
  await rm("dist/node_modules/msnodesqlv8/lib", { recursive: true, force: true });
  await rm("dist/node_modules/msnodesqlv8/package.json", { force: true });
  await rm("dist/node_modules/msnodesqlv8/LICENSE", { force: true });
}
