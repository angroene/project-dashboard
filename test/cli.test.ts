/** The agent CLI (agent-kit/cli/apd.mjs) run as a real process against a listening server. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, PNG_1x1, POST_HEADERS, question, writeJson } from "./helpers.js";
import { tokenSha256 } from "../src/server/auth.js";

const CLI = path.resolve("agent-kit/cli/apd.mjs");
const OPERATOR = "operator-token-0123456789abcdef";
const AGENT = "agent-cli-token-0123456789abcdef";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
/** A local port with nothing listening (connections are refused). */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

async function server(opts: { auth?: boolean } = {}) {
  const root = makeDataRoot();
  const a = path.join(root, "projects", "alpha");
  const manifest = JSON.parse(fs.readFileSync(path.join(a, "project.json"), "utf8"));
  writeJson(path.join(a, "project.json"), { ...manifest, publishing: { enabled: true } });
  let extra: Record<string, unknown> = {};
  if (opts.auth) {
    const tokenFile = path.join(root, "op.txt");
    fs.writeFileSync(tokenFile, OPERATOR);
    const agentTokensFile = path.join(root, "agents.json");
    writeJson(agentTokensFile, { schemaVersion: 1, tokens: [{ name: "cli-agent", sha256: tokenSha256(AGENT), projects: ["alpha"], scopes: ["read", "publish", "consume"] }] });
    fs.writeFileSync(path.join(root, "agent-token.txt"), AGENT + "\n");
    extra = { auth: { mode: "token", tokenFile }, agentTokensFile };
  }
  const h = await makeApp(root, extra);
  apps.push(h);
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (h.app.server.address() as { port: number }).port;
  const work = fs.mkdtempSync(path.join(root, "agent-"));
  const env = {
    PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    APD_URL: `http://127.0.0.1:${port}`, APD_PROJECT: "alpha", APD_OWNER: "cli-worker", APD_OUTBOX: path.join(work, "outbox"),
    APD_RETRIES: "0", ...(opts.auth ? { APD_TOKEN_FILE: path.join(root, "agent-token.txt") } : {}),
  };
  const apd = (args: string[], envOver: Record<string, string> = {}) =>
    new Promise<{ code: number; out: Record<string, unknown>; err: Record<string, unknown> | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: work, env: { ...env, ...envOver }, timeout: 20000 }, (e, stdout, stderr) => {
        const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        const parse = (s: string) => { try { return JSON.parse(s.trim().split("\n").pop() ?? ""); } catch { return null; } };
        resolve({ code, out: parse(stdout) ?? {}, err: parse(stderr), stdout, stderr });
      });
    });
  const answerAsUser = async (qid: string, body: Record<string, unknown>) => {
    const headers: Record<string, string> = { ...POST_HEADERS, ...(opts.auth ? { authorization: `Bearer ${OPERATOR}` } : {}) };
    const r = await h.app.inject({ method: "POST", url: `/api/projects/alpha/questions/${qid}/answers`, headers, payload: JSON.stringify({ questionRevision: 1, idempotencyKey: `cli-${qid}-key01`, ...body }) });
    expect(r.statusCode).toBe(201);
    return r.json().answerId as string;
  };
  return { root, work, env, apd, answerAsUser, ...h };
}

describe("apd CLI", () => {
  it("runs the agent loop: ask, find the answer without reading the inbox, claim, complete, report", async () => {
    const s = await server({ auth: true });
    const cap = await s.apd(["capabilities"]);
    expect(cap.code).toBe(0);
    expect((cap.out.caller as { name: string }).name).toBe("cli-agent");

    const qFile = path.join(s.work, "q.json");
    fs.writeFileSync(qFile, JSON.stringify({ title: "Which storage format?", taskId: "T1", answerSchema: { type: "single-choice", options: [{ id: "json", label: "JSON" }, { id: "sqlite", label: "SQLite" }] } }));
    const ask = await s.apd(["ask", "--section", "qs", "--id", "Q-CLI-1", "--file", qFile]);
    expect(ask.code, ask.stderr).toBe(0);
    expect(ask.out).toMatchObject({ recordId: "Q-CLI-1", created: true });
    expect((await s.apd(["pending", "--count"])).out).toEqual({ count: 0, more: false });

    expect((await s.apd(["hint"])).stdout).toBe("");
    const offHint = await s.apd(["hint"], { APD_URL: `http://127.0.0.1:${await closedPort()}` });
    expect([offHint.code, offHint.stdout, offHint.stderr]).toEqual([0, "", ""]);

    const answerId = await s.answerAsUser("Q-CLI-1", { answers: [{ fieldId: "response", kind: "choice", optionIds: ["sqlite"] }] });
    const hint = await s.apd(["hint"]);
    expect(hint.code).toBe(0);
    expect(hint.stdout).toMatch(/^Agents Project Dashboard: 1 submitted answer\(s\) waiting in project alpha\./);
    const pending = await s.apd(["pending", "--task", "T1"]);
    expect(pending.out.items).toEqual([expect.objectContaining({ answerId, questionId: "Q-CLI-1" })]);
    expect((await s.apd(["pending", "--task", "T2"])).out.items).toEqual([]);

    const claim = await s.apd(["claim", answerId, "--lease", "120"]);
    expect(claim.out.claimed).toBe(true);
    expect((claim.out.answer as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "choice", optionIds: ["sqlite"] }]);
    expect((await s.apd(["claim"])).out).toEqual({ claimed: false });
    expect((await s.apd(["status", answerId])).out).toMatchObject({ processingState: "processing", attempts: 1 });
    expect((await s.apd(["complete", answerId, "--note", "switched to SQLite"])).code).toBe(0);
    expect((await s.apd(["status", answerId])).out).toMatchObject({ processingState: "processed", result: { note: "switched to SQLite" } });
    const again = await s.apd(["complete", answerId]);
    expect([again.code, again.err?.error]).toEqual([1, "wrong-state"]);

    expect((await s.apd(["update", "Q-CLI-1", "--status", "processed"])).code).toBe(0);
    expect((await s.apd(["update", "T1", "--status", "in-testing", "--percent", "70", "--note", "Storage switched", "--by", "cli-agent"])).code).toBe(0);
    expect((await s.apd(["event", "EV-CLI-1", "--action", "test", "--summary", "31 tests passed", "--status", "success", "--record", "T1"])).code).toBe(0);
    expect((await s.apd(["progress", "--percent", "45", "--label", "Release"])).code).toBe(0);

    const png = path.join(s.work, "shot.png");
    fs.writeFileSync(png, PNG_1x1);
    const up = await s.apd(["upload", png]);
    expect(up.code, up.stderr).toBe(0);
    const uploadId = (up.out.attachments as { attachmentId: string }[])[0].attachmentId;
    const issue = await s.apd(["publish", "--section", "tasks", "--id", "BUG-CLI", "--json", JSON.stringify({ recordType: "issue", title: "Save crashes", status: "open", severity: "major", attachments: [{ uploadId }] })]);
    expect(issue.code, issue.stderr).toBe(0);
    const dl = await s.apd(["download", uploadId, "--out", "copy.png"]);
    expect(dl.code).toBe(0);
    expect(Buffer.compare(fs.readFileSync(path.join(s.work, "copy.png")), PNG_1x1)).toBe(0);

    const src = await s.apd(["source", "T1"]);
    expect((src.out.record as { status: string; percent: number }).status).toBe("in-testing");
    expect((src.out.record as { history: { text: string }[] }).history.at(-1)!.text).toBe("Storage switched");
  });

  it("accepts a JSON file with a UTF-8 byte order mark (as Windows PowerShell 5.1 writes them)", async () => {
    const s = await server({ auth: true });
    const f = path.join(s.work, "bom.json");
    fs.writeFileSync(f, "﻿" + JSON.stringify({ title: "Written by PowerShell", taskId: "T1", answerSchema: { type: "free-text" } }), "utf8");
    const r = await s.apd(["ask", "--section", "qs", "--id", "Q-BOM-1", "--file", f]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ recordId: "Q-BOM-1", created: true });
  });

  it("never prints or stores the token", async () => {
    const s = await server({ auth: true });
    const outputs = [await s.apd(["projects"]), await s.apd(["capabilities"]), await s.apd(["update", "NOPE", "--status", "done"])];
    for (const o of outputs) expect(o.stdout + o.stderr).not.toContain(AGENT);
    const off = await s.apd(["update", "T1", "--status", "done"], { APD_URL: `http://127.0.0.1:${await closedPort()}` });
    expect(off.code).toBe(3);
    const files = fs.readdirSync(path.join(s.work, "outbox"));
    for (const f of files) expect(fs.readFileSync(path.join(s.work, "outbox", f), "utf8")).not.toContain(AGENT);
  });

  it("queues publish calls while the server is unreachable and delivers them with flush", async () => {
    const s = await server();
    const offline = { APD_URL: `http://127.0.0.1:${await closedPort()}` };
    const u = await s.apd(["update", "T1", "--status", "done", "--note", "finished offline"], offline);
    expect(u.code).toBe(3);
    expect(u.err).toMatchObject({ ok: false, error: "unavailable" });
    expect(u.err?.queued).toMatch(/\.json$/);
    const ev = await s.apd(["event", "EV-OFF", "--action", "build", "--summary", "built offline"], offline);
    expect(ev.code).toBe(3);
    const bad = await s.apd(["update", "T2", "--status", "not-a-status"], offline);
    expect(bad.code).toBe(3);
    const claim = await s.apd(["claim"], offline);
    expect([claim.code, claim.err?.error]).toEqual([3, "unavailable"]);
    expect((await s.apd(["outbox"])).out.queued).toHaveLength(3);

    const f = await s.apd(["flush"]);
    expect(f.code).toBe(0);
    expect(f.out).toMatchObject({ remaining: 0 });
    expect(f.out.delivered).toHaveLength(2);
    expect(f.out.rejected).toEqual([expect.objectContaining({ error: "validation" })]);
    expect(fs.readdirSync(path.join(s.work, "outbox", "rejected"))).toHaveLength(1);
    const src = (await s.apd(["source", "T1"])).out.record as { status: string; history: { text: string }[] };
    expect(src.status).toBe("done");
    // Replaying the same queued update again must not duplicate its history entry.
    expect(src.history.filter((h) => h.text === "finished offline")).toHaveLength(1);
    expect((await s.apd(["flush"])).out).toMatchObject({ delivered: [], remaining: 0 });
  });

  it("reports rejections with field errors, and usage errors with exit code 2", async () => {
    const s = await server();
    const r = await s.apd(["publish", "--section", "tasks", "--id", "X", "--json", JSON.stringify({ recordType: "task", title: "t", status: "shipped" })]);
    expect(r.code).toBe(1);
    expect(r.err).toMatchObject({ error: "validation", status: 422, fieldErrors: [expect.objectContaining({ fieldId: "status" })] });
    expect((await s.apd(["publish", "--id", "X", "--json", "{}"])).code).toBe(2);
    expect((await s.apd(["ask", "--section", "qs", "--id", "X", "--json", "not json"])).code).toBe(2);
    expect((await s.apd(["frobnicate"])).code).toBe(2);
    expect((await s.apd(["projects"], { APD_TOKEN_FILE: path.join(s.work, "missing.txt") })).code).toBe(2);
    const help = await s.apd(["help"]);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("usage: apd")]);
  });

  it("fail with --retry returns the answer to pending; a final failure lets the user answer again", async () => {
    const s = await server();
    writeJson(path.join(s.root, "projects", "alpha", "sections", "dev", "desk", "qs", "records", "QF.json"), question("QF"));
    await s.app.inject({ method: "POST", url: "/api/admin/reindex", headers: POST_HEADERS, payload: "{}" });
    const answerId = await s.answerAsUser("QF", { answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }] });
    expect((await s.apd(["claim"])).out.claimed).toBe(true);
    expect((await s.apd(["fail", answerId, "--reason", "repo locked", "--retry"])).out).toMatchObject({ processingState: "pending" });
    expect((await s.apd(["claim"])).out.claimed).toBe(true);
    expect((await s.apd(["fail", answerId, "--reason", "cannot apply"])).out).toMatchObject({ processingState: "failed", attempts: 2 });
    const d = (await s.app.inject("/api/projects/alpha/records/QF")).json();
    expect(d.question.uiState).toBe("failed");
  });
});

describe("apd CLI: tracked fields, external references, listing, templates", () => {
  async function withFields() {
    const s = await server({ auth: true });
    const a = path.join(s.root, "projects", "alpha", "sections", "dev", "work");
    writeJson(path.join(a, "reviews", "section.json"), { schemaVersion: 1, id: "reviews", displayType: "expandable-card", title: "Reviews", fields: [
      { id: "built", label: "Built", type: "checkbox", editableBy: ["agent"], filter: true },
      { id: "reviewed", label: "Reviewed", type: "checkbox", editableBy: ["user"] },
      { id: "note", label: "Note", type: "text" },
    ] });
    writeJson(path.join(a, "reviews", "records", "R1.json"), { schemaVersion: 1, id: "R1", recordType: "review", title: "R1", status: "needs-review", updatedAt: "2026-11-01T10:00:00Z" });
    writeJson(path.join(a, "reviews", "records", "R2.json"), { schemaVersion: 1, id: "R2", recordType: "review", title: "R2", status: "needs-review", updatedAt: "2026-11-01T10:00:00Z" });
    writeJson(path.join(a, "reviews", "templates", "daily.json"), { schemaVersion: 1, id: "daily", title: "Daily", state: "paused",
      schedule: { frequency: "daily", timezone: "UTC", startDate: "2026-11-01" }, record: { recordType: "review", status: "needs-review" } });
    const re = await s.app.inject({ method: "POST", url: "/api/admin/reindex", headers: { ...POST_HEADERS, authorization: `Bearer ${OPERATOR}` }, payload: "{}" });
    expect(re.statusCode).toBe(200);
    return s;
  }

  it("sets agent fields and external references, and lists filtered summaries", async () => {
    const s = await withFields();
    const refs = path.join(s.work, "refs.json");
    fs.writeFileSync(refs, "﻿" + JSON.stringify([{ system: "ci", id: "build-41", url: "https://ci.example/41", status: "passed" }]));
    const up = await s.apd(["update", "R1", "--field", "built=true", "--field", "note=green on main", "--external", refs]);
    expect(up.code, up.stderr).toBe(0);
    const list = await s.apd(["list", "--section", "reviews", "--field", "built=true"]);
    expect(list.code, list.stderr).toBe(0);
    const items = list.out.items as { id: string; fields: Record<string, unknown>; external: { id: string }[] }[];
    expect(items.map((i) => i.id)).toEqual(["R1"]);
    expect(items[0].fields).toEqual({ built: true, note: "green on main" });
    expect(items[0].external[0].id).toBe("build-41");
    const clear = await s.apd(["update", "R1", "--field", "note=none"]);
    expect(clear.code).toBe(0);
    const none = await s.apd(["list", "--section", "reviews", "--field", "built="]);
    expect((none.out.items as { id: string }[]).map((i) => i.id)).toEqual(["R2"]);
  });

  it("is refused for user-only fields and stale revisions; bad flags are usage errors", async () => {
    const s = await withFields();
    const user = await s.apd(["update", "R1", "--field", "reviewed=true"]);
    expect(user.code).toBe(1);
    expect(user.err?.error).toBe("field-not-editable");
    const stale = await s.apd(["update", "R1", "--field", "built=true", "--if-revision", "0000000000000000"]);
    expect(stale.code).toBe(1);
    expect(stale.err?.error).toBe("revision-mismatch");
    expect((await s.apd(["update", "R1", "--field", "built"])).code).toBe(2);
    expect((await s.apd(["list"])).code).toBe(2);
  });

  it("lists templates", async () => {
    const s = await withFields();
    const r = await s.apd(["templates"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.out.templates).toMatchObject([{ id: "daily", sectionId: "reviews", state: "paused" }]);
  });
});
