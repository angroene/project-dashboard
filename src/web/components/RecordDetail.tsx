import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MarkReadResponse, RecordDetail } from "../../shared/api";
import { apiGet, apiPost, apiPostDownload, enc, errorMessage, projectApi, qk } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject } from "../context";
import { formatAbsolute, humanize, recordPlainText } from "../format";
import { projectHref } from "../routes";
import { AttachmentList, ErrorNote, Loading, ProgressBar, TimeAgo } from "./common";
import { useCopy, useToast } from "./Toasts";
import { lazyModule } from "../lazyModule";
import { CommentBox, ExternalRefs, TrackedFields } from "./RecordFields";

// Markdown rendering and answer forms are only needed once a record is expanded: separate chunks.
const markdownChunk = lazyModule(() => import("./MarkdownBody"));
const questionChunk = lazyModule(() => import("./QuestionForm"));

/** Warms both detail chunks (called while idle after a project opens). */
export function preloadDetailChunks(): void {
  void markdownChunk.load();
  void questionChunk.load();
}

export function RecordDetailView({ id }: { id: string }) {
  const { pid } = useProject();
  const q = useQuery({
    queryKey: qk.record(pid, id),
    queryFn: ({ signal }) => apiGet<RecordDetail>(`${projectApi(pid)}/records/${enc(id)}`, signal),
  });
  if (q.isPending) return <Loading label="Loading details…" />;
  if (q.isError) return <ErrorNote prefix="Could not load details" error={q.error} onRetry={() => void q.refetch()} />;
  return <DetailBody d={q.data} />;
}

function DetailBody({ d }: { d: RecordDetail }) {
  const { pid, navIndex } = useProject();
  const ui = d.question?.uiState;
  const metaEntries = Object.entries(d.metadata);
  const md = markdownChunk.useModule();
  const qm = questionChunk.useModule();
  return (
    <div className="detail">
      {d.bodyMarkdown && (
        md ? <md.default text={d.bodyMarkdown} /> : <Loading label="Loading description…" />
      )}

      {d.percent != null && (
        <div className="record-percent">
          <ProgressBar value={d.percent} label={`${d.title} progress`} />
          <span className="small">{Math.round(d.percent)}%</span>
        </div>
      )}

      {d.question && (
        <div className="question-area">
          {!qm ? (
            <Loading label="Loading answer form…" />
          ) : ui === "needs-response" && d.answerSchema ? (
            <qm.QuestionForm detail={d} />
          ) : d.submittedAnswer ? (
            <>
              <qm.SubmittedAnswerView detail={d} />
              {ui === "failed" && d.answerSchema && <AnswerAgain detail={d} Form={qm.QuestionForm} />}
            </>
          ) : ui === "needs-response" ? (
            <p className="notice">This question needs a response but publishes no answer form. Reply through the project instead.</p>
          ) : ui === "answered" ? (
            <p className="notice">Answered{d.question.answeredAt ? ` ${formatAbsolute(d.question.answeredAt)}` : ""} outside the dashboard. No response is needed.</p>
          ) : null}
        </div>
      )}

      <TrackedFields d={d} />

      {d.occurrence && (
        <p className="small muted occurrence-note">
          Created from recurring template <span className="mono">{d.occurrence.templateId}</span> for {d.occurrence.date}.
        </p>
      )}

      {(metaEntries.length > 0 || d.createdAt || d.taskId || d.question) && (
        <dl className="meta-table">
          {d.question && <MetaPair term="Question revision" value={String(d.question.revision)} />}
          {d.taskId && <MetaPair term="Task" value={d.taskId} mono />}
          {d.createdAt && <MetaPair term="Created" value={formatAbsolute(d.createdAt)} />}
          <MetaPair term="Updated" value={formatAbsolute(d.updatedAt)} />
          {metaEntries.map(([k, v]) => (
            <MetaPair key={k} term={k} value={typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)} />
          ))}
        </dl>
      )}

      {d.links.length > 0 && (
        <div className="detail-block">
          <h4>Links</h4>
          <ul role="list" className="link-list">
            {d.links.map((l, i) => (
              <li key={i}>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ExternalRefs items={d.external ?? []} />

      {d.linkedRecords.length > 0 && (
        <div className="detail-block">
          <h4>Linked records</h4>
          <ul role="list" className="link-list">
            {d.linkedRecords.map((l) => (
              <li key={l.id}>
                <a href={projectHref(pid, navIndex.get(l.sectionId)?.tabPath ?? [], l.id)}>
                  <span className="mono">{l.id}</span> · {l.title}
                </a>{" "}
                <span className="small muted">({humanize(l.recordType)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.attachments.length > 0 && (
        <div className="detail-block">
          <h4>Attachments</h4>
          <AttachmentList items={d.attachments} />
        </div>
      )}

      {d.history.length > 0 && (
        <div className="detail-block">
          <h4>History</h4>
          <ol className="history" role="list">
            {d.history.map((h, i) => (
              <li key={i}>
                <TimeAgo iso={h.at} />
                {h.by && <span className="muted"> · {h.by}</span>}
                <span> — {h.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <CommentBox d={d} />

      <RecordActions d={d} />
    </div>
  );
}

/** After a failed processing attempt the server accepts a new answer; each form mount gets a fresh idempotency key. */
function AnswerAgain({ detail, Form }: { detail: RecordDetail; Form: (p: { detail: RecordDetail }) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="tools answer-again">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Answer again
        </button>
      </div>
    );
  }
  return <Form detail={detail} />;
}

function MetaPair({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="meta-pair">
      <dt>{term}</dt>
      <dd className={mono ? "mono break" : "break"}>{value}</dd>
    </div>
  );
}

function RecordActions({ d }: { d: RecordDetail }) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const copy = useCopy();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const available = d.attachments.filter((a) => a.available);
  const canCopy = d.actions.includes("copy");
  const canDownload = d.actions.includes("download") && available.length > 0;
  const canMarkRead = d.actions.includes("mark-read") && d.unread;
  if (!canCopy && !canDownload && !canMarkRead) return null;

  const markRead = async () => {
    setBusy(true);
    try {
      await apiPost<MarkReadResponse>(`${projectApi(pid)}/records/mark-read`, { recordIds: [d.id] });
      qc.setQueryData<RecordDetail>(qk.record(pid, d.id), (old) => (old ? { ...old, unread: false } : old));
      applyInvalidation(qc, { projectId: pid, scopes: ["records", "projects", "navigation"], recordIds: [d.id] });
      toast("Marked as read");
    } catch (e) {
      toast(`Could not mark as read: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = async () => {
    setBusy(true);
    try {
      const name = await apiPostDownload(`${projectApi(pid)}/download/zip`, { recordIds: [d.id] }, `${d.id}.zip`);
      toast(`Downloaded ${name}`);
    } catch (e) {
      toast(`Download failed: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tools detail-actions">
      {canCopy && (
        <button type="button" className="btn btn-sm" onClick={() => void copy(recordPlainText(d), d.id)}>
          ⧉ Copy
        </button>
      )}
      {canDownload &&
        (available.length === 1 ? (
          <a className="btn btn-sm" href={available[0].url} download={available[0].fileName}>
            ↓ Download
          </a>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void downloadAll()}>
            ↓ Download all (.zip)
          </button>
        ))}
      {canMarkRead && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void markRead()}>
          ✓ Mark read
        </button>
      )}
    </div>
  );
}
