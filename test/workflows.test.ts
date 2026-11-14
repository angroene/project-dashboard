/** Project-defined status workflows: labels, categories, counts and unknown-status handling. */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, section, writeJson, T0 } from "./helpers.js";
import { ProjectManifest } from "../src/shared/schemas.js";
import { statusInfo } from "../src/shared/workflow.js";
import type { ProjectCard, RecordPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

const issue = (id: string, status: string) => ({ schemaVersion: 1, id, recordType: "issue", title: `Issue ${id}`, status, updatedAt: T0 });

function gammaRoot(unknownStatus: "warn" | "strict" = "warn"): string {
  const root = makeDataRoot();
  const g = path.join(root, "projects", "gamma");
  writeJson(path.join(g, "project.json"), {
    schemaVersion: 1, id: "gamma", displayName: "Gamma",
    workflows: {
      issue: {
        unknownStatus,
        statuses: [
          { id: "triage", label: "Triage", category: "open" },
          { id: "on-bench", label: "On the bench", category: "active" },
          { id: "stuck", label: "Stuck", category: "blocked" },
          { id: "shipped", label: "Shipped", category: "done", tone: "ok" },
        ],
      },
    },
  });
  writeJson(path.join(g, "sections", "bugs", "section.json"), section("bugs", "expandable-card", "Bugs"));
  const rec = path.join(g, "sections", "bugs", "records");
  writeJson(path.join(rec, "B1.json"), issue("B1", "triage"));
  writeJson(path.join(rec, "B2.json"), issue("B2", "on-bench"));
  writeJson(path.join(rec, "B3.json"), issue("B3", "stuck"));
  writeJson(path.join(rec, "B4.json"), issue("B4", "shipped"));
  writeJson(path.join(rec, "B5.json"), issue("B5", "in-progress"));
  return root;
}

describe("status workflows", () => {
  it("uses project-defined labels and categories for summaries and card counts", async () => {
    const h = await makeApp(gammaRoot());
    apps.push(h);
    const cards = (await h.app.inject("/api/projects")).json().projects as ProjectCard[];
    const gamma = cards.find((c) => c.id === "gamma")!;
    expect(gamma.active).toBe(1);
    expect(gamma.blocked).toBe(1);
    const page = (await h.app.inject("/api/projects/gamma/sections/bugs/records?status=all")).json() as RecordPage;
    const byId = Object.fromEntries(page.items.map((i) => [i.id, i]));
    expect(byId.B2).toMatchObject({ statusLabel: "On the bench", statusCategory: "active", statusTone: "info" });
    expect(byId.B4).toMatchObject({ statusLabel: "Shipped", statusCategory: "done", statusTone: "ok" });
    // "in-progress" is a default issue status but not in gamma's workflow: shown as open, with a warning.
    expect(byId.B5).toMatchObject({ statusCategory: "open", statusLabel: "In progress" });
    const diag = (await h.app.inject("/api/diagnostics")).json();
    expect(JSON.stringify(diag)).toMatch(/status 'in-progress' is not in this project's issue workflow — shown as open/);
  });

  it("strict workflows reject records with unknown statuses", async () => {
    const h = await makeApp(gammaRoot("strict"));
    apps.push(h);
    const page = (await h.app.inject("/api/projects/gamma/sections/bugs/records?status=all")).json() as RecordPage;
    expect(page.items.map((i) => i.id).sort()).toEqual(["B1", "B2", "B3", "B4"]);
  });

  it("other projects keep the built-in defaults", async () => {
    const h = await makeApp(gammaRoot());
    apps.push(h);
    const alpha = ((await h.app.inject("/api/projects")).json().projects as ProjectCard[]).find((c) => c.id === "alpha")!;
    expect(alpha.blocked).toBe(1); // task T2 "blocked" in the default task workflow
  });

  it("rejects invalid workflow definitions and questions as a workflow key", () => {
    const base = { schemaVersion: 1, id: "x", displayName: "X" };
    expect(ProjectManifest.safeParse({ ...base, workflows: { issue: { statuses: [{ id: "a", label: "A", category: "open" }, { id: "a", label: "A2", category: "done" }] } } }).success).toBe(false);
    expect(ProjectManifest.safeParse({ ...base, workflows: { issue: { statuses: [{ id: "a", label: "A", category: "finished" }] } } }).success).toBe(false);
    expect(ProjectManifest.safeParse({ ...base, workflows: { issue: { statuses: [] } } }).success).toBe(false);
    expect(ProjectManifest.safeParse({ ...base, workflows: { question: { statuses: [{ id: "a", label: "A", category: "open" }] } } }).success).toBe(false);
    expect(ProjectManifest.safeParse({ ...base, workflows: { issue: { statuses: [{ id: "a", label: "A", category: "open" }] } } }).success).toBe(true);
  });

  it("question statuses are fixed and never configurable", () => {
    expect(statusInfo({ workflows: {} }, "question", "answered")).toMatchObject({ category: "waiting", known: true });
    expect(statusInfo({ workflows: {} }, "question", "mystery")).toMatchObject({ known: false, category: "open" });
  });
});
