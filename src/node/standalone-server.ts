import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_STANDALONE_BODY_LIMIT,
  StandaloneHttpError,
  readJsonBody,
  requireBearerToken,
  requireLoopbackHost,
  requireMutationProtection,
  sendError,
  sendHtml,
  sendJson,
  sendRouteResponse,
  serveStaticFile,
  type StandaloneHttpResponse
} from "./standalone-http";

export interface StandaloneRouteContext {
  request: IncomingMessage;
  method: string;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

export interface StandaloneRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string | RegExp;
  handle(context: StandaloneRouteContext): Promise<StandaloneHttpResponse | unknown> | StandaloneHttpResponse | unknown;
}

export interface StandaloneServerOptions {
  /** Static assets to serve. Omit for a single embedded index document. */
  staticRoot?: string;
  /** Creates the root document and lets SEA builds bootstrap the per-process token. */
  indexHtml?: (token: string) => string | Promise<string>;
  routes?: readonly StandaloneRoute[];
  maxBodyBytes?: number;
  initialPath?: string;
  spaFallback?: boolean;
}

export interface StandaloneServerHandle {
  origin: string;
  url: string;
  token: string;
  close(): Promise<void>;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function startStandaloneServer(options: StandaloneServerOptions = {}): Promise<StandaloneServerHandle> {
  if (!options.staticRoot && !options.indexHtml) {
    throw new Error("A staticRoot or indexHtml callback is required.");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_STANDALONE_BODY_LIMIT;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be a positive integer.");
  const initialPath = normalizeInitialPath(options.initialPath);
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  let expectedHost = "";
  const activeRequests = new Map<AbortController, Promise<void>>();

  const server = createServer(async (request, response) => {
    try {
      requireLoopbackHost(request, expectedHost);
      const requestUrl = new URL(request.url ?? "/", origin);
      const method = request.method?.toUpperCase() ?? "GET";
      if (requestUrl.pathname.startsWith("/api/")) {
        requireBearerToken(request, token);
        if (MUTATING_METHODS.has(method)) requireMutationProtection(request, origin, token);
        if (requestUrl.pathname === "/api/health" && method === "GET") {
          sendJson(response, 200, { ok: true });
          return;
        }
        const matched = findRoute(options.routes ?? [], method, requestUrl.pathname);
        if (!matched) throw new StandaloneHttpError(404, "not_found", "The API route was not found.");
        const controller = new AbortController();
        let completeRequest!: () => void;
        const requestCompleted = new Promise<void>(resolve => { completeRequest = resolve; });
        const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
        const responseClosed = (): void => { if (!response.writableFinished) abort(); };
        activeRequests.set(controller, requestCompleted);
        request.once("aborted", abort);
        response.once("close", responseClosed);
        try {
          if (request.aborted || response.destroyed) abort();
          controller.signal.throwIfAborted();
          const body = MUTATING_METHODS.has(method) ? await readJsonBody(request, maxBodyBytes) : undefined;
          controller.signal.throwIfAborted();
          const result = await matched.route.handle({
            request, method, pathname: requestUrl.pathname, query: requestUrl.searchParams,
            params: matched.params, body, signal: controller.signal
          });
          if (!response.headersSent) await sendRouteResponse(response, result, controller.signal);
        } finally {
          activeRequests.delete(controller);
          completeRequest();
          request.off("aborted", abort);
          response.off("close", responseClosed);
        }
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        throw new StandaloneHttpError(405, "method_not_allowed", "Only GET and HEAD are allowed for browser assets.");
      }
      if (requestUrl.pathname === "/" && options.indexHtml) {
        sendHtml(response, await options.indexHtml(token), method === "HEAD");
        return;
      }
      if (options.staticRoot && await serveStaticFile(response, options.staticRoot, requestUrl.pathname, method === "HEAD", options.spaFallback)) return;
      throw new StandaloneHttpError(404, "not_found", "The requested asset was not found.");
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    origin,
    url: `${origin}${initialPath}`,
    token,
    close: () => closeServer(server, activeRequests)
  };
}

function findRoute(routes: readonly StandaloneRoute[], method: string, pathname: string): { route: StandaloneRoute; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return { route, params: {} };
      continue;
    }
    route.path.lastIndex = 0;
    const match = route.path.exec(pathname);
    if (match && match[0] === pathname) return { route, params: match.groups ?? {} };
  }
  return undefined;
}

function normalizeInitialPath(value = "/"): string {
  if (!value.startsWith("/") || value.startsWith("//")) throw new Error("initialPath must be an origin-relative path.");
  const parsed = new URL(value, "http://127.0.0.1");
  if (parsed.origin !== "http://127.0.0.1") throw new Error("initialPath must be an origin-relative path.");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server, activeRequests: ReadonlyMap<AbortController, Promise<void>>): Promise<void> {
  const closeNetwork = new Promise<void>((resolve, reject) => {
    server.closeIdleConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  });
  const drainRequests = async (): Promise<void> => {
    while (activeRequests.size > 0) {
      const pending = [...activeRequests.entries()];
      pending.forEach(([controller]) => controller.abort());
      await Promise.allSettled(pending.map(([, completed]) => completed));
    }
  };
  await Promise.all([closeNetwork, drainRequests()]);
}
