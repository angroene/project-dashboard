import { useEffect, useId, useRef, type ReactNode } from "react";
import type { AttachmentRef, NavNode, ProgressSummary } from "../../shared/api";
import { errorMessage } from "../api/client";
import { formatAbsolute, formatBytes, formatPercent, formatRelative, type Tone } from "../format";

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, label, small }: { value: number; label: string; small?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`bar${small ? " bar-sm" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={formatPercent(v)}
    >
      <div className="fill" style={{ width: `${v}%` }} />
    </div>
  );
}

/** Published overall progress: "N%" with bar, or "Not reported" with no bar. */
export function ProgressSummaryView({ progress, name }: { progress: ProgressSummary; name: string }) {
  const label = progress.label || "Overall progress";
  const tip = [label, progress.method, progress.updatedAt ? `Updated ${formatAbsolute(progress.updatedAt)}` : ""].filter(Boolean).join(" · ");
  const pct = progress.overallPercent;
  return (
    <div className="progress-summary" title={tip}>
      <div className="meta">
        <span className="muted">{label}</span>
        <span className="progress-value">
          {progress.stale && <Pill tone="warn" title="The published progress is older than the project's freshness limit">Stale</Pill>}
          <strong>{pct == null ? "Not reported" : formatPercent(pct)}</strong>
        </span>
      </div>
      {pct != null && <ProgressBar value={pct} label={`${name}: ${label}`} />}
      <span className="sr-only">
        {progress.method ? `Method: ${progress.method}. ` : ""}
        {progress.updatedAt ? `Updated ${formatAbsolute(progress.updatedAt)}.` : ""}
      </span>
      {progress.updatedAt && (
        <span className="small muted" aria-hidden="true">
          Updated {formatRelative(progress.updatedAt)}
        </span>
      )}
    </div>
  );
}

export function TimeAgo({ iso }: { iso: string | undefined }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

export function NodeBadges({ counts }: { counts: NavNode["counts"] }) {
  return (
    <>
      {/* Leading separators keep accessible names readable ("Title, 2 need response, 1 unread"). */}
      {counts.awaitingResponse > 0 && (
        <>
          <span className="sr-only">, </span>
          <Pill tone="warn">
            <span className="sr-only">{counts.awaitingResponse} need response</span>
            <span aria-hidden="true">{counts.awaitingResponse} to answer</span>
          </Pill>
        </>
      )}
      {counts.unread > 0 && (
        <>
          <span className="sr-only">, </span>
          <Pill tone="info">{counts.unread} unread</Pill>
        </>
      )}
    </>
  );
}

export function UnreadDot({ label = "Unread" }: { label?: string }) {
  return <span className="unread-dot" role="img" aria-label={label} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading muted" role="status">
      {label}
    </p>
  );
}

export function ErrorNote({ error, onRetry, prefix }: { error: unknown; onRetry?: () => void; prefix?: string }) {
  return (
    <div className="notice notice-error" role="alert">
      <span>
        {prefix ? `${prefix}: ` : ""}
        {errorMessage(error)}
      </span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Raster images the server serves inline; shown as previews. SVG is excluded: it is served sandboxed, not as a picture. */
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function AttachmentList({ items }: { items: AttachmentRef[] }) {
  return (
    <ul role="list" className="file-list">
      {items.map((a) =>
        a.available ? (
          <li key={a.id}>
            {PREVIEW_TYPES.has(a.mimeType) && (
              <a className="attachment-preview" href={a.url} target="_blank" rel="noopener noreferrer" title="Open full size">
                <img src={a.url} alt={a.title || a.fileName} loading="lazy" />
              </a>
            )}
            <a href={a.url} download={a.fileName}>
              ↓ {a.title || a.fileName}
            </a>{" "}
            <span className="small muted">
              {a.title && a.title !== a.fileName ? `${a.fileName} · ` : ""}
              {formatBytes(a.bytes)}
            </span>
          </li>
        ) : (
          <li key={a.id} className="unavailable" aria-disabled="true">
            <span>{a.title || a.fileName}</span> <span className="small">· unavailable (file missing or not permitted)</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Native modal <dialog>: focus trapping, Escape and inert background come from the browser. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " modal-wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn ghost btn-icon" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
