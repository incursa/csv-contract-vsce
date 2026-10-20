import test from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../src/node/standalone-server";

test("standalone server requires its bearer token for every API request", async (t) => {
  const server = await startStandaloneServer({ indexHtml: () => "<!doctype html><title>Runner</title>" });
  t.after(() => server.close());

  const rejected = await fetch(`${server.origin}/api/health`);
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), {
    error: { code: "unauthorized", message: "A valid bearer token is required." }
  });

  const accepted = await fetch(`${server.origin}/api/health`, {
    headers: { Authorization: `Bearer ${server.token}` }
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
});

test("standalone server rejects cross-origin mutations and validates CSRF before dispatch", async (t) => {
  let calls = 0;
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{
      method: "POST",
      path: "/api/run",
      handle: ({ body }) => {
        calls += 1;
        return { received: body };
      }
    }]
  });
  t.after(() => server.close());
  const authorization = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };

  const crossOrigin = await fetch(`${server.origin}/api/run`, {
    method: "POST",
    headers: { ...authorization, Origin: "https://example.invalid", "X-Validation-Workbench-CSRF": server.token },
    body: JSON.stringify({ approved: true })
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json() as { error: { code: string } }).error.code, "invalid_origin");

  const missingCsrf = await fetch(`${server.origin}/api/run`, {
    method: "POST",
    headers: { ...authorization, Origin: server.origin },
    body: JSON.stringify({ approved: true })
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json() as { error: { code: string } }).error.code, "invalid_csrf_token");
  assert.equal(calls, 0);

  const accepted = await fetch(`${server.origin}/api/run`, {
    method: "POST",
    headers: {
      ...authorization,
      Origin: server.origin,
      "X-Validation-Workbench-CSRF": server.token
    },
    body: JSON.stringify({ approved: true })
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { received: { approved: true } });
  assert.equal(calls, 1);
});

test("standalone server rejects a forged Host header", async (t) => {
  const server = await startStandaloneServer({ indexHtml: () => "<!doctype html>" });
  t.after(() => server.close());
  const response = await rawRequest(server.origin, { Host: "attacker.invalid", Authorization: `Bearer ${server.token}` });
  assert.equal(response.status, 421);
  assert.equal((JSON.parse(response.body) as { error: { code: string } }).error.code, "invalid_host");
});

test("standalone server serializes domain status fields as JSON payloads", async (t) => {
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: /^\/api\/runs\/(?<id>[^/]+)$/, handle: ({ params }) => ({ id: params.id, status: "running" }) }]
  });
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/api/runs/example`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "example", status: "running" });
});

test("standalone server streams large responses with supplied headers and cleans up once", async (t) => {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const chunks = 8;
  let cleanups = 0;
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: () => ({
      stream: (async function* () { for (let index = 0; index < chunks; index++) yield chunk; })(),
      cleanup: () => { cleanups++; },
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.length * chunks) }
    }) }]
  });
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/api/export`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(chunk.length * chunks));
  const content = new Uint8Array(await response.arrayBuffer());
  assert.equal(content.length, chunk.length * chunks);
  assert.ok(content.every(value => value === 0x61));
  for (let attempt = 0; attempt < 100 && cleanups === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cleanups, 1);
});

test("standalone server cancels a disconnected stream and cleans up exactly once", async (t) => {
  let cleanups = 0;
  let generatorClosed = false;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: ({ signal }) => ({
      stream: (async function* () {
        try {
          yield Buffer.alloc(64 * 1024, 0x62);
          await wait;
          signal.throwIfAborted();
          yield Buffer.alloc(64 * 1024, 0x63);
        } finally { generatorClosed = true; }
      })(),
      cleanup: () => { cleanups++; }
    }) }]
  });
  t.after(async () => { release(); await server.close(); });

  await new Promise<void>((resolve, reject) => {
    const pending = request(`${server.origin}/api/export`, { headers: { Authorization: `Bearer ${server.token}` } }, response => {
      response.once("data", () => { response.destroy(); resolve(); });
    });
    pending.on("error", reject);
    pending.end();
  });
  release();
  for (let attempt = 0; attempt < 100 && cleanups === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(generatorClosed, true);
  assert.equal(cleanups, 1);
});

test("stream failures close the response without appending a JSON error", async (t) => {
  let cleanups = 0;
  let confirmPrefix!: () => void;
  const prefixReceived = new Promise<void>(resolve => { confirmPrefix = resolve; });
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: () => ({
      stream: (async function* () {
        yield Buffer.from("partial-binary");
        await prefixReceived;
        throw new Error("synthetic stream failure");
      })(),
      cleanup: () => { cleanups++; },
      headers: { "Content-Type": "application/octet-stream" }
    }) }]
  });
  t.after(() => server.close());
  const received = await readUntilClosed(`${server.origin}/api/export`, { Authorization: `Bearer ${server.token}` }, confirmPrefix);
  assert.equal(received.includes("partial-binary"), true);
  assert.doesNotMatch(received, /internal_error|application\/json/);
  assert.equal(cleanups, 1);
});

test("invalid mixed body and stream responses clean up before returning an error", async (t) => {
  let cleanups = 0;
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: () => ({
      body: "not allowed",
      stream: (async function* () { yield Buffer.from("unused"); })(),
      cleanup: () => { cleanups++; }
    }) }]
  });
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/api/export`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: "internal_error", message: "The request could not be completed." } });
  assert.equal(cleanups, 1);
});

test("connection close after a finished stream does not retroactively cancel it", async (t) => {
  let routeSignal: AbortSignal | undefined;
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let cleanupStarted!: () => void;
  const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
  let socketClosed!: () => void;
  const closed = new Promise<void>(resolve => { socketClosed = resolve; });
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: ({ request, signal }) => {
      routeSignal = signal;
      request.socket.once("close", socketClosed);
      return {
        stream: (async function* () { yield Buffer.from("complete"); })(),
        cleanup: async () => { cleanupStarted(); await cleanupGate; }
      };
    } }]
  });
  t.after(async () => { releaseCleanup(); await server.close(); });
  const body = await rawRequest(`${server.origin}/api/export`, {
    Authorization: `Bearer ${server.token}`,
    Connection: "close"
  });
  await started;
  await closed;
  assert.equal(body.body, "complete");
  assert.equal(routeSignal?.aborted, false);
  releaseCleanup();
});

test("server shutdown aborts an in-flight file stream and closes it before cleanup", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "standalone-stream-shutdown-"));
  const path = join(root, "download.bin");
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x64));
  t.after(() => rm(root, { recursive: true, force: true }));
  let routeSignal: AbortSignal | undefined;
  let source: ReturnType<typeof createReadStream> | undefined;
  let cleanups = 0;
  let closedBeforeCleanup = false;
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    routes: [{ method: "GET", path: "/api/export", handle: ({ signal }) => {
      routeSignal = signal;
      source = createReadStream(path, { highWaterMark: 16 * 1024 });
      return {
        stream: source,
        cleanup: async () => {
          cleanups++;
          closedBeforeCleanup = source?.closed === true;
          await rm(path, { force: true });
        }
      };
    } }]
  });
  let received!: () => void;
  const firstChunk = new Promise<void>(resolve => { received = resolve; });
  const clientFinished = new Promise<void>(resolve => {
    const pending = request(`${server.origin}/api/export`, { headers: { Authorization: `Bearer ${server.token}` } }, response => {
      response.once("data", () => { response.pause(); received(); });
      response.once("aborted", resolve);
      response.once("close", resolve);
      response.once("error", resolve);
    });
    pending.once("error", resolve);
    pending.end();
  });
  await firstChunk;
  await Promise.race([
    server.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("server shutdown did not finish")), 2000))
  ]);
  await clientFinished;
  assert.equal(routeSignal?.aborted, true);
  assert.equal(source?.closed, true);
  assert.equal(closedBeforeCleanup, true);
  assert.equal(cleanups, 1);
});

test("invalid initial paths are rejected before a server is created", async () => {
  await assert.rejects(startStandaloneServer({ indexHtml: () => "<!doctype html>", initialPath: "https://example.invalid/" }),
    /origin-relative path/);
});

test("standalone server enforces the JSON body limit before route dispatch", async (t) => {
  let calls = 0;
  const server = await startStandaloneServer({
    indexHtml: () => "<!doctype html>",
    maxBodyBytes: 16,
    routes: [{ method: "POST", path: "/api/run", handle: () => { calls += 1; return { ok: true }; } }]
  });
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/api/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.token}`,
      Origin: server.origin,
      "X-Validation-Workbench-CSRF": server.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ value: "this body is intentionally too large" })
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "body_too_large");
  assert.equal(calls, 0);
});

test("standalone static serving does not escape its configured root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "standalone-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicRoot = join(root, "public");
  await mkdir(publicRoot);
  await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>Safe</title>");
  await writeFile(join(root, "secret.txt"), "must-not-be-served");
  const server = await startStandaloneServer({ staticRoot: publicRoot });
  t.after(() => server.close());

  const response = await rawRequest(`${server.origin}/%2e%2e/secret.txt`, {});
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body, /must-not-be-served/);
});

function rawRequest(origin: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const pending = request(origin, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    pending.on("error", reject);
    pending.end();
  });
}

function readUntilClosed(origin: string, headers: Record<string, string>, onData?: () => void): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const complete = () => resolve(Buffer.concat(chunks).toString("utf8"));
    const pending = request(origin, { headers }, response => {
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); onData?.(); });
      response.on("end", complete);
      response.on("aborted", complete);
      response.on("error", complete);
    });
    pending.on("error", complete);
    pending.end();
  });
}
