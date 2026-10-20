import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { getAssetKeys, getRawAsset, isSea } from "node:sea";

const NATIVE_ASSET_PREFIX = "node_modules/msnodesqlv8/";

export interface StandaloneNativeRuntime {
  root: string;
  moduleRoot: string;
  assetKeys: string[];
}

export interface StandaloneNativeSqlDriver {
  open: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

let prepared: StandaloneNativeRuntime | undefined;

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs govern effective access. */ }
}

/** Extracts the native SQL driver embedded in a SEA into a private process directory. */
export function prepareStandaloneNativeRuntime(): StandaloneNativeRuntime | undefined {
  if (!isSea()) return undefined;
  if (prepared) return prepared;

  const assetKeys = getAssetKeys()
    .filter((key) => key.startsWith(NATIVE_ASSET_PREFIX))
    .sort();
  if (!assetKeys.includes(`${NATIVE_ASSET_PREFIX}package.json`)
    || !assetKeys.includes(`${NATIVE_ASSET_PREFIX}build/Release/sqlserver.node`)
    || !assetKeys.some((key) => key.startsWith(`${NATIVE_ASSET_PREFIX}lib/`))) {
    throw new Error("The standalone executable is missing required integrated-auth SQL assets.");
  }

  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), "validation-workbench-native-"));
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `Unable to create private runtime files in the current user's temporary directory. Check TEMP/TMP availability and permissions${detail}`
    );
  }
  privateDirectory(root);
  const moduleRoot = resolve(root, "node_modules", "msnodesqlv8");
  privateDirectory(moduleRoot);

  try {
    for (const key of assetKeys) {
      const relative = key.slice("node_modules/".length);
      const destination = resolve(root, "node_modules", ...relative.split("/"));
      const allowedRoot = resolve(root, "node_modules") + sep;
      if (!destination.startsWith(allowedRoot)) throw new Error(`Unsafe embedded asset path: ${key}`);
      privateDirectory(dirname(destination));
      writeFileSync(destination, Buffer.from(getRawAsset(key)), { mode: 0o600 });
    }

    const nodeModules = resolve(root, "node_modules");
    process.env.NODE_PATH = process.env.NODE_PATH
      ? `${nodeModules}${delimiter}${process.env.NODE_PATH}`
      : nodeModules;
    (Module as typeof Module & { _initPaths(): void })._initPaths();

    prepared = { root, moduleRoot, assetKeys };
    process.once("exit", () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Best effort. */ }
    });
    return prepared;
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Best effort. */ }
    throw error;
  }
}

/** Loads the extracted add-on with an ordinary filesystem-backed require. */
export function loadStandaloneNativeSqlDriver(): StandaloneNativeSqlDriver {
  const runtime = prepareStandaloneNativeRuntime();
  if (!runtime) throw new Error("The standalone native SQL driver is only available inside the packaged executable.");
  const filesystemRequire = createRequire(join(runtime.moduleRoot, "package.json"));
  return filesystemRequire("msnodesqlv8") as StandaloneNativeSqlDriver;
}
