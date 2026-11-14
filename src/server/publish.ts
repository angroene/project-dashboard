/**
 * Producer side of the API: lets authorised clients (agents, CI jobs, scripts) write records, activity events and
 * progress through the server instead of into the project folder. Only for projects whose project.json enables
 * `publishing`; the server validates everything and writes atomically into the same files a local producer would.
 * See docs/AGENT_INTEGRATION.md and ADR 0009.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FieldError } from "../shared/validate.js";
import {
  ActivityEvent, ANSWER_TYPES, AnswerSchema, AnyRecord, DEFAULT_WORKFLOWS, Id, IsoTime, PRIORITIES, PROCESSING_STATES, ProgressFile,
  QUESTION_STATUSES, RECORD_TYPES, SCHEMA_VERSION, Slug, type RecordType,
} from "../shared/schemas.js";
import { statusInfo, workflowFor } from "../shared/workflow.js";
import { agentOf } from "./auth.js";
import { ApiFailure } from "./answers.js";
import type { Config } from "./config.js";
import { atomicWriteFile, safeResolve } from "./fsutil.js";
import { claimKey, UPLOAD_SUBDIR, type ProjectState, type SectionState, type Store } from "./store.js";
import { uploadMeta } from "./uploads.js";

/** Version of the agent-facing contract (capabilities, publish calls, queue listing filters). */
export const AGENT_API_VERSION = 1;

/** Short content hash used for optimistic concurrency (`ifRevision`). */
export function revisionOf(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const Revision = z.string().regex(/^[a-f0-9]{16}$/, "16 hex characters expected");

const serialize = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function zodFieldErrors(e: z.ZodError): FieldError[] {
  return e.issues.slice(0, 20).map((i) => ({ fieldId: i.path.join(".") || "(root)", message: i.message }));
}

function invalid(what: string, e: z.ZodError): ApiFailure {
  const fe = zodFieldErrors(e);
  return new ApiFailure(422, "validation", `${what} is invalid: ${fe.slice(0, 3).map((f) => `${f.fieldId}: ${f.message}`).join("; ")}`, fe);
}

function requirePublishing(p: ProjectState): void {
  if (!p.manifest.publishing.enabled) {
    throw new ApiFailure(403, "publishing-disabled", `project ${p.manifest.id} does not accept published records (project.json "publishing.enabled" is false)`);
  }
}

/** The card a client may write records into, addressed by its logical section id; never by path. */
function publishSection(p: ProjectState, sectionId: string): SectionState {
  requirePublishing(p);
  const s = p.sections.get(sectionId);
  if (!s) throw new ApiFailure(404, "not-found", `section ${sectionId} not found`);
  if (s.manifest.displayType !== "expandable-card") throw new ApiFailure(422, "not-a-card", `section ${sectionId} is a ${s.manifest.displayType}; records live only in expandable-card sections`);
  const allowed = p.manifest.publishing.sections;
  if (allowed && !allowed.includes(sectionId)) throw new ApiFailure(403, "section-not-allowed", `section ${sectionId} is not open for publishing`);
  return s;
}

/** Validates a full record and the project's status workflow; returns the parsed record. */
function validateRecord(p: ProjectState, raw: Record<string, unknown>): AnyRecord {
  const parsed = AnyRecord.safeParse(raw);
  if (!parsed.success) throw invalid("record", parsed.error);
  const rec = parsed.data;
  if (!statusInfo(p.manifest, rec.recordType, rec.status).known) {
    const allowed = rec.recordType === "question" ? [...QUESTION_STATUSES] : workflowFor(p.manifest, rec.recordType).statuses.map((s) => s.id);
    throw new ApiFailure(422, "validation", `status '${rec.status}' is not in this project's ${rec.recordType} workflow`, [
      { fieldId: "status", message: `allowed: ${allowed.join(", ")}` },
    ]);
  }
  for (const a of rec.attachments) {
    const owner = p.attachments.get(a.id);
    if ((owner && owner.recordId !== rec.id) || (uploadMeta(p, a.id) && a.path !== uploadPath(p, a.id))) {
      throw new ApiFailure(409, "id-conflict", `attachment id ${a.id} is already used by another record or upload`);
    }
  }
  return rec;
}

function uploadPath(p: ProjectState, uploadId: string): string | undefined {
  const up = uploadMeta(p, uploadId);
  return up ? `${UPLOAD_SUBDIR}/${up.storedName}` : undefined;
}

/** `{uploadId, title?}` attachment shorthand → a normal record attachment pointing at the stored upload. */
function expandUploads(p: ProjectState, raw: Record<string, unknown>): void {
  if (!Array.isArray(raw.attachments)) return;
  raw.attachments = raw.attachments.map((a: unknown, i: number) => {
    if (!a || typeof a !== "object" || !("uploadId" in a)) return a;
    const { uploadId, title, id } = a as { uploadId: unknown; title?: unknown; id?: unknown };
    if (typeof uploadId !== "string" || !uploadMeta(p, uploadId)) {
      throw new ApiFailure(422, "validation", `attachments.${i}: unknown uploadId`, [{ fieldId: `attachments.${i}.uploadId`, message: "unknown upload" }]);
    }
    if (id !== undefined && id !== uploadId) throw new ApiFailure(422, "validation", `attachments.${i}: id must equal uploadId when uploadId is used`);
    const up = uploadMeta(p, uploadId)!;
    return { id: uploadId, title: typeof title === "string" ? title : up.originalName, path: uploadPath(p, uploadId), root: "attachments" };
  });
}

async function readRaw(file: string): Promise<{ text: string; json: Record<string, unknown> } | null> {
  let text: string;
  try { text = await fsp.readFile(file, "utf8"); } catch { return null; }
  try {
    const json = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? { text, json } : { text, json: {} };
  } catch {
    return { text, json: {} };
  }
}

const rel = (p: ProjectState, file: string) => path.relative(p.dir, file).split(path.sep).join("/");

export function registerPublishRoutes(app: FastifyInstance, store: Store, cfg: Config): void {
  const project = (id: string): ProjectState => {
    const p = store.get(id);
    if (!p) throw new ApiFailure(404, "not-found", `project ${id} not found or unavailable`);
    return p;
  };
  /** All publish writes of one project are serialised: id uniqueness across sections is checked and written atomically. */
  const exclusive = <T>(p: ProjectState, fn: () => Promise<T>) => store.mutex.run(`publish:${p.manifest.id}`, fn);
  const fresh = (p: ProjectState) => store.get(p.manifest.id) ?? p;

  // -------------------------------------------------------- capabilities --
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/capabilities", async (req) => {
    const p = project(req.params.projectId);
    const grant = agentOf(req);
    const allowed = p.manifest.publishing.sections;
    const cards = [...p.sections.values()].filter((s) => s.manifest.displayType === "expandable-card");
    const titlePath = (s: SectionState): string[] => {
      const out: string[] = [];
      for (let cur: SectionState | undefined = s; cur; cur = cur.parentId ? p.sections.get(cur.parentId) : undefined) out.unshift(cur.manifest.title);
      return out;
    };
    const recordTypes: Record<string, { id: string; label: string; category: string }[]> = {};
    for (const t of RECORD_TYPES) {
      recordTypes[t] = t === "question"
        ? QUESTION_STATUSES.map((id) => ({ id, ...statusInfo(p.manifest, "question", id) })).map(({ id, label, category }) => ({ id, label, category }))
        : workflowFor(p.manifest, t as Exclude<RecordType, "question">).statuses.map((s) => ({ id: s.id, label: s.label, category: s.category }));
    }
    return {
      apiVersion: AGENT_API_VERSION,
      projectId: p.manifest.id,
      displayName: p.manifest.displayName,
      caller: grant ? { kind: "agent", name: grant.name, scopes: [...grant.scopes] } : { kind: "operator" },
      publishing: {
        enabled: p.manifest.publishing.enabled,
        sections: p.manifest.publishing.enabled
          ? cards.filter((s) => !allowed || allowed.includes(s.manifest.id)).map((s) => ({ id: s.manifest.id, title: s.manifest.title, path: titlePath(s) }))
          : [],
      },
      recordTypes,
      customWorkflows: Object.keys(p.manifest.workflows).filter((t) => t in DEFAULT_WORKFLOWS),
      answerTypes: ANSWER_TYPES,
      priorities: PRIORITIES,
      queueStates: PROCESSING_STATES,
      uploads: { maxBytes: cfg.uploads.maxBytes, maxFiles: cfg.uploads.maxFiles, allowedMimeTypes: Object.keys(cfg.allowedUploadTypes) },
    };
  });

  // -------------------------------------------------------------- records --
  app.get<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId/source", async (req) => {
    const p = project(req.params.projectId);
    const entry = p.records.get(Id.parse(req.params.recordId));
    if (!entry) throw new ApiFailure(404, "not-found", "record not found");
    const raw = await readRaw(entry.file);
    if (!raw) throw new ApiFailure(404, "not-found", "record not found");
    return { recordId: entry.id, sectionId: entry.sectionId, revision: revisionOf(raw.text), record: raw.json };
  });

  const PutRecordBody = z.object({
    sectionId: Slug,
    record: z.record(z.string(), z.unknown()),
    ifRevision: Revision.optional(),
  });

  app.put<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId", async (req, reply) => {
    const recordId = Id.parse(req.params.recordId);
    const body = PutRecordBody.parse(req.body);
    const result = await exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      const section = publishSection(p, body.sectionId);
      const raw: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, ...body.record, id: body.record.id ?? recordId };
      if (raw.id !== recordId) throw new ApiFailure(400, "bad-request", "record.id differs from the id in the URL");
      raw.updatedAt ??= new Date().toISOString();
      expandUploads(p, raw);
      const rec = validateRecord(p, raw);

      const existing = p.records.get(recordId);
      if (existing && existing.sectionId !== section.manifest.id) {
        throw new ApiFailure(409, "id-conflict", `record ${recordId} already exists in section ${existing.sectionId}; record ids are unique per project`);
      }
      const file = existing?.file ?? path.join(section.dir, "records", `${recordId}.json`);
      const current = await readRaw(file);
      if (body.ifRevision && (!current || revisionOf(current.text) !== body.ifRevision)) {
        throw new ApiFailure(409, "revision-mismatch", "the record changed since you read it; fetch /source again and retry", undefined, current ? { revision: revisionOf(current.text) } : undefined);
      }
      if (existing?.question && rec.recordType === "question" && current) {
        // Changing what an already-answered revision asks would silently re-interpret the stored answer.
        const answered = p.claims.has(claimKey(recordId, existing.question.revision));
        const old = current.json as { answerSchema?: unknown; questionRevision?: number };
        const norm = (v: unknown) => JSON.stringify(AnswerSchema.safeParse(v).data ?? null);
        if (answered && rec.questionRevision === (old.questionRevision ?? 1) && norm(rec.answerSchema) !== norm(old.answerSchema)) {
          throw new ApiFailure(409, "revision-required", `revision ${rec.questionRevision} of ${recordId} already has an answer; raise questionRevision to change the answer schema`);
        }
      }
      const text = serialize(raw);
      if (current?.text === text) return { recordId, sectionId: section.manifest.id, revision: revisionOf(text), created: false, unchanged: true };
      await atomicWriteFile(file, text);
      await store.applyChanges(p.dir, [rel(p, file)]);
      const indexed = fresh(p).records.get(recordId);
      if (!indexed || indexed.file !== file) throw new ApiFailure(500, "internal", "record written but not indexed");
      return { recordId, sectionId: section.manifest.id, revision: revisionOf(text), created: !current, unchanged: false };
    });
    reply.code(result.created ? 201 : 200);
    return result;
  });

  const PatchRecordBody = z.object({
    status: Slug.optional(),
    statusLabel: z.string().max(60).nullable().optional(),
    summary: z.string().max(1000).optional(),
    percent: z.number().min(0).max(100).nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    notifyUser: z.boolean().optional(),
    history: z.object({ at: IsoTime.optional(), text: z.string().min(1).max(2000), by: z.string().max(80).optional() }).optional(),
    ifRevision: Revision.optional(),
  }).strict();

  app.patch<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId", async (req) => {
    const recordId = Id.parse(req.params.recordId);
    const body = PatchRecordBody.parse(req.body);
    return exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      requirePublishing(p);
      const existing = p.records.get(recordId);
      if (!existing) throw new ApiFailure(404, "not-found", "record not found");
      publishSection(p, existing.sectionId);
      const current = await readRaw(existing.file);
      if (!current) throw new ApiFailure(404, "not-found", "record not found");
      if (body.ifRevision && revisionOf(current.text) !== body.ifRevision) {
        throw new ApiFailure(409, "revision-mismatch", "the record changed since you read it", undefined, { revision: revisionOf(current.text) });
      }
      const next: Record<string, unknown> = { ...current.json };
      let changed = false;
      const set = (k: string, v: unknown) => {
        if (v === undefined) return;
        if (v === null) { if (k in next) { delete next[k]; changed = true; } return; }
        if (next[k] !== v) { next[k] = v; changed = true; }
      };
      set("status", body.status);
      set("statusLabel", body.statusLabel);
      set("summary", body.summary);
      set("percent", body.percent);
      set("priority", body.priority);
      set("notifyUser", body.notifyUser);
      if (body.history) {
        const entry = { at: body.history.at ?? new Date().toISOString(), text: body.history.text, ...(body.history.by ? { by: body.history.by } : {}) };
        const hist = Array.isArray(next.history) ? [...(next.history as Record<string, unknown>[])] : [];
        // Same `at` and text = the same entry (a retried call); never append it twice.
        if (!hist.some((h) => h && h.at === entry.at && h.text === entry.text)) { hist.push(entry); next.history = hist; changed = true; }
      }
      if (!changed) return { recordId, sectionId: existing.sectionId, revision: revisionOf(current.text), unchanged: true };
      next.updatedAt = new Date().toISOString();
      validateRecord(p, next);
      const text = serialize(next);
      await atomicWriteFile(existing.file, text);
      await store.applyChanges(p.dir, [rel(p, existing.file)]);
      return { recordId, sectionId: existing.sectionId, revision: revisionOf(text), unchanged: false };
    });
  });

  // ------------------------------------------------------------- activity --
  app.put<{ Params: { projectId: string; eventId: string } }>("/api/projects/:projectId/activity/:eventId", async (req, reply) => {
    const eventId = Id.parse(req.params.eventId);
    const input = z.record(z.string(), z.unknown()).parse(req.body);
    const result = await exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      requirePublishing(p);
      const raw: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, ...input, id: input.id ?? eventId };
      if (raw.id !== eventId) throw new ApiFailure(400, "bad-request", "event id differs from the id in the URL");
      const clientSentAt = raw.at !== undefined;
      raw.at ??= new Date().toISOString();
      const parsed = ActivityEvent.safeParse(raw);
      if (!parsed.success) throw invalid("activity event", parsed.error);
      if (parsed.data.recordId && !p.records.has(parsed.data.recordId)) {
        throw new ApiFailure(422, "validation", `recordId ${parsed.data.recordId} is not a record of this project`, [{ fieldId: "recordId", message: "unknown record" }]);
      }
      const dir = safeResolve(p.dir, p.manifest.activityDir);
      const file = path.join(dir, `${eventId}.json`);
      const current = await readRaw(file);
      if (!current && p.activity.some((e) => e.id === eventId)) throw new ApiFailure(409, "id-conflict", `activity event ${eventId} already exists`);
      if (current) {
        // Events are immutable: a replay of the same event is accepted, a different event under the same id is not.
        const same = (a: Record<string, unknown>, b: Record<string, unknown>) => serialize(clientSentAt ? a : { ...a, at: undefined }) === serialize(clientSentAt ? b : { ...b, at: undefined });
        if (same(current.json, raw)) return { eventId, created: false, unchanged: true };
        throw new ApiFailure(409, "id-conflict", `activity event ${eventId} already exists with different content; events are immutable`);
      }
      await atomicWriteFile(file, serialize(raw));
      await store.applyChanges(p.dir, [rel(p, file)]);
      return { eventId, created: true, unchanged: false };
    });
    reply.code(result.created ? 201 : 200);
    return result;
  });

  // ------------------------------------------------------------- progress --
  app.put<{ Params: { projectId: string } }>("/api/projects/:projectId/progress", async (req) => {
    const input = z.object({ progress: z.record(z.string(), z.unknown()), ifRevision: Revision.optional() }).parse(req.body);
    return exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      requirePublishing(p);
      const raw: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, ...input.progress };
      raw.updatedAt ??= new Date().toISOString();
      const parsed = ProgressFile.safeParse(raw);
      if (!parsed.success) throw invalid("progress", parsed.error);
      const file = safeResolve(p.dir, p.manifest.progressFile);
      const current = await readRaw(file);
      if (input.ifRevision && (!current || revisionOf(current.text) !== input.ifRevision)) {
        throw new ApiFailure(409, "revision-mismatch", "progress changed since you read it", undefined, current ? { revision: revisionOf(current.text) } : undefined);
      }
      const text = serialize(raw);
      if (current?.text === text) return { revision: revisionOf(text), unchanged: true };
      await atomicWriteFile(file, text);
      await store.applyChanges(p.dir, [rel(p, file)]);
      return { revision: revisionOf(text), unchanged: false };
    });
  });
}
