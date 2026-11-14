/** The in-memory index must not hide writes the server just made (read-after-write through the API). */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, multipartBody, PNG_1x1, POST_HEADERS, task, writeJson } from "./helpers.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

async function setup() {
  const root = makeDataRoot();
  const h = await makeApp(root);
  apps.push(h);
  return { root, ...h };
}

describe("index consistency", () => {
  it("a mixed batch of data-file changes is applied in place, without rebuilding the project object", async () => {
    const t = await setup();
    const before = t.store.get("alpha")!;
    const dir = before.dir;
    writeJson(path.join(dir, "sections", "dev", "work", "tasks", "records", "T9.json"), task("T9"));
    writeJson(path.join(dir, "activity", "events", "E9.json"), { schemaVersion: 1, id: "E9", at: "2026-11-03T10:00:00Z", action: "x", summary: "nine" });
    writeJson(path.join(dir, "progress.json"), { schemaVersion: 1, overallPercent: 91, updatedAt: "2026-11-03T10:00:00Z" });
    await t.store.applyChanges(dir, [
      "sections/dev/work/tasks/records/T9.json", "activity/events/E9.json", "progress.json", "communications/answers/pending",
    ]);
    const after = t.store.get("alpha")!;
    expect(after).toBe(before);
    expect(after.records.has("T9")).toBe(true);
    expect(after.activity.some((e) => e.id === "E9")).toBe(true);
    expect(after.progress.overallPercent).toBe(91);
  });

  it("a structural change still rebuilds the project", async () => {
    const t = await setup();
    const before = t.store.get("alpha")!;
    writeJson(path.join(before.dir, "sections", "dev", "work", "more", "section.json"), { schemaVersion: 1, id: "more", displayType: "expandable-card", title: "More" });
    await t.store.applyChanges(before.dir, ["sections/dev/work/more/section.json", "progress.json"]);
    const after = t.store.get("alpha")!;
    expect(after).not.toBe(before);
    expect(after.sections.has("more")).toBe(true);
  });

  it("an upload missing from the index (index not caught up yet) can still be answered with and downloaded", async () => {
    const t = await setup();
    const mp = multipartBody([{ name: "questionId", value: "QFILE" }, { name: "file", filename: "art.png", content: PNG_1x1, type: "image/png" }]);
    const up = await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", payload: mp.payload, headers: mp.headers });
    const id = up.json().attachments[0].attachmentId as string;
    t.store.get("alpha")!.uploads.delete(id); // simulate a re-read of the upload folder that started before the upload
    const dl = await t.app.inject(`/api/projects/alpha/attachments/${id}`);
    expect(dl.statusCode).toBe(200);
    t.store.get("alpha")!.uploads.delete(id);
    const a = await t.app.inject({
      method: "POST", url: "/api/projects/alpha/questions/QFILE/answers", headers: POST_HEADERS,
      payload: JSON.stringify({ questionRevision: 1, idempotencyKey: "consistency-01", answers: [{ fieldId: "response", kind: "files", attachmentIds: [id] }] }),
    });
    expect(a.statusCode).toBe(201);
    expect(t.store.get("alpha")!.uploads.has(id)).toBe(true);
    // A forged id still fails: the fallback only reads a valid sidecar named after the id.
    const forged = await t.app.inject(`/api/projects/alpha/attachments/UPL-NOT-THERE`);
    expect(forged.statusCode).toBe(404);
  });

  it("an answer missing from the claim index is still listed with its question, also under a filter", async () => {
    const t = await setup();
    const s = await t.app.inject({
      method: "POST", url: "/api/projects/alpha/questions/Q2/answers", headers: POST_HEADERS,
      payload: JSON.stringify({ questionRevision: 1, idempotencyKey: "consistency-02", answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }] }),
    });
    const answerId = s.json().answerId as string;
    t.store.get("alpha")!.claims.clear(); // simulate a claim index that has not caught up yet
    const all = (await t.app.inject("/api/projects/alpha/queue?state=pending")).json();
    expect(all.items).toEqual([expect.objectContaining({ answerId, questionId: "Q2", questionRevision: 1 })]);
    const filtered = (await t.app.inject("/api/projects/alpha/queue?state=pending&questionId=Q2")).json();
    expect(filtered.items.map((i: { answerId: string }) => i.answerId)).toEqual([answerId]);
    expect(fs.existsSync(path.join(t.root, "projects", "alpha", "communications", "answers", "pending", `${answerId}.json`))).toBe(true);
  });
});
