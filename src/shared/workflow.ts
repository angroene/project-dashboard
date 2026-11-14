import { DEFAULT_TONE, DEFAULT_WORKFLOWS, type ProjectManifest, type RecordType, type StatusCategory, type StatusTone, type Workflow } from "./schemas.js";

export interface StatusInfo {
  label: string;
  category: StatusCategory;
  tone: StatusTone;
  /** False when the status is not part of the record type's workflow. */
  known: boolean;
}

const QUESTION_INFO: Record<string, Omit<StatusInfo, "known">> = {
  open: { label: "Open", category: "open", tone: "neutral" },
  answered: { label: "Answered", category: "waiting", tone: "info" },
  processed: { label: "Processed", category: "done", tone: "ok" },
  closed: { label: "Closed", category: "closed", tone: "neutral" },
  withdrawn: { label: "Withdrawn", category: "closed", tone: "neutral" },
};

/** The project's workflow for a record type, or the built-in default. Questions have no configurable workflow. */
export function workflowFor(manifest: Pick<ProjectManifest, "workflows">, type: Exclude<RecordType, "question">): Workflow {
  return manifest.workflows[type] ?? DEFAULT_WORKFLOWS[type];
}

function humanize(slug: string): string {
  const s = slug.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Display label, category and tone of a status; unknown statuses are treated as open with a humanized label. */
export function statusInfo(manifest: Pick<ProjectManifest, "workflows">, type: RecordType, status: string): StatusInfo {
  if (type === "question") {
    const q = QUESTION_INFO[status];
    return q ? { ...q, known: true } : { label: humanize(status), category: "open", tone: "neutral", known: false };
  }
  const def = workflowFor(manifest, type).statuses.find((s) => s.id === status);
  if (!def) return { label: humanize(status), category: "open", tone: "neutral", known: false };
  return { label: def.label, category: def.category, tone: def.tone ?? DEFAULT_TONE[def.category], known: true };
}
