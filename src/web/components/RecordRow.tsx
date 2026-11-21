import { landedByReload } from "../routes";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { RecordSummary } from "../../shared/api";
import type { TrackedFieldDef, TrackedFieldValue } from "../../shared/schemas";
import { fieldValueText } from "../../shared/fields";
import { prefersReducedMotion } from "../context";
import { humanize, uiStateInfo } from "../format";
import { Pill, ProgressBar, TimeAgo, UnreadDot } from "./common";
import { RecordDetailView } from "./RecordDetail";
import { ChoiceButtons, useQuickFieldSave } from "./RecordFields";

interface Props {
  summary: RecordSummary;
  selectable: boolean;
  selected: boolean;
  onSelect: (r: RecordSummary, on: boolean) => void;
  focused?: boolean;
  /** The card's tracked fields; set values are listed under the title. */
  fieldDefs?: TrackedFieldDef[];
  /** Also answer user-editable choice fields from the row, as buttons (pinned cards). Yes / No always is. */
  quickChoices?: boolean;
}

const NO_FIELDS: TrackedFieldDef[] = [];

/**
 * Fields the user may change that are answered from the row itself, without opening the record: Yes / No always,
 * choice fields when the row asks for it (pinned cards).
 */
const quickEdit = (choices: boolean) => (d: TrackedFieldDef) =>
  d.editableBy.includes("user") && (d.type === "yes-no" || (choices && d.type === "choice" && !!d.options?.length));

function QuickField({ recordId, title, def, value }: { recordId: string; title: string; def: TrackedFieldDef; value: TrackedFieldValue }) {
  const save = useQuickFieldSave(recordId);
  // The tapped value is shown until the reloaded list brings a different stored value (or the save fails).
  const [tap, setTap] = useState<{ v: boolean | string; base: TrackedFieldValue; saving: boolean } | null>(null);
  const id = useId();
  if (tap && !tap.saving && value !== tap.base) setTap(null);
  return (
    <div className="record-yes-no">
      <span className="label" aria-hidden="true">{def.label}</span>
      <ChoiceButtons
        id={id}
        label={`${def.label}: ${title}`}
        options={def.type === "yes-no" ? [{ value: true, label: "Yes" }, { value: false, label: "No" }] : (def.options ?? []).map((o) => ({ value: o.id, label: o.label }))}
        value={tap ? tap.v : value}
        busy={!!tap?.saving}
        onChange={(v) => {
          setTap({ v, base: value, saving: true });
          void save(def, v).then((ok) => setTap(ok ? { v, base: value, saving: false } : null));
        }}
      />
    </div>
  );
}

/** One record row. Memoized: selecting or refetching one row does not re-render the others. Detail loads only when expanded. */
export const RecordRow = memo(function RecordRow({ summary: r, selectable, selected, onSelect, focused, fieldDefs = NO_FIELDS, quickChoices = false }: Props) {
  const quick = quickEdit(quickChoices);
  const [expanded, setExpanded] = useState(!!focused);
  const ref = useRef<HTMLLIElement>(null);
  const detailId = useId();
  // Becoming the focused record expands the row (state adjusted during render, not in an effect).
  const [wasFocused, setWasFocused] = useState(!!focused);
  if (!!focused !== wasFocused) {
    setWasFocused(!!focused);
    if (focused) setExpanded(true);
  }
  useEffect(() => {
    if (!focused || landedByReload()) return;
    const raf = requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
    return () => cancelAnimationFrame(raf);
  }, [focused]);

  const ui = r.question ? uiStateInfo(r.question.uiState) : null;
  return (
    <li ref={ref} data-record-id={r.id} className={`record${r.unread ? " unread" : ""}${expanded ? " expanded" : ""}${focused ? " focused" : ""}`}>
      <div className="record-head">
        {selectable && (
          <label className="check">
            <input type="checkbox" checked={selected} onChange={(e) => onSelect(r, e.target.checked)} />
            <span className="sr-only">Select {r.title}</span>
          </label>
        )}
        <button type="button" className="record-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((x) => !x)}>
          <span className="record-title">
            {r.unread && <UnreadDot />}
            <span>{r.title}</span>
          </span>
          <span className="record-pills">
            {ui && <Pill tone={ui.tone}>{ui.label}</Pill>}
            {(!ui || ui.label.toLowerCase() !== (r.statusLabel || humanize(r.status)).toLowerCase()) && (
              <Pill tone={r.statusTone}>{r.statusLabel || humanize(r.status)}</Pill>
            )}
            {r.priority && r.priority !== "none" && <Pill tone={r.priority === "critical" || r.priority === "high" ? "warn" : "neutral"}>{humanize(r.priority)}</Pill>}
            <span className={`chevron${expanded ? " open" : ""}`} aria-hidden="true">
              ▾
            </span>
          </span>
        </button>
      </div>
      <div className="record-sub small muted">
        <span className="mono">{r.id}</span>
        <span>
          {" "}
          · updated <TimeAgo iso={r.updatedAt} />
        </span>
        {r.attachmentCount > 0 && (
          <span>
            {" "}
            · {r.attachmentCount} {r.attachmentCount === 1 ? "attachment" : "attachments"}
          </span>
        )}
        {fieldDefs.filter((d) => r.fields?.[d.id] != null && r.fields[d.id] !== "" && !quick(d)).map((d) => (
          <span key={d.id} className="record-field">
            {" "}
            · {d.label}: {fieldValueText(d, r.fields![d.id])}
          </span>
        ))}
        {r.external && r.external.length > 0 && (
          <span>
            {" "}
            · {r.external.map((x) => `${x.system} ${x.id}${x.status ? ` (${x.system} reports ${x.status})` : ""}`).join(", ")}
          </span>
        )}
        {r.question?.dueAt && (
          <span>
            {" "}
            · due <TimeAgo iso={r.question.dueAt} />
          </span>
        )}
      </div>
      {fieldDefs.filter(quick).map((d) => (
        <QuickField key={d.id} recordId={r.id} title={r.title} def={d} value={r.fields?.[d.id] ?? null} />
      ))}
      {r.summary && <p className={`record-summary${expanded ? "" : " clamp"}`}>{r.summary}</p>}
      {r.percent != null && (
        <div className="record-percent">
          <ProgressBar value={r.percent} label={`${r.title} progress`} small />
          <span className="small">{Math.round(r.percent)}%</span>
        </div>
      )}
      <div id={detailId} hidden={!expanded}>
        {expanded && <RecordDetailView id={r.id} />}
      </div>
    </li>
  );
});
