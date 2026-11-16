import { memo, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectCard, ProjectsResponse } from "../../shared/api";
import { apiGet, qk } from "../api/client";
import { useSseFallback } from "../api/sse";
import { attentionHref, diagnosticsHref, projectHref } from "../routes";
import { formatPercent } from "../format";
import { ErrorNote, Loading, Pill, ProgressBar, ProgressSummaryView } from "./common";

export function useProjects() {
  const fallback = useSseFallback();
  return useQuery({
    queryKey: qk.projects,
    queryFn: ({ signal }) => apiGet<ProjectsResponse>("/api/projects", signal),
    refetchInterval: fallback ? 60_000 : false,
  });
}

export function ProjectsLanding() {
  const q = useProjects();
  const data = q.data;
  return (
    <>
      <div className="hero">
        <div>
          <div className="eyebrow">All projects</div>
          <h1 tabIndex={-1}>{data?.productName ?? "Projects"}</h1>
          <p>Select a project to see its work areas, questions and published progress.</p>
        </div>
        {data && data.diagnosticsCount > 0 && (
          <a className="btn" href={diagnosticsHref}>
            <span aria-hidden="true">⚠</span> {data.diagnosticsCount} configuration {data.diagnosticsCount === 1 ? "problem" : "problems"}
          </a>
        )}
      </div>
      {q.isPending && <Loading label="Loading projects…" />}
      {q.isError && <ErrorNote prefix="Could not load projects" error={q.error} onRetry={() => void q.refetch()} />}
      {data && data.projects.length === 0 && (
        <div className="panel empty">
          <h2>No projects registered</h2>
          <p>
            Add a project folder with a valid <code>project.json</code> under the dashboard data root. It appears here once the server has indexed it.
          </p>
        </div>
      )}
      {data && data.projects.length > 0 && (
        <ul className="cards" role="list">
          {data.projects.map((p) => (
            <li key={p.id}>
              <ProjectCardView p={p} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * One project, collapsed to its name and one status line by default: what requires attention, else published
 * progress, else nothing. The name opens the project; the chevron button only expands or collapses the details.
 */
const ProjectCardView = memo(function ProjectCardView({ p }: { p: ProjectCard }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (!p.available) {
    return (
      <div className="project project-disabled" aria-disabled="true">
        <div className="top">
          <h2 className="project-title">{p.displayName}</h2>
          <Pill tone="danger">Unavailable</Pill>
        </div>
        {p.description && <p>{p.description}</p>}
        <p className="small">{p.unavailableReason || "This project is temporarily unavailable."}</p>
      </div>
    );
  }
  const need = p.requireAttention ?? p.awaitingResponse;
  const pct = p.progress.overallPercent;
  return (
    <div className={`project project-compact accent-${p.accent}${open ? " open" : ""}`}>
      <div className="project-head">
        <h2 className="project-title">
          <a href={projectHref(p.id)} className="project-link">
            {p.displayName}
          </a>
        </h2>
        <button
          type="button"
          className="btn ghost btn-icon project-expand"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? "Hide" : "Show"} details for ${p.displayName}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <div className="project-line">
        {need > 0 ? (
          <a className="attention" href={attentionHref(p.id, p.awaitingResponse > 0 ? "questions" : "actions")}>
            <span className="attention-dot" aria-hidden="true" />
            {need} {need === 1 ? "requires" : "require"} attention
          </a>
        ) : pct != null ? (
          <span className="project-line-progress" title={p.progress.label || "Overall progress"}>
            <ProgressBar value={pct} label={`${p.displayName}: ${p.progress.label || "Overall progress"}`} small />
            <span className="small" aria-hidden="true">{formatPercent(pct)}</span>
          </span>
        ) : null}
      </div>
      <div id={bodyId} className="project-details" hidden={!open}>
        {p.description && <p className="project-desc">{p.description}</p>}
        <ProgressSummaryView progress={p.progress} name={p.displayName} />
        <ul className="counts" role="list">
          <li>
            <Pill tone={p.awaitingResponse > 0 ? "warn" : "neutral"}>
              {p.awaitingResponse} {p.awaitingResponse === 1 ? "question needs" : "questions need"} response
            </Pill>
          </li>
          {(p.outstandingActions ?? 0) > 0 && (
            <li>
              <Pill tone="warn">{p.outstandingActions} {p.outstandingActions === 1 ? "action" : "actions"} to do</Pill>
            </li>
          )}
          <li>
            <Pill tone={p.unreadUpdates > 0 ? "info" : "neutral"}>
              {p.unreadUpdates} unread {p.unreadUpdates === 1 ? "update" : "updates"}
            </Pill>
          </li>
          {p.awaitingPickup > 0 && (
            <li>
              <Pill tone="info">{p.awaitingPickup} submitted · awaiting pickup</Pill>
            </li>
          )}
          {p.blocked > 0 && (
            <li>
              <Pill tone="danger">{p.blocked} blocked</Pill>
            </li>
          )}
          {p.active > 0 && (
            <li>
              <Pill>{p.active} active</Pill>
            </li>
          )}
        </ul>
        <a className="explore" href={projectHref(p.id)}>
          Open project <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  );
});
