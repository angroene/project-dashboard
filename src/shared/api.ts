/**
 * HTTP API response shapes. All endpoints live under /api and return JSON unless noted.
 * State-changing requests (POST) must send header `X-PCC-Request: 1` (CSRF guard).
 * Errors: HTTP 4xx/5xx with body ApiError.
 */
import type {
  Action, ActivityEvent, AnswerSchema, AnswerValue, DisplayType, ProcessingState, ProgressFile, RecordType, StatusCategory, StatusTone, ExternalRef, TrackedFieldDef, TrackedFieldValue, TemplateState,
} from "./schemas.js";

export interface ApiError {
  error: string;
  message: string;
  /** Per-field validation errors when error === "validation". */
  fieldErrors?: { fieldId: string; message: string }[];
  details?: unknown;
}

export interface SessionInfo {
  /** The server's login mode; "disabled" means anyone who reaches the server has full access. */
  authMode: "required" | "local-network" | "disabled";
  /** Whether this client must sign in (false when its address or the mode lets it in without login). */
  authRequired: boolean;
  authenticated: boolean;
  user: string;
  productName: string;
  uploadLimits: { maxBytes: number; maxFiles: number; allowedMimeTypes: string[] };
}

export interface ProgressSummary {
  /** null = Not reported. */
  overallPercent: number | null;
  label: string;
  method: string;
  updatedAt?: string;
  stale: boolean;
}

/** GET /api/projects → { projects: ProjectCard[], diagnosticsCount } */
export interface ProjectCard {
  id: string;
  displayName: string;
  description: string;
  order: number;
  accent: string;
  available: boolean;
  /** Why the project is unavailable (invalid manifest etc.). */
  unavailableReason?: string;
  progress: ProgressSummary;
  /** Questions with requiresResponse, status open, and no answer for the current revision. */
  awaitingResponse: number;
  /** Records with requiresAction that are still to do (questions among them are also in awaitingResponse). */
  outstandingActions: number;
  /** Items that need the user to act: questions awaiting a response plus other outstanding actions. Unread is not included. */
  requireAttention: number;
  /** Answers submitted but not yet processed by the project (pending + processing). */
  awaitingPickup: number;
  unreadUpdates: number;
  blocked: number;
  active: number;
}

export interface ProjectsResponse {
  productName: string;
  projects: ProjectCard[];
  diagnosticsCount: number;
}

/** GET /api/projects/:projectId */
export type ProjectDetail = ProjectCard;

export interface NavNode {
  id: string;
  displayType: DisplayType;
  title: string;
  description: string;
  icon?: string;
  order: number;
  defaultOpen: boolean;
  views: ("records" | "progress" | "activity" | "attention")[];
  actions: Action[];
  filters: { statuses?: string[]; defaultStatus?: string; sort: string };
  pageSize: number;
  /** Counts for badges. */
  counts: { records: number; awaitingResponse: number; unread: number };
  children: NavNode[];
}

/** GET /api/projects/:projectId/navigation */
export interface NavigationResponse {
  projectId: string;
  /** Display type shared by the root's children ("main-tab", "page-tab" or "expandable-card"), or null if empty. */
  rootChildType: DisplayType | null;
  nodes: NavNode[];
}

/** Effective question state as shown to the user, derived from the record and the answer queue. */
export type QuestionUiState =
  | "needs-response"     // open, requiresResponse, no answer for current revision
  | "submitted"          // answer pending pickup
  | "processing"         // answer claimed by a consumer
  | "answered"           // record says answered outside the dashboard (no queued answer)
  | "processed"          // answer processed (or record status processed)
  | "failed"             // answer processing failed
  | "informational"      // requiresResponse=false
  | "closed";            // closed/withdrawn

export interface RecordSummary {
  id: string;
  recordType: RecordType;
  sectionId: string;
  title: string;
  summary: string;
  status: string;
  /** Record's own statusLabel, else the workflow label. */
  statusLabel?: string;
  /** Generic category from the project's workflow (unknown statuses: "open"). */
  statusCategory: StatusCategory;
  statusTone: StatusTone;
  priority: string;
  updatedAt: string;
  order?: number;
  percent?: number | null;
  attachmentCount: number;
  unread: boolean;
  /** Set when the record asks the user to do something; actionOutstanding = still to do. */
  requiresAction?: true;
  actionOutstanding?: boolean;
  actions: Action[];
  /** Tracked field values (only when the record has any). */
  fields?: Record<string, TrackedFieldValue>;
  /** References to work items in other systems; their status is as reported by that system. */
  external?: ExternalRef[];
  /** Set on records generated from a recurring template. */
  occurrence?: { templateId: string; date: string };
  /** Questions only. */
  question?: {
    uiState: QuestionUiState;
    revision: number;
    requiresResponse: boolean;
    answerType?: AnswerSchema["type"];
    answerId?: string;
    answeredAt?: string;
    dueAt?: string;
  };
}

/**
 * GET /api/projects/:projectId/sections/:sectionId/records?cursor=&status=&q=&sort=&limit=
 * Without `status` the section's filters.defaultStatus applies; send `status=all` for everything.
 * `status` also matches question UI states, so `status=needs-response` lists only questions still awaiting an answer.
 * `cursor` is an opaque keyset token (stable under inserts/deletes).
 */
export interface RecordPage {
  sectionId: string;
  total: number;
  /** Total before status/text filtering. */
  unfilteredTotal: number;
  statusCounts: Record<string, number>;
  /** Display label for every status in statusCounts (workflow label or humanized id). */
  statusLabels: Record<string, string>;
  /** Questions in the section still needing a response; present only when the section has answerable questions. */
  needsResponseCount?: number;
  /** The card's tracked field definitions (empty when it has none). */
  fieldDefs: TrackedFieldDef[];
  /** Counts per value of each filterable field, over the unfiltered records ("" = not set). */
  fieldCounts: Record<string, Record<string, number>>;
  /** Recurring templates of this card. */
  templates: TemplateSummary[];
  /** The dashboard user may comment on and attach files to records of this card. */
  canComment: boolean;
  items: RecordSummary[];
  nextCursor: string | null;
}

export interface TemplateSummary {
  id: string;
  sectionId: string;
  title: string;
  state: TemplateState;
  schedule: { frequency: "daily"; time: string; timezone: string; startDate: string; endDate?: string; catchUpDays: number };
  /** Last occurrence date created by the scheduler. */
  lastDate?: string;
  /** Problem with the template file, if any (it then creates nothing). */
  error?: string;
}

/**
 * GET /api/projects/:projectId/templates/:templateId/current: the occurrence that is current now and its tracked field
 * values. `date` is today (template time zone) once the template's time has passed, otherwise yesterday; null before
 * startDate. Until that day's record exists, `fields` are the template's starting values, so a default is in effect
 * from the reset time on without anyone (or the scheduler) acting. `labels` holds the same values as display text.
 */
export interface TemplateCurrent {
  templateId: string;
  sectionId: string;
  state: TemplateState;
  date: string | null;
  recordId: string | null;
  recordExists: boolean;
  fields: Record<string, TrackedFieldValue>;
  labels: Record<string, string>;
}

/** POST /api/projects/:projectId/records/:recordId/user-update (dashboard user) */
export interface UserRecordUpdate {
  fields?: Record<string, TrackedFieldValue>;
  comment?: string;
  /** Uploaded files (POST /uploads) to attach to the record. */
  attach?: { uploadId: string; title?: string }[];
  /** Revision from the record detail; a newer record makes the update fail with 409 revision-mismatch. */
  ifRevision?: string;
}

export interface AttachmentRef {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  bytes: number | null;
  available: boolean;
  /** GET this URL to download (same-origin). */
  url: string;
}

/** GET /api/projects/:projectId/records/:recordId */
export interface RecordDetail extends RecordSummary {
  /** Content revision of the record file, for ifRevision on updates. */
  revision: string;
  /** The card's tracked field definitions, and whether the user may comment and attach files. */
  fieldDefs: TrackedFieldDef[];
  canComment: boolean;
  createdAt?: string;
  bodyMarkdown: string;
  attachments: AttachmentRef[];
  links: { title: string; url: string }[];
  linkedRecords: { id: string; title: string; sectionId: string; recordType: RecordType }[];
  metadata: Record<string, string | number | boolean>;
  history: { at: string; text: string; by?: string }[];
  /** Questions only. */
  answerSchema?: AnswerSchema;
  taskId?: string;
  submittedAnswer?: {
    answerId: string;
    submittedAt: string;
    source: "dashboard" | "excel-import";
    processingState: ProcessingState;
    answers: AnswerValue[];
    attachments: AttachmentRef[];
    resultNote?: string;
  };
}

/** GET /api/projects/:projectId/progress */
export interface ProgressResponse extends ProgressSummary {
  breakdown: NonNullable<ProgressFile["breakdown"]>;
}

/** GET /api/projects/:projectId/activity?cursor=&limit= */
export interface ActivityPage {
  items: (ActivityEvent & { unread: boolean })[];
  nextCursor: string | null;
  unreadCount: number;
}

/** GET /api/projects/:projectId/attention → questions awaiting the user across all sections. */
export interface AttentionResponse {
  /** Questions awaiting a response (first 50), kept for existing clients. */
  questions: RecordSummary[];
  /** Unread records that are not awaiting a response (first 50), kept for existing clients. */
  unreadRecords: RecordSummary[];
  /** Items pending per attention group (each record counted in at most one group). */
  counts: Record<AttentionGroup, number>;
  /** Items per group including answered, completed and read history ("Show all"). */
  totals: Record<AttentionGroup, number>;
  /** Unread activity events (shown in the activity panel). */
  unreadActivity: number;
}

export const ATTENTION_GROUPS = ["questions", "actions", "responses", "updates"] as const;
/** Questions = awaiting an answer; actions = records with requiresAction; responses = unread questions; updates = other unread records. */
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

/**
 * GET /api/projects/:projectId/attention/:group?all=1&cursor=&limit=
 * Without `all`: only pending items (unanswered, outstanding or unread). With `all=1`: the group's whole history.
 */
export interface AttentionPage {
  group: AttentionGroup;
  all: boolean;
  total: number;
  items: RecordSummary[];
  nextCursor: string | null;
}

/** POST /api/projects/:projectId/questions/:id/answers  (body SubmitAnswerRequest) */
export interface SubmitAnswerResponse {
  answerId: string;
  processingState: ProcessingState;
  /** true when the same idempotency key was replayed. */
  replayed: boolean;
}

/** POST /api/projects/:projectId/uploads (multipart: file(s), optional field questionId) */
export interface UploadResponse {
  attachments: { attachmentId: string; originalName: string; mimeType: string; bytes: number }[];
}

/** POST /api/projects/:projectId/records/mark-read  body { recordIds?: string[], activityIds?: string[], allActivity?: boolean } */
export interface MarkReadResponse {
  marked: number;
  unreadUpdates: number;
}

/** POST /api/projects/:projectId/export/xlsx  body { questionIds: string[] } → .xlsx file download */

export type ImportRowStatus = "ready" | "blank" | "invalid" | "stale" | "already-answered" | "needs-dashboard";

/** POST /api/projects/:projectId/import/xlsx/preview (multipart: file) */
export interface ImportPreview {
  previewId: string;
  projectId: string;
  fileName: string;
  totals: Record<ImportRowStatus, number>;
  rows: {
    questionId: string;
    title: string;
    status: ImportRowStatus;
    messages: string[];
    answers?: AnswerValue[];
  }[];
  /** Workbook-level problems (wrong project, unknown schema version...). */
  errors: string[];
  expiresAt: string;
}

/** POST /api/projects/:projectId/import/xlsx/commit  body { previewId, questionIds } */
export interface ImportCommitResponse {
  results: { questionId: string; ok: boolean; answerId?: string; message?: string }[];
}

/** POST /api/projects/:projectId/download/zip/preflight body { recordIds?, attachmentIds? } */
export interface ZipPreflight {
  available: AttachmentRef[];
  missing: { attachmentId: string; recordId?: string; reason: string }[];
  totalBytes: number;
}
/** POST /api/projects/:projectId/download/zip body { recordIds?, attachmentIds? } → application/zip */

export interface Diagnostic {
  level: "error" | "warning";
  projectId?: string;
  path?: string;
  message: string;
}
/** GET /api/diagnostics */
export interface DiagnosticsResponse {
  indexedAt: string;
  projects: { id: string; records: number; sections: number; indexMs: number }[];
  diagnostics: Diagnostic[];
}

/** GET /api/updates — Server-Sent Events. Event "invalidate" data: InvalidateEvent. Event "ping" every 25 s. */
export interface InvalidateEvent {
  projectId: string | null;
  scopes: ("projects" | "navigation" | "records" | "progress" | "activity" | "answers")[];
  /** Ids of records that changed when known. */
  recordIds?: string[];
}
