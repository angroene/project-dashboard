import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TemplateSummary } from "../../shared/api";
import type { TrackedFieldDef } from "../../shared/schemas";
import { apiPost, enc, errorMessage, projectApi } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject } from "../context";
import { useToast } from "./Toasts";

/** Filter a card by one tracked field ("*" = any value, "" = not set). */
export function FieldFilter({ def, counts, value, onChange }: { def: TrackedFieldDef; counts: Record<string, number>; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const options = def.type === "checkbox"
    ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }]
    : (def.options ?? []);
  return (
    <>
      <label className="sr-only" htmlFor={id}>Filter by {def.label}</label>
      <select id={id} className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="*">{def.label}: any</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{def.label}: {o.label} ({counts[o.id] ?? 0})</option>
        ))}
        <option value="">{def.label}: not set ({counts[""] ?? 0})</option>
      </select>
    </>
  );
}

/** The card's recurring templates, with pause/resume. */
export function Templates({ items }: { items: TemplateSummary[] }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const setState = async (t: TemplateSummary, state: TemplateSummary["state"]) => {
    setBusy(t.id);
    try {
      await apiPost(`${projectApi(pid)}/templates/${enc(t.id)}/state`, { state });
      toast(`${t.title}: ${state === "active" ? "resumed" : state}`);
    } catch (e) {
      toast(`Could not change ${t.title}: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(null);
      applyInvalidation(qc, { projectId: pid, scopes: ["records", "navigation"] });
    }
  };
  return (
    <details className="templates">
      <summary className="small">Recurring templates ({items.length})</summary>
      <ul role="list" className="template-list">
        {items.map((t) => (
          <li key={t.id} data-template-id={t.id}>
            <strong>{t.title}</strong>{" "}
            <span className="small muted">
              daily at {t.schedule.time} ({t.schedule.timezone}) from {t.schedule.startDate}
              {t.schedule.endDate ? ` to ${t.schedule.endDate}` : ""} · {t.state}
              {t.lastDate ? ` · last ${t.lastDate}` : ""}
            </span>
            {t.error && <span className="field-error small"> {t.error}</span>}{" "}
            {t.state === "active" && (
              <button type="button" className="btn btn-sm" disabled={busy === t.id} onClick={() => void setState(t, "paused")}>Pause</button>
            )}
            {t.state === "paused" && (
              <button type="button" className="btn btn-sm" disabled={busy === t.id} onClick={() => void setState(t, "active")}>Resume</button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
