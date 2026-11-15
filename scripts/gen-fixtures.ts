/**
 * Generates the SYNTHETIC test data root at fixtures/data (deleted and rebuilt on every run).
 *
 * Deterministic: a seeded PRNG and fixed timestamps derived from 2026-11-01T00:00:00Z; no clock reads.
 * Every JSON file is validated against src/shared/schemas.ts before it is written, except the files
 * that are deliberately broken (listed in DELIBERATELY_BROKEN). Any validation error aborts the run.
 *
 * Usage: npx tsx scripts/gen-fixtures.ts
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { z } from "zod";
import {
  ALLOWED_CHILDREN, ActivityEvent, AnswerEnvelope, AnyRecord, MAX_SECTION_DEPTH, ProgressFile, ProjectManifest,
  SectionManifest, SINGLE_FIELD_ID, type AnswerSchema, type AnswerValue, type DisplayType,
} from "../src/shared/schemas.js";
import { validateAnswer } from "../src/shared/validate.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "fixtures", "data");
const BASE_MS = Date.parse("2026-11-01T00:00:00Z");
const SYNTH = "SYNTHETIC FIXTURE";

// ------------------------------------------------------------ utilities ---
/** mulberry32: small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  };
}
const rnd = prng(20261101);

/** Fixed timestamp: base + minutes, ISO with seconds and Z. */
const at = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString().replace(".000Z", "Z");
const pad = (n: number, w = 3) => String(n).padStart(w, "0");

const counts = {
  projects: 0, sections: 0, records: 0, questions: 0, issues: 0, reviews: 0, tasks: 0, documents: 0, other: 0,
  activity: 0, attachments: 0, answers: 0, notifyUser: 0, brokenFiles: 0,
};
const byType: Record<string, number> = {};
const answerTypes: Record<string, number> = {};
const questionStatuses: Record<string, number> = {};

function writeJson(path: string, schema: z.ZodType, value: unknown): void {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new Error(`fixture failed validation: ${path}\n${JSON.stringify(r.error.issues, null, 2)}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function writeRaw(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Valid RGB PNG of size×size in one colour (real zlib stream + CRCs). */
function png(size: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------- project model ---
interface SectionSpec {
  folder: string;
  manifest: Record<string, unknown> & { id: string; displayType: DisplayType };
  children?: SectionSpec[];
  records?: Record<string, unknown>[];
}

class ProjectWriter {
  readonly root: string;
  private recordIds = new Set<string>();
  private sectionIds = new Set<string>();
  constructor(readonly id: string, folder: string) {
    this.root = join(OUT, "projects", folder);
  }

  manifest(m: Record<string, unknown>) {
    writeJson(join(this.root, "project.json"), ProjectManifest, { schemaVersion: 1, id: this.id, ...m });
    counts.projects++;
  }
  progress(p: Record<string, unknown>) {
    writeJson(join(this.root, "progress.json"), ProgressFile, { schemaVersion: 1, ...p });
  }

  /** Writes the tree under rootSection, enforcing the hierarchy rules the backend enforces. */
  sections(specs: SectionSpec[], rootSection = "sections") {
    this.writeLevel(join(this.root, rootSection), specs, "root", 1);
  }
  private writeLevel(dir: string, specs: SectionSpec[], parent: "root" | DisplayType, depth: number) {
    const types = new Set(specs.map((s) => s.manifest.displayType));
    if (types.size > 1) throw new Error(`${this.id}: mixed child display types under ${dir}`);
    for (const s of specs) {
      const t = s.manifest.displayType;
      if (!ALLOWED_CHILDREN[parent].includes(t)) throw new Error(`${this.id}: ${t} not allowed under ${parent}`);
      if (depth > MAX_SECTION_DEPTH) throw new Error(`${this.id}: section depth > ${MAX_SECTION_DEPTH} at ${s.folder}`);
      if (this.sectionIds.has(s.manifest.id)) throw new Error(`${this.id}: duplicate section id ${s.manifest.id}`);
      this.sectionIds.add(s.manifest.id);
      const sdir = join(dir, s.folder);
      writeJson(join(sdir, "section.json"), SectionManifest, { schemaVersion: 1, ...s.manifest });
      counts.sections++;
      if (s.children?.length) this.writeLevel(sdir, s.children, t, depth + 1);
      if (s.records?.length) {
        if (t !== "expandable-card") throw new Error(`${this.id}: records only allowed in cards (${s.folder})`);
        for (const r of s.records) this.record(join(sdir, "records"), r);
      }
    }
  }
  private record(dir: string, r: Record<string, unknown>) {
    const id = r.id as string;
    if (this.recordIds.has(id)) throw new Error(`${this.id}: duplicate record id ${id}`);
    this.recordIds.add(id);
    writeJson(join(dir, `${id}.json`), AnyRecord, { schemaVersion: 1, ...r });
    counts.records++;
    const t = r.recordType as string;
    byType[t] = (byType[t] ?? 0) + 1;
    if (t === "question") {
      counts.questions++;
      questionStatuses[r.status as string] = (questionStatuses[r.status as string] ?? 0) + 1;
      const s = r.answerSchema as AnswerSchema | undefined;
      const k = s ? s.type : "informational";
      answerTypes[k] = (answerTypes[k] ?? 0) + 1;
    } else if (t === "issue") counts.issues++;
    else if (t === "review") counts.reviews++;
    else if (t === "task") counts.tasks++;
    else if (t === "document") counts.documents++;
    else counts.other++;
    if (r.notifyUser) counts.notifyUser++;
  }

  activity(events: Record<string, unknown>[]) {
    for (const e of events) {
      writeJson(join(this.root, "activity", "events", `${e.id}.json`), ActivityEvent, { schemaVersion: 1, ...e });
      counts.activity++;
    }
  }
  attachment(rel: string, data: string | Buffer, root = "attachments") {
    writeRaw(join(this.root, root, rel), data);
    counts.attachments++;
  }
  /** Writes an answer envelope plus its claim file, after checking it against the question's schema. */
  answer(env: Record<string, unknown> & { answerId: string; questionId: string; questionRevision: number; processingState: string }, schema: AnswerSchema) {
    const errs = validateAnswer(schema, env.answers as AnswerValue[], { questionId: env.questionId });
    if (errs.length) throw new Error(`answer ${env.answerId} invalid: ${JSON.stringify(errs)}`);
    writeJson(join(this.root, "communications", "answers", env.processingState, `${env.answerId}.json`), AnswerEnvelope, {
      schemaVersion: 1, projectId: this.id, ...env,
    });
    const claim = join(this.root, "communications", "claims", `${env.questionId}@r${env.questionRevision}.json`);
    writeRaw(claim, JSON.stringify({ answerId: env.answerId, state: env.processingState }, null, 2) + "\n");
    counts.answers++;
  }
}

// ----------------------------------------------------------- vocabulary ---
const MECHANICS = ["Movement", "Perception", "Combat", "Stealth", "Climbing", "Carrying", "Alarms", "Inventory", "Doors", "Vehicles"];
const AREAS = ["Combat", "AI", "Camera", "UI", "Level", "Save/Load", "Audio", "Animation"];
const PRIOS = ["critical", "high", "medium", "low", "none"] as const;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"];
const CARD_ACTIONS = ["copy", "open-detail", "mark-read"] as const;
const QUESTION_ACTIONS = ["copy", "open-detail", "respond", "upload", "export-xlsx", "import-xlsx", "mark-read"] as const;
const DOC_ACTIONS = ["copy", "open-detail", "download", "bulk-download", "mark-read"] as const;

const card = (id: string, title: string, order: number, extra: Record<string, unknown> = {}) => ({
  id, displayType: "expandable-card" as const, title, order, actions: [...CARD_ACTIONS], ...extra,
});
const pageTab = (id: string, title: string, order: number, extra: Record<string, unknown> = {}) => ({
  id, displayType: "page-tab" as const, title, order, ...extra,
});
const mainTab = (id: string, title: string, order: number, extra: Record<string, unknown> = {}) => ({
  id, displayType: "main-tab" as const, title, order, ...extra,
});

function choiceOptions(n: number, topic: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `opt-${String.fromCharCode(97 + i)}`,
    label: `Option ${String.fromCharCode(65 + i)}: ${topic} variant ${i + 1}`,
    ...(i === 0 ? { description: "Synthetic recommended option." } : {}),
  }));
}

/** Builds the 6 answer-schema shapes in rotation; returns undefined for informational questions. */
function answerSchemaFor(kind: string, topic: string): AnswerSchema {
  switch (kind) {
    case "single-choice":
      return { type: "single-choice", options: choiceOptions(3, topic), allowOther: false, allowExplanation: false, required: true };
    case "single-choice-other":
      return { type: "single-choice", options: choiceOptions(rnd.int(2, 4), topic), allowOther: true, allowExplanation: true, required: true };
    case "multiple-choice":
      return { type: "multiple-choice", options: choiceOptions(5, topic), allowOther: false, allowExplanation: true, required: true, minSelected: 1, maxSelected: 3 };
    case "free-text":
      return { type: "free-text", required: true, minLength: 1, maxLength: 2000, multiline: true, placeholder: "Write a short synthetic answer" };
    case "approval":
      return { type: "approval", required: true, allowRationale: true, requireRationaleOnReject: true };
    case "file-upload":
      return { type: "file-upload", required: true, minFiles: 1, maxFiles: 4, allowedMimeTypes: IMAGE_MIMES, allowComment: true };
    case "composite":
      return {
        type: "composite",
        fields: [
          { id: "choice", label: "Pick a direction", type: "single-choice", options: choiceOptions(3, topic), allowOther: true, allowExplanation: false, required: true },
          { id: "explanation", label: "Explain your choice", type: "free-text", required: false, minLength: 0, maxLength: 3000, multiline: true },
          { id: "artwork", label: "Reference artwork", help: "PNG, JPEG or WebP", type: "file-upload", required: false, minFiles: 0, maxFiles: 3, allowedMimeTypes: IMAGE_MIMES, allowComment: true },
        ],
      };
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}
const QUESTION_KINDS = ["single-choice", "single-choice-other", "multiple-choice", "free-text", "approval", "file-upload", "composite"];

// ====================================================== harborlight ===
function harborlightDemo() {
  const p = new ProjectWriter("harborlight", "harborlight");
  p.manifest({
    displayName: "Harborlight (example game)",
    description: `${SYNTH}: a fictional example game project (game development, map tooling, documentation). Not real project data.`,
    order: 10,
    artifactRoots: ["docs/design"],
    theme: { accent: "indigo" },
    progressStaleAfterDays: 14,
  });
  p.progress({
    overallPercent: 64,
    label: "Synthetic milestone completion",
    method: `${SYNTH}: illustrative weighted estimate, not a real measurement.`,
    updatedAt: at(12 * 24 * 60),
    breakdown: [
      { id: "core-mechanics", title: "Core mechanics", percent: 78, detail: "Synthetic", weight: 3, updatedAt: at(12 * 1440) },
      { id: "ai", title: "Enemy and civilian AI", percent: 61, detail: "Synthetic", weight: 2 },
      { id: "map", title: "Map editor content", percent: 55, detail: "Synthetic", weight: 2 },
      { id: "docs", title: "Documentation", percent: 70, detail: "Synthetic", weight: 1 },
      { id: "qa", title: "Testing and QA", percent: null, detail: "Synthetic: not reported yet" },
    ],
  });

  // --- attachments (real files) ---
  const ADR_TITLES = [
    "Folder-driven navigation", "Per-answer queue files", "Published progress only", "Stable record ids",
    "Atomic JSON writes", "Excel round trip", "Attachment roots", "Read state per operator",
  ];
  ADR_TITLES.forEach((t, i) => {
    const n = i + 1;
    p.attachment(
      `documents/adr/ADR-00${n}-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
      `# ADR-00${n}: ${t}\n\n> ${SYNTH}. This document is test data, not a real decision record.\n\n## Status\n\nProposed (synthetic)\n\n## Context\n\nSynthetic context paragraph ${n}.\n\n## Decision\n\nSynthetic decision ${n}.\n\n## Consequences\n\n- Synthetic consequence A\n- Synthetic consequence B\n`,
    );
  });
  const IMAGES: [string, [number, number, number]][] = [
    ["concept-tower.png", [70, 90, 160]],
    ["concept-gate.png", [160, 80, 60]],
    ["concept-yard.png", [60, 140, 90]],
    ["concept-forest.png", [30, 90, 40]],
  ];
  for (const [name, rgb] of IMAGES) p.attachment(`images/${name}`, png(16, rgb));
  p.attachment("documents/notes/playtest-night-notes.txt", `${SYNTH}\nNight notes: synthetic playtest observations.\n`);
  p.attachment("documents/notes/art-brief.md", `# Art brief (synthetic)\n\n${SYNTH}. Placeholder brief.\n`);
  p.attachment("overview.md", `# Design overview (synthetic artifact root)\n\n${SYNTH}. Served from the read-only artifact root docs/design.\n`, "docs/design");

  // --- Game Developer: Progress ---
  const mechanics = MECHANICS.slice(0, 8).map((m, i) => ({
    id: `HBL-MECH-${pad(i + 1)}`,
    recordType: "task",
    title: `${m} mechanic`,
    summary: `${SYNTH}: outstanding work on ${m.toLowerCase()}.`,
    status: i === 6 ? "blocked" : i === 7 ? "planned" : "in-progress",
    priority: PRIOS[i % 4],
    order: i + 1,
    percent: [85, 72, 64, 50, 41, 33, 20, 0][i],
    createdAt: at(i * 60),
    updatedAt: at(9 * 1440 + i * 37),
    assignee: "synthetic-agent",
    bodyMarkdown: `## ${m}\n\n${SYNTH}. Remaining steps:\n\n- step one\n- step two\n`,
    linkedRecords: i < 3 ? [`HBL-Q-${pad(i + 1)}`] : [],
    notifyUser: i === 0 || i === 6,
    history: [{ at: at(i * 60), text: "Created (synthetic)", by: "fixture" }],
  }));
  const recentlyDone = Array.from({ length: 6 }, (_, i) => ({
    id: `HBL-DONE-${pad(i + 1)}`,
    recordType: "task",
    title: `Completed: ${MECHANICS[(i + 3) % MECHANICS.length]} polish ${i + 1}`,
    summary: `${SYNTH}: completed item.`,
    status: i === 5 ? "cancelled" : "done",
    priority: "low",
    percent: i === 5 ? null : 100,
    updatedAt: at(10 * 1440 + i * 90),
  }));

  // --- Game Developer: Review Desk questions (116) ---
  const questions: Record<string, unknown>[] = [];
  const schemas = new Map<string, AnswerSchema>();
  for (let i = 1; i <= 116; i++) {
    const id = `HBL-Q-${pad(i)}`;
    const topic = rnd.pick(MECHANICS);
    const informational = i % 13 === 0;
    const statusRoll = i % 10;
    const status = statusRoll < 5 ? "open" : statusRoll < 7 ? "answered" : statusRoll < 9 ? "processed" : "closed";
    const kind = QUESTION_KINDS[(i - 1) % QUESTION_KINDS.length];
    const q: Record<string, unknown> = {
      id,
      recordType: "question",
      title: informational ? `FYI: ${topic} change landed (synthetic note ${i})` : `How should ${topic.toLowerCase()} behave in case ${i}?`,
      summary: `${SYNTH} question ${i} (${informational ? "informational" : kind}).`,
      status: informational ? (i % 2 ? "closed" : "open") : status,
      priority: PRIOS[i % 5],
      createdAt: at(i * 97),
      updatedAt: at(i * 97 + 30),
      bodyMarkdown: `**${SYNTH}.** Context for question ${i} about ${topic}.\n\n1. Point one\n2. Point two`,
      requiresResponse: !informational,
      notifyUser: informational,
    };
    if (!informational) {
      const s = answerSchemaFor(kind, topic);
      q.answerSchema = s;
      schemas.set(id, s);
      if (kind === "composite" || kind === "file-upload") {
        q.attachments = [{ id: `${id}-ref`, title: "Current look", path: `images/${IMAGES[i % IMAGES.length][0]}`, mimeType: "image/png" }];
      }
    }
    if (i % 7 === 3) q.dueAt = at(15 * 1440 + i * 11);
    if (i % 19 === 5) {
      q.questionRevision = 2;
      q.history = [
        { at: at(i * 97), text: "Revision 1 published (synthetic)" },
        { at: at(i * 97 + 30), text: "Revision 2: options reworded (synthetic)" },
      ];
    }
    if (i <= 3) q.taskId = `HBL-MECH-${pad(i)}`;
    if (q.status === "answered" || q.status === "processed") {
      q.bodyMarkdown += `\n\n**Answer (synthetic):** recorded outside the dashboard queue.`;
    }
    questions.push(q);
  }

  // --- Test issues (64) & code review (54) ---
  const ISSUE_STATUSES = ["open", "in-progress", "fixed", "verified", "wont-fix", "duplicate"] as const;
  const issues = Array.from({ length: 64 }, (_, i) => ({
    id: `HBL-PT-${pad(i + 1)}`,
    recordType: "issue",
    title: `Playtest: ${rnd.pick(AREAS)} glitch #${i + 1}`,
    summary: `${SYNTH} playtest issue ${i + 1}.`,
    status: ISSUE_STATUSES[i % 6 === 5 ? 5 : i % 4],
    priority: PRIOS[(i * 3) % 5],
    severity: rnd.pick(["high", "medium", "low"]),
    area: rnd.pick(AREAS),
    createdAt: at(i * 211),
    updatedAt: at(i * 211 + 45),
    bodyMarkdown: `Steps (synthetic):\n\n1. Start mission\n2. Observe glitch ${i + 1}`,
    metadata: { night: `2026-11-${String(1 + (i % 12)).padStart(2, "0")}`, build: `CL${1400 + i}` },
    notifyUser: i % 21 === 4,
    ...(i % 16 === 0 ? { attachments: [{ id: `HBL-PT-${pad(i + 1)}-notes`, path: "documents/notes/playtest-night-notes.txt", mimeType: "text/plain" }] } : {}),
  }));
  const REVIEW_STATUSES = ["needs-review", "changes-requested", "approved", "rejected", "done"] as const;
  const reviews = Array.from({ length: 54 }, (_, i) => ({
    id: `HBL-CR-${pad(i + 1, 4)}`,
    recordType: "review",
    title: `Review finding ${i + 1}: ${rnd.pick(["null check", "unused include", "race on save", "magic number", "missing test"])}`,
    summary: `${SYNTH} code review finding.`,
    status: REVIEW_STATUSES[i % 5],
    priority: PRIOS[i % 4],
    updatedAt: at(11 * 1440 + i * 13),
    // The first finding has a long unbroken log line: on a phone it must scroll inside its box, not widen the page.
    bodyMarkdown: i === 0
      ? "```text\n" + `${SYNTH}: LogStreaming: Warning: ${"Synthetic/Very/Long/Package/Path/".repeat(8)}Asset.uasset failed to load` + "\n```\n\nSuggested fix: synthetic."
      : "```cpp\n// synthetic snippet\nint x = 0;\n```\n\nSuggested fix: synthetic.",
    metadata: { file: `Source/Synthetic/File${i % 9}.cpp`, line: 10 + i * 7, category: rnd.pick(["bug", "design", "test-gap"]) },
    notifyUser: i === 2 || i === 40,
  }));

  // --- Map Editor ---
  const mapProgress = Array.from({ length: 5 }, (_, i) => ({
    id: `HBL-MAP-${pad(i + 1)}`,
    recordType: "task",
    title: `Map milestone ${i + 1}: ${["Terrain", "Buildings", "Forest", "Props", "Lighting"][i]}`,
    summary: `${SYNTH} map milestone.`,
    status: i < 2 ? "done" : "in-progress",
    percent: [100, 100, 60, 35, 10][i],
    updatedAt: at(8 * 1440 + i * 120),
  }));
  const mapQuestions: Record<string, unknown>[] = Array.from({ length: 6 }, (_, i) => {
    const id = `HBL-MQ-${pad(i + 1)}`;
    const kind = ["single-choice-other", "approval", "file-upload", "composite", "free-text", "multiple-choice"][i];
    const s = answerSchemaFor(kind, "terrain");
    schemas.set(id, s);
    return {
      id,
      recordType: "question",
      title: `Map question ${i + 1}: object placement on slope ${i + 1}?`,
      summary: `${SYNTH} map editor question.`,
      status: i < 4 ? "open" : "answered",
      requiresResponse: true,
      answerSchema: s,
      priority: "medium",
      createdAt: at(2000 + i * 33),
      updatedAt: at(2000 + i * 33 + 5),
      attachments: [{ id: `${id}-shot`, title: "Screenshot (synthetic)", path: `images/${IMAGES[i % 4][0]}`, mimeType: "image/png" }],
      ...(i === 0 ? { dueAt: at(14 * 1440) } : {}),
    };
  });
  const artAssets = IMAGES.map(([name], i) => ({
    id: `HBL-ART-${pad(i + 1)}`,
    recordType: "document",
    title: `Concept art: ${name.replace(".png", "")}`,
    summary: `${SYNTH} placeholder image.`,
    status: "published",
    statusLabel: "Published",
    updatedAt: at(7 * 1440 + i * 15),
    attachments: [{ id: `HBL-ART-${pad(i + 1)}-png`, title: name, path: `images/${name}`, mimeType: "image/png" }],
    notifyUser: i === 3,
  }));
  artAssets.push({
    id: "HBL-ART-005",
    recordType: "document",
    title: "Art brief",
    summary: `${SYNTH} brief with a text attachment.`,
    status: "published",
    statusLabel: "Published",
    updatedAt: at(7 * 1440 + 90),
    attachments: [{ id: "HBL-ART-005-md", title: "art-brief.md", path: "documents/notes/art-brief.md", mimeType: "text/markdown" }],
    notifyUser: false,
  });

  // --- Docs Editor: ADR reviews ---
  const adrReviews: Record<string, unknown>[] = ADR_TITLES.map((t, i) => {
    const n = i + 1;
    return {
      id: `HBL-ADR-00${n}`,
      recordType: i % 3 === 2 ? "document" : "review",
      title: `ADR-00${n}: ${t}`,
      summary: `${SYNTH} ADR awaiting review.`,
      status: i % 3 === 2 ? "draft" : (["needs-review", "changes-requested", "approved"] as const)[i % 3],
      ...(i % 3 === 2 ? { statusLabel: "Draft" } : {}),
      priority: "medium",
      updatedAt: at(12 * 1440 + i * 20),
      attachments: [{
        id: `HBL-ADR-00${n}-md`,
        title: `ADR-00${n}.md`,
        path: `documents/adr/ADR-00${n}-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
        mimeType: "text/markdown",
      }],
      actions: [...DOC_ACTIONS],
      notifyUser: i === 1,
    };
  });
  adrReviews.push({
    id: "HBL-ADR-009",
    recordType: "review",
    title: "ADR-009: Attachment deliberately missing",
    summary: `${SYNTH}: the referenced file does not exist (tests the unavailable-attachment state).`,
    status: "needs-review",
    updatedAt: at(12 * 1440 + 200),
    attachments: [{ id: "HBL-ADR-009-md", title: "ADR-009.md", path: "documents/adr/ADR-009-missing-on-purpose.md", mimeType: "text/markdown" }],
  });
  adrReviews.push({
    id: "HBL-DOC-OVERVIEW",
    recordType: "document",
    title: "Design overview (artifact root)",
    summary: `${SYNTH}: attachment served from the read-only artifact root docs/design.`,
    status: "published",
    updatedAt: at(12 * 1440 + 210),
    attachments: [{ id: "HBL-DOC-OVERVIEW-md", path: "overview.md", root: "docs/design", mimeType: "text/markdown" }],
  });

  p.sections([
    {
      folder: "game-developer",
      manifest: mainTab("game-developer", "Game Developer", 10, { icon: "gamepad", description: "Synthetic engine work area" }),
      children: [
        {
          folder: "progress",
          manifest: pageTab("progress", "Progress", 10, { icon: "chart", views: ["progress"] }),
          children: [
            { folder: "outstanding-mechanics", manifest: card("outstanding-mechanics", "Outstanding Mechanics", 10, { defaultOpen: true, filters: { sort: "order" }, actions: ["copy", "open-detail", "export-xlsx", "mark-read"] }), records: mechanics },
            { folder: "recently-completed", manifest: card("recently-completed", "Recently Completed", 20), records: recentlyDone },
          ],
        },
        {
          folder: "review-desk",
          manifest: pageTab("review-desk", "Review Desk", 20, { icon: "inbox", views: ["attention"] }),
          children: [
            {
              folder: "questions",
              manifest: card("questions", "Questions", 10, {
                defaultOpen: true, icon: "question", actions: [...QUESTION_ACTIONS], pageSize: 50,
                filters: { statuses: ["open", "answered", "processed", "closed"], defaultStatus: "open", sort: "updated-desc" },
              }),
              records: questions,
            },
          ],
        },
        {
          folder: "test-issues",
          manifest: pageTab("test-issues", "Test Issues", 30, { icon: "bug" }),
          children: [{ folder: "playtest", manifest: card("playtest-issues", "Playtest issues", 10, { defaultOpen: true, pageSize: 50 }), records: issues }],
        },
        {
          folder: "code-review",
          manifest: pageTab("code-review", "Code Review", 40, { icon: "review" }),
          children: [{ folder: "findings", manifest: card("review-findings", "Review findings", 10, { defaultOpen: true, filters: { sort: "priority" } }), records: reviews }],
        },
      ],
    },
    {
      folder: "map-editor",
      manifest: mainTab("map-editor", "Map Editor", 20, { icon: "map" }),
      children: [
        {
          folder: "progress",
          manifest: pageTab("map-progress", "Progress", 10, { views: ["progress"] }),
          children: [{ folder: "milestones", manifest: card("map-milestones", "Map milestones", 10, { defaultOpen: true }), records: mapProgress }],
        },
        {
          folder: "questions",
          manifest: pageTab("map-questions", "Questions", 20, { icon: "question" }),
          children: [{ folder: "open", manifest: card("map-question-list", "Map questions", 10, { defaultOpen: true, actions: [...QUESTION_ACTIONS] }), records: mapQuestions }],
        },
        {
          folder: "art-assets",
          manifest: pageTab("art-assets", "Art Assets", 30, { icon: "image" }),
          children: [{ folder: "concepts", manifest: card("concept-art", "Concept art", 10, { actions: [...DOC_ACTIONS] }), records: artAssets }],
        },
      ],
    },
    {
      folder: "docs-editor",
      manifest: mainTab("docs-editor", "Docs Editor", 30, { icon: "book" }),
      children: [
        {
          folder: "adr-reviews",
          manifest: pageTab("adr-reviews", "ADR Reviews", 10, { icon: "file" }),
          children: [{ folder: "adrs", manifest: card("adr-review-list", "ADR reviews", 10, { defaultOpen: true, actions: [...DOC_ACTIONS], filters: { sort: "title" } }), records: adrReviews }],
        },
        { folder: "activity", manifest: pageTab("docs-activity", "Activity", 20, { icon: "clock", views: ["activity"] }) },
      ],
    },
  ]);

  // Deliberately invalid section manifest (displayType "sidebar"); the rest of the project must still load.
  writeRaw(
    join(p.root, "sections", "game-developer", "legacy-sidebar", "section.json"),
    JSON.stringify({ schemaVersion: 1, id: "legacy-sidebar", displayType: "sidebar", title: "Legacy sidebar (invalid on purpose)" }, null, 2) + "\n",
  );
  counts.brokenFiles++;
  // A folder without section.json is not a section and must be ignored.
  writeRaw(join(p.root, "sections", "game-developer", "scratch-notes", "README.md"), `${SYNTH}: folder without section.json; ignored by discovery.\n`);

  // --- activity: 40 events over 12 days ---
  const ACTIONS = ["task-updated", "question-asked", "issue-reported", "review-posted", "build-finished", "doc-landed"];
  const STAT = ["info", "success", "warning", "failure"] as const;
  const AREA_NAMES = ["Game Developer", "Map Editor", "Docs Editor"];
  const allIds = [...mechanics, ...questions, ...issues, ...reviews].map((r) => r.id as string);
  p.activity(
    Array.from({ length: 40 }, (_, i) => ({
      id: `HBL-EV-${pad(i + 1)}`,
      at: at(i * 431),
      area: AREA_NAMES[i % 3],
      action: ACTIONS[i % ACTIONS.length],
      source: rnd.pick(["synthetic-engine-agent", "synthetic-map-agent", "synthetic-docs-agent"]),
      summary: `${SYNTH} event ${i + 1}: ${ACTIONS[i % ACTIONS.length].replace("-", " ")}.`,
      status: STAT[i % 7 === 6 ? 3 : i % 3],
      ...(i % 2 === 0 ? { recordId: allIds[(i * 7) % allIds.length] } : {}),
    })),
  );

  // --- a few queued answers (pending on open questions, processed on processed questions) ---
  const pickQ = (status: string, kinds: string[], n: number) =>
    questions.filter((q) => q.status === status && q.answerSchema && kinds.includes((q.answerSchema as AnswerSchema).type)).slice(0, n);
  const valueFor = (s: AnswerSchema, i: number): AnswerValue[] => {
    switch (s.type) {
      case "single-choice":
        return s.allowOther && i % 2
          ? [{ fieldId: SINGLE_FIELD_ID, kind: "choice", optionIds: ["__other"], otherText: "Synthetic other idea", explanation: "Synthetic reason" }]
          : [{ fieldId: SINGLE_FIELD_ID, kind: "choice", optionIds: [s.options[0].id] }];
      case "multiple-choice":
        return [{ fieldId: SINGLE_FIELD_ID, kind: "choice", optionIds: [s.options[0].id, s.options[2].id] }];
      case "free-text":
        return [{ fieldId: SINGLE_FIELD_ID, kind: "text", text: "Synthetic free-text answer." }];
      case "approval":
        return [{ fieldId: SINGLE_FIELD_ID, kind: "approval", decision: i % 2 ? "reject" : "approve", rationale: "Synthetic rationale." }];
      default:
        throw new Error(`no fixture answer for ${s.type}`);
    }
  };
  const answerable = ["single-choice", "multiple-choice", "free-text", "approval"];
  const pendingQs = pickQ("open", answerable, 4);
  // One open free-text question whose answer a consumer rejected: the UI offers "Answer again" for it.
  const failedQs = pickQ("open", ["free-text"], 10).filter((q) => !pendingQs.includes(q)).slice(0, 1);
  let a = 0;
  for (const [state, qs] of [["pending", pendingQs], ["processed", pickQ("processed", answerable, 3)], ["failed", failedQs]] as const) {
    for (const q of qs) {
      a++;
      const qid = q.id as string;
      const s = schemas.get(qid)!;
      const submittedAt = at((q.createdAt ? Date.parse(q.createdAt as string) - BASE_MS : 0) / 60_000 + 120);
      p.answer(
        {
          answerId: `ANS-FIXTURE-${pad(a)}`,
          questionId: qid,
          questionRevision: (q.questionRevision as number | undefined) ?? 1,
          submittedAt,
          source: a % 3 === 0 ? "excel-import" : "dashboard",
          submittedBy: "fixture-operator",
          idempotencyKey: `fixture-key-${pad(a)}`,
          answers: valueFor(s, a),
          attachments: [],
          processingState: state,
          attempts: state === "pending" ? 0 : 1,
          ...(state === "processed" ? { result: { at: at(15 * 1440 + a), note: "Processed by a synthetic consumer." } } : {}),
          ...(state === "failed" ? { result: { at: at(15 * 1440 + a), reason: "Synthetic consumer could not apply the answer.", retryable: false } } : {}),
          audit: [
            { at: submittedAt, event: "submitted", by: "fixture-operator" },
            ...(state === "processed" ? [{ at: at(15 * 1440 + a), event: "processed", by: "synthetic-consumer" }] : []),
            ...(state === "failed" ? [{ at: at(15 * 1440 + a), event: "failed", by: "synthetic-consumer", note: "Synthetic consumer could not apply the answer." }] : []),
          ],
        },
        s,
      );
    }
  }
}

// ========================================================== atlas-toolkit ===
function atlasToolkit() {
  const p = new ProjectWriter("atlas-toolkit", "atlas-toolkit");
  p.manifest({
    displayName: "Atlas Toolkit (synthetic)",
    description: `${SYNTH}: a second, differently arranged project (page tabs at the root, no work areas).`,
    order: 20,
    theme: { accent: "teal" },
  });
  p.progress({
    overallPercent: null,
    label: "Release readiness",
    method: `${SYNTH}: the project has not reported an overall figure yet.`,
    updatedAt: at(5 * 1440),
    breakdown: [
      { id: "parser", title: "Parser", percent: 40, detail: "Synthetic" },
      { id: "cli", title: "CLI", percent: null, detail: "Synthetic: not reported" },
    ],
  });
  p.attachment("documents/spec/atlas-format.md", `# Atlas format (synthetic)\n\n${SYNTH}.\n`);
  const milestones = Array.from({ length: 6 }, (_, i) => ({
    id: `ATL-MS-${pad(i + 1)}`,
    recordType: "task",
    title: `Milestone ${i + 1}`,
    summary: `${SYNTH} milestone.`,
    status: (["done", "done", "in-progress", "in-progress", "planned", "blocked"] as const)[i],
    percent: [100, 100, 50, 20, 0, null][i],
    order: i + 1,
    updatedAt: at(3 * 1440 + i * 60),
  }));
  const backlog = Array.from({ length: 12 }, (_, i) => ({
    id: `ATL-BL-${pad(i + 1)}`,
    recordType: i % 3 === 0 ? "issue" : "task",
    title: `Backlog item ${i + 1}`,
    summary: `${SYNTH} backlog entry.`,
    status: i % 3 === 0 ? "open" : "planned",
    priority: PRIOS[i % 5],
    updatedAt: at(4 * 1440 + i * 17),
  }));
  const reviews: Record<string, unknown>[] = Array.from({ length: 5 }, (_, i) => ({
    id: `ATL-RV-${pad(i + 1)}`,
    recordType: "review",
    title: `Spec review ${i + 1}`,
    summary: `${SYNTH} review.`,
    status: (["needs-review", "approved", "changes-requested", "done", "needs-review"] as const)[i],
    updatedAt: at(4 * 1440 + i * 41),
    attachments: i === 0 ? [{ id: "ATL-RV-001-spec", path: "documents/spec/atlas-format.md", mimeType: "text/markdown" }] : [],
    notifyUser: i === 4,
  }));
  ["approval", "single-choice-other", "free-text", "composite"].forEach((k, i) =>
    reviews.push({
      id: `ATL-Q-${pad(i + 1)}`,
      recordType: "question",
      title: `Atlas question ${i + 1}`,
      summary: `${SYNTH} question inside a review card.`,
      status: i === 3 ? "answered" : "open",
      requiresResponse: true,
      answerSchema: answerSchemaFor(k, "format"),
      updatedAt: at(4 * 1440 + 300 + i),
      ...(i === 1 ? { dueAt: at(6 * 1440) } : {}),
    }),
  );
  p.sections([
    { folder: "milestones", manifest: pageTab("milestones", "Milestones", 10, { views: ["progress"], icon: "flag" }), children: [{ folder: "list", manifest: card("milestone-list", "Milestones", 10, { defaultOpen: true, filters: { sort: "order" } }), records: milestones }] },
    { folder: "backlog", manifest: pageTab("backlog", "Backlog", 20, { icon: "list" }), children: [{ folder: "items", manifest: card("backlog-items", "Backlog", 10), records: backlog }] },
    { folder: "reviews", manifest: pageTab("reviews", "Reviews", 30, { icon: "review" }), children: [{ folder: "open", manifest: card("review-queue", "Reviews and questions", 10, { actions: [...QUESTION_ACTIONS, "download"] }), records: reviews }] },
  ]);
  p.activity(
    Array.from({ length: 5 }, (_, i) => ({
      id: `ATL-EV-${pad(i + 1)}`,
      at: at(3 * 1440 + i * 200),
      area: "Atlas",
      action: "milestone-updated",
      summary: `${SYNTH} atlas event ${i + 1}.`,
      status: "info",
      recordId: milestones[i].id,
    })),
  );
}

// ============================================================= cards-only ===
function cardsOnly() {
  const p = new ProjectWriter("cards-only", "cards-only");
  p.manifest({
    displayName: "Cards Only (synthetic)",
    description: `${SYNTH}: third arrangement, expandable cards directly at the root and no progress file.`,
    order: 30,
    theme: { accent: "amber" },
  });
  p.attachment("documents/readme.txt", `${SYNTH}: cards-only attachment.\n`);
  p.sections([
    {
      folder: "inbox",
      manifest: card("inbox", "Inbox", 10, { defaultOpen: true, actions: [...QUESTION_ACTIONS] }),
      records: [
        { id: "CO-Q-001", recordType: "question", title: "Approve the synthetic plan?", summary: `${SYNTH}.`, status: "open", requiresResponse: true, answerSchema: answerSchemaFor("approval", "plan"), updatedAt: at(100) },
        { id: "CO-Q-002", recordType: "question", title: "Upload a synthetic logo", summary: `${SYNTH}.`, status: "open", requiresResponse: true, answerSchema: answerSchemaFor("file-upload", "logo"), updatedAt: at(110) },
        { id: "CO-Q-003", recordType: "question", title: "Synthetic notice (no response needed)", summary: `${SYNTH}.`, status: "open", requiresResponse: false, updatedAt: at(120), notifyUser: true },
      ],
    },
    {
      folder: "notes",
      manifest: card("notes", "Notes", 20, { actions: [...DOC_ACTIONS] }),
      records: [
        { id: "CO-N-001", recordType: "generic", title: "Synthetic note", summary: `${SYNTH}.`, status: "info", updatedAt: at(130) },
        { id: "CO-N-002", recordType: "document", title: "Readme", summary: `${SYNTH}.`, status: "published", updatedAt: at(140), attachments: [{ id: "CO-N-002-txt", path: "documents/readme.txt", mimeType: "text/plain" }] },
      ],
    },
  ]);
}

// ========================================================= broken-project ===
function brokenProject() {
  writeRaw(join(OUT, "projects", "broken-project", "project.json"), `{ "schemaVersion": 1, "id": "broken-project", "displayName": "Broken (synthetic) ` + "\n");
  writeRaw(join(OUT, "projects", "broken-project", "README.md"), `${SYNTH}: project.json is malformed JSON on purpose.\n`);
  counts.brokenFiles++;
}

// ================================================================== main ===
function main() {
  if (!OUT.startsWith(join(REPO, "fixtures"))) throw new Error(`refusing to write outside fixtures/: ${OUT}`);
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeRaw(join(OUT, "README.md"), `# Synthetic fixture data root\n\nGenerated by \`npx tsx scripts/gen-fixtures.ts\`. Everything here is SYNTHETIC test data; do not copy it into real project data.\nRegenerating deletes and rebuilds this folder.\n`);
  harborlightDemo();
  atlasToolkit();
  cardsOnly();
  brokenProject();
  console.log(`fixtures written to ${OUT}`);
  console.log(JSON.stringify({ ...counts, recordsByType: byType, questionAnswerTypes: answerTypes, questionStatuses }, null, 2));
}

main();
