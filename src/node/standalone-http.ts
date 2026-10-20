import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const DEFAULT_STANDALONE_BODY_LIMIT = 1024 * 1024;

export class StandaloneHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface StandaloneHttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Streams an already-complete artifact without buffering it in memory. */
  stream?: AsyncIterable<Uint8Array>;
  /** Releases stream-owned resources after completion, failure, or disconnect. */
  cleanup?: () => void | Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireBearerToken(request: IncomingMessage, token: string): void {
  const authorization = headerValue(request, "authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match || !tokensEqual(match[1], token)) {
    throw new StandaloneHttpError(401, "unauthorized", "A valid bearer token is required.");
  }
}

export function requireMutationProtection(request: IncomingMessage, origin: string, token: string): void {
  if (headerValue(request, "origin") !== origin) {
    throw new StandaloneHttpError(403, "invalid_origin", "The request origin is not allowed.");
  }
  const csrf = headerValue(request, "x-validation-workbench-csrf");
  if (!csrf || !tokensEqual(csrf, token)) {
    throw new StandaloneHttpError(403, "invalid_csrf_token", "A valid CSRF token is required.");
  }
}

export function requireLoopbackHost(request: IncomingMessage, expectedHost: string): void {
  if (headerValue(request, "host") !== expectedHost) {
    throw new StandaloneHttpError(421, "invalid_host", "The request host is not allowed.");
  }
}

export async function readJsonBody(request: IncomingMessage, maxBytes = DEFAULT_STANDALONE_BODY_LIMIT): Promise<unknown> {
  const declaredLength = headerValue(request, "content-length");
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new StandaloneHttpError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (parsed > maxBytes) throw new StandaloneHttpError(413, "body_too_large", `The request body exceeds ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) {
      exceeded = true;
    } else if (!exceeded) {
      chunks.push(value);
    }
  }
  if (exceeded) throw new StandaloneHttpError(413, "body_too_large", `The request body exceeds ${maxBytes} bytes.`);
  if (bytes === 0) return undefined;

  const contentType = headerValue(request, "content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new StandaloneHttpError(415, "unsupported_media_type", "Request bodies must use application/json.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StandaloneHttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body === undefined ? null : body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "X-Content-Type-Options": "nosniff"
  });
  response.end(data);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof StandaloneHttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: "internal_error", message: "The request could not be completed." } });
}

export async function sendRouteResponse(response: ServerResponse, result: StandaloneHttpResponse | unknown, signal?: AbortSignal): Promise<void> {
  if (!isHttpResponse(result)) {
    sendJson(response, 200, result);
    return;
  }
  if (Object.hasOwn(result, "stream") || Object.hasOwn(result, "cleanup")) {
    await sendStreamResponse(response, result, signal);
    return;
  }
  const status = result.status ?? (result.body === undefined ? 204 : 200);
  if (result.body === undefined) {
    response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...result.headers });
    response.end();
    return;
  }
  const contentType = result.headers?.["Content-Type"] ?? result.headers?.["content-type"];
  if (!contentType || (typeof result.body !== "string" && !Buffer.isBuffer(result.body))) {
    const data = Buffer.from(JSON.stringify(result.body));
    response.writeHead(status, {
      "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
      "Content-Length": data.length, "X-Content-Type-Options": "nosniff", ...result.headers
    });
    response.end(data);
    return;
  }
  const data = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
  response.writeHead(status, {
    "Cache-Control": "no-store", "Content-Length": data.length,
    "X-Content-Type-Options": "nosniff", ...result.headers
  });
  response.end(data);
}

function isHttpResponse(value: unknown): value is StandaloneHttpResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  // Domain payloads commonly have string statuses such as PASS or running.
  // Only a numeric status, an explicit body, or headers denotes a transport envelope.
  return typeof candidate.status === "number" || Object.hasOwn(candidate, "body") || Object.hasOwn(candidate, "headers") ||
    Object.hasOwn(candidate, "stream") || Object.hasOwn(candidate, "cleanup");
}

async function sendStreamResponse(response: ServerResponse, result: StandaloneHttpResponse, signal?: AbortSignal): Promise<void> {
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await result.cleanup?.();
  };
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let failure: unknown;
  try {
    if (!result.stream) throw new Error("A streaming response requires stream.");
    if (result.body !== undefined) throw new Error("A streaming response cannot also define body.");
    signal?.throwIfAborted();
    const status = result.status ?? 200;
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...result.headers
    });
    iterator = result.stream[Symbol.asyncIterator]();
    while (true) {
      const next = await nextWithCancellation(iterator, result.stream, signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new TypeError("Streaming response chunks must be Uint8Array values.");
      if (!response.write(next.value)) await waitForDrain(response, signal);
    }
    signal?.throwIfAborted();
    response.end();
    await waitForFinish(response, signal);
  } catch (error) {
    failure = error;
    if (response.headersSent && !response.destroyed) response.destroy();
  } finally {
    try {
      await iterator?.return?.();
      await waitForSourceClose(result.stream);
    } catch (error) {
      failure ??= error;
    }
    try {
      await cleanup();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], "Streaming response and cleanup both failed.");
    }
  }
  if (failure !== undefined) throw failure;
}

function waitForSourceClose(stream: AsyncIterable<Uint8Array> | undefined): Promise<void> {
  const source = stream as (AsyncIterable<Uint8Array> & {
    closed?: boolean;
    once?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
  }) | undefined;
  if (!source || typeof source.closed !== "boolean" || typeof source.once !== "function" || source.closed) return Promise.resolve();
  return new Promise(resolve => {
    const closed = (): void => {
      source.off?.("close", closed);
      resolve();
    };
    source.once!("close", closed);
    if (source.closed) closed();
  });
}

async function nextWithCancellation(
  iterator: AsyncIterator<Uint8Array>,
  stream: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<IteratorResult<Uint8Array>> {
  if (!signal) return iterator.next();
  signal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (): void => {
    const destroy = (stream as AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }).destroy;
    if (typeof destroy === "function") destroy.call(stream, abortReason(signal));
    rejectAbort(signal.reason ?? abortReason(signal));
  };
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([iterator.next(), aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

function waitForDrain(response: ServerResponse, signal?: AbortSignal): Promise<void> {
  return waitForResponseEvent(response, "drain", signal);
}

function waitForFinish(response: ServerResponse, signal?: AbortSignal): Promise<void> {
  if (response.writableFinished) return Promise.resolve();
  return waitForResponseEvent(response, "finish", signal);
}

function waitForResponseEvent(response: ServerResponse, event: "drain" | "finish", signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: unknown): void => {
      response.off(event, success);
      response.off("close", closed);
      response.off("error", failed);
      signal?.removeEventListener("abort", aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const success = (): void => settle();
    const closed = (): void => settle(new Error("Streaming response closed before completion."));
    const failed = (error: Error): void => settle(error);
    const aborted = (): void => settle(signal?.reason ?? abortReason(signal));
    response.once(event, success);
    response.once("close", closed);
    response.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

export async function serveStaticFile(
  response: ServerResponse,
  staticRoot: string,
  pathname: string,
  headOnly: boolean,
  spaFallback = true
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new StandaloneHttpError(400, "invalid_path", "The request path is invalid.");
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) {
    throw new StandaloneHttpError(400, "invalid_path", "The request path is invalid.");
  }

  const root = await realpath(staticRoot);
  let requested = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  if (!isInside(root, requested)) throw new StandaloneHttpError(403, "path_outside_root", "The request path is not allowed.");
  let info = await stat(requested).catch(() => undefined);
  if (info?.isDirectory()) {
    requested = resolve(requested, "index.html");
    info = await stat(requested).catch(() => undefined);
  }
  if ((!info || !info.isFile()) && spaFallback && !extname(decoded)) {
    requested = resolve(root, "index.html");
    info = await stat(requested).catch(() => undefined);
  }
  if (!info?.isFile()) return false;

  const canonical = await realpath(requested);
  if (!isInside(root, canonical)) throw new StandaloneHttpError(403, "path_outside_root", "The request path is not allowed.");
  const data = await readFile(canonical);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": CONTENT_TYPES[extname(canonical).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": data.length,
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(headOnly ? undefined : data);
  return true;
}

export function sendHtml(response: ServerResponse, html: string, headOnly: boolean): void {
  const data = Buffer.from(html);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": data.length,
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(headOnly ? undefined : data);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
