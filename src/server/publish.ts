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
  QUESTION_STATUSES, RECORD_TYPES, SCHEMA_VERSION, Slug, ExternalRef, TrackedFieldValue, type RecordType,
} from "../shared/schemas.js";
import { fieldErrors, fieldValueText } from "../shared/fields.js";
import { statusInfo, workflowFor } from "../shared/workflow.js";
import { agentOf } from "./auth.js";
import { ApiFailure } from "./answers.js";
import type { Config } from "./config.js";
import { atomicWriteFile, safeResolve } from "./fsutil.js";
import { claimKey, UPLOAD_SUBDIR, type ProjectState, type RecordEntry, type SectionState, type Store } from "./store.js";
import { uploadMeta } from "./uploads.js";

/** Version of the agent-facing contract (capabilities, publish calls, queue listing filters). */
export const AGENT_API_VERSION = 1;

/** Short content hash used for optimistic concurrency (`ifRevision`). */
export function revisionOf(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const Revision = z.string().regex(/^[a-f0-9]{16}$/, "16 hex characters expected");

export const serialize = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function zodFieldErrors(e: z.ZodError): FieldError[] {
  return e.issues.slice(0, 20).map((i) => ({ fieldId: i.path.join(".") || "(root)", message: i.message }));
}

export function invalid(what: string, e: z.ZodError): ApiFailure {
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

/** Keys present in `raw` that the schema dropped while parsing (it strips unknown keys), as dotted paths. */
export function unknownKeys(raw: unknown, parsed: unknown, at = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) return raw.flatMap((v, i) => unknownKeys(v, parsed[i], `${at}${i}.`));
  if (!raw || typeof raw !== "object" || !parsed || typeof parsed !== "object" || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in parsed)) { if (v !== undefined) out.push(`${at}${k}`); continue; }
    out.push(...unknownKeys(v, (parsed as Record<string, unknown>)[k], `${at}${k}.`));
  }
  return out;
}

/**
 * Validates a full record, the project's status workflow and the card's tracked fields; returns the parsed record.
 * `strict` (a record sent by a client) also refuses unknown keys (unless `stored` has the same key and value) and
 * attachment roots the project does not declare;
 * a record already on disk is only held to the schema, so an old or hand-edited file never blocks later updates.
 * `ignoreStoredFields` validates only the tracked-field values that still have a valid definition.
 */
export function validateRecord(
  p: ProjectState, raw: Record<string, unknown>, section: SectionState,
  opts: { strict?: boolean; ignoreStoredFields?: boolean; stored?: Record<string, unknown> } = {},
): AnyRecord {
  const parsed = AnyRecord.safeParse(raw);
  if (!parsed.success) throw invalid("record", parsed.error);
  const rec = parsed.data;
  if (opts.strict) {
    // A key the stored file already has with the same value (an older or hand-edited file, echoed back) is accepted.
    const at = (o: unknown, path: string) => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
    const extra = unknownKeys(raw, rec).filter((k) => !opts.stored || !sameJson(at(raw, k), at(opts.stored, k)));
    if (extra.length) {
      throw new ApiFailure(422, "validation", `unknown keys: ${extra.slice(0, 5).join(", ")}`, extra.slice(0, 20).map((k) => ({ fieldId: k, message: "not part of the record format" })));
    }
    const storedAtts = Array.isArray(opts.stored?.attachments) ? (opts.stored.attachments as unknown[]) : [];
    (raw.attachments as unknown[] | undefined)?.forEach((sent, i) => {
      const a = rec.attachments[i];
      // An attachment echoed unchanged from the stored file (older or hand-edited) is not re-checked.
      if (!a || storedAtts.some((x) => sameJson(x, sent))) return;
      if (a.root !== "attachments" && !p.manifest.artifactRoots.includes(a.root)) {
        throw new ApiFailure(422, "validation", `attachments.${i}.root: '${a.root}' is not declared in project.json artifactRoots`, [{ fieldId: `attachments.${i}.root`, message: "undeclared root" }]);
      }
    });
  }
  const checked = opts.ignoreStoredFields
    ? Object.fromEntries(Object.entries(rec.fields).filter(([id, v]) => !fieldErrors(section.manifest.fields, { [id]: v }).length))
    : rec.fields;
  const fe = fieldErrors(section.manifest.fields, checked);
  if (fe.length) {
    throw new ApiFailure(422, "validation", `fields: ${fe.slice(0, 3).map((e) => `${e.fieldId}: ${e.message}`).join("; ")}`, fe.map((e) => ({ fieldId: `fields.${e.fieldId}`, message: e.message })));
  }
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
export function expandUploads(p: ProjectState, raw: Record<string, unknown>): void {
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

export async function readRaw(file: string): Promise<{ text: string; json: Record<string, unknown> } | null> {
  let text: string;
  try { text = await fsp.readFile(file, "utf8"); } catch { return null; }
  try {
    const json = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? { text, json } : { text, json: {} };
  } catch {
    return { text, json: {} };
  }
}

export const rel = (p: ProjectState, file: string) => path.relative(p.dir, file).split(path.sep).join("/");

/** The actor name of the dashboard user in history entries and attachments; agents cannot write under it. */
export const USER_ACTOR = "user";
const isUserActor = (by: unknown) => by === USER_ACTOR;

/**
 * A name a client puts in `by` must be printable ASCII and must not start with "user" (letters and digits only,
 * case-insensitive): that rules out the user's name and look-alikes such as "User (dashboard)", "user" with a
 * zero-width space, or a Cyrillic "е". Server-generated names (token names) are not checked here.
 */
export function checkClientActor(by: unknown, what: string): void {
  if (typeof by !== "string") return; // absent, or reported by the schema
  const letters = by.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[\x20-\x7e]*$/.test(by) || letters.startsWith(USER_ACTOR)) {
    throw new ApiFailure(403, "reserved-actor", `${what}: 'by' must be printable ASCII and must not start with "${USER_ACTOR}" (reserved for the dashboard user)`);
  }
}

/** Record ids map to file names; on case-insensitive file systems two ids differing only in case are one file. */
export function caseVariantOf(p: ProjectState, recordId: string): string | undefined {
  const lower = recordId.toLowerCase();
  for (const id of p.records.keys()) if (id !== recordId && id.toLowerCase() === lower) return id;
  return undefined;
}

function refuseCaseVariant(p: ProjectState, recordId: string): void {
  const other = caseVariantOf(p, recordId);
  if (other) throw new ApiFailure(409, "id-conflict", `record ${other} differs from ${recordId} only in letter case; ids map to file names, which are case-insensitive on some systems`);
}

type Json = Record<string, unknown>;
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const entryKey = (h: unknown) => (h && typeof h === "object" ? `${String((h as Json).at)}\u0000${String((h as Json).text)}` : "");
const fullKey = (h: unknown) => (h && typeof h === "object" ? `${entryKey(h)}\u0000${String((h as Json).by)}` : "");
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const HISTORY_MAX = 500;

/** Keeps at most HISTORY_MAX entries, dropping the oldest entries not written by the user first. */
export function trimHistory(hist: Json[]): Json[] {
  if (hist.length <= HISTORY_MAX) return hist;
  let excess = hist.length - HISTORY_MAX;
  const out = hist.filter((h) => {
    if (excess > 0 && !isUserActor(h?.by)) { excess--; return false; }
    return true;
  });
  return out.length > HISTORY_MAX ? out.slice(-HISTORY_MAX) : out;
}

function byTime(list: Json[]): Json[] {
  // Stable by time; entries without a usable time keep their relative place.
  return list
    .map((h, i) => ({ h, i, t: Date.parse(String(h?.at)) }))
    .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? a.i - b.i : a.t - b.t || a.i - b.i))
    .map((x) => x.h);
}

/**
 * A full write (PUT) replaces what the client owns, never what the dashboard user added. The user's history entries
 * (comments, field changes) and attachments are written back exactly as stored, whatever the client sent for them;
 * tracked fields the write leaves out keep their stored value (`null` clears one). New entries or attachments with a
 * reserved or look-alike `by` are refused; unchanged echoes of stored entries are accepted.
 */
function keepUserParts(raw: Json, stored: Json | undefined): void {
  const storedHist = asArray(stored?.history);
  const storedAtts = asArray(stored?.attachments);
  if (raw.history !== undefined && !Array.isArray(raw.history)) return; // the schema reports it
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) return;
  const hist = asArray(raw.history);
  const atts = asArray(raw.attachments);

  const storedEntries = new Set(storedHist.map(fullKey));
  for (const h of hist) if (!storedEntries.has(fullKey(h))) checkClientActor(h?.by, "history entry");
  for (const a of atts) if (!storedAtts.some((x) => sameJson(x, a))) checkClientActor(a?.by, "attachment");
  if (!stored) return;

  const userHist = storedHist.filter((h) => isUserActor(h?.by));
  if (userHist.length) {
    const userKeys = new Set(userHist.map(entryKey));
    raw.history = trimHistory(byTime([...hist.filter((h) => !userKeys.has(entryKey(h))), ...userHist]));
  }
  const userAtts = storedAtts.filter((a) => isUserActor(a?.by));
  if (userAtts.length) {
    const userIds = new Set(userAtts.map((a) => String(a.id)));
    raw.attachments = [...atts.filter((a) => !userIds.has(String(a?.id))), ...userAtts];
  }

  const storedFields = stored.fields && typeof stored.fields === "object" && !Array.isArray(stored.fields) ? (stored.fields as Json) : {};
  if (raw.fields !== undefined && (typeof raw.fields !== "object" || raw.fields === null || Array.isArray(raw.fields))) return;
  const merged: Json = { ...storedFields, ...((raw.fields as Json | undefined) ?? {}) };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
  if (Object.keys(merged).length || raw.fields !== undefined) raw.fields = merged;
}

export function registerPublishRoutes(app: FastifyInstance, store: Store, cfg: Config): void {
  const project = (id: string): ProjectState => {
    const p = store.get(id);
    // A disabled project ("enabled": false) is off: hidden from the list and refused by id, for reads and writes.
    if (!p || !p.manifest.enabled) throw new ApiFailure(404, "not-found", `project ${id} not found or unavailable`);
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
      const existing = p.records.get(recordId);
      if (!existing) refuseCaseVariant(p, recordId);
      const stored = existing ? await readRaw(existing.file) : null;
      // The client's own field values must be valid; stored values it leaves alone are kept as they are.
      const sentFields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>) : {};
      const storedFields = (stored?.json.fields && typeof stored.json.fields === "object" ? stored.json.fields : {}) as Record<string, unknown>;
      // Values echoed unchanged from the stored file (also of a field whose definition was removed) are not re-checked.
      const own = Object.entries(sentFields).filter(([k, v]) => v !== null && !(k in storedFields && storedFields[k] === v));
      const sentErrors = fieldErrors(section.manifest.fields, Object.fromEntries(own) as Record<string, TrackedFieldValue>);
      if (sentErrors.length) {
        throw new ApiFailure(422, "validation", `fields: ${sentErrors.slice(0, 3).map((e) => `${e.fieldId}: ${e.message}`).join("; ")}`, sentErrors.map((e) => ({ fieldId: `fields.${e.fieldId}`, message: e.message })));
      }
      keepUserParts(raw, stored?.json);
      const rec = validateRecord(p, raw, section, { strict: true, ignoreStoredFields: true, stored: stored?.json });

      // Fields only the dashboard user may change keep their stored value; an agent's full write cannot alter them.
      const kept = existing ? existing.fields : {};
      for (const def of section.manifest.fields) {
        if (def.editableBy.includes("agent")) continue;
        if ((rec.fields[def.id] ?? null) !== (kept[def.id] ?? null)) {
          throw new ApiFailure(403, "field-not-editable", `field '${def.id}' can only be changed by: ${def.editableBy.join(", ")}`);
        }
      }
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
    fields: z.record(z.string().max(40), TrackedFieldValue).optional(),
    /** Replaces the record's external references. */
    external: z.array(ExternalRef).max(20).optional(),
    ifRevision: Revision.optional(),
  }).strict();

  app.patch<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId", async (req) => {
    const recordId = Id.parse(req.params.recordId);
    const body = PatchRecordBody.parse(req.body);
    const grant = agentOf(req);
    return exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      requirePublishing(p);
      const existing = p.records.get(recordId);
      if (!existing) throw new ApiFailure(404, "not-found", "record not found");
      publishSection(p, existing.sectionId);
      return updateRecord(store, p, existing, body, { kind: "agent", name: grant ? grant.name : "api" });
    });
  });

  // A dashboard user's own changes to a record: tracked fields, comments, attachments. Agents use PATCH instead.
  const UserUpdateBody = z.object({
    fields: z.record(z.string().max(40), TrackedFieldValue).optional(),
    comment: z.string().trim().min(1).max(2000).optional(),
    attach: z.array(z.object({ uploadId: Id, title: z.string().max(200).optional() })).max(10).optional(),
    ifRevision: Revision.optional(),
  }).strict();

  app.post<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId/user-update", async (req) => {
    const recordId = Id.parse(req.params.recordId);
    const body = UserUpdateBody.parse(req.body);
    return exclusive(project(req.params.projectId), async () => {
      const p = fresh(project(req.params.projectId));
      const existing = p.records.get(recordId);
      if (!existing) throw new ApiFailure(404, "not-found", "record not found");
      const section = p.sections.get(existing.sectionId)!;
      if ((body.comment || body.attach) && !section.manifest.actions.includes("comment")) {
        throw new ApiFailure(403, "not-allowed", `comments and attachments are not enabled for section ${section.manifest.id}`);
      }
      return updateRecord(store, p, existing, body, { kind: "user", name: "user" });
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
      const variant = p.activity.find((e) => e.id !== eventId && e.id.toLowerCase() === eventId.toLowerCase());
      if (variant) throw new ApiFailure(409, "id-conflict", `activity event ${variant.id} differs from ${eventId} only in letter case; ids map to file names, which are case-insensitive on some systems`);
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

export interface RecordUpdate {
  status?: string;
  statusLabel?: string | null;
  summary?: string;
  percent?: number | null;
  priority?: (typeof PRIORITIES)[number];
  notifyUser?: boolean;
  history?: { at?: string; text: string; by?: string };
  fields?: Record<string, TrackedFieldValue>;
  external?: ExternalRef[];
  comment?: string;
  attach?: { uploadId: string; title?: string }[];
  ifRevision?: string;
}

/**
 * The one place a stored record is changed in part: by an agent (PATCH) or by the dashboard user. Checks the revision
 * and who may change which tracked field, validates the result, records each field change and comment in the history,
 * writes atomically and re-indexes. Callers hold the project's publish lock.
 */
export async function updateRecord(
  store: Store, p: ProjectState, existing: RecordEntry, u: RecordUpdate, actor: { kind: "user" | "agent"; name: string },
): Promise<{ recordId: string; sectionId: string; revision: string; unchanged: boolean }> {
  const section = p.sections.get(existing.sectionId)!;
  const current = await readRaw(existing.file);
  if (!current) throw new ApiFailure(404, "not-found", "record not found");
  if (u.ifRevision && revisionOf(current.text) !== u.ifRevision) {
    throw new ApiFailure(409, "revision-mismatch", "the record changed since you read it; reload and try again", undefined, { revision: revisionOf(current.text) });
  }
  const next: Record<string, unknown> = { ...current.json };
  const now = new Date().toISOString();
  const notes: { at: string; text: string; by?: string }[] = [];
  let changed = false;
  const set = (k: string, v: unknown) => {
    if (v === undefined) return;
    if (v === null) { if (k in next) { delete next[k]; changed = true; } return; }
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) { next[k] = v; changed = true; }
  };
  set("status", u.status);
  set("statusLabel", u.statusLabel);
  set("summary", u.summary);
  set("percent", u.percent);
  set("priority", u.priority);
  set("notifyUser", u.notifyUser);
  set("external", u.external);

  if (u.fields && Object.keys(u.fields).length) {
    const defs = new Map(section.manifest.fields.map((d) => [d.id, d]));
    const fe = fieldErrors(section.manifest.fields, u.fields);
    if (fe.length) {
      throw new ApiFailure(422, "validation", `fields: ${fe.map((e) => `${e.fieldId}: ${e.message}`).join("; ")}`, fe.map((e) => ({ fieldId: `fields.${e.fieldId}`, message: e.message })));
    }
    const values = { ...((next.fields as Record<string, TrackedFieldValue> | undefined) ?? {}) };
    let fieldChanged = false;
    for (const [id, v] of Object.entries(u.fields)) {
      const def = defs.get(id)!;
      if (!def.editableBy.includes(actor.kind)) {
        throw new ApiFailure(403, "field-not-editable", `field '${id}' can only be changed by: ${def.editableBy.join(", ")}`);
      }
      const before = values[id] ?? null;
      if (before === v) continue;
      if (v === null) delete values[id]; else values[id] = v;
      fieldChanged = true;
      notes.push({ at: now, text: `${def.label}: ${fieldValueText(def, before)} → ${fieldValueText(def, v)}`, by: actor.name });
    }
    if (fieldChanged) { next.fields = values; changed = true; }
  }
  if (u.attach?.length) {
    const atts = Array.isArray(next.attachments) ? [...(next.attachments as { id?: string; by?: string }[])] : [];
    for (const a of u.attach) {
      const up = uploadMeta(p, a.uploadId);
      if (up?.answerId || up?.questionId) throw new ApiFailure(409, "id-conflict", `upload ${a.uploadId} belongs to a question's answer`);
    }
    const added = { attachments: u.attach.map((a) => ({ uploadId: a.uploadId, ...(a.title ? { title: a.title } : {}) })) } as Record<string, unknown>;
    expandUploads(p, added);
    for (const a of added.attachments as { id: string; title?: string }[]) {
      if (atts.some((x) => x.id === a.id)) continue;
      atts.push(actor.kind === "user" ? { ...a, by: USER_ACTOR } : a);
      notes.push({ at: now, text: `Attached ${a.title ?? a.id}`, by: actor.name });
      changed = true;
    }
    next.attachments = atts;
  }
  if (u.comment) notes.push({ at: now, text: u.comment, by: actor.name });
  if (u.history && actor.kind === "agent") checkClientActor(u.history.by, "history entry");
  if (u.history) notes.push({ at: u.history.at ?? now, text: u.history.text, ...(u.history.by ? { by: u.history.by } : {}) });
  if (notes.length) {
    const hist = Array.isArray(next.history) ? [...(next.history as Record<string, unknown>[])] : [];
    for (const n of notes) {
      // Same `at` and text = the same entry (a retried call); never append it twice.
      if (!hist.some((h) => h && h.at === n.at && h.text === n.text)) { hist.push(n); changed = true; }
    }
    next.history = trimHistory(hist);
  }
  if (!changed) return { recordId: existing.id, sectionId: existing.sectionId, revision: revisionOf(current.text), unchanged: true };
  next.updatedAt = now;
  validateRecord(p, next, section, { ignoreStoredFields: true });
  const text = serialize(next);
  await atomicWriteFile(existing.file, text);
  await store.applyChanges(p.dir, [rel(p, existing.file)]);
  return { recordId: existing.id, sectionId: existing.sectionId, revision: revisionOf(text), unchanged: false };
}
