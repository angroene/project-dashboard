/** Tracked field values: checks shared by the server (authoritative) and the UI. */
import type { TrackedFieldDef, TrackedFieldValue } from "./schemas.js";

export interface FieldValueError {
  fieldId: string;
  message: string;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Why `value` is not valid for `def`, or null. `null` always clears a field. */
export function fieldValueError(def: TrackedFieldDef, value: TrackedFieldValue): string | null {
  if (value === null) return null;
  switch (def.type) {
    case "checkbox":
    case "yes-no":
      return typeof value === "boolean" ? null : "expected true or false";
    case "choice":
      if (typeof value !== "string") return "expected an option id";
      return def.options?.some((o) => o.id === value) ? null : `unknown option '${value}'`;
    case "text":
      return typeof value === "string" ? null : "expected text";
    case "date":
      return typeof value === "string" && isDate(value) ? null : "expected a date as YYYY-MM-DD";
  }
}

/** Errors for a set of values against a card's field definitions (unknown ids included). */
export function fieldErrors(defs: readonly TrackedFieldDef[], values: Record<string, TrackedFieldValue>): FieldValueError[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: FieldValueError[] = [];
  for (const [id, v] of Object.entries(values)) {
    const def = byId.get(id);
    if (!def) { out.push({ fieldId: id, message: "this card has no such field" }); continue; }
    const e = fieldValueError(def, v);
    if (e) out.push({ fieldId: id, message: e });
  }
  return out;
}

/** Human-readable value for history notes and plain-text views. */
export function fieldValueText(def: TrackedFieldDef | undefined, value: TrackedFieldValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (def?.type === "checkbox" || def?.type === "yes-no") return value ? "yes" : "no";
  if (def?.type === "choice") return def.options?.find((o) => o.id === value)?.label ?? String(value);
  return String(value);
}
