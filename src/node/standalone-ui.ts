export interface StandaloneUiOptions {
  apiBase?: string;
  title?: string;
  csrfToken?: string;
}

const jsonForScript = (value: unknown): string => JSON.stringify(value)
  .replaceAll("<", "\\u003c")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");

/** Renders the dependency-free browser client served by the standalone runner. */
export function renderStandaloneUi(options: StandaloneUiOptions = {}): string {
  const config = jsonForScript({
    apiBase: (options.apiBase ?? "/api").replace(/\/$/, ""),
    title: options.title ?? "CSV Contract Standalone Runner",
    csrfToken: options.csrfToken ?? ""
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(options.title ?? "CSV Contract Standalone Runner")}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --accent:#2463eb; --border:#9aa3b2; --muted:#667085; --panel:#f7f8fa; --danger:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; background:Canvas; color:CanvasText; }
    main { width:min(900px, calc(100% - 32px)); margin:32px auto; }
    h1 { margin:0 0 6px; font-size:1.55rem; }
    h2 { margin:0 0 12px; font-size:1.05rem; }
    p { margin:6px 0; }
    .muted { color:var(--muted); }
    .stack { display:grid; gap:16px; }
    .card { border:1px solid var(--border); border-radius:10px; padding:16px; background:var(--panel); }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    input[type="text"] { flex:1 1 420px; min-width:0; padding:9px 10px; border:1px solid var(--border); border-radius:6px; background:Canvas; color:CanvasText; }
    button, .download { border:1px solid var(--border); border-radius:6px; padding:8px 12px; background:Canvas; color:CanvasText; font:inherit; cursor:pointer; text-decoration:none; }
    button.primary { background:var(--accent); border-color:var(--accent); color:white; }
    button.danger { color:var(--danger); }
    button:disabled, .download[aria-disabled="true"] { opacity:.5; cursor:not-allowed; pointer-events:none; }
    fieldset { border:0; padding:0; margin:0; }
    .targets { display:grid; gap:8px; margin:12px 0; }
    .target { display:grid; grid-template-columns:auto 1fr; gap:2px 9px; align-items:start; }
    .target small { grid-column:2; color:var(--muted); }
    .confirm { margin-top:14px; padding-top:12px; border-top:1px solid var(--border); }
    progress { width:100%; height:12px; margin:12px 0 4px; }
    .status { font-weight:650; }
    .error { color:var(--danger); white-space:pre-wrap; }
    [hidden] { display:none !important; }
    @media (prefers-color-scheme:dark) { :root { --panel:#17191d; --border:#596170; --muted:#aab2c0; } }
  </style>
</head>
<body>
<main class="stack">
  <header><h1 id="page-title"></h1><p class="muted">Open a definition or suite, review its permitted targets, then run it locally.</p></header>
  <section class="card" aria-labelledby="open-heading">
    <h2 id="open-heading">1. Open definition or suite</h2>
    <form id="open-form" class="row">
      <input id="definition-path" type="text" autocomplete="off" spellcheck="false" required aria-label="Definition or suite path" placeholder="C:\\path\\to\\definition.validation.yaml">
      <button id="open-button" class="primary" type="submit">Open</button>
    </form>
    <p id="open-message" class="muted" role="status"></p>
  </section>
  <section id="targets-card" class="card" aria-labelledby="targets-heading" hidden>
    <h2 id="targets-heading">2. Confirm all allowed targets</h2>
    <p id="definition-summary" class="muted"></p>
    <fieldset id="targets" class="targets"></fieldset>
    <label class="row confirm"><input id="confirm-targets" type="checkbox"> I reviewed every allowed target shown above and approve running all of them.</label>
    <div class="row" style="margin-top:12px"><button id="run" class="primary" type="button" disabled>Run validation</button></div>
  </section>
  <section id="run-card" class="card" aria-labelledby="run-heading" hidden>
    <h2 id="run-heading">3. Run</h2>
    <p id="run-status" class="status" role="status">Waiting</p>
    <progress id="run-progress" max="100" value="0"></progress>
    <p id="run-detail" class="muted"></p>
    <p id="run-error" class="error" role="alert"></p>
    <div class="row">
      <button id="cancel" class="danger" type="button" disabled>Cancel run</button>
      <button id="download-json" class="download" type="button" disabled>Download review JSON</button>
      <button id="download-html" class="download" type="button" disabled>Download offline HTML</button>
      <button id="download-xlsx" class="download" type="button" disabled>Download Excel (aggregate)</button>
    </div>
    <p class="muted">The Excel export contains aggregate review results only. It does not query or include source-row data.</p>
  </section>
</main>
<script>
(() => {
  'use strict';
  const config = ${config};
  const byId = id => document.getElementById(id);
  const els = {
    title: byId('page-title'), openForm: byId('open-form'), openButton: byId('open-button'), path: byId('definition-path'), openMessage: byId('open-message'),
    targetsCard: byId('targets-card'), summary: byId('definition-summary'), targets: byId('targets'), confirm: byId('confirm-targets'), run: byId('run'),
    runCard: byId('run-card'), status: byId('run-status'), progress: byId('run-progress'), detail: byId('run-detail'), error: byId('run-error'),
    cancel: byId('cancel'), json: byId('download-json'), html: byId('download-html'), xlsx: byId('download-xlsx')
  };
  let opened;
  let runId;
  let pollTimer;
  els.title.textContent = config.title;

  const endpoint = path => config.apiBase + path;
  const message = value => typeof value === 'string' ? value : value && typeof value.message === 'string' ? value.message : value && value.error && typeof value.error.message === 'string' ? value.error.message : '';
  async function apiFetch(path, init) {
    const mutating = Boolean(init && init.method && init.method !== 'GET');
    return fetch(endpoint(path), { ...init, headers: { Accept:'application/json', Authorization:'Bearer ' + config.csrfToken, ...(init && init.body ? {'Content-Type':'application/json'} : {}), ...(mutating ? {'X-Validation-Workbench-CSRF':config.csrfToken} : {}), ...(init && init.headers || {}) } });
  }
  async function request(path, init) {
    const response = await apiFetch(path, init);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(message(body) || response.statusText || ('Request failed (' + response.status + ')'));
    return body;
  }
  function stopPolling() { if (pollTimer) window.clearTimeout(pollTimer); pollTimer = undefined; }
  function setDownload(button, path, enabled) { button.dataset.path = enabled ? path : ''; button.disabled = !enabled; }
  function selectedTargetIds() { return [...els.targets.querySelectorAll('input[data-target]:checked')].map(input => input.value); }
  function updateRunEnabled() { els.run.disabled = !opened || !els.confirm.checked || selectedTargetIds().length === 0 || Boolean(runId); els.openButton.disabled = Boolean(runId); }
  function resetRun() {
    stopPolling(); runId = undefined; els.runCard.hidden = true; els.status.textContent = 'Waiting'; els.progress.value = 0; els.detail.textContent = ''; els.error.textContent = '';
    els.cancel.disabled = true; setDownload(els.json, '', false); setDownload(els.html, '', false); setDownload(els.xlsx, '', false); updateRunEnabled();
  }
  function renderOpened(data) {
    opened = data;
    resetRun(); els.targets.replaceChildren(); els.confirm.checked = false;
    const targets = Array.isArray(data.targets) ? data.targets : [];
    els.summary.textContent = [data.name || data.selectedPath || els.path.value, data.kind].filter(Boolean).join(' · ');
    for (const target of targets) {
      const label = document.createElement('label'); label.className = 'target';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.target = ''; input.value = String(target.id); input.disabled = true; input.checked = target.allowed !== false;
      const name = document.createElement('span'); name.textContent = target.label || target.id;
      label.append(input, name);
      if (target.reason) { const reason = document.createElement('small'); reason.textContent = target.reason; label.append(reason); }
      els.targets.append(label);
    }
    if (!targets.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No runnable targets were found.'; els.targets.append(empty); }
    els.targetsCard.hidden = false; updateRunEnabled();
  }
  function percentOf(run) {
    const value = run.progress;
    if (typeof value === 'number') return value <= 1 ? value * 100 : value;
    if (value && typeof value.percent === 'number') return value.percent;
    if (value && typeof value.completed === 'number' && typeof value.total === 'number' && value.total) return value.completed / value.total * 100;
    return 0;
  }
  function isTerminal(status) { return ['PASS','FAIL','ERROR','CANCELED','SKIPPED','SAMPLED','UNKNOWN'].includes(String(status || '').toUpperCase()); }
  function paintRun(run) {
    const status = String(run.status || 'running').toUpperCase(); const terminal = isTerminal(status);
    els.status.textContent = status; els.progress.value = Math.max(0, Math.min(100, percentOf(run))); els.detail.textContent = message(run.progress) || run.message || '';
    els.error.textContent = run.error || ''; els.cancel.disabled = terminal;
    if (terminal) {
      stopPolling(); const id = encodeURIComponent(run.id || runId); const hasReview = run.hasReview === true; setDownload(els.json, '/runs/' + id + '/review.json', hasReview); setDownload(els.html, '/runs/' + id + '/review.html', hasReview); setDownload(els.xlsx, '/runs/' + id + '/review.xlsx', hasReview);
      runId = undefined; updateRunEnabled();
    }
  }
  async function poll() {
    if (!runId) return;
    try { const run = await request('/runs/' + encodeURIComponent(runId)); paintRun(run); if (runId) pollTimer = window.setTimeout(poll, 700); }
    catch (error) { els.error.textContent = error instanceof Error ? error.message : String(error); els.cancel.disabled = false; pollTimer = window.setTimeout(poll, 1500); }
  }
  els.openForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (runId) { els.openMessage.textContent = 'Cancel or wait for the active run before opening another definition.'; return; }
    els.openMessage.textContent = 'Opening…'; els.targetsCard.hidden = true; opened = undefined; resetRun();
    try { const data = await request('/open', { method:'POST', body:JSON.stringify({path:els.path.value.trim()}) }); els.openMessage.textContent = 'Opened.'; renderOpened(data); }
    catch (error) { els.openMessage.textContent = ''; els.targetsCard.hidden = true; els.error.textContent = error instanceof Error ? error.message : String(error); els.runCard.hidden = false; }
  });
  els.targets.addEventListener('change', () => { els.confirm.checked = false; updateRunEnabled(); });
  els.confirm.addEventListener('change', updateRunEnabled);
  els.run.addEventListener('click', async () => {
    const targetIds = selectedTargetIds(); if (!opened || !els.confirm.checked || !targetIds.length) return;
    els.run.disabled = true; els.runCard.hidden = false; els.status.textContent = 'STARTING'; els.detail.textContent = ''; els.error.textContent = ''; setDownload(els.json, '', false); setDownload(els.html, '', false); setDownload(els.xlsx, '', false);
    try { const run = await request('/runs', { method:'POST', body:JSON.stringify({targetIds}) }); runId = String(run.runId || run.id); if (!runId || runId === 'undefined') throw new Error('The server did not return a run ID.'); els.cancel.disabled = false; paintRun({...run, id:runId}); if (runId) poll(); }
    catch (error) { runId = undefined; els.status.textContent = 'ERROR'; els.error.textContent = error instanceof Error ? error.message : String(error); updateRunEnabled(); }
  });
  els.cancel.addEventListener('click', async () => {
    if (!runId) return; els.cancel.disabled = true; els.detail.textContent = 'Cancel requested; waiting for the active executor to stop.';
    try { const run = await request('/runs/' + encodeURIComponent(runId), {method:'DELETE', body:JSON.stringify({})}); if (run && typeof run === 'object') paintRun(run); }
    catch (error) { els.error.textContent = error instanceof Error ? error.message : String(error); els.cancel.disabled = false; }
  });
  async function download(button, fallbackName) {
    const path = button.dataset.path; if (!path) return; button.disabled = true; els.error.textContent = '';
    try {
      const response = await apiFetch(path); if (!response.ok) throw new Error(response.statusText || ('Download failed (' + response.status + ')'));
      const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename="?([^";]+)"?/i);
      const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = match ? match[1] : fallbackName; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(anchor.href);
    } catch (error) { els.error.textContent = error instanceof Error ? error.message : String(error); }
    finally { if (button.dataset.path === path) button.disabled = false; }
  }
  const excelFallbackLimit = 64 * 1024 * 1024;
  const excelLimitMessage = 'Excel export exceeds the 64 MiB browser fallback limit. Use the desktop save picker or CLI streamed export.';
  const canceled = error => error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
  function responseFilename(response, fallbackName) {
    const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename="?([^";]+)"?/i); return match ? match[1] : fallbackName;
  }
  async function saveExcelWithPicker(path, pickerPromise, current) {
    let writable;
    try {
      const handle = await pickerPromise; if (!current()) return false; writable = await handle.createWritable(); const response = await apiFetch(path, {headers:{Accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
      if (!response.ok) throw new Error(response.statusText || ('Download failed (' + response.status + ')'));
      if (!response.body) throw new Error('The browser did not provide a stream for the Excel export.');
      if (!current()) { await response.body.cancel(); await writable.abort(); writable = undefined; return false; }
      const destination = writable; writable = undefined; await response.body.pipeTo(destination);
      return true;
    } catch (error) { if (writable) { try { await writable.abort(error); } catch {} } throw error; }
  }
  async function saveExcelFallback(path, fallbackName, current) {
    const response = await apiFetch(path, {headers:{Accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
    if (!response.ok) throw new Error(response.statusText || ('Download failed (' + response.status + ')'));
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > excelFallbackLimit) { await response.body?.cancel(); throw new Error(excelLimitMessage); }
    if (!response.body) throw new Error('This browser cannot safely stream the Excel export. Use the desktop save picker or CLI streamed export.');
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; if (!current()) { await reader.cancel(); return false; } total += part.value.byteLength; if (total > excelFallbackLimit) { await reader.cancel(); throw new Error(excelLimitMessage); } chunks.push(part.value); }
      if (!current()) return false;
      const blob = new Blob(chunks, {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}); const anchor = document.createElement('a'); const objectUrl = URL.createObjectURL(blob);
      anchor.href = objectUrl; anchor.download = responseFilename(response, fallbackName); document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      return true;
    } catch (error) { try { await reader.cancel(error); } catch {} throw error; }
  }
  async function downloadExcel(button, pickerPromise) {
    const path = button.dataset.path; if (!path) return; button.disabled = true; els.error.textContent = ''; els.detail.textContent = 'Preparing aggregate Excel export…';
    try { const saved = pickerPromise ? await saveExcelWithPicker(path, pickerPromise, () => button.dataset.path === path) : await saveExcelFallback(path, 'validation-review-aggregate.xlsx', () => button.dataset.path === path); if (saved && button.dataset.path === path) els.detail.textContent = 'Aggregate Excel export saved.'; }
    catch (error) { if (canceled(error)) { els.detail.textContent = 'Excel download canceled.'; } else { els.detail.textContent = ''; els.error.textContent = error instanceof Error ? error.message : String(error); } }
    finally { if (button.dataset.path === path) button.disabled = false; }
  }
  els.json.addEventListener('click', () => download(els.json, 'validation-review.json'));
  els.html.addEventListener('click', () => download(els.html, 'validation-review.html'));
  els.xlsx.addEventListener('click', () => {
    let pickerPromise;
    if (typeof window.showSaveFilePicker === 'function') { try { pickerPromise = window.showSaveFilePicker({suggestedName:'validation-review-aggregate.xlsx', types:[{description:'Excel workbook', accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]}); } catch (error) { pickerPromise = Promise.reject(error); } }
    void downloadExcel(els.xlsx, pickerPromise);
  });
  window.addEventListener('beforeunload', stopPolling);
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
