/**
 * Versioned JSON contracts for dashboard data files and API payloads.
 * These schemas are used by the backend (authoritative validation) and the
 * frontend (form hints only; the server always re-validates).
 */
import { z } from "zod";
import { defaultErrors } from "./validate.js";

export const SCHEMA_VERSION = 1 as const;

/** Stable machine id: letters, digits, dot, underscore, dash; no path characters. */
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const Id = z.string().regex(idPattern, "invalid id (allowed: A-Z a-z 0-9 . _ -, max 128, no leading symbol)");
/** Lower-case slug used for section ids and status values. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "invalid slug (lower-case letters, digits, dash)");
/** ISO 8601 date-time with an explicit offset; seconds optional (e.g. 2026-11-01T09:30+01:00). */
export const IsoTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/, "ISO date-time with offset expected")
  .refine((v) => !Number.isNaN(Date.parse(v)), "invalid date");
const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Relative path inside a project root; never absolute, never escaping. Enforced again on the server. */
export const RelPath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:/.test(p), "must be relative")
  .refine((p) => !p.split(/[\\/]/).some((s) => s === ".."), "must not contain ..");

// ---------------------------------------------------------------- icons ----
/** Allowlisted icon names; the UI maps each to a built-in glyph. Unknown names are rejected. */
export const ICONS = [
  "folder", "gamepad", "map", "book", "chart", "question", "bug", "review", "check",
  "flag", "clock", "file", "image", "code", "wrench", "star", "inbox", "list", "box", "bolt",
] as const;
export const Icon = z.enum(ICONS);

// --------------------------------------------------------------- project ---
export const ProjectManifest = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  displayName: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  enabled: z.boolean().default(true),
  order: z.number().int().default(100),
  rootSection: RelPath.default("sections"),
  progressFile: RelPath.default("progress.json"),
  allowedAttachmentRoot: RelPath.default("attachments"),
  /** Extra read-only artifact roots inside the project root (e.g. "docs/adr"). */
  artifactRoots: z.array(RelPath).max(16).default([]),
  /** Activity events folder, relative to the project root. */
  activityDir: RelPath.default("activity/events"),
  theme: z.object({ accent: z.enum(["indigo", "teal", "amber", "rose", "violet", "slate"]).default("indigo") }).default({ accent: "indigo" }),
  /** Days after which published progress is shown as stale; omitted = never stale. */
  progressStaleAfterDays: z.number().int().min(1).max(365).optional(),
  /** Per-record-type status vocabularies replacing the built-in defaults (questions excluded). */
  workflows: z.partialRecord(z.enum(["task", "issue", "review", "progress", "activity", "document", "generic"]), z.lazy(() => Workflow)).default({}),
  /**
   * Opt-in: lets authorised API clients (agents, CI) write records, activity events and progress through the server.
   * `sections` limits record writes to these expandable-card ids; omitted = every card of the project.
   */
  publishing: z.object({
    enabled: z.boolean().default(false),
    sections: z.array(Slug).max(200).optional(),
  }).default({ enabled: false }),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// --------------------------------------------------------------- section ---
export const DISPLAY_TYPES = ["main-tab", "page-tab", "expandable-card"] as const;
export const DisplayType = z.enum(DISPLAY_TYPES);
export type DisplayType = z.infer<typeof DisplayType>;

export const ACTIONS = [
  "copy", "download", "bulk-download", "export-xlsx", "import-xlsx", "respond", "upload", "mark-read", "open-detail",
  "comment",
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/** Built-in reusable panels a section can show in addition to its child cards. */
export const SectionView = z.enum(["records", "progress", "activity", "attention"]);

export const SectionManifest = z.object({
  schemaVersion: SchemaVersion,
  id: Slug,
  displayType: DisplayType,
  title: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  order: z.number().int().default(100),
  icon: Icon.optional(),
  visible: z.boolean().default(true),
  defaultOpen: z.boolean().default(false),
  /** expandable-card only: its newest record is also shown above the project's tabs, on every view. */
  pinned: z.boolean().default(false),
  /** Extra panels rendered by this section (page-tab / main-tab), before its children. */
  views: z.array(SectionView).max(4).default([]),
  actions: z.array(Action).default(["copy", "open-detail"]),
  filters: z
    .object({
      statuses: z.array(Slug).max(20).optional(),
      defaultStatus: Slug.optional(),
      sort: z.enum(["updated-desc", "updated-asc", "priority", "title", "order"]).default("updated-desc"),
    })
    .default({ sort: "updated-desc" }),
  pageSize: z.number().int().min(5).max(200).default(25),
  /** Tracked fields: independent, typed values on every record of this card, edited by the user and/or agents. */
  fields: z.lazy(() => z.array(TrackedFieldDef).max(20)).default([]).superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const f of list) {
      if (seen.has(f.id)) ctx.addIssue({ code: "custom", message: `duplicate field '${f.id}'` });
      seen.add(f.id);
    }
  }),
});
export type SectionManifest = z.infer<typeof SectionManifest>;

/**
 * Allowed parent → child display types. A container's children must all share one display type.
 * Root may hold main-tabs, page-tabs or cards; cards hold records only (no child sections).
 */
export const ALLOWED_CHILDREN: Record<"root" | DisplayType, readonly DisplayType[]> = {
  root: ["main-tab", "page-tab", "expandable-card"],
  "main-tab": ["page-tab", "expandable-card"],
  "page-tab": ["expandable-card"],
  "expandable-card": [],
};
export const MAX_SECTION_DEPTH = 3;

// --------------------------------------------------------- tracked fields --
export const TRACKED_FIELD_TYPES = ["checkbox", "yes-no", "choice", "text", "date"] as const;
export const FIELD_EDITORS = ["user", "agent"] as const;
/** One independently tracked value per record, e.g. "Reviewed" (checkbox) next to "Decision" (choice). */
export const TrackedFieldDef = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,39}$/, "field id: letter first, then letters, digits, _ or - (max 40)"),
  label: z.string().min(1).max(60),
  type: z.enum(TRACKED_FIELD_TYPES),
  help: z.string().max(300).optional(),
  /** For type "choice". */
  options: z.array(ChoiceOptionLazy()).min(1).max(30).optional(),
  /** Who may change it: the dashboard user, agents (publish scope), or both (default). */
  editableBy: z.array(z.enum(FIELD_EDITORS)).min(1).max(2).default(["user", "agent"]),
  /** Show a filter for this field in the card header (checkbox and choice fields). */
  filter: z.boolean().default(false),
}).superRefine((f, ctx) => {
  if (f.type === "choice" && !f.options) ctx.addIssue({ code: "custom", message: "a choice field needs options", path: ["options"] });
  if (f.type !== "choice" && f.options) ctx.addIssue({ code: "custom", message: "options are only for choice fields", path: ["options"] });
});
export type TrackedFieldDef = z.infer<typeof TrackedFieldDef>;
function ChoiceOptionLazy() {
  return z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), label: z.string().min(1).max(60) });
}
/** A tracked field's stored value: checkbox and yes-no → boolean, choice → option id, text → string, date → YYYY-MM-DD; null = cleared. */
export const TrackedFieldValue = z.union([z.boolean(), z.string().max(2000), z.null()]);
export type TrackedFieldValue = z.infer<typeof TrackedFieldValue>;

// -------------------------------------------------------------- progress ---
export const ProgressFile = z.object({
  schemaVersion: SchemaVersion,
  overallPercent: z.number().min(0).max(100).nullable().optional(),
  label: z.string().max(120).default("Overall progress"),
  method: z.string().max(500).default(""),
  updatedAt: IsoTime.optional(),
  breakdown: z
    .array(
      z.object({
        id: Id,
        title: z.string().min(1).max(120),
        percent: z.number().min(0).max(100).nullable().optional(),
        detail: z.string().max(500).default(""),
        weight: z.number().min(0).optional(),
        updatedAt: IsoTime.optional(),
      }),
    )
    .max(100)
    .default([]),
});
export type ProgressFile = z.infer<typeof ProgressFile>;

// ---------------------------------------------------------- answer schema --
export const ChoiceOption = z.object({ id: Id, label: z.string().min(1).max(200), description: z.string().max(500).optional() });

const ChoiceBase = {
  options: z.array(ChoiceOption).min(1).max(50),
  allowOther: z.boolean().default(false),
  allowExplanation: z.boolean().default(false),
  required: z.boolean().default(true),
};
// `default` on a field is shown pre-selected in the form. It is never submitted on the user's behalf: an answer exists
// only after the user submits it. Defaults are checked against the field (see defaultErrors in validate.ts).
export const SingleChoiceField = z.object({ type: z.literal("single-choice"), ...ChoiceBase, default: Id.optional() });
export const MultipleChoiceField = z.object({
  type: z.literal("multiple-choice"),
  ...ChoiceBase,
  minSelected: z.number().int().min(0).max(50).default(1),
  maxSelected: z.number().int().min(1).max(50).optional(),
  default: z.array(Id).max(50).optional(),
});
export const FreeTextField = z.object({
  type: z.literal("free-text"),
  required: z.boolean().default(true),
  minLength: z.number().int().min(0).max(20000).default(1),
  maxLength: z.number().int().min(1).max(20000).default(5000),
  multiline: z.boolean().default(true),
  placeholder: z.string().max(200).optional(),
  default: z.string().max(20000).optional(),
});
export const ApprovalField = z.object({
  type: z.literal("approval"),
  required: z.boolean().default(true),
  allowRationale: z.boolean().default(true),
  requireRationaleOnReject: z.boolean().default(false),
  /** Yes/no questions use this type; `default` pre-selects approve (yes) or reject (no). */
  default: z.enum(["approve", "reject"]).optional(),
});
export const FileUploadField = z.object({
  type: z.literal("file-upload"),
  required: z.boolean().default(true),
  minFiles: z.number().int().min(0).max(20).default(1),
  maxFiles: z.number().int().min(1).max(20).default(5),
  /** Must be a subset of the server's upload allowlist; the server enforces both. */
  allowedMimeTypes: z.array(z.string().max(100)).max(30).optional(),
  allowComment: z.boolean().default(true),
});
const PlainField = z.discriminatedUnion("type", [SingleChoiceField, MultipleChoiceField, FreeTextField, ApprovalField, FileUploadField]);
export const CompositeFieldDef = z.intersection(
  z.object({ id: Id, label: z.string().min(1).max(200), help: z.string().max(500).optional() }),
  PlainField,
);
export const CompositeField = z.object({ type: z.literal("composite"), fields: z.array(CompositeFieldDef).min(1).max(20) });
/** Answer schema types a question can use (keep in sync with AnswerSchema below). */
export const ANSWER_TYPES = ["single-choice", "multiple-choice", "free-text", "approval", "file-upload", "composite"] as const;
export const AnswerSchema = z.discriminatedUnion("type", [
  SingleChoiceField, MultipleChoiceField, FreeTextField, ApprovalField, FileUploadField, CompositeField,
]);
export type AnswerSchema = z.infer<typeof AnswerSchema>;
export type PlainFieldDef = z.infer<typeof PlainField>;
export type CompositeFieldDef = z.infer<typeof CompositeFieldDef>;
export { SINGLE_FIELD_ID, OTHER_OPTION_ID } from "./constants.js";

// ---------------------------------------------------------------- records --
export const RECORD_TYPES = ["question", "task", "issue", "review", "progress", "activity", "document", "generic"] as const;
export const RecordType = z.enum(RECORD_TYPES);
export type RecordType = z.infer<typeof RecordType>;

/**
 * Status workflows. Every non-question record type has a status vocabulary; each status belongs to one generic
 * category so counts (active, blocked) and colours work for any project-defined vocabulary.
 * Question statuses are fixed because the answer queue depends on them.
 */
export const STATUS_CATEGORIES = ["open", "active", "waiting", "blocked", "done", "closed"] as const;
export const StatusCategory = z.enum(STATUS_CATEGORIES);
export type StatusCategory = z.infer<typeof StatusCategory>;
export const StatusTone = z.enum(["neutral", "info", "ok", "warn", "danger"]);
export type StatusTone = z.infer<typeof StatusTone>;
export const StatusDef = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase slug"),
  label: z.string().min(1).max(60),
  category: StatusCategory,
  tone: StatusTone.optional(),
});
export type StatusDef = z.infer<typeof StatusDef>;
export const Workflow = z.object({
  statuses: z.array(StatusDef).min(1).max(64).superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const st of list) {
      if (seen.has(st.id)) ctx.addIssue({ code: "custom", message: `duplicate status '${st.id}'` });
      seen.add(st.id);
    }
  }),
  /** "strict": records with an unknown status are rejected; "warn" (default): shown, with a diagnostic. */
  unknownStatus: z.enum(["warn", "strict"]).default("warn"),
});
export type Workflow = z.infer<typeof Workflow>;

const st = (id: string, label: string, category: StatusCategory, tone?: StatusTone): StatusDef => ({ id, label, category, ...(tone ? { tone } : {}) });
export const QUESTION_STATUSES = ["open", "answered", "processed", "closed", "withdrawn"] as const;
/** Built-in defaults; a project replaces one by declaring `workflows.<recordType>` in project.json. */
export const DEFAULT_WORKFLOWS: Record<Exclude<RecordType, "question">, Workflow> = {
  task: { unknownStatus: "warn", statuses: [st("planned", "Planned", "open"), st("in-progress", "In progress", "active"), st("in-testing", "In testing", "active"), st("blocked", "Blocked", "blocked", "warn"), st("done", "Done", "done", "ok"), st("cancelled", "Cancelled", "closed")] },
  issue: { unknownStatus: "warn", statuses: [
    st("open", "Open", "open"), st("reopened", "Reopened", "open", "warn"), st("in-progress", "In progress", "active"),
    st("in-testing", "In testing", "active"), st("awaiting-verification", "Awaiting verification", "waiting", "info"),
    st("answered", "Answered", "waiting", "info"), st("blocked", "Blocked", "blocked", "warn"), st("fixed", "Fixed", "done", "ok"),
    st("verified", "Verified", "done", "ok"), st("wont-fix", "Won't fix", "closed"), st("duplicate", "Duplicate", "closed")] },
  review: { unknownStatus: "warn", statuses: [st("needs-review", "Needs review", "open", "warn"), st("in-review", "In review", "active"), st("changes-requested", "Changes requested", "blocked", "warn"), st("approved", "Approved", "done", "ok"), st("rejected", "Rejected", "closed", "danger"), st("done", "Done", "done", "ok")] },
  progress: { unknownStatus: "warn", statuses: [st("published", "Published", "done"), st("draft", "Draft", "open")] },
  activity: { unknownStatus: "warn", statuses: [st("info", "Info", "done"), st("success", "Success", "done", "ok"), st("warning", "Warning", "done", "warn"), st("failure", "Failure", "done", "danger")] },
  document: { unknownStatus: "warn", statuses: [st("draft", "Draft", "open"), st("proposed", "Proposed", "waiting"), st("accepted", "Accepted", "done", "ok"), st("published", "Published", "done", "ok"), st("superseded", "Superseded", "closed"), st("deprecated", "Deprecated", "closed")] },
  generic: { unknownStatus: "warn", statuses: [st("open", "Open", "open"), st("active", "Active", "active"), st("waiting", "Waiting", "waiting"), st("blocked", "Blocked", "blocked", "warn"), st("done", "Done", "done", "ok"), st("closed", "Closed", "closed")] },
};
export const DEFAULT_TONE: Record<StatusCategory, StatusTone> = { open: "neutral", active: "info", waiting: "info", blocked: "warn", done: "ok", closed: "neutral" };

export const PRIORITIES = ["critical", "high", "medium", "low", "none"] as const;

export const RecordAttachment = z.object({
  id: Id,
  title: z.string().max(200).optional(),
  /** Path relative to the project's attachment root or one of its artifact roots. */
  path: RelPath,
  /** Which root `path` is relative to: "attachments" (default) or an artifactRoots entry. */
  root: z.string().max(512).default("attachments"),
  mimeType: z.string().max(100).optional(),
  /** "user" when the dashboard user attached it; such attachments survive an agent's full rewrite of the record. */
  by: z.string().max(80).optional(),
});
export type RecordAttachment = z.infer<typeof RecordAttachment>;

export const RecordLink = z.object({
  title: z.string().min(1).max(200),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "only http(s) links"),
});

/**
 * A reference to a work item elsewhere (a change request, a ticket, a build). Display only: the dashboard never acts
 * on it. `status` is what the source system reported, as of `statusAt`, and is shown as such.
 */
export const ExternalRef = z.object({
  system: z.string().min(1).max(40),
  id: z.string().min(1).max(120),
  title: z.string().max(300).optional(),
  url: z.string().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "only http(s) links").optional(),
  /** Branch, revision or change reference. */
  ref: z.string().max(200).optional(),
  status: z.string().max(60).optional(),
  statusAt: IsoTime.optional(),
}).strict();
export type ExternalRef = z.infer<typeof ExternalRef>;

const RecordBase = {
  schemaVersion: SchemaVersion,
  id: Id,
  title: z.string().min(1).max(300),
  summary: z.string().max(1000).default(""),
  status: Slug,
  statusLabel: z.string().max(60).optional(),
  priority: z.enum(PRIORITIES).default("none"),
  order: z.number().int().optional(),
  createdAt: IsoTime.optional(),
  updatedAt: IsoTime,
  bodyMarkdown: z.string().max(200_000).default(""),
  attachments: z.array(RecordAttachment).max(50).default([]),
  links: z.array(RecordLink).max(50).default([]),
  linkedRecords: z.array(Id).max(50).default([]),
  metadata: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean()])).default({}),
  history: z.array(z.object({ at: IsoTime, text: z.string().max(2000), by: z.string().max(80).optional() })).max(500).default([]),
  actions: z.array(Action).optional(),
  /** When true this record counts as an unread update until the user marks it read (per updatedAt). */
  notifyUser: z.boolean().default(false),
  /**
   * When true the record asks the user to do something and is listed under Actions. Outstanding while a question still
   * needs a response, or while another record's status is not in a done/closed category. Independent of read state.
   */
  requiresAction: z.boolean().default(false),
  percent: z.number().min(0).max(100).nullable().optional(),
  /** Values of the card's tracked fields (see SectionManifest.fields). */
  fields: z.record(z.string().max(40), TrackedFieldValue).default({}),
  /** References to work items in other systems. Their status is what that system reported, kept apart from fields. */
  external: z.array(z.lazy(() => ExternalRef)).max(20).default([]),
  /** Set on records generated from a recurring template. */
  occurrence: z.object({ templateId: Id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).optional(),
};

export const QuestionRecord = z.object({
  ...RecordBase,
  recordType: z.literal("question"),
  status: z.enum(QUESTION_STATUSES),
  taskId: Id.optional(),
  requiresResponse: z.boolean().default(true),
  questionRevision: z.number().int().min(1).default(1),
  dueAt: IsoTime.optional(),
  answerSchema: AnswerSchema.optional(),
});
export type QuestionRecord = z.infer<typeof QuestionRecord>;

const typed = (t: Exclude<RecordType, "question">) => z.object({ ...RecordBase, recordType: z.literal(t) });
export const AnyRecord = z.discriminatedUnion("recordType", [
  QuestionRecord,
  typed("task").extend({ assignee: z.string().max(80).optional() }),
  typed("issue").extend({
    severity: z.string().max(30).optional(),
    area: z.string().max(80).optional(),
  }),
  typed("review"),
  typed("progress"),
  typed("activity"),
  typed("document"),
  typed("generic"),
]).superRefine((r, ctx) => {
  if (r.recordType === "question" && r.requiresResponse && !r.answerSchema) {
    ctx.addIssue({ code: "custom", message: "requiresResponse=true needs answerSchema", path: ["answerSchema"] });
  }
  if (r.recordType === "question" && r.answerSchema) {
    for (const e of defaultErrors(r.answerSchema)) {
      ctx.addIssue({ code: "custom", message: `default for field '${e.fieldId}': ${e.message}`, path: ["answerSchema"] });
    }
  }
});
export type AnyRecord = z.infer<typeof AnyRecord>;

// ------------------------------------------------------ recurring records --
export const TEMPLATE_STATES = ["active", "paused", "disabled"] as const;
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date as YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "not a calendar date");
export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/**
 * A template the server turns into one record per day (`<template id>-<YYYY-MM-DD>`), in the card whose `templates/`
 * folder holds it. Occurrences are ordinary records; a template never answers its questions.
 */
export const RecurringTemplate = z.object({
  schemaVersion: SchemaVersion,
  /** At most 117 characters so that "<id>-YYYY-MM-DD" is a valid record id. */
  id: Id.refine((v) => v.length <= 117, "template id: at most 117 characters"),
  title: z.string().min(1).max(200),
  state: z.enum(TEMPLATE_STATES).default("active"),
  schedule: z.object({
    frequency: z.literal("daily"),
    /** Local wall-clock time in `timezone` from which the day's occurrence is created. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time as HH:MM").default("00:00"),
    timezone: z.string().max(64).refine(isTimeZone, "unknown time zone"),
    startDate: LocalDate,
    endDate: LocalDate.optional(),
    /** After downtime, also create up to this many missed earlier days (0 = only today; see ADR 0017). */
    catchUpDays: z.number().int().min(0).max(31).default(0),
  }).refine((s) => !s.endDate || s.endDate >= s.startDate, { message: "endDate before startDate", path: ["endDate"] }),
  /** The record each occurrence starts from, without id. "{date}" in title, summary and bodyMarkdown is replaced. */
  record: z.record(z.string(), z.unknown())
    .refine((r) => !("id" in r) && !("occurrence" in r), "the template's record must not set id or occurrence (the server sets them)")
    // An attachment id belongs to one record, so every day after the first would fail; link to shared files instead.
    .refine((r) => !Array.isArray(r.attachments) || r.attachments.length === 0, "the template's record must not have attachments (an attachment belongs to one record); use links"),
});
export type RecurringTemplate = z.infer<typeof RecurringTemplate>;
export type TemplateState = (typeof TEMPLATE_STATES)[number];

// --------------------------------------------------------------- activity --
export const ActivityEvent = z.object({
  schemaVersion: SchemaVersion,
  id: Id,
  at: IsoTime,
  area: z.string().max(80).default(""),
  action: z.string().min(1).max(80),
  source: z.string().max(80).optional(),
  summary: z.string().min(1).max(1000),
  status: z.enum(["info", "success", "warning", "failure"]).default("info"),
  recordId: Id.optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

// ---------------------------------------------------------------- answers --
export const AnswerValue = z.discriminatedUnion("kind", [
  z.object({ fieldId: Id, kind: z.literal("choice"), optionIds: z.array(z.union([Id, z.literal("__other")])).max(50), otherText: z.string().max(5000).optional(), explanation: z.string().max(5000).optional() }),
  z.object({ fieldId: Id, kind: z.literal("text"), text: z.string().max(20000) }),
  z.object({ fieldId: Id, kind: z.literal("approval"), decision: z.enum(["approve", "reject"]), rationale: z.string().max(5000).optional() }),
  z.object({ fieldId: Id, kind: z.literal("files"), attachmentIds: z.array(Id).max(20), comment: z.string().max(5000).optional() }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const SubmitAnswerRequest = z.object({
  questionRevision: z.number().int().min(1),
  answers: z.array(AnswerValue).max(20),
  /** Client-generated key; repeating a request with the same key returns the original result. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
});
export type SubmitAnswerRequest = z.infer<typeof SubmitAnswerRequest>;

export const PROCESSING_STATES = ["pending", "processing", "processed", "failed"] as const;
export const ProcessingState = z.enum(PROCESSING_STATES);
export type ProcessingState = z.infer<typeof ProcessingState>;

export const AnswerEnvelope = z.object({
  schemaVersion: SchemaVersion,
  answerId: Id,
  projectId: Id,
  questionId: Id,
  taskId: Id.optional(),
  questionRevision: z.number().int().min(1),
  submittedAt: IsoTime,
  source: z.enum(["dashboard", "excel-import"]),
  submittedBy: z.string().max(80),
  idempotencyKey: z.string().max(120),
  answers: z.array(AnswerValue),
  attachments: z.array(Id),
  processingState: ProcessingState,
  lease: z.object({ owner: z.string().max(120), claimedAt: IsoTime, expiresAt: IsoTime }).optional(),
  attempts: z.number().int().min(0).default(0),
  result: z.object({ at: IsoTime, note: z.string().max(5000).optional(), reason: z.string().max(5000).optional(), retryable: z.boolean().optional() }).optional(),
  audit: z.array(z.object({ at: IsoTime, event: z.string().max(60), by: z.string().max(120).optional(), note: z.string().max(2000).optional() })).default([]),
});
export type AnswerEnvelope = z.infer<typeof AnswerEnvelope>;

/** Metadata stored next to each uploaded file (never the bytes in JSON). */
export const UploadMeta = z.object({
  schemaVersion: SchemaVersion,
  attachmentId: Id,
  /** Always `<attachmentId><.ext>`; never a path. */
  storedName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[a-z0-9]{1,10}$/),
  originalName: z.string().max(255),
  mimeType: z.string().max(100),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: IsoTime,
  uploadedBy: z.string().max(80),
  questionId: Id.optional(),
  /** Set once an answer references the upload. */
  answerId: Id.optional(),
});
export type UploadMeta = z.infer<typeof UploadMeta>;

// ------------------------------------------------------------- read state --
export const ReadState = z.object({
  schemaVersion: SchemaVersion,
  user: z.string().max(80),
  /** key = "record:<id>" or "activity:<id>", value = updatedAt/at that the user has seen. */
  seen: z.record(z.string().max(200), IsoTime).default({}),
});
export type ReadState = z.infer<typeof ReadState>;
