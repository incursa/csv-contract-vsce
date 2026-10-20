/* global Buffer, clearTimeout, console, fetch, process, setTimeout */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAsInvokerExecutable } from "./lib/windows-pe-manifest.mjs";
import { inspectWindowsProcessToken, inspectWindowsStandardUserToken } from "./lib/windows-standard-user.mjs";
import { inspectWindowsSqlPrerequisites } from "./lib/windows-sql-prerequisites.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(root, "package.json");
const bundlePath = join(root, "dist", "standalone", "validation-runner.cjs");

function fail(message) {
  console.error(`Standalone packaging failed: ${message}`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function smokeLoopbackUi(executable) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawn(executable, ["serve", "--no-browser"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, stopping = false;
    let shutdownTimeout;
    const startupTimeout = setTimeout(() => stop(new Error(`loopback UI smoke timed out.\n${stderr || stdout}`.trim())), 15_000);
    let successValue;
    const complete = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimeout);
      clearTimeout(shutdownTimeout);
      if (error) rejectSmoke(error);
      else resolveSmoke(successValue);
    };
    const stop = (error, value) => {
      if (stopping || settled) return;
      stopping = true;
      successValue = value;
      clearTimeout(startupTimeout);
      if (child.exitCode !== null) return complete(error);
      child.once("exit", () => complete(error));
      child.kill();
      shutdownTimeout = setTimeout(() => complete(error ?? new Error("loopback UI smoke did not stop within 5 seconds.")), 5_000);
    };
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", async chunk => {
      stdout += chunk;
      const url = /Validation Workbench is listening at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1];
      if (!url || settled) return;
      try {
        const response = await fetch(url);
        const html = await response.text();
        if (!response.ok || !html.includes("Validation Workbench")) throw new Error(`loopback UI returned HTTP ${response.status}.`);
        const token = inspectWindowsProcessToken(child.pid);
        stop(undefined, token);
      } catch (error) { stop(error); }
    });
    child.once("error", complete);
    child.once("exit", code => { if (!settled && !stopping) complete(new Error(`loopback UI exited before readiness with code ${code}.\n${stderr || stdout}`.trim())); });
  });
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("this packager currently produces Windows executables and must run on Windows.");
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`unsupported Windows architecture: ${process.arch}.`);
  }

  const seaHelp = run(process.execPath, ["--help"]);
  if (seaHelp.status !== 0 || !`${seaHelp.stdout}\n${seaHelp.stderr}`.includes("--build-sea")) {
    throw new Error(
      `Node ${process.version} does not support --build-sea. Use Node 25.5.0 or newer.`
    );
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const bundle = await stat(bundlePath).catch(() => undefined);
  if (!bundle?.isFile()) {
    throw new Error(
      `${bundlePath} does not exist. Build the production standalone entry before packaging the runner.`
    );
  }

  const nativePackageRoot = join(root, "node_modules", "msnodesqlv8");
  const nativeFiles = [
    join(nativePackageRoot, "package.json"),
    join(nativePackageRoot, "LICENSE"),
    ...await collectFiles(join(nativePackageRoot, "lib")),
    join(nativePackageRoot, "build", "Release", "sqlserver.node")
  ];
  for (const path of nativeFiles) {
    if (!(await stat(path).catch(() => undefined))?.isFile()) {
      throw new Error(`required integrated-auth SQL runtime file is missing: ${path}`);
    }
  }
  const nativeAssets = Object.fromEntries(nativeFiles.map((path) => {
    const relative = path.slice(nativePackageRoot.length + 1).split("\\").join("/");
    return [`node_modules/msnodesqlv8/${relative}`, path];
  }));

  const artifactsDirectory = join(root, "artifacts");
  const artifactName = `validation-runner-${packageJson.version}-win-${process.arch}.exe`;
  const artifactPath = join(artifactsDirectory, artifactName);
  const nonce = `${process.pid}-${randomUUID()}`;
  const temporaryExecutable = join(artifactsDirectory, `.${artifactName}.${nonce}.tmp.exe`);
  const backupExecutable = join(artifactsDirectory, `.${artifactName}.${nonce}.backup.exe`);
  const seaConfigPath = join(artifactsDirectory, `.validation-runner-sea-${nonce}.json`);

  await mkdir(artifactsDirectory, { recursive: true });
  try {
    await writeFile(seaConfigPath, `${JSON.stringify({
      main: bundlePath,
      mainFormat: "commonjs",
      executable: process.execPath,
      output: temporaryExecutable,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
      assets: nativeAssets
    }, null, 2)}\n`, "utf8");

    const build = run(process.execPath, ["--build-sea", seaConfigPath], { timeout: 120_000 });
    if (build.status !== 0) {
      throw new Error(
        `Node SEA build exited with code ${build.status}.\n${build.stderr || build.stdout}`.trim()
      );
    }

    const header = Buffer.alloc(2);
    const executable = await open(temporaryExecutable, "r");
    try {
      const { bytesRead } = await executable.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header[0] !== 0x4d || header[1] !== 0x5a) {
        throw new Error("Node SEA output is not a Windows PE executable.");
      }
    } finally {
      await executable.close();
    }

    const manifest = await verifyAsInvokerExecutable(temporaryExecutable);

    const smoke = run(temporaryExecutable, ["--help"], { timeout: 15_000 });
    if (smoke.status !== 0 || !`${smoke.stdout}\n${smoke.stderr}`.includes("Validation Workbench")) {
      throw new Error(
        `standalone startup check failed (exit ${smoke.status ?? "unknown"}).\n${smoke.stderr || smoke.stdout}`.trim()
      );
    }

    const nativeSmoke = run(temporaryExecutable, ["--native-smoke"], { timeout: 15_000 });
    if (nativeSmoke.status !== 0 || !nativeSmoke.stdout.includes("Native SQL runtime: PASS")) {
      throw new Error(
        `native SQL runtime check failed (exit ${nativeSmoke.status ?? "unknown"}).\n${nativeSmoke.stderr || nativeSmoke.stdout}`.trim()
      );
    }

    const fileSmoke = run(temporaryExecutable, ["test", "--spec", "examples/employees.csvtest.yaml", "--csv", "examples/employees.csv", "--format", "json"], { timeout: 30_000 });
    let fileResult;
    try { fileResult = JSON.parse(fileSmoke.stdout); } catch { /* Report the command output below. */ }
    if (fileSmoke.status !== 0 || fileResult?.valid !== true) {
      throw new Error(`standard file-validation smoke failed (exit ${fileSmoke.status ?? "unknown"}).\n${fileSmoke.stderr || fileSmoke.stdout}`.trim());
    }
    const executableTokenCheck = await smokeLoopbackUi(temporaryExecutable);

    const tokenCheck = inspectWindowsStandardUserToken();
    const sqlPrerequisites = inspectWindowsSqlPrerequisites();

    // Keep the previous artifact recoverable while promoting the validated
    // file. Windows may reject rename-over-existing, so use a bounded swap and
    // restore the prior executable if promotion fails.
    let previousRetained = false;
    try {
      await rename(artifactPath, backupExecutable);
      previousRetained = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await rename(temporaryExecutable, artifactPath);
    } catch (promotionError) {
      if (previousRetained) {
        try {
          await rename(backupExecutable, artifactPath);
        } catch (rollbackError) {
          throw new AggregateError(
            [promotionError, rollbackError],
            `Standalone promotion failed and the previous artifact remains at ${backupExecutable}.`
          );
        }
      }
      throw promotionError;
    }
    if (previousRetained) await rm(backupExecutable, { force: true });

    const artifact = await stat(artifactPath);
    const sha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");

    console.log(`Created ${artifactPath}`);
    console.log(`Runtime: ${process.version} (${process.platform}-${process.arch})`);
    console.log(`Size: ${artifact.size.toLocaleString("en-US")} bytes`);
    console.log(`SHA-256: ${sha256}`);
    console.log(`Startup check: PASS (${basename(artifactPath)} --help)`);
    console.log(`Native SQL runtime check: PASS (${Object.keys(nativeAssets).length} embedded assets)`);
    console.log(`Windows PE manifest: PASS (${manifest.level}, uiAccess=${manifest.uiAccess})`);
    console.log("Standard file validation: PASS (no Node.js installation required)");
    console.log("Loopback UI startup: PASS (127.0.0.1 random port)");
    console.log(tokenCheck.verified && executableTokenCheck.verified
      ? `Standard-user token QA: PASS (packager and launched executable: ${tokenCheck.integrity} integrity, not elevated, Administrators SID not enabled)`
      : `Standard-user token QA: UNVERIFIED (${tokenCheck.reason ?? executableTokenCheck.reason})`);
    console.log(`Optional integrated-auth prerequisite: ${sqlPrerequisites.odbc18 ? "FOUND" : "NOT CONFIRMED"} (${sqlPrerequisites.note})`);
  } finally {
    await rm(seaConfigPath, { force: true });
    await rm(temporaryExecutable, { force: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
