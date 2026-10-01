import { renderResults } from "./results-view";
import type { LoadedSuite, SuiteRun } from "./core/suite";
import { resolveSqlServerTargets, sqlServerConnectionLabel } from "./core/sql-server-targets";
import type { ValidationProgress } from "./core/run-progress";

export type SuiteProgressStatus = "queued" | "running" | "PASS" | "FAIL" | "ERROR" | "CANCELED" | "SKIPPED" | "SAMPLED";
export interface SuiteTargetProgress {
  label: string;
  status: SuiteProgressStatus;
  progress?: ValidationProgress;
  rows?: number;
  error?: string;
}
export interface SuiteMemberProgress {
  id: string;
  source: string;
  status: SuiteProgressStatus;
  targets: SuiteTargetProgress[];
}
export interface SuiteRunProgress {
  running: boolean;
  status?: string;
  members: SuiteMemberProgress[];
}

export interface SuiteWorkbenchState {
  suite?: LoadedSuite;
  name?: string;
  description?: string;
  references?: (string | undefined)[];
  error?: string;
  notice?: string;
  running?: boolean;
  stale?: boolean;
  live?: boolean;
  watchInputs?: boolean;
  runs?: SuiteRun[];
  runView?: boolean;
  runProgress?: SuiteRunProgress;
}
const escape = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function targetPercent(target: SuiteTargetProgress): number | undefined {
  if (!["queued", "running"].includes(target.status)) return 100;
  const progress = target.progress;
  const fraction = progress?.phase === "reading" && progress.totalBytes && progress.bytesRead !== undefined
    ? progress.bytesRead / progress.totalBytes : progress?.phase === "validating" && progress.totalRows && progress.groupRowsProcessed !== undefined
      ? progress.groupRowsProcessed / progress.totalRows : undefined;
  return fraction === undefined ? undefined : Math.min(99, Math.max(0, Math.round(fraction * 100)));
}

function progressPhase(target: SuiteTargetProgress): string {
  if (!["queued", "running"].includes(target.status)) return target.status;
  if (target.status === "queued") return "Waiting";
  return target.progress?.phase === "connecting" ? "Connecting" : target.progress?.phase === "reading" ? "Reading target" :
    target.progress?.phase === "validating" ? "Validating" : target.progress?.phase === "summarizing" ? "Finishing" : "Preparing";
}

function progressDetail(target: SuiteTargetProgress): string {
  const progress = target.progress;
  const details: string[] = [];
  if (progress?.rowsRead !== undefined || target.rows !== undefined) details.push(`${(progress?.rowsRead ?? target.rows ?? 0).toLocaleString()} rows read${progress?.totalRows !== undefined ? ` of ${progress.totalRows.toLocaleString()}` : ""}`);
  if (progress?.phase === "reading" && progress.bytesRead !== undefined) details.push(`${(progress.bytesRead / 1048576).toFixed(1)} MB${progress.totalBytes ? ` of ${(progress.totalBytes / 1048576).toFixed(1)} MB` : ""}`);
  if (progress?.phase === "reading" && progress.readElapsedMs !== undefined && progress.firstRowMs === undefined) details.push(`Waiting for first row · ${(progress.readElapsedMs / 1000).toFixed(1)}s`);
  if (progress?.groupsValidated !== undefined) details.push(`${progress.groupsValidated.toLocaleString()} groups validated`);
  if (target.error) details.push(target.error);
  return details.join(" · ");
}

function memberCompletion(member: SuiteMemberProgress): { complete: number; total: number; percent: number } {
  const complete = member.targets.filter(target => !["queued", "running"].includes(target.status)).length;
  const total = member.targets.length;
  const percent = total ? Math.round(complete / total * 100) : !["queued", "running"].includes(member.status) ? 100 : 0;
  return { complete, total, percent };
}

function renderSuiteRunView(state: SuiteWorkbenchState, nonce: string): string {
  const run = state.runProgress!;
  const completeMembers = run.members.filter(member => memberCompletion(member).percent === 100).length;
  const overall = run.members.length ? Math.round(completeMembers / run.members.length * 100) : 0;
  const memberCards = run.members.map((member, memberIndex) => {
    const completion = memberCompletion(member);
    return `<article class="suite-run-member" data-run-member="${escape(member.id)}">
      <div class="suite-run-member__heading"><div><span class="run-kicker">TEST FILE ${memberIndex + 1}</span><h2>${escape(member.id)}</h2><small>${escape(member.source)}</small></div><span class="run-status" data-member-status>${escape(member.status === "queued" ? "Waiting" : member.status)}</span></div>
      <div class="suite-run-member__rollup"><progress max="100" value="${completion.percent}" aria-label="${escape(member.id)} progress" data-member-bar></progress><span data-member-count>${completion.complete} / ${completion.total} targets</span></div>
      <div class="suite-run-targets">${member.targets.length ? member.targets.map((target, index) => {
        const percent = targetPercent(target);
        return `<div class="suite-run-target suite-run-target--${target.status.toLowerCase()}" data-run-target="${escape(member.id)}:${index}">
          <div class="suite-run-target__line"><strong title="${escape(target.label)}">${escape(target.label)}</strong><span data-target-phase>${escape(progressPhase(target))}</span></div>
          <progress max="100" ${percent === undefined ? "" : `value="${percent}"`} class="${percent === undefined && target.status === "running" ? "indeterminate" : ""}" data-target-bar></progress>
          <small data-target-detail>${escape(progressDetail(target))}</small></div>`;
      }).join("") : '<p class="empty-targets">No executable targets were resolved.</p>'}</div>
    </article>`;
  }).join("");
  const serialized = JSON.stringify(run).replaceAll("<", "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Suite run</title>
  <style nonce="${nonce}">
    :root{font-family:"IBM Plex Sans",var(--vscode-font-family,system-ui,sans-serif);color:var(--vscode-editor-foreground,#121316);background:var(--vscode-editor-background,#f6f6f6)}*{box-sizing:border-box}body{margin:0}.suite-run{max-width:1120px;margin:auto;padding:24px}.suite-run__header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:16px}.run-kicker{color:var(--vscode-textLink-foreground,#4459c6);font-size:10px;font-weight:700;letter-spacing:.08em}.suite-run h1{margin:5px 0 3px;font-size:24px}.suite-run h2{margin:3px 0;font-size:14px}.suite-run p,.suite-run small{color:var(--vscode-descriptionForeground,#656668)}button{font:inherit;padding:7px 12px;border:1px solid var(--vscode-button-border,#cfd4df);border-radius:4px;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#4459c6);cursor:pointer}.suite-rollup,.suite-run-member{border:1px solid var(--vscode-panel-border,#dbdcdc);border-radius:6px;background:var(--vscode-editor-background,#fff)}.suite-rollup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px 14px;padding:12px 14px;margin-bottom:12px}.suite-rollup strong{font-size:13px}.suite-rollup span{font-size:11px;color:var(--vscode-descriptionForeground,#656668)}progress{width:100%;height:7px;grid-column:1/-1;appearance:none;border:0;border-radius:99px;overflow:hidden;background:#e6e8ef}progress::-webkit-progress-bar{background:#e6e8ef}progress::-webkit-progress-value{background:#445bd4}progress::-moz-progress-bar{background:#445bd4}.suite-run__members{display:grid;gap:9px}.suite-run-member{padding:11px 13px}.suite-run-member__heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.suite-run-member__heading>div{min-width:0}.suite-run-member__heading small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.run-status{padding:3px 6px;border-radius:3px;color:#344bbd;background:#e9edff;font-size:10px;font-weight:700}.suite-run-member__rollup{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:9px;margin:9px 0}.suite-run-member__rollup progress{grid-column:auto}.suite-run-member__rollup span{font-size:10px;color:var(--vscode-descriptionForeground,#656668)}.suite-run-targets{display:grid;gap:4px}.suite-run-target{display:grid;grid-template-columns:minmax(0,1fr) minmax(8rem,.7fr) 135px;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;background:var(--vscode-sideBar-background,#f7f7f7)}.suite-run-target__line{display:flex;justify-content:space-between;gap:10px;min-width:0}.suite-run-target__line strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.suite-run-target__line span{font-size:10px;color:var(--vscode-descriptionForeground,#656668);white-space:nowrap}.suite-run-target progress{grid-column:3;grid-row:1;height:5px;align-self:center}.suite-run-target small{grid-column:2;grid-row:1;min-width:0;min-height:0;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.suite-run-target--pass progress::-webkit-progress-value{background:#328452}.suite-run-target--fail progress::-webkit-progress-value,.suite-run-target--error progress::-webkit-progress-value{background:#c44250}.indeterminate{background:linear-gradient(90deg,#e6e8ef,#445bd4,#e6e8ef);background-size:200% 100%;animation:sweep 1.4s infinite}@keyframes sweep{to{background-position:-200% 0}}.empty-targets{margin:4px 0;font-size:11px}@media(max-width:650px){.suite-run{padding:14px}.suite-run__header{align-items:flex-start;flex-direction:column}.suite-run-target{grid-template-columns:minmax(0,1fr)}.suite-run-target progress{grid-column:1;grid-row:auto}.suite-run-target small{grid-column:1;grid-row:auto;white-space:normal}}
  </style></head><body><main class="suite-run"><header class="suite-run__header"><div><span class="run-kicker">SUITE RUN</span><h1 data-run-title>${run.running ? "Running suite" : "Suite run complete"}</h1><p data-run-summary>${completeMembers} of ${run.members.length} test files complete${run.running ? " · targets execute concurrently" : ""}</p></div><div>${run.running ? '<button data-action="cancel">Cancel run</button>' : ""}<button data-action="show-results">${run.running ? "Back to suite" : "View results"}</button></div></header>
  <section class="suite-rollup"><strong>${escape(state.name ?? state.suite?.id ?? "Contract suite")}</strong><span data-suite-status>${escape(run.status ?? (run.running ? "RUNNING" : "COMPLETE"))}</span><progress max="100" value="${overall}" aria-label="Overall suite progress" data-suite-bar></progress></section><section class="suite-run__members">${memberCards}</section></main>
  <script nonce="${nonce}">const api=acquireVsCodeApi();let run=${serialized};
  const done=s=>!['queued','running'].includes(s);const pct=t=>{if(done(t.status))return 100;const p=t.progress||{};if(p.phase==='reading'&&p.totalBytes&&p.bytesRead!==undefined)return Math.min(99,Math.round(p.bytesRead/p.totalBytes*100));if(p.phase==='validating'&&p.totalRows&&p.groupRowsProcessed!==undefined)return Math.min(99,Math.round(p.groupRowsProcessed/p.totalRows*100));};
  const phase=t=>done(t.status)?t.status:t.status==='queued'?'Waiting':t.progress?.phase==='connecting'?'Connecting':t.progress?.phase==='reading'?'Reading target':t.progress?.phase==='validating'?'Validating':t.progress?.phase==='summarizing'?'Finishing':'Preparing';
  const detail=t=>{const p=t.progress||{},v=[];if(p.rowsRead!==undefined||t.rows!==undefined)v.push((p.rowsRead??t.rows??0).toLocaleString()+' rows read'+(p.totalRows!==undefined?' of '+p.totalRows.toLocaleString():''));if(p.phase==='reading'&&p.bytesRead!==undefined)v.push((p.bytesRead/1048576).toFixed(1)+' MB'+(p.totalBytes?' of '+(p.totalBytes/1048576).toFixed(1)+' MB':''));if(p.phase==='reading'&&p.readElapsedMs!==undefined&&p.firstRowMs===undefined)v.push('Waiting for first row · '+(p.readElapsedMs/1000).toFixed(1)+'s');if(p.groupsValidated!==undefined)v.push(p.groupsValidated.toLocaleString()+' groups validated');if(t.error)v.push(t.error);return v.join(' · ')};
  function paint(){let completeMembers=0;run.members.forEach(m=>{const card=document.querySelector('[data-run-member="'+CSS.escape(m.id)+'"]');if(!card)return;let complete=0;m.targets.forEach((t,i)=>{if(done(t.status))complete++;const row=card.querySelector('[data-run-target="'+CSS.escape(m.id+':'+i)+'"]');if(!row)return;row.className='suite-run-target suite-run-target--'+t.status.toLowerCase();row.querySelector('[data-target-phase]').textContent=phase(t);row.querySelector('[data-target-detail]').textContent=detail(t);const bar=row.querySelector('[data-target-bar]'),value=pct(t);bar.classList.toggle('indeterminate',value===undefined&&t.status==='running');if(value===undefined)bar.removeAttribute('value');else bar.value=value;});const percent=m.targets.length?Math.round(complete/m.targets.length*100):done(m.status)?100:0;if(percent===100)completeMembers++;card.querySelector('[data-member-bar]').value=percent;card.querySelector('[data-member-count]').textContent=complete+' / '+m.targets.length+' targets';card.querySelector('[data-member-status]').textContent=m.status==='queued'?'Waiting':m.status;});document.querySelector('[data-suite-bar]').value=run.members.length?Math.round(completeMembers/run.members.length*100):0;document.querySelector('[data-run-title]').textContent=run.running?'Running suite':'Suite run complete';document.querySelector('[data-run-summary]').textContent=completeMembers+' of '+run.members.length+' test files complete'+(run.running?' · targets execute concurrently':'');document.querySelector('[data-suite-status]').textContent=run.status||(run.running?'RUNNING':'COMPLETE');}
  window.addEventListener('message',event=>{if(event.data.type==='suiteRunProgress'){run=event.data.run;paint();}});document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button)api.postMessage({type:button.dataset.action});});</script></body></html>`;
}

/** The same renderer is exercised by the browser smoke test and the VS Code editor. */
export function renderSuiteWorkbench(state: SuiteWorkbenchState, nonce: string): string {
  if (state.runView && state.runProgress) return renderSuiteRunView(state, nonce);
  const suite = state.suite;
  const members = suite?.members ?? [];
  const status = (runs: SuiteRun[]): string => runs.some((r) => r.status === "ERROR") ? "ERROR" : runs.some((r) => r.status === "FAIL") ? "FAIL" : runs.some((r) => r.status === "CANCELED") ? "CANCELED" : runs.some((r) => r.status === "SKIPPED") ? "SKIPPED" : runs.length ? "PASS" : "NOT RUN";
  const badge = (value: string): string => `<span class="badge ${value.toLowerCase().replaceAll(" ", "-")}">${escape(value)}</span>`;
  const resultStatus = state.runs ? status(state.runs) : "NOT RUN";
  const cards = members.map((member, index) => {
    const contract = member.contract;
    const runs = state.runs?.filter((r) => r.member === member.id) ?? [];
    let error = member.error;
    let targets: string[] = [];
    try {
      targets = contract ? resolveSqlServerTargets(contract, false).map((t, index) => `${t.schema}.${t.table} · ${sqlServerConnectionLabel(t)} · ${member.connectionOrigins?.[index] ?? "contract"}`) : [];
      targets.push(...(contract?.targets ?? []).map((t) => t.path ?? t.url!));
    } catch (e) { error = String(e); }
    const columns = Object.entries(contract?.schema.columns ?? {});
    const rules = [...(contract?.rowTests ?? []), ...(contract?.rules ?? []), ...(contract?.groupRules ?? []), ...(contract?.sqlServer?.conditionalRules ?? [])];
    return `<article class="member" data-member="${escape(member.id)}">
      <details><summary><span class="ordinal">${index + 1}</span><span class="member-title"><strong>${escape(member.id)}</strong><small>${escape(targets.join(" • ") || "No configured target")}</small></span>${badge(error ? "ERROR" : status(runs))}</summary>
      <div class="member-body"><div class="member-toolbar"><button data-action="connection" data-index="${index}" ${state.running ? "disabled" : ""}>Edit connection</button><span class="muted">${escape(state.references?.[index] ?? "Embedded contract")}</span><button data-action="member" data-index="${index}">${state.references?.[index] ? "Open contract" : "Edit inline contract"}</button></div>
      ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
      ${contract ? `<h3>Schema <span class="muted">${columns.length} columns</span></h3><div class="table-scroll"><table><thead><tr><th>Column</th><th>Presence</th><th>Constraints</th></tr></thead><tbody>${columns.map(([name, column]) => `<tr><td><strong>${escape(name)}</strong>${column.description ? `<small>${escape(column.description)}</small>` : ""}</td><td>${escape(column.presence)}</td><td><code>${escape(column.constraints ? JSON.stringify(column.constraints) : "—")}</code></td></tr>`).join("")}</tbody></table></div>
      <h3>Rules <span class="muted">${rules.length} explicit rules</span></h3>${rules.length ? rules.map((rule) => `<details class="rule"><summary>${escape(rule.id)}${rule.name ? ` — ${escape(rule.name)}` : ""}</summary><pre>${escape(JSON.stringify(rule, null, 2))}</pre></details>`).join("") : '<p class="muted">Column and schema constraints apply; no additional row or group rules.</p>'}` : ""}
      </div></details>
      <div class="results">${renderResults(runs, "", state.stale)}</div>
      </article>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>CSV Contract Suite Workbench</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background,#f6f6f6);color:var(--vscode-editor-foreground,#121316);font:14px var(--vscode-font-family,system-ui,sans-serif)}main{max-width:1120px;margin:auto;padding:0 24px 64px}.suite-header{margin:0 -24px;padding:18px 24px;background:#2a3142;color:#fff}.suite-header .muted{color:#dfe5ff}.suite-header h1{font-size:24px;letter-spacing:-.4px;margin:5px 0}.suite-header p{margin:3px 0}.eyebrow{font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#b9c5f5}.muted,small{color:var(--vscode-descriptionForeground,#697184)}small{display:block;font-size:11px;margin-top:3px;overflow-wrap:anywhere}p{line-height:1.5}h2{font-size:17px}h3{font-size:13px;margin:20px 0 10px}h3 .muted{font-weight:400;margin-left:8px}button{font:inherit;border:1px solid var(--vscode-button-border,#cfd4df);border-radius:4px;padding:7px 11px;cursor:pointer;background:var(--vscode-button-secondaryBackground,#e8ebf2);color:var(--vscode-button-secondaryForeground,#252b3b)}button.primary{background:var(--vscode-button-background,#4459c6);color:var(--vscode-button-foreground,#fff);border-color:transparent}button:hover{filter:brightness(.94)}button:disabled{opacity:.55;cursor:default}button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder,#4459c6);outline-offset:2px}.toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:16px 0}.suite-tools{position:relative}.suite-tools>summary{padding:7px 11px;border:1px solid var(--vscode-button-border,#cfd4df);border-radius:4px;cursor:pointer;list-style:none;background:var(--vscode-button-secondaryBackground,#e8ebf2)}.suite-tools__menu{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;padding:9px;border:1px solid var(--vscode-panel-border,#dce0e9);border-radius:5px;background:var(--vscode-editor-background,#fff)}.overview{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:11px 14px;border:1px solid var(--vscode-panel-border,#dce0e9);border-radius:5px;background:var(--vscode-editor-background,#fff)}.metric strong{font-size:17px;display:block}.metric span{font-size:10px;color:var(--vscode-descriptionForeground,#697184)}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px}input[type=checkbox]{width:auto}input{font:inherit;padding:7px 9px;border-radius:4px;border:1px solid var(--vscode-input-border,#cfd4df);background:var(--vscode-input-background,#fff);color:var(--vscode-input-foreground,#252b3b);width:240px;max-width:100%}.member{border:1px solid var(--vscode-panel-border,#dce0e9);border-radius:5px;margin:8px 0;overflow:hidden;background:var(--vscode-editor-background,#fff)}.member>details>summary{display:flex;align-items:center;gap:10px;padding:11px 13px;cursor:pointer;list-style:none}.member>details>summary:before{content:'›';font-size:18px}.member>details[open]>summary:before{transform:rotate(90deg)}.member-title{flex:1;min-width:0}.member-title strong{overflow-wrap:anywhere}.ordinal{color:var(--vscode-descriptionForeground,#697184);font-size:10px}.badge{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.5px;padding:3px 6px;border-radius:3px;background:var(--vscode-badge-background,#e8ebf2);color:var(--vscode-badge-foreground,#596175);white-space:nowrap}.badge.pass{color:var(--vscode-testing-iconPassed,#23734c);background:transparent}.badge.error,.badge.fail,.error{color:var(--vscode-errorForeground,#bd3535)}.badge.error,.badge.fail{background:transparent}.member-body{padding:0 14px 14px}.member-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;overflow-wrap:anywhere}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:11px}td,th{padding:8px;border-bottom:1px solid var(--vscode-panel-border,#e1e4ec);vertical-align:top}td code{white-space:normal;overflow-wrap:anywhere}th{color:var(--vscode-descriptionForeground,#697184)}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:11px}.rule{padding:8px 0;border-bottom:1px solid var(--vscode-panel-border,#e1e4ec)}.rule summary{cursor:pointer;overflow-wrap:anywhere}.results{padding:0 14px 12px}.run{padding-top:9px}.run li{margin:6px 0;overflow-wrap:anywhere}.notice{padding:10px 13px;border-left:3px solid var(--vscode-focusBorder,#4459c6)}[hidden]{display:none!important}@media(max-width:600px){main{padding:0 12px 48px}.suite-header{margin:0 -12px;padding:16px 12px}.section-heading{align-items:stretch;flex-direction:column;gap:0}input{width:100%;margin-bottom:8px}.member>details>summary{padding:10px 8px;gap:7px}.member-toolbar{align-items:flex-start;flex-direction:column}.overview{gap:14px}.member-body{padding:0 10px 12px}}
  </style></head><body><main><header class="suite-header"><div class="eyebrow">CSV Contract Workbench / Suite</div><h1>${escape(state.name ?? suite?.id ?? "Contract suite")}</h1><p class="muted">${escape(state.description ?? "Independent contracts, one suite run. Expand a test file to review its schema and rules.")}</p></header>
  <div class="toolbar"><button class="primary" data-action="run" ${!suite || state.running ? "disabled" : ""}>${state.running ? "Running suite…" : "Run suite"}</button><button data-action="preflight">Test connections</button><button data-action="yaml">Edit suite YAML</button><details class="suite-tools"><summary>More tools</summary><div class="suite-tools__menu"><button data-action="selected">Run selected files</button><button data-action="failed">Rerun failed files</button><button data-action="bulk-connection">Bulk edit connections</button><button data-action="watch-inputs">${state.watchInputs ? "Stop watching CSV input" : "Watch CSV inputs"}</button><button data-action="history">Run history</button><button data-action="live">${state.live ? "Pause live tests" : "Enable live tests"}</button><button data-action="cancel">Cancel</button><button data-action="sql" ${!suite || state.running ? "disabled" : ""}>Generate SQL</button><button data-action="connection" ${!suite || state.running ? "disabled" : ""}>Edit default connection</button><button data-action="credentials" ${state.running ? "disabled" : ""}>Configure credentials</button><button data-action="export" ${!state.runs || state.running ? "disabled" : ""}>Export results</button></div></details></div>
  ${state.error ? `<p class="error notice" role="alert">${escape(state.error)}</p>` : ""}${state.notice ? `<p class="notice" role="status">${escape(state.notice)}</p>` : ""}
  <section class="overview" aria-label="Suite summary"><div class="metric"><strong>${members.length}</strong><span>Contracts</span></div><div class="metric"><strong>${state.references?.filter(Boolean).length ?? 0}</strong><span>Referenced</span></div><div class="metric"><strong>${members.length - (state.references?.filter(Boolean).length ?? 0)}</strong><span>Inline</span></div><div class="metric"><strong>${state.runs?.length ?? 0}</strong><span>Completed runs</span></div>${badge(state.running ? "RUNNING" : state.stale ? "STALE" : resultStatus)}</section>${state.runs?.some(r => r.status === "ERROR") ? `<p class="error notice" role="alert">${state.runs.filter(r => r.status === "ERROR").length} execution error(s). Details are shown beneath each member; export to save the full report.</p>` : ""}
  <div class="section-heading"><h2>Suite members</h2><input id="filter" type="search" aria-label="Filter members" placeholder="Filter members or tables"></div><label>Search failures <input id="result-filter" type="search" placeholder="Rule, severity, status or diagnostic"></label><p>Select issue checkboxes to export only those details. With none selected, export includes the visible filtered scope.</p><section aria-label="Suite members">${cards}</section>${state.runs?.some(r => r.member.startsWith("cross:")) ? `<section><h2>Cross-table checks</h2>${renderResults(state.runs.filter(r => r.member.startsWith("cross:")), "", state.stale)}</section>` : ""}<p id="no-match" class="muted" hidden>No members match your filter.</p></main>
  <script nonce="${nonce}">
    const api=acquireVsCodeApi(); const saved=api.getState()||{}; const filter=document.getElementById('filter');
    const cards=Array.from(document.querySelectorAll('[data-member]')); const resultFilter=document.getElementById('result-filter'); resultFilter.addEventListener('input',()=>{document.querySelectorAll('[data-result-search]').forEach(row=>{row.hidden=!row.dataset.resultSearch.toLowerCase().includes(resultFilter.value.toLowerCase()); if(row.hidden)row.querySelectorAll('[data-issue-selection]').forEach(input=>input.checked=false);});});
    function save(){api.setState({filter:filter.value,open:cards.filter(c=>c.querySelector('details').open).map(c=>c.dataset.member)});}
    function applyFilter(){const query=filter.value.toLowerCase();cards.forEach(c=>c.hidden=!c.textContent.toLowerCase().includes(query));document.getElementById('no-match').hidden=!cards.length||cards.some(c=>!c.hidden);}
    cards.forEach(c=>{const details=c.querySelector('details');details.open=(saved.open||[]).includes(c.dataset.member);details.addEventListener('toggle',save);});
    filter.value=saved.filter||'';applyFilter();filter.addEventListener('input',()=>{applyFilter();save();});
    document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;api.postMessage({type:button.dataset.action,resultFilter:button.dataset.action==="export"&&resultFilter.value?resultFilter.value:undefined,selectedIssues:button.dataset.action==="export"?(()=>{const selected=Array.from(document.querySelectorAll("[data-issue-selection]:checked")).filter(input=>!input.closest("[data-member]")?.hidden).map(input=>input.dataset.issueSelection);return selected.length?selected:undefined;})():undefined,index:button.dataset.index===undefined?undefined:Number(button.dataset.index),ruleId:button.dataset.rule,memberId:button.dataset.rule?button.closest("[data-member]")?.dataset.member:undefined,memberIds:button.dataset.action==="export"&&filter.value?cards.filter(c=>!c.hidden).map(c=>c.dataset.member):undefined});});
  </script></body></html>`;
}
