import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { makeApp, makeDataRoot, multipartBody, PNG_1x1, POST_HEADERS, question, writeJson } from "./helpers.js";
import { safeResolve } from "../src/server/fsutil.js";
import { claimNext, completeAnswer, failAnswer, recoverExpiredLeases } from "../src/server/answers.js";
import type { ImportPreview, NavigationResponse, ProjectsResponse, RecordDetail, RecordPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });
async function setup(extra: Record<string, unknown> = {}) {
  const root = makeDataRoot();
  const h = await makeApp(root, extra);
  apps.push(h);
  const get = async <T>(url: string) => { const r = await h.app.inject({ method: "GET", url }); return { status: r.statusCode, body: r.json() as T }; };
  const post = async <T>(url: string, body: unknown, headers: Record<string, string> = POST_HEADERS) => {
    const r = await h.app.inject({ method: "POST", url, payload: JSON.stringify(body), headers });
    return { status: r.statusCode, body: (r.body ? (r.headers["content-type"]?.toString().includes("json") ? r.json() : r.rawPayload) : null) as T, raw: r };
  };
  return { root, ...h, get, post };
}
const choice = (fieldId: string, optionIds: string[], extra: Record<string, unknown> = {}) => ({ fieldId, kind: "choice", optionIds, ...extra });
let keyN = 0;
const key = () => `testkey${Date.now()}${keyN++}`;

describe("discovery and navigation", () => {
  it("lists valid projects, reports broken ones and counts per project", async () => {
    const t = await setup();
    const { body } = await t.get<ProjectsResponse>("/api/projects");
    const ids = body.projects.map((p) => p.id);
    expect(ids).toEqual(["alpha", "beta", "broken"]);
    const alpha = body.projects.find((p) => p.id === "alpha")!;
    expect(alpha.progress.overallPercent).toBe(40);
    expect(alpha.awaitingResponse).toBe(9); // Q1-5, QTEXT, QAPP, QFILE, QCOMP (QINFO is informational)
    expect(alpha.unreadUpdates).toBe(3); // T1 notifyUser + 2 activity events
    expect(alpha.blocked).toBe(1);
    const beta = body.projects.find((p) => p.id === "beta")!;
    expect(beta.progress.overallPercent).toBeNull();
    expect(beta.awaitingResponse).toBe(1);
    const broken = body.projects.find((p) => p.id === "broken")!;
    expect(broken.available).toBe(false);
    expect(broken.unavailableReason).toMatch(/project.json/);
    expect(body.diagnosticsCount).toBeGreaterThan(0);
  });

  it("builds navigation from manifests, ignores invalid sections and plain folders", async () => {
    const t = await setup();
    const { body } = await t.get<NavigationResponse>("/api/projects/alpha/navigation");
    expect(body.rootChildType).toBe("main-tab");
    expect(body.nodes.map((n) => n.title)).toEqual(["Developer Area"]);
    expect(body.nodes[0].children.map((c) => c.title)).toEqual(["Desk", "Work"]);
    expect(body.nodes[0].children[0].children[0].counts.awaitingResponse).toBe(9);
    const diags = (await t.get<{ diagnostics: { path?: string; message: string }[] }>("/api/diagnostics")).body.diagnostics;
    expect(diags.some((d) => d.path?.includes("weird") && /invalid/.test(d.message))).toBe(true);
    expect(diags.some((d) => d.path?.endsWith("bad.json"))).toBe(true);
    const beta = (await t.get<NavigationResponse>("/api/projects/beta/navigation")).body;
    expect(beta.rootChildType).toBe("expandable-card");
  });

  it("rejects mixed child types and nesting cards in cards", async () => {
    const root = makeDataRoot();
    const s = path.join(root, "projects", "beta", "sections");
    writeJson(path.join(s, "tab", "section.json"), { schemaVersion: 1, id: "tab", displayType: "page-tab", title: "Tab", order: 999 });
    writeJson(path.join(s, "backlog", "inner", "section.json"), { schemaVersion: 1, id: "inner", displayType: "expandable-card", title: "Inner" });
    const h = await makeApp(root); apps.push(h);
    const nav = (await h.app.inject("/api/projects/beta/navigation")).json() as NavigationResponse;
    expect(nav.nodes.map((n) => n.id)).toEqual(["backlog"]);
    const d = h.store.diagnostics().map((x) => x.message).join("\n");
    expect(d).toMatch(/mixed child types/);
    expect(d).toMatch(/cannot contain sections/);
  });

  it("detects duplicate project and record ids", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "zeta", "project.json"), { schemaVersion: 1, id: "alpha", displayName: "Dup" });
    writeJson(path.join(root, "projects", "beta", "sections", "backlog", "records", "dup.json"), question("Q1"));
    const h = await makeApp(root); apps.push(h);
    const msgs = h.store.diagnostics().map((d) => d.message).join("\n");
    expect(msgs).toMatch(/duplicate project id 'alpha'/);
    expect(msgs).toMatch(/duplicate record id 'Q1'/);
  });
});

describe("records", () => {
  it("paginates summaries and filters by status/ui state and text", async () => {
    const t = await setup();
    const p1 = (await t.get<RecordPage>("/api/projects/alpha/sections/qs/records?limit=4&sort=title")).body;
    expect(p1.items).toHaveLength(4);
    expect(p1.total).toBe(10);
    expect(p1.nextCursor).toBeTruthy();
    expect((p1.items[0] as unknown as Record<string, unknown>).bodyMarkdown).toBeUndefined();
    const p2 = (await t.get<RecordPage>(`/api/projects/alpha/sections/qs/records?limit=4&sort=title&cursor=${p1.nextCursor}`)).body;
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    const info = (await t.get<RecordPage>("/api/projects/alpha/sections/qs/records?status=informational")).body;
    expect(info.items.map((i) => i.id)).toEqual(["QINFO"]);
    const text = (await t.get<RecordPage>("/api/projects/alpha/sections/qs/records?q=qapp")).body;
    expect(text.items.map((i) => i.id)).toEqual(["QAPP"]);
    const dev = (await t.get<RecordPage>("/api/projects/alpha/sections/dev/records?limit=100")).body;
    expect(dev.total).toBe(12);
  });

  it("returns full detail with attachment availability only on demand", async () => {
    const t = await setup();
    const d = (await t.get<RecordDetail>("/api/projects/alpha/records/T1")).body;
    expect(d.attachments.find((a) => a.id === "ATT-1")!.available).toBe(true);
    expect(d.attachments.find((a) => a.id === "ATT-GONE")!.available).toBe(false);
    const dl = await t.app.inject("/api/projects/alpha/attachments/ATT-1");
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/attachment; filename="adr-1.md"/);
    expect((await t.app.inject("/api/projects/alpha/attachments/ATT-DOC")).statusCode).toBe(200);
    expect((await t.app.inject("/api/projects/alpha/attachments/ATT-GONE")).statusCode).toBe(404);
  });

  it("isolates projects: ids from one project do not resolve in another", async () => {
    const t = await setup();
    expect((await t.get("/api/projects/beta/records/T1")).status).toBe(404);
    expect((await t.app.inject("/api/projects/beta/attachments/ATT-1")).statusCode).toBe(404);
    expect((await t.get("/api/projects/broken/navigation")).status).toBe(404);
  });
});

describe("path security", () => {
  it("rejects traversal, absolute paths and symlink escapes", () => {
    const root = makeDataRoot();
    const proj = path.join(root, "projects", "alpha");
    expect(() => safeResolve(proj, "../beta/project.json")).toThrow();
    expect(() => safeResolve(proj, "C:/Windows/win.ini")).toThrow();
    expect(() => safeResolve(proj, "/etc/passwd")).toThrow();
    expect(() => safeResolve(proj, "a/../../x")).toThrow();
    const link = path.join(proj, "attachments", "escape");
    try {
      fs.symlinkSync(path.join(root, "projects", "beta"), link, "junction");
      expect(() => safeResolve(proj, "attachments/escape/project.json")).toThrow(/symlink/);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    }
  });

  it("rejects attachment paths escaping via record JSON and project.json roots", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "beta", "sections", "backlog", "records", "evil.json"), {
      schemaVersion: 1, id: "EVIL", recordType: "document", title: "x", status: "active", updatedAt: "2026-11-01T00:00:00Z",
      attachments: [{ id: "ESC", path: "../../alpha/progress.json" }],
    });
    writeJson(path.join(root, "projects", "gamma", "project.json"), { schemaVersion: 1, id: "gamma", displayName: "G", artifactRoots: ["../alpha"] });
    const h = await makeApp(root); apps.push(h);
    expect((await h.app.inject("/api/projects/beta/attachments/ESC")).statusCode).toBe(404);
    expect(h.store.diagnostics().some((d) => /evil.json/.test(d.path ?? "") && /\.\./.test(d.message))).toBe(true);
    expect(h.store.broken.some((b) => b.key === "gamma")).toBe(true);
  });
});

describe("answers and queue", () => {
  it("validates and enqueues one canonical answer; replay is idempotent; duplicates rejected", async () => {
    const t = await setup();
    const url = "/api/projects/alpha/questions/Q1/answers";
    const bad = await t.post<{ error: string; fieldErrors: unknown[] }>(url, { questionRevision: 1, answers: [choice("response", ["__other"])], idempotencyKey: key() });
    expect(bad.status).toBe(422);
    expect(bad.body.fieldErrors.length).toBeGreaterThan(0);
    const k = key();
    const ok = await t.post<{ answerId: string; replayed: boolean }>(url, { questionRevision: 1, answers: [choice("response", ["__other"], { otherText: "Snap to grid", explanation: "because" })], idempotencyKey: k });
    expect(ok.status).toBe(201);
    const replay = await t.post<{ answerId: string; replayed: boolean }>(url, { questionRevision: 1, answers: [choice("response", ["a"])], idempotencyKey: k });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.answerId).toBe(ok.body.answerId);
    const dup = await t.post<{ error: string }>(url, { questionRevision: 1, answers: [choice("response", ["a"])], idempotencyKey: key() });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("already-answered");

    const pendingDir = path.join(t.root, "projects", "alpha", "communications", "answers", "pending");
    const files = fs.readdirSync(pendingDir);
    expect(files).toEqual([`${ok.body.answerId}.json`]);
    const env = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]), "utf8"));
    expect(env).toMatchObject({ projectId: "alpha", questionId: "Q1", questionRevision: 1, source: "dashboard", processingState: "pending" });
    expect(env.answers[0]).toMatchObject({ optionIds: ["__other"], otherText: "Snap to grid" });

    const card = (await t.get<ProjectsResponse>("/api/projects")).body.projects.find((p) => p.id === "alpha")!;
    expect(card.awaitingResponse).toBe(8);
    expect(card.awaitingPickup).toBe(1);
    const det = (await t.get<RecordDetail>("/api/projects/alpha/records/Q1")).body;
    expect(det.question!.uiState).toBe("submitted");
    expect(det.submittedAnswer!.processingState).toBe("pending");

    // "Needs response" filter: the answered question drops out; the count matches the card.
    const needs = (await t.get<RecordPage>("/api/projects/alpha/sections/qs/records?status=needs-response")).body;
    expect(needs.needsResponseCount).toBe(8);
    expect(needs.total).toBe(8);
    expect(needs.items.map((r) => r.id)).not.toContain("Q1");
    expect(needs.items.map((r) => r.id)).not.toContain("QINFO");
    expect(needs.items.every((r) => r.question?.uiState === "needs-response")).toBe(true);
    const tasks = (await t.get<RecordPage>("/api/projects/alpha/sections/tasks/records?status=all")).body;
    expect(tasks.needsResponseCount).toBeUndefined();
  });

  it("rejects stale revisions and non-answerable questions", async () => {
    const t = await setup();
    const stale = await t.post<{ error: string }>("/api/projects/alpha/questions/Q2/answers", { questionRevision: 2, answers: [choice("response", ["a"])], idempotencyKey: key() });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale-revision");
    const info = await t.post<{ error: string }>("/api/projects/alpha/questions/QINFO/answers", { questionRevision: 1, answers: [], idempotencyKey: key() });
    expect(info.status).toBe(409);
  });

  it("validates free text, approval and composite answers", async () => {
    const t = await setup();
    const u = (q: string) => `/api/projects/alpha/questions/${q}/answers`;
    expect((await t.post(u("QTEXT"), { questionRevision: 1, answers: [{ fieldId: "response", kind: "text", text: "x".repeat(201) }], idempotencyKey: key() })).status).toBe(422);
    expect((await t.post(u("QTEXT"), { questionRevision: 1, answers: [{ fieldId: "response", kind: "text", text: "Fine" }], idempotencyKey: key() })).status).toBe(201);
    expect((await t.post(u("QAPP"), { questionRevision: 1, answers: [{ fieldId: "response", kind: "approval", decision: "reject" }], idempotencyKey: key() })).status).toBe(422);
    expect((await t.post(u("QAPP"), { questionRevision: 1, answers: [{ fieldId: "response", kind: "approval", decision: "reject", rationale: "too dark" }], idempotencyKey: key() })).status).toBe(201);
    expect((await t.post(u("QCOMP"), { questionRevision: 1, answers: [{ fieldId: "why", kind: "text", text: "no choice" }], idempotencyKey: key() })).status).toBe(422);
    expect((await t.post(u("QCOMP"), { questionRevision: 1, answers: [choice("choice", ["y"]), { fieldId: "why", kind: "text", text: "Y reads better" }], idempotencyKey: key() })).status).toBe(201);
  });

  it("handles concurrent submissions for one question without duplicates", async () => {
    const t = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      t.post("/api/projects/alpha/questions/Q3/answers", { questionRevision: 1, answers: [choice("response", ["b"])], idempotencyKey: key() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    expect(fs.readdirSync(path.join(t.root, "projects", "alpha", "communications", "answers", "pending"))).toHaveLength(1);
  });

  it("concurrent submissions for different questions all succeed", async () => {
    const t = await setup();
    const ids = ["Q1", "Q2", "Q3", "Q4", "Q5"];
    const res = await Promise.all(ids.map((q) => t.post(`/api/projects/alpha/questions/${q}/answers`, { questionRevision: 1, answers: [choice("response", ["a"])], idempotencyKey: key() })));
    expect(res.every((r) => r.status === 201)).toBe(true);
  });

  it("queue: claim → complete, fail → retry, expired lease recovery, one claimer wins", async () => {
    const t = await setup();
    for (const q of ["Q1", "Q2", "Q3"]) await t.post(`/api/projects/alpha/questions/${q}/answers`, { questionRevision: 1, answers: [choice("response", ["a"])], idempotencyKey: key() });
    const p = t.store.get("alpha")!;
    const [c1, c2] = await Promise.all([claimNext(t.store, p, "worker-1"), claimNext(t.store, p, "worker-2")]);
    expect(c1 && c2 && c1.answerId !== c2.answerId).toBe(true);
    await expect(completeAnswer(t.store, p, c1!.answerId, "worker-2")).rejects.toThrow(/not leased/);
    const done = await completeAnswer(t.store, p, c1!.answerId, "worker-1", "applied");
    expect(done.processingState).toBe("processed");
    const retried = await failAnswer(t.store, p, c2!.answerId, "worker-2", "editor busy", true);
    expect(retried.processingState).toBe("pending");
    const c3 = await claimNext(t.store, p, "worker-3", 10);
    expect(c3).toBeTruthy();
    const recovered = await recoverExpiredLeases(t.store, p, new Date(Date.now() + 60_000));
    expect(recovered).toContain(c3!.answerId);
    const det = (await t.get<RecordDetail>(`/api/projects/alpha/records/${done.questionId}`)).body;
    expect(det.question!.uiState).toBe("processed");
    // A failed (non-retryable) answer lets the user answer again.
    const c4 = await claimNext(t.store, p, "w4");
    await failAnswer(t.store, p, c4!.answerId, "w4", "unusable", false);
    const again = await t.post(`/api/projects/alpha/questions/${c4!.questionId}/answers`, { questionRevision: 1, answers: [choice("response", ["b"])], idempotencyKey: key() });
    expect(again.status).toBe(201);
  });

  it("queue HTTP API claims and reports empty queue with 204", async () => {
    const t = await setup();
    expect((await t.post("/api/projects/alpha/queue/claim", { owner: "agent" })).status).toBe(204);
  });
});

describe("uploads and downloads", () => {
  it("accepts allowed files, rejects disguised ones, links uploads to answers", async () => {
    const t = await setup();
    const good = multipartBody([{ name: "questionId", value: "QFILE" }, { name: "file", filename: "art.png", content: PNG_1x1, type: "image/png" }]);
    const up = await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", payload: good.payload, headers: good.headers });
    expect(up.statusCode).toBe(201);
    const attId = up.json().attachments[0].attachmentId;
    const fake = multipartBody([{ name: "file", filename: "evil.png", content: Buffer.from("<script>"), type: "image/png" }]);
    expect((await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", payload: fake.payload, headers: fake.headers })).statusCode).toBe(422);
    const exe = multipartBody([{ name: "file", filename: "run.exe", content: Buffer.from("MZ") }]);
    expect((await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", payload: exe.payload, headers: exe.headers })).statusCode).toBe(422);

    const sub = await t.post<{ answerId: string }>("/api/projects/alpha/questions/QFILE/answers", { questionRevision: 1, answers: [{ fieldId: "response", kind: "files", attachmentIds: [attId], comment: "first sketch" }], idempotencyKey: key() });
    expect(sub.status).toBe(201);
    const env = JSON.parse(fs.readFileSync(path.join(t.root, "projects", "alpha", "communications", "answers", "pending", `${sub.body.answerId}.json`), "utf8"));
    expect(env.attachments).toEqual([attId]);
    expect(JSON.stringify(env)).not.toMatch(/iVBOR/); // no base64 payloads
    // Upload cannot be reused by another answer.
    const reuse = await t.post("/api/projects/alpha/questions/QCOMP/answers", { questionRevision: 1, answers: [choice("choice", ["x"]), { fieldId: "art", kind: "files", attachmentIds: [attId] }], idempotencyKey: key() });
    expect(reuse.status).toBe(422);
    const dl = await t.app.inject(`/api/projects/alpha/attachments/${attId}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("image/png");
  });

  it("enforces upload size limits", async () => {
    const t = await setup({ uploads: { maxBytes: 2048, maxFiles: 3 } });
    const big = multipartBody([{ name: "file", filename: "big.txt", content: Buffer.alloc(5000, 65) }]);
    const r = await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", payload: big.payload, headers: big.headers });
    expect(r.statusCode).toBe(422);
    expect(fs.readdirSync(path.join(t.root, "projects", "alpha", "attachments", "answers")).filter((f) => !f.endsWith(".meta.json"))).toHaveLength(0);
  });

  it("zip preflight reports missing files and zip contains files + manifest", async () => {
    const t = await setup();
    const pre = await t.post<{ available: unknown[]; missing: { attachmentId: string }[] }>("/api/projects/alpha/download/zip/preflight", { recordIds: ["T1", "T2"] });
    expect(pre.body.available).toHaveLength(2);
    expect(pre.body.missing.map((m) => m.attachmentId)).toEqual(["ATT-GONE"]);
    const r = await t.app.inject({ method: "POST", url: "/api/projects/alpha/download/zip", payload: JSON.stringify({ recordIds: ["T1", "T2"] }), headers: POST_HEADERS });
    expect(r.statusCode).toBe(200);
    const names = await zipNames(r.rawPayload);
    expect(names.sort()).toEqual(["T1/adr-1.md", "T2/ADR-2.md", "manifest.json"]);
  });
});

describe("read state", () => {
  it("marks records and activity read explicitly; record becomes unread again when updated", async () => {
    const t = await setup();
    const unread = async () => (await t.get<ProjectsResponse>("/api/projects")).body.projects.find((p) => p.id === "alpha")!.unreadUpdates;
    expect(await unread()).toBe(3);
    await t.get("/api/projects/alpha/navigation");
    expect(await unread()).toBe(3); // opening does not mark read
    await t.post("/api/projects/alpha/records/mark-read", { recordIds: ["T1"] });
    expect(await unread()).toBe(2);
    await t.post("/api/projects/alpha/records/mark-read", { allActivity: true });
    expect(await unread()).toBe(0);
    const p = t.store.get("alpha")!;
    const file = p.records.get("T1")!.file;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.updatedAt = "2026-11-05T10:00:00Z";
    fs.writeFileSync(file, JSON.stringify(rec));
    await t.store.applyChanges(p.dir, [path.relative(p.dir, file).replace(/\\/g, "/")]);
    expect(await unread()).toBe(1);
    expect(fs.existsSync(path.join(p.dir, "user-state", "operator.json"))).toBe(true);
  });
});

describe("excel round trip", () => {
  it("exports a real workbook, imports edits with preview, rejects stale/invalid, commits idempotently", async () => {
    const t = await setup();
    const exp = await t.app.inject({ method: "POST", url: "/api/projects/alpha/export/xlsx", payload: JSON.stringify({ questionIds: ["Q1", "Q2", "Q3", "QTEXT", "QAPP", "QFILE", "Q4"] }), headers: POST_HEADERS });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Instructions", "Answers", "_meta"]);
    const ws = wb.getWorksheet("Answers")!;
    const rowOf = (qid: string) => { for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(2).value === qid) return ws.getRow(r); throw new Error(qid); };
    rowOf("Q1").getCell(12).value = "Keep upright";
    rowOf("Q1").getCell(13).value = "less floating props";
    rowOf("Q2").getCell(12).value = "Other: snap to navmesh";
    rowOf("Q3").getCell(12).value = "Nonsense option";
    rowOf("QTEXT").getCell(12).value = "Answer typed in Excel";
    rowOf("QAPP").getCell(12).value = { formula: "1+1" } as never;
    rowOf("QFILE").getCell(13).value = "see upload";
    // Q4 left blank. Make Q2 stale: revise question after export.
    const p = t.store.get("alpha")!;
    const q2file = p.records.get("Q2")!.file;
    const q2 = JSON.parse(fs.readFileSync(q2file, "utf8"));
    q2.questionRevision = 2;
    fs.writeFileSync(q2file, JSON.stringify(q2));
    await t.store.applyChanges(p.dir, [path.relative(p.dir, q2file).replace(/\\/g, "/")]);
    const edited = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = async () => {
      const mp = multipartBody([{ name: "file", filename: "answers.xlsx", content: edited }]);
      const r = await t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", payload: mp.payload, headers: mp.headers });
      expect(r.statusCode).toBe(200);
      return r.json() as ImportPreview;
    };
    const pv = await upload();
    const st = Object.fromEntries(pv.rows.map((r) => [r.questionId, r.status]));
    expect(st).toMatchObject({ Q1: "ready", Q2: "stale", Q3: "invalid", QTEXT: "ready", QAPP: "invalid", QFILE: "needs-dashboard", Q4: "blank" });
    expect(pv.rows.find((r) => r.questionId === "QAPP")!.messages.join()).toMatch(/formula/);
    expect(pv.totals.ready).toBe(2);

    const commit = await t.post<{ results: { questionId: string; ok: boolean; answerId?: string }[] }>("/api/projects/alpha/import/xlsx/commit", { previewId: pv.previewId, questionIds: ["Q1", "QTEXT", "Q3"] });
    expect(commit.body.results.filter((r) => r.ok).map((r) => r.questionId).sort()).toEqual(["Q1", "QTEXT"]);
    expect(commit.body.results.find((r) => r.questionId === "Q3")!.ok).toBe(false);
    const again = await t.post<{ results: { ok: boolean; answerId?: string }[] }>("/api/projects/alpha/import/xlsx/commit", { previewId: pv.previewId, questionIds: ["Q1"] });
    expect(again.body.results[0].answerId).toBe(commit.body.results.find((r) => r.questionId === "Q1")!.answerId);
    const pv2 = await upload();
    expect(pv2.rows.find((r) => r.questionId === "Q1")!.status).toBe("already-answered");
    const pending = fs.readdirSync(path.join(p.dir, "communications", "answers", "pending"));
    expect(pending).toHaveLength(2);
    const env = JSON.parse(fs.readFileSync(path.join(p.dir, "communications", "answers", "pending", pending.find((f) => f.includes(commit.body.results[0].answerId!))!), "utf8"));
    expect(env.source).toBe("excel-import");
    expect(env.answers[0]).toMatchObject({ fieldId: "response", kind: "choice", optionIds: ["b"], explanation: "less floating props" });
  });

  it("rejects a workbook for another project and non-dashboard workbooks", async () => {
    const t = await setup();
    const exp = await t.app.inject({ method: "POST", url: "/api/projects/beta/export/xlsx", payload: JSON.stringify({ questionIds: ["Q1"] }), headers: POST_HEADERS });
    const mp = multipartBody([{ name: "file", filename: "beta.xlsx", content: exp.rawPayload }]);
    const pv = (await t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", payload: mp.payload, headers: mp.headers })).json() as ImportPreview;
    expect(pv.errors.join()).toMatch(/belongs to project 'beta'/);
    const plain = new ExcelJS.Workbook();
    plain.addWorksheet("Sheet1").addRow(["x"]);
    const mp2 = multipartBody([{ name: "file", filename: "plain.xlsx", content: Buffer.from(await plain.xlsx.writeBuffer()) }]);
    const pv2 = (await t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", payload: mp2.payload, headers: mp2.headers })).json() as ImportPreview;
    expect(pv2.errors.join()).toMatch(/not exported by the dashboard/);
    const junk = multipartBody([{ name: "file", filename: "junk.xlsx", content: Buffer.from("not a zip") }]);
    expect((await t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", payload: junk.payload, headers: junk.headers })).statusCode).toBe(400);
  });
});

describe("change propagation", () => {
  it("watcher-free reconcile picks up added projects and changed progress", async () => {
    const t = await setup();
    writeJson(path.join(t.root, "projects", "delta", "project.json"), { schemaVersion: 1, id: "delta", displayName: "Delta" });
    const prog = path.join(t.root, "projects", "alpha", "progress.json");
    writeJson(prog, { schemaVersion: 1, overallPercent: 55, updatedAt: "2026-11-03T00:00:00Z" });
    await t.store.reconcile();
    const body = (await t.get<ProjectsResponse>("/api/projects")).body;
    expect(body.projects.map((p) => p.id)).toContain("delta");
    expect(body.projects.find((p) => p.id === "alpha")!.progress.overallPercent).toBe(55);
  });

  it("file watcher reindexes a changed record and emits an invalidate event", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root, { watch: true });
    apps.push(h);
    h.store.startWatching();
    const events: { projectId: string | null; recordIds?: string[] }[] = [];
    h.store.on("invalidate", (e) => events.push(e));
    const file = path.join(root, "projects", "beta", "sections", "backlog", "records", "NEW.json");
    await new Promise((r) => setTimeout(r, 100));
    writeJson(file, question("NEW", { title: "Added later" }));
    // The record lands in the index before the event is emitted (a signature read sits in between), so wait for both.
    const named = () => events.some((e) => e.projectId === "beta" && e.recordIds?.includes("NEW"));
    for (let i = 0; i < 40 && !(h.store.get("beta")!.records.has("NEW") && named()); i++) await new Promise((r) => setTimeout(r, 50));
    expect(h.store.get("beta")!.records.get("NEW")?.title).toBe("Added later");
    expect(named()).toBe(true);
  });

  it("a projects folder created after startup gets a watcher at the next reconcile", async () => {
    const root = makeDataRoot();
    const projects = path.join(root, "projects");
    fs.renameSync(projects, path.join(root, "later"));
    const h = await makeApp(root, { watch: true });
    apps.push(h);
    h.store.startWatching();
    fs.renameSync(path.join(root, "later"), projects);
    await h.store.reconcile();
    expect(h.store.get("alpha")).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    // No reconcile from here on: only the newly attached watcher can index this project.
    writeJson(path.join(projects, "gamma", "project.json"), { schemaVersion: 1, id: "gamma", displayName: "Gamma" });
    for (let i = 0; i < 60 && !h.store.get("gamma"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(h.store.get("gamma")?.manifest.displayName).toBe("Gamma");
  });

  it("malformed JSON in one section does not affect other projects", async () => {
    const t = await setup();
    const sec = path.join(t.root, "projects", "beta", "sections", "backlog", "section.json");
    fs.writeFileSync(sec, "{ broken");
    await t.store.reconcile();
    const body = (await t.get<ProjectsResponse>("/api/projects")).body;
    expect(body.projects.find((p) => p.id === "alpha")!.available).toBe(true);
    expect((await t.get<NavigationResponse>("/api/projects/beta/navigation")).body.nodes).toHaveLength(0);
  });
});

describe("http safety", () => {
  it("requires the CSRF header and same origin on POST", async () => {
    const t = await setup();
    expect((await t.post("/api/projects/alpha/records/mark-read", {}, { "content-type": "application/json" })).status).toBe(403);
    expect((await t.post("/api/projects/alpha/records/mark-read", {}, { ...POST_HEADERS, origin: "http://evil.example", host: "127.0.0.1:8790" })).status).toBe(403);
  });

  it("token mode requires login; refuses non-loopback bind without auth", async () => {
    const root = makeDataRoot();
    const tokenFile = path.join(root, "token.txt");
    fs.writeFileSync(tokenFile, "test-token-0123456789abcdef");
    const h = await makeApp(root, { auth: { mode: "token", tokenFile } });
    apps.push(h);
    expect((await h.app.inject("/api/projects")).statusCode).toBe(401);
    const bad = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: JSON.stringify({ token: "wrong" }), headers: POST_HEADERS });
    expect(bad.statusCode).toBe(401);
    const ok = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: JSON.stringify({ token: "test-token-0123456789abcdef" }), headers: POST_HEADERS });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const sid = cookie.split(";")[0];
    expect((await h.app.inject({ url: "/api/projects", headers: { cookie: sid } })).statusCode).toBe(200);
    const { loadConfig } = await import("../src/server/config.js");
    expect(() => loadConfig({ dataRoot: root, host: "0.0.0.0" } as never)).toThrow(/Refusing to bind/);
  });
});

function zipNames(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names: string[] = [];
      zip.on("entry", (e: yauzl.Entry) => { names.push(e.fileName); zip.readEntry(); });
      zip.on("end", () => resolve(names));
      zip.readEntry();
    });
  });
}
