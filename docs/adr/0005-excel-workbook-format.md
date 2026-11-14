# ADR 0005 — Excel workbook format for question round trips

**Status:** Accepted · **Date:** 2026-11-13

Sheets: `Instructions`, `Answers`, hidden `_meta` (format `pcc-answers`, version 1, projectId).
`Answers` has **one row per question field** (composite questions get several rows with the same Question ID).
Grey locked ID columns: Project ID, Question ID, Revision, Field ID. Editable: **Response** and **Notes**.
- single-choice: label or id; `Other: text` for Other; Notes = explanation. Drop-down for short option lists.
- multiple-choice: `;`-separated labels/ids.
- approval: Approve/Reject (drop-down); Notes = rationale.
- free-text: Response = the text.
- file-upload: not answerable in Excel; a question with a required upload is reported `needs-dashboard`.

Import = preview (per question: ready / blank / invalid / stale / already-answered / needs-dashboard), then
commit of the selected ready rows through the same submit path (`source: "excel-import"`). Formulas and error
values in answer cells are rejected. Zip size/entry limits are checked before parsing. Sheet protection is a
usability hint only (no password).

**Rejected:** one column per field (breaks for varied composite shapes); embedded images (not needed).