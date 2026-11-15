/** Answer defaults, tracked fields, comments/attachments, external references and recurring templates. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeDataRoot, multipartBody, PNG_1x1, POST_HEADERS, question, section, T0, writeJson } from "./helpers.js";
import { tokenSha256 } from "../src/server/auth.js";
import { runRecurrence } from "../src/server/recurrence.js";
import type { RecordDetail, RecordPage, TemplateSummary } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

const OPERATOR = "operator-token-0123456789abcdef";
const PUB = "agent-publish-token-0123456789";
const A = "/api/projects/alpha";

const REVIEW_FIELDS = [
  { id: "reviewed", label: "Reviewed", type: "checkbox", editableBy: ["user"], filter: true },
  { id: "decision", label: "Decision", type: "choice", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], editableBy: ["user"], filter: true },
  { id: "built", label: "Built", type: "checkbox", editableBy: ["agent"] },
  { id: "note", label: "Note", type: "text" },
  { id: "due", label: "Due", type: "date" },
];

/** alpha publishes into "tasks", "qs" and "reviews"; "reviews" has tracked fields, comments and a daily template. */
function dataRoot(): string {
  const root = makeDataRoot();
  const a = path.join(root, "projects", "alpha");
  const manifest = JSON.parse(fs.readFileSync(path.join(a, "project.json"), "utf8"));
  writeJson(path.join(a, "project.json"), { ...manifest, publishing: { enabled: true, sections: ["tasks", "qs", "reviews", "daily"] } });
  const work = path.join(a, "sections", "dev", "work");
  writeJson(path.join(work, "reviews", "section.json"), section("reviews", "expandable-card", "Reviews", { actions: ["copy", "open-detail", "comment"], fields: REVIEW_FIELDS }));
  writeJson(path.join(work, "reviews", "records", "R1.json"), { schemaVersion: 1, id: "R1", recordType: "review", title: "Review R1", status: "needs-review", updatedAt: T0 });
  writeJson(path.join(work, "reviews", "records", "R2.json"), { schemaVersion: 1, id: "R2", recordType: "review", title: "Review R2", status: "needs-review", updatedAt: T0, fields: { reviewed: true } });
  writeJson(path.join(work, "daily", "section.json"), section("daily", "expandable-card", "Daily check-in"));
  return root;
}

async function setup(opts: { root?: string; auth?: boolean } = {}) {
  const root = opts.root ?? dataRoot();
  let extra: Record<string, unknown> = {};
  if (opts.auth) {
    const tokenFile = path.join(root, "operator-token.txt");
    fs.writeFileSync(tokenFile, OPERATOR);
    const agentTokensFile = path.join(root, "agent-tokens.json");
    writeJson(agentTokensFile, { schemaVersion: 1, tokens: [{ name: "alpha-publisher", sha256: tokenSha256(PUB), projects: ["alpha"], scopes: ["read", "publish"] }] });
    extra = { auth: { mode: "token", tokenFile }, agentTokensFile };
  }
  const h = await makeApp(root, extra);
  apps.push(h);
  const call = async <T = Record<string, unknown>>(method: string, url: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = method === "GET" ? {} : { ...POST_HEADERS };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await h.app.inject({ method: method as "GET", url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, body: (r.body ? r.json() : null) as T };
  };
  return { root, ...h, call };
}

const reviewsDir = (root: string) => path.join(root, "projects", "alpha", "sections", "dev", "work", "reviews");
const dailyDir = (root: string) => path.join(root, "projects", "alpha", "sections", "dev", "work", "daily");

// ------------------------------------------------------------------ defaults --
describe("answer defaults", () => {
  const ask = (answerSchema: unknown) => ({ recordType: "question", title: "Pick", status: "open", updatedAt: T0, requiresResponse: true, questionRevision: 1, answerSchema });

  it("accepts valid defaults for single-choice, multiple-choice, approval and free-text and returns them in the detail", async () => {
    const t = await setup();
    const schemas = {
      QD1: { type: "single-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], default: "b" },
      QD2: { type: "multiple-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], maxSelected: 2, default: ["a", "c"] },
      QD3: { type: "approval", default: "approve" },
      QD4: { type: "free-text", maxLength: 50, default: "Looks fine" },
    };
    for (const [id, s] of Object.entries(schemas)) {
      const r = await t.call("PUT", `${A}/records/${id}`, { sectionId: "qs", record: ask(s) });
      expect(r.status, id).toBe(201);
    }
    const d = await t.call<RecordDetail>("GET", `${A}/records/QD2`);
    expect(d.body.answerSchema).toMatchObject({ type: "multiple-choice", default: ["a", "c"] });
  });

  it.each([
    ["unknown option", { type: "single-choice", options: [{ id: "a", label: "A" }], default: "zz" }, "unknown option 'zz'"],
    ["too many options", { type: "multiple-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], maxSelected: 1, default: ["a", "b"] }, "choose at most 1"],
    ["duplicate option", { type: "multiple-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], default: ["a", "a"] }, "duplicate option"],
    ["text too long", { type: "free-text", maxLength: 5, default: "far too long" }, "at most 5 characters"],
    ["bad approval value", { type: "approval", default: "maybe" }, 'expected one of \\"approve\\"|\\"reject\\"'],
  ])("rejects an invalid default (%s)", async (_name, schema, message) => {
    const t = await setup();
    const r = await t.call<{ error: string; message: string }>("PUT", `${A}/records/QBAD`, { sectionId: "qs", record: ask(schema) });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("validation");
    expect(JSON.stringify(r.body)).toContain(message);
  });

  it("checks defaults inside composite questions per field", async () => {
    const t = await setup();
    const schema = { type: "composite", fields: [
      { id: "style", label: "Style", type: "single-choice", options: [{ id: "x", label: "X" }], default: "x" },
      { id: "size", label: "Size", type: "single-choice", options: [{ id: "s", label: "S" }], default: "xl" },
    ] };
    const r = await t.call("PUT", `${A}/records/QCD`, { sectionId: "qs", record: ask(schema) });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("default for field 'size'");
    expect(JSON.stringify(r.body)).not.toContain("default for field 'style'");
  });

  it("a record file with an invalid default is reported and not shown", async () => {
    const root = dataRoot();
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "desk", "qs", "records", "QF.json"),
      question("QF", { answerSchema: { type: "single-choice", options: [{ id: "a", label: "A" }], default: "nope" } }));
    const t = await setup({ root });
    expect((await t.call("GET", `${A}/records/QF`)).status).toBe(404);
    const diag = await t.call<{ diagnostics: { path: string; message: string }[] }>("GET", "/api/diagnostics");
    expect(diag.body.diagnostics.some((d) => d.path.endsWith("QF.json") && d.message.includes("default for field 'response'"))).toBe(true);
  });

  it("a default is never submitted: the question still needs a response and the queue stays empty", async () => {
    const t = await setup();
    await t.call("PUT", `${A}/records/QD`, { sectionId: "qs", record: ask({ type: "approval", default: "approve" }) });
    const d = await t.call<RecordDetail>("GET", `${A}/records/QD`);
    expect(d.body.question?.uiState).toBe("needs-response");
    expect(d.body.submittedAnswer).toBeUndefined();
    const q = await t.call<{ items: unknown[] }>("GET", `${A}/queue?state=pending`);
    expect(q.body.items.filter((i) => JSON.stringify(i).includes("QD"))).toEqual([]);
  });

  it("the submitted answer is stored as given, independent of the default", async () => {
    const t = await setup();
    await t.call("PUT", `${A}/records/QS`, { sectionId: "qs", record: ask({ type: "single-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], default: "a" }) });
    const sub = await t.call<{ answerId: string }>("POST", `${A}/questions/QS/answers`, {
      questionRevision: 1, idempotencyKey: "defaults-test-1", answers: [{ fieldId: "response", kind: "choice", optionIds: ["b"] }],
    });
    expect(sub.status).toBe(201);
    const d = await t.call<RecordDetail>("GET", `${A}/records/QS`);
    expect(d.body.submittedAnswer?.answers).toEqual([{ fieldId: "response", kind: "choice", optionIds: ["b"] }]);
    expect(d.body.answerSchema).toMatchObject({ default: "a" });
  });
});

// ---------------------------------------------------------- tracked fields --
describe("tracked fields and actionable cards", () => {
  it("lists field definitions, values and filter counts, and filters by field", async () => {
    const t = await setup();
    const all = await t.call<RecordPage>("GET", `${A}/sections/reviews/records?status=all`);
    expect(all.body.fieldDefs.map((d) => d.id)).toEqual(["reviewed", "decision", "built", "note", "due"]);
    expect(all.body.fieldCounts.reviewed).toEqual({ "": 1, true: 1 });
    expect(all.body.canComment).toBe(true);
    expect(all.body.items.find((r) => r.id === "R2")!.fields).toEqual({ reviewed: true });
    const done = await t.call<RecordPage>("GET", `${A}/sections/reviews/records?status=all&field.reviewed=true`);
    expect(done.body.items.map((r) => r.id)).toEqual(["R2"]);
    const open = await t.call<RecordPage>("GET", `${A}/sections/reviews/records?status=all&field.reviewed=`);
    expect(open.body.items.map((r) => r.id)).toEqual(["R1"]);
  });

  it("the user sets independent fields; each change is recorded in the history", async () => {
    const t = await setup();
    const r = await t.call("POST", `${A}/records/R1/user-update`, { fields: { reviewed: true, decision: "reject", note: "needs tests" } });
    expect(r.status).toBe(200);
    const d = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(d.body.fields).toEqual({ reviewed: true, decision: "reject", note: "needs tests" });
    expect(d.body.status).toBe("needs-review"); // fields never change the workflow status
    expect(d.body.history.map((h) => h.text)).toEqual(["Reviewed: — → yes", "Decision: — → Reject", "Note: — → needs tests"]);
    expect(d.body.history.every((h) => h.by === "user")).toBe(true);
    // Clearing a value
    await t.call("POST", `${A}/records/R1/user-update`, { fields: { decision: null } });
    const d2 = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(d2.body.fields).toEqual({ reviewed: true, note: "needs tests" });
    expect(d2.body.history.at(-1)!.text).toBe("Decision: Reject → —");
  });

  it("rejects unknown fields, wrong types and unknown options", async () => {
    const t = await setup();
    for (const fields of [{ nope: true }, { reviewed: "yes" }, { decision: "maybe" }, { due: "2026-02-30" }]) {
      const r = await t.call<{ error: string }>("POST", `${A}/records/R1/user-update`, { fields });
      expect(r.status, JSON.stringify(fields)).toBe(422);
      expect(r.body.error).toBe("validation");
    }
    const d = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(d.body.fields).toBeUndefined();
  });

  it("enforces who may change a field: users cannot set agent fields, agents cannot set user fields", async () => {
    const t = await setup({ auth: true });
    const asUser = await t.call<{ error: string }>("POST", `${A}/records/R1/user-update`, { fields: { built: true } }, OPERATOR);
    expect(asUser.status).toBe(403);
    expect(asUser.body.error).toBe("field-not-editable");
    const asAgent = await t.call<{ error: string }>("PATCH", `${A}/records/R1`, { fields: { reviewed: true } }, PUB);
    expect(asAgent.status).toBe(403);
    const ok = await t.call("PATCH", `${A}/records/R1`, { fields: { built: true, note: "build 41 green" } }, PUB);
    expect(ok.status).toBe(200);
    const d = await t.call<RecordDetail>("GET", `${A}/records/R1`, undefined, OPERATOR);
    expect(d.body.fields).toEqual({ built: true, note: "build 41 green" });
    expect(d.body.history.map((h) => h.by)).toEqual(["alpha-publisher", "alpha-publisher"]);
  });

  it("an agent's full PUT cannot change a user-only field", async () => {
    const t = await setup({ auth: true });
    const src = await t.call<{ record: Record<string, unknown> }>("GET", `${A}/records/R2/source`, undefined, PUB);
    const changed = { ...src.body.record, fields: { reviewed: false } };
    const r = await t.call<{ error: string }>("PUT", `${A}/records/R2`, { sectionId: "reviews", record: changed }, PUB);
    expect(r.status).toBe(403);
    const keep = await t.call("PUT", `${A}/records/R2`, { sectionId: "reviews", record: { ...src.body.record, summary: "rebased" } }, PUB);
    expect(keep.status).toBe(200);
    const created = await t.call("PUT", `${A}/records/R9`, { sectionId: "reviews", record: { recordType: "review", title: "R9", status: "needs-review", updatedAt: T0, fields: { reviewed: true } } }, PUB);
    expect(created.status).toBe(403);
  });

  it("agent tokens cannot use the user route", async () => {
    const t = await setup({ auth: true });
    const r = await t.call("POST", `${A}/records/R1/user-update`, { comment: "hi" }, PUB);
    expect(r.status).toBe(403);
  });

  it("a stale revision is refused instead of overwriting a newer change", async () => {
    const t = await setup();
    const d = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(d.body.revision).toMatch(/^[a-f0-9]{16}$/);
    expect((await t.call("POST", `${A}/records/R1/user-update`, { fields: { reviewed: true }, ifRevision: d.body.revision })).status).toBe(200);
    const stale = await t.call<{ error: string }>("POST", `${A}/records/R1/user-update`, { fields: { decision: "approve" }, ifRevision: d.body.revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("revision-mismatch");
    const after = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(after.body.fields).toEqual({ reviewed: true });
  });

  it("comments and attachments go into the record and its history; only on cards that allow them", async () => {
    const t = await setup();
    const up = multipartBody([{ name: "file", filename: "shot.png", content: PNG_1x1, type: "image/png" }]);
    const u = await t.app.inject({ method: "POST", url: `${A}/uploads`, headers: up.headers, payload: up.payload });
    expect(u.statusCode).toBe(201);
    const uploadId = u.json().attachments[0].attachmentId as string;
    const r = await t.call("POST", `${A}/records/R1/user-update`, { comment: "Please add a test", attach: [{ uploadId, title: "Screenshot" }] });
    expect(r.status).toBe(200);
    const d = await t.call<RecordDetail>("GET", `${A}/records/R1`);
    expect(d.body.attachments.map((a) => [a.id, a.title, a.available])).toEqual([[uploadId, "Screenshot", true]]);
    expect(d.body.history.map((h) => h.text)).toEqual(["Attached Screenshot", "Please add a test"]);
    const file = await t.app.inject({ method: "GET", url: `${A}/attachments/${uploadId}` });
    expect(file.statusCode).toBe(200);
    // The tasks card does not enable comments.
    const no = await t.call<{ error: string }>("POST", `${A}/records/T1/user-update`, { comment: "hi" });
    expect(no.status).toBe(403);
    expect(no.body.error).toBe("not-allowed");
  });

  it("an upload made for a question cannot be attached to another record", async () => {
    const t = await setup();
    const up = multipartBody([{ name: "questionId", value: "QFILE" }, { name: "file", filename: "a.png", content: PNG_1x1, type: "image/png" }]);
    const u = await t.app.inject({ method: "POST", url: `${A}/uploads`, headers: up.headers, payload: up.payload });
    const uploadId = u.json().attachments[0].attachmentId as string;
    const r = await t.call<{ error: string }>("POST", `${A}/records/R1/user-update`, { attach: [{ uploadId }] });
    expect(r.status).toBe(409);
    const bogus = await t.call("POST", `${A}/records/R1/user-update`, { attach: [{ uploadId: "UP-nope" }] });
    expect(bogus.status).toBe(422);
  });

  it("an invalid field value in a record file is dropped with a warning; the record stays visible", async () => {
    const root = dataRoot();
    writeJson(path.join(reviewsDir(root), "records", "R3.json"), { schemaVersion: 1, id: "R3", recordType: "review", title: "R3", status: "needs-review", updatedAt: T0, fields: { reviewed: "yes", note: "kept" } });
    const t = await setup({ root });
    const d = await t.call<RecordDetail>("GET", `${A}/records/R3`);
    expect(d.status).toBe(200);
    expect(d.body.fields).toEqual({ note: "kept" });
    const diag = await t.call<{ diagnostics: { level: string; message: string }[] }>("GET", "/api/diagnostics");
    expect(diag.body.diagnostics.some((x) => x.level === "warning" && x.message.includes("field 'reviewed'"))).toBe(true);
  });

  it("rejects bad field definitions in section.json", async () => {
    const root = dataRoot();
    writeJson(path.join(reviewsDir(root), "section.json"), section("reviews", "expandable-card", "Reviews", { fields: [{ id: "x", label: "X", type: "choice" }] }));
    const t = await setup({ root });
    const diag = await t.call<{ diagnostics: { message: string }[] }>("GET", "/api/diagnostics");
    expect(diag.body.diagnostics.some((x) => x.message.includes("a choice field needs options"))).toBe(true);
  });
});

// ---------------------------------------------------------- external refs --
describe("external references", () => {
  const ref = { system: "tracker", id: "LAN-142", title: "Autosave", url: "https://tracker.example/LAN-142", ref: "feature/autosave@3f9c2e1", status: "merged", statusAt: "2026-11-10T09:00:00Z" };

  it("are stored, shown in summaries and kept apart from the record's own status", async () => {
    const t = await setup();
    const r = await t.call("PATCH", `${A}/records/T1`, { external: [ref] });
    expect(r.status).toBe(200);
    const page = await t.call<RecordPage>("GET", `${A}/sections/tasks/records?status=all`);
    const t1 = page.body.items.find((x) => x.id === "T1")!;
    expect(t1.external).toEqual([ref]);
    expect(t1.status).toBe("in-progress");
    // Clearing
    await t.call("PATCH", `${A}/records/T1`, { external: [] });
    expect((await t.call<RecordDetail>("GET", `${A}/records/T1`)).body.external).toBeUndefined();
  });

  it.each([
    ["javascript url", { ...ref, url: "javascript:alert(1)" }],
    ["data url", { ...ref, url: "data:text/html,hi" }],
    ["missing system", { id: "X" }],
    ["unknown key", { ...ref, onclick: "x" }],
  ])("rejects %s, in a patch and in a full record", async (_n, bad) => {
    const t = await setup();
    const r = await t.call<{ error: string }>("PATCH", `${A}/records/T1`, { external: [bad] });
    expect(r.status).toBe(400); // request body does not match the call's schema
    const src = await t.call<{ record: Record<string, unknown> }>("GET", `${A}/records/T1/source`);
    const put = await t.call<{ error: string }>("PUT", `${A}/records/T1`, { sectionId: "tasks", record: { ...src.body.record, external: [bad] } });
    expect(put.status).toBe(422);
    expect(put.body.error).toBe("validation");
    expect((await t.call<RecordDetail>("GET", `${A}/records/T1`)).body.external).toBeUndefined();
  });
});

// ------------------------------------------------------- recurring records --
function template(extra: Record<string, unknown> = {}, schedule: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id: "checkin", title: "Daily check-in", state: "active",
    schedule: { frequency: "daily", time: "09:00", timezone: "Europe/Amsterdam", startDate: "2026-11-01", ...schedule },
    record: {
      recordType: "question", title: "Check-in {date}", status: "open", requiresResponse: true, questionRevision: 1,
      answerSchema: { type: "approval", default: "approve" },
    },
    ...extra,
  };
}

async function withTemplate(tpl: Record<string, unknown>, root = dataRoot()) {
  writeJson(path.join(dailyDir(root), "templates", `${tpl.id as string}.json`), tpl);
  return setup({ root });
}

const ids = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.call<RecordPage>("GET", `${A}/sections/daily/records?status=all&sort=title&limit=200`)).body.items.map((r) => r.id);

describe("recurring templates", () => {
  it("creates one occurrence per local day once its time has passed, with a stable id", async () => {
    const t = await withTemplate(template());
    // 07:59 UTC = 08:59 in Amsterdam (CET): not yet due.
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-01T07:59:00Z"))).created).toEqual([]);
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-01T08:00:00Z"))).created).toEqual(["checkin-2026-11-01"]);
    const d = await t.call<RecordDetail>("GET", `${A}/records/checkin-2026-11-01`);
    expect(d.body.title).toBe("Check-in 2026-11-01");
    expect(d.body.occurrence).toEqual({ templateId: "checkin", date: "2026-11-01" });
    // The default is shown, not submitted.
    expect(d.body.question?.uiState).toBe("needs-response");
    expect(d.body.submittedAnswer).toBeUndefined();
  });

  it("is idempotent: repeated runs, a restart and a concurrent second server create nothing twice", async () => {
    const root = dataRoot();
    const t = await withTemplate(template(), root);
    const at = new Date("2026-11-03T12:00:00Z");
    await runRecurrence(t.store, "alpha", at);
    expect((await runRecurrence(t.store, "alpha", at)).created).toEqual([]);
    const restarted = await setup({ root });
    expect((await runRecurrence(restarted.store, "alpha", at)).created).toEqual([]);
    // Two servers on the same data, both missing the cursor (as if they started together), racing on a new day.
    fs.rmSync(path.join(root, "projects", "alpha", "user-state", ".recurrence.json"));
    const s1 = await setup({ root });
    const s2 = await setup({ root });
    const next = new Date("2026-11-04T12:00:00Z");
    const [a, b] = await Promise.all([runRecurrence(s1.store, "alpha", next), runRecurrence(s2.store, "alpha", next)]);
    expect([...a.created, ...b.created]).toEqual(["checkin-2026-11-04"]);
    const files = fs.readdirSync(path.join(dailyDir(root), "records")).filter((f) => !f.startsWith("."));
    expect(files.sort()).toEqual(["checkin-2026-11-03.json", "checkin-2026-11-04.json"]);
  });

  it("handles missed days predictably: only catchUpDays are created, never before startDate", async () => {
    const t = await withTemplate(template({}, { catchUpDays: 2 }));
    const created = (await runRecurrence(t.store, "alpha", new Date("2026-11-10T12:00:00Z"))).created;
    expect(created).toEqual(["checkin-2026-11-08", "checkin-2026-11-09", "checkin-2026-11-10"]);
    const t2 = await withTemplate(template({}, { catchUpDays: 0 }));
    expect((await runRecurrence(t2.store, "alpha", new Date("2026-11-10T12:00:00Z"))).created).toEqual(["checkin-2026-11-10"]);
    const t3 = await withTemplate(template({}, { catchUpDays: 30, startDate: "2026-11-09" }));
    expect((await runRecurrence(t3.store, "alpha", new Date("2026-11-10T12:00:00Z"))).created).toEqual(["checkin-2026-11-09", "checkin-2026-11-10"]);
  });

  it("stops after endDate and does not start before startDate", async () => {
    const t = await withTemplate(template({}, { startDate: "2026-11-05", endDate: "2026-11-06", catchUpDays: 10 }));
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-04T12:00:00Z"))).created).toEqual([]);
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-08T12:00:00Z"))).created).toEqual(["checkin-2026-11-05", "checkin-2026-11-06"]);
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-09T12:00:00Z"))).created).toEqual([]);
    // Days that ended before the catch-up window are not created.
    const late = await withTemplate(template({}, { startDate: "2026-11-05", endDate: "2026-11-06", catchUpDays: 2 }));
    expect((await runRecurrence(late.store, "alpha", new Date("2026-11-20T12:00:00Z"))).created).toEqual([]);
  });

  it("uses the template's time zone for the date", async () => {
    // 2026-11-01 20:00 UTC is already 2026-11-02 09:00 in Auckland (NZDT, UTC+13).
    const t = await withTemplate(template({}, { timezone: "Pacific/Auckland" }));
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-01T20:00:00Z"))).created).toEqual(["checkin-2026-11-02"]);
  });

  it("creates exactly one occurrence on daylight-saving days", async () => {
    // Spring forward: 2026-03-08 in New York, 02:00 → 03:00. 02:30 never happens; due once the clock passes it.
    const spring = await withTemplate(template({}, { timezone: "America/New_York", time: "02:30", startDate: "2026-03-08" }));
    expect((await runRecurrence(spring.store, "alpha", new Date("2026-03-08T06:59:00Z"))).created).toEqual([]); // 01:59 EST
    expect((await runRecurrence(spring.store, "alpha", new Date("2026-03-08T07:00:00Z"))).created).toEqual(["checkin-2026-03-08"]); // 03:00 EDT
    // Fall back: 2026-11-01, 01:30 happens twice; created at the first, not again at the second.
    const fall = await withTemplate(template({}, { timezone: "America/New_York", time: "01:30", startDate: "2026-11-01" }));
    expect((await runRecurrence(fall.store, "alpha", new Date("2026-11-01T05:30:00Z"))).created).toEqual(["checkin-2026-11-01"]); // 01:30 EDT
    expect((await runRecurrence(fall.store, "alpha", new Date("2026-11-01T06:30:00Z"))).created).toEqual([]); // 01:30 EST
  });

  it("keeps history: occurrences are never changed or removed, and a deleted one is not recreated", async () => {
    const t = await withTemplate(template({}, { catchUpDays: 3 }));
    await runRecurrence(t.store, "alpha", new Date("2026-11-03T12:00:00Z"));
    await t.call("POST", `${A}/questions/checkin-2026-11-02/answers`, { questionRevision: 1, idempotencyKey: "rec-hist-1", answers: [{ fieldId: "response", kind: "approval", decision: "reject" }] });
    const file = path.join(dailyDir(t.root), "records", "checkin-2026-11-03.json");
    fs.rmSync(file);
    await t.store.applyChanges(path.join(t.root, "projects", "alpha"), ["sections/dev/work/daily/records/checkin-2026-11-03.json"]);
    await runRecurrence(t.store, "alpha", new Date("2026-11-03T13:00:00Z"));
    expect(fs.existsSync(file)).toBe(false);
    expect(await ids(t)).toEqual(["checkin-2026-11-01", "checkin-2026-11-02"]);
    expect((await t.call<RecordDetail>("GET", `${A}/records/checkin-2026-11-02`)).body.question?.uiState).not.toBe("needs-response");
  });

  it("can be paused and resumed through the API; paused templates create nothing", async () => {
    const t = await withTemplate(template());
    const p = await t.call<TemplateSummary>("POST", `${A}/templates/checkin/state`, { state: "paused" });
    expect(p.status).toBe(200);
    expect(p.body.state).toBe("paused");
    expect(JSON.parse(fs.readFileSync(path.join(dailyDir(t.root), "templates", "checkin.json"), "utf8")).state).toBe("paused");
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-05T12:00:00Z"))).created).toEqual([]);
    // The server resumes on its own clock; set it to the simulated day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T11:00:00Z"));
    try { await t.call("POST", `${A}/templates/checkin/state`, { state: "active" }); } finally { vi.useRealTimers(); }
    // Resumed without catch-up: only today.
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-06T12:00:00Z"))).created).toEqual(["checkin-2026-11-06"]);
    await t.call("POST", `${A}/templates/checkin/state`, { state: "disabled" });
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-07T12:00:00Z"))).created).toEqual([]);
    const list = await t.call<{ templates: TemplateSummary[] }>("GET", `${A}/templates`);
    expect(list.body.templates).toMatchObject([{ id: "checkin", state: "disabled", lastDate: "2026-11-06" }]);
    expect((await t.call("POST", `${A}/templates/nope/state`, { state: "paused" })).status).toBe(404);
    expect((await t.call("POST", `${A}/templates/checkin/state`, { state: "deleted" })).status).toBe(400);
  });

  it("resuming starts from today: paused days are not filled in, even within catchUpDays", async () => {
    const t = await withTemplate(template({}, { catchUpDays: 3 }));
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-01T12:00:00Z"))).created).toEqual(["checkin-2026-11-01"]);
    await t.call("POST", `${A}/templates/checkin/state`, { state: "paused" });
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-04T12:00:00Z"))).created).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    try { await t.call("POST", `${A}/templates/checkin/state`, { state: "active" }); } finally { vi.useRealTimers(); }
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-05T12:00:01Z"))).created).toEqual(["checkin-2026-11-05"]);
    // Downtime (not a pause) is still caught up within catchUpDays.
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-08T12:00:00Z"))).created).toEqual(["checkin-2026-11-06", "checkin-2026-11-07", "checkin-2026-11-08"]);
  });

  it("a day whose time passes between two checks of a running server is created, also with catchUpDays 0", async () => {
    const t = await withTemplate(template({}, { time: "23:59", timezone: "UTC" }));
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-02T23:58:59.950Z"))).created).toEqual([]);
    // The next check lands after midnight: 11-02 became due in between and must not be skipped.
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-03T00:00:00.100Z"))).created).toEqual(["checkin-2026-11-02"]);
    // A restart is downtime: a fresh server does not catch up yesterday with catchUpDays 0.
    const again = await setup({ root: t.root });
    expect((await runRecurrence(again.store, "alpha", new Date("2026-11-04T00:00:30Z"))).created).toEqual([]);
  });

  it("agents may list templates but not change their state", async () => {
    const t = await setup({ auth: true, root: (() => { const r = dataRoot(); writeJson(path.join(dailyDir(r), "templates", "checkin.json"), template()); return r; })() });
    expect((await t.call("GET", `${A}/templates`, undefined, PUB)).status).toBe(200);
    expect((await t.call("POST", `${A}/templates/checkin/state`, { state: "paused" }, PUB)).status).toBe(403);
  });

  it("an invalid template is reported and creates nothing", async () => {
    const root = dataRoot();
    writeJson(path.join(dailyDir(root), "templates", "tz.json"), template({ id: "tz" }, { timezone: "Mars/Olympus" }));
    writeJson(path.join(dailyDir(root), "templates", "idset.json"), { ...template({ id: "idset" }), record: { ...template().record, id: "fixed" } });
    writeJson(path.join(dailyDir(root), "templates", "range.json"), template({ id: "range" }, { startDate: "2026-11-05", endDate: "2026-11-01" }));
    const t = await setup({ root });
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-10T12:00:00Z"))).created).toEqual([]);
    const diag = await t.call<{ diagnostics: { message: string }[] }>("GET", "/api/diagnostics");
    const text = JSON.stringify(diag.body.diagnostics);
    expect(text).toContain("unknown time zone");
    expect(text).toContain("must not set id");
    expect(text).toContain("endDate before startDate");
    const list = await t.call<{ templates: TemplateSummary[] }>("GET", `${A}/templates`);
    expect(list.body.templates.every((x) => x.error)).toBe(true);
  });

  it("an occurrence that fails validation is reported on the template and retried later", async () => {
    const t = await withTemplate({ ...template(), record: { recordType: "task", title: "Run {date}", status: "not-a-status" } });
    const r = await runRecurrence(t.store, "alpha", new Date("2026-11-02T12:00:00Z"));
    expect(r.created).toEqual([]);
    expect(r.errors[0].message).toContain("status 'not-a-status'");
    const list = await t.call<{ templates: TemplateSummary[] }>("GET", `${A}/templates`);
    expect(list.body.templates[0].error).toContain("not-a-status");
    expect(list.body.templates[0].lastDate).toBeUndefined();
  });

  it("refuses an occurrence id already used by another section", async () => {
    const root = dataRoot();
    writeJson(path.join(reviewsDir(root), "records", "checkin-2026-11-02.json"), { schemaVersion: 1, id: "checkin-2026-11-02", recordType: "review", title: "x", status: "needs-review", updatedAt: T0 });
    const t = await withTemplate(template(), root);
    const r = await runRecurrence(t.store, "alpha", new Date("2026-11-02T12:00:00Z"));
    expect(r.created).toEqual([]);
    expect(r.errors[0].message).toContain("already used in section reviews");
  });
});

describe("example projects", () => {
  it("load without diagnostics and show the new capabilities", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "apd-examples-"));
    fs.cpSync(path.resolve("examples"), root, { recursive: true });
    const t = await setup({ root });
    const diag = await t.call<{ diagnostics: unknown[] }>("GET", "/api/diagnostics");
    expect(diag.body.diagnostics).toEqual([]);
    const rev = await t.call<RecordDetail>("GET", "/api/projects/lantern-web-app/records/LNT-REV-001");
    expect(rev.body.fieldDefs.map((d) => d.id)).toEqual(["reviewed", "decision", "checks", "followUp"]);
    expect(rev.body.external?.[0]).toMatchObject({ system: "code review", status: "open" });
    const tpl = await t.call<{ templates: TemplateSummary[] }>("GET", "/api/projects/tidepool-notebook/templates");
    expect(tpl.body.templates).toMatchObject([{ id: "field-log", state: "paused" }]);
    // Paused: the scheduler creates nothing for the example until someone resumes it.
    expect((await runRecurrence(t.store, "tidepool-notebook", new Date("2026-11-20T20:00:00Z"))).created).toEqual([]);
  });
});

// ------------------------------------------------- record integrity (review) --
describe("record integrity", () => {
  const review = (extra: Record<string, unknown> = {}) => ({ recordType: "review", title: "Review R1", status: "needs-review", updatedAt: T0, ...extra });
  const upload = async (t: Awaited<ReturnType<typeof setup>>, token?: string, url = `${A}/uploads`) => {
    const up = multipartBody([{ name: "file", filename: "shot.png", content: PNG_1x1, type: "image/png" }]);
    const headers: Record<string, string> = { ...up.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    return t.app.inject({ method: "POST", url, headers, payload: up.payload });
  };

  it("an agent's full republish keeps the user's comments, attachments, field changes and untouched field values", async () => {
    const t = await setup();
    await t.call("PATCH", `${A}/records/R1`, { fields: { note: "from agent", built: true } });
    const u = await upload(t);
    const uploadId = u.json().attachments[0].attachmentId as string;
    expect((await t.call("POST", `${A}/records/R1/user-update`, { fields: { reviewed: true, note: "user note" }, comment: "Please fix the footer", attach: [{ uploadId, title: "Shot" }] })).status).toBe(200);
    // The agent republishes from its own copy, which has none of that.
    const put = await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ summary: "v2", history: [{ at: T0, text: "Published v2", by: "builder" }] }) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const d = (await t.call<RecordDetail>("GET", `${A}/records/R1`)).body;
    expect(d.summary).toBe("v2");
    expect(d.fields).toEqual({ reviewed: true, note: "user note", built: true });
    expect(d.attachments.map((a) => a.id)).toEqual([uploadId]);
    const texts = d.history.map((h) => h.text);
    expect(texts).toContain("Please fix the footer");
    expect(texts).toContain("Reviewed: — → yes");
    expect(texts).toContain("Published v2");
    // A field the write names is replaced; null clears it.
    await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ fields: { note: null, built: false } }) });
    expect((await t.call<RecordDetail>("GET", `${A}/records/R1`)).body.fields).toEqual({ reviewed: true, built: false });
  });

  it("agents cannot write history entries or attachments under the user's name", async () => {
    const t = await setup();
    const fake = await t.call<{ error: string }>("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ history: [{ at: T0, text: "Decision: approved by user", by: "user" }] }) });
    expect(fake.status).toBe(403);
    expect(fake.body.error).toBe("reserved-actor");
    const patch = await t.call<{ error: string }>("PATCH", `${A}/records/R1`, { history: { text: "Reviewed: no → yes", by: "User" } });
    expect(patch.status).toBe(403);
    const att = await t.call<{ error: string }>("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ attachments: [{ id: "X1", path: "documents/adr-1.md", by: "user" }] }) });
    expect(att.status).toBe(403);
    // Sending back what the user really wrote (read from /source) is fine.
    await t.call("POST", `${A}/records/R1/user-update`, { comment: "real comment" });
    const src = (await t.call<{ record: Record<string, unknown> }>("GET", `${A}/records/R1/source`)).body.record;
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, summary: "echo" } })).status).toBe(200);
  });

  it("refuses a record or event id that differs from an existing one only in letter case", async () => {
    const t = await setup();
    const r = await t.call<{ error: string }>("PUT", `${A}/records/r1`, { sectionId: "reviews", record: review({ title: "other" }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("id-conflict");
    expect(fs.readFileSync(path.join(reviewsDir(t.root), "records", "R1.json"), "utf8")).toContain("Review R1");
    expect((await t.call("PUT", `${A}/activity/EV-Case`, { action: "test", summary: "one" })).status).toBe(201);
    const ev = await t.call<{ error: string; message: string }>("PUT", `${A}/activity/ev-case`, { action: "test", summary: "two" });
    expect(ev.status).toBe(409);
    // On a case-insensitive file system the file clash alone would also give 409; the case rule must answer first.
    expect(ev.body.message).toContain("only in letter case");
  });

  it("refuses unknown keys and undeclared attachment roots in a published record", async () => {
    const t = await setup();
    const k = await t.call<{ error: string; message: string }>("PUT", `${A}/records/R9`, { sectionId: "reviews", record: review({ titel: "typo" }) });
    expect(k.status).toBe(422);
    expect(k.body.message).toContain("titel");
    const d = await t.call("PUT", `${A}/records/Q9`, { sectionId: "qs", record: question("Q9", { answerSchema: { type: "file-upload", maxFiles: 1, default: "x" } }) });
    expect(d.status).toBe(422);
    const root = await t.call("PUT", `${A}/records/R9`, { sectionId: "reviews", record: review({ attachments: [{ id: "A9", path: "x.md", root: "." }] }) });
    expect(root.status).toBe(422);
  });

  it("a stored value whose field definition was removed never blocks later updates", async () => {
    const root = dataRoot();
    const recFile = path.join(reviewsDir(root), "records", "R1.json");
    writeJson(recFile, { ...JSON.parse(fs.readFileSync(recFile, "utf8")), fields: { gone: "old value" } });
    const t = await setup({ root });
    expect((await t.call("PATCH", `${A}/records/R1`, { status: "approved" })).status).toBe(200);
    expect((await t.call("POST", `${A}/records/R1/user-update`, { comment: "still works" })).status).toBe(200);
    // The value is kept in the file (the definition may come back), not shown.
    expect(JSON.parse(fs.readFileSync(recFile, "utf8")).fields).toEqual({ gone: "old value" });
  });

  it("parallel user and agent updates of one record are all kept, and survive a restart", async () => {
    const t = await setup();
    for (let i = 0; i < 15; i++) {
      const res = await Promise.all([
        t.call("PATCH", `${A}/records/R1`, { history: { text: `agent ${i}`, by: "builder" }, fields: { built: i % 2 === 0 } }),
        t.call("POST", `${A}/records/R1/user-update`, { comment: `user ${i}`, fields: { note: `n${i}` } }),
      ]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
    }
    const again = await setup({ root: t.root });
    const d = (await again.call<RecordDetail>("GET", `${A}/records/R1`)).body;
    const texts = d.history.map((h) => h.text);
    for (let i = 0; i < 15; i++) {
      expect(texts).toContain(`agent ${i}`);
      expect(texts).toContain(`user ${i}`);
    }
    expect(d.fields).toEqual({ built: true, note: "n14" });
  });

  it("a template record with attachments is rejected (each attachment belongs to one record)", async () => {
    const t = await withTemplate(template({ record: { ...template().record, attachments: [{ id: "GUIDE", path: "documents/adr-1.md" }] } }));
    const list = await t.call<{ templates: TemplateSummary[] }>("GET", `${A}/templates`);
    expect(list.body.templates[0]?.error ?? "").toMatch(/attachments/);
    expect((await runRecurrence(t.store, "alpha", new Date("2026-11-02T12:00:00Z"))).created).toEqual([]);
  });

  it("agent uploads need publishing; a disabled project is refused by id", async () => {
    const root = dataRoot();
    const pj = path.join(root, "projects", "alpha", "project.json");
    const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
    writeJson(pj, { ...manifest, publishing: { enabled: false } });
    const t = await setup({ root, auth: true });
    expect((await upload(t, PUB)).statusCode).toBe(403);
    // The dashboard user's own uploads (answers, comments) need no publishing opt-in.
    expect((await upload(t, OPERATOR)).statusCode).toBe(201);

    writeJson(pj, { ...manifest, enabled: false });
    const off = await setup({ root, auth: true });
    expect((await off.call("GET", A, undefined, OPERATOR)).status).toBe(404);
    expect((await off.call("GET", `${A}/records/R1`, undefined, OPERATOR)).status).toBe(404);
    expect((await off.call("POST", `${A}/records/R1/user-update`, { comment: "x" }, OPERATOR)).status).toBe(404);
  });
});

describe("record integrity, round 2", () => {
  const review = (extra: Record<string, unknown> = {}) => ({ recordType: "review", title: "Review R1", status: "needs-review", updatedAt: T0, ...extra });
  type Src = { record: { history?: { at: string; text: string; by?: string }[]; attachments?: { id: string; by?: string }[] } };

  it("a republish can neither re-attribute nor drop the user's history entries and attachments", async () => {
    const t = await setup();
    const up = multipartBody([{ name: "file", filename: "shot.png", content: PNG_1x1, type: "image/png" }]);
    const uploadId = (await t.app.inject({ method: "POST", url: `${A}/uploads`, headers: up.headers, payload: up.payload })).json().attachments[0].attachmentId as string;
    await t.call("POST", `${A}/records/R1/user-update`, { comment: "Please fix the footer", attach: [{ uploadId, title: "Shot" }] });
    const src = (await t.call<Src>("GET", `${A}/records/R1/source`)).body.record;
    // Step 1: echo everything, but claim the user's entries and attachment for the agent.
    const reattributed = {
      ...src,
      history: src.history!.map((h) => ({ ...h, by: "builder" })),
      attachments: src.attachments!.map(({ by: _by, ...a }) => a),
    };
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: reattributed })).status).toBe(200);
    // Step 2: drop them.
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, history: [], attachments: [] } })).status).toBe(200);
    const after = (await t.call<Src>("GET", `${A}/records/R1/source`)).body.record;
    expect(after.history!.filter((h) => h.by === "user").map((h) => h.text)).toEqual(["Attached Shot", "Please fix the footer"]);
    expect(after.attachments!.map((a) => [a.id, a.by])).toEqual([[uploadId, "user"]]);
  });

  it("refuses look-alikes of the user's name from agents", async () => {
    const t = await setup();
    for (const by of ["User (dashboard)", "usеr", "user​", " USER", "user-bot"]) {
      const r = await t.call<{ error: string }>("PATCH", `${A}/records/R1`, { history: { text: "x", by } });
      expect(r.status, JSON.stringify(by)).toBe(403);
      expect(r.body.error).toBe("reserved-actor");
    }
    expect((await t.call("PATCH", `${A}/records/R1`, { history: { text: "x", by: "build-agent 2" } })).status).toBe(200);
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ history: [{ at: T0, text: "y", by: "Us er" }] }) })).status).toBe(403);
  });

  it("the history cap drops agent entries before the user's", async () => {
    const t = await setup();
    await t.call("POST", `${A}/records/R1/user-update`, { comment: "keep me" });
    const flood = Array.from({ length: 500 }, (_, i) => ({ at: new Date(Date.parse("2030-01-01T00:00:00Z") + i * 1000).toISOString(), text: `agent ${i}`, by: "builder" }));
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: review({ history: flood }) })).status).toBe(200);
    const h = (await t.call<Src>("GET", `${A}/records/R1/source`)).body.record.history!;
    expect(h).toHaveLength(500);
    expect(h.some((x) => x.text === "keep me" && x.by === "user")).toBe(true);
    for (let i = 0; i < 3; i++) await t.call("PATCH", `${A}/records/R1`, { history: { text: `more ${i}`, by: "builder" } });
    const h2 = (await t.call<Src>("GET", `${A}/records/R1/source`)).body.record.history!;
    expect(h2).toHaveLength(500);
    expect(h2.some((x) => x.text === "keep me")).toBe(true);
  });

  it("read-then-republish works for a record with an old unknown key or a value of a removed field", async () => {
    const root = dataRoot();
    const recFile = path.join(reviewsDir(root), "records", "R1.json");
    writeJson(recFile, { ...JSON.parse(fs.readFileSync(recFile, "utf8")), myNote: "hand-written", fields: { gone: "old" }, attachments: [{ id: "OLD-1", path: "x.md", root: "elsewhere" }] });
    const t = await setup({ root });
    const src = (await t.call<{ record: Record<string, unknown> }>("GET", `${A}/records/R1/source`)).body.record;
    const r = await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, summary: "republished" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A new unknown key or a new value for an undefined field is still refused.
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, otherKey: 1 } })).status).toBe(422);
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, fields: { gone: "new" } } })).status).toBe(422);
    expect((await t.call("PUT", `${A}/records/R1`, { sectionId: "reviews", record: { ...src, attachments: [{ id: "NEW-1", path: "x.md", root: "elsewhere" }] } })).status).toBe(422);
  });

  it("an occurrence id that differs from an existing record only in letter case is reported, not skipped", async () => {
    const root = dataRoot();
    writeJson(path.join(dailyDir(root), "records", "CHECKIN-2026-11-02.json"), { schemaVersion: 1, id: "CHECKIN-2026-11-02", recordType: "task", title: "x", status: "planned", updatedAt: T0 });
    const t = await withTemplate(template(), root);
    const r = await runRecurrence(t.store, "alpha", new Date("2026-11-02T12:00:00Z"));
    expect(r.created).toEqual([]);
    expect(r.errors[0]?.message ?? "").toMatch(/only in letter case/);
    // The day is not marked as handled: it is tried again once the clash is resolved.
    const list = await t.call<{ templates: TemplateSummary[] }>("GET", `${A}/templates`);
    expect(list.body.templates[0].lastDate).toBeUndefined();
    expect(list.body.templates[0].error ?? "").toMatch(/only in letter case/);
  });
});
