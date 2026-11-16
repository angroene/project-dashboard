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
import { addDays, runRecurrence } from "../src/server/recurrence.js";
import type { DiagnosticsResponse, ProjectsResponse, RecordDetail, RecordPage } from "../src/shared/api.js";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "data");
const EXAMPLES = path.join(REPO, "examples", "projects");
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
// The browser runs on this machine: login-free for loopback only (auth.mode "local-network"); walk 14 covers the others.
const cfg = loadConfig({ dataRoot: DATA, webRoot: WEB_ROOT, port, host: "127.0.0.1", watch: true, logLevel: "silent", reconcileSeconds: 3,
  auth: { mode: "local-network", trustedNetworks: ["127.0.0.1/32", "::1/128"] } });
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
    const link = page.locator(`a.project-link[href="#/p/${p.id}"]`);
    expect((await link.count()) === 1, `card for ${p.id} missing`);
    const card = page.locator(".project", { has: link });
    const details = card.locator(".project-details");
    // Collapsed by default: name, then one status line.
    expect(!(await details.isVisible()), `${p.id}: details visible before expanding`);
    expect(((await link.textContent()) ?? "").includes(p.displayName), `${p.id}: name`);
    const line = (await card.locator(".project-line").textContent()) ?? "";
    // Published progress straight from the fixture file (not just echoed from the API).
    const progFile = path.join(projDir(p.id), "progress.json");
    const published = fs.existsSync(progFile) ? readJson<{ overallPercent?: number | null }>(progFile).overallPercent ?? null : null;
    if (p.requireAttention > 0) {
      const want = `${p.requireAttention} ${p.requireAttention === 1 ? "requires" : "require"} attention`;
      expect(line.includes(want), `${p.id}: collapsed line "${line}" should say "${want}"`);
    } else if (published != null) {
      expect(line.includes(`${Math.round(published)}%`), `${p.id}: collapsed line shows the percentage`);
    } else {
      expect(line.trim() === "", `${p.id}: nothing invented when there is no attention or progress ("${line}")`);
    }
    await card.locator(".project-expand").click();
    expect((await card.locator(".project-expand").getAttribute("aria-expanded")) === "true", `${p.id}: aria-expanded`);
    const text = (await details.textContent()) ?? "";
    const want = published == null ? "Not reported" : `${Math.round(published)}%`;
    expect(text.includes(want), `${p.id}: progress shows "${want}"`);
    if (published == null) expect((await details.locator('[role="progressbar"]').count()) === 0, `${p.id}: no bar when not reported`);
    else expect((await details.locator('[role="progressbar"]').getAttribute("aria-valuenow")) === String(Math.round(published)), `${p.id}: aria-valuenow`);
    const q = `${p.awaitingResponse} ${p.awaitingResponse === 1 ? "question needs" : "questions need"} response`;
    const u = `${p.unreadUpdates} unread ${p.unreadUpdates === 1 ? "update" : "updates"}`;
    expect(text.includes(q), `${p.id}: "${q}" missing in card text`);
    expect(text.includes(u), `${p.id}: "${u}" missing`);
    log(`${p.id} ${want} q=${p.awaitingResponse} u=${p.unreadUpdates} attention=${p.requireAttention}`);
  }
  expect((await page.getByRole("link", { name: /configuration problem/ }).count()) === 1, "diagnostics link missing");
  await shot(page, "desktop-landing-expanded");
  // Screenshot of the default (collapsed) landing page.
  await page.reload();
  await page.waitForSelector(".project");
  await shot(page, "desktop-landing");
});

// #2 — Harborlight → Game Developer → Progress → Outstanding Mechanics; detail loads only on expand.
await walk(2, "Workspace navigation; record detail loads lazily", async (log) => {
  desk.requests.length = 0;
  metrics.projectOpenUncachedMs = await timeClick(page, `a.project-link[href="#/p/${MW}"]`, ".workarea");
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
  metrics.projectOpenCachedMs = await timeClick(page, `a.project-link[href="#/p/${MW}"]`, ".workarea");
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
  await page.locator('a.project-link[href="#/p/e2e-added"]').waitFor({ timeout: 20_000 });
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
  // A long code line scrolls inside its box; the record itself stays within the screen. (Page overflow alone misses
  // this: the record list clips, so the page does not get wider while the record's text runs off the edge.)
  await mp.goto(`${BASE}/#/p/${MW}?record=HBL-CR-0001`);
  const cr = mp.locator('[data-record-id="HBL-CR-0001"]').first();
  await cr.waitFor();
  if ((await cr.locator('.record-toggle[aria-expanded="true"]').count()) === 0) await cr.locator(".record-toggle").click();
  await cr.locator(".markdown pre").waitFor();
  const wide = await cr.evaluate((card) => {
    const pre = card.querySelector(".markdown pre")!;
    return { cardRight: card.getBoundingClientRect().right, viewport: window.innerWidth, preScrolls: pre.scrollWidth > pre.clientWidth };
  });
  expect(wide.cardRight <= wide.viewport, `record with a long code line is ${Math.round(wide.cardRight - wide.viewport)} px wider than the screen`);
  expect(wide.preScrolls, "long code line should scroll inside its box");
  // Image attachments show as previews, before the answer form.
  await mp.goto(`${BASE}/#/p/${MW}?record=HBL-MQ-001`);
  const mq = mp.locator('[data-record-id="HBL-MQ-001"]').first();
  await mq.waitFor();
  if ((await mq.locator('.record-toggle[aria-expanded="true"]').count()) === 0) await mq.locator(".record-toggle").click();
  const preview = mq.locator(".attachment-preview img").first();
  await preview.scrollIntoViewIfNeeded();
  await until("image preview loaded", () => preview.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), 5000);
  const order = await mq.evaluate((card) => {
    const att = card.querySelector(".attachment-preview");
    const form = card.querySelector(".question-area");
    return !!att && !!form && !!(att.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order, "attachments should come before the answer form");
  expect((await overflowX(mp)) <= 0, "question with an image preview overflows at 360 px");
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
      // Diagnostics if the list stops growing: what the list and the button looked like (a live update that
      // arrived during a page load used to cancel that load; see applyInvalidation).
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

// #13 — generic capabilities on the fictional example projects: default answer, tracked fields, filter, comment,
// external reference, recurring template resume → occurrence → pause.
await walk(13, "Defaults, tracked fields, comments, external refs, recurring template (example projects)", async (log) => {
  for (const name of fs.readdirSync(EXAMPLES)) fs.cpSync(path.join(EXAMPLES, name), projDir(name), { recursive: true });
  const LNT = "lantern-web-app";
  const TP = "tidepool-notebook";
  await until("example projects indexed", async () => (await api<ProjectsResponse>("/api/projects")).projects.some((p) => p.id === TP));

  // Default answer: pre-selected, labelled, nothing submitted.
  await page.goto(`${BASE}/#/p/${LNT}?record=LNT-Q-002`);
  const q = page.locator('[data-record-id="LNT-Q-002"]').first();
  await q.locator(".question-form").waitFor();
  expect(await q.getByRole("radio", { name: "Approve" }).isChecked(), "default Approve not pre-selected");
  expect(((await q.getByTestId("field-default").textContent()) ?? "").includes("Suggested default: Approve"), "default not labelled");
  expect(listJson(pendingDir(LNT)).length === 0, "a default must not create an answer");
  await shot(page, "desktop-default-answer");

  // Tracked fields and the external reference on a review.
  await page.goto(`${BASE}/#/p/${LNT}?record=LNT-REV-001`);
  const rev = page.locator('[data-record-id="LNT-REV-001"]').first();
  await rev.locator(".tracked-fields").waitFor();
  expect(((await rev.locator(".external-refs").textContent()) ?? "").includes("code review reports open"), "external status not shown as reported");
  expect((await rev.locator(".external-refs a").getAttribute("rel")) === "noopener noreferrer", "external link rel");
  const recFile = path.join(projDir(LNT), "sections", "build", "quality", "reviews", "records", "LNT-REV-001.json");
  await rev.getByRole("checkbox", { name: "Reviewed" }).check();
  await until("reviewed saved", async () => readJson<{ fields?: Record<string, unknown> }>(recFile).fields?.reviewed === true);
  await rev.getByRole("combobox", { name: "Decision" }).selectOption("changes");
  await until("decision saved", async () => readJson<{ fields?: Record<string, unknown> }>(recFile).fields?.decision === "changes");
  await rev.getByRole("textbox", { name: "Add a comment" }).fill("E2E: please split the sync notes.");
  await rev.getByRole("button", { name: "Add" }).click();
  const hist = await until("comment in history", async () => {
    const h = readJson<{ history?: { text: string; by?: string }[] }>(recFile).history ?? [];
    return h.some((x) => x.text === "E2E: please split the sync notes.") ? h : null;
  });
  expect(hist.some((x) => x.text === "Reviewed: — → yes" && x.by === "user"), "field change not in history");
  await rev.locator(".history").getByText("Decision: — → Request changes").waitFor();
  expect((await rev.getByRole("checkbox", { name: "Checks passed" }).count()) === 0, "agent-only field must not be editable");
  await shot(page, "desktop-review-fields");

  // Filter the card by the field.
  const card = page.locator('[data-section-id="reviews"]');
  await card.getByRole("combobox", { name: "Filter by Reviewed" }).selectOption("false");
  await card.getByText("No records match the current filter.").waitFor();
  await card.getByRole("combobox", { name: "Filter by Reviewed" }).selectOption("true");
  await card.locator('[data-record-id="LNT-REV-001"]').waitFor();
  log("default shown, 2 fields + comment saved with history, field filter works");

  // Recurring template: resume, scheduler run, occurrence appears live, pause again.
  await page.goto(`${BASE}/#/p/${TP}?record=field-log-2026-11-13`);
  const obs = page.locator('[data-section-id="observations"]');
  await obs.getByText("Recurring templates (1)").click();
  await obs.getByRole("button", { name: "Resume" }).click();
  const tplFile = path.join(projDir(TP), "sections", "observations", "templates", "field-log.json");
  await until("template active", async () => readJson<{ state: string }>(tplFile).state === "active");
  // Resuming starts from today (the server's clock); simulate a check a few days later at 08:00 Honolulu time (after
  // the 07:00 schedule): catchUpDays 1 gives the day before and that day.
  const day = addDays(new Date().toISOString().slice(0, 10), 5);
  const at = new Date(`${day}T18:00:00Z`);
  const made = await runRecurrence(store, TP, at);
  expect(made.created.join() === `field-log-${addDays(day, -1)},field-log-${day}`, `occurrences: ${made.created.join()}`);
  expect((await runRecurrence(store, TP, new Date(at.getTime() + 5 * 60_000))).created.length === 0, "second run must create nothing");
  await obs.locator(`[data-record-id="field-log-${day}"]`).waitFor({ timeout: 15_000 });
  await obs.getByRole("button", { name: "Pause" }).click();
  await until("template paused", async () => readJson<{ state: string }>(tplFile).state === "paused");
  await shot(page, "desktop-recurring");
  log(`resumed → ${made.created.length} occurrences, idempotent re-run, paused`);
});

await walk(14, "Login modes: required, local-network (forged X-Forwarded-For ignored), disabled warning", async (log) => {
  const OP = "e2e-operator-token-0123456789abcdef";
  const servers: { close: () => Promise<unknown> }[] = [];
  /** A separate server on its own copy of the fixtures, in the given login mode. */
  const serve = async (auth: Record<string, unknown>) => {
    const root = path.join(TMP, `auth-${servers.length}`);
    fs.cpSync(FIXTURES, root, { recursive: true });
    fs.writeFileSync(path.join(root, "op.txt"), OP);
    const p = await freePort();
    const c = loadConfig({ dataRoot: root, webRoot: WEB_ROOT, port: p, host: "127.0.0.1", watch: false, logLevel: "silent", reconcileSeconds: 0,
      recurrenceSeconds: 0, auth: { tokenFile: path.join(root, "op.txt"), ...auth } });
    const h = await buildApp(c, { logger: false });
    await h.app.listen({ host: "127.0.0.1", port: p });
    servers.push({ close: async () => { h.store.stop(); await h.app.close(); } });
    return `http://127.0.0.1:${p}`;
  };
  // Own contexts without the console listener: the expected 401 responses are not page problems.
  const page = async (headers?: Record<string, string>) => {
    const ctx = await browser.newContext({ viewport: DESKTOP, extraHTTPHeaders: headers });
    return { ctx, page: await ctx.newPage() };
  };
  try {
    // required: the sign-in page, a wrong token is refused, the right one opens the projects.
    const req = await serve({ mode: "required" });
    const a = await page();
    await a.page.goto(req + "/");
    await a.page.getByRole("heading", { name: "Sign in" }).waitFor();
    expect((await a.page.request.get(req + "/api/projects")).status() === 401, "required: API answered without a session");
    await a.page.locator('input[type="password"]').fill("wrong-token-0123456789");
    await a.page.getByRole("button", { name: "Sign in" }).click();
    await a.page.getByText(/wrong access token/i).waitFor();
    await a.page.locator('input[type="password"]').fill(OP);
    await a.page.getByRole("button", { name: "Sign in" }).click();
    await a.page.locator(".project").first().waitFor();
    expect(await a.page.getByRole("button", { name: "Sign out" }).isVisible(), "required: no Sign out after login");
    await a.ctx.close();
    log("required: sign-in enforced");

    // local-network trusting 10.0.0.0/8 only: this browser (127.0.0.1) must sign in, also when it forges its address.
    const lan = await serve({ mode: "local-network", trustedNetworks: ["10.0.0.0/8"] });
    const b = await page({ "X-Forwarded-For": "10.1.2.3", "X-Real-IP": "10.1.2.3", Forwarded: "for=10.1.2.3" });
    await b.page.goto(lan + "/");
    await b.page.getByRole("heading", { name: "Sign in" }).waitFor();
    expect((await b.page.request.get(lan + "/api/projects")).status() === 401, "local-network: forged X-Forwarded-For was believed");
    await b.ctx.close();
    // local-network trusting loopback: no sign-in, no warning.
    const lo = await serve({ mode: "local-network", trustedNetworks: ["127.0.0.1/32", "::1/128"] });
    const c = await page();
    await c.page.goto(lo + "/");
    await c.page.locator(".project").first().waitFor();
    expect(!(await c.page.getByRole("heading", { name: "Sign in" }).isVisible()), "local-network: trusted client asked to sign in");
    expect((await c.page.getByTestId("auth-disabled-warning").count()) === 0, "local-network shows the disabled warning");
    await c.ctx.close();
    log("local-network: trusted range login-free, forged headers ignored");

    // disabled: no sign-in, a warning on the page.
    const off = await serve({ mode: "disabled", tokenFile: undefined });
    const d = await page();
    await d.page.goto(off + "/");
    await d.page.locator(".project").first().waitFor();
    const warn = d.page.getByTestId("auth-disabled-warning");
    await warn.waitFor();
    expect(/Sign-in is disabled/.test(await warn.innerText()), "disabled: warning text missing");
    await shot(d.page, "desktop-auth-disabled-warning");
    await d.ctx.close();
    log("disabled: warning shown");
  } finally {
    for (const sv of servers) await sv.close();
  }
});

// #15 — attention groups: counts, deep link, Show all, select and mark read; Back to top.
await walk(15, "Attention groups: counts, deep link, Show all, Mark selected as read; Back to top", async (log) => {
  const att = await api<{ counts: Record<string, number>; totals: Record<string, number> }>(`/api/projects/${MW}/attention`);
  await page.goto(`${BASE}/#/p/${MW}?attention=updates`);
  const panel = page.locator(".attention-panel").first();
  await panel.waitFor();
  for (const [g, title] of [["questions", "Questions"], ["actions", "Actions"], ["responses", "Responses"], ["updates", "Updates"]] as const) {
    const chip = panel.locator(".attention-chip", { hasText: title });
    expect(((await chip.locator("strong").textContent()) ?? "") === String(att.counts[g]), `${g}: chip count ${await chip.textContent()} vs ${att.counts[g]}`);
  }
  expect(att.counts.updates > 1, "fixtures need at least two unread updates");
  const group = page.locator(`#attention-${MW}-updates`);
  await group.locator(".attention-item").first().waitFor();
  await until("deep link focuses the Updates group", async () => page.evaluate((id) => document.activeElement?.closest(`#${id}`) != null, `attention-${MW}-updates`), 5000);
  expect(!(await panel.getByRole("checkbox", { name: "Show all" }).isChecked()), "Show all must be off on open");
  // Mark one unread update read: only read state changes.
  const firstId = await group.locator(".attention-item a.list-link").first().getAttribute("href");
  const rid = new URLSearchParams((firstId ?? "").split("?")[1]).get("record")!;
  const before = await api<RecordDetail>(`/api/projects/${MW}/records/${rid}`);
  await group.locator(".attention-item").first().getByRole("checkbox").check();
  await group.getByRole("button", { name: "Mark selected as read (1)" }).click();
  await until("updates count down by one", async () => (await api<{ counts: Record<string, number> }>(`/api/projects/${MW}/attention`)).counts.updates === att.counts.updates - 1);
  await until("chip follows", async () => ((await panel.locator(".attention-chip", { hasText: "Updates" }).locator("strong").textContent()) ?? "") === String(att.counts.updates - 1));
  const after = await api<RecordDetail>(`/api/projects/${MW}/records/${rid}`);
  expect(after.status === before.status && after.revision === before.revision && !after.unread, "mark read changed more than read state");
  // Show all brings the read item back, without writing anything.
  const writes = desk.requests.length;
  await panel.getByRole("checkbox", { name: "Show all" }).check();
  await page.locator(`#attention-${MW}-updates a.list-link[href*="record=${rid}"]`).waitFor();
  expect(desk.requests.slice(writes).every((r) => r.req.method() === "GET"), "Show all sent a write");
  await shot(page, "desktop-attention");
  // Header counts open the matching group.
  await page.goto(`${BASE}/#/p/${MW}/game-developer`);
  await page.locator("a.stat-link", { hasText: "Need your response" }).click();
  await page.locator(`#attention-${MW}-questions .attention-item`).first().waitFor();
  await until("header link focuses the Questions group", async () => page.evaluate((id) => document.activeElement?.closest(`#${id}`) != null, `attention-${MW}-questions`), 5000);
  // The jump is one-shot: the parameter is dropped, and a reload starts at the top.
  await until("attention parameter dropped", async () => !(await page.evaluate(() => location.hash)).includes("attention="), 5000);
  // A link to a record far down scrolls to it; reloading that address starts at the top (record still open).
  const deep = (await openQuestions(MW, "questions")).at(-1)!.id;
  await page.goto(`${BASE}/#/p/${MW}?record=${deep}`);
  const deepRow = page.locator(`[data-record-id="${deep}"]`).first();
  await deepRow.locator('.record-toggle[aria-expanded="true"]').waitFor();
  await until("link scrolls to the record", async () => (await page.evaluate(() => window.scrollY)) > 200, 5000);
  await page.reload();
  await deepRow.locator('.record-toggle[aria-expanded="true"]').waitFor();
  await page.waitForTimeout(1500);
  const afterReload = await page.evaluate(() => window.scrollY);
  expect(afterReload === 0, `reload must start at the top (was at ${afterReload})`);
  await page.goto(`${BASE}/#/p/${MW}/game-developer`);
  await page.locator("a.stat-link", { hasText: "Need your response" }).click();
  await page.locator(`#attention-${MW}-questions .attention-item`).first().waitFor();
  // Back to top after scrolling far.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole("button", { name: "Back to top" }).click();
  await until("scrolled to top", async () => (await page.evaluate(() => window.scrollY)) === 0, 5000);
  expect(await page.evaluate(() => document.activeElement?.tagName === "H1"), "focus moves to the page heading");
  log(`counts ${JSON.stringify(att.counts)}; marked ${rid} read; Show all; header link; back to top`);
});

// #16 — daily Yes / No: default in effect untouched, tap saves at once, agents read it.
await walk(16, "Daily Yes / No: default without answering, one tap saves, API value follows", async (log) => {
  const pid = "cards-only";
  const dir = path.join(projDir(pid), "sections", "e2e-tonight");
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "section.json"), JSON.stringify({ schemaVersion: 1, id: "e2e-tonight", displayType: "expandable-card", title: "Available tonight? (synthetic)", order: 0, defaultOpen: true,
    fields: [{ id: "answer", label: "Available tonight?", type: "yes-no", editableBy: ["user"] }] }, null, 2));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "templates", "tonight.json"), JSON.stringify({ schemaVersion: 1, id: "e2e-tonight", title: "Available tonight?", state: "active",
    schedule: { frequency: "daily", time: "00:00", timezone: "UTC", startDate: today }, record: { recordType: "generic", title: "Available tonight? {date}", status: "open", fields: { answer: true } } }, null, 2));
  await until("template indexed", async () => (await api<{ templates: { id: string }[] }>(`/api/projects/${pid}/templates`)).templates.some((t) => t.id === "e2e-tonight"));
  const cur0 = await api<{ date: string; recordExists: boolean; fields: Record<string, unknown> }>(`/api/projects/${pid}/templates/e2e-tonight/current`);
  expect(cur0.date === today && cur0.fields.answer === true, `default before the record exists: ${JSON.stringify(cur0)}`);
  await runRecurrence(store, pid, new Date());
  const rid = `e2e-tonight-${today}`;
  await page.goto(`${BASE}/#/p/${pid}`);
  const row = page.locator(`[data-record-id="${rid}"]`);
  await row.waitFor({ timeout: 15_000 });
  const yes = row.locator(".record-yes-no").getByRole("button", { name: "Yes" });
  const no = row.locator(".record-yes-no").getByRole("button", { name: "No" });
  expect((await yes.getAttribute("aria-pressed")) === "true", "Yes pressed by default");
  expect((await page.locator('button:has-text("Submit")').count()) === 0 || (await row.getByRole("button", { name: /Submit/ }).count()) === 0, "no submit for a yes-no item");
  await no.click();
  const file = path.join(dir, "records", `${rid}.json`);
  await until("No saved to the day's record", async () => readJson<{ fields?: Record<string, unknown> }>(file).fields?.answer === false);
  await until("API returns no", async () => (await api<{ fields: Record<string, unknown> }>(`/api/projects/${pid}/templates/e2e-tonight/current`)).fields.answer === false);
  await page.reload();
  await row.waitFor();
  expect((await no.getAttribute("aria-pressed")) === "true", "No still pressed after reload");
  expect(readJson<{ record: { fields: Record<string, unknown> } }>(path.join(dir, "templates", "tonight.json")).record.fields.answer === true, "default unchanged");
  await row.scrollIntoViewIfNeeded();
  await shot(page, "desktop-daily-yes-no");
  log(`${rid}: default yes, tapped no, saved and read back`);
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
