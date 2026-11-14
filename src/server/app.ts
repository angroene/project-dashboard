/** HTTP API (Fastify). All filesystem access goes through the Store and resolvers; clients only see ids. */
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import yazl from "yazl";
import { z } from "zod";
import type {
  ActivityPage, AttentionResponse, DiagnosticsResponse, ImportCommitResponse, MarkReadResponse, NavigationResponse,
  ProgressResponse, ProjectsResponse, RecordDetail, RecordPage, SessionInfo, SubmitAnswerResponse, TemplateSummary, UploadResponse, ZipPreflight,
} from "../shared/api.js";
import { Id, RecurringTemplate, SubmitAnswerRequest, TEMPLATE_STATES, type QuestionRecord } from "../shared/schemas.js";
import { agentMayUseProject, agentOf, Auth } from "./auth.js";
import { statusInfo } from "../shared/workflow.js";
import { ApiFailure, claimNext, completeAnswer, failAnswer, listQueue, readAnswer, recoverExpiredLeases, recoverStaging, submitAnswer } from "./answers.js";
import { attachmentRef, inlineSafe, resolveAttachment, type ResolvedAttachment } from "./attachments.js";
import type { Config } from "./config.js";
import { atomicWriteFile, sanitizeFileName } from "./fsutil.js";
import { readRaw, registerPublishRoutes, revisionOf, serialize } from "./publish.js";
import { claimKey, parseRecordFile, Store, type ProjectState, type RecordEntry, type TemplateEntry } from "./store.js";
import { storeUpload, UploadRejected } from "./uploads.js";
import { buildWorkbook, commitImport, previewImport } from "./xlsx.js";

const MAX_SSE_CLIENTS = 50;
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Keyset cursors: the sort key of the last item returned, so inserts/deletes never skip or repeat rows. */
function encodeCursor(v: Record<string, unknown>): string { return Buffer.from(JSON.stringify(v)).toString("base64url"); }
function decodeCursor<T>(c: unknown): T | null {
  if (typeof c !== "string" || !c || c.length > 2000) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString());
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

export interface AppHandle {
  app: FastifyInstance;
  store: Store;
}

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<AppHandle> {
  const store = new Store(cfg);
  await store.init();
  for (const p of store.projects.values()) {
    await recoverStaging(p);
    await recoverExpiredLeases(store, p);
  }
  // Abandoned consumer claims return to pending without anyone having to call /queue/recover.
  const leaseTimer = setInterval(() => {
    for (const p of store.projects.values()) void recoverExpiredLeases(store, p).catch(() => undefined);
  }, 60_000);
  leaseTimer.unref();

  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.logLevel, redact: ["req.headers.cookie", "req.headers.authorization"] },
    bodyLimit: 1024 * 1024,
    trustProxy: cfg.behindHttpsProxy ? "127.0.0.1" : false,
    https: cfg.tls ? { cert: fs.readFileSync(cfg.tls.certFile), key: fs.readFileSync(cfg.tls.keyFile) } : null,
  } as never) as unknown as FastifyInstance;

  const auth = new Auth(cfg);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: Math.max(cfg.uploads.maxBytes, cfg.xlsx.maxBytes), files: cfg.uploads.maxFiles, fields: 10, fieldSize: 1024, parts: cfg.uploads.maxFiles + 10 },
  });
  app.addHook("onRequest", auth.guard);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });
  auth.register(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiFailure) {
      return reply.code(err.status).send({ error: err.code, message: err.message, fieldErrors: err.fieldErrors, details: err.details });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "bad-request", message: err.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal" : "bad-request", message: status >= 500 ? "internal error" : (err as Error).message });
  });

  const project = (id: string): ProjectState => {
    const p = store.get(id);
    if (!p) throw new ApiFailure(404, "not-found", `project ${id} not found or unavailable`);
    return p;
  };
  const user = cfg.auth.user;

  // ---------------------------------------------------------------- read --
  app.get("/api/session", async (req): Promise<SessionInfo> => ({
    authRequired: auth.required,
    authenticated: auth.isAuthenticated(req),
    user,
    productName: cfg.productName,
    uploadLimits: { maxBytes: cfg.uploads.maxBytes, maxFiles: cfg.uploads.maxFiles, allowedMimeTypes: Object.keys(cfg.allowedUploadTypes) },
  }));

  app.get("/api/projects", async (req): Promise<ProjectsResponse> => {
    const grant = agentOf(req);
    const cards = [...store.projects.values()].filter((p) => p.manifest.enabled && agentMayUseProject(grant, p.manifest.id)).map((p) => store.card(p));
    // Broken projects have no trustworthy id, so only the operator sees them.
    if (!grant) cards.push(...store.broken.map((b) => store.brokenCard(b)));
    cards.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
    return { productName: cfg.productName, projects: cards, diagnosticsCount: grant ? 0 : store.diagnostics().length };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req) => store.card(project(req.params.projectId)));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/navigation", async (req): Promise<NavigationResponse> => {
    const p = project(req.params.projectId);
    return { projectId: p.manifest.id, rootChildType: p.rootChildType, nodes: store.navigation(p) };
  });

  app.get<{ Params: { projectId: string; sectionId: string }; Querystring: Record<string, string> }>(
    "/api/projects/:projectId/sections/:sectionId/records",
    async (req): Promise<RecordPage> => {
      const p = project(req.params.projectId);
      const s = p.sections.get(req.params.sectionId);
      if (!s) throw new ApiFailure(404, "not-found", "section not found");
      const q = req.query;
      const limit = Math.min(200, Math.max(1, Number(q.limit) || s.manifest.pageSize));
      const all = store.sectionRecordIds(p, s.manifest.id).map((id) => p.records.get(id)).filter((r): r is RecordEntry => !!r);
      const statusCounts: Record<string, number> = {};
      const statusLabels: Record<string, string> = {};
      let answerable = false;
      let needsResponse = 0;
      for (const r of all) {
        statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
        statusLabels[r.status] ??= statusInfo(p.manifest, r.recordType, r.status).label;
        if (r.question?.requiresResponse) {
          answerable = true;
          if (store.questionUiState(p, r) === "needs-response") needsResponse++;
        }
      }
      let rows = all;
      const status = q.status ?? s.manifest.filters.defaultStatus;
      if (status && status !== "all") {
        const wanted = new Set(status.split(","));
        rows = rows.filter((r) => wanted.has(r.status) || (r.question && wanted.has(store.questionUiState(p, r)!)));
      }
      if (q.unread === "1") rows = rows.filter((r) => store.isUnread(p, r));
      // Tracked-field filters: `field.<id>=a,b` keeps records whose value is one of a, b ("" = not set; true/false for checkboxes).
      for (const def of s.manifest.fields) {
        const want = q[`field.${def.id}`];
        if (want === undefined) continue;
        const allowed = new Set(String(want).split(","));
        rows = rows.filter((r) => allowed.has(fieldKey(r.fields[def.id])));
      }
      if (q.q) {
        const needle = String(q.q).toLowerCase().slice(0, 200);
        rows = rows.filter((r) => r.title.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle));
      }
      const sort = (q.sort as string) || s.manifest.filters.sort;
      const cmp: Record<string, (a: RecordEntry, b: RecordEntry) => number> = {
        "updated-desc": (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        "updated-asc": (a, b) => a.updatedAt.localeCompare(b.updatedAt),
        priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || b.updatedAt.localeCompare(a.updatedAt),
        title: (a, b) => a.title.localeCompare(b.title),
        order: (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title),
      };
      const full = (a: RecordEntry, b: RecordEntry) => (cmp[sort] ?? cmp["updated-desc"])(a, b) || a.id.localeCompare(b.id);
      rows = [...rows].sort(full);
      const after = decodeCursor<{ id: string; updatedAt: string; priority: string; title: string; order?: number }>(q.cursor);
      let start = 0;
      if (after && typeof after.id === "string") {
        const probe = { ...after, title: String(after.title ?? ""), updatedAt: String(after.updatedAt ?? "") } as unknown as RecordEntry;
        start = rows.findIndex((r) => full(r, probe) > 0);
        if (start < 0) start = rows.length;
      }
      const page = rows.slice(start, start + limit);
      const last = page[page.length - 1];
      return {
        sectionId: s.manifest.id,
        total: rows.length,
        unfilteredTotal: all.length,
        statusCounts,
        statusLabels,
        ...(answerable ? { needsResponseCount: needsResponse } : {}),
        fieldDefs: s.manifest.fields,
        fieldCounts: Object.fromEntries(s.manifest.fields.filter((d) => d.filter).map((d) => {
          const counts: Record<string, number> = {};
          for (const r of all) { const k = fieldKey(r.fields[d.id]); counts[k] = (counts[k] ?? 0) + 1; }
          return [d.id, counts];
        })),
        templates: [...p.templates.values()].filter((t) => t.sectionId === s.manifest.id).map((t) => templateSummary(p, t)),
        canComment: s.manifest.actions.includes("comment"),
        items: page.map((r) => store.summary(p, r)),
        nextCursor: last && start + limit < rows.length
          ? encodeCursor({ id: last.id, updatedAt: last.updatedAt, priority: last.priority, title: last.title, order: last.order })
          : null,
      };
    },
  );

  app.get<{ Params: { projectId: string; recordId: string } }>("/api/projects/:projectId/records/:recordId", async (req): Promise<RecordDetail> => {
    const p = project(req.params.projectId);
    const entry = p.records.get(req.params.recordId);
    if (!entry) throw new ApiFailure(404, "not-found", "record not found");
    const [parsed, raw] = await Promise.all([parseRecordFile(entry.file), readRaw(entry.file)]);
    if (!parsed.ok || !raw) throw new ApiFailure(409, "unavailable", `record cannot be read: ${parsed.ok ? "file vanished" : parsed.error}`);
    const rec = parsed.record;
    const pid = p.manifest.id;
    const section = p.sections.get(entry.sectionId)!;
    const detail: RecordDetail = {
      ...store.summary(p, entry),
      revision: revisionOf(raw.text),
      fieldDefs: section.manifest.fields,
      canComment: section.manifest.actions.includes("comment"),
      createdAt: rec.createdAt,
      bodyMarkdown: rec.bodyMarkdown,
      attachments: rec.attachments.map((a) => {
        const r = resolveAttachment(p, a.id);
        return r ? attachmentRef(pid, { ...r, title: a.title ?? r.title }) : { id: a.id, title: a.title ?? a.path, fileName: path.basename(a.path), mimeType: "application/octet-stream", bytes: null, available: false, url: "" };
      }),
      links: rec.links,
      linkedRecords: rec.linkedRecords.map((id) => p.records.get(id)).filter((r): r is RecordEntry => !!r)
        .map((r) => ({ id: r.id, title: r.title, sectionId: r.sectionId, recordType: r.recordType })),
      metadata: rec.metadata,
      history: rec.history,
    };
    if (rec.recordType === "question") {
      const qr = rec as QuestionRecord;
      detail.answerSchema = qr.answerSchema;
      detail.taskId = qr.taskId;
      const claim = p.claims.get(claimKey(qr.id, qr.questionRevision));
      if (claim) {
        const env = await readAnswer(p, claim.answerId);
        if (env) {
          detail.submittedAnswer = {
            answerId: env.answerId, submittedAt: env.submittedAt, source: env.source, processingState: env.processingState, answers: env.answers,
            attachments: env.attachments.map((id) => resolveAttachment(p, id)).filter((r): r is ResolvedAttachment => !!r).map((r) => attachmentRef(pid, r)),
            resultNote: env.result?.note ?? env.result?.reason,
          };
        }
      }
    }
    return detail;
  });

  // ------------------------------------------------------- recurring templates --
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/templates", async (req): Promise<{ templates: TemplateSummary[] }> => {
    const p = project(req.params.projectId);
    return { templates: [...p.templates.values()].sort((a, b) => a.id.localeCompare(b.id)).map((t) => templateSummary(p, t)) };
  });

  const TemplateStateBody = z.object({ state: z.enum(TEMPLATE_STATES) }).strict();
  app.post<{ Params: { projectId: string; templateId: string } }>("/api/projects/:projectId/templates/:templateId/state", async (req): Promise<TemplateSummary> => {
    const body = TemplateStateBody.parse(req.body);
    const id = req.params.projectId;
    return store.mutex.run(`publish:${project(id).manifest.id}`, async () => {
      const p = project(id);
      const entry = p.templates.get(req.params.templateId);
      if (!entry) throw new ApiFailure(404, "not-found", "template not found");
      const raw = await readRaw(entry.file);
      if (!raw) throw new ApiFailure(404, "not-found", "template not found");
      const parsed = RecurringTemplate.safeParse({ ...raw.json, state: body.state });
      if (!parsed.success) throw new ApiFailure(409, "unavailable", `template file is invalid; fix it first (${entry.error ?? parsed.error.issues[0]?.message})`);
      if (raw.json.state !== body.state) {
        await atomicWriteFile(entry.file, serialize({ ...raw.json, state: body.state }));
        await store.applyChanges(p.dir, [path.relative(p.dir, entry.file).split(path.sep).join("/")]);
      }
      const after = project(id);
      return templateSummary(after, after.templates.get(entry.id) ?? entry);
    });
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/progress", async (req): Promise<ProgressResponse> => {
    const p = project(req.params.projectId);
    return { ...p.progress, breakdown: p.progressBreakdown };
  });

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string; limit?: string; unread?: string } }>(
    "/api/projects/:projectId/activity",
    async (req): Promise<ActivityPage> => {
      const p = project(req.params.projectId);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      let items = p.activity;
      if (req.query.unread === "1") items = items.filter((e) => store.isActivityUnread(p, e));
      const after = decodeCursor<{ at: string; id: string }>(req.query.cursor);
      let start = 0;
      if (after && typeof after.at === "string" && typeof after.id === "string") {
        start = items.findIndex((e) => e.at < after.at || (e.at === after.at && e.id.localeCompare(after.id) > 0));
        if (start < 0) start = items.length;
      }
      const slice = items.slice(start, start + limit);
      const page = slice.map((e) => ({ ...e, unread: store.isActivityUnread(p, e) }));
      const lastEv = slice[slice.length - 1];
      return {
        items: page,
        nextCursor: lastEv && start + limit < items.length ? encodeCursor({ at: lastEv.at, id: lastEv.id }) : null,
        unreadCount: p.activity.filter((e) => store.isActivityUnread(p, e)).length,
      };
    },
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/attention", async (req): Promise<AttentionResponse> => {
    const p = project(req.params.projectId);
    const questions: RecordEntry[] = [];
    const unread: RecordEntry[] = [];
    for (const r of p.records.values()) {
      if (store.questionUiState(p, r) === "needs-response") questions.push(r);
      else if (store.isUnread(p, r)) unread.push(r);
    }
    const byDue = (a: RecordEntry, b: RecordEntry) => (a.question?.dueAt ?? "9999").localeCompare(b.question?.dueAt ?? "9999") || b.updatedAt.localeCompare(a.updatedAt);
    return {
      questions: questions.sort(byDue).slice(0, 50).map((r) => store.summary(p, r)),
      unreadRecords: unread.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map((r) => store.summary(p, r)),
    };
  });

  app.get("/api/diagnostics", async (): Promise<DiagnosticsResponse> => ({
    indexedAt: store.indexedAt,
    projects: [...store.projects.values()].map((p) => ({ id: p.manifest.id, records: p.records.size, sections: p.sections.size, indexMs: p.indexMs })),
    diagnostics: store.diagnostics(),
  }));

  // -------------------------------------------------------------- answers --
  app.post<{ Params: { projectId: string; id: string } }>("/api/projects/:projectId/questions/:id/answers", async (req, reply): Promise<SubmitAnswerResponse> => {
    const p = project(req.params.projectId);
    Id.parse(req.params.id);
    const body = SubmitAnswerRequest.parse(req.body);
    const res = await submitAnswer(store, p, req.params.id, body, "dashboard", user);
    reply.code(res.replayed ? 200 : 201);
    return res;
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/uploads", async (req, reply): Promise<UploadResponse> => {
    const p = project(req.params.projectId);
    if (!req.isMultipart()) throw new ApiFailure(400, "bad-request", "multipart/form-data expected");
    let questionId: string | undefined;
    const out: UploadResponse["attachments"] = [];
    const rejected: string[] = [];
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "questionId" && typeof part.value === "string" && part.value) {
          const qid = Id.parse(part.value);
          if (p.records.get(qid)?.recordType !== "question") throw new ApiFailure(400, "bad-request", "unknown questionId");
          questionId = qid;
        }
        continue;
      }
      try {
        const grant = agentOf(req);
        const meta = await storeUpload(cfg, p, part.file, part.filename, grant ? `agent:${grant.name}` : user, questionId);
        out.push({ attachmentId: meta.attachmentId, originalName: meta.originalName, mimeType: meta.mimeType, bytes: meta.bytes });
      } catch (e) {
        if (e instanceof UploadRejected) rejected.push(e.message);
        else throw e;
      }
    }
    if (rejected.length) {
      // All-or-nothing from the user's view: report rejects; accepted files stay unreferenced until used.
      return reply.code(422).send({ error: "upload-rejected", message: rejected.join("; "), details: { accepted: out } });
    }
    if (!out.length) throw new ApiFailure(400, "bad-request", "no file received");
    reply.code(201);
    return { attachments: out };
  });

  app.get<{ Params: { projectId: string; attachmentId: string } }>("/api/projects/:projectId/attachments/:attachmentId", async (req, reply) => {
    const p = project(req.params.projectId);
    const r = resolveAttachment(p, req.params.attachmentId);
    if (!r) throw new ApiFailure(404, "not-found", "attachment not found");
    if (!r.file) throw new ApiFailure(404, "unavailable", `attachment unavailable: ${r.reason ?? "missing"}`);
    const disposition = inlineSafe(r.mimeType) ? "inline" : "attachment";
    reply.header("Content-Type", r.mimeType);
    reply.header("Content-Disposition", contentDisposition(disposition, r.fileName));
    reply.header("Cache-Control", "private, max-age=60");
    if (r.mimeType === "image/svg+xml") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(fs.createReadStream(r.file));
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/records/mark-read", async (req): Promise<MarkReadResponse> => {
    const p = project(req.params.projectId);
    const body = z.object({
      recordIds: z.array(Id).max(1000).optional(),
      activityIds: z.array(Id).max(1000).optional(),
      allActivity: z.boolean().optional(),
    }).parse(req.body ?? {});
    const marked = await store.saveReadState(p, (seen) => {
      let n = 0;
      for (const id of body.recordIds ?? []) {
        const r = p.records.get(id);
        if (r) { seen[`record:${id}`] = r.updatedAt; n++; }
      }
      const acts = body.allActivity ? p.activity.map((e) => e.id) : body.activityIds ?? [];
      for (const id of acts) {
        const e = p.activity.find((x) => x.id === id);
        if (e && !seen[`activity:${id}`]) { seen[`activity:${id}`] = e.at; n++; }
      }
      return n;
    });
    store.invalidate({ projectId: p.manifest.id, scopes: ["projects", "records", "activity", "navigation"], recordIds: body.recordIds });
    return { marked, unreadUpdates: store.card(p).unreadUpdates };
  });

  // ------------------------------------------------------------ bulk ops --
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/export/xlsx", async (req, reply) => {
    const p = project(req.params.projectId);
    const { questionIds } = z.object({ questionIds: z.array(Id).min(1).max(2000) }).parse(req.body);
    const items = [];
    for (const id of [...new Set(questionIds)]) {
      const e = p.records.get(id);
      if (!e || e.recordType !== "question") throw new ApiFailure(400, "bad-request", `${id} is not a question`);
      const parsed = await parseRecordFile(e.file);
      if (!parsed.ok) throw new ApiFailure(409, "unavailable", `${id}: ${parsed.error}`);
      const q = parsed.record as QuestionRecord;
      if (!q.answerSchema) continue;
      items.push({ record: q, uiState: store.questionUiState(p, e) ?? "" });
    }
    if (!items.length) throw new ApiFailure(400, "bad-request", "none of the selected questions take a response");
    const buf = await buildWorkbook(p.manifest.id, items);
    const name = `${p.manifest.id}_questions_${new Date().toISOString().slice(0, 10)}.xlsx`;
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", contentDisposition("attachment", name));
    return reply.send(buf);
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/import/xlsx/preview", async (req) => {
    const p = project(req.params.projectId);
    if (!req.isMultipart()) throw new ApiFailure(400, "bad-request", "multipart/form-data expected");
    const file = await req.file({ limits: { fileSize: cfg.xlsx.maxBytes, files: 1 } });
    if (!file) throw new ApiFailure(400, "bad-request", "no file received");
    if (!file.filename.toLowerCase().endsWith(".xlsx")) { file.file.resume(); throw new ApiFailure(400, "bad-request", "only .xlsx files can be imported"); }
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new ApiFailure(413, "too-large", `workbook larger than ${cfg.xlsx.maxBytes} bytes`);
    return previewImport(store, p, buf, sanitizeFileName(file.filename), cfg.xlsx.maxRows);
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/import/xlsx/commit", async (req): Promise<ImportCommitResponse> => {
    const p = project(req.params.projectId);
    const body = z.object({ previewId: z.string().regex(/^[a-f0-9]{24}$/), questionIds: z.array(Id).min(1).max(2000) }).parse(req.body);
    return commitImport(store, p, body.previewId, body.questionIds, user);
  });

  const zipSelection = (p: ProjectState, body: { recordIds?: string[]; attachmentIds?: string[] }): ZipPreflight & { resolved: ResolvedAttachment[] } => {
    const ids: { id: string; recordId?: string }[] = [];
    for (const rid of body.recordIds ?? []) {
      const r = p.records.get(rid);
      if (!r) continue;
      for (const a of r.attachments) ids.push({ id: a.id, recordId: rid });
      // Include files uploaded with this question's answer.
      if (r.question) {
        const claim = p.claims.get(claimKey(r.id, r.question.revision));
        if (claim) for (const u of p.uploads.values()) if (u.answerId === claim.answerId) ids.push({ id: u.attachmentId, recordId: rid });
      }
    }
    for (const id of body.attachmentIds ?? []) ids.push({ id });
    const seen = new Set<string>();
    const resolved: ResolvedAttachment[] = [];
    const missing: ZipPreflight["missing"] = [];
    for (const { id, recordId } of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const r = resolveAttachment(p, id);
      if (!r) missing.push({ attachmentId: id, recordId, reason: "unknown attachment" });
      else if (!r.file) missing.push({ attachmentId: id, recordId: recordId ?? r.recordId, reason: r.reason ?? "missing" });
      else resolved.push({ ...r, recordId: recordId ?? r.recordId });
    }
    return {
      resolved,
      available: resolved.map((r) => attachmentRef(p.manifest.id, r)),
      missing,
      totalBytes: resolved.reduce((n, r) => n + (r.bytes ?? 0), 0),
    };
  };
  const ZipBody = z.object({ recordIds: z.array(Id).max(2000).optional(), attachmentIds: z.array(Id).max(2000).optional() });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/download/zip/preflight", async (req): Promise<ZipPreflight> => {
    const p = project(req.params.projectId);
    const { resolved: _r, ...rest } = zipSelection(p, ZipBody.parse(req.body ?? {}));
    return rest;
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/download/zip", async (req, reply) => {
    const p = project(req.params.projectId);
    const sel = zipSelection(p, ZipBody.parse(req.body ?? {}));
    if (!sel.resolved.length) throw new ApiFailure(404, "nothing-to-download", "none of the selected items has an available file");
    if (sel.totalBytes > 1024 * 1024 * 1024) throw new ApiFailure(413, "too-large", "selection is larger than 1 GB");
    const zip = new yazl.ZipFile();
    const used = new Set<string>();
    const manifest = { projectId: p.manifest.id, createdAt: new Date().toISOString(), files: [] as unknown[], missing: sel.missing };
    for (const r of sel.resolved) {
      const folder = sanitizeFileName(r.recordId ?? "attachments");
      let name = `${folder}/${sanitizeFileName(r.fileName)}`;
      for (let i = 2; used.has(name.toLowerCase()); i++) {
        const ext = path.extname(r.fileName);
        name = `${folder}/${sanitizeFileName(path.basename(r.fileName, ext))}-${i}${ext}`;
      }
      used.add(name.toLowerCase());
      zip.addFile(r.file!, name);
      manifest.files.push({ path: name, attachmentId: r.id, recordId: r.recordId, title: r.title, mimeType: r.mimeType, bytes: r.bytes });
    }
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), "manifest.json");
    zip.end();
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", `${p.manifest.id}_documents_${new Date().toISOString().slice(0, 10)}.zip`));
    return reply.send(zip.outputStream);
  });

  // ------------------------------------------------- queue (consumer API) --
  const Owner = z.string().regex(/^[A-Za-z0-9._:@-]{1,120}$/);
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/queue/claim", async (req, reply) => {
    const p = project(req.params.projectId);
    const b = z.object({ owner: Owner, leaseSeconds: z.number().int().min(10).max(86400).default(600), answerId: Id.optional() }).parse(req.body ?? {});
    const env = await claimNext(store, p, b.owner, b.leaseSeconds, b.answerId);
    if (!env) return reply.code(204).send();
    return env;
  });
  app.get<{ Params: { projectId: string }; Querystring: Record<string, string | undefined> }>("/api/projects/:projectId/queue", async (req) => {
    const p = project(req.params.projectId);
    const q = z.object({
      state: z.enum(["pending", "processing", "processed", "failed"]).default("pending"),
      limit: z.coerce.number().int().min(1).max(5000).default(500),
      after: Id.optional(),
      questionId: Id.optional(),
      taskId: Id.optional(),
    }).parse(req.query);
    // Filters use the in-memory index (question id from the claim file, task id from the question record).
    const match = q.questionId || q.taskId
      ? (questionId: string | undefined) => !!questionId && (!q.questionId || questionId === q.questionId) &&
        (!q.taskId || p.records.get(questionId)?.question?.taskId === q.taskId)
      : undefined;
    return listQueue(p, q.state, q.limit, q.after, match);
  });
  app.get<{ Params: { projectId: string; answerId: string } }>("/api/projects/:projectId/queue/:answerId", async (req) => {
    const p = project(req.params.projectId);
    const env = await readAnswer(p, Id.parse(req.params.answerId));
    if (!env) throw new ApiFailure(404, "not-found", `answer ${req.params.answerId} not found`);
    return env;
  });
  app.post<{ Params: { projectId: string; answerId: string } }>("/api/projects/:projectId/queue/:answerId/complete", async (req) => {
    const p = project(req.params.projectId);
    const b = z.object({ owner: Owner, note: z.string().max(5000).optional() }).parse(req.body ?? {});
    return completeAnswer(store, p, Id.parse(req.params.answerId), b.owner, b.note);
  });
  app.post<{ Params: { projectId: string; answerId: string } }>("/api/projects/:projectId/queue/:answerId/fail", async (req) => {
    const p = project(req.params.projectId);
    const b = z.object({ owner: Owner, reason: z.string().min(1).max(5000), retryable: z.boolean().default(false) }).parse(req.body ?? {});
    return failAnswer(store, p, Id.parse(req.params.answerId), b.owner, b.reason, b.retryable);
  });
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/queue/recover", async (req) => {
    const p = project(req.params.projectId);
    return { recovered: await recoverExpiredLeases(store, p) };
  });

  registerPublishRoutes(app, store, cfg);

  app.post("/api/admin/reindex", async () => {
    await store.init();
    store.invalidate({ projectId: null, scopes: ["projects", "navigation", "records", "progress", "activity", "answers"] });
    return { indexedAt: store.indexedAt, projects: store.projects.size };
  });

  // ------------------------------------------------------------------ SSE --
  let sseClients = 0;
  app.get("/api/updates", (req, reply) => {
    if (sseClients >= MAX_SSE_CLIENTS) {
      return reply.code(503).send({ error: "busy", message: "too many live-update connections; the UI falls back to polling" });
    }
    sseClients++;
    req.raw.on("close", () => { sseClients--; });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 5000\n\n");
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onInvalidate = (ev: unknown) => send("invalidate", ev);
    store.on("invalidate", onInvalidate);
    const ping = setInterval(() => send("ping", { at: new Date().toISOString() }), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      store.off("invalidate", onInvalidate);
    });
    reply.hijack();
  });

  app.all("/api/*", async (_req, reply: FastifyReply) => reply.code(404).send({ error: "not-found", message: "unknown endpoint" }));

  // ------------------------------------------------------------- static UI --
  const webRoot = cfg.webRoot ? path.resolve(cfg.webRoot) : null;
  if (webRoot && fs.existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, index: ["index.html"], wildcard: false, serveDotFiles: false });
    app.setNotFoundHandler((_req, reply) => reply.type("text/html").sendFile("index.html"));
  }

  app.addHook("onClose", async () => { clearInterval(leaseTimer); store.stop(); });
  return { app, store };
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Filter/count key of a tracked field value: "" when not set, "true"/"false" for checkboxes. */
function fieldKey(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function templateSummary(p: ProjectState, t: TemplateEntry): TemplateSummary {
  const tpl = t.template;
  return {
    id: t.id,
    sectionId: t.sectionId,
    title: tpl?.title ?? t.id,
    state: tpl?.state ?? "disabled",
    schedule: tpl ? { ...tpl.schedule } : { frequency: "daily", time: "00:00", timezone: "UTC", startDate: "", catchUpDays: 0 },
    ...(p.recurrenceCursor[t.id] ? { lastDate: p.recurrenceCursor[t.id] } : {}),
    ...(t.error ?? t.runError ? { error: t.error ?? t.runError } : {}),
  };
}
