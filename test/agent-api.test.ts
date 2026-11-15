/** Agent-facing API: capabilities, publishing records/activity/progress, scoped tokens, queue filters, concurrency. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, multipartBody, PNG_1x1, POST_HEADERS, question, section, T0, writeJson } from "./helpers.js";
import { loadConfig } from "../src/server/config.js";
import { tokenSha256 } from "../src/server/auth.js";
import type { ProgressResponse, ProjectsResponse, RecordDetail, RecordPage, ActivityPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

const OPERATOR = "operator-token-0123456789abcdef";
const TOKENS = {
  pub: "agent-publish-token-0123456789",
  con: "agent-consume-token-0123456789",
  all: "agent-readall-token-0123456789",
};

/** alpha publishes into "tasks" and "qs"; "notes" is a card that is not open for publishing; beta does not publish. */
function dataRoot(): string {
  const root = makeDataRoot();
  const a = path.join(root, "projects", "alpha");
  const manifest = JSON.parse(fs.readFileSync(path.join(a, "project.json"), "utf8"));
  writeJson(path.join(a, "project.json"), { ...manifest, publishing: { enabled: true, sections: ["tasks", "qs"] } });
  writeJson(path.join(a, "sections", "dev", "work", "notes", "section.json"), section("notes", "expandable-card", "Notes"));
  return root;
}

async function setup(opts: { root?: string; auth?: boolean } = {}) {
  const root = opts.root ?? dataRoot();
  let extra: Record<string, unknown> = {};
  if (opts.auth) {
    const tokenFile = path.join(root, "operator-token.txt");
    fs.writeFileSync(tokenFile, OPERATOR);
    const agentTokensFile = path.join(root, "agent-tokens.json");
    writeJson(agentTokensFile, {
      schemaVersion: 1,
      tokens: [
        { name: "alpha-publisher", sha256: tokenSha256(TOKENS.pub), projects: ["alpha"], scopes: ["read", "publish"] },
        { name: "alpha-consumer", sha256: tokenSha256(TOKENS.con), projects: ["alpha"], scopes: ["read", "consume"] },
        { name: "reader", sha256: tokenSha256(TOKENS.all), projects: ["*"], scopes: ["read"] },
      ],
    });
    extra = { auth: { mode: "required", tokenFile }, agentTokensFile };
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

const A = "/api/projects/alpha";
const newTask = (id: string, extra: Record<string, unknown> = {}) => ({ recordType: "task", title: `Task ${id}`, status: "planned", updatedAt: T0, ...extra });

describe("capabilities", () => {
  it("lists publishable cards with their title path, workflows and limits", async () => {
    const t = await setup();
    const { status, body } = await t.call<{ apiVersion: number; publishing: { enabled: boolean; sections: { id: string; path: string[] }[] }; recordTypes: Record<string, { id: string }[]>; caller: { kind: string } }>("GET", `${A}/capabilities`);
    expect(status).toBe(200);
    expect(body.apiVersion).toBe(1);
    expect(body.caller.kind).toBe("operator");
    expect(body.publishing.enabled).toBe(true);
    expect(body.publishing.sections.map((s) => s.id).sort()).toEqual(["qs", "tasks"]);
    expect(body.publishing.sections.find((s) => s.id === "tasks")!.path).toEqual(["Developer Area", "Work", "Tasks"]);
    expect(body.recordTypes.task.map((s) => s.id)).toContain("in-progress");
    expect(body.recordTypes.question.map((s) => s.id)).toEqual(["open", "answered", "processed", "closed", "withdrawn"]);
    const beta = await t.call<{ publishing: { enabled: boolean; sections: unknown[] } }>("GET", "/api/projects/beta/capabilities");
    expect(beta.body.publishing).toEqual({ enabled: false, sections: [] });
  });
});

describe("publishing records", () => {
  it("creates, replays unchanged, updates, and shows the record in the section list", async () => {
    const t = await setup();
    const c = await t.call("PUT", `${A}/records/NEW-1`, { sectionId: "tasks", record: newTask("NEW-1") });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ recordId: "NEW-1", sectionId: "tasks", created: true, unchanged: false });
    const file = path.join(t.root, "projects", "alpha", "sections", "dev", "work", "tasks", "records", "NEW-1.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ id: "NEW-1", schemaVersion: 1, status: "planned" });
    const again = await t.call("PUT", `${A}/records/NEW-1`, { sectionId: "tasks", record: newTask("NEW-1") });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ unchanged: true, revision: c.body.revision });
    const upd = await t.call("PUT", `${A}/records/NEW-1`, { sectionId: "tasks", record: newTask("NEW-1", { status: "in-progress" }) });
    expect(upd.body).toMatchObject({ created: false, unchanged: false });
    expect(upd.body.revision).not.toBe(c.body.revision);
    const page = await t.call<RecordPage>("GET", `${A}/sections/tasks/records?status=all&limit=50`);
    expect(page.body.items.find((r) => r.id === "NEW-1")?.status).toBe("in-progress");
  });

  it("defaults updatedAt to now and fills id and schemaVersion", async () => {
    const t = await setup();
    const before = new Date().toISOString();
    await t.call("PUT", `${A}/records/NEW-2`, { sectionId: "tasks", record: { recordType: "task", title: "x", status: "planned" } });
    const src = await t.call<{ record: { updatedAt: string; id: string } }>("GET", `${A}/records/NEW-2/source`);
    expect(src.body.record.id).toBe("NEW-2");
    expect(src.body.record.updatedAt >= before).toBe(true);
  });

  it("rejects unknown, wrong-type and closed sections, and projects without publishing", async () => {
    const t = await setup();
    expect((await t.call("PUT", `${A}/records/X1`, { sectionId: "nope", record: newTask("X1") })).status).toBe(404);
    const tab = await t.call("PUT", `${A}/records/X1`, { sectionId: "desk", record: newTask("X1") });
    expect([tab.status, tab.body.error]).toEqual([422, "not-a-card"]);
    const closed = await t.call("PUT", `${A}/records/X1`, { sectionId: "notes", record: newTask("X1") });
    expect([closed.status, closed.body.error]).toEqual([403, "section-not-allowed"]);
    const beta = await t.call("PUT", "/api/projects/beta/records/X1", { sectionId: "backlog", record: newTask("X1") });
    expect([beta.status, beta.body.error]).toEqual([403, "publishing-disabled"]);
    const act = await t.call("PUT", "/api/projects/beta/activity/EV1", { action: "x", summary: "y" });
    expect(act.status).toBe(403);
    const prog = await t.call("PUT", "/api/projects/beta/progress", { progress: { overallPercent: 5 } });
    expect(prog.status).toBe(403);
    expect(fs.existsSync(path.join(t.root, "projects", "beta", "progress.json"))).toBe(false);
  });

  it("validates the record, its status workflow and its ids; nothing is written on rejection", async () => {
    const t = await setup();
    const status = await t.call<{ error: string; fieldErrors: { fieldId: string }[] }>("PUT", `${A}/records/X2`, { sectionId: "tasks", record: newTask("X2", { status: "shipped" }) });
    expect(status.status).toBe(422);
    expect(status.body.fieldErrors[0].fieldId).toBe("status");
    const noTitle = await t.call<{ fieldErrors: { fieldId: string }[] }>("PUT", `${A}/records/X2`, { sectionId: "tasks", record: { recordType: "task", status: "planned" } });
    expect(noTitle.status).toBe(422);
    expect(noTitle.body.fieldErrors.map((f) => f.fieldId)).toContain("title");
    expect((await t.call("PUT", `${A}/records/X2`, { sectionId: "tasks", record: newTask("OTHER", { id: "OTHER" }) })).status).toBe(400);
    expect((await t.call("PUT", `${A}/records/..%2F..%2Fescape`, { sectionId: "tasks", record: newTask("x") })).status).toBe(400);
    expect((await t.call("PUT", `${A}/records/X2`, { sectionId: "../dev", record: newTask("X2") })).status).toBe(400);
    const attPath = await t.call("PUT", `${A}/records/X2`, { sectionId: "tasks", record: newTask("X2", { attachments: [{ id: "A-1", path: "../../project.json" }] }) });
    expect(attPath.status).toBe(422);
    const question = await t.call("PUT", `${A}/records/X3`, { sectionId: "qs", record: { recordType: "question", title: "q", status: "open", requiresResponse: true } });
    expect(question.status).toBe(422);
    const tasksDir = path.join(t.root, "projects", "alpha", "sections", "dev", "work", "tasks", "records");
    expect(fs.readdirSync(tasksDir).filter((f) => f.startsWith("X"))).toEqual([]);
  });

  it("keeps record ids unique per project and attachment ids unique across records", async () => {
    const t = await setup();
    const dup = await t.call("PUT", `${A}/records/Q1`, { sectionId: "tasks", record: newTask("Q1") });
    expect([dup.status, dup.body.error]).toEqual([409, "id-conflict"]);
    const att = await t.call("PUT", `${A}/records/X4`, { sectionId: "tasks", record: newTask("X4", { attachments: [{ id: "ATT-1", path: "documents/adr-1.md" }] }) });
    expect([att.status, att.body.error]).toEqual([409, "id-conflict"]);
  });

  it("supports optimistic concurrency with ifRevision", async () => {
    const t = await setup();
    const src = await t.call<{ revision: string; record: Record<string, unknown> }>("GET", `${A}/records/T2/source`);
    expect(src.body.revision).toMatch(/^[a-f0-9]{16}$/);
    const ok = await t.call("PUT", `${A}/records/T2`, { sectionId: "tasks", record: { ...src.body.record, status: "done" }, ifRevision: src.body.revision });
    expect(ok.status).toBe(200);
    const stale = await t.call<{ error: string; details: { revision: string } }>("PUT", `${A}/records/T2`, { sectionId: "tasks", record: { ...src.body.record, status: "blocked" }, ifRevision: src.body.revision });
    expect([stale.status, stale.body.error]).toEqual([409, "revision-mismatch"]);
    expect(stale.body.details.revision).toBe(ok.body.revision);
    const create = await t.call("PUT", `${A}/records/X5`, { sectionId: "tasks", record: newTask("X5"), ifRevision: "0000000000000000" });
    expect(create.status).toBe(409);
  });

  it("refuses to change the answer schema of an answered question revision; a new revision is answerable again", async () => {
    const t = await setup();
    const sub = await t.call("POST", `${A}/questions/Q1/answers`, { questionRevision: 1, idempotencyKey: "agentapi-0001", answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }] });
    expect(sub.status).toBe(201);
    const changed = { ...question("Q1"), answerSchema: { type: "free-text" } };
    const same = await t.call("PUT", `${A}/records/Q1`, { sectionId: "qs", record: changed });
    expect([same.status, same.body.error]).toEqual([409, "revision-required"]);
    const titleOnly = await t.call("PUT", `${A}/records/Q1`, { sectionId: "qs", record: { ...question("Q1"), title: "Reworded" } });
    expect(titleOnly.status).toBe(200);
    const bumped = await t.call("PUT", `${A}/records/Q1`, { sectionId: "qs", record: { ...changed, questionRevision: 2 } });
    expect(bumped.status).toBe(200);
    const d = await t.call<RecordDetail>("GET", `${A}/records/Q1`);
    expect(d.body.question?.uiState).toBe("needs-response");
  });

  it("PATCH updates status and progress fields, de-duplicates retried history entries", async () => {
    const t = await setup();
    const at = "2026-11-14T08:00:00Z";
    const p1 = await t.call("PATCH", `${A}/records/T1`, { status: "in-testing", percent: 80, history: { at, text: "Tests started", by: "agent-1" } });
    expect(p1.status).toBe(200);
    expect(p1.body.unchanged).toBe(false);
    const p2 = await t.call("PATCH", `${A}/records/T1`, { status: "in-testing", percent: 80, history: { at, text: "Tests started", by: "agent-1" } });
    expect(p2.body).toMatchObject({ unchanged: true, revision: p1.body.revision });
    const src = await t.call<{ record: { history: unknown[]; status: string; percent: number; updatedAt: string } }>("GET", `${A}/records/T1/source`);
    expect(src.body.record.history).toEqual([{ at, text: "Tests started", by: "agent-1" }]);
    expect(src.body.record.percent).toBe(80);
    expect(src.body.record.updatedAt > T0).toBe(true);
    expect((await t.call("PATCH", `${A}/records/T1`, { status: "shipped" })).status).toBe(422);
    expect((await t.call("PATCH", `${A}/records/T1`, { title: "not patchable" })).status).toBe(400);
    expect((await t.call("PATCH", `${A}/records/NOPE`, { status: "done" })).status).toBe(404);
    const cleared = await t.call("PATCH", `${A}/records/T1`, { percent: null });
    expect(cleared.status).toBe(200);
    expect((await t.call<{ record: Record<string, unknown> }>("GET", `${A}/records/T1/source`)).body.record).not.toHaveProperty("percent");
  });

  it("links an uploaded evidence file to a published issue", async () => {
    const t = await setup();
    const mp = multipartBody([{ name: "file", filename: "screenshot.png", content: PNG_1x1, type: "image/png" }]);
    const up = await t.app.inject({ method: "POST", url: `${A}/uploads`, payload: mp.payload, headers: mp.headers });
    expect(up.statusCode).toBe(201);
    const uploadId = up.json().attachments[0].attachmentId as string;
    const put = await t.call("PUT", `${A}/records/BUG-1`, { sectionId: "tasks", record: { recordType: "issue", title: "Crash on save", status: "open", severity: "major", attachments: [{ uploadId, title: "Screenshot" }] } });
    expect(put.status).toBe(201);
    const d = await t.call<RecordDetail>("GET", `${A}/records/BUG-1`);
    expect(d.body.attachments).toHaveLength(1);
    expect(d.body.attachments[0]).toMatchObject({ id: uploadId, title: "Screenshot", available: true, mimeType: "image/png" });
    const file = await t.app.inject({ method: "GET", url: d.body.attachments[0].url });
    expect(file.statusCode).toBe(200);
    expect(Buffer.compare(file.rawPayload, PNG_1x1)).toBe(0);
    const bad = await t.call("PUT", `${A}/records/BUG-2`, { sectionId: "tasks", record: { recordType: "issue", title: "x", status: "open", attachments: [{ uploadId: "UPL-NOPE" }] } });
    expect(bad.status).toBe(422);
  });
});

describe("publishing activity and progress", () => {
  it("activity events are immutable and idempotent", async () => {
    const t = await setup();
    const ev = { at: "2026-11-14T09:00:00Z", action: "test", summary: "42 tests passed", status: "success", recordId: "T1", source: "ci" };
    expect((await t.call("PUT", `${A}/activity/EV-1`, ev)).status).toBe(201);
    const replay = await t.call("PUT", `${A}/activity/EV-1`, ev);
    expect([replay.status, replay.body.unchanged]).toEqual([200, true]);
    const diff = await t.call("PUT", `${A}/activity/EV-1`, { ...ev, summary: "41 tests passed" });
    expect([diff.status, diff.body.error]).toEqual([409, "id-conflict"]);
    expect((await t.call("PUT", `${A}/activity/EV-2`, { ...ev, recordId: "NOPE" })).status).toBe(422);
    expect((await t.call("PUT", `${A}/activity/E1`, { ...ev })).status).toBe(409); // an event the project wrote itself
    const list = await t.call<ActivityPage>("GET", `${A}/activity?limit=10`);
    expect(list.body.items[0]).toMatchObject({ id: "EV-1", summary: "42 tests passed" });
  });

  it("an event without `at` replays as the same event", async () => {
    const t = await setup();
    expect((await t.call("PUT", `${A}/activity/EV-3`, { action: "build", summary: "Build ok" })).status).toBe(201);
    expect((await t.call("PUT", `${A}/activity/EV-3`, { action: "build", summary: "Build ok" })).status).toBe(200);
  });

  it("progress is published as given and validated", async () => {
    const t = await setup();
    const r = await t.call("PUT", `${A}/progress`, { progress: { overallPercent: 64, label: "Release", method: "checklist", breakdown: [{ id: "core", title: "Core", percent: 90 }] } });
    expect(r.status).toBe(200);
    const p = await t.call<ProgressResponse>("GET", `${A}/progress`);
    expect(p.body.overallPercent).toBe(64);
    expect(p.body.breakdown[0].percent).toBe(90);
    expect((await t.call("PUT", `${A}/progress`, { progress: { overallPercent: 120 } })).status).toBe(422);
    expect((await t.call("PUT", `${A}/progress`, { progress: { overallPercent: 10 }, ifRevision: "0000000000000000" })).status).toBe(409);
  });
});

describe("queue filters", () => {
  it("lists pending answers for one task or question without reading answer files", async () => {
    const t = await setup();
    for (const [id, taskId] of [["QT1", "T1"], ["QT2", "T2"]]) {
      await t.call("PUT", `${A}/records/${id}`, { sectionId: "qs", record: { ...question(id), taskId } });
      const s = await t.call("POST", `${A}/questions/${id}/answers`, { questionRevision: 1, idempotencyKey: `filter-${id}-key`, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }] });
      expect(s.status).toBe(201);
    }
    const byTask = await t.call<{ items: { questionId: string }[] }>("GET", `${A}/queue?state=pending&taskId=T2`);
    expect(byTask.body.items.map((i) => i.questionId)).toEqual(["QT2"]);
    const byQuestion = await t.call<{ items: { questionId: string }[] }>("GET", `${A}/queue?state=pending&questionId=QT1`);
    expect(byQuestion.body.items.map((i) => i.questionId)).toEqual(["QT1"]);
    expect((await t.call<{ items: unknown[] }>("GET", `${A}/queue?state=pending&taskId=NOPE`)).body.items).toEqual([]);
  });
});

describe("scoped agent tokens", () => {
  it("rejects missing and unknown tokens", async () => {
    const t = await setup({ auth: true });
    expect((await t.call("GET", "/api/projects")).status).toBe(401);
    expect((await t.call("GET", "/api/projects", undefined, "not-a-real-token-at-all")).status).toBe(401);
  });

  it("limits a token to its projects: other projects look like they do not exist", async () => {
    const t = await setup({ auth: true });
    const list = await t.call<ProjectsResponse>("GET", "/api/projects", undefined, TOKENS.pub);
    expect(list.body.projects.map((p) => p.id)).toEqual(["alpha"]);
    expect(list.body.diagnosticsCount).toBe(0);
    for (const url of ["/api/projects/beta", "/api/projects/beta/queue?state=pending", "/api/projects/beta/records/Q1", "/api/projects/beta/capabilities"]) {
      expect((await t.call("GET", url, undefined, TOKENS.pub)).status, url).toBe(404);
    }
    expect((await t.call("PUT", "/api/projects/beta/records/Z1", { sectionId: "backlog", record: newTask("Z1") }, TOKENS.pub)).status).toBe(404);
    const reader = await t.call<ProjectsResponse>("GET", "/api/projects", undefined, TOKENS.all);
    expect(reader.body.projects.map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("enforces scopes and keeps operator-only endpoints closed", async () => {
    const t = await setup({ auth: true });
    const cap = await t.call<{ caller: { kind: string; name: string; scopes: string[] } }>("GET", `${A}/capabilities`, undefined, TOKENS.pub);
    expect(cap.body.caller).toEqual({ kind: "agent", name: "alpha-publisher", scopes: ["read", "publish"] });
    expect((await t.call("PUT", `${A}/records/AG-1`, { sectionId: "tasks", record: newTask("AG-1") }, TOKENS.pub)).status).toBe(201);
    expect((await t.call("POST", `${A}/queue/claim`, { owner: "w" }, TOKENS.pub)).status).toBe(403);
    expect((await t.call("PUT", `${A}/records/AG-2`, { sectionId: "tasks", record: newTask("AG-2") }, TOKENS.con)).status).toBe(403);
    expect((await t.call("POST", `${A}/queue/claim`, { owner: "w" }, TOKENS.con)).status).toBe(204);
    expect((await t.call("PUT", `${A}/records/AG-3`, { sectionId: "tasks", record: newTask("AG-3") }, TOKENS.all)).status).toBe(403);
    const operatorOnly: [string, string, unknown?][] = [
      ["POST", `${A}/questions/Q1/answers`, { questionRevision: 1, idempotencyKey: "agent-tries-1", answers: [] }],
      ["POST", `${A}/records/mark-read`, { allActivity: true }],
      ["POST", `${A}/export/xlsx`, { questionIds: ["Q1"] }],
      ["POST", `${A}/download/zip`, { recordIds: ["T1"] }],
      ["GET", "/api/diagnostics"],
      ["GET", "/api/updates"],
      ["POST", "/api/admin/reindex", {}],
    ];
    for (const [m, url, body] of operatorOnly) {
      for (const tok of Object.values(TOKENS)) {
        const r = await t.call<{ error: string; message: string }>(m, url, body, tok);
        expect([r.status, r.body.error], `${m} ${url}`).toEqual([403, "forbidden"]);
        expect(r.body.message, `${m} ${url}`).toMatch(/may not call this endpoint/);
      }
    }
  });

  it("the operator token works as a bearer token with full access; CSRF header is still required", async () => {
    const t = await setup({ auth: true });
    expect((await t.call("GET", "/api/diagnostics", undefined, OPERATOR)).status).toBe(200);
    const noHeader = await t.app.inject({ method: "PUT", url: `${A}/records/AG-4`, payload: JSON.stringify({ sectionId: "tasks", record: newTask("AG-4") }), headers: { authorization: `Bearer ${TOKENS.pub}`, "content-type": "application/json" } });
    expect(noHeader.statusCode).toBe(403);
  });

  it("throttles repeated wrong bearer tokens", async () => {
    const t = await setup({ auth: true });
    for (let i = 0; i < 5; i++) await t.call("GET", "/api/projects", undefined, `wrong-token-number-${i}-xxxxxxxx`);
    expect((await t.call("GET", "/api/projects", undefined, TOKENS.pub)).status).toBe(429);
  });

  it("records the agent as uploader", async () => {
    const t = await setup({ auth: true });
    const mp = multipartBody([{ name: "file", filename: "log.txt", content: Buffer.from("trace"), type: "text/plain" }]);
    const up = await t.app.inject({ method: "POST", url: `${A}/uploads`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${TOKENS.pub}` } });
    expect(up.statusCode).toBe(201);
    const id = up.json().attachments[0].attachmentId as string;
    const meta = JSON.parse(fs.readFileSync(path.join(t.root, "projects", "alpha", "attachments", "answers", `${id}.meta.json`), "utf8"));
    expect(meta.uploadedBy).toBe("agent:alpha-publisher");
  });

  it("validates the token file at startup", async () => {
    const root = dataRoot();
    const tokenFile = path.join(root, "op.txt");
    fs.writeFileSync(tokenFile, OPERATOR);
    const f = path.join(root, "agents.json");
    // Default mode is "required": an operator token file is needed, agent tokens or not.
    expect(() => loadConfig({ dataRoot: root, agentTokensFile: f } as never)).toThrow(/needs auth.tokenFile/);
    writeJson(f, { schemaVersion: 1, tokens: [{ name: "x", sha256: "abc", projects: ["alpha"], scopes: ["read"] }] });
    await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f })).rejects.toThrow(/agentTokensFile invalid/);
    writeJson(f, { schemaVersion: 1, tokens: [{ name: "x", sha256: tokenSha256(OPERATOR), projects: ["alpha"], scopes: ["read"] }] });
    await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f })).rejects.toThrow(/must not equal the operator token/);
    writeJson(f, { schemaVersion: 1, tokens: [{ name: "x", sha256: tokenSha256("a-b-c-d-e-f-g-h-i"), projects: ["alpha"], scopes: ["admin"] }] });
    await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f })).rejects.toThrow(/agentTokensFile invalid/);
    // Token names end up in history entries; the user's name and look-alikes are reserved.
    for (const name of ["user", "user-ci", "User.2", "u-s-e-r"]) {
      writeJson(f, { schemaVersion: 1, tokens: [
        { name: "ok-agent", sha256: tokenSha256("z-y-x-w-v-u-t-s-r"), projects: ["alpha"], scopes: ["read"] },
        { name, sha256: tokenSha256("a-b-c-d-e-f-g-h-i"), projects: ["alpha"], scopes: ["read"] }] });
      // The message names the file, the entry and the token, says why and what to do.
      await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f }), name)
        .rejects.toThrow(`agentTokensFile invalid: tokens.1.name '${name}' must not start with "user"`);
      await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f }), name).rejects.toThrow(/rename the token/);
    }
    // Names that merely contain "user" later on are fine.
    writeJson(f, { schemaVersion: 1, tokens: [{ name: "ci-user", sha256: tokenSha256("a-b-c-d-e-f-g-h-i"), projects: ["alpha"], scopes: ["read"] }] });
    await (await makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f })).app.close();
  });

  it("starts with the empty list the deploy script creates; a missing or malformed file stops start-up without echoing it", async () => {
    const root = dataRoot();
    const tokenFile = path.join(root, "op.txt");
    fs.writeFileSync(tokenFile, OPERATOR);
    const f = path.join(root, "agent_tokens.json");
    // Byte for byte what deploy/apd-deploy.sh writes.
    fs.writeFileSync(f, '{ "schemaVersion": 1, "tokens": [] }\n');
    const t = await makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f });
    const anyToken = await t.app.inject({ method: "GET", url: "/api/projects", headers: { authorization: "Bearer some-agent-token-0123456789" } });
    expect(anyToken.statusCode).toBe(401);
    await t.app.close();
    fs.rmSync(f);
    await expect(makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f })).rejects.toThrow("agentTokensFile unreadable: ENOENT");
    // An operator pasting a raw token instead of an entry: the error must not repeat the file's content.
    const raw = "raw-agent-token-SECRET-4f9a2c";
    for (const content of [raw, `{ "schemaVersion": 1, "tokens": [ "${raw}" ] }`, `{ "schemaVersion": 1, "tokens": [ ${raw} ] }`]) {
      fs.writeFileSync(f, content);
      const err = await makeApp(root, { auth: { mode: "required", tokenFile }, agentTokensFile: f }).then(() => null, (e: Error) => e);
      expect(err?.message, content).toMatch(/^agentTokensFile invalid/);
      expect(err?.message, content).not.toContain(raw);
    }
  });

  it("reads the token file location from PCC_AGENT_TOKENS_FILE (as the Compose file sets it)", () => {
    const root = dataRoot();
    const old = process.env.PCC_AGENT_TOKENS_FILE;
    process.env.PCC_AGENT_TOKENS_FILE = "/run/secrets/pcc_agent_tokens";
    try {
      const cfg = loadConfig({ dataRoot: root, auth: { mode: "local-network", trustedNetworks: ["127.0.0.1/32"] } } as never);
      expect(cfg.agentTokensFile).toBe("/run/secrets/pcc_agent_tokens");
    } finally {
      if (old === undefined) delete process.env.PCC_AGENT_TOKENS_FILE; else process.env.PCC_AGENT_TOKENS_FILE = old;
    }
  });
});

describe("concurrency and persistence", () => {
  it("parallel publishers: distinct ids all land, one id written many times stays valid, cross-section duplicates lose", async () => {
    const t = await setup();
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => t.call("PUT", `${A}/records/P-${i}`, { sectionId: "tasks", record: newTask(`P-${i}`) })));
    expect(many.every((r) => r.status === 201)).toBe(true);
    const page = await t.call<RecordPage>("GET", `${A}/sections/tasks/records?status=all&limit=200`);
    expect(page.body.items.filter((r) => r.id.startsWith("P-"))).toHaveLength(20);

    const same = await Promise.all(Array.from({ length: 10 }, (_, i) => t.call("PUT", `${A}/records/SAME`, { sectionId: "tasks", record: newTask("SAME", { summary: `v${i}` }) })));
    expect(same.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    const file = path.join(t.root, "projects", "alpha", "sections", "dev", "work", "tasks", "records", "SAME.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).summary).toMatch(/^v\d$/);

    const race = await Promise.all([
      t.call("PUT", `${A}/records/RACE`, { sectionId: "tasks", record: newTask("RACE") }),
      t.call("PUT", `${A}/records/RACE`, { sectionId: "qs", record: { ...question("RACE") } }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("published records, events and progress survive a restart", async () => {
    const root = dataRoot();
    const t = await setup({ root });
    await t.call("PUT", `${A}/records/KEEP`, { sectionId: "tasks", record: newTask("KEEP") });
    await t.call("PUT", `${A}/activity/EV-KEEP`, { action: "x", summary: "kept" });
    await t.call("PUT", `${A}/progress`, { progress: { overallPercent: 77 } });
    await t.app.close();
    apps.length = 0;
    const t2 = await setup({ root });
    expect((await t2.call<RecordDetail>("GET", `${A}/records/KEEP`)).status).toBe(200);
    expect((await t2.call<ActivityPage>("GET", `${A}/activity`)).body.items.some((e) => e.id === "EV-KEEP")).toBe(true);
    expect((await t2.call<ProgressResponse>("GET", `${A}/progress`)).body.overallPercent).toBe(77);
  });
});
