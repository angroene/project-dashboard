/** Attention groups (questions, actions, responses, updates) and daily Yes / No values from recurring templates. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeDataRoot, POST_HEADERS, question, section, task, writeJson } from "./helpers.js";
import { tokenSha256 } from "../src/server/auth.js";
import { currentDate, runRecurrence } from "../src/server/recurrence.js";
import type { AttentionPage, AttentionResponse, ProjectCard, RecordDetail, TemplateCurrent } from "../src/shared/api.js";
import { RecurringTemplate } from "../src/shared/schemas.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (apps.length) await apps.pop()!.app.close();
});

const OPERATOR = "operator-token-0123456789abcdef";
const READER = "agent-read-token-0123456789abc";
const PUB = "agent-publish-token-0123456789";
const OTHER = "agent-other-project-token-0123";
const A = "/api/projects/alpha";

function dataRoot(): string {
  const root = makeDataRoot();
  const a = path.join(root, "projects", "alpha");
  const manifest = JSON.parse(fs.readFileSync(path.join(a, "project.json"), "utf8"));
  writeJson(path.join(a, "project.json"), { ...manifest, publishing: { enabled: true, sections: ["tasks", "qs", "tonight"] } });
  const tasks = path.join(a, "sections", "dev", "work", "tasks", "records");
  writeJson(path.join(tasks, "ACT-1.json"), task("ACT-1", { status: "planned", requiresAction: true, title: "Plug in the rig" }));
  writeJson(path.join(tasks, "ACT-2.json"), task("ACT-2", { status: "done", requiresAction: true, title: "Rig already plugged in" }));
  writeJson(path.join(a, "sections", "dev", "desk", "qs", "records", "QACT.json"), question("QACT", { requiresAction: true, title: "Confirm the rig is on" }));
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
        { name: "alpha-reader", sha256: tokenSha256(READER), projects: ["alpha"], scopes: ["read"] },
        { name: "alpha-publisher", sha256: tokenSha256(PUB), projects: ["alpha"], scopes: ["read", "publish"] },
        { name: "beta-reader", sha256: tokenSha256(OTHER), projects: ["beta"], scopes: ["read"] },
      ],
    });
    extra = { auth: { mode: "required", tokenFile }, agentTokensFile };
  }
  const h = await makeApp(root, extra);
  apps.push(h);
  const call = async <T = Record<string, unknown>>(method: string, url: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = method === "GET" ? {} : { ...POST_HEADERS };
    const tok = token ?? (opts.auth ? OPERATOR : undefined);
    if (tok) headers.authorization = `Bearer ${tok}`;
    const r = await h.app.inject({ method: method as "GET", url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, body: (r.body ? r.json() : null) as T };
  };
  return { root, ...h, call };
}

const groupIds = async (t: Awaited<ReturnType<typeof setup>>, g: string, all = false) =>
  (await t.call<AttentionPage>("GET", `${A}/attention/${g}?limit=100${all ? "&all=1" : ""}`)).body.items.map((r) => r.id).sort();

describe("attention groups", () => {
  it("counts each pending record in one group; Show all adds history; the project card counts only what needs action", async () => {
    const t = await setup();
    const att = (await t.call<AttentionResponse>("GET", `${A}/attention`)).body;
    // Q1..Q5, QTEXT, QAPP, QFILE, QCOMP await an answer; QACT is an action question; ACT-1 is an open action.
    expect(att.counts).toEqual({ questions: 9, actions: 2, responses: 0, updates: 1 });
    expect(att.totals).toEqual({ questions: 9, actions: 3, responses: 1, updates: 1 });
    expect(att.unreadActivity).toBe(2);
    // Existing fields are unchanged for older clients.
    expect(att.questions.map((r) => r.id)).toContain("QACT");
    expect(att.unreadRecords.map((r) => r.id)).toEqual(["T1"]);

    expect(await groupIds(t, "actions")).toEqual(["ACT-1", "QACT"]);
    expect(await groupIds(t, "actions", true)).toEqual(["ACT-1", "ACT-2", "QACT"]);
    expect(await groupIds(t, "questions")).not.toContain("QACT");
    expect(await groupIds(t, "responses", true)).toEqual(["QINFO"]);
    expect(await groupIds(t, "updates")).toEqual(["T1"]);
    const acts = (await t.call<AttentionPage>("GET", `${A}/attention/actions?all=1`)).body.items;
    expect(acts.find((r) => r.id === "ACT-1")).toMatchObject({ requiresAction: true, actionOutstanding: true });
    expect(acts.find((r) => r.id === "ACT-2")).toMatchObject({ requiresAction: true, actionOutstanding: false });
    // Pending items come first in Show all.
    expect(acts.map((r) => r.id).indexOf("ACT-2")).toBe(2);

    const card = (await t.call<ProjectCard>("GET", A)).body;
    expect(card.awaitingResponse).toBe(10);
    expect(card.outstandingActions).toBe(2);
    expect(card.requireAttention).toBe(11);
    expect(card.unreadUpdates).toBe(3);
  });

  it("marking read changes read state only: it never answers a question or completes an action", async () => {
    const t = await setup();
    const r = await t.call("POST", `${A}/records/mark-read`, { recordIds: ["T1", "Q1", "QACT", "ACT-1"] });
    expect(r.status).toBe(200);
    const att = (await t.call<AttentionResponse>("GET", `${A}/attention`)).body;
    expect(att.counts).toEqual({ questions: 9, actions: 2, responses: 0, updates: 0 });
    expect(await groupIds(t, "updates", true)).toEqual(["T1"]);
    expect((await t.call<RecordDetail>("GET", `${A}/records/Q1`)).body.question?.uiState).toBe("needs-response");
  });

  it("an answered question leaves the pending list but stays in Show all; an answered action question is completed", async () => {
    const t = await setup();
    for (const id of ["Q1", "QACT"]) {
      const res = await t.call("POST", `${A}/questions/${id}/answers`, { questionRevision: 1, idempotencyKey: `answer-${id}-0001`, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect(await groupIds(t, "questions")).not.toContain("Q1");
    expect(await groupIds(t, "questions", true)).toContain("Q1");
    expect(await groupIds(t, "actions")).toEqual(["ACT-1"]);
    const card = (await t.call<ProjectCard>("GET", A)).body;
    expect(card.outstandingActions).toBe(1);
    expect(card.requireAttention).toBe(9);
    // An agent completing a non-question action through its status.
    expect((await t.call("PATCH", `${A}/records/ACT-1`, { status: "done" })).status).toBe(200);
    expect(await groupIds(t, "actions")).toEqual([]);
    expect((await t.call<ProjectCard>("GET", A)).body.outstandingActions).toBe(0);
    // requiresAction can be switched off and on by an agent.
    expect((await t.call("PATCH", `${A}/records/T2`, { requiresAction: true })).status).toBe(200);
    expect(await groupIds(t, "actions")).toEqual(["T2"]);
  });

  it("pages with a keyset cursor: every record once, even when one is added between pages", async () => {
    const t = await setup();
    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const pg: { body: AttentionPage } = await t.call<AttentionPage>("GET", `${A}/attention/questions?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...pg.body.items.map((r) => r.id));
      cursor = pg.body.nextCursor;
      if (first) {
        first = false;
        writeJson(path.join(t.root, "projects", "alpha", "sections", "dev", "desk", "qs", "records", "QNEW.json"), question("QNEW", { updatedAt: "2026-11-05T00:00:00Z" }));
        await t.call("POST", "/api/admin/reindex", {});
      }
    } while (cursor);
    const originals = ["Q1", "Q2", "Q3", "Q4", "Q5", "QAPP", "QCOMP", "QFILE", "QTEXT"];
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of originals) expect(seen).toContain(id);
  });

  it("rejects an unknown group and lets read-scoped agents use the groups of their own project only", async () => {
    const t = await setup({ auth: true });
    expect((await t.call("GET", `${A}/attention/everything`)).status).toBe(400);
    expect((await t.call("GET", `${A}/attention/questions`, undefined, READER)).status).toBe(200);
    expect((await t.call("GET", `${A}/attention/questions`, undefined, OTHER)).status).toBe(404);
  });
});

// ------------------------------------------------------------ daily yes/no --
const FIELD = { id: "answer", label: "Testing tonight?", type: "yes-no", editableBy: ["user"] };

function yesNoTemplate(defaultYes: boolean, schedule: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id: "tonight", title: "Tonight", state: "active",
    schedule: { frequency: "daily", time: "06:00", timezone: "Europe/Berlin", startDate: "2026-11-01", ...schedule },
    record: { recordType: "generic", title: "Testing tonight? {date}", status: "open", fields: { answer: defaultYes } },
    ...extra,
  };
}

function dailyRoot(tpl: Record<string, unknown>): string {
  const root = dataRoot();
  const dir = path.join(root, "projects", "alpha", "sections", "dev", "work", "tonight");
  writeJson(path.join(dir, "section.json"), section("tonight", "expandable-card", "Testing tonight?", { fields: [FIELD] }));
  writeJson(path.join(dir, "templates", "tonight.json"), tpl);
  return root;
}

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

describe("daily yes / no values", () => {
  it("a daily choice works the same way: the template's option is in effect untouched, a tap sets another, the next day resets", async () => {
    const root = dataRoot();
    const dir = path.join(root, "projects", "alpha", "sections", "dev", "work", "tonight");
    const plan = { id: "plan", label: "Tonight's plan", type: "choice", editableBy: ["user"], options: [{ id: "test", label: "Play-test" }, { id: "off", label: "Night off" }] };
    writeJson(path.join(dir, "section.json"), section("tonight", "expandable-card", "Tonight", { pinned: true, fields: [plan] }));
    writeJson(path.join(dir, "templates", "tonight.json"), { ...yesNoTemplate(true), record: { recordType: "generic", title: "Tonight {date}", status: "open", fields: { plan: "test" } } });
    const t = await setup({ root });
    at("2026-11-10T07:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ recordExists: false, fields: { plan: "test" }, labels: { plan: "Play-test" } });
    await runRecurrence(t.store, "alpha", new Date());
    expect((await t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { plan: "off" } })).status).toBe(200);
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ fields: { plan: "off" }, labels: { plan: "Night off" } });
    expect((await t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { plan: "maybe" } })).status).toBe(422);
    at("2026-11-11T05:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: "2026-11-11", fields: { plan: "test" } });
  });

  it.each([true, false])("default %s is the effective value from the reset time on, before the scheduler runs and without anyone answering", async (dflt) => {
    const t = await setup({ root: dailyRoot(yesNoTemplate(dflt)) });
    // 05:30 UTC = 06:30 in Berlin (CET): today's day has begun, its record does not exist yet.
    at("2026-11-10T05:30:00Z");
    const cur = (await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body;
    expect(cur).toEqual({
      templateId: "tonight", sectionId: "tonight", state: "active", date: "2026-11-10", recordId: "tonight-2026-11-10",
      recordExists: false, fields: { answer: dflt }, labels: { answer: dflt ? "yes" : "no" },
    });
    // The scheduler then creates the record with the same value: nothing changes for the reader.
    expect((await runRecurrence(t.store, "alpha", new Date())).created).toEqual(["tonight-2026-11-10"]);
    const after = (await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body;
    expect(after).toMatchObject({ recordExists: true, fields: { answer: dflt } });
    expect((await t.call<RecordDetail>("GET", `${A}/records/tonight-2026-11-10`)).body.history).toEqual([]);
  });

  it("switches day exactly at the reset time (05:59 still yesterday, 06:00 today)", async () => {
    const t = await setup({ root: dailyRoot(yesNoTemplate(true)) });
    at("2026-11-10T04:59:59Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body.date).toBe("2026-11-09");
    at("2026-11-10T05:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body.date).toBe("2026-11-10");
  });

  it("a tap saves at once for that day only; the next day resets to the default; earlier days are kept; a restart keeps it", async () => {
    const root = dailyRoot(yesNoTemplate(true));
    const t = await setup({ root });
    at("2026-11-10T07:00:00Z");
    await runRecurrence(t.store, "alpha", new Date());
    const up = await t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { answer: false } });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: "2026-11-10", fields: { answer: false }, labels: { answer: "no" } });
    const hist = (await t.call<RecordDetail>("GET", `${A}/records/tonight-2026-11-10`)).body.history;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ by: "user" });

    at("2026-11-11T05:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: "2026-11-11", recordExists: false, fields: { answer: true } });
    await runRecurrence(t.store, "alpha", new Date());
    expect((await t.call<RecordDetail>("GET", `${A}/records/tonight-2026-11-11`)).body.fields).toEqual({ answer: true });
    expect((await t.call<RecordDetail>("GET", `${A}/records/tonight-2026-11-10`)).body.fields).toEqual({ answer: false });
    // The template default is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(root, "projects", "alpha", "sections", "dev", "work", "tonight", "templates", "tonight.json"), "utf8")).record.fields).toEqual({ answer: true });

    // Restart: same values from disk.
    const again = await setup({ root });
    at("2026-11-11T12:00:00Z");
    expect((await again.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: "2026-11-11", recordExists: true, fields: { answer: true } });
    at("2026-11-10T20:00:00Z");
    expect((await again.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: "2026-11-10", fields: { answer: false } });
  });

  it("concurrent taps are serialised: every request succeeds, one record, the last stored value is what agents read", async () => {
    const t = await setup({ root: dailyRoot(yesNoTemplate(true)) });
    at("2026-11-10T07:00:00Z");
    const ran = Promise.all([runRecurrence(t.store, "alpha", new Date()), runRecurrence(t.store, "alpha", new Date())]);
    await ran;
    const values = [false, true, false, false, true, false];
    const res = await Promise.all(values.map((v) => t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { answer: v } })));
    expect(res.map((r) => r.status)).toEqual(values.map(() => 200));
    const files = fs.readdirSync(path.join(t.root, "projects", "alpha", "sections", "dev", "work", "tonight", "records"));
    expect(files).toEqual(["tonight-2026-11-10.json"]);
    const stored = JSON.parse(fs.readFileSync(path.join(t.root, "projects", "alpha", "sections", "dev", "work", "tonight", "records", files[0]!), "utf8"));
    const cur = (await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body;
    expect(cur.fields.answer).toBe(stored.fields.answer);
    // Each actual change is in the history once.
    const changes = (stored.history as unknown[]).length;
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(changes).toBeLessThanOrEqual(values.length);
  });

  it("validates yes-no values and who may set them", async () => {
    const t = await setup({ auth: true, root: dailyRoot(yesNoTemplate(true)) });
    at("2026-11-10T07:00:00Z");
    await runRecurrence(t.store, "alpha", new Date());
    expect((await t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { answer: "yes" } })).status).toBe(422);
    // Agents read the value; only the user sets it here (editableBy: user).
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`, undefined, READER)).body.fields).toEqual({ answer: true });
    expect((await t.call("GET", `${A}/templates/tonight/current`, undefined, OTHER)).status).toBe(404);
    expect((await t.call("POST", `${A}/records/tonight-2026-11-10/user-update`, { fields: { answer: false } }, PUB)).status).toBe(403);
    const patch = await t.call("PATCH", `${A}/records/tonight-2026-11-10`, { fields: { answer: false } }, PUB);
    expect([403, 422]).toContain(patch.status);
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`, undefined, READER)).body.fields).toEqual({ answer: true });
    expect((await t.call("GET", `${A}/templates/nope/current`, undefined, READER)).status).toBe(404);
  });

  it("reports no current day before startDate or after endDate, and the default while paused", async () => {
    const t = await setup({ root: dailyRoot(yesNoTemplate(false, { startDate: "2026-11-20", endDate: "2026-11-25" })) });
    at("2026-11-19T12:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ date: null, recordId: null, fields: {} });
    at("2026-11-26T12:00:00Z");
    expect((await t.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body.date).toBeNull();
    const p = await setup({ root: dailyRoot(yesNoTemplate(true, {}, { state: "paused" })) });
    at("2026-11-10T12:00:00Z");
    expect((await p.call<TemplateCurrent>("GET", `${A}/templates/tonight/current`)).body).toMatchObject({ state: "paused", date: "2026-11-10", recordExists: false, fields: { answer: true } });
  });
});

describe("currentDate", () => {
  const tpl = (time: string, timezone = "Europe/Berlin") => RecurringTemplate.parse({
    schemaVersion: 1, id: "x", title: "x", schedule: { frequency: "daily", time, timezone, startDate: "2026-01-01" }, record: { recordType: "generic", status: "open" },
  });
  it.each([
    // [time, now (UTC), expected local date]
    ["00:00", "2026-11-09T22:59:59Z", "2026-11-09"], // 23:59:59 CET
    ["00:00", "2026-11-09T23:00:00Z", "2026-11-10"], // midnight
    ["23:59", "2026-11-10T22:58:00Z", "2026-11-09"], // 23:58
    ["23:59", "2026-11-10T22:59:00Z", "2026-11-10"], // 23:59
    // Fall back (2026-10-25, 03:00 CEST -> 02:00 CET): 02:30 happens twice; the first one starts the day.
    ["02:30", "2026-10-25T00:29:00Z", "2026-10-24"],
    ["02:30", "2026-10-25T00:30:00Z", "2026-10-25"],
    ["02:30", "2026-10-25T01:30:00Z", "2026-10-25"],
    // Spring forward (2026-03-29, 02:00 CET -> 03:00 CEST): 02:30 does not exist; the day starts at the jump.
    ["02:30", "2026-03-29T00:59:00Z", "2026-03-28"],
    ["02:30", "2026-03-29T01:00:00Z", "2026-03-29"],
  ])("time %s at %s is day %s", (time, now, want) => {
    expect(currentDate(tpl(time), new Date(now))).toBe(want);
  });
  it("uses the template's time zone, not the server's", () => {
    expect(currentDate(tpl("06:00", "Pacific/Honolulu"), new Date("2026-11-10T15:59:00Z"))).toBe("2026-11-09");
    expect(currentDate(tpl("06:00", "Pacific/Honolulu"), new Date("2026-11-10T16:00:00Z"))).toBe("2026-11-10");
  });
});
