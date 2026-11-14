import { useQuery } from "@tanstack/react-query";
import type { ProgressResponse } from "../../shared/api";
import { apiGet, projectApi, qk } from "../api/client";
import { useProject } from "../context";
import { formatAbsolute, formatPercent } from "../format";
import { ErrorNote, Loading, Pill, ProgressBar, TimeAgo } from "./common";

export function ProgressPanel() {
  const { pid } = useProject();
  const q = useQuery({ queryKey: qk.progress(pid), queryFn: ({ signal }) => apiGet<ProgressResponse>(`${projectApi(pid)}/progress`, signal) });
  const d = q.data;
  return (
    <section className="panel" aria-labelledby={`progress-${pid}`}>
      <h2 className="section-title" id={`progress-${pid}`}>
        {d?.label || "Progress"}
      </h2>
      <p className="small muted">Published by the project, not calculated by the dashboard</p>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {d && (
        <>
          <div className="meta">
            <span>Overall</span>
            <span className="progress-value">
              {d.stale && <Pill tone="warn">Stale</Pill>}
              <strong>{d.overallPercent == null ? "Not reported" : formatPercent(d.overallPercent)}</strong>
            </span>
          </div>
          {d.overallPercent != null && <ProgressBar value={d.overallPercent} label={d.label || "Overall progress"} />}
          {d.method && <p className="small">{d.method}</p>}
          {d.updatedAt && (
            <p className="small muted">
              Updated <TimeAgo iso={d.updatedAt} />
            </p>
          )}
          {d.breakdown.length === 0 ? (
            <p className="small muted">No breakdown published.</p>
          ) : (
            <ul className="breakdown" role="list">
              {d.breakdown.map((b) => (
                <li key={b.id} title={b.updatedAt ? `Updated ${formatAbsolute(b.updatedAt)}` : undefined}>
                  <div className="meta">
                    <span>
                      {b.title}
                      {b.weight != null && <span className="small muted"> · weight {b.weight}</span>}
                    </span>
                    <strong>{b.percent == null ? "Not reported" : formatPercent(b.percent)}</strong>
                  </div>
                  {b.percent != null && <ProgressBar value={b.percent} label={b.title} small />}
                  {b.detail && <p className="small muted breakdown-detail">{b.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
