# Excel round trip

Answer questions offline: export open questions to a real `.xlsx` workbook, fill in the answers in Excel,
LibreOffice or any spreadsheet app, and import it back. Import is always a **preview first**; nothing is written until
you confirm. CSV is not used.

Actions are enabled per section (`export-xlsx`, `import-xlsx` in the section's `actions`). The example Lantern
and Tidepool question cards have both.

## Export

In the UI select questions and choose Export, or call the API:

```sh
curl -s -X POST -H 'X-PCC-Request: 1' -H 'Content-Type: application/json' \
  http://127.0.0.1:8790/api/projects/lantern-web-app/export/xlsx \
  -d '{"questionIds":["LNT-Q-001","LNT-Q-002"]}' -o answers.xlsx
```

The file name is `<projectId>_questions_<date>.xlsx`. The workbook has three sheets:

- **Instructions**: how to fill it in.
- **Answers**: one row per question field (a composite question has several rows with the same Question ID).
- `_meta` (very hidden): format name, workbook version, project id, export time.

Grey, locked columns identify the row: Project ID, Question ID, Revision, Field ID, plus read-only context
(title, context text, choices, current status, due date, a "how to answer" hint). You edit two columns:
**Response** and **Notes**. Excel list drop-downs are provided for approvals and short single-choice lists. Sheet
protection has no password: it prevents accidents, it is not security.

Cell values are written as text; the workbook contains no formulas.

## Filling it in

| Answer type | Response | Notes |
|---|---|---|
| single-choice | option label or id; `Other: your text` for the Other option | explanation (if allowed) |
| multiple-choice | labels or ids separated by `;` (may include `Other: your text`) | explanation (if allowed) |
| free-text | the text | ignored (a message says so) |
| approval | `Approve` or `Reject` | rationale |
| file-upload | not possible in Excel | |

Leave all cells of a question empty to skip it. Do not rename sheets, change the header row, or edit the grey columns.

## Import and preview

Upload the file in the UI (Import), or:

```sh
curl -s -X POST -H 'X-PCC-Request: 1' -F 'file=@answers.xlsx' \
  http://127.0.0.1:8790/api/projects/lantern-web-app/import/xlsx/preview
```

The preview is kept in memory for 30 minutes and classifies each question:

| Status | Meaning |
|---|---|
| `ready` | Valid answer; can be imported. |
| `blank` | Nothing entered; skipped. |
| `invalid` | Unknown option, bad value, formula or error value in a cell, duplicate row, wrong project, question no longer exists, or a workbook-level problem. Not importable. |
| `stale` | The question was revised after the export (revision changed). Not importable; export again. |
| `already-answered` | The question already has an answer (submitted, processing or processed). Not overwritten. |
| `needs-dashboard` | A required file upload cannot be answered in Excel. Answer it in the dashboard. |

Then commit the rows you select:

```sh
curl -s -X POST -H 'X-PCC-Request: 1' -H 'Content-Type: application/json' \
  http://127.0.0.1:8790/api/projects/lantern-web-app/import/xlsx/commit \
  -d '{"previewId":"<id from the preview>","questionIds":["LNT-Q-001"]}'
```

Each selected question goes through exactly the same validation and queue as an answer typed in the dashboard
(`source: "excel-import"`). The result lists `ok` or a message per question. Committing the same preview twice is
safe: the repeat reports `already submitted from this preview` and creates no second answer.

Guarantees, all covered by the implementation:

- An invalid, stale, blank or already-answered row never changes anything; other rows in the same file can still import.
- A workbook that is not from this dashboard, is for another project, has changed columns, is not a valid zip, or is
  too large (5 MB, 5000 rows, bounded unpacked size and entry count) is rejected with a clear message.
- Formulas are never evaluated or imported.

Verified by hand against the running server on the examples: export, edit with a script, preview (one `ready` row
and one `invalid` row for a formula cell), commit (one answer created, the invalid row refused), and a repeat commit.
Excel itself was not used; the workbook was produced and edited with the same library the server uses.
