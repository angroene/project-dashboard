import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImportCommitResponse, ImportPreview, ImportRowStatus } from "../../shared/api";
import { apiPost, errorMessage, projectApi, uploadMultipart } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject } from "../context";
import { formatAbsolute, type Tone } from "../format";
import { Modal, Pill, ProgressBar } from "./common";
import { useToast } from "./Toasts";

const STATUS: Record<ImportRowStatus, { label: string; tone: Tone }> = {
  ready: { label: "Ready to submit", tone: "ok" },
  blank: { label: "Blank / unchanged (skipped)", tone: "neutral" },
  invalid: { label: "Invalid", tone: "danger" },
  stale: { label: "Stale (question changed)", tone: "warn" },
  "already-answered": { label: "Already answered", tone: "neutral" },
  "needs-dashboard": { label: "Answer in dashboard (needs uploads)", tone: "warn" },
};
const STATUS_ORDER: ImportRowStatus[] = ["ready", "blank", "invalid", "stale", "already-answered", "needs-dashboard"];

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [results, setResults] = useState<ImportCommitResponse["results"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const p = await uploadMultipart<ImportPreview>(`${projectApi(pid)}/import/xlsx/preview`, form, setProgress);
      setPreview(p);
      setChosen(new Set(p.rows.filter((r) => r.status === "ready").map((r) => r.questionId)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const commit = async () => {
    if (!preview || chosen.size === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await apiPost<ImportCommitResponse>(`${projectApi(pid)}/import/xlsx/commit`, { previewId: preview.previewId, questionIds: [...chosen] });
      setResults(res.results);
      const ok = res.results.filter((r) => r.ok).length;
      toast(`Imported ${ok} of ${res.results.length} answers · awaiting pickup`, ok === res.results.length ? "info" : "error");
      applyInvalidation(qc, { projectId: pid, scopes: ["answers", "projects", "navigation"], recordIds: res.results.map((r) => r.questionId) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCommitting(false);
    }
  };

  const toggle = (qid: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(qid);
      else next.delete(qid);
      return next;
    });

  return (
    <Modal title="Import answers from Excel" onClose={onClose} wide>
      {!preview && (
        <form onSubmit={(e) => void upload(e)}>
          <p>Upload a workbook exported from this dashboard. You will see a preview before anything is submitted.</p>
          <label className="field-label" htmlFor={`${id}-file`}>
            Workbook (.xlsx)
          </label>
          <input
            id={`${id}-file`}
            className="input"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {progress != null && <ProgressBar value={progress * 100} label="Upload progress" small />}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="tools modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!file || progress != null}>
              {progress != null ? "Uploading…" : "Preview import"}
            </button>
          </div>
        </form>
      )}

      {preview && (
        <>
          <p className="small muted">
            {preview.fileName} · preview valid until {formatAbsolute(preview.expiresAt)}
          </p>
          {preview.errors.length > 0 && (
            <div className="notice notice-error" role="alert">
              <strong>Workbook problems:</strong>
              <ul role="list">
                {preview.errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className="counts" role="list" aria-label="Preview totals">
            {STATUS_ORDER.map((s) => (
              <li key={s}>
                <Pill tone={(preview.totals[s] ?? 0) > 0 ? STATUS[s].tone : "neutral"}>
                  {preview.totals[s] ?? 0} · {STATUS[s].label}
                </Pill>
              </li>
            ))}
          </ul>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Submit</span>
                  </th>
                  <th scope="col">Question</th>
                  <th scope="col">Status</th>
                  <th scope="col">Messages</th>
                  {results && <th scope="col">Result</th>}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const res = results?.find((x) => x.questionId === r.questionId);
                  return (
                    <tr key={r.questionId}>
                      <td>
                        {r.status === "ready" && (
                          <input
                            type="checkbox"
                            aria-label={`Submit answer for ${r.questionId}`}
                            checked={chosen.has(r.questionId)}
                            disabled={!!results || committing}
                            onChange={(e) => toggle(r.questionId, e.target.checked)}
                          />
                        )}
                      </td>
                      <td>
                        <span className="mono">{r.questionId}</span>
                        <div className="small">{r.title}</div>
                      </td>
                      <td>
                        <Pill tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Pill>
                      </td>
                      <td className="break small">{r.messages.length ? r.messages.join("; ") : "—"}</td>
                      {results && (
                        <td className="small">
                          {res ? (res.ok ? <Pill tone="info">Submitted · Awaiting pickup</Pill> : <span className="field-error">{res.message ?? "Failed"}</span>) : "—"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="tools modal-actions">
            {!results && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPreview(null);
                  setFile(null);
                }}
              >
                Choose another file
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              {results ? "Close" : "Cancel"}
            </button>
            {!results && (
              <button type="button" className="btn primary" disabled={chosen.size === 0 || committing} onClick={() => void commit()}>
                {committing ? "Submitting…" : `Submit ${chosen.size} selected ${chosen.size === 1 ? "answer" : "answers"}`}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
