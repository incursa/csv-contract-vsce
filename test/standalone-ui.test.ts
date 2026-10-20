import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderStandaloneUi } from "../src/node/standalone-ui";

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

async function completeRun(dom: JSDOM): Promise<void> {
  const document = dom.window.document;
  const path = document.querySelector<HTMLInputElement>("#definition-path")!;
  path.value = "C:\\review.validation.yaml";
  document.querySelector<HTMLFormElement>("#open-form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const confirm = document.querySelector<HTMLInputElement>("#confirm-targets")!;
  confirm.checked = true; confirm.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  document.querySelector<HTMLButtonElement>("#run")!.click();
  await settle();
}

test("standalone UI safely embeds configuration values", () => {
  const html = renderStandaloneUi({
    title: '<img src=x onerror="alert(1)">',
    apiBase: "/api</script><script>alert(2)</script>",
    csrfToken: "token</script><script>alert(3)</script>"
  });

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\([123]\)<\/script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /\\u003c\/script>/);
});

test("standalone UI requires explicit target confirmation and exposes cancellation", () => {
  const html = renderStandaloneUi({ csrfToken: "test-token" });

  assert.match(html, /id="confirm-targets"/);
  assert.match(html, /reviewed every allowed target/);
  assert.match(html, /input\.disabled = true/);
  assert.match(html, /if \(runId\).*active run/);
  assert.match(html, /'SAMPLED','UNKNOWN'/);
  assert.match(html, /run\.hasReview === true/);
  assert.match(html, /definition\.validation\.yaml/);
  assert.match(html, /id="run"[^>]*disabled/);
  assert.match(html, /id="cancel"[^>]*disabled/);
  assert.match(html, /method:'DELETE'/);
  assert.match(html, /Cancel requested; waiting for the active executor to stop\./);
  assert.match(html, /X-Validation-Workbench-CSRF/);
});

test("standalone UI labels Excel as aggregate-only and bounds its fallback", () => {
  const html = renderStandaloneUi({ csrfToken: "test-token" });

  assert.match(html, /Download Excel \(aggregate\)/);
  assert.match(html, /aggregate review results only/);
  assert.match(html, /does not query or include source-row data/);
  assert.match(html, /64 \* 1024 \* 1024/);
  assert.match(html, /desktop save picker or CLI streamed export/);
  assert.match(html, /response\.body\.pipeTo\(destination\)/);
  assert.match(html, /if \(button\.dataset\.path === path\) button\.disabled = false/);
});

test("Excel picker is opened from the click gesture before the authenticated fetch and streams to its writable", async () => {
  const events: string[] = [];
  const written: number[] = [];
  let resolvePicker!: (handle: { createWritable(): Promise<WritableStream<Uint8Array>> }) => void;
  const picker = new Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>(resolve => { resolvePicker = resolve; });
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input); events.push(`fetch:${url}`);
    const authorization = new Headers(init?.headers).get("Authorization");
    assert.equal(authorization, "Bearer browser-token");
    assert.doesNotMatch(url, /browser-token/);
    if (url.endsWith("/open")) return Response.json({ name: "review", kind: "definition", targets: [{ id: "local", label: "Local", allowed: true }] });
    if (url.endsWith("/runs")) return Response.json({ id: "run-1", status: "PASS", hasReview: true });
    if (url.endsWith("/review.xlsx")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }), {
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-length": "3" }
    });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const dom = new JSDOM(renderStandaloneUi({ csrfToken: "browser-token" }), { runScripts: "dangerously", beforeParse(window) {
    Object.assign(window, { fetch: fetchMock, showSaveFilePicker: () => { events.push("picker"); return picker; } });
  } });
  await completeRun(dom);
  events.length = 0;

  dom.window.document.querySelector<HTMLButtonElement>("#download-xlsx")!.click();
  assert.deepEqual(events, ["picker"], "the picker must be invoked synchronously before awaiting or fetching");
  resolvePicker({ createWritable: async () => new WritableStream<Uint8Array>({ write(chunk) { written.push(...chunk); } }) });
  await settle(); await settle();

  assert.deepEqual(events, ["picker", "fetch:/api/runs/run-1/review.xlsx"]);
  assert.deepEqual(written, [1, 2, 3]);
  assert.equal(dom.window.document.querySelector("#run-detail")!.textContent, "Aggregate Excel export saved.");
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#download-xlsx")!.disabled, false);
  dom.window.close();
});

test("Excel fallback refuses an oversized response without buffering and restores the current button", async () => {
  let bodyCanceled = false;
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer browser-token");
    if (url.endsWith("/open")) return Response.json({ name: "review", kind: "definition", targets: [{ id: "local", allowed: true }] });
    if (url.endsWith("/runs")) return Response.json({ id: "run-2", status: "PASS", hasReview: true });
    if (url.endsWith("/review.xlsx")) return new Response(new ReadableStream<Uint8Array>({ cancel() { bodyCanceled = true; } }), { headers: { "content-length": String(64 * 1024 * 1024 + 1) } });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const dom = new JSDOM(renderStandaloneUi({ csrfToken: "browser-token" }), { runScripts: "dangerously", beforeParse(window) { Object.assign(window, { fetch: fetchMock }); } });
  await completeRun(dom);

  const button = dom.window.document.querySelector<HTMLButtonElement>("#download-xlsx")!;
  button.click(); await settle(); await settle();

  assert.equal(bodyCanceled, true);
  assert.match(dom.window.document.querySelector("#run-error")!.textContent!, /desktop save picker or CLI streamed export/);
  assert.equal(button.disabled, false);
  dom.window.close();
});

test("canceling the Excel picker is quiet and does not issue a download request", async () => {
  const urls: string[] = [];
  const fetchMock = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/open")) return Response.json({ name: "review", kind: "definition", targets: [{ id: "local", allowed: true }] });
    if (url.endsWith("/runs")) return Response.json({ id: "run-3", status: "PASS", hasReview: true });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const dom = new JSDOM(renderStandaloneUi({ csrfToken: "browser-token" }), { runScripts: "dangerously", beforeParse(window) {
    Object.assign(window, { fetch: fetchMock, showSaveFilePicker: () => Promise.reject(new DOMException("Canceled", "AbortError")) });
  } });
  await completeRun(dom);

  const before = urls.length;
  const button = dom.window.document.querySelector<HTMLButtonElement>("#download-xlsx")!;
  button.click(); await settle();

  assert.equal(urls.length, before);
  assert.equal(dom.window.document.querySelector("#run-error")!.textContent, "");
  assert.equal(dom.window.document.querySelector("#run-detail")!.textContent, "Excel download canceled.");
  assert.equal(button.disabled, false);
  dom.window.close();
});

test("an Excel picker completion cannot revive or download a stale run export", async () => {
  const urls: string[] = [];
  let resolvePicker!: (handle: { createWritable(): Promise<WritableStream<Uint8Array>> }) => void;
  const picker = new Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>(resolve => { resolvePicker = resolve; });
  const fetchMock = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/open")) return Response.json({ name: "review", kind: "definition", targets: [{ id: "local", allowed: true }] });
    if (url.endsWith("/runs")) return Response.json({ id: "run-4", status: "PASS", hasReview: true });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const dom = new JSDOM(renderStandaloneUi({ csrfToken: "browser-token" }), { runScripts: "dangerously", beforeParse(window) {
    Object.assign(window, { fetch: fetchMock, showSaveFilePicker: () => picker });
  } });
  await completeRun(dom);

  const document = dom.window.document;
  const button = document.querySelector<HTMLButtonElement>("#download-xlsx")!;
  button.click();
  document.querySelector<HTMLInputElement>("#definition-path")!.value = "C:\\new.validation.yaml";
  document.querySelector<HTMLFormElement>("#open-form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const fetchCount = urls.length;
  resolvePicker({ createWritable: async () => new WritableStream<Uint8Array>() });
  await settle();

  assert.equal(urls.length, fetchCount, "the stale run must not be fetched after the picker resolves");
  assert.equal(button.dataset.path, "");
  assert.equal(button.disabled, true);
  dom.window.close();
});
