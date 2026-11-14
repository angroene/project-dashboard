/**
 * End-to-end acceptance walks against the real UI (dist/web) and the real backend,
 * run in-process on a throw-away copy of fixtures/data. Prerequisite: `npx vite build`.
 *
 *   npx tsx scripts/e2e.ts            (set E2E_KEEP=1 to keep the temp data root afterwards)
 *
 * Writes docs/screenshots/*.png and docs/screenshots/e2e-results.json. Exit code 1 on any failed walk.
 * Uses an installed browser through playwright-core (no browser download): Microsoft Edge by default,
 * E2E_BROWSER_CHANNEL=chrome for Google Chrome, or E2E_BROWSER_PATH=/path/to/chromium.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright-core";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { DiagnosticsResponse, ProjectsResponse, RecordDetail, RecordPage } from "../src/shared/api.js";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "data");
const WEB_ROOT = path.join(REPO, "dist", "web");
const SHOTS = path.join(REPO, "docs", "screenshots");
const MW = "harborlight";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

// ------------------------------------------------------------------ setup --
if (!fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
  console.error("dist/web/index.html missing: run `npx vite build` first.");
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-e2e-"));
const DATA = path.join(TMP, "data");
fs.cpSync(FIXTURES, DATA, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const DL = path.join(TMP, "downloads");
fs.mkdirSync(DL);

const projDir = (pid: string) => path.join(DATA, "projects", pid);
const pendingDir = (pid: string) => path.join(projDir(pid), "communications", "answers", "pending");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const tStart = performance.now();
const cfg = loadConfig({ dataRoot: DATA, webRoot: WEB_ROOT, port, host: "127.0.0.1", watch: true, logLevel: "silent", reconcileSeconds: 3 });
const { app, store } = await buildApp(cfg, { logger: false });
const serverIndexMs = Math.round(performance.now() - tStart);
store.startWatching();
await app.listen({ host: "127.0.0.1", port });

async function api<T>(p: string): Promise<T> {
  const res = await fetch(BASE + p);
  if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// --------------------------------------------------------------- helpers --
class Fail extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000, stepMs = 200): Promise<T> {
  const t0 = Date.now();
  let lastErr: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Fail(`timed out after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ""}`);
}

const metrics: Record<string, number | string | Record<string, number>> = { serverStartupIndexMs: serverIndexMs };
const consoleProblems: string[] = [];

/** Records all /api requests of a page so walks can assert what was (not) fetched. */
interface Tracked {
  page: Page;
  ctx: BrowserContext;
  requests: { url: string; at: number; req: Request }[];
}
async function open(viewport: { width: number; height: number }, tag: string): Promise<Tracked> {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  // Time at which the first project card appears (cold landing measurement).
  await ctx.addInitScript(() => {
    const w = window as unknown as { __firstCard?: number };
    const obs = new MutationObserver(() => {
      if (w.__firstCard === undefined && document.querySelector(".project")) {
        w.__firstCard = performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  const t: Tracked = { page, ctx, requests: [] };
  page.on("request", (req) => {
    if (req.url().includes("/api/")) t.requests.push({ url: req.url(), at: Date.now(), req });
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleProblems.push(`[${tag}] console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleProblems.push(`[${tag}] pageerror: ${e.message}`));
  return t;
}
const apiPath = (u: string) => new URL(u).pathname;

/** Clicks `clickSel` inside the page and resolves when an element matching `waitSel` (optionally containing `text`) exists. Returns ms. */
// Plain JS source: tsx's keep-names transform would inject a `__name` helper into functions passed to the browser.
const TIME_CLICK_JS = `([c, w, txt]) => new Promise((resolve, reject) => {
  const el = document.querySelector(c);
  if (!el) return reject(new Error("no element " + c));
  const t0 = performance.now();
  el.click();
  const deadline = t0 + 15000;
  const check = function () {
    const hit = Array.from(document.querySelectorAll(w)).some(function (n) { return !txt || (n.textContent || "").includes(txt); });
    if (hit) resolve(Math.round(performance.now() - t0));
    else if (performance.now() > deadline) reject(new Error("timeout waiting for " + w + " " + txt));
    else requestAnimationFrame(check);
  };
  check();
})`;

async function timeClick(page: Page, clickSel: string, waitSel: string, text?: string): Promise<number> {
  return page.evaluate(`(${TIME_CLICK_JS})(${JSON.stringify([clickSel, waitSel, text ?? ""])})`) as Promise<number>;
}

async function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
function listJson(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}
interface Envelope {
  answerId: string;
  questionId: string;
  source: string;
  processingState: string;
  answers: { fieldId: string; kind: string; optionIds?: string[]; otherText?: string; explanation?: string; text?: string; decision?: string; attachmentIds?: string[]; comment?: string }[];
  attachments: string[];
}
function pendingFor(pid: string, questionId: string, exclude: Set<string> = new Set()): Envelope | undefined {
  for (const f of listJson(pendingDir(pid))) {
    if (exclude.has(f)) continue;
    const env = readJson<Envelope>(path.join(pendingDir(pid), f));
    if (env.questionId === questionId) return env;
  }
  return undefined;
}

function findFile(root: string, name: string): string | undefined {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return undefined;
}

/** Open questions currently needing a response in a section (first page as the UI loads it). */
async function openQuestions(pid: string, sectionId: string, limit = 50): Promise<RecordDetail[]> {
  const page = await api<RecordPage>(`/api/projects/${pid}/sections/${sectionId}/records?status=open&sort=updated-desc&limit=${limit}`);
  const out: RecordDetail[] = [];
  for (const r of page.items) {
    if (r.question?.uiState !== "needs-response") continue;
    out.push(await api<RecordDetail>(`/api/projects/${pid}/records/${encodeURIComponent(r.id)}`));
  }
  return out;
}

function unzipEntries(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error("zip read failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** A valid 2x2 PNG. */
const PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000020000000208060000007284BC5D0000001549444154789C63F8CFC0F09F8181E13F030303000E7A02FDD6B1A9C50000000049454E44AE426082",
  "hex",
);

// ------------------------------------------------------------------ walks --
interface WalkResult {
  n: number;
  name: string;
  pass: boolean;
  ms: number;
  details: string[];
  error?: string;
}
const results: WalkResult[] = [];
async function walk(n: number, name: string, fn: (log: (s: string) => void) => Promise<void>) {
  const details: string[] = [];
  const t0 = Date.now();
  try {
    await fn((s) => details.push(s));
    results.push({ n, name, pass: true, ms: Date.now() - t0, details });
    console.log(`PASS  #${n} ${name}${details.length ? ` — ${details.join("; ")}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ n, name, pass: false, ms: Date.now() - t0, details, error: msg });
    console.log(`FAIL  #${n} ${name} — ${msg}${details.length ? ` [${details.join("; ")}]` : ""}`);
  }
}

// Browser: installed Edge by default; CI sets E2E_BROWSER_CHANNEL=chrome. E2E_BROWSER_PATH points at any Chromium binary.
const channel = process.env.E2E_BROWSER_PATH ? undefined : (process.env.E2E_BROWSER_CHANNEL || "msedge");
const browser: Browser = await chromium.launch({ headless: true, channel, executablePath: process.env.E2E_BROWSER_PATH || undefined });
metrics.browser = `${channel ?? process.env.E2E_BROWSER_PATH} ${browser.version()}`;
const desk = await open(DESKTOP, "desktop");
const page = desk.page;

// #1 — landing cards match the published fixtures.
await walk(1, "All Projects: cards, progress and attention match fixtures", async (log) => {
  await page.goto(BASE + "/");
  await page.waitForSelector(".project");
  metrics.coldLandingFirstCardMs = Math.round(await page.evaluate(() => (window as unknown as { __firstCard: number }).__firstCard));
  const nav = await page.evaluate(() => {
    const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { domContentLoaded: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd) };
  });
  metrics.coldLandingNavigation = nav;
  const bytes = await page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0),
  );
  metrics.coldLandingTransferBytes = bytes;

  const data = await api<ProjectsResponse>("/api/projects");
  for (const p of data.projects) {
    if (!p.available) {
      const card = page.locator(".project-disabled", { hasText: p.displayName });
      expect((await card.count()) === 1, `disabled card for ${p.id} missing`);
      expect((await card.textContent())?.includes(p.unavailableReason ?? "§"), `unavailable reason for ${p.id} not shown`);
      continue;
    }
    const card = page.locator(`a.project[href="#/p/${p.id}"]`);
    expect((await card.count()) === 1, `card for ${p.id} missing`);
    const text = (await card.textContent()) ?? "";
    expect(text.includes(p.displayName), `${p.id}: name`);
    // Published progress straight from the fixture file (not just echoed from the API).
    const progFile = path.join(projDir(p.id), "progress.json");
    const published = fs.existsSync(progFile) ? readJson<{ overallPercent?: number | null }>(progFile).overallPercent ?? null : null;
    const want = published == null ? "Not reported" : `${Math.round(published)}%`;
    expect(text.includes(want), `${p.id}: progress shows "${want}"`);
    if (published == null) expect((await card.locator('[role="progressbar"]').count()) === 0, `${p.id}: no bar when not reported`);
    else expect((await card.locator('[role="progressbar"]').getAttribute("aria-valuenow")) === String(Math.round(published)), `${p.id}: aria-valuenow`);
    const q = `${p.awaitingResponse} ${p.awaitingResponse === 1 ? "question needs" : "questions need"} response`;
    const u = `${p.unreadUpdates} unread ${p.unreadUpdates === 1 ? "update" : "updates"}`;
    expect(text.includes(q), `${p.id}: "${q}" missing in card text`);
    expect(text.includes(u), `${p.id}: "${u}" missing`);
    const attention = p.awaitingResponse > 0 || p.unreadUpdates > 0;
    expect(text.includes(attention ? "Needs attention" : "Up to date"), `${p.id}: attention text`);
    log(`${p.id} ${want} q=${p.awaitingResponse} u=${p.unreadUpdates}`);
  }
  expect((await page.getByRole("link", { name: /configuration problem/ }).count()) === 1, "diagnostics link missing");
  await shot(page, "desktop-landing");
});

// #2 — Harborlight → Game Developer → Progress → Outstanding Mechanics; detail loads only on expand.
await walk(2, "Workspace navigation; record detail loads lazily", async (log) => {
  desk.requests.length = 0;
  metrics.projectOpenUncachedMs = await timeClick(page, `a.project[href="#/p/${MW}"]`, ".workarea");
  await page.waitForSelector(".stat");
  await shot(page, "desktop-workspace");
  metrics.mainTabOpenMs = await timeClick(page, 'a.workarea[href$="/game-developer"]', '[data-section-id="outstanding-mechanics"] li.record');
  const selected = await page.locator('[role="tab"][aria-selected="true"]').textContent();
  expect(selected?.includes("Progress"), `default page tab should be Progress, got ${selected}`);
  expect(await page.locator('[data-section-id="outstanding-mechanics"] .card-toggle[aria-expanded="true"]').count(), "Outstanding Mechanics should be open (defaultOpen)");
  const detailReqsBefore = desk.requests.filter((r) => /\/records\/[^/?]+$/.test(apiPath(r.url)));
  expect(detailReqsBefore.length === 0, `detail requested before expand: ${detailReqsBefore.map((r) => apiPath(r.url)).join(", ")}`);
  expect((await page.locator(".markdown").count()) === 0, "markdown rendered before expand");
  const row = '[data-record-id="HBL-MECH-001"]';
  metrics.recordExpandMs = await timeClick(page, `${row} .record-toggle`, `${row} .markdown`);
  const detailReqs = desk.requests.filter((r) => apiPath(r.url) === `/api/projects/${MW}/records/HBL-MECH-001`);
  expect(detailReqs.length === 1, `expected exactly 1 detail request after expand, got ${detailReqs.length}`);
  const timing = detailReqs[0].req.timing();
  metrics.recordDetailRequestMs = Math.round(timing.responseEnd - timing.requestStart);
  expect(await page.locator(`${row} .record-toggle[aria-expanded="true"]`).count(), "row not aria-expanded");
  const others = desk.requests.filter((r) => /\/records\/[^/?]+$/.test(apiPath(r.url)) && !r.url.endsWith("HBL-MECH-001"));
  expect(others.length === 0, "other rows fetched details");
  log(`detail fetched only on expand (${metrics.recordExpandMs} ms)`);

  // Page-tab switch: uncached (100+ issues list) then cached back to Progress.
  metrics.pageTabSwitchUncachedMs = await timeClick(page, "#tab-test-issues", '[data-section-id="playtest-issues"] li.record');
  metrics.issueList100PlusFirstPageMs = metrics.pageTabSwitchUncachedMs;
  desk.requests.length = 0;
  metrics.pageTabSwitchCachedMs = await timeClick(page, "#tab-progress", '[data-section-id="outstanding-mechanics"] li.record');
  const refetched = desk.requests.filter((r) => apiPath(r.url).includes("/sections/outstanding-mechanics/records"));
  log(`tab switch uncached ${metrics.pageTabSwitchUncachedMs} ms, cached ${metrics.pageTabSwitchCachedMs} ms (${refetched.length} list refetch)`);
  expect(refetched.length === 0, "cached tab switch refetched the record list");
});

// #3 — back to All Projects and return without re-downloading.
await walk(3, "Return to All Projects and back without refetching", async (log) => {
  desk.requests.length = 0;
  await page.locator(".breadcrumb a", { hasText: "All projects" }).click();
  await page.waitForSelector(".project");
  metrics.projectOpenCachedMs = await timeClick(page, `a.project[href="#/p/${MW}"]`, ".workarea");
  await page.waitForTimeout(500);
  const paths = desk.requests.map((r) => apiPath(r.url));
  const navigation = paths.filter((p) => p.endsWith("/navigation"));
  const projectList = paths.filter((p) => p === "/api/projects");
  const detail = paths.filter((p) => p === `/api/projects/${MW}`);
  log(`requests during return: ${paths.length ? paths.join(", ") : "none"}; open ${metrics.projectOpenCachedMs} ms`);
  expect(navigation.length === 0, "navigation was refetched");
  expect(projectList.length === 0, "projects list was refetched");
  expect(detail.length === 0, "project detail was refetched");
});

const usedQuestions = new Set<string>();

// #4 — answer with Other + explanation → pending JSON in the project queue.
await walk(4, "Answer with Other + explanation → pending queue file", async (log) => {
  const candidates = await openQuestions(MW, "questions");
  const q = candidates.find((d) => d.answerSchema?.type === "single-choice" && d.answerSchema.allowOther && d.answerSchema.allowExplanation);
  expect(q, "no open single-choice question with Other in fixtures");
  usedQuestions.add(q.id);
  const before = new Set(listJson(pendingDir(MW)));
  const cardBefore = (await api<ProjectsResponse>("/api/projects")).projects.find((p) => p.id === MW)!;
  await page.goto(`${BASE}/#/p/${MW}/game-developer/review-desk?record=${q.id}`);
  const row = page.locator(`[data-record-id="${q.id}"]`).first();
  const form = row.locator(".question-form");
  await form.waitFor();
  await shot(page, "desktop-question");
  await form.getByLabel("Other", { exact: true }).check();
  await form.getByLabel("Describe your other choice").fill("E2E: align props to the terrain normal");
  await form.getByLabel("Explanation (optional)").fill("E2E explanation: looks natural on slopes.");
  await form.getByRole("button", { name: "Submit response" }).click();
  await row.getByText("Submitted · Awaiting pickup").first().waitFor();
  const env = await until("pending answer file", async () => pendingFor(MW, q.id, before));
  const a = env.answers[0];
  expect(env.source === "dashboard" && env.processingState === "pending", "envelope source/state");
  expect(a.kind === "choice" && a.optionIds?.includes("__other"), "optionIds should contain __other");
  expect(a.otherText === "E2E: align props to the terrain normal", "otherText");
  expect(a.explanation === "E2E explanation: looks natural on slopes.", "explanation");
  // Counts update in place (header stat), without a reload.
  const want = String(cardBefore.awaitingResponse - 1);
  await until("header count update", async () => (await page.locator(".stat", { hasText: "Need your response" }).locator("strong").textContent()) === want);
  log(`${q.id} → ${env.answerId}; awaitingResponse ${cardBefore.awaitingResponse} → ${want}`);
});

// #5 — upload a PNG plus a note via a file-upload question.
await walk(5, "Upload artwork + note → stored attachment and queued envelope", async (log) => {
  const all = [...(await openQuestions(MW, "map-question-list")), ...(await openQuestions(MW, "questions"))];
  const q = all.find((d) => d.answerSchema?.type === "file-upload" && !usedQuestions.has(d.id));
  expect(q, "no open file-upload question");
  usedQuestions.add(q.id);
  const before = new Set(listJson(pendingDir(MW)));
  // Section-less link: the UI resolves the record's tab itself.
  await page.goto(`${BASE}/#/p/${MW}?record=${q.id}`);
  const row = page.locator(`[data-record-id="${q.id}"]`).first();
  const form = row.locator(".question-form");
  await form.waitFor();
  log(`resolved to ${await page.evaluate(() => location.hash)}`);
  await form.locator('input[type="file"]').setInputFiles({ name: "e2e-artwork.png", mimeType: "image/png", buffer: PNG });
  await form.locator(".file-item", { hasText: "e2e-artwork.png" }).waitFor();
  await form.getByLabel("Comment (optional)").fill("E2E note: reference artwork attached.");
  await form.getByRole("button", { name: "Submit response" }).click();
  await row.getByText("Submitted · Awaiting pickup").first().waitFor();
  const env = await until("pending answer with files", async () => pendingFor(MW, q.id, before));
  const a = env.answers[0];
  expect(a.kind === "files" && a.attachmentIds?.length === 1, "one attachment id in answer");
  expect(a.comment === "E2E note: reference artwork attached.", "comment kept");
  const attId = a.attachmentIds![0];
  expect(env.attachments.includes(attId), "envelope.attachments lists the upload");
  const metaFile = findFile(path.join(projDir(MW), "attachments"), `${attId}.meta.json`);
  expect(metaFile, `upload meta for ${attId} not found`);
  const meta = readJson<{ mimeType: string; bytes: number; originalName: string; storedName: string }>(metaFile);
  expect(meta.mimeType === "image/png" && meta.bytes === PNG.length, `meta mime/bytes ${meta.mimeType}/${meta.bytes}`);
  expect(meta.originalName === "e2e-artwork.png", "original name kept as metadata");
  const stored = path.join(path.dirname(metaFile), meta.storedName);
  expect(fs.existsSync(stored) && fs.readFileSync(stored).equals(PNG), "stored bytes equal the upload");
  expect(!JSON.stringify(env).includes(PNG.toString("base64")), "no base64 payload in envelope");
  log(`${q.id} → ${env.answerId}, attachment ${attId}`);
});

// #6 — Excel round trip with a stale row.
await walk(6, "Export 3 questions to .xlsx → edit → import preview → commit; stale row rejected", async (log) => {
  const candidates = (await openQuestions(MW, "questions")).filter((d) => !usedQuestions.has(d.id));
  const single = candidates.find((d) => d.answerSchema?.type === "single-choice");
  const text = candidates.find((d) => d.answerSchema?.type === "free-text");
  const approval = candidates.find((d) => d.answerSchema?.type === "approval");
  expect(single && text && approval, "need open single-choice, free-text and approval questions");
  const chosen = [single, text, approval];
  chosen.forEach((d) => usedQuestions.add(d.id));

  await page.goto(`${BASE}/#/p/${MW}/game-developer/review-desk`);
  const card = page.locator('[data-section-id="questions"]');
  for (const d of chosen) await card.locator(`li[data-record-id="${d.id}"] input[type="checkbox"]`).check();
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Export to Excel (3)" }).click()]);
  const xlsx = path.join(DL, download.suggestedFilename() || "export.xlsx");
  await download.saveAs(xlsx);
  expect(xlsx.endsWith(".xlsx"), `download name ${download.suggestedFilename()}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.getWorksheet("Answers");
  expect(ws && wb.getWorksheet("Instructions"), "Answers/Instructions sheets");
  const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const col = (h: string) => header.indexOf(h);
  const cQ = col("Question ID"), cResp = col("Response"), cNotes = col("Notes / explanation / rationale");
  expect(cQ > 0 && cResp > 0 && cNotes > 0, `unexpected columns: ${header.join("|")}`);
  const seen = new Set<string>();
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const qid = String(row.getCell(cQ).value ?? "");
    seen.add(qid);
    if (qid === single.id && single.answerSchema?.type === "single-choice") row.getCell(cResp).value = single.answerSchema.options[0].id;
    if (qid === text.id) row.getCell(cResp).value = "E2E offline free-text answer";
    if (qid === approval.id) {
      row.getCell(cResp).value = "Approve";
      row.getCell(cNotes).value = "E2E rationale";
    }
  });
  expect(chosen.every((d) => seen.has(d.id)), `workbook rows ${[...seen].join(",")}`);
  const edited = path.join(DL, "edited.xlsx");
  await wb.xlsx.writeFile(edited);

  // Revise one exported question on disk → its row must be rejected as stale.
  const recFile = findFile(path.join(projDir(MW), "sections"), `${approval.id}.json`);
  expect(recFile, "approval record file");
  const rec = readJson<Record<string, unknown>>(recFile);
  const newRev = Number(rec.questionRevision ?? 1) + 1;
  rec.questionRevision = newRev;
  rec.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
  await until("revised question indexed", async () => (await api<RecordDetail>(`/api/projects/${MW}/records/${approval.id}`)).question?.revision === newRev);

  const before = new Set(listJson(pendingDir(MW)));
  await card.getByRole("button", { name: "Import Excel" }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Workbook (.xlsx)").setInputFiles(edited);
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await dialog.locator("table").waitFor();
  await shot(page, "desktop-import-preview");
  const rowStatus = async (id: string) => (await dialog.locator("tr", { hasText: id }).locator("td").nth(2).textContent()) ?? "";
  expect((await rowStatus(single.id)).includes("Ready"), `${single.id}: ${await rowStatus(single.id)}`);
  expect((await rowStatus(text.id)).includes("Ready"), `${text.id}: ${await rowStatus(text.id)}`);
  expect((await rowStatus(approval.id)).includes("Stale"), `${approval.id} should be stale: ${await rowStatus(approval.id)}`);
  expect((await dialog.locator("tr", { hasText: approval.id }).locator('input[type="checkbox"]').count()) === 0, "stale row must not be selectable");
  await dialog.getByRole("button", { name: "Submit 2 selected answers" }).click();
  await until("commit results", async () => (await dialog.getByText("Submitted · Awaiting pickup").count()) === 2);
  const e1 = pendingFor(MW, single.id, before);
  const e2 = pendingFor(MW, text.id, before);
  const e3 = pendingFor(MW, approval.id, before);
  expect(e1?.source === "excel-import" && e2?.source === "excel-import", "imported envelopes with source excel-import");
  expect(e2?.answers[0].text === "E2E offline free-text answer", "imported text");
  expect(!e3, "stale question must not be queued");
  await dialog.getByRole("button", { name: "Close" }).first().click();
  log(`ready ${single.id}, ${text.id}; stale ${approval.id} (rev ${newRev}) rejected`);
  metrics.__editedWorkbook = edited;
});

// #7 — ADR ZIP.
await walk(7, "Select ADRs → ZIP with original files and manifest", async (log) => {
  await page.goto(`${BASE}/#/p/${MW}/docs-editor/adr-reviews`);
  const card = page.locator('[data-section-id="adr-review-list"]');
  const ids = ["HBL-ADR-001", "HBL-ADR-002", "HBL-ADR-009"];
  for (const id of ids) await card.locator(`li[data-record-id="${id}"] input[type="checkbox"]`).check();
  await card.getByRole("button", { name: /Download ZIP \(3\)/ }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByText("2 files available").waitFor();
  expect(await dialog.getByText("HBL-ADR-009-md").count(), "missing attachment listed before download");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download ZIP", exact: true }).click()]);
  const zipFile = path.join(DL, download.suggestedFilename() || "docs.zip");
  await download.saveAs(zipFile);
  const entries = await unzipEntries(zipFile);
  const manifest = JSON.parse(entries.get("manifest.json")?.toString("utf8") ?? "null") as { files: { path: string; recordId: string }[]; missing: { attachmentId: string }[] } | null;
  expect(manifest, "manifest.json missing");
  expect(manifest.files.length === 2, `manifest files ${manifest.files.length}`);
  expect(manifest.missing.some((m) => m.attachmentId === "HBL-ADR-009-md"), "manifest lists the missing attachment");
  for (const f of manifest.files) {
    const buf = entries.get(f.path);
    expect(buf, `zip entry ${f.path}`);
    const orig = findFile(path.join(projDir(MW), "attachments"), path.basename(f.path));
    expect(orig && fs.readFileSync(orig).equals(buf), `${f.path} differs from the original file`);
  }
  log(`${download.suggestedFilename()}: ${[...entries.keys()].join(", ")}`);
});

// #8 — a third project appears from folders + manifests only.
await walk(8, "New project folder appears without code changes or reload", async (log) => {
  await page.goto(BASE + "/");
  await page.waitForSelector(".project");
  const dst = projDir("e2e-added");
  fs.cpSync(projDir("cards-only"), dst, { recursive: true });
  const pj = readJson<Record<string, unknown>>(path.join(dst, "project.json"));
  pj.id = "e2e-added";
  pj.displayName = "E2E Added (synthetic)";
  fs.writeFileSync(path.join(dst, "project.json"), JSON.stringify(pj, null, 2));
  const t0 = Date.now();
  await page.locator('a.project[href="#/p/e2e-added"]').waitFor({ timeout: 20_000 });
  metrics.newProjectVisibleMs = Date.now() - t0;
  log(`card visible after ${metrics.newProjectVisibleMs} ms (no page reload)`);
});

// #9 — malformed JSON in one section.
await walk(9, "Malformed section JSON → diagnostics; other projects unaffected", async (log) => {
  const bad = path.join(projDir("atlas-toolkit"), "sections", "reviews", "open", "section.json");
  fs.writeFileSync(bad, '{ "schemaVersion": 1, "id": "open", ');
  await until("diagnostic for malformed section", async () =>
    (await api<DiagnosticsResponse>("/api/diagnostics")).diagnostics.some((d) => d.projectId === "atlas-toolkit" && (d.path ?? "").replace(/\\/g, "/").includes("reviews/open")),
  );
  await page.goto(BASE + "/#/diagnostics");
  await page.locator("table").first().waitFor();
  const table = (await page.locator("table").first().textContent()) ?? "";
  expect(table.includes("atlas-toolkit"), "diagnostics table shows atlas-toolkit");
  expect(table.includes("legacy-sidebar") || table.includes("sidebar"), "fixture's invalid section manifest listed");
  await shot(page, "desktop-diagnostics");
  const projects = await api<ProjectsResponse>("/api/projects");
  for (const id of [MW, "cards-only", "atlas-toolkit"]) expect(projects.projects.find((p) => p.id === id)?.available, `${id} should still be available`);
  await page.goto(`${BASE}/#/p/${MW}/game-developer`);
  await page.locator('[data-section-id="outstanding-mechanics"] li.record').first().waitFor();
  await page.goto(`${BASE}/#/p/atlas-toolkit`);
  await page.locator('[role="tab"]').first().waitFor();
  log(`diagnostics: ${(await api<DiagnosticsResponse>("/api/diagnostics")).diagnostics.length}; other projects render`);
});

// #10 — mobile width, keyboard-only navigation, ARIA.
await walk(10, "Mobile 360 px, keyboard-only tabs, ARIA labels; change propagation", async (log) => {
  const m = await open({ width: 360, height: 780 }, "mobile360");
  const mp = m.page;
  await mp.goto(BASE + "/");
  await mp.waitForSelector(".project");
  expect((await overflowX(mp)) <= 0, "landing overflows at 360 px");
  await mp.goto(`${BASE}/#/p/${MW}/game-developer`);
  await mp.locator('[data-section-id="outstanding-mechanics"] li.record').first().waitFor();
  expect((await overflowX(mp)) <= 0, "workspace overflows at 360 px");
  await mp.locator('[data-record-id="HBL-MECH-001"] .record-toggle').click();
  await mp.locator('[data-record-id="HBL-MECH-001"] .markdown').waitFor();
  expect((await overflowX(mp)) <= 0, "expanded record overflows at 360 px");
  const small = await mp.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button.btn, .record-toggle, .tab, .card-toggle"))
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40)
      .map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`),
  );
  expect(small.length === 0, `buttons under 40 px: ${small.slice(0, 5).join(", ")}`);
  await m.ctx.close();

  // Keyboard only: Tab to the tab list, arrows switch tabs, Enter expands a record.
  await page.goto(`${BASE}/#/p/${MW}/game-developer`);
  await page.locator('[role="tab"]').first().waitFor();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  let onTab = false;
  for (let i = 0; i < 80 && !onTab; i++) {
    await page.keyboard.press("Tab");
    onTab = await page.evaluate(() => document.activeElement?.getAttribute("role") === "tab");
  }
  expect(onTab, "could not reach the tab list with the Tab key");
  await page.keyboard.press("ArrowRight");
  await until("hash after ArrowRight", async () => (await page.evaluate(() => location.hash)).endsWith("/review-desk"), 5000);
  // The hash changes before React re-renders the tab list; wait for the render instead of sampling once.
  const focusedOnSelectedTab = () =>
    page.evaluate(() => document.activeElement?.getAttribute("role") === "tab" && document.activeElement.getAttribute("aria-selected") === "true");
  await until("focus on the newly selected tab", focusedOnSelectedTab, 5000).catch(() => undefined);
  expect(await focusedOnSelectedTab(), "focus should stay on the newly selected tab");
  await page.keyboard.press("ArrowLeft");
  await until("hash after ArrowLeft", async () => (await page.evaluate(() => location.hash)).endsWith("/progress"), 5000);
  await page.locator('[data-record-id="HBL-MECH-002"] .record-toggle').focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-record-id="HBL-MECH-002"] .record-toggle[aria-expanded="true"]').waitFor();
  const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(focusRing !== "none", "no visible focus outline on keyboard focus");

  // ARIA on progress bars and unread dots.
  const aria = await page.evaluate(() => ({
    bars: Array.from(document.querySelectorAll('[role="progressbar"]')).filter((b) => !b.getAttribute("aria-label") || b.getAttribute("aria-valuenow") == null).length,
    barCount: document.querySelectorAll('[role="progressbar"]').length,
    dots: Array.from(document.querySelectorAll(".unread-dot")).filter((d) => !d.getAttribute("aria-label")).length,
    dotCount: document.querySelectorAll(".unread-dot").length,
  }));
  expect(aria.barCount > 0 && aria.bars === 0, `progress bars without label/value: ${aria.bars}/${aria.barCount}`);
  expect(aria.dotCount > 0 && aria.dots === 0, `unread dots without label: ${aria.dots}/${aria.dotCount}`);
  log(`keyboard tabs OK; ${aria.barCount} progress bars and ${aria.dotCount} unread dots labelled`);

  // Change propagation: a new record file shows up via watcher + SSE without reload.
  const recDir = path.join(projDir(MW), "sections", "game-developer", "progress", "outstanding-mechanics", "records");
  const rec = {
    schemaVersion: 1, id: "HBL-MECH-E2E", recordType: "task", title: "E2E propagation mechanic", summary: "SYNTHETIC: written by e2e",
    status: "planned", priority: "low", order: 999, updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const t0 = Date.now();
  fs.writeFileSync(path.join(recDir, "HBL-MECH-E2E.json"), JSON.stringify(rec, null, 2));
  await page.locator('[data-record-id="HBL-MECH-E2E"]').waitFor({ timeout: 20_000 });
  metrics.changePropagationMs = Date.now() - t0;
  log(`new record visible after ${metrics.changePropagationMs} ms`);
});

// Extra: the 100+ question list — "All" filter and paging through every page.
await walk(11, "100+ question list: All filter and Load more through every page", async (log) => {
  const expected = (await api<RecordPage>(`/api/projects/${MW}/sections/questions/records?status=all&limit=1`)).total;
  expect(expected >= 100, `fixture should have 100+ questions, has ${expected}`);
  await page.goto(`${BASE}/#/p/${MW}/game-developer/review-desk`);
  await page.locator('[data-section-id="questions"] li.record').first().waitFor();
  metrics.questionsFilterAllMs = await timeClick(page, '[data-section-id="questions"] .chip', '[data-section-id="questions"] .list-footer', `of ${expected}`);
  const rows = page.locator('[data-section-id="questions"] li.record');
  const more = page.locator('[data-section-id="questions"] .load-more');
  const t0 = Date.now();
  while ((await more.count()) > 0 && Date.now() - t0 < 20_000) {
    const n = await rows.count();
    await more.click();
    try {
      await until("next page of questions", async () => (await rows.count()) > n, 10_000, 30);
    } catch (e) {
      // Diagnostics for an intermittent stall seen once locally: what the list and the button looked like.
      const btn = (await more.count()) ? `"${await more.textContent()}" disabled=${await more.isDisabled()}` : "gone";
      const apiTail = desk.requests.slice(-5).map((r) => apiPath(r.url) + new URL(r.url).search).join(" | ");
      throw new Fail(`${(e as Error).message}; rows ${n} → ${await rows.count()}, load-more ${btn}; last requests: ${apiTail}`);
    }
  }
  metrics.questionsLoadAllMs = Date.now() - t0;
  const rendered = await rows.count();
  metrics.questionsRendered = rendered;
  expect(rendered === expected, `rendered ${rendered} of ${expected}`);
  expect((await page.locator('[data-section-id="questions"] .markdown').count()) === 0, "collapsed rows must not render markdown");
  metrics.jsHeapUsedBytesAfterWalks = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  log(`All filter ${metrics.questionsFilterAllMs} ms; ${rendered} rows after paging in ${metrics.questionsLoadAllMs} ms`);
});

// Extra: a consumer rejected an answer → failure reason shown → "Answer again" → new pending envelope.
await walk(12, "Failed answer: failure reason, Answer again → new pending queue file", async (log) => {
  const failedDir = path.join(projDir(MW), "communications", "answers", "failed");
  const failedFile = listJson(failedDir)[0];
  expect(failedFile, "fixture has no failed answer");
  const old = readJson<Envelope & { result?: { reason?: string } }>(path.join(failedDir, failedFile));
  const qid = old.questionId;
  const before = new Set(listJson(pendingDir(MW)));
  await page.goto(`${BASE}/#/p/${MW}?record=${qid}`);
  const row = page.locator(`[data-record-id="${qid}"]`).first();
  await row.locator(".answer-view").waitFor();
  const reason = old.result?.reason ?? "";
  expect(reason && ((await row.locator(".answer-view .notice").textContent()) ?? "").includes(reason), "failure reason not shown");
  expect((await row.locator(".question-form").count()) === 0, "form shown before Answer again");
  await shot(page, "desktop-failed-answer");
  await row.getByRole("button", { name: "Answer again" }).click();
  const form = row.locator(".question-form");
  await form.waitFor();
  await form.locator("textarea, input[type=text]").first().fill("E2E second attempt after a failed pickup.");
  await form.getByRole("button", { name: "Submit response" }).click();
  await row.getByText("Submitted · Awaiting pickup").first().waitFor();
  const env = await until("new pending answer file", async () => pendingFor(MW, qid, before));
  expect(env.answerId !== old.answerId, "new answer must get a new answerId");
  expect(env.answers[0].text === "E2E second attempt after a failed pickup.", "resubmitted text");
  expect(fs.existsSync(path.join(failedDir, failedFile)), "failed envelope must stay for the audit trail");
  log(`${qid}: ${old.answerId} (failed) → ${env.answerId} (pending)`);
});

// ------------------------------------------------- screenshots (mobile) --
try {
  const m = await open(MOBILE, "mobile390");
  const mp = m.page;
  await mp.goto(BASE + "/");
  await mp.waitForSelector(".project");
  await shot(mp, "mobile-landing");
  await mp.goto(`${BASE}/#/p/${MW}`);
  await mp.waitForSelector(".workarea");
  await shot(mp, "mobile-workspace");
  const open2 = (await openQuestions(MW, "map-question-list")).concat(await openQuestions(MW, "questions")).find((d) => !usedQuestions.has(d.id));
  if (open2) {
    await mp.goto(`${BASE}/#/p/${MW}?record=${open2.id}`);
    await mp.locator(`[data-record-id="${open2.id}"] .question-form`).first().waitFor();
    await shot(mp, "mobile-question");
  }
  const edited = metrics.__editedWorkbook;
  if (typeof edited === "string") {
    await mp.goto(`${BASE}/#/p/${MW}/game-developer/review-desk`);
    const card = mp.locator('[data-section-id="questions"]');
    await card.getByRole("button", { name: "Import Excel" }).click();
    const dialog = mp.locator("dialog[open]");
    await dialog.getByLabel("Workbook (.xlsx)").setInputFiles(edited);
    await dialog.getByRole("button", { name: "Preview import" }).click();
    await dialog.locator("table").waitFor();
    await shot(mp, "mobile-import-preview");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
  await mp.goto(BASE + "/#/diagnostics");
  await mp.locator("table").first().waitFor();
  await shot(mp, "mobile-diagnostics");
  await m.ctx.close();
} catch (e) {
  consoleProblems.push(`mobile screenshots failed: ${String(e)}`);
}

// --------------------------------------------------------------- report --
delete metrics.__editedWorkbook;
const failed = results.filter((r) => !r.pass);
const report = {
  generatedAt: new Date().toISOString(),
  note: "Measured on the local dev machine against synthetic fixtures (in-process server, headless Edge). Timings are in-page performance.now() deltas unless noted.",
  environment: { node: process.version, platform: `${process.platform} ${os.release()}`, cpus: os.cpus().length, browser: metrics.browser },
  metrics,
  walks: results,
  consoleProblems,
};
fs.writeFileSync(path.join(SHOTS, "e2e-results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nMetrics: ${JSON.stringify(metrics)}`);
if (consoleProblems.length) console.log(`Console problems:\n  ${consoleProblems.join("\n  ")}`);
console.log(`\n${results.length - failed.length}/${results.length} walks passed. Report: docs/screenshots/e2e-results.json`);

await browser.close();
store.stop();
await app.close();
if (process.env.E2E_KEEP || failed.length) console.log(`Temp data root kept at ${TMP}`);
else await fsp.rm(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
