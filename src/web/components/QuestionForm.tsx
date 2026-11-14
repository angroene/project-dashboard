import { useCallback, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RecordDetail, SessionInfo, SubmitAnswerResponse, UploadResponse } from "../../shared/api";
import type { AnswerValue, PlainFieldDef } from "../../shared/schemas";
import { fieldsOf, OTHER_OPTION_ID, validateAnswer, type FieldSpec } from "../../shared/validate";
import { ApiRequestError, enc, errorMessage, apiPost, newIdempotencyKey, projectApi, uploadMultipart } from "../api/client";
import { applyInvalidation } from "../api/sse";
import { useProject, useSession } from "../context";
import { formatAbsolute, formatBytes, PROCESSING } from "../format";
import { AttachmentList, Pill, ProgressBar } from "./common";
import { useToast } from "./Toasts";

type ChoiceDef = Extract<PlainFieldDef, { type: "single-choice" | "multiple-choice" }>;
type TextDef = Extract<PlainFieldDef, { type: "free-text" }>;
type ApprovalDef = Extract<PlainFieldDef, { type: "approval" }>;
type FileDef = Extract<PlainFieldDef, { type: "file-upload" }>;

interface FileItem {
  uid: string;
  file: File;
  progress: number | null;
  attachmentId?: string;
  error?: string;
}

type FieldState =
  | { kind: "choice"; optionIds: string[]; otherText: string; explanation: string }
  | { kind: "text"; text: string }
  | { kind: "approval"; decision: "" | "approve" | "reject"; rationale: string }
  | { kind: "files"; files: FileItem[]; comment: string };

function initialState(def: PlainFieldDef): FieldState {
  switch (def.type) {
    case "single-choice":
    case "multiple-choice":
      return { kind: "choice", optionIds: [], otherText: "", explanation: "" };
    case "free-text":
      return { kind: "text", text: "" };
    case "approval":
      return { kind: "approval", decision: "", rationale: "" };
    case "file-upload":
      return { kind: "files", files: [], comment: "" };
  }
}

/** Builds the answer value for one field; undefined when the field was left empty. */
function toValue(fieldId: string, s: FieldState, attachmentIdOf: (f: FileItem) => string): AnswerValue | undefined {
  switch (s.kind) {
    case "choice": {
      const usesOther = s.optionIds.includes(OTHER_OPTION_ID);
      const explanation = s.explanation.trim() ? s.explanation : undefined;
      if (s.optionIds.length === 0 && !explanation) return undefined;
      return { fieldId, kind: "choice", optionIds: s.optionIds, otherText: usesOther ? s.otherText : undefined, explanation };
    }
    case "text":
      return s.text.trim() ? { fieldId, kind: "text", text: s.text } : undefined;
    case "approval":
      return s.decision ? { fieldId, kind: "approval", decision: s.decision, rationale: s.rationale.trim() ? s.rationale : undefined } : undefined;
    case "files": {
      const comment = s.comment.trim() ? s.comment : undefined;
      if (s.files.length === 0 && !comment) return undefined;
      return { fieldId, kind: "files", attachmentIds: s.files.map(attachmentIdOf), comment };
    }
  }
}

function allowedTypes(def: FileDef, session: SessionInfo): string[] {
  return def.allowedMimeTypes && def.allowedMimeTypes.length > 0 ? def.allowedMimeTypes : session.uploadLimits.allowedMimeTypes;
}

function fileProblem(file: File, def: FileDef, session: SessionInfo): string | null {
  if (file.size > session.uploadLimits.maxBytes) return `${file.name} is too large (${formatBytes(file.size)}, max ${formatBytes(session.uploadLimits.maxBytes)})`;
  const types = allowedTypes(def, session);
  // Browsers report "" for some types (e.g. .md); the server makes the final call on those.
  if (file.type && types.length > 0 && !types.includes(file.type)) return `${file.name}: file type ${file.type} is not allowed`;
  return null;
}

let uidCounter = 0;

export function QuestionForm({ detail }: { detail: RecordDetail }) {
  const { pid } = useProject();
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const schema = detail.answerSchema!;
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const formId = useId();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [state, setState] = useState<Record<string, FieldState>>(() => Object.fromEntries(fields.map((f) => [f.id, initialState(f.def)])));
  const uploaded = useRef(new Map<string, string>());
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ at: string; res: SubmitAnswerResponse } | null>(null);

  const setField = useCallback((fieldId: string, next: FieldState) => setState((prev) => ({ ...prev, [fieldId]: next })), []);
  const patchFile = useCallback((fieldId: string, uid: string, patch: Partial<FileItem>) => {
    setState((prev) => {
      const s = prev[fieldId];
      if (s?.kind !== "files") return prev;
      return { ...prev, [fieldId]: { ...s, files: s.files.map((f) => (f.uid === uid ? { ...f, ...patch } : f)) } };
    });
  }, []);

  const idBase = (fieldId: string) => `${formId}-${fieldId}`;

  const buildValues = (st: Record<string, FieldState>, idOf: (f: FileItem) => string): AnswerValue[] =>
    fields.map((f) => toValue(f.id, st[f.id], idOf)).filter((v): v is AnswerValue => v !== undefined);

  const focusField = (fieldId: string) => {
    const el = document.getElementById(idBase(fieldId));
    el?.querySelector<HTMLElement>("input:not([type=hidden]),textarea,select,button")?.focus();
  };

  const showErrors = (list: { fieldId: string; message: string }[]) => {
    const map: Record<string, string[]> = {};
    for (const e of list) (map[e.fieldId] ??= []).push(e.message);
    setErrors(map);
    const firstField = fields.find((f) => map[f.id]);
    if (firstField) focusField(firstField.id);
    const unknown = list.filter((e) => !fields.some((f) => f.id === e.fieldId));
    if (unknown.length) setGeneral(unknown.map((e) => `${e.fieldId}: ${e.message}`).join("; "));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || done) return;
    setGeneral(null);
    // The form state at submit time; upload progress updates do not change which files or values are sent.
    const st = state;
    const pre = buildValues(st, (f) => uploaded.current.get(f.uid) ?? `pending-${f.uid}`);
    const problems = validateAnswer(schema, pre);
    for (const f of fields) {
      const s = st[f.id];
      if (s.kind !== "files" || f.def.type !== "file-upload") continue;
      for (const item of s.files) {
        const p = fileProblem(item.file, f.def, session);
        if (p) problems.push({ fieldId: f.id, message: p });
      }
    }
    if (problems.length > 0) {
      showErrors(problems);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      for (const f of fields) {
        const s = st[f.id];
        if (s.kind !== "files") continue;
        for (const item of s.files) {
          if (uploaded.current.has(item.uid)) continue;
          patchFile(f.id, item.uid, { progress: 0, error: undefined });
          const form = new FormData();
          form.append("questionId", detail.id); // must precede the file part
          form.append("file", item.file, item.file.name);
          try {
            const res = await uploadMultipart<UploadResponse>(`${projectApi(pid)}/uploads`, form, (p) => patchFile(f.id, item.uid, { progress: p }));
            const att = res?.attachments?.[0];
            if (!att) throw new Error(`The server returned no attachment for ${item.file.name}`);
            uploaded.current.set(item.uid, att.attachmentId);
            patchFile(f.id, item.uid, { progress: 1, attachmentId: att.attachmentId });
          } catch (err) {
            patchFile(f.id, item.uid, { progress: null, error: errorMessage(err) });
            setErrors({ [f.id]: [`Upload failed for ${item.file.name}: ${errorMessage(err)}`] });
            focusField(f.id);
            return;
          }
        }
      }
      const answers = buildValues(st, (f) => uploaded.current.get(f.uid) ?? "");
      const res = await apiPost<SubmitAnswerResponse>(`${projectApi(pid)}/questions/${enc(detail.id)}/answers`, {
        questionRevision: detail.question?.revision ?? 1,
        answers,
        idempotencyKey,
      });
      setDone({ at: new Date().toISOString(), res });
      toast(`Answer to ${detail.id} submitted · awaiting pickup`);
      applyInvalidation(qc, { projectId: pid, scopes: ["answers", "projects", "navigation"], recordIds: [detail.id] });
    } catch (err) {
      if (err instanceof ApiRequestError && err.fieldErrors.length > 0) showErrors(err.fieldErrors);
      setGeneral(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="notice notice-info" role="status">
        <strong>Submitted · Awaiting pickup</strong> — {formatAbsolute(done.at)}. The project has not processed this answer yet.
      </div>
    );
  }

  const composite = schema.type === "composite";
  return (
    <form className="question-form" onSubmit={(e) => void submit(e)} noValidate aria-label={`Answer ${detail.title}`}>
      {fields.map((f) => (
        <FieldBlock key={f.id} spec={f} idBase={idBase(f.id)} errors={errors[f.id]} composite={composite}>
          <FieldControl
            spec={f}
            idBase={idBase(f.id)}
            state={state[f.id]}
            set={(next) => setField(f.id, next)}
            disabled={submitting}
            session={session}
            hasError={!!errors[f.id]}
          />
        </FieldBlock>
      ))}
      {general && (
        <p className="field-error" role="alert">
          {general}
        </p>
      )}
      <div className="tools">
        <button type="submit" className="btn primary" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit response"}
        </button>
      </div>
    </form>
  );
}

function FieldBlock({ spec, idBase, errors, composite, children }: { spec: FieldSpec; idBase: string; errors?: string[]; composite: boolean; children: ReactNode }) {
  const required = spec.def.required;
  return (
    <fieldset id={idBase} className={`field${errors ? " has-error" : ""}`} aria-describedby={[spec.help ? `${idBase}-help` : "", errors ? `${idBase}-err` : ""].filter(Boolean).join(" ") || undefined}>
      <legend className="field-label">
        {composite ? spec.label : "Your response"}
        {required ? <span className="muted"> (required)</span> : <span className="muted"> (optional)</span>}
      </legend>
      {spec.help && (
        <p id={`${idBase}-help`} className="small muted">
          {spec.help}
        </p>
      )}
      {children}
      {errors && (
        <ul id={`${idBase}-err`} className="field-error" role="list">
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

interface ControlProps {
  spec: FieldSpec;
  idBase: string;
  state: FieldState;
  set: (s: FieldState) => void;
  disabled: boolean;
  session: SessionInfo;
  hasError: boolean;
}

function FieldControl(p: ControlProps) {
  const { def } = p.spec;
  const s = p.state;
  switch (def.type) {
    case "single-choice":
    case "multiple-choice":
      return s.kind === "choice" ? <ChoiceControl {...p} def={def} s={s} /> : null;
    case "free-text":
      return s.kind === "text" ? <TextControl {...p} def={def} s={s} /> : null;
    case "approval":
      return s.kind === "approval" ? <ApprovalControl {...p} def={def} s={s} /> : null;
    case "file-upload":
      return s.kind === "files" ? <FileControl {...p} def={def} s={s} /> : null;
  }
}

function ChoiceControl({ idBase, set, disabled, hasError, def, s }: ControlProps & { def: ChoiceDef; s: Extract<FieldState, { kind: "choice" }> }) {
  const multi = def.type === "multiple-choice";
  const toggle = (id: string, checked: boolean) =>
    set({ ...s, optionIds: multi ? (checked ? [...s.optionIds, id] : s.optionIds.filter((x) => x !== id)) : [id] });
  const usesOther = s.optionIds.includes(OTHER_OPTION_ID);
  return (
    <>
      {multi && def.maxSelected != null && <p className="small muted">Choose up to {def.maxSelected}.</p>}
      {def.options.map((o) => (
        <label className="choice" key={o.id}>
          <input
            type={multi ? "checkbox" : "radio"}
            name={idBase}
            value={o.id}
            checked={s.optionIds.includes(o.id)}
            onChange={(e) => toggle(o.id, e.target.checked)}
            disabled={disabled}
            aria-invalid={hasError || undefined}
          />
          <span>
            {o.label}
            {o.description && <span className="choice-desc">{o.description}</span>}
          </span>
        </label>
      ))}
      {def.allowOther && (
        <>
          <label className="choice">
            <input
              type={multi ? "checkbox" : "radio"}
              name={idBase}
              value={OTHER_OPTION_ID}
              checked={usesOther}
              onChange={(e) => toggle(OTHER_OPTION_ID, e.target.checked)}
              disabled={disabled}
            />
            <span>Other</span>
          </label>
          {usesOther && (
            <>
              <label className="sr-only" htmlFor={`${idBase}-other`}>
                Describe your other choice
              </label>
              <input
                id={`${idBase}-other`}
                className="input"
                placeholder="Describe your other choice"
                value={s.otherText}
                maxLength={5000}
                onChange={(e) => set({ ...s, otherText: e.target.value })}
                disabled={disabled}
              />
            </>
          )}
        </>
      )}
      {def.allowExplanation && (
        <>
          <label className="field-sublabel" htmlFor={`${idBase}-expl`}>
            Explanation (optional)
          </label>
          <textarea
            id={`${idBase}-expl`}
            className="input"
            rows={3}
            maxLength={5000}
            value={s.explanation}
            onChange={(e) => set({ ...s, explanation: e.target.value })}
            disabled={disabled}
          />
        </>
      )}
    </>
  );
}

function TextControl({ spec, idBase, set, disabled, hasError, def, s }: ControlProps & { def: TextDef; s: Extract<FieldState, { kind: "text" }> }) {
  const common = {
    id: `${idBase}-text`,
    className: "input",
    value: s.text,
    maxLength: def.maxLength,
    placeholder: def.placeholder,
    disabled,
    "aria-invalid": hasError || undefined,
    "aria-describedby": `${idBase}-count`,
  };
  return (
    <>
      <label className="sr-only" htmlFor={`${idBase}-text`}>
        {spec.label}
      </label>
      {def.multiline ? (
        <textarea {...common} rows={4} onChange={(e) => set({ ...s, text: e.target.value })} />
      ) : (
        <input {...common} type="text" onChange={(e) => set({ ...s, text: e.target.value })} />
      )}
      <p id={`${idBase}-count`} className="small muted counter">
        {s.text.length} / {def.maxLength} characters{def.minLength > 1 ? ` (minimum ${def.minLength})` : ""}
      </p>
    </>
  );
}

function ApprovalControl({ idBase, set, disabled, hasError, def, s }: ControlProps & { def: ApprovalDef; s: Extract<FieldState, { kind: "approval" }> }) {
  return (
    <>
      <div className="switch">
        {(["approve", "reject"] as const).map((d) => (
          <label className="choice" key={d}>
            <input type="radio" name={idBase} value={d} checked={s.decision === d} onChange={() => set({ ...s, decision: d })} disabled={disabled} aria-invalid={hasError || undefined} />
            <span>{d === "approve" ? "Approve" : "Reject"}</span>
          </label>
        ))}
      </div>
      {def.allowRationale && (
        <>
          <label className="field-sublabel" htmlFor={`${idBase}-rationale`}>
            Rationale {def.requireRationaleOnReject ? "(required when rejecting)" : "(optional)"}
          </label>
          <textarea
            id={`${idBase}-rationale`}
            className="input"
            rows={3}
            maxLength={5000}
            value={s.rationale}
            onChange={(e) => set({ ...s, rationale: e.target.value })}
            disabled={disabled}
          />
        </>
      )}
    </>
  );
}

function FileControl({ idBase, set, disabled, session, def, s }: ControlProps & { def: FileDef; s: Extract<FieldState, { kind: "files" }> }) {
  const max = Math.min(def.maxFiles, session.uploadLimits.maxFiles);
  const types = allowedTypes(def, session);
  const [notice, setNotice] = useState<string | null>(null);
  const add = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const room = Math.max(0, max - s.files.length);
    const accepted = incoming.slice(0, room).map((file): FileItem => ({ uid: `f${++uidCounter}`, file, progress: null }));
    setNotice(incoming.length > room ? `Only ${max} ${max === 1 ? "file is" : "files are"} allowed; ${incoming.length - room} not added.` : null);
    set({ ...s, files: [...s.files, ...accepted] });
  };
  const remove = (uid: string) => set({ ...s, files: s.files.filter((f) => f.uid !== uid) });
  return (
    <>
      <label className="btn upload" htmlFor={`${idBase}-file`}>
        ↑ Choose {max === 1 ? "file" : "files"}
      </label>
      <input
        id={`${idBase}-file`}
        className="file-input"
        type="file"
        multiple={max > 1}
        accept={types.length ? types.join(",") : undefined}
        disabled={disabled || s.files.length >= max}
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="small muted">
        Up to {max} {max === 1 ? "file" : "files"}, max {formatBytes(session.uploadLimits.maxBytes)} each.
      </p>
      {notice && (
        <p className="small field-error" role="status">
          {notice}
        </p>
      )}
      {s.files.length > 0 ? (
        <ul className="file-list" role="list">
          {s.files.map((f) => {
            const problem = fileProblem(f.file, def, session);
            return (
              <li key={f.uid} className="file-item">
                <span className="break">
                  {f.file.name} <span className="small muted">· {formatBytes(f.file.size)}</span>
                </span>
                {f.attachmentId ? (
                  <Pill tone="ok">Uploaded</Pill>
                ) : f.progress != null ? (
                  <ProgressBar value={f.progress * 100} label={`Uploading ${f.file.name}`} small />
                ) : null}
                {(problem || f.error) && <span className="small field-error">{f.error ?? problem}</span>}
                <button type="button" className="btn btn-sm ghost" onClick={() => remove(f.uid)} disabled={disabled}>
                  Remove<span className="sr-only"> {f.file.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="small muted">No files selected.</p>
      )}
      {def.allowComment && (
        <>
          <label className="field-sublabel" htmlFor={`${idBase}-comment`}>
            Comment (optional)
          </label>
          <textarea
            id={`${idBase}-comment`}
            className="input"
            rows={3}
            maxLength={5000}
            value={s.comment}
            onChange={(e) => set({ ...s, comment: e.target.value })}
            disabled={disabled}
          />
        </>
      )}
    </>
  );
}

/** Read-only view of an answer already submitted for this question. */
export function SubmittedAnswerView({ detail }: { detail: RecordDetail }) {
  const a = detail.submittedAnswer!;
  const fields = detail.answerSchema ? fieldsOf(detail.answerSchema) : [];
  const composite = detail.answerSchema?.type === "composite";
  const state = PROCESSING[a.processingState] ?? { label: a.processingState, tone: "neutral" as const };
  return (
    <div className="answer-view">
      <div className="row">
        <h4>Your submitted answer</h4>
        <Pill tone={state.tone}>{state.label}</Pill>
      </div>
      <p className="small muted">
        Submitted {formatAbsolute(a.submittedAt)} via {a.source === "excel-import" ? "Excel import" : "the dashboard"}
        {a.processingState === "pending" ? " · not yet picked up by the project" : ""}
      </p>
      <dl className="answer-list">
        {a.answers.map((v, i) => {
          const spec = fields.find((f) => f.id === v.fieldId);
          return (
            <div key={i} className="meta-pair">
              <dt>{composite ? (spec?.label ?? v.fieldId) : "Response"}</dt>
              <dd>
                <AnswerText value={v} def={spec?.def} />
              </dd>
            </div>
          );
        })}
      </dl>
      {a.attachments.length > 0 && <AttachmentList items={a.attachments} />}
      {a.resultNote && (
        <p className="notice">
          <strong>{a.processingState === "failed" ? "Failure reason" : "Result note"}:</strong> {a.resultNote}
        </p>
      )}
    </div>
  );
}

function AnswerText({ value: v, def }: { value: AnswerValue; def?: PlainFieldDef }) {
  switch (v.kind) {
    case "choice": {
      const labels = v.optionIds.map((id) => {
        if (id === OTHER_OPTION_ID) return `Other: ${v.otherText ?? ""}`;
        const opt = def && (def.type === "single-choice" || def.type === "multiple-choice") ? def.options.find((o) => o.id === id) : undefined;
        return opt?.label ?? id;
      });
      return (
        <>
          <span>{labels.join(", ") || "—"}</span>
          {v.explanation && <span className="answer-extra">Explanation: {v.explanation}</span>}
        </>
      );
    }
    case "text":
      return <span className="pre-wrap">{v.text}</span>;
    case "approval":
      return (
        <>
          <span>{v.decision === "approve" ? "Approved" : "Rejected"}</span>
          {v.rationale && <span className="answer-extra">Rationale: {v.rationale}</span>}
        </>
      );
    case "files":
      return (
        <>
          <span>
            {v.attachmentIds.length} {v.attachmentIds.length === 1 ? "file" : "files"}
          </span>
          {v.comment && <span className="answer-extra">Comment: {v.comment}</span>}
        </>
      );
  }
}
