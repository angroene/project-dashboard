/**
 * Answer validation shared by the server (authoritative) and the UI (early feedback).
 * Every question is treated as a list of fields: non-composite schemas are one field with id "response".
 */
import type { AnswerSchema, AnswerValue, PlainFieldDef } from "./schemas.js";
import { OTHER_OPTION_ID, SINGLE_FIELD_ID } from "./constants.js";

export { OTHER_OPTION_ID };

export interface FieldSpec {
  id: string;
  label: string;
  help?: string;
  def: PlainFieldDef;
}

export interface FieldError {
  fieldId: string;
  message: string;
}

/** Info about an uploaded attachment, needed to check file fields. */
export interface UploadInfo {
  mimeType: string;
  questionId?: string;
  answerId?: string;
}

export function fieldsOf(schema: AnswerSchema): FieldSpec[] {
  if (schema.type === "composite") {
    return schema.fields.map((f) => {
      const { id, label, help, ...def } = f as typeof f & Record<string, unknown>;
      return { id, label, help, def: def as unknown as PlainFieldDef };
    });
  }
  return [{ id: SINGLE_FIELD_ID, label: "Response", def: schema }];
}

function isBlank(v: AnswerValue | undefined): boolean {
  if (!v) return true;
  switch (v.kind) {
    case "choice":
      return v.optionIds.length === 0 && !(v.otherText ?? "").trim();
    case "text":
      return !v.text.trim();
    case "approval":
      return false;
    case "files":
      return v.attachmentIds.length === 0;
  }
}


/**
 * Validate submitted values against a question's answer schema.
 * `uploads` resolves attachment ids for file fields; pass undefined on the client to skip that check.
 */
export function validateAnswer(
  schema: AnswerSchema,
  values: AnswerValue[],
  opts: { questionId?: string; uploads?: (id: string) => UploadInfo | undefined } = {},
): FieldError[] {
  const errors: FieldError[] = [];
  const fields = fieldsOf(schema);
  const known = new Set(fields.map((f) => f.id));
  const seen = new Set<string>();
  for (const v of values) {
    if (!known.has(v.fieldId)) errors.push({ fieldId: v.fieldId, message: "unknown field" });
    if (seen.has(v.fieldId)) errors.push({ fieldId: v.fieldId, message: "field answered twice" });
    seen.add(v.fieldId);
  }
  const usedAttachments = new Set<string>();

  for (const f of fields) {
    const v = values.find((x) => x.fieldId === f.id);
    const def = f.def;
    const required = def.required;
    const err = (message: string) => errors.push({ fieldId: f.id, message });

    if (isBlank(v)) {
      if (required) err("required");
      continue;
    }
    if (!v) continue;

    switch (def.type) {
      case "single-choice":
      case "multiple-choice": {
        if (v.kind !== "choice") { err("expected a choice"); break; }
        const ids = new Set(def.options.map((o) => o.id));
        const picked = v.optionIds;
        if (new Set(picked).size !== picked.length) err("duplicate option");
        for (const id of picked) {
          if (id === OTHER_OPTION_ID) continue;
          if (!ids.has(id)) err(`unknown option '${id}'`);
        }
        const usesOther = picked.includes(OTHER_OPTION_ID);
        if (usesOther && !def.allowOther) err("'Other' is not allowed");
        if (usesOther && !(v.otherText ?? "").trim()) err("describe the 'Other' choice");
        if (!usesOther && (v.otherText ?? "").trim()) err("otherText given without choosing 'Other'");
        if ((v.explanation ?? "").trim() && !def.allowExplanation) err("explanation not allowed");
        const count = picked.length;
        if (def.type === "single-choice") {
          if (count !== 1) err("choose exactly one option");
        } else {
          const max = def.maxSelected ?? def.options.length + (def.allowOther ? 1 : 0);
          if (count < def.minSelected) err(`choose at least ${def.minSelected}`);
          if (count > max) err(`choose at most ${max}`);
        }
        break;
      }
      case "free-text": {
        if (v.kind !== "text") { err("expected text"); break; }
        const len = v.text.trim().length;
        if (len < def.minLength) err(`at least ${def.minLength} characters`);
        if (v.text.length > def.maxLength) err(`at most ${def.maxLength} characters`);
        break;
      }
      case "approval": {
        if (v.kind !== "approval") { err("expected approve/reject"); break; }
        if ((v.rationale ?? "").trim() && !def.allowRationale) err("rationale not allowed");
        if (v.decision === "reject" && def.requireRationaleOnReject && !(v.rationale ?? "").trim()) err("give a reason for rejecting");
        break;
      }
      case "file-upload": {
        if (v.kind !== "files") { err("expected files"); break; }
        const n = v.attachmentIds.length;
        if (n < def.minFiles) err(`at least ${def.minFiles} file(s)`);
        if (n > def.maxFiles) err(`at most ${def.maxFiles} file(s)`);
        if ((v.comment ?? "").trim() && !def.allowComment) err("comment not allowed");
        for (const id of v.attachmentIds) {
          if (usedAttachments.has(id)) err(`attachment ${id} used twice`);
          usedAttachments.add(id);
          if (!opts.uploads) continue;
          const u = opts.uploads(id);
          if (!u) { err(`attachment ${id} not found`); continue; }
          if (u.answerId) err(`attachment ${id} already belongs to another answer`);
          if (u.questionId && opts.questionId && u.questionId !== opts.questionId) err(`attachment ${id} was uploaded for another question`);
          if (def.allowedMimeTypes && !def.allowedMimeTypes.includes(u.mimeType)) err(`file type ${u.mimeType} not allowed here`);
        }
        break;
      }
    }
  }
  return errors;
}

/**
 * The answer values a question's configured defaults would give, for pre-filling the form. Fields without a default
 * are left out. This is display data only: nothing is submitted until the user submits the form.
 */
export function defaultAnswers(schema: AnswerSchema): AnswerValue[] {
  const out: AnswerValue[] = [];
  for (const f of fieldsOf(schema)) {
    const d = f.def;
    if (d.type === "single-choice" && d.default !== undefined) out.push({ fieldId: f.id, kind: "choice", optionIds: [d.default] });
    else if (d.type === "multiple-choice" && d.default !== undefined) out.push({ fieldId: f.id, kind: "choice", optionIds: [...d.default] });
    else if (d.type === "free-text" && d.default !== undefined) out.push({ fieldId: f.id, kind: "text", text: d.default });
    else if (d.type === "approval" && d.default !== undefined) out.push({ fieldId: f.id, kind: "approval", decision: d.default });
  }
  return out;
}

/** Errors in configured defaults: each default must itself be a valid answer for its field. */
export function defaultErrors(schema: AnswerSchema): FieldError[] {
  const values = defaultAnswers(schema);
  const withDefault = new Set(values.map((v) => v.fieldId));
  // "required" errors for fields without a default are expected here and not about defaults.
  return validateAnswer(schema, values).filter((e) => withDefault.has(e.fieldId));
}
