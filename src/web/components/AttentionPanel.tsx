import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ATTENTION_GROUPS, type AttentionGroup, type AttentionPage, type AttentionResponse, type MarkReadResponse, type RecordSummary } from "../../shared/api";
import { apiGet, apiPost, enc, errorMessage, projectApi, qk } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { prefersReducedMotion, useProject } from "../context";
import { uiStateInfo } from "../format";
import { projectHref } from "../routes";
import { ErrorNote, Loading, Pill, TimeAgo, UnreadDot } from "./common";
import { useToast } from "./Toasts";

const PAGE = 25;

const GROUP_INFO: Record<AttentionGroup, { title: string; pending: (n: number) => string; empty: string }> = {
  questions: { title: "Questions", pending: (n) => `${n} awaiting your answer`, empty: "No questions." },
  actions: { title: "Actions", pending: (n) => `${n} to do`, empty: "No actions." },
  responses: { title: "Responses", pending: (n) => `${n} unread`, empty: "No responses." },
  updates: { title: "Updates", pending: (n) => `${n} unread`, empty: "No updates." },
};

/**
 * What needs the user, split into Questions, Actions, Responses and Updates. By default each group lists only what is
 * pending (unanswered, outstanding, unread); "Show all" adds answered, completed and read history without changing any
 * record. Marking read changes read state only: it never answers a question or completes an action.
 */
export function AttentionPanel() {
  const { pid, attention: focus } = useProject();
  const q = useQuery({ queryKey: qk.attention(pid), queryFn: ({ signal }) => apiGet<AttentionResponse>(`${projectApi(pid)}/attention`, signal) });
  const d = q.data;
  const [open, setOpen] = useState(true);
  // Off whenever the project is opened again: the component is remounted per project visit.
  const [showAll, setShowAll] = useState(false);
  const bodyId = useId();
  const headId = `attention-${pid}`;
  const counts = d?.counts;
  const pendingTotal = counts ? ATTENTION_GROUPS.reduce((n, g) => n + counts[g], 0) : 0;
  const shown = d ? ATTENTION_GROUPS.filter((g) => (showAll ? d.totals[g] : d.counts[g]) > 0) : [];

  // A deep link (?attention=<group>) opens the panel; the group scrolls itself into view.
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) setOpen(true);
  }

  return (
    <section className="panel attention-panel" aria-labelledby={headId}>
      <div className="panel-head">
        <h2 className="section-title" id={headId}>
          <button type="button" className="card-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            <span className="card-title-text">Needs your attention</span>
            <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
              ▾
            </span>
          </button>
        </h2>
        {open && d && (
          <label className="check show-all">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <span>Show all</span>
          </label>
        )}
      </div>
      <div id={bodyId} hidden={!open}>
        {q.isPending && <Loading />}
        {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
        {d && (
          <nav className="attention-index" aria-label="Attention groups">
            <ul role="list">
              {ATTENTION_GROUPS.map((g) => {
                const n = d.counts[g];
                const body = (
                  <>
                    <span>{GROUP_INFO[g].title}</span> <strong>{n}</strong>
                    <span className="sr-only"> pending</span>
                  </>
                );
                return (
                  <li key={g}>
                    {shown.includes(g) ? (
                      <a href={`#${groupAnchor(pid, g)}`} className={`attention-chip${n > 0 ? " has" : ""}`} onClick={(e) => { e.preventDefault(); scrollToGroup(pid, g); }}>
                        {body}
                      </a>
                    ) : (
                      <span className="attention-chip">{body}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        {d && !showAll && pendingTotal === 0 && (
          <p className="caught-up" role="status">
            <span aria-hidden="true">✓</span> All caught up
            {d.unreadActivity > 0 && <span className="small muted"> · {d.unreadActivity} unread activity {d.unreadActivity === 1 ? "event" : "events"} below</span>}
          </p>
        )}
        {d && showAll && shown.length === 0 && <p className="muted">Nothing here yet.</p>}
        {shown.map((g) => (
          <GroupView key={`${g}-${showAll}`} group={g} all={showAll} count={showAll ? d!.totals[g] : d!.counts[g]} pending={d!.counts[g]} focused={focus === g} />
        ))}
      </div>
    </section>
  );
}

const groupAnchor = (pid: string, g: AttentionGroup) => `attention-${pid}-${g}`;

function scrollToGroup(pid: string, g: AttentionGroup) {
  const el = document.getElementById(groupAnchor(pid, g));
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  el.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

function GroupView({ group, all, count, pending, focused }: { group: AttentionGroup; all: boolean; count: number; pending: number; focused: boolean }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [wasFocused, setWasFocused] = useState(focused);
  if (focused !== wasFocused) {
    setWasFocused(focused);
    if (focused) setOpen(true);
  }
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const bodyId = useId();
  const ref = useRef<HTMLElement>(null);
  const info = GROUP_INFO[group];

  const pages = useInfiniteQuery({
    queryKey: [...qk.attention(pid), group, all],
    queryFn: ({ pageParam, signal }) =>
      apiGet<AttentionPage>(`${projectApi(pid)}/attention/${group}?limit=${PAGE}${all ? "&all=1" : ""}${pageParam ? `&cursor=${enc(pageParam)}` : ""}`, signal),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });

  // Pages are keyset-paged; a record that moved between pages during a refresh is shown once.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: RecordSummary[] = [];
    for (const pg of pages.data?.pages ?? []) for (const r of pg.items) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    return out;
  }, [pages.data]);
  const readable = items.filter((r) => r.unread);
  // Only selections that are still listed and unread count; others drop out without resetting the rest.
  const chosen = readable.filter((r) => selected.has(r.id));
  const allChosen = readable.length > 0 && chosen.length === readable.length;

  useEffect(() => {
    if (!focused) return;
    const raf = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      ref.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focused]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const markRead = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const ids = chosen.map((r) => r.id);
      const res = await apiPost<MarkReadResponse>(`${projectApi(pid)}/records/mark-read`, { recordIds: ids });
      setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
      const msg = `${res.marked} marked as read`;
      setAnnounce(msg);
      toast(msg);
    } catch (e) {
      toast(`Could not mark as read: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(false);
      applyInvalidation(qc, { projectId: pid, scopes: ["projects", "records", "navigation"] });
    }
  };

  const label = all ? `${info.title} (${count}${pending ? `, ${pending} pending` : ""})` : `${info.title}: ${info.pending(count)}`;
  return (
    <section ref={ref} className="attention-group" id={groupAnchor(pid, group)} aria-label={info.title}>
      <h3>
        <button type="button" className="card-toggle group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <span className="card-title-text">{label}</span>
          <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      </h3>
      <div id={bodyId} hidden={!open}>
        {pages.isPending && open && <Loading />}
        {pages.isError && <ErrorNote error={pages.error} onRetry={() => void pages.refetch()} />}
        {readable.length > 0 && (
          <div className="bulk-bar">
            <label className="check">
              <input type="checkbox" checked={allChosen} onChange={(e) => setSelected(e.target.checked ? new Set(readable.map((r) => r.id)) : new Set())} />
              <span>Select all unread shown ({readable.length})</span>
            </label>
            <button type="button" className="btn btn-sm" disabled={busy || chosen.length === 0} onClick={() => void markRead()}>
              {busy ? "Marking…" : `Mark selected as read${chosen.length ? ` (${chosen.length})` : ""}`}
            </button>
          </div>
        )}
        <span className="sr-only" role="status">
          {announce}
        </span>
        {pages.data && items.length === 0 && <p className="muted">{info.empty}</p>}
        {items.length > 0 && (
          <AttentionList items={items} selected={selected} onSelect={toggle} />
        )}
        {pages.hasNextPage && (
          <button type="button" className="btn btn-sm load-more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            {pages.isFetchingNextPage ? "Loading…" : `Show more (${items.length} of ${pages.data?.pages.at(-1)?.total ?? count})`}
          </button>
        )}
      </div>
    </section>
  );
}

function AttentionList({ items, selected, onSelect }: { items: RecordSummary[]; selected: ReadonlySet<string>; onSelect: (id: string, on: boolean) => void }) {
  const { pid, navIndex } = useProject();
  return (
    <ul className="list" role="list">
      {items.map((r) => {
        const path = navIndex.get(r.sectionId)?.tabPath ?? [];
        const section = navIndex.get(r.sectionId)?.node.title;
        const ui = r.question ? uiStateInfo(r.question.uiState) : null;
        return (
          <li key={r.id} className="list-item attention-item">
            {r.unread && (
              <label className="check">
                <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => onSelect(r.id, e.target.checked)} />
                <span className="sr-only">Select {r.title}</span>
              </label>
            )}
            <div className="attention-item-body">
              <a href={projectHref(pid, path, r.id)} className="list-link">
                {r.unread && <UnreadDot />}
                {r.title}
              </a>
              <div className="list-meta small muted">
                <span className="mono">{r.id}</span>
                {section && <span> · {section}</span>}
                <span>
                  {" "}
                  · <TimeAgo iso={r.updatedAt} />
                </span>
                {r.question?.dueAt && (
                  <span>
                    {" "}
                    · due <TimeAgo iso={r.question.dueAt} />
                  </span>
                )}
                {ui && <Pill tone={ui.tone}>{ui.label}</Pill>}
                {r.requiresAction && !r.question && (
                  <Pill tone={r.actionOutstanding ? "warn" : "ok"}>{r.actionOutstanding ? "To do" : "Done"}</Pill>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
