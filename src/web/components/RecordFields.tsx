import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RecordDetail, UploadResponse, UserRecordUpdate } from "../../shared/api";
import type { ExternalRef, TrackedFieldDef, TrackedFieldValue } from "../../shared/schemas";
import { fieldValueText } from "../../shared/fields";
import { ApiRequestError, apiPost, enc, errorMessage, projectApi, uploadMultipart } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject } from "../context";
import { formatAbsolute } from "../format";
import { useToast } from "./Toasts";

/**
 * Revision written by this page's own last save, per record, while the loaded detail still shows the revision it
 * started from. Lets quick successive saves chain without a false conflict; any other change still conflicts.
 */
const ownWrites = new Map<string, { seen: string; next: string }>();

/** Sends one user update with the record's revision; a concurrent change makes it fail instead of overwriting. */
function useUserUpdate(d: RecordDetail) {
  const { pid } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  return async (update: UserRecordUpdate, okMessage: string): Promise<boolean> => {
    const key = `${pid}/${d.id}`;
    const own = ownWrites.get(key);
    const ifRevision = own && own.seen === d.revision ? own.next : d.revision;
    try {
      const res = await apiPost<{ revision: string }>(`${projectApi(pid)}/records/${enc(d.id)}/user-update`, { ...update, ifRevision });
      ownWrites.set(key, { seen: d.revision, next: res.revision });
      toast(okMessage);
      return true;
    } catch (e) {
      if (e instanceof ApiRequestError && e.body.error === "revision-mismatch") {
        toast("This record changed meanwhile; it was reloaded. Check it and try again.", "error");
      } else {
        toast(`Could not save: ${errorMessage(e)}`, "error");
      }
      return false;
    } finally {
      applyInvalidation(qc, { projectId: pid, scopes: ["records", "navigation"], recordIds: [d.id] });
    }
  };
}

/** The card's tracked fields: editable when the dashboard user may change them, read-only otherwise. */
export function TrackedFields({ d }: { d: RecordDetail }) {
  const save = useUserUpdate(d);
  const [busy, setBusy] = useState<string | null>(null);
  // The value just chosen, shown until the reloaded record (new revision) confirms it or the save fails.
  const [local, setLocal] = useState<Record<string, TrackedFieldValue>>({});
  const [localFor, setLocalFor] = useState(d.revision);
  if (localFor !== d.revision) {
    setLocalFor(d.revision);
    setLocal({});
  }
  if (!d.fieldDefs.length) return null;
  const values = { ...(d.fields ?? {}), ...local };
  const change = async (def: TrackedFieldDef, v: TrackedFieldValue) => {
    setBusy(def.id);
    setLocal((l) => ({ ...l, [def.id]: v }));
    const ok = await save({ fields: { [def.id]: v } }, `${def.label} saved`);
    if (!ok) setLocal((l) => { const { [def.id]: _drop, ...rest } = l; return rest; });
    setBusy(null);
  };
  return (
    <div className="detail-block tracked-fields">
      <h4>Fields</h4>
      <dl className="meta-table">
        {d.fieldDefs.map((def) => (
          <FieldRow key={def.id} def={def} value={values[def.id] ?? null} busy={busy === def.id} onChange={(v) => void change(def, v)} />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({ def, value, busy, onChange }: { def: TrackedFieldDef; value: TrackedFieldValue; busy: boolean; onChange: (v: TrackedFieldValue) => void }) {
  const id = useId();
  const editable = def.editableBy.includes("user");
  const help = def.help ? <span className="small muted"> {def.help}</span> : null;
  if (!editable) {
    return (
      <div className="meta-pair">
        <dt>{def.label}</dt>
        <dd>
          {fieldValueText(def, value)}
          <span className="small muted"> (set by agents)</span>
        </dd>
      </div>
    );
  }
  let control;
  switch (def.type) {
    case "checkbox":
      control = <input id={id} type="checkbox" checked={value === true} disabled={busy} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "choice":
      control = (
        <select id={id} className="input select" value={typeof value === "string" ? value : ""} disabled={busy} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {def.options!.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      );
      break;
    case "date":
      control = <input id={id} className="input" type="date" value={typeof value === "string" ? value : ""} disabled={busy} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "text":
      control = <TextField id={id} value={typeof value === "string" ? value : ""} disabled={busy} onSave={(t) => onChange(t.trim() ? t : null)} />;
      break;
  }
  return (
    <div className="meta-pair">
      <dt><label htmlFor={id}>{def.label}</label></dt>
      <dd>{control}{help}</dd>
    </div>
  );
}

function TextField({ id, value, disabled, onSave }: { id: string; value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <span className="inline-edit">
      <input id={id} className="input" type="text" maxLength={2000} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} />
      {text !== value && (
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onSave(text)}>Save</button>
      )}
    </span>
  );
}

/** Work items in other systems. Status is shown as reported by that system, never as the dashboard's own state. */
export function ExternalRefs({ items }: { items: ExternalRef[] }) {
  if (!items.length) return null;
  return (
    <div className="detail-block">
      <h4>External references</h4>
      <ul role="list" className="link-list external-refs">
        {items.map((x, i) => (
          <li key={`${x.system}:${x.id}:${i}`}>
            <span className="pill">{x.system}</span>{" "}
            {x.url ? (
              <a href={x.url} target="_blank" rel="noopener noreferrer"><span className="mono">{x.id}</span></a>
            ) : (
              <span className="mono">{x.id}</span>
            )}
            {x.title && <span> · {x.title}</span>}
            {x.ref && <span className="small muted"> · <span className="mono">{x.ref}</span></span>}
            {x.status && (
              <span className="small muted">
                {" "}· {x.system} reports <strong>{x.status}</strong>{x.statusAt ? ` (${formatAbsolute(x.statusAt)})` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Add a comment and/or files to the record; both land in its history. */
export function CommentBox({ d }: { d: RecordDetail }) {
  const { pid } = useProject();
  const save = useUserUpdate(d);
  const toast = useToast();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!d.canComment) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const files = [...(fileRef.current?.files ?? [])];
    if (!text.trim() && !files.length) return;
    setBusy(true);
    try {
      let attach: UserRecordUpdate["attach"];
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append("file", f, f.name);
        const up = await uploadMultipart<UploadResponse>(`${projectApi(pid)}/uploads`, form);
        attach = up.attachments.map((a) => ({ uploadId: a.attachmentId, title: a.originalName }));
      }
      const ok = await save({ ...(text.trim() ? { comment: text.trim() } : {}), ...(attach ? { attach } : {}) }, files.length ? "Comment and files added" : "Comment added");
      if (ok) {
        setText("");
        if (fileRef.current) fileRef.current.value = "";
      }
    } catch (err) {
      toast(`Upload failed: ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="detail-block comment-box" onSubmit={(e) => void submit(e)}>
      <label htmlFor={id}><h4>Add a comment</h4></label>
      <textarea id={id} className="input" rows={2} maxLength={2000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      <div className="comment-actions">
        <input ref={fileRef} type="file" multiple disabled={busy} aria-label="Attach files" />
        <button type="submit" className="btn btn-sm" disabled={busy}>{busy ? "Saving…" : "Add"}</button>
      </div>
    </form>
  );
}
