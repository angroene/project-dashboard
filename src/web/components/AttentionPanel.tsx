import { useId, useState, type ReactNode } from "react";
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
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="panel" aria-labelledby={`attention-${pid}`}>
      <h2 className="section-title" id={`attention-${pid}`}>
        <button type="button" className="card-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <span className="card-title-text">Needs your attention</span>
          <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      </h2>
      <div id={bodyId} hidden={!open}>
        {q.isPending && <Loading />}
        {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
        {d && d.questions.length === 0 && d.unreadRecords.length === 0 && <p className="muted">Nothing needs your attention.</p>}
        {d && d.questions.length > 0 && (
          <Group title={`Questions awaiting your response (${d.questions.length})`}>
            <AttentionList items={d.questions} />
          </Group>
        )}
        {d && d.unreadRecords.length > 0 && (
          <Group title={`Unread updates (${d.unreadRecords.length})`}>
            <AttentionList items={d.unreadRecords} />
          </Group>
        )}
      </div>
    </section>
  );
}

/** A group inside the panel that can be folded away on its own (long unread lists push the questions off a phone screen). */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <>
      <h3>
        <button type="button" className="card-toggle group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <span className="card-title-text">{title}</span>
          <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      </h3>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </>
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
