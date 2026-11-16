/**
 * Recurring records: turns each active template into one ordinary record per local calendar day.
 *
 * - Occurrence id: `<template id>-<YYYY-MM-DD>` (the template's local date). The record file is created only if it does
 *   not exist (atomic, exclusive), so restarts, repeated ticks and several server processes never create duplicates.
 * - A day is due once the template's local wall-clock time reaches `schedule.time` in `schedule.timezone`. On a
 *   daylight-saving change the day is still created exactly once: a skipped time (spring forward) is reached when the
 *   clock jumps past it, a repeated time (fall back) is reached the first time.
 * - Missed days after downtime are created only within `catchUpDays` before today; older ones are skipped. A day whose
 *   time passed between two checks of a running server (for example 23:59, checked at 23:58 and 00:00) is still
 *   created. Resuming a paused or disabled template starts from today: the paused days are not filled in.
 *   A cursor per template (last handled date) keeps deleted occurrences from coming back.
 * - Occurrences are never changed or removed by the scheduler, and nothing is answered on the user's behalf.
 */
import path from "node:path";
import { SCHEMA_VERSION, type RecurringTemplate } from "../shared/schemas.js";
import { ApiFailure } from "./answers.js";
import { atomicWriteJson, createExclusiveAtomic } from "./fsutil.js";
import { caseVariantOf, rel, serialize, validateRecord } from "./publish.js";
import { recurrenceCursorFile, type ProjectState, type Store, type TemplateEntry } from "./store.js";

/** Local calendar date (YYYY-MM-DD) and time (HH:MM) of `at` in `timeZone`. */
export function localDateTime(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The dates that should exist now and have not been handled yet (`after` = cursor), oldest first. `lastCheck` is the
 * previous check of this running server: if it was yesterday (local), yesterday is due even with `catchUpDays: 0`,
 * because its time passed while the server was running, between two checks.
 */
export function dueDates(t: RecurringTemplate, now: Date, after: string | undefined, lastCheck?: Date): string[] {
  const s = t.schedule;
  const local = localDateTime(now, s.timezone);
  let last = local.time >= s.time ? local.date : addDays(local.date, -1);
  if (s.endDate && s.endDate < last) last = s.endDate;
  let first = addDays(local.date, -s.catchUpDays);
  const yesterday = addDays(local.date, -1);
  if (lastCheck && lastCheck < now && localDateTime(lastCheck, s.timezone).date === yesterday && yesterday < first) first = yesterday;
  if (s.startDate > first) first = s.startDate;
  if (after && addDays(after, 1) > first) first = addDays(after, 1);
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The local date whose occurrence is current at `now`: today once `schedule.time` has passed, else yesterday; limited
 * to startDate..endDate (null before the start and after the end). Uses the same rule as dueDates, so the value an agent reads switches
 * to the new day at exactly the time the scheduler creates it, even before the scheduler has run.
 */
export function currentDate(t: RecurringTemplate, now: Date): string | null {
  const s = t.schedule;
  const local = localDateTime(now, s.timezone);
  const d = local.time >= s.time ? local.date : addDays(local.date, -1);
  return d < s.startDate || (s.endDate && d > s.endDate) ? null : d;
}

export const occurrenceId = (templateId: string, date: string) => `${templateId}-${date}`;

function fill(v: unknown, date: string): unknown {
  return typeof v === "string" ? v.replaceAll("{date}", date) : v;
}

/** The raw record for one occurrence; validated by the caller like any published record. */
export function occurrenceRecord(t: RecurringTemplate, date: string, now: Date): Record<string, unknown> {
  const r = t.record;
  return {
    schemaVersion: SCHEMA_VERSION,
    ...r,
    id: occurrenceId(t.id, date),
    title: fill(r.title ?? `${t.title} {date}`, date),
    ...(r.summary !== undefined ? { summary: fill(r.summary, date) } : {}),
    ...(r.bodyMarkdown !== undefined ? { bodyMarkdown: fill(r.bodyMarkdown, date) } : {}),
    occurrence: { templateId: t.id, date },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** When each project's templates were last checked by this server (per store); not persisted: a restart is downtime. */
const lastChecks = new WeakMap<Store, Map<string, Date>>();

export interface RecurrenceResult {
  created: string[];
  errors: { templateId: string; message: string }[];
}

/**
 * Create every due occurrence of the project's active templates. Runs under the project's publish lock, so it never
 * interleaves with agent or user writes in this process; the exclusive file creation covers other processes.
 */
export async function runRecurrence(store: Store, projectId: string, now: Date = new Date()): Promise<RecurrenceResult> {
  const result: RecurrenceResult = { created: [], errors: [] };
  const initial = store.get(projectId);
  if (!initial || !initial.manifest.enabled) return result;
  return store.mutex.run(`publish:${projectId}`, async () => {
    const p = store.get(projectId) ?? initial;
    const checks = lastChecks.get(store) ?? new Map<string, Date>();
    lastChecks.set(store, checks);
    const lastCheck = checks.get(projectId);
    checks.set(projectId, now);
    const files: string[] = [];
    let cursorChanged = false;
    for (const entry of [...p.templates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const t = entry.template;
      if (!t || t.state !== "active") continue;
      entry.runError = undefined;
      for (const date of dueDates(t, now, p.recurrenceCursor[t.id], lastCheck)) {
        const res = await createOccurrence(p, entry, t, date, now);
        if (res.error) { result.errors.push({ templateId: t.id, message: res.error }); break; }
        if (res.file) { files.push(res.file); result.created.push(occurrenceId(t.id, date)); }
        p.recurrenceCursor[t.id] = date;
        cursorChanged = true;
      }
    }
    if (cursorChanged) await atomicWriteJson(recurrenceCursorFile(p.dir), p.recurrenceCursor);
    if (files.length) await store.applyChanges(p.dir, files.map((f) => rel(p, f)));
    for (const e of result.errors) {
      const entry = p.templates.get(e.templateId);
      if (entry) entry.runError = e.message;
    }
    return result;
  });
}

async function createOccurrence(
  p: ProjectState, entry: TemplateEntry, t: RecurringTemplate, date: string, now: Date,
): Promise<{ file?: string; error?: string }> {
  const section = p.sections.get(entry.sectionId);
  if (!section) return { error: `section ${entry.sectionId} no longer exists` };
  const id = occurrenceId(t.id, date);
  const file = path.join(section.dir, "records", `${id}.json`);
  const existing = p.records.get(id);
  if (existing) {
    if (existing.file === file) return {}; // already created (by this or another process)
    return { error: `record id ${id} is already used in section ${existing.sectionId}` };
  }
  const variant = caseVariantOf(p, id);
  if (variant) return { error: `record ${variant} differs from ${id} only in letter case; rename the template or that record` };
  let raw: Record<string, unknown>;
  try {
    raw = occurrenceRecord(t, date, now);
    validateRecord(p, raw, section);
  } catch (e) {
    return { error: e instanceof ApiFailure ? e.message : `invalid occurrence: ${(e as Error).message}` };
  }
  const made = await createExclusiveAtomic(file, serialize(raw));
  return made ? { file } : {};
}

/**
 * Resuming starts from today: moves the template's cursor to yesterday (if it is behind), so the days it was paused or
 * disabled are not created afterwards. Caller holds the project's publish lock.
 */
export async function skipPausedDays(p: ProjectState, t: RecurringTemplate, now: Date = new Date()): Promise<void> {
  const yesterday = addDays(localDateTime(now, t.schedule.timezone).date, -1);
  const cur = p.recurrenceCursor[t.id];
  if (cur && cur >= yesterday) return;
  p.recurrenceCursor[t.id] = yesterday;
  await atomicWriteJson(recurrenceCursorFile(p.dir), p.recurrenceCursor);
}

/** Run every project's templates now and then every `intervalMs`. Returns a stop function. */
export function startRecurrence(store: Store, intervalMs: number, log: (msg: string, err?: unknown) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const id of [...store.projects.keys()]) {
        try {
          const r = await runRecurrence(store, id);
          for (const e of r.errors) log(`recurring template ${id}/${e.templateId}: ${e.message}`);
        } catch (e) {
          log(`recurring templates of ${id} failed`, e);
        }
      }
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
