import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NavigationResponse, NavNode, ProjectDetail, ProjectsResponse, RecordDetail } from "../../shared/api";
import { apiGet, projectApi, enc, qk } from "../api/client";
import { buildNavIndex, ProjectContext, type ProjectCtx } from "../context";
import { homeHref, navigate, projectHref, type ProjectRoute } from "../routes";
import { ErrorNote, Loading, Pill, ProgressSummaryView } from "./common";
import { SectionContent, TabBar, TabPanel, WorkAreas } from "./Navigation";
import { CardPanel, StandaloneRecord } from "./CardPanel";
import { preloadDetailChunks } from "./RecordDetail";
import { ProgressPanel } from "./ProgressPanel";
import { AttentionPanel } from "./AttentionPanel";
import { ActivityPanel } from "./ActivityPanel";

export function ProjectWorkspace({ route }: { route: ProjectRoute }) {
  const qc = useQueryClient();
  const { projectId: pid, path, record } = route;

  const detail = useQuery<ProjectDetail>({
    queryKey: qk.projectDetail(pid),
    queryFn: ({ signal }) => apiGet<ProjectDetail>(projectApi(pid), signal),
    placeholderData: () => qc.getQueryData<ProjectsResponse>(qk.projects)?.projects.find((p) => p.id === pid),
  });
  const available = detail.data?.available !== false;
  const nav = useQuery({
    queryKey: qk.navigation(pid),
    queryFn: ({ signal }) => apiGet<NavigationResponse>(`${projectApi(pid)}/navigation`, signal),
    enabled: available && !!detail.data,
  });
  const focusDetail = useQuery({
    queryKey: qk.record(pid, record ?? ""),
    queryFn: ({ signal }) => apiGet<RecordDetail>(`${projectApi(pid)}/records/${enc(record ?? "")}`, signal),
    enabled: !!record,
  });

  // Warm the lazily loaded detail chunks while idle so the first record expand does not wait for them.
  useEffect(() => {
    const t = setTimeout(preloadDetailChunks, 1000);
    return () => clearTimeout(t);
  }, []);

  const navIndex = useMemo(() => buildNavIndex(nav.data?.nodes ?? []), [nav.data]);
  const focusSection = record && focusDetail.data ? focusDetail.data.sectionId : null;
  const focusEntry = focusSection ? navIndex.get(focusSection) : undefined;

  // A record link without a section path (activity, linked records) resolves to the tab that shows it.
  useEffect(() => {
    if (!record || path.length > 0 || !focusEntry || focusEntry.tabPath.length === 0) return;
    navigate(projectHref(pid, focusEntry.tabPath, record), { replace: true });
  }, [record, path.length, focusEntry, pid]);

  const ctx: ProjectCtx = useMemo(
    () => ({ pid, navIndex, focus: record && focusSection ? { recordId: record, sectionId: focusSection } : null }),
    [pid, navIndex, record, focusSection],
  );

  const project = detail.data;
  const nodes = nav.data?.nodes ?? [];
  const rootType = nav.data?.rootChildType ?? null;

  // Resolve the selected tabs from the path.
  let main: NavNode | undefined;
  let rootPage: NavNode | undefined;
  let missing = false;
  if (rootType === "main-tab" && path[0]) {
    main = nodes.find((n) => n.id === path[0]);
    missing = !main;
  } else if (rootType === "page-tab" && path[0]) {
    rootPage = nodes.find((n) => n.id === path[0]);
    missing = !rootPage;
  }
  const mainPages = main?.children.filter((c) => c.displayType === "page-tab") ?? [];
  const selectedMainPage = main ? (mainPages.find((c) => c.id === path[1]) ?? mainPages[0]) : undefined;

  const crumbs: { label: string; href?: string }[] = [{ label: "All projects", href: homeHref }];
  if (project) crumbs.push({ label: project.displayName, href: main || rootPage ? projectHref(pid) : undefined });
  if (main) crumbs.push({ label: main.title, href: selectedMainPage ? projectHref(pid, [main.id]) : undefined });
  if (selectedMainPage) crumbs.push({ label: selectedMainPage.title });
  if (rootPage) crumbs.push({ label: rootPage.title });

  const orphanFocus = record && focusDetail.data && nav.data && !focusEntry;
  const showOverview = !main && !rootPage;

  return (
    <ProjectContext.Provider value={ctx}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((c, i) => (
            <li key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
              {c.href ? <a href={c.href}>{c.label}</a> : c.label}
            </li>
          ))}
        </ol>
      </nav>

      {detail.isPending && <Loading label="Loading project…" />}
      {detail.isError && !project && <ErrorNote prefix="Could not load project" error={detail.error} onRetry={() => void detail.refetch()} />}
      {project && <ProjectHeader project={project} />}
      {project && !project.available && (
        <div className="notice notice-error" role="alert">
          This project is unavailable: {project.unavailableReason || "unknown reason"}.
        </div>
      )}

      {project?.available && (
        <>
          {nav.isPending && <Loading label="Loading sections…" />}
          {nav.isError && <ErrorNote prefix="Could not load navigation" error={nav.error} onRetry={() => void nav.refetch()} />}
          {record && focusDetail.isError && <ErrorNote prefix={`Could not open record ${record}`} error={focusDetail.error} />}
          {missing && (
            <div className="notice" role="alert">
              The section “{path[0]}” does not exist (it may have been renamed or removed).
            </div>
          )}
          {orphanFocus && focusDetail.data && <StandaloneRecord record={focusDetail.data} />}

          {nav.data && rootType === null && (
            <div className="panel empty">
              <h2>No sections yet</h2>
              <p>This project has not published any sections.</p>
            </div>
          )}

          {nav.data && rootType === "main-tab" && (
            <>
              <WorkAreas nodes={nodes} selectedId={main?.id} />
              {main && <SectionContent node={main} selectedPageId={selectedMainPage?.id} />}
            </>
          )}

          {nav.data && rootType === "page-tab" && (
            <>
              <TabBar tabs={nodes} selectedId={rootPage?.id} hrefFor={(t) => projectHref(pid, [t.id])} label={`${project.displayName} views`} />
              {rootPage && (
                <TabPanel tabId={rootPage.id}>
                  <SectionContent node={rootPage} />
                </TabPanel>
              )}
            </>
          )}

          {nav.data && showOverview && <Overview />}

          {nav.data && rootType === "expandable-card" && (
            <div className="card-list">
              {nodes.map((n) => (
                <CardPanel key={n.id} node={n} />
              ))}
            </div>
          )}
        </>
      )}
    </ProjectContext.Provider>
  );
}

function ProjectHeader({ project: p }: { project: ProjectDetail }) {
  return (
    <>
      <div className="hero">
        <div>
          <div className="eyebrow">Project workspace</div>
          <h1 tabIndex={-1}>{p.displayName}</h1>
          {p.description && <p>{p.description}</p>}
        </div>
        {p.awaitingResponse > 0 ? <Pill tone="warn">{p.awaitingResponse} awaiting your response</Pill> : <Pill tone="ok">Nothing awaiting your response</Pill>}
      </div>
      <div className="stats">
        <div className="stat stat-progress">
          <ProgressSummaryView progress={p.progress} name={p.displayName} />
        </div>
        <div className="stat">
          <span>Need your response</span>
          <strong>{p.awaitingResponse}</strong>
        </div>
        <div className="stat">
          <span>Unread updates</span>
          <strong>{p.unreadUpdates}</strong>
        </div>
        <div className="stat">
          <span>Submitted · awaiting pickup</span>
          <strong>{p.awaitingPickup}</strong>
        </div>
        {p.active > 0 && (
          <div className="stat">
            <span>Active</span>
            <strong>{p.active}</strong>
          </div>
        )}
        {p.blocked > 0 && (
          <div className="stat stat-danger">
            <span>Blocked</span>
            <strong>{p.blocked}</strong>
          </div>
        )}
      </div>
    </>
  );
}

function Overview() {
  return (
    <div className="overview">
      <div className="summary-grid">
        <ProgressPanel />
        <AttentionPanel />
      </div>
      <ActivityPanel pageSize={10} />
    </div>
  );
}
