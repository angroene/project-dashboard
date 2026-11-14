import { useQuery } from "@tanstack/react-query";
import type { AttentionResponse, RecordSummary } from "../../shared/api";
import { apiGet, projectApi, qk } from "../api/client";
import { useProject } from "../context";
import { uiStateInfo } from "../format";
import { projectHref } from "../routes";
import { ErrorNote, Loading, Pill, TimeAgo, UnreadDot } from "./common";

export function AttentionPanel() {
  const { pid } = useProject();
  const q = useQuery({ queryKey: qk.attention(pid), queryFn: ({ signal }) => apiGet<AttentionResponse>(`${projectApi(pid)}/attention`, signal) });
  const d = q.data;
  return (
    <section className="panel" aria-labelledby={`attention-${pid}`}>
      <h2 className="section-title" id={`attention-${pid}`}>
        Needs your attention
      </h2>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {d && d.questions.length === 0 && d.unreadRecords.length === 0 && <p className="muted">Nothing needs your attention.</p>}
      {d && d.questions.length > 0 && (
        <>
          <h3>Questions awaiting your response ({d.questions.length})</h3>
          <AttentionList items={d.questions} />
        </>
      )}
      {d && d.unreadRecords.length > 0 && (
        <>
          <h3>Unread updates ({d.unreadRecords.length})</h3>
          <AttentionList items={d.unreadRecords} />
        </>
      )}
    </section>
  );
}

function AttentionList({ items }: { items: RecordSummary[] }) {
  const { pid, navIndex } = useProject();
  return (
    <ul className="list" role="list">
      {items.map((r) => {
        const path = navIndex.get(r.sectionId)?.tabPath ?? [];
        const section = navIndex.get(r.sectionId)?.node.title;
        const ui = r.question ? uiStateInfo(r.question.uiState) : null;
        return (
          <li key={r.id} className="list-item">
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
            </div>
          </li>
        );
      })}
    </ul>
  );
}
