/**
 * The example catalogue: the showcase project covers every supported type and loads cleanly, and every JSON example
 * marked in docs/ITEM_TYPES.md is valid against the runtime schemas. Lists come from the schema module, so adding a
 * type without an example fails here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { makeApp } from "./helpers.js";
import {
  ActivityEvent, ANSWER_TYPES, AnyRecord, DISPLAY_TYPES, ProgressFile, ProjectManifest, RECORD_TYPES, RecurringTemplate,
  SectionManifest, SectionView, TRACKED_FIELD_TYPES,
} from "../src/shared/schemas.js";
import type { AttentionResponse, TemplateCurrent } from "../src/shared/api.js";

const SHOWCASE = "showcase-garden";
const apps: { app: { close: () => Promise<unknown> } }[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.app.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function copyExamples(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "apd-catalogue-"));
  fs.cpSync(path.resolve("examples"), root, { recursive: true });
  roots.push(root);
  return root;
}

function jsonFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => f.endsWith(".json"));
}

interface SectionFile { id: string; displayType: string; views?: string[]; pinned?: boolean; fields?: { id: string; type: string; editableBy: string[]; options?: { id: string; label: string }[] }[] }
interface RecordFile { recordType: string; answerSchema?: { type: string }; fields?: Record<string, unknown> }
interface TemplateFile { id: string; state?: string; record: RecordFile }
const read = <T>(f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as T;

describe("showcase-garden example", () => {
  it("loads with zero diagnostics and covers every display type, view, record, answer and field type", async () => {
    const root = copyExamples();
    const h = await makeApp(root);
    apps.push(h);
    const get = async <T>(url: string) => {
      const r = await h.app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      return r.json() as T;
    };
    expect((await get<{ diagnostics: unknown[] }>("/api/diagnostics")).diagnostics).toEqual([]);

    const sectionsDir = path.join(root, "projects", SHOWCASE, "sections");
    const files = jsonFiles(sectionsDir).map((f) => path.join(sectionsDir, f));
    const sections = files.filter((f) => path.basename(f) === "section.json").map((f) => read<SectionFile>(f));
    const records = files.filter((f) => /[\\/]records[\\/]/.test(f)).map((f) => read<RecordFile>(f));
    const templates = files.filter((f) => /[\\/]templates[\\/]/.test(f)).map((f) => read<TemplateFile>(f));

    const missing = (all: readonly string[], seen: Iterable<string>) => { const s = new Set(seen); return all.filter((v) => !s.has(v)); };
    expect(missing(DISPLAY_TYPES, sections.map((s) => s.displayType)), "display types").toEqual([]);
    expect(missing(SectionView.options, sections.flatMap((s) => s.views ?? [])), "section views").toEqual([]);
    expect(missing(RECORD_TYPES, records.map((r) => r.recordType)), "record types").toEqual([]);
    const answerTypes = [...records, ...templates.map((t) => t.record)].flatMap((r) => (r.answerSchema ? [r.answerSchema.type] : []));
    expect(missing(ANSWER_TYPES, answerTypes), "answer types").toEqual([]);
    expect(missing(TRACKED_FIELD_TYPES, sections.flatMap((s) => (s.fields ?? []).map((f) => f.type))), "field types").toEqual([]);

    // Every attention group has something in it.
    const att = await get<AttentionResponse>(`/api/projects/${SHOWCASE}/attention`);
    for (const g of ["questions", "actions", "responses", "updates"] as const) expect(att.counts[g], g).toBeGreaterThan(0);

    // A daily Yes / No item: an active template in a card with a yes-no field; the current value is a boolean.
    const yesNoCards = new Map(sections.filter((s) => (s.fields ?? []).some((f) => f.type === "yes-no"))
      .map((s) => [s.id, s.fields!.find((f) => f.type === "yes-no")!.id]));
    const daily = templates.filter((t) => t.state === "active" && Object.keys(t.record.fields ?? {}).some((k) => [...yesNoCards.values()].includes(k)));
    expect(daily.length).toBeGreaterThan(0);
    for (const t of daily) {
      const cur = await get<TemplateCurrent>(`/api/projects/${SHOWCASE}/templates/${t.id}/current`);
      const fieldId = yesNoCards.get(cur.sectionId)!;
      expect(cur.date).not.toBeNull();
      expect(typeof cur.fields[fieldId]).toBe("boolean");
      expect(["yes", "no"]).toContain(cur.labels[fieldId]);
    }
    // A daily pinned choice: a pinned card with a user choice field and an active template that sets its default.
    const choiceCards = sections.filter((s) => s.pinned && (s.fields ?? []).some((f) => f.type === "choice" && f.editableBy.includes("user")));
    const choiceDaily = templates.filter((t) => t.state === "active" && choiceCards.some((s) => s.fields!.some((f) => f.type === "choice" && t.record.fields?.[f.id] !== undefined)));
    expect(choiceDaily.length).toBeGreaterThan(0);
    for (const t of choiceDaily) {
      const cur = await get<TemplateCurrent>(`/api/projects/${SHOWCASE}/templates/${t.id}/current`);
      const f = choiceCards.find((s) => s.id === cur.sectionId)!.fields!.find((x) => x.type === "choice")!;
      expect(f.options!.map((o) => o.id)).toContain(cur.fields[f.id]);
      expect(cur.labels[f.id]).toBe(f.options!.find((o) => o.id === cur.fields[f.id])!.label);
    }
    expect(templates.some((t) => t.state === "paused")).toBe(true);
    expect(templates.some((t) => t.record.recordType === "question")).toBe(true);
  });
});

describe("docs/ITEM_TYPES.md examples", () => {
  const SCHEMAS: Record<string, ZodType> = {
    record: AnyRecord, section: SectionManifest, project: ProjectManifest, template: RecurringTemplate,
    progress: ProgressFile, activity: ActivityEvent,
  };
  const doc = fs.readFileSync(path.resolve("docs/ITEM_TYPES.md"), "utf8");
  const blocks = [...doc.matchAll(/<!-- example: ([a-z]+) -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/g)]
    .map((m) => ({ kind: m[1], json: m[2], line: doc.slice(0, m.index).split("\n").length }));

  it("has a marked example of every kind, and no marker without a json block", () => {
    expect(new Set(blocks.map((b) => b.kind))).toEqual(new Set(Object.keys(SCHEMAS)));
    expect(blocks.length).toBe((doc.match(/<!-- example: /g) ?? []).length);
  });

  it("every marked example parses with its schema", () => {
    const failures: string[] = [];
    for (const b of blocks) {
      let value: unknown;
      try { value = JSON.parse(b.json); } catch (e) { failures.push(`line ${b.line} (${b.kind}): invalid JSON: ${(e as Error).message}`); continue; }
      const r = SCHEMAS[b.kind].safeParse(value);
      if (!r.success) failures.push(`line ${b.line} (${b.kind}): ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
