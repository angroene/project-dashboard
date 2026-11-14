import type { QuestionUiState, RecordSummary } from "../shared/api";
import type { ProcessingState } from "../shared/schemas";

function toDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function formatRelative(iso: string | undefined | null): string {
  const d = toDate(iso);
  if (!d) return "unknown time";
  const diff = (d.getTime() - Date.now()) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "just now";
}

export function formatAbsolute(iso: string | undefined | null): string {
  const d = toDate(iso);
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown time";
}

export function formatTime(iso: string): string {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
}

export function dayKey(iso: string): string {
  const d = toDate(iso);
  return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "unknown";
}

export function formatDay(iso: string): string {
  const d = toDate(iso);
  if (!d) return "Unknown date";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "size unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatPercent(v: number): string {
  return `${Math.round(v)}%`;
}

export type Tone = "neutral" | "warn" | "ok" | "danger" | "info";

export const UI_STATE: Record<QuestionUiState, { label: string; tone: Tone }> = {
  "needs-response": { label: "Needs response", tone: "warn" },
  submitted: { label: "Submitted · Awaiting pickup", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  processed: { label: "Processed", tone: "ok" },
  answered: { label: "Answered", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  informational: { label: "Info", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
};

export function uiStateInfo(s: QuestionUiState): { label: string; tone: Tone } {
  return UI_STATE[s] ?? { label: s, tone: "neutral" };
}

export const PROCESSING: Record<ProcessingState, { label: string; tone: Tone }> = {
  pending: { label: "Submitted · Awaiting pickup", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  processed: { label: "Processed", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
};

export function humanize(slug: string): string {
  const s = slug.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Concise plain-text form of a record for the clipboard: id, title, status, summary — never the full body. */
export function recordPlainText(r: Pick<RecordSummary, "id" | "title" | "status" | "statusLabel" | "priority" | "summary">): string {
  const status = r.statusLabel || humanize(r.status);
  const prio = r.priority && r.priority !== "none" ? ` · Priority: ${humanize(r.priority)}` : "";
  const lines = [`${r.id} · ${r.title}`, `Status: ${status}${prio}`];
  if (r.summary) lines.push(r.summary);
  return lines.join("\n");
}
