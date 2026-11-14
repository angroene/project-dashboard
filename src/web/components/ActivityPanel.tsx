import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityPage, MarkReadResponse } from "../../shared/api";
import { apiGet, apiPost, errorMessage, projectApi, qk } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject } from "../context";
import { dayKey, formatAbsolute, formatDay, formatTime, type Tone } from "../format";
import { projectHref } from "../routes";
import { ErrorNote, Loading, Pill, UnreadDot } from "./common";
import { useToast } from "./Toasts";

type Item = ActivityPage["items"][number];

const STATUS_TONE: Record<Item["status"], Tone> = { info: "neutral", success: "ok", warning: "warn", failure: "danger" };
const STATUS_LABEL: Record<Item["status"], string> = { info: "Info", success: "Success", warning: "Warning", failure: "Failure" };

export function ActivityPanel({ pageSize = 20 }: { pageSize?: number }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: [...qk.activity(pid), pageSize],
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams({ limit: String(pageSize) });
      if (pageParam) sp.set("cursor", pageParam);
      return apiGet<ActivityPage>(`${projectApi(pid)}/activity?${sp}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Item[] }[] = [];
    const seen = new Set<string>();
    for (const page of q.data?.pages ?? []) {
      for (const ev of page.items) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const key = dayKey(ev.at);
        let g = out[out.length - 1];
        if (!g || g.key !== key) {
          g = { key, label: formatDay(ev.at), items: [] };
          out.push(g);
        }
        g.items.push(ev);
      }
    }
    return out;
  }, [q.data]);

  const unreadCount = q.data?.pages[0]?.unreadCount ?? 0;

  const markRead = async (body: { activityIds?: string[]; allActivity?: boolean }, key: string) => {
    setBusy(key);
    try {
      const res = await apiPost<MarkReadResponse>(`${projectApi(pid)}/records/mark-read`, body);
      toast(`Marked ${res.marked} ${res.marked === 1 ? "update" : "updates"} as read`);
      applyInvalidation(qc, { projectId: pid, scopes: ["activity", "projects", "navigation"] });
    } catch (e) {
      toast(`Could not mark as read: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel" aria-labelledby={`activity-${pid}`}>
      <div className="row">
        <h2 className="section-title" id={`activity-${pid}`}>
          Recent activity {unreadCount > 0 && <Pill tone="info">{unreadCount} unread</Pill>}
        </h2>
        {unreadCount > 0 && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void markRead({ allActivity: true }, "all")}>
            Mark all read
          </button>
        )}
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && groups.length === 0 && <p className="muted">No activity reported yet.</p>}
      {groups.map((g) => (
        <div key={g.key} className="activity-day">
          <h3 className="activity-date">{g.label}</h3>
          <ul className="list" role="list">
            {g.items.map((ev) => (
              <li key={ev.id} className={`list-item activity${ev.unread ? " unread" : ""}`}>
                <div className="activity-head">
                  <time dateTime={ev.at} title={formatAbsolute(ev.at)} className="small muted">
                    {formatTime(ev.at)}
                  </time>
                  {ev.unread && <UnreadDot label="Unread update" />}
                  <Pill tone={STATUS_TONE[ev.status] ?? "neutral"}>{STATUS_LABEL[ev.status] ?? ev.status}</Pill>
                  <span className="small muted">{[ev.area, ev.action, ev.source].filter(Boolean).join(" · ")}</span>
                </div>
                <p className="activity-summary">{ev.summary}</p>
                <div className="tools">
                  {ev.recordId && (
                    <a className="btn btn-sm" href={projectHref(pid, [], ev.recordId)}>
                      Open record
                    </a>
                  )}
                  {ev.unread && (
                    <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void markRead({ activityIds: [ev.id] }, ev.id)}>
                      Mark read<span className="sr-only">: {ev.summary}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {q.hasNextPage && (
        <button type="button" className="btn load-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading…" : "Load more activity"}
        </button>
      )}
    </section>
  );
}
