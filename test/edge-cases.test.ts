/** Failure and invalid-input behaviour: schema versions, timestamps, progress, export safety, crash recovery. */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, POST_HEADERS, question, task, writeJson } from "./helpers.js";
import type { ProjectCard, RecordPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });
const tasksDir = (root: string) => path.join(root, "projects", "alpha", "sections", "dev", "work", "tasks", "records");

describe("invalid input files", () => {
  it("rejects unsupported schema versions and invalid timestamps with a diagnostic, keeping valid siblings", async () => {
    const root = makeDataRoot();
    writeJson(path.join(tasksDir(root), "V2.json"), task("V2", { schemaVersion: 2 }));
    writeJson(path.join(tasksDir(root), "TS.json"), task("TS", { updatedAt: "yesterday" }));
    writeJson(path.join(tasksDir(root), "TZ.json"), task("TZ", { updatedAt: "2026-11-01T10:00:00" })); // no offset
    const h = await makeApp(root);
    apps.push(h);
    const ids = ((await h.app.inject("/api/projects/alpha/sections/tasks/records?status=all")).json() as RecordPage).items.map((i) => i.id);
    expect(ids).toContain("T1");
    expect(ids).not.toContain("V2");
    expect(ids).not.toContain("TS");
    expect(ids).not.toContain("TZ");
    const diag = JSON.stringify((await h.app.inject("/api/diagnostics")).json());
    for (const f of ["V2.json", "TS.json", "TZ.json"]) expect(diag).toContain(f);
  });

  it("never fabricates progress: missing or invalid progress is 'not reported'", async () => {
    const root = makeDataRoot();
    fs.rmSync(path.join(root, "projects", "beta", "progress.json"), { force: true });
    writeJson(path.join(root, "projects", "alpha", "progress.json"), { schemaVersion: 1, overallPercent: 140, updatedAt: "2026-11-01T10:00:00Z" });
    const h = await makeApp(root);
    apps.push(h);
    const cards = (await h.app.inject("/api/projects")).json().projects as ProjectCard[];
    for (const c of cards.filter((x) => x.id === "alpha" || x.id === "beta")) expect(c.progress.overallPercent).toBeNull();
    expect(JSON.stringify((await h.app.inject("/api/diagnostics")).json())).toMatch(/progress\.json/);
  });

  it("a deleted attachment returns 404 and is reported unavailable in detail", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    fs.rmSync(path.join(root, "projects", "alpha", "attachments", "documents", "adr-1.md"));
    expect((await h.app.inject("/api/projects/alpha/attachments/ATT-1")).statusCode).toBe(404);
    const det = (await h.app.inject("/api/projects/alpha/records/T1")).json();
    expect(JSON.stringify(det)).toMatch(/"available":false/);
  });

  it("unexpected errors return a generic 500 without stack traces or paths", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    const p = h.store.get("alpha")!;
    const orig = h.store.summary.bind(h.store);
    h.store.summary = () => { throw new Error(`boom at ${p.dir}`); };
    try {
      const r = await h.app.inject("/api/projects/alpha/sections/tasks/records");
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toContain(p.dir);
      expect(r.body).not.toMatch(/at .*\.ts:\d+/);
    } finally {
      h.store.summary = orig;
    }
  });
});

describe("export safety", () => {
  it("writes formula-looking text as plain strings, never as formulas", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "desk", "qs", "records", "QF.json"),
      question("QF", { title: "=HYPERLINK(\"http://example.invalid\",\"click\")", summary: "+cmd|' /C calc'!A0" }));
    const h = await makeApp(root);
    apps.push(h);
    const exp = await h.app.inject({ method: "POST", url: "/api/projects/alpha/export/xlsx", headers: POST_HEADERS, payload: JSON.stringify({ questionIds: ["QF"] }) });
    expect(exp.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Answers")!;
    let seen = 0;
    ws.eachRow((row) => row.eachCell((cell) => {
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      if (String(cell.value).includes("HYPERLINK")) seen++;
    }));
    expect(seen).toBeGreaterThan(0);
  });
});

describe("crash recovery", () => {
  it("a staged answer with a claim is published on restart; an orphan is removed; partial temp files are ignored", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    const res = await h.app.inject({ method: "POST", url: "/api/projects/alpha/questions/Q1/answers", headers: POST_HEADERS,
      payload: JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }], idempotencyKey: "crash-key-0001" }) });
    expect(res.statusCode).toBe(201);
    const answerId = res.json().answerId as string;
    const p = h.store.get("alpha")!;
    await h.app.close();
    const ans = path.join(p.dir, "communications", "answers");
    // Simulate a crash between staging and publish: move the answer back to staging, add an orphan and a torn temp file.
    fs.mkdirSync(path.join(ans, ".staging"), { recursive: true });
    fs.renameSync(path.join(ans, "pending", `${answerId}.json`), path.join(ans, ".staging", `${answerId}.json`));
    fs.writeFileSync(path.join(ans, ".staging", "ANS-ORPHAN-000000000000.json"), "{}");
    fs.writeFileSync(path.join(ans, "pending", `${answerId}.json.tmp-123`), "{\"trunc");
    const h2 = await makeApp(root);
    apps.push(h2);
    expect(fs.existsSync(path.join(ans, "pending", `${answerId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(ans, ".staging", "ANS-ORPHAN-000000000000.json"))).toBe(false);
    const list = await h2.app.inject("/api/projects/alpha/queue?state=pending");
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(answerId);
    expect(JSON.stringify(list.json())).not.toContain("tmp-123");
  });
});
