/**
 * Backend performance measurement against a data root (default: fixtures/data).
 *   npx tsx scripts/perf.ts [dataRoot] [--out file.json]
 * Measures index build, API latencies (cold/warm), payload sizes, change propagation and memory.
 * Runs on a temporary copy so the source data is never modified.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { NavNode, NavigationResponse, ProjectsResponse, RecordPage } from "../src/shared/api.js";

const args = process.argv.slice(2);
const src = path.resolve(args.find((a) => !a.startsWith("--")) ?? "fixtures/data");
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-perf-"));
fs.cpSync(src, tmp, { recursive: true });

const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100;
const results: Record<string, unknown> = { dataRoot: path.basename(src), node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, at: new Date().toISOString() };

const t0 = performance.now();
const cfg = loadConfig({ dataRoot: tmp, watch: true, reconcileSeconds: 0, logLevel: "silent", auth: { mode: "disabled" } } as never);
const { app, store } = await buildApp(cfg, { logger: false });
results.startupIndexMs = ms(t0);
results.projects = [...store.projects.values()].map((p) => ({ id: p.manifest.id, records: p.records.size, sections: p.sections.size, indexMs: p.indexMs }));
results.diagnostics = store.diagnostics().length;
store.startWatching();

async function timed(url: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const t = performance.now();
  const r = await app.inject({ method, url, payload: body ? JSON.stringify(body) : undefined, headers: body ? { "content-type": "application/json", "x-pcc-request": "1" } : undefined });
  return { ms: ms(t), bytes: r.rawPayload.length, status: r.statusCode, json: () => r.json() };
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

const cards = await timed("/api/projects");
results.projectsList = { coldMs: cards.ms, bytes: cards.bytes };
const warm: number[] = [];
for (let i = 0; i < 50; i++) warm.push((await timed("/api/projects")).ms);
results.projectsListWarm = stats(warm);

const per: Record<string, unknown>[] = [];
for (const card of (cards.json() as ProjectsResponse).projects.filter((c) => c.available)) {
  const nav = await timed(`/api/projects/${card.id}/navigation`);
  const flat: NavNode[] = [];
  const walk = (n: NavNode[]) => n.forEach((x) => { flat.push(x); walk(x.children); });
  walk((nav.json() as NavigationResponse).nodes);
  const cardsOnly = flat.filter((n) => n.displayType === "expandable-card");
  const biggest = cardsOnly.sort((a, b) => b.counts.records - a.counts.records)[0];
  const row: Record<string, unknown> = { project: card.id, navigationMs: nav.ms, navigationBytes: nav.bytes, sections: flat.length };
  if (biggest) {
    const first = await timed(`/api/projects/${card.id}/sections/${biggest.id}/records?limit=25`);
    const all = await timed(`/api/projects/${card.id}/sections/${biggest.id}/records?limit=200`);
    const filt = await timed(`/api/projects/${card.id}/sections/${biggest.id}/records?limit=200&status=open&q=e`);
    const page = first.json() as RecordPage;
    row.biggestSection = { id: biggest.id, records: biggest.counts.records, page25Ms: first.ms, page25Bytes: first.bytes, page200Ms: all.ms, page200Bytes: all.bytes, filteredMs: filt.ms };
    const detailTimes: number[] = [];
    let detailBytes = 0;
    for (const it of page.items.slice(0, 20)) {
      const d = await timed(`/api/projects/${card.id}/records/${encodeURIComponent(it.id)}`);
      detailTimes.push(d.ms);
      detailBytes = Math.max(detailBytes, d.bytes);
    }
    row.recordDetail = { ...stats(detailTimes), maxBytes: detailBytes };
  }
  const act = await timed(`/api/projects/${card.id}/activity?limit=20`);
  row.activityMs = act.ms;
  per.push(row);
}
results.perProject = per;

// Change propagation: write a record file, wait for the watcher-driven invalidate event.
const target = [...store.projects.values()].flatMap((p) => [...p.records.values()].map((r) => ({ p, r })))[0];
if (target) {
  const rec = JSON.parse(fs.readFileSync(target.r.file, "utf8"));
  rec.title = `${rec.title} (perf edit)`;
  rec.updatedAt = new Date().toISOString();
  const t = performance.now();
  const seen = new Promise<number>((resolve) => {
    const on = (e: { recordIds?: string[] }) => { if (e.recordIds?.includes(target.r.id)) { store.off("invalidate", on); resolve(ms(t)); } };
    store.on("invalidate", on);
    setTimeout(() => resolve(-1), 10_000);
  });
  fs.writeFileSync(target.r.file, JSON.stringify(rec, null, 2));
  results.changePropagationMs = await seen;
  results.changePropagationNote = "file write → watcher debounce (200 ms) → reindex → invalidate event; -1 = not observed within 10 s";
}

const mem = process.memoryUsage();
results.memoryMB = { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) };
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });

const text = JSON.stringify(results, null, 2);
if (out) fs.writeFileSync(out, text + "\n");
console.log(text);
