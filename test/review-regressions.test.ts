/** Regression tests for defects found in the independent backend review (2026-11-13). */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import ExcelJS from "exceljs";
import { makeApp, makeDataRoot, multipartBody, POST_HEADERS, question, task, writeJson } from "./helpers.js";
import { claimNext, completeAnswer, failAnswer, recoverExpiredLeases } from "../src/server/answers.js";
import { checkZipLimits } from "../src/server/xlsx.js";
import type { ImportPreview, RecordPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });
let n = 0;
const key = () => `regkey${Date.now()}${n++}`;

describe("review #1: encoded paths cannot bypass auth or CSRF", () => {
  it("guards %-encoded /api paths", async () => {
    const root = makeDataRoot();
    const tokenFile = path.join(root, "token.txt");
    fs.writeFileSync(tokenFile, "test-token-0123456789abcdef");
    const h = await makeApp(root, { auth: { mode: "token", tokenFile } });
    apps.push(h);
    for (const url of ["/%61pi/projects", "/%61pi/diagnostics", "/api/projects/alpha/attachments/ATT-1", "/%61pi/projects/alpha/attachments/ATT-1", "/API/projects"]) {
      const r = await h.app.inject(url);
      expect([401, 404], url).toContain(r.statusCode);
      expect(r.body).not.toMatch(/alpha/);
    }
    const noCsrf = await h.app.inject({ method: "POST", url: "/%61pi/admin/reindex" });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("review #2: upload metadata cannot point outside the upload folder", () => {
  it("ignores a meta file whose storedName is a path", async () => {
    const root = makeDataRoot();
    fs.writeFileSync(path.join(root, "SECRET.txt"), "top secret");
    writeJson(path.join(root, "projects", "alpha", "attachments", "answers", "UPL-X.meta.json"), {
      schemaVersion: 1, attachmentId: "UPL-X", storedName: "../../../../SECRET.txt", originalName: "x.txt", mimeType: "text/html",
      bytes: 10, sha256: "0".repeat(64), uploadedAt: "2026-11-01T00:00:00Z", uploadedBy: "x",
    });
    writeJson(path.join(root, "projects", "alpha", "attachments", "answers", "UPL-Y.meta.json"), {
      schemaVersion: 1, attachmentId: "UPL-Y", storedName: "UPL-Z.txt", originalName: "y.txt", mimeType: "text/html",
      bytes: 10, sha256: "0".repeat(64), uploadedAt: "2026-11-01T00:00:00Z", uploadedBy: "x",
    });
    const h = await makeApp(root);
    apps.push(h);
    for (const id of ["UPL-X", "UPL-Y"]) {
      const r = await h.app.inject(`/api/projects/alpha/attachments/${id}`);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toMatch(/top secret/);
    }
  });
});

describe("review #3: no absolute paths in API output", () => {
  it("diagnostics use project-relative paths", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    const body = (await h.app.inject("/api/diagnostics")).body;
    expect(body).not.toContain(root.replace(/\\/g, "\\\\"));
    expect(body).not.toMatch(/[A-Za-z]:\\\\/);
  });
});

describe("review #4: zip bomb check inflates instead of trusting headers", () => {
  it("rejects a workbook that inflates past the limit", async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.alloc(3 * 1024 * 1024, 0), "xl/worksheets/sheet1.xml");
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeLessThan(100 * 1024);
    await expect(checkZipLimits(buf, 500, 1024 * 1024)).rejects.toThrow(/too large/);
    await expect(checkZipLimits(buf, 500, 10 * 1024 * 1024)).resolves.toBeUndefined();
    void zlib;
  });
});

describe("review #5/#9: queue transitions are serialised", () => {
  it("complete and retry racing leave the answer in exactly one place", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    await h.app.inject({ method: "POST", url: "/api/projects/alpha/questions/Q1/answers", headers: POST_HEADERS, payload: JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }], idempotencyKey: key() }) });
    const p = h.store.get("alpha")!;
    const c = await claimNext(h.store, p, "w1");
    const res = await Promise.allSettled([
      completeAnswer(h.store, p, c!.answerId, "w1", "done"),
      failAnswer(h.store, p, c!.answerId, "w1", "oops", true),
      recoverExpiredLeases(h.store, p, new Date(Date.now() + 3_600_000)),
    ]);
    const okTransitions = res.slice(0, 2).filter((r) => r.status === "fulfilled").length;
    expect(okTransitions).toBe(1);
    const dirs = ["pending", "processing", "processed", "failed"].filter((d) =>
      fs.existsSync(path.join(p.dir, "communications", "answers", d, `${c!.answerId}.json`)));
    expect(dirs).toHaveLength(1);
  });

  it("claimNext recovers expired leases on its own", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    await h.app.inject({ method: "POST", url: "/api/projects/alpha/questions/Q1/answers", headers: POST_HEADERS, payload: JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }], idempotencyKey: key() }) });
    const p = h.store.get("alpha")!;
    const c = await claimNext(h.store, p, "crashed", 10);
    const file = path.join(p.dir, "communications", "answers", "processing", `${c!.answerId}.json`);
    const env = JSON.parse(fs.readFileSync(file, "utf8"));
    env.lease.expiresAt = "2020-01-01T00:00:00Z";
    fs.writeFileSync(file, JSON.stringify(env));
    const again = await claimNext(h.store, p, "fresh");
    expect(again?.answerId).toBe(c!.answerId);
    expect(again?.lease?.owner).toBe("fresh");
  });
});

describe("review #10: idempotent replay after the question moved on", () => {
  it("returns the original answer even when the record is now answered", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    const k = key();
    const body = JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }], idempotencyKey: k });
    const first = await h.app.inject({ method: "POST", url: "/api/projects/alpha/questions/Q2/answers", headers: POST_HEADERS, payload: body });
    const p = h.store.get("alpha")!;
    const f = p.records.get("Q2")!.file;
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), status: "answered" }));
    await h.store.applyChanges(p.dir, [path.relative(p.dir, f).replace(/\\/g, "/")]);
    const replay = await h.app.inject({ method: "POST", url: "/api/projects/alpha/questions/Q2/answers", headers: POST_HEADERS, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().answerId).toBe(first.json().answerId);
  });
});

describe("review #12: keyset pagination is stable under inserts", () => {
  it("a record inserted before the cursor does not repeat rows", async () => {
    const root = makeDataRoot();
    const h = await makeApp(root);
    apps.push(h);
    const p1 = (await h.app.inject("/api/projects/alpha/sections/qs/records?limit=3&sort=title")).json() as RecordPage;
    const p = h.store.get("alpha")!;
    const f = path.join(p.dir, "sections", "dev", "desk", "qs", "records", "AAA.json");
    writeJson(f, question("AAA", { title: "Aaa first" }));
    await h.store.applyChanges(p.dir, [path.relative(p.dir, f).replace(/\\/g, "/")]);
    const p2 = (await h.app.inject(`/api/projects/alpha/sections/qs/records?limit=3&sort=title&cursor=${p1.nextCursor}`)).json() as RecordPage;
    const ids1 = p1.items.map((i) => i.id);
    expect(p2.items.some((i) => ids1.includes(i.id))).toBe(false);
    expect(p2.items.map((i) => i.id)).not.toContain("AAA");
    void task;
  });
});

describe("review #7/#8: Excel option labels with commas and an option called Other", () => {
  it("imports the drop-down form of the label and prefers a real 'Other' option", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "beta", "sections", "backlog", "records", "QC.json"), question("QC", {
      answerSchema: { type: "single-choice", options: [{ id: "ship", label: "Yes, ship it" }, { id: "oth", label: "Other" }] },
    }));
    writeJson(path.join(root, "projects", "beta", "sections", "backlog", "records", "QO.json"), question("QO", {
      answerSchema: { type: "single-choice", options: [{ id: "ship", label: "Yes" }, { id: "oth", label: "Other" }] },
    }));
    const h = await makeApp(root);
    apps.push(h);
    const exp = await h.app.inject({ method: "POST", url: "/api/projects/beta/export/xlsx", headers: POST_HEADERS, payload: JSON.stringify({ questionIds: ["QC", "QO"] }) });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Answers")!;
    for (let r = 2; r <= ws.rowCount; r++) {
      const id = ws.getRow(r).getCell(2).value;
      if (id === "QC") ws.getRow(r).getCell(12).value = "Yes ship it";
      if (id === "QO") ws.getRow(r).getCell(12).value = "Other";
    }
    const mp = multipartBody([{ name: "file", filename: "a.xlsx", content: Buffer.from(await wb.xlsx.writeBuffer()) }]);
    const pv = (await h.app.inject({ method: "POST", url: "/api/projects/beta/import/xlsx/preview", payload: mp.payload, headers: mp.headers })).json() as ImportPreview;
    const qc = pv.rows.find((r) => r.questionId === "QC")!;
    const qo = pv.rows.find((r) => r.questionId === "QO")!;
    expect(qc.status).toBe("ready");
    expect(qc.answers![0]).toMatchObject({ optionIds: ["ship"] });
    expect(qo.status).toBe("ready");
    expect(qo.answers![0]).toMatchObject({ optionIds: ["oth"] });
  });
});
