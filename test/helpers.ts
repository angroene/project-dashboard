/** Test helpers: build small synthetic data roots in a temp folder and an in-process app. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

export const T0 = "2026-11-01T10:00:00Z";

export function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pcc-test-"));
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

export function section(id: string, displayType: string, title: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, displayType, title, ...extra };
}

export function question(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id, recordType: "question", title: `Question ${id}`, summary: "synthetic", status: "open",
    updatedAt: T0, requiresResponse: true, questionRevision: 1,
    answerSchema: {
      type: "single-choice",
      options: [{ id: "a", label: "Align to surface" }, { id: "b", label: "Keep upright" }],
      allowOther: true, allowExplanation: true,
    },
    ...extra,
  };
}

export function task(id: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, recordType: "task", title: `Task ${id}`, status: "in-progress", updatedAt: T0, ...extra };
}

/**
 * Two projects: "alpha" (main-tab → page-tab → cards) and "beta" (root cards), plus a broken one.
 */
export function makeDataRoot(): string {
  const root = tmpRoot();
  const a = path.join(root, "projects", "alpha");
  writeJson(path.join(a, "project.json"), { schemaVersion: 1, id: "alpha", displayName: "Alpha", description: "synthetic", order: 1, artifactRoots: ["docs"] });
  writeJson(path.join(a, "progress.json"), { schemaVersion: 1, overallPercent: 40, label: "Milestones", method: "owner estimate", updatedAt: T0, breakdown: [{ id: "core", title: "Core", percent: 50 }] });
  const s = path.join(a, "sections");
  writeJson(path.join(s, "dev", "section.json"), section("dev", "main-tab", "Developer Area", { order: 1 }));
  writeJson(path.join(s, "dev", "desk", "section.json"), section("desk", "page-tab", "Desk", { order: 1 }));
  writeJson(path.join(s, "dev", "desk", "qs", "section.json"), section("qs", "expandable-card", "Questions", { actions: ["copy", "export-xlsx", "import-xlsx", "bulk-download", "respond"] }));
  for (let i = 1; i <= 5; i++) writeJson(path.join(s, "dev", "desk", "qs", "records", `Q${i}.json`), question(`Q${i}`));
  writeJson(path.join(s, "dev", "desk", "qs", "records", "QTEXT.json"), question("QTEXT", { answerSchema: { type: "free-text", maxLength: 200 } }));
  writeJson(path.join(s, "dev", "desk", "qs", "records", "QAPP.json"), question("QAPP", { answerSchema: { type: "approval", requireRationaleOnReject: true } }));
  writeJson(path.join(s, "dev", "desk", "qs", "records", "QFILE.json"), question("QFILE", { answerSchema: { type: "file-upload", maxFiles: 2, allowedMimeTypes: ["image/png"] } }));
  writeJson(path.join(s, "dev", "desk", "qs", "records", "QCOMP.json"), question("QCOMP", {
    answerSchema: {
      type: "composite",
      fields: [
        { id: "choice", label: "Style", type: "single-choice", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
        { id: "why", label: "Why", type: "free-text", required: false },
        { id: "art", label: "Artwork", type: "file-upload", required: false, minFiles: 0 },
      ],
    },
  }));
  writeJson(path.join(s, "dev", "desk", "qs", "records", "QINFO.json"), question("QINFO", { requiresResponse: false, answerSchema: undefined }));
  writeJson(path.join(s, "dev", "work", "section.json"), section("work", "page-tab", "Work", { order: 2, views: ["progress"] }));
  writeJson(path.join(s, "dev", "work", "tasks", "section.json"), section("tasks", "expandable-card", "Tasks"));
  writeJson(path.join(s, "dev", "work", "tasks", "records", "T1.json"), task("T1", { notifyUser: true, attachments: [{ id: "ATT-1", path: "documents/adr-1.md" }, { id: "ATT-GONE", path: "documents/missing.md" }] }));
  writeJson(path.join(s, "dev", "work", "tasks", "records", "T2.json"), task("T2", { status: "blocked", attachments: [{ id: "ATT-DOC", path: "ADR-2.md", root: "docs" }] }));
  writeJson(path.join(s, "dev", "work", "tasks", "records", "bad.json"), "{ not json");
  writeJson(path.join(s, "dev", "weird", "section.json"), section("weird", "sidebar", "Weird"));
  fs.mkdirSync(path.join(s, "dev", "plainfolder"), { recursive: true });
  writeJson(path.join(a, "attachments", "documents", "adr-1.md"), "# ADR 1\n\nsynthetic");
  writeJson(path.join(a, "docs", "ADR-2.md"), "# ADR 2\n");
  writeJson(path.join(a, "activity", "events", "E1.json"), { schemaVersion: 1, id: "E1", at: T0, action: "build", summary: "Build ran", area: "dev" });
  writeJson(path.join(a, "activity", "events", "E2.json"), { schemaVersion: 1, id: "E2", at: "2026-11-02T10:00:00Z", action: "test", summary: "Tests ran", status: "failure" });

  const b = path.join(root, "projects", "beta");
  writeJson(path.join(b, "project.json"), { schemaVersion: 1, id: "beta", displayName: "Beta", order: 2 });
  writeJson(path.join(b, "sections", "backlog", "section.json"), section("backlog", "expandable-card", "Backlog"));
  writeJson(path.join(b, "sections", "backlog", "records", "Q1.json"), question("Q1"));

  writeJson(path.join(root, "projects", "broken", "project.json"), "{ nope");
  return root;
}

export async function makeApp(root: string, extra: Record<string, unknown> = {}) {
  const cfg = loadConfig({ dataRoot: root, watch: false, reconcileSeconds: 0, logLevel: "silent", ...extra } as never);
  const h = await buildApp(cfg, { logger: false });
  return { ...h, cfg };
}

export const POST_HEADERS = { "x-pcc-request": "1", "content-type": "application/json" };

/** Minimal valid PNG (1x1). */
export const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function multipartBody(parts: { name: string; value?: string; filename?: string; content?: Buffer; type?: string }[]) {
  const boundary = "----pcctest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? "application/octet-stream"}\r\n\r\n`));
      chunks.push(p.content ?? Buffer.alloc(0));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ""}`));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-pcc-request": "1" } };
}
