import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectCard, ProjectsResponse } from "../../shared/api";
import { apiGet, qk } from "../api/client";
import { useSseFallback } from "../api/sse";
import { diagnosticsHref, projectHref } from "../routes";
import { ErrorNote, Loading, Pill, ProgressSummaryView } from "./common";

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

const ProjectCardView = memo(function ProjectCardView({ p }: { p: ProjectCard }) {
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
  const attention = p.awaitingResponse > 0 || p.unreadUpdates > 0;
  return (
    <a className={`project accent-${p.accent}`} href={projectHref(p.id)}>
      <div className="top">
        <h2 className="project-title">{p.displayName}</h2>
        {attention ? (
          <span className="attention">
            <span className="attention-dot" aria-hidden="true" />
            Needs attention
          </span>
        ) : (
          <Pill tone="ok">Up to date</Pill>
        )}
      </div>
      {p.description && <p className="project-desc">{p.description}</p>}
      <ProgressSummaryView progress={p.progress} name={p.displayName} />
      <ul className="counts" role="list">
        <li>
          <Pill tone={p.awaitingResponse > 0 ? "warn" : "neutral"}>
            {p.awaitingResponse} {p.awaitingResponse === 1 ? "question needs" : "questions need"} response
          </Pill>
        </li>
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
      <span className="explore" aria-hidden="true">
        Open project →
      </span>
    </a>
  );
});
