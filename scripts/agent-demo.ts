/**
 * End-to-end demonstration of the agent tools on the fictional example project `lantern-web-app`:
 *   1. an agent publishes two questions with the CLI (scoped token),
 *   2. the user answers one with a file upload and the other through the Excel export/import route,
 *   3. the agent finds the pending answers by task id without reading the inbox,
 *   4. claims, processes and completes them (a second claim finds nothing: no duplicates),
 *   5. publishes task progress, an issue with evidence, a review finding, an activity event and project progress,
 *   6. after a server restart the API (and, when a browser is available, the UI) shows the right states.
 * Runs on a temporary copy of examples/; tokens are generated into temp files and never printed.
 *   npx tsx scripts/agent-demo.ts            (npm run build first for the browser check)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import ExcelJS from "exceljs";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { tokenSha256 } from "../src/server/auth.js";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "agent-kit", "cli", "apd.mjs");
const PROJECT = "lantern-web-app";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const steps: { step: string; ok: boolean; detail?: unknown }[] = [];
function check(step: string, ok: boolean, detail?: unknown): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "apd-demo-"));
const dataRoot = path.join(work, "data");
fs.cpSync(path.join(REPO, "examples"), dataRoot, { recursive: true });
const secrets = path.join(work, "secrets");
fs.mkdirSync(secrets);
const operatorToken = crypto.randomBytes(24).toString("base64url");
const agentToken = crypto.randomBytes(24).toString("base64url");
fs.writeFileSync(path.join(secrets, "operator.txt"), operatorToken, { mode: 0o600 });
fs.writeFileSync(path.join(secrets, "agent.txt"), agentToken, { mode: 0o600 });
fs.writeFileSync(path.join(secrets, "agent-tokens.json"), JSON.stringify({
  schemaVersion: 1,
  tokens: [{ name: "lantern-agent", sha256: tokenSha256(agentToken), projects: [PROJECT], scopes: ["read", "publish", "consume"] }],
}));
const webRoot = fs.existsSync(path.join(REPO, "dist", "web", "index.html")) ? path.join(REPO, "dist", "web") : undefined;

async function start(port = 0) {
  const cfg = loadConfig({
    dataRoot, webRoot, logLevel: "silent", reconcileSeconds: 0,
    auth: { mode: "token", tokenFile: path.join(secrets, "operator.txt") },
    agentTokensFile: path.join(secrets, "agent-tokens.json"),
  } as never);
  const h = await buildApp(cfg, { logger: false });
  h.store.startWatching();
  await h.app.listen({ port, host: "127.0.0.1" });
  return { ...h, port: (h.app.server.address() as { port: number }).port };
}

let srv = await start();
const base = () => `http://127.0.0.1:${srv.port}`;
const agentDir = path.join(work, "agent");
fs.mkdirSync(agentDir);

function apd(args: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  const env = {
    PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    APD_URL: base(), APD_PROJECT: PROJECT, APD_TOKEN_FILE: path.join(secrets, "agent.txt"), APD_OWNER: "lantern-agent", APD_RETRIES: "1",
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: agentDir, env, timeout: 30000 }, (e, stdout, stderr) => {
      const text = (e ? stderr : stdout).trim().split("\n").pop() ?? "";
      let out: Record<string, unknown> = {};
      try { out = JSON.parse(text); } catch { out = { raw: text }; }
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out });
    });
  });
}

/** The user's side: the same HTTP calls the dashboard UI makes, signed in with the operator token. */
async function user(method: string, url: string, body?: unknown, form?: FormData): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${operatorToken}`, "X-PCC-Request": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(base() + url, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
}
const P = `/api/projects/${PROJECT}`;

try {
  // 1. Agent publishes two questions linked to an existing task.
  const cap = await apd(["capabilities"]);
  check("agent discovers the project and its publishable sections", cap.code === 0 && (cap.out.publishing as { sections: unknown[] }).sections.length === 4,
    (cap.out.publishing as { sections: { id: string }[] }).sections.map((s) => s.id));
  const q1 = await apd(["ask", "--section", "questions", "--id", "LNT-Q-DEMO-1", "--json", JSON.stringify({
    title: "Attach a screenshot of the sync settings you expect", taskId: "LNT-TASK-001", notifyUser: true,
    answerSchema: { type: "file-upload", maxFiles: 2, allowedMimeTypes: ["image/png", "image/jpeg"], allowComment: true },
  })]);
  const q2 = await apd(["ask", "--section", "questions", "--id", "LNT-Q-DEMO-2", "--json", JSON.stringify({
    title: "Which conflict rule should sync use?", taskId: "LNT-TASK-001",
    answerSchema: { type: "single-choice", options: [{ id: "last-write", label: "Last write wins" }, { id: "keep-both", label: "Keep both copies" }], allowExplanation: true },
  })]);
  check("agent publishes a file-upload and a choice question", q1.code === 0 && q2.code === 0, [q1.out.recordId, q2.out.recordId]);
  const before = await apd(["pending", "--task", "LNT-TASK-001", "--count"]);
  check("nothing pending before the user answers", before.code === 0 && before.out.count === 0);

  // 2a. User answers question 1 with an uploaded file.
  const form = new FormData();
  form.append("questionId", "LNT-Q-DEMO-1");
  form.append("file", new Blob([PNG], { type: "image/png" }), "sync-settings.png");
  const up = await user("POST", `${P}/uploads`, undefined, form);
  const uploadId = ((await up.json()) as { attachments: { attachmentId: string }[] }).attachments[0].attachmentId;
  const a1 = await user("POST", `${P}/questions/LNT-Q-DEMO-1/answers`, {
    questionRevision: 1, idempotencyKey: "demo-answer-1-key", answers: [{ fieldId: "response", kind: "files", attachmentIds: [uploadId], comment: "Like this" }],
  });
  check("user answers with a file upload", a1.status === 201, a1.status === 201 ? undefined : await a1.text());

  // 2b. User answers question 2 in Excel: export, fill in, preview, commit.
  const xr = await user("POST", `${P}/export/xlsx`, { questionIds: ["LNT-Q-DEMO-2"] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xr.arrayBuffer()) as never);
  const ws = wb.getWorksheet("Answers")!;
  for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(2).value === "LNT-Q-DEMO-2") ws.getRow(r).getCell(12).value = "Keep both copies";
  const filled = Buffer.from(await wb.xlsx.writeBuffer());
  const pf = new FormData();
  pf.append("file", new Blob([filled]), "answers.xlsx");
  const preview = (await (await user("POST", `${P}/import/xlsx/preview`, undefined, pf)).json()) as { previewId: string; rows: { questionId: string; status: string }[] };
  const commit = (await (await user("POST", `${P}/import/xlsx/commit`, { previewId: preview.previewId, questionIds: ["LNT-Q-DEMO-2"] })).json()) as { results: { ok: boolean }[] };
  check("user answers the choice question through Excel export/import", commit.results?.[0]?.ok === true, preview.rows?.map((r) => `${r.questionId}:${r.status}`));

  // 3. Agent finds pending answers for its task by id only.
  const pend = await apd(["pending", "--task", "LNT-TASK-001"]);
  const items = (pend.out.items ?? []) as { answerId: string; questionId: string }[];
  check("agent lists exactly the two pending answers for its task (ids only)", items.length === 2 && items.every((i) => Object.keys(i).length <= 5), items.map((i) => i.questionId));

  // 4. Agent claims and processes each; a further claim finds nothing.
  for (const it of items) {
    const c = await apd(["claim", it.answerId, "--lease", "300"]);
    const env = c.out.answer as { answers: { kind: string; attachmentIds?: string[]; optionIds?: string[] }[]; source: string };
    let note = "";
    if (env.answers[0].kind === "files") {
      const d = await apd(["download", env.answers[0].attachmentIds![0], "--out", "evidence/sync-settings.png"]);
      note = `received screenshot (${d.out.bytes} bytes)`;
    } else note = `conflict rule: ${env.answers[0].optionIds?.join(",")} (via ${env.source})`;
    const done = await apd(["complete", it.answerId, "--note", note]);
    check(`agent claims and completes ${it.questionId}`, c.code === 0 && done.code === 0 && (done.out as { processingState: string }).processingState === "processed", note);
    await apd(["update", it.questionId, "--status", "processed"]);
  }
  const again = await apd(["claim"]);
  check("a second claim finds nothing (no duplicate processing)", again.code === 0 && again.out.claimed === false);

  // 5. Agent reports progress, an issue with evidence, a review finding, an activity event and project progress.
  const upd = await apd(["update", "LNT-TASK-001", "--status", "in-testing", "--percent", "85", "--note", "Sync conflict rule implemented: keep both copies", "--by", "lantern-agent"]);
  const ev = path.join(agentDir, "trace.txt");
  fs.writeFileSync(ev, "Repro: edit the same note on two devices offline, reconnect. Last keystroke lost on device B.\n");
  const evUp = await apd(["upload", ev]);
  const evId = (evUp.out.attachments as { attachmentId: string }[])[0].attachmentId;
  const issue = await apd(["publish", "--section", "issues", "--id", "LNT-ISS-DEMO", "--json", JSON.stringify({
    recordType: "issue", title: "Autosave loses the last keystroke after a sync conflict", status: "open", severity: "major", priority: "high",
    summary: "Reproducible 3/3 on the conflict path; fix not yet verified.", notifyUser: true, attachments: [{ uploadId: evId, title: "Repro trace" }], linkedRecords: ["LNT-TASK-001"],
  })]);
  const review = await apd(["publish", "--section", "reviews", "--id", "LNT-REV-DEMO", "--json", JSON.stringify({
    recordType: "review", title: "Review: sync conflict handling", status: "changes-requested", summary: "1 finding: merge keeps stale cursor position.",
    bodyMarkdown: "**Finding (medium):** after *keep both*, the editor cursor stays in the discarded copy.\n\nEvidence: unit test `sync.cursor` fails.",
  })]);
  const event = await apd(["event", "LNT-EV-DEMO", "--action", "test", "--summary", "Sync tests: 41 passed, 1 failed (sync.cursor)", "--status", "warning", "--record", "LNT-TASK-001", "--source", "lantern-agent"]);
  const prog = await apd(["progress", "--json", JSON.stringify({ overallPercent: 62, label: "Release 1.0 readiness", method: "Share of release checklist items done" })]);
  check("agent publishes task progress, issue with evidence, review finding, event and progress",
    [upd, issue, review, event, prog].every((r) => r.code === 0), [upd, issue, review, event, prog].map((r) => r.code));

  // 6. Restart and verify what the dashboard shows.
  const port = srv.port;
  await srv.app.close();
  srv = await start(port);
  const get = async <T>(url: string) => (await (await user("GET", url)).json()) as T;
  const d1 = await get<{ question: { uiState: string } }>(`${P}/records/LNT-Q-DEMO-1`);
  const d2 = await get<{ question: { uiState: string }; submittedAnswer: { source: string } }>(`${P}/records/LNT-Q-DEMO-2`);
  check("after restart: both questions show Processed", d1.question.uiState === "processed" && d2.question.uiState === "processed", [d1.question.uiState, d2.question.uiState, d2.submittedAnswer.source]);
  const processed = await get<{ items: unknown[] }>(`${P}/queue?state=processed`);
  const pendingNow = await get<{ items: unknown[] }>(`${P}/queue?state=pending`);
  check("after restart: queue holds 2 processed, 0 pending answers", processed.items.length === 2 && pendingNow.items.length === 0);
  const iss = await get<{ status: string; attachments: { available: boolean; title: string }[] }>(`${P}/records/LNT-ISS-DEMO`);
  check("after restart: issue is open with its evidence file available", iss.status === "open" && iss.attachments[0]?.available === true, iss.attachments.map((a) => a.title));
  const task = await get<{ status: string; percent: number; history: { text: string }[] }>(`${P}/records/LNT-TASK-001`);
  check("after restart: task shows in-testing at 85% with the agent's note", task.status === "in-testing" && task.percent === 85 && task.history.some((h) => h.text.startsWith("Sync conflict rule")));
  const pr = await get<{ overallPercent: number }>(`${P}/progress`);
  const act = await get<{ items: { id: string }[] }>(`${P}/activity?limit=5`);
  check("after restart: project progress 62% and the activity event is listed", pr.overallPercent === 62 && act.items[0]?.id === "LNT-EV-DEMO");
  const card = await get<{ projects: { id: string; awaitingResponse: number }[] }>("/api/projects");
  check("answered questions are not counted as awaiting response", card.projects.find((p) => p.id === PROJECT)!.awaitingResponse === 3, card.projects.find((p) => p.id === PROJECT)!.awaitingResponse);

  // Browser check of the same states (optional: needs `npm run build` and a Chromium-based browser).
  if (webRoot) {
    try {
      const { chromium } = await import("playwright-core");
      const channel = process.env.E2E_BROWSER_PATH ? undefined : (process.env.E2E_BROWSER_CHANNEL || "msedge");
      const browser = await chromium.launch({ headless: true, channel, executablePath: process.env.E2E_BROWSER_PATH || undefined });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${base()}/`);
      await page.locator('input[type="password"]').fill(operatorToken);
      await page.keyboard.press("Enter");
      await page.goto(`${base()}/#/p/${PROJECT}/build/quality?record=LNT-ISS-DEMO`);
      await page.getByText("Autosave loses the last keystroke after a sync conflict").first().waitFor({ timeout: 15000 });
      await page.getByText("Repro trace").first().waitFor({ timeout: 15000 });
      await page.goto(`${base()}/#/p/${PROJECT}/build/planning?record=LNT-Q-DEMO-2`);
      await page.getByText("Which conflict rule should sync use?").first().waitFor({ timeout: 15000 });
      await page.getByText(/Processed/).first().waitFor({ timeout: 15000 });
      const shot = path.join(work, "agent-demo.png");
      await page.screenshot({ path: shot });
      await browser.close();
      check("browser shows the published issue with evidence and the processed question", true, path.basename(shot));
    } catch (e) {
      check("browser check", false, (e as Error).message.split("\n")[0]);
    }
  } else {
    console.log("SKIP  browser check (run npm run build first)");
  }
} finally {
  await srv.app.close();
}

const failed = steps.filter((s) => !s.ok);
fs.writeFileSync(path.join(work, "agent-demo-results.json"), JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
console.log(`\n${steps.length - failed.length}/${steps.length} checks passed. Data and results: ${work}`);
process.exitCode = failed.length ? 1 : 0;
