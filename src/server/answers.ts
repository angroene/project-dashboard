/**
 * Answer submission and the per-project file queue:
 *   communications/answers/{pending,processing,processed,failed}/<answerId>.json  (one file per answer)
 *   communications/claims/<questionId>@r<revision>.json                          (one per answered question revision, O_EXCL)
 * The claim file is the duplicate guard across processes. Every queue transition runs under a per-project
 * in-process mutex plus an O_EXCL lock file per answer (cross-process), see ADR 0003.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  AnswerEnvelope, type AnswerValue, type ProcessingState, type QuestionRecord, type SubmitAnswerRequest,
} from "../shared/schemas.js";
import { validateAnswer, type FieldError } from "../shared/validate.js";
import { atomicWriteJson, createExclusive, newId, readJson, renameWithRetry } from "./fsutil.js";
import { ANSWERS_DIR, CLAIMS_DIR, claimKey, parseRecordFile, type ProjectState, type Store } from "./store.js";
import { markUploadsUsed, uploadMeta } from "./uploads.js";

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fieldErrors?: FieldError[], readonly details?: unknown) {
    super(message);
  }
}

const STAGING = ".staging";
const LOCKS = ".locks";
const STALE_LOCK_MS = 5 * 60 * 1000;
const answersDir = (p: ProjectState, st: ProcessingState | typeof STAGING) => path.join(p.dir, ANSWERS_DIR, st);
const claimFile = (p: ProjectState, qid: string, rev: number) => path.join(p.dir, CLAIMS_DIR, `${claimKey(qid, rev)}.json`);
const lockFile = (p: ProjectState, answerId: string) => path.join(p.dir, ANSWERS_DIR, LOCKS, `${answerId}.lock`);
const queueKey = (p: ProjectState) => `queue:${p.manifest.id}`;

export async function findAnswerFile(p: ProjectState, answerId: string): Promise<{ file: string; state: ProcessingState } | null> {
  const known = p.answerStates.get(answerId);
  const order: ProcessingState[] = known ? [known, "pending", "processing", "processed", "failed"] : ["pending", "processing", "processed", "failed"];
  for (const st of order) {
    const f = path.join(answersDir(p, st), `${answerId}.json`);
    if (fs.existsSync(f)) return { file: f, state: st };
  }
  return null;
}

export async function readAnswer(p: ProjectState, answerId: string): Promise<AnswerEnvelope | null> {
  const loc = await findAnswerFile(p, answerId);
  if (!loc) return null;
  const raw = await readJson(loc.file, 1024 * 1024);
  if (!raw.ok) return null;
  const parsed = AnswerEnvelope.safeParse(raw.value);
  return parsed.success ? { ...parsed.data, processingState: loc.state } : null;
}

export interface SubmitResult {
  answerId: string;
  processingState: ProcessingState;
  replayed: boolean;
}

/** Validate and enqueue one answer. Used by the dashboard form and by Excel import alike. */
export async function submitAnswer(
  store: Store,
  p: ProjectState,
  questionId: string,
  req: SubmitAnswerRequest,
  source: "dashboard" | "excel-import",
  user: string,
): Promise<SubmitResult> {
  return store.mutex.run(queueKey(p), async () => {
    const entry = p.records.get(questionId);
    if (!entry || entry.recordType !== "question") throw new ApiFailure(404, "not-found", `question ${questionId} not found`);

    // Idempotent replay first: a retry with the same key returns the original answer even if the
    // question has moved on since (answered/revised).
    const cfile = claimFile(p, questionId, req.questionRevision);
    const existing = await readJson(cfile, 16 * 1024);
    const claim = existing.ok ? (existing.value as { answerId?: string; idempotencyKey?: string }) : null;
    const loc = claim?.answerId ? await findAnswerFile(p, claim.answerId) : null;
    if (claim?.answerId && loc && claim.idempotencyKey === req.idempotencyKey) {
      return { answerId: claim.answerId, processingState: loc.state, replayed: true };
    }

    const parsed = await parseRecordFile(entry.file);
    if (!parsed.ok || parsed.record.recordType !== "question") throw new ApiFailure(409, "unavailable", `question ${questionId} cannot be read`);
    const q = parsed.record as QuestionRecord;
    if (!q.requiresResponse || !q.answerSchema) throw new ApiFailure(409, "not-answerable", "this question does not take a response");
    if (q.status !== "open") throw new ApiFailure(409, "not-open", `question is ${q.status}`);
    if (req.questionRevision !== q.questionRevision) {
      throw new ApiFailure(409, "stale-revision", `question was revised (now revision ${q.questionRevision}, answer was for ${req.questionRevision})`);
    }
    if (claim) {
      // Only a positively failed answer, or a claim whose answer exists nowhere (staging included), may be replaced.
      const staged = claim.answerId ? fs.existsSync(path.join(answersDir(p, STAGING), `${claim.answerId}.json`)) : false;
      const replaceable = (loc && loc.state === "failed") || (!loc && !staged);
      if (!replaceable) throw new ApiFailure(409, "already-answered", "this question revision already has an answer", undefined, { answerId: claim.answerId });
    }

    const errors = validateAnswer(q.answerSchema, req.answers, {
      questionId,
      uploads: (id) => {
        const u = uploadMeta(p, id);
        return u ? { mimeType: u.mimeType, questionId: u.questionId, answerId: u.answerId } : undefined;
      },
    });
    if (errors.length) throw new ApiFailure(422, "validation", "answer is not valid", errors);

    if (claim) {
      const hist = path.join(p.dir, "communications", "claims-history");
      await fsp.mkdir(hist, { recursive: true });
      await renameWithRetry(cfile, path.join(hist, `${claimKey(questionId, q.questionRevision)}.${claim.answerId ?? "orphan"}.json`));
    }

    const attachmentIds = req.answers.flatMap((a: AnswerValue) => (a.kind === "files" ? a.attachmentIds : []));
    const now = new Date().toISOString();
    const answerId = newId("ANS");
    const env: AnswerEnvelope = {
      schemaVersion: 1,
      answerId,
      projectId: p.manifest.id,
      questionId,
      taskId: q.taskId,
      questionRevision: q.questionRevision,
      submittedAt: now,
      source,
      submittedBy: user,
      idempotencyKey: req.idempotencyKey,
      answers: req.answers,
      attachments: attachmentIds,
      processingState: "pending",
      attempts: 0,
      audit: [{ at: now, event: "submitted", by: user, note: source }],
    };
    AnswerEnvelope.parse(env);

    // 1) stage, 2) exclusive claim, 3) publish to pending.
    const staged = path.join(answersDir(p, STAGING), `${answerId}.json`);
    await atomicWriteJson(staged, env);
    const claimed = await createExclusive(cfile, {
      answerId, questionId, questionRevision: q.questionRevision, submittedAt: now, idempotencyKey: req.idempotencyKey, source,
    });
    if (!claimed) {
      await fsp.rm(staged, { force: true });
      throw new ApiFailure(409, "already-answered", "this question revision was answered concurrently");
    }
    await fsp.mkdir(answersDir(p, "pending"), { recursive: true });
    await renameWithRetry(staged, path.join(answersDir(p, "pending"), `${answerId}.json`));
    if (attachmentIds.length) await markUploadsUsed(p, attachmentIds, answerId);

    p.claims.set(claimKey(questionId, q.questionRevision), { answerId, questionId, revision: q.questionRevision, submittedAt: now });
    p.answerStates.set(answerId, "pending");
    store.invalidate({ projectId: p.manifest.id, scopes: ["answers", "records", "projects", "navigation"], recordIds: [questionId] });
    return { answerId, processingState: "pending", replayed: false };
  });
}

/** Startup recovery for answers staged but not published (crash between steps). */
export async function recoverStaging(p: ProjectState): Promise<{ published: number; removed: number }> {
  const dir = answersDir(p, STAGING);
  let files: string[] = [];
  try { files = await fsp.readdir(dir); } catch { return { published: 0, removed: 0 }; }
  let published = 0, removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) { await fsp.rm(path.join(dir, f), { force: true }); continue; }
    const answerId = f.slice(0, -5);
    const raw = await readJson(path.join(dir, f));
    const env = raw.ok ? AnswerEnvelope.safeParse(raw.value) : null;
    const claim = env?.success ? p.claims.get(claimKey(env.data.questionId, env.data.questionRevision)) : undefined;
    if (env?.success && claim?.answerId === answerId) {
      await fsp.mkdir(answersDir(p, "pending"), { recursive: true });
      await renameWithRetry(path.join(dir, f), path.join(answersDir(p, "pending"), f));
      p.answerStates.set(answerId, "pending");
      published++;
    } else {
      await fsp.rm(path.join(dir, f), { force: true });
      removed++;
    }
  }
  return { published, removed };
}

// ------------------------------------------------------------------ queue --
/**
 * One state transition for an answer. Callers hold the per-project mutex; the O_EXCL lock file guards
 * against other processes. Once the lock is held the source must still be in `from`, otherwise 409.
 */
async function transition(
  p: ProjectState, answerId: string, from: ProcessingState, to: ProcessingState,
  update: (e: AnswerEnvelope) => AnswerEnvelope,
): Promise<AnswerEnvelope> {
  const lock = lockFile(p, answerId);
  if (!(await createExclusive(lock, { at: new Date().toISOString(), pid: process.pid }))) {
    throw new ApiFailure(409, "busy", `answer ${answerId} is being changed by another consumer`);
  }
  try {
    const src = path.join(answersDir(p, from), `${answerId}.json`);
    const raw = await readJson(src, 1024 * 1024);
    if (!raw.ok) throw new ApiFailure(409, "wrong-state", `answer ${answerId} is not in ${from}`);
    const env = update(AnswerEnvelope.parse(raw.value));
    env.processingState = to;
    await atomicWriteJson(src, env);
    if (from !== to) {
      await fsp.mkdir(answersDir(p, to), { recursive: true });
      await renameWithRetry(src, path.join(answersDir(p, to), `${answerId}.json`));
    }
    p.answerStates.set(answerId, to);
    return env;
  } finally {
    await fsp.rm(lock, { force: true });
  }
}

/** Remove claim locks left by crashed consumers. */
export async function removeStaleLocks(p: ProjectState, now = Date.now()): Promise<number> {
  const dir = path.join(p.dir, ANSWERS_DIR, LOCKS);
  let files: string[] = [];
  try { files = await fsp.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st && now - st.mtimeMs > STALE_LOCK_MS) { await fsp.rm(path.join(dir, f), { force: true }); n++; }
  }
  return n;
}

async function recoverExpiredUnlocked(p: ProjectState, now: Date): Promise<string[]> {
  await removeStaleLocks(p, now.getTime());
  let files: string[] = [];
  try { files = (await fsp.readdir(answersDir(p, "processing"))).filter((f) => f.endsWith(".json")); } catch { return []; }
  const recovered: string[] = [];
  for (const f of files) {
    const raw = await readJson(path.join(answersDir(p, "processing"), f));
    if (!raw.ok) continue;
    const e = AnswerEnvelope.safeParse(raw.value);
    if (!e.success || !e.data.lease || Date.parse(e.data.lease.expiresAt) > now.getTime()) continue;
    try {
      await transition(p, e.data.answerId, "processing", "pending", (x) => {
        // Re-check under the lock: the consumer may have finished or renewed meanwhile.
        if (!x.lease || Date.parse(x.lease.expiresAt) > now.getTime()) throw new ApiFailure(409, "not-expired", "lease no longer expired");
        return { ...x, lease: undefined, audit: [...x.audit, { at: now.toISOString(), event: "lease-expired", by: x.lease.owner }] };
      });
      recovered.push(e.data.answerId);
    } catch (err) {
      if (!(err instanceof ApiFailure)) throw err;
    }
  }
  return recovered;
}

export type QueueState = "pending" | "processing" | "processed" | "failed";
export interface QueueItem { answerId: string; state: QueueState; questionId?: string; questionRevision?: number; submittedAt?: string }

/**
 * Compact listing of one queue folder (ids + question reference only), oldest first. Consumers use this instead of
 * scanning question files; answer ids sort by submission time.
 */
export async function listQueue(
  p: ProjectState, state: QueueState, limit: number, after?: string, match?: (questionId: string | undefined) => boolean,
): Promise<{ items: QueueItem[]; next?: string }> {
  let files: string[] = [];
  try { files = (await fsp.readdir(answersDir(p, state))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); } catch { return { items: [] }; }
  const byAnswer = new Map<string, { questionId: string; revision: number; submittedAt?: string }>();
  for (const c of p.claims.values()) byAnswer.set(c.answerId, { questionId: c.questionId, revision: c.revision, submittedAt: c.submittedAt });
  // An answer written moments ago may not be in the in-memory claim index yet; read just those envelopes.
  for (const f of files) {
    if (byAnswer.has(f)) continue;
    const env = await readAnswer(p, f);
    if (env) byAnswer.set(f, { questionId: env.questionId, revision: env.questionRevision, submittedAt: env.submittedAt });
  }
  if (match) files = files.filter((f) => match(byAnswer.get(f)?.questionId));
  const start = after ? files.findIndex((f) => f > after) : 0;
  const page = start < 0 ? [] : files.slice(start, start + limit);
  const items = page.map((answerId): QueueItem => {
    const c = byAnswer.get(answerId);
    return { answerId, state, ...(c ? { questionId: c.questionId, questionRevision: c.revision, submittedAt: c.submittedAt } : {}) };
  });
  const more = start >= 0 && start + limit < files.length;
  return more ? { items, next: page[page.length - 1] } : { items };
}

/** Claims the oldest pending answer, or exactly `answerId` when given (409 if that one is not pending). */
export async function claimNext(store: Store, p: ProjectState, owner: string, leaseSeconds = 600, answerId?: string): Promise<AnswerEnvelope | null> {
  return store.mutex.run(queueKey(p), async () => {
    await recoverExpiredUnlocked(p, new Date());
    let files: string[] = [];
    try { files = (await fsp.readdir(answersDir(p, "pending"))).filter((f) => f.endsWith(".json")).sort(); } catch { files = []; }
    if (answerId) {
      if (!files.includes(`${answerId}.json`)) throw new ApiFailure(409, "not-pending", `answer ${answerId} is not pending`);
      files = [`${answerId}.json`];
    }
    for (const f of files) {
      const answerId = f.slice(0, -5);
      const now = new Date();
      try {
        const env = await transition(p, answerId, "pending", "processing", (e) => ({
          ...e,
          attempts: e.attempts + 1,
          lease: { owner, claimedAt: now.toISOString(), expiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString() },
          audit: [...e.audit, { at: now.toISOString(), event: "claimed", by: owner }],
        }));
        store.invalidate({ projectId: p.manifest.id, scopes: ["answers", "records", "projects"], recordIds: [env.questionId] });
        return env;
      } catch (e) {
        if (e instanceof ApiFailure && !answerId) continue; // taken by another process
        if (e instanceof ApiFailure) throw new ApiFailure(409, "not-pending", `answer ${answerId} is not pending`);
        throw e;
      }
    }
    return null;
  });
}

function assertLease(e: AnswerEnvelope, owner: string) {
  if (!e.lease || e.lease.owner !== owner) throw new ApiFailure(409, "not-owner", `answer ${e.answerId} is not leased by ${owner}`);
}

export async function completeAnswer(store: Store, p: ProjectState, answerId: string, owner: string, note?: string): Promise<AnswerEnvelope> {
  const env = await store.mutex.run(queueKey(p), () => {
    const at = new Date().toISOString();
    return transition(p, answerId, "processing", "processed", (e) => {
      assertLease(e, owner);
      return { ...e, lease: undefined, result: { at, note }, audit: [...e.audit, { at, event: "processed", by: owner, note }] };
    });
  });
  store.invalidate({ projectId: p.manifest.id, scopes: ["answers", "records", "projects"], recordIds: [env.questionId] });
  return env;
}

export async function failAnswer(store: Store, p: ProjectState, answerId: string, owner: string, reason: string, retryable: boolean): Promise<AnswerEnvelope> {
  const env = await store.mutex.run(queueKey(p), () => {
    const at = new Date().toISOString();
    return transition(p, answerId, "processing", retryable ? "pending" : "failed", (e) => {
      assertLease(e, owner);
      return { ...e, lease: undefined, result: { at, reason, retryable }, audit: [...e.audit, { at, event: retryable ? "retry" : "failed", by: owner, note: reason }] };
    });
  });
  store.invalidate({ projectId: p.manifest.id, scopes: ["answers", "records", "projects"], recordIds: [env.questionId] });
  return env;
}

/** Return abandoned claims (lease expired) to pending. */
export async function recoverExpiredLeases(store: Store, p: ProjectState, now = new Date()): Promise<string[]> {
  const recovered = await store.mutex.run(queueKey(p), () => recoverExpiredUnlocked(p, now));
  if (recovered.length) store.invalidate({ projectId: p.manifest.id, scopes: ["answers", "records", "projects"] });
  return recovered;
}
