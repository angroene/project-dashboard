// @vitest-environment node
/** Pure answer validation shared by the server and the UI. */
import { describe, expect, it } from "vitest";
import { fieldsOf, validateAnswer } from "../../src/shared/validate.js";
import type { AnswerSchema, AnswerValue } from "../../src/shared/schemas.js";

const single: AnswerSchema = {
  type: "single-choice",
  options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  allowOther: false,
  allowExplanation: false,
  required: true,
};
const choice = (optionIds: string[], extra: Partial<Extract<AnswerValue, { kind: "choice" }>> = {}): AnswerValue => ({ fieldId: "response", kind: "choice", optionIds, ...extra });
const msgs = (schema: AnswerSchema, values: AnswerValue[], opts?: Parameters<typeof validateAnswer>[2]) => validateAnswer(schema, values, opts).map((e) => `${e.fieldId}: ${e.message}`);

describe("fieldsOf", () => {
  it("treats a plain schema as one field with id response", () => {
    expect(fieldsOf(single)).toEqual([{ id: "response", label: "Response", def: single }]);
  });
  it("splits a composite schema into labelled fields without the id/label/help keys in def", () => {
    const f = fieldsOf({ type: "composite", fields: [{ id: "x", label: "X", help: "h", type: "approval", required: true, allowRationale: true, requireRationaleOnReject: false }] });
    expect(f).toEqual([{ id: "x", label: "X", help: "h", def: { type: "approval", required: true, allowRationale: true, requireRationaleOnReject: false } }]);
  });
});

describe("validateAnswer", () => {
  it("required vs optional blanks", () => {
    expect(msgs(single, [])).toEqual(["response: required"]);
    expect(msgs({ ...single, required: false }, [])).toEqual([]);
  });

  it("rejects unknown fields and duplicate answers for one field", () => {
    expect(msgs(single, [choice(["a"]), { fieldId: "nope", kind: "text", text: "x" }])).toEqual(["nope: unknown field"]);
    expect(msgs(single, [choice(["a"]), choice(["b"])])).toContain("response: field answered twice");
  });

  it("single choice: exactly one known option; Other and explanation only when allowed", () => {
    expect(msgs(single, [choice(["a"])])).toEqual([]);
    expect(msgs(single, [choice(["a", "b"])])).toEqual(["response: choose exactly one option"]);
    expect(msgs(single, [choice(["zzz"])])).toEqual(["response: unknown option 'zzz'"]);
    expect(msgs(single, [choice(["__other"], { otherText: "x" })])).toEqual(["response: 'Other' is not allowed"]);
    expect(msgs(single, [choice(["a"], { explanation: "why" })])).toEqual(["response: explanation not allowed"]);
    expect(msgs(single, [choice(["a"], { otherText: "x" })])).toEqual(["response: otherText given without choosing 'Other'"]);
    expect(msgs(single, [choice(["a", "a"])])).toContain("response: duplicate option");
  });

  it("Other must be described", () => {
    const s: AnswerSchema = { ...single, allowOther: true };
    expect(msgs(s, [choice(["__other"], { otherText: "  " })])).toEqual(["response: describe the 'Other' choice"]);
    expect(msgs(s, [choice(["__other"], { otherText: "c" })])).toEqual([]);
  });

  it("multiple choice: min and max, with Other counting towards the default max", () => {
    const m: AnswerSchema = { type: "multiple-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowOther: true, allowExplanation: false, required: true, minSelected: 2 };
    expect(msgs(m, [choice(["a"])])).toEqual(["response: choose at least 2"]);
    expect(msgs(m, [choice(["a", "b", "__other"], { otherText: "c" })])).toEqual([]);
    expect(msgs({ ...m, maxSelected: 2 }, [choice(["a", "b", "__other"], { otherText: "c" })])).toEqual(["response: choose at most 2"]);
  });

  it("free text: trimmed minimum length and raw maximum length", () => {
    const t: AnswerSchema = { type: "free-text", required: true, minLength: 3, maxLength: 5, multiline: false };
    expect(msgs(t, [{ fieldId: "response", kind: "text", text: " ab " }])).toEqual(["response: at least 3 characters"]);
    expect(msgs(t, [{ fieldId: "response", kind: "text", text: "abcdef" }])).toEqual(["response: at most 5 characters"]);
    expect(msgs(t, [{ fieldId: "response", kind: "text", text: "abc" }])).toEqual([]);
    expect(msgs(t, [{ fieldId: "response", kind: "choice", optionIds: ["a"] }])).toEqual(["response: expected text"]);
  });

  it("approval: rationale required on reject only when configured, forbidden when not allowed", () => {
    const a: AnswerSchema = { type: "approval", required: true, allowRationale: true, requireRationaleOnReject: true };
    expect(msgs(a, [{ fieldId: "response", kind: "approval", decision: "reject" }])).toEqual(["response: give a reason for rejecting"]);
    expect(msgs(a, [{ fieldId: "response", kind: "approval", decision: "approve" }])).toEqual([]);
    expect(msgs({ ...a, allowRationale: false, requireRationaleOnReject: false }, [{ fieldId: "response", kind: "approval", decision: "approve", rationale: "x" }])).toEqual(["response: rationale not allowed"]);
  });

  it("files: counts, reuse, and upload ownership checks when upload info is available", () => {
    const f: AnswerSchema = { type: "file-upload", required: true, minFiles: 1, maxFiles: 2, allowComment: false, allowedMimeTypes: ["image/png"] };
    const files = (ids: string[], comment?: string): AnswerValue => ({ fieldId: "response", kind: "files", attachmentIds: ids, comment });
    expect(msgs(f, [files(["1", "2", "3"])])).toEqual(["response: at most 2 file(s)"]);
    expect(msgs(f, [files(["1"], "hi")])).toEqual(["response: comment not allowed"]);
    expect(msgs(f, [files(["1", "1"])])).toEqual(["response: attachment 1 used twice"]);
    // Without upload info (the browser) attachments are not resolved.
    expect(msgs(f, [files(["missing"])])).toEqual([]);
    const uploads = (id: string) =>
      ({
        ok: { mimeType: "image/png", questionId: "Q-1" },
        used: { mimeType: "image/png", answerId: "A-9" },
        other: { mimeType: "image/png", questionId: "Q-2" },
        pdf: { mimeType: "application/pdf" },
      })[id];
    expect(msgs(f, [files(["ok"])], { questionId: "Q-1", uploads })).toEqual([]);
    expect(msgs(f, [files(["missing"])], { questionId: "Q-1", uploads })).toEqual(["response: attachment missing not found"]);
    expect(msgs(f, [files(["used"])], { questionId: "Q-1", uploads })).toEqual(["response: attachment used already belongs to another answer"]);
    expect(msgs(f, [files(["other"])], { questionId: "Q-1", uploads })).toEqual(["response: attachment other was uploaded for another question"]);
    expect(msgs(f, [files(["pdf"])], { questionId: "Q-1", uploads })).toEqual(["response: file type application/pdf not allowed here"]);
  });

  it("composite: each field validated independently, errors keyed by field id", () => {
    const c: AnswerSchema = {
      type: "composite",
      fields: [
        { id: "pick", label: "Pick", ...single },
        { id: "note", label: "Note", type: "free-text", required: false, minLength: 1, maxLength: 10, multiline: true },
      ],
    } as AnswerSchema;
    expect(msgs(c, [{ fieldId: "note", kind: "text", text: "way too long text" }])).toEqual(["pick: required", "note: at most 10 characters"]);
  });
});
