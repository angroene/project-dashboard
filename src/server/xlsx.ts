/**
 * Excel round trip for questions.
 * Workbook: "Instructions", "Answers" (one row per question field), hidden "_meta".
 * Response conventions (documented on the Instructions sheet):
 *   single-choice   Response = option label or id; "Other: <text>" for Other. Notes = explanation.
 *   multiple-choice Response = labels/ids separated by ";" (may include "Other: <text>"). Notes = explanation.
 *   free-text       Response = the text.
 *   approval        Response = Approve | Reject. Notes = rationale.
 *   file-upload     cannot be answered in Excel; upload in the dashboard.
 */
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import type { ImportPreview, ImportRowStatus } from "../shared/api.js";
import type { AnswerValue, QuestionRecord } from "../shared/schemas.js";
import { fieldsOf, OTHER_OPTION_ID, validateAnswer, type FieldSpec } from "../shared/validate.js";
import { parseRecordFile, type ProjectState, type Store } from "./store.js";
import { ApiFailure, submitAnswer } from "./answers.js";

export const WORKBOOK_FORMAT = "pcc-answers";
export const WORKBOOK_VERSION = 1;

const COLS = [
  { key: "projectId", header: "Project ID", width: 16 },
  { key: "questionId", header: "Question ID", width: 16 },
  { key: "revision", header: "Revision", width: 9 },
  { key: "fieldId", header: "Field ID", width: 14 },
  { key: "title", header: "Question", width: 40 },
  { key: "context", header: "Context", width: 50 },
  { key: "field", header: "Field", width: 20 },
  { key: "type", header: "Answer type", width: 15 },
  { key: "choices", header: "Choices (id = label)", width: 34 },
  { key: "status", header: "Current status", width: 16 },
  { key: "due", header: "Due", width: 20 },
  { key: "response", header: "Response", width: 36 },
  { key: "notes", header: "Notes / explanation / rationale", width: 40 },
  { key: "hint", header: "How to answer", width: 44 },
] as const;
const EDITABLE = new Set(["response", "notes"]);

/** Excel list validation cannot hold commas or quotes; the import side matches this same form. */
function dropdownLabel(label: string): string {
  return label.replace(/[",]/g, " ").replace(/\s+/g, " ").trim();
}

function hintFor(f: FieldSpec): string {
  const d = f.def;
  const req = d.required ? "Required." : "Optional.";
  switch (d.type) {
    case "single-choice":
      return `${req} One option label or id.${d.allowOther ? ' Or "Other: your text".' : ""}${d.allowExplanation ? " Explanation in Notes." : ""}`;
    case "multiple-choice":
      return `${req} Labels/ids separated by ";".${d.allowOther ? ' May include "Other: your text".' : ""}${d.allowExplanation ? " Explanation in Notes." : ""}`;
    case "free-text":
      return `${req} Type your answer (max ${d.maxLength} characters).`;
    case "approval":
      return `${req} Approve or Reject.${d.allowRationale ? " Reason in Notes." : ""}${d.requireRationaleOnReject ? " Reason required when rejecting." : ""}`;
    case "file-upload":
      return "Files cannot be added in Excel. Upload them in the dashboard.";
  }
}

export interface ExportItem {
  record: QuestionRecord;
  uiState: string;
}

export async function buildWorkbook(projectId: string, items: ExportItem[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Agents Project Dashboard";
  wb.created = new Date();

  const ins = wb.addWorksheet("Instructions");
  ins.getColumn(1).width = 110;
  const lines = [
    "How to use this workbook",
    "",
    "1. Fill in the Response column (and Notes where useful) on the Answers sheet. Leave a question's rows empty to skip it.",
    "2. Do not change the grey ID columns or rename sheets; the dashboard uses them to match answers to questions.",
    "3. Single choice: write one option label or id. Use \"Other: your text\" when Other is allowed.",
    "4. Multiple choice: separate labels/ids with ;   Approval: write Approve or Reject (reason in Notes).",
    "5. File uploads cannot be answered here. Upload files for those questions in the dashboard.",
    "6. Save, then use Import Excel in the dashboard. You will see a preview and choose which answers to submit.",
    "7. If a question was changed after export, its answer is rejected as stale; export again.",
    "",
    `Project: ${projectId}    Exported: ${new Date().toISOString()}    Questions: ${items.length}`,
  ];
  lines.forEach((l, i) => {
    const c = ins.getCell(i + 1, 1);
    c.value = l;
    if (i === 0) c.font = { bold: true, size: 14 };
  });

  const ws = wb.addWorksheet("Answers", { views: [{ state: "frozen", ySplit: 1, xSplit: 0 }] });
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };

  for (const { record: q, uiState } of items) {
    if (!q.answerSchema) continue;
    const context = [q.summary, q.bodyMarkdown].filter(Boolean).join("\n\n").slice(0, 2000);
    for (const f of fieldsOf(q.answerSchema)) {
      const d = f.def;
      const choices = d.type === "single-choice" || d.type === "multiple-choice"
        ? d.options.map((o) => `${o.id} = ${o.label}`).join("\n") + (d.allowOther ? "\nOther: <text>" : "")
        : d.type === "approval" ? "Approve\nReject" : "";
      const row = ws.addRow({
        projectId, questionId: q.id, revision: q.questionRevision, fieldId: f.id, title: q.title, context,
        field: f.label, type: d.type, choices, status: uiState, due: q.dueAt ?? "",
        response: d.type === "file-upload" ? "(upload in dashboard)" : "", notes: "", hint: hintFor(f),
      });
      row.alignment = { vertical: "top", wrapText: true };
      COLS.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const editable = EDITABLE.has(c.key) && d.type !== "file-upload";
        cell.protection = { locked: !editable };
        if (!editable) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      });
      const resp = row.getCell(COLS.findIndex((c) => c.key === "response") + 1);
      if (d.type === "approval") {
        resp.dataValidation = { type: "list", allowBlank: true, formulae: ['"Approve,Reject"'] };
      } else if (d.type === "single-choice") {
        const list = d.options.map((o) => dropdownLabel(o.label)).join(",");
        if (list.length <= 250) {
          resp.dataValidation = {
            type: "list", allowBlank: true, formulae: [`"${list}"`],
            // Other: free text must stay possible, so invalid entries only warn.
            showErrorMessage: !d.allowOther, errorStyle: d.allowOther ? "information" : "stop",
            error: "Pick one of the listed options.",
          };
        }
      }
    }
  }
  // Protection is a usability hint only (no password); the server validates everything on import.
  await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, sort: false, autoFilter: true });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };

  const meta = wb.addWorksheet("_meta");
  meta.state = "veryHidden";
  meta.addRows([["format", WORKBOOK_FORMAT], ["workbookSchemaVersion", WORKBOOK_VERSION], ["projectId", projectId], ["exportedAt", new Date().toISOString()]]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------------ import --
/** Reject zip bombs before ExcelJS inflates the workbook. */
export function checkZipLimits(buf: Buffer, maxEntries = 500, maxTotal = 60 * 1024 * 1024): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(new ApiFailure(400, "bad-workbook", "not a valid .xlsx file"));
      // Inflate every entry and count real bytes: declared sizes in the directory can lie.
      let n = 0, total = 0, done = false;
      const fail = (msg: string) => { if (done) return; done = true; zip.close(); reject(new ApiFailure(400, "bad-workbook", msg)); };
      zip.on("entry", (e: yauzl.Entry) => {
        n++;
        if (n > maxEntries) return fail("workbook has too many parts");
        if (/\/$/.test(e.fileName)) return zip.readEntry();
        zip.openReadStream(e, (err2, rs) => {
          if (err2 || !rs) return fail("corrupt .xlsx file");
          rs.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxTotal) { rs.destroy(); fail("workbook too large when unpacked"); }
          });
          rs.on("error", () => fail("corrupt .xlsx file"));
          rs.on("end", () => { if (!done) zip.readEntry(); });
        });
      });
      zip.on("end", () => { if (!done) { done = true; resolve(); } });
      zip.on("error", () => fail("corrupt .xlsx file"));
      zip.readEntry();
    });
  });
}

type CellRead = { text: string; formula: boolean; error: boolean };
function readCell(v: ExcelJS.CellValue): CellRead {
  if (v === null || v === undefined) return { text: "", formula: false, error: false };
  if (typeof v === "string") return { text: v, formula: false, error: false };
  if (typeof v === "number" || typeof v === "boolean") return { text: String(v), formula: false, error: false };
  if (v instanceof Date) return { text: v.toISOString(), formula: false, error: false };
  const o = v as unknown as Record<string, unknown>;
  if ("formula" in o || "sharedFormula" in o) return { text: "", formula: true, error: false };
  if ("error" in o) return { text: "", formula: false, error: true };
  if ("richText" in o && Array.isArray(o.richText)) return { text: (o.richText as { text: string }[]).map((r) => r.text).join(""), formula: false, error: false };
  if ("text" in o) return { text: String(o.text), formula: false, error: false };
  return { text: String(v), formula: false, error: false };
}

function parseChoice(f: FieldSpec, response: string, notes: string): { value?: AnswerValue; errors: string[] } {
  const d = f.def;
  if (d.type !== "single-choice" && d.type !== "multiple-choice") return { errors: [] };
  const errors: string[] = [];
  const parts = d.type === "multiple-choice" ? response.split(";") : [response];
  const optionIds: string[] = [];
  let otherText: string | undefined;
  for (const raw of parts.map((s) => s.trim()).filter(Boolean)) {
    // Real options win over the "Other" convention (an option may itself be labelled "Other").
    const opt = d.options.find((o) => o.id === raw)
      ?? d.options.find((o) => o.label.trim().toLowerCase() === raw.toLowerCase())
      ?? d.options.find((o) => dropdownLabel(o.label).toLowerCase() === dropdownLabel(raw).toLowerCase());
    if (opt) { optionIds.push(opt.id); continue; }
    const m = /^other\s*:\s*(.*)$/is.exec(raw);
    if (m || raw.toLowerCase() === "other") {
      optionIds.push(OTHER_OPTION_ID);
      otherText = (m?.[1] ?? "").trim();
      continue;
    }
    errors.push(`'${raw}' is not one of the options`);
  }
  const value: AnswerValue = { fieldId: f.id, kind: "choice", optionIds };
  if (otherText !== undefined) value.otherText = otherText;
  if (notes) value.explanation = notes;
  return { value, errors };
}

interface PreviewRowInternal {
  questionId: string;
  title: string;
  status: ImportRowStatus;
  messages: string[];
  answers?: AnswerValue[];
  revision?: number;
}

interface StoredPreview {
  projectId: string;
  rows: PreviewRowInternal[];
  expires: number;
}

const previews = new Map<string, StoredPreview>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 20;

function sweepPreviews() {
  const now = Date.now();
  for (const [k, v] of previews) if (v.expires < now) previews.delete(k);
}

export async function previewImport(store: Store, p: ProjectState, buf: Buffer, fileName: string, maxRows: number): Promise<ImportPreview> {
  sweepPreviews();
  await checkZipLimits(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ApiFailure(400, "bad-workbook", "could not read the workbook");
  }
  const errors: string[] = [];
  const meta = wb.getWorksheet("_meta");
  const metaMap = new Map<string, string>();
  meta?.eachRow((row) => metaMap.set(readCell(row.getCell(1).value).text, readCell(row.getCell(2).value).text));
  if (!meta || metaMap.get("format") !== WORKBOOK_FORMAT) errors.push("This workbook was not exported by the dashboard (missing _meta sheet).");
  else if (metaMap.get("workbookSchemaVersion") !== String(WORKBOOK_VERSION)) errors.push(`Unsupported workbook version ${metaMap.get("workbookSchemaVersion")}.`);
  if (metaMap.get("projectId") && metaMap.get("projectId") !== p.manifest.id) errors.push(`Workbook belongs to project '${metaMap.get("projectId")}', not '${p.manifest.id}'.`);

  const ws = wb.getWorksheet("Answers");
  if (!ws) errors.push("Answers sheet is missing.");
  const header = ws ? COLS.map((_c, i) => readCell(ws.getRow(1).getCell(i + 1).value).text.trim()) : [];
  if (ws && header.some((h, i) => h !== COLS[i].header)) errors.push("Answers sheet columns were changed; export a fresh workbook.");

  const grouped = new Map<string, { revision: string; projectId: string; rows: { fieldId: string; response: CellRead; notes: CellRead; rowNo: number }[] }>();
  if (ws && !errors.length) {
    if (ws.rowCount - 1 > maxRows) throw new ApiFailure(400, "too-many-rows", `workbook has more than ${maxRows} rows`);
    const col = (k: (typeof COLS)[number]["key"]) => COLS.findIndex((c) => c.key === k) + 1;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const qid = readCell(row.getCell(col("questionId")).value).text.trim();
      if (!qid) continue;
      const g = grouped.get(qid) ?? { revision: readCell(row.getCell(col("revision")).value).text.trim(), projectId: readCell(row.getCell(col("projectId")).value).text.trim(), rows: [] };
      g.rows.push({
        fieldId: readCell(row.getCell(col("fieldId")).value).text.trim(),
        response: readCell(row.getCell(col("response")).value),
        notes: readCell(row.getCell(col("notes")).value),
        rowNo: r,
      });
      grouped.set(qid, g);
    }
  }

  const rows: PreviewRowInternal[] = [];
  for (const [qid, g] of grouped) {
    const msgs: string[] = [];
    const push = (status: ImportRowStatus, title = qid, extra: Partial<PreviewRowInternal> = {}) => rows.push({ questionId: qid, title, status, messages: msgs, ...extra });
    if (g.projectId !== p.manifest.id) { msgs.push(`row project '${g.projectId}' does not match`); push("invalid"); continue; }
    const entry = p.records.get(qid);
    if (!entry || entry.recordType !== "question") { msgs.push("question no longer exists"); push("invalid"); continue; }
    const parsed = await parseRecordFile(entry.file);
    if (!parsed.ok || parsed.record.recordType !== "question" || !parsed.record.answerSchema) { msgs.push("question cannot be answered"); push("invalid", entry.title); continue; }
    const q = parsed.record as QuestionRecord;
    const schema = q.answerSchema!;
    const fields = fieldsOf(schema);
    const fieldIds = new Set(fields.map((f) => f.id));

    const seenFields = new Set<string>();
    let bad = false;
    for (const r of g.rows) {
      if (!fieldIds.has(r.fieldId)) { msgs.push(`row ${r.rowNo}: unknown field '${r.fieldId}'`); bad = true; }
      if (seenFields.has(r.fieldId)) { msgs.push(`row ${r.rowNo}: duplicate row for field '${r.fieldId}'`); bad = true; }
      seenFields.add(r.fieldId);
      if (r.response.formula || r.notes.formula) { msgs.push(`row ${r.rowNo}: formulas are not accepted in answer cells`); bad = true; }
      if (r.response.error || r.notes.error) { msgs.push(`row ${r.rowNo}: cell contains an error value`); bad = true; }
    }
    const filled = g.rows.filter((r) => {
      const f = fields.find((x) => x.id === r.fieldId);
      const resp = f?.def.type === "file-upload" ? "" : r.response.text.trim();
      return resp || r.notes.text.trim();
    });
    if (bad) { push("invalid", q.title); continue; }
    if (!filled.length) { push("blank", q.title); continue; }
    if (String(q.questionRevision) !== g.revision) { msgs.push(`question changed since export (revision ${g.revision} → ${q.questionRevision})`); push("stale", q.title); continue; }
    const ui = store.questionUiState(p, entry);
    if (ui === "submitted" || ui === "processing" || ui === "processed" || ui === "answered") { msgs.push(`already ${ui}`); push("already-answered", q.title); continue; }
    if (ui !== "needs-response") { msgs.push(`question is ${ui}`); push("invalid", q.title); continue; }

    const answers: AnswerValue[] = [];
    let needsDashboard = false;
    for (const f of fields) {
      const r = g.rows.find((x) => x.fieldId === f.id);
      const response = r?.response.text.trim() ?? "";
      const notes = r?.notes.text.trim() ?? "";
      switch (f.def.type) {
        case "file-upload":
          if (f.def.required && f.def.minFiles > 0) needsDashboard = true;
          break;
        case "single-choice":
        case "multiple-choice": {
          if (!response && !notes) break;
          const pc = parseChoice(f, response, notes);
          pc.errors.forEach((e) => msgs.push(`${f.label}: ${e}`));
          if (pc.value) answers.push(pc.value);
          break;
        }
        case "free-text":
          if (notes) msgs.push(`${f.label}: Notes column ignored for text answers`);
          if (response) answers.push({ fieldId: f.id, kind: "text", text: response });
          break;
        case "approval": {
          if (!response && !notes) break;
          const dec = response.toLowerCase();
          if (dec !== "approve" && dec !== "reject") { msgs.push(`${f.label}: write Approve or Reject`); bad = true; break; }
          answers.push({ fieldId: f.id, kind: "approval", decision: dec, ...(notes ? { rationale: notes } : {}) });
          break;
        }
      }
    }
    if (needsDashboard) { msgs.push("has a required file upload — answer this question in the dashboard"); push("needs-dashboard", q.title); continue; }
    const verrs = validateAnswer(schema, answers, { questionId: qid });
    for (const e of verrs) msgs.push(`${fields.find((f) => f.id === e.fieldId)?.label ?? e.fieldId}: ${e.message}`);
    if (bad || verrs.length || msgs.some((m) => / is not one of the options/.test(m))) { push("invalid", q.title); continue; }
    push("ready", q.title, { answers, revision: q.questionRevision });
  }
  if (errors.length) for (const r of rows) { r.status = "invalid"; r.messages = ["workbook rejected", ...r.messages]; }

  const totals: Record<ImportRowStatus, number> = { ready: 0, blank: 0, invalid: 0, stale: 0, "already-answered": 0, "needs-dashboard": 0 };
  for (const r of rows) totals[r.status]++;
  const previewId = crypto.randomBytes(12).toString("hex");
  const expires = Date.now() + PREVIEW_TTL_MS;
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
  previews.set(previewId, { projectId: p.manifest.id, rows, expires });
  return {
    previewId, projectId: p.manifest.id, fileName, totals, errors, expiresAt: new Date(expires).toISOString(),
    rows: rows.map(({ revision: _r, ...rest }) => rest),
  };
}

export async function commitImport(store: Store, p: ProjectState, previewId: string, questionIds: string[], user: string) {
  const prev = previews.get(previewId);
  if (!prev || prev.projectId !== p.manifest.id || prev.expires < Date.now()) throw new ApiFailure(404, "preview-expired", "import preview not found or expired; upload the workbook again");
  const results: { questionId: string; ok: boolean; answerId?: string; message?: string }[] = [];
  for (const qid of [...new Set(questionIds)]) {
    const row = prev.rows.find((r) => r.questionId === qid);
    if (!row) { results.push({ questionId: qid, ok: false, message: "not in this preview" }); continue; }
    if (row.status !== "ready" || !row.answers || !row.revision) { results.push({ questionId: qid, ok: false, message: `not importable (${row.status})` }); continue; }
    const key = `xlsx_${previewId}_${crypto.createHash("sha1").update(qid).digest("hex").slice(0, 16)}`;
    try {
      const r = await submitAnswer(store, p, qid, { questionRevision: row.revision, answers: row.answers, idempotencyKey: key }, "excel-import", user);
      results.push({ questionId: qid, ok: true, answerId: r.answerId, message: r.replayed ? "already submitted from this preview" : undefined });
    } catch (e) {
      const f = e as ApiFailure;
      results.push({ questionId: qid, ok: false, message: f.fieldErrors?.map((x) => `${x.fieldId}: ${x.message}`).join("; ") || f.message });
    }
  }
  return { results };
}
