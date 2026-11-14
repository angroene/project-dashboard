# ADR 0002 — One authoritative question copy; the dashboard never rewrites question records

**Status:** Accepted · **Date:** 2026-11-13

## Decision
Questions live only as record files inside an `expandable-card` section (`records/*.json`). The dashboard
reads them but never writes them. The question state shown to the user is **derived** from the record status
(open/answered/processed/closed/withdrawn), `requiresResponse`, and the answer queue (claim for the current
`questionRevision` and the state folder of that answer). A separate `communications/questions/` copy is not used.

## Why
One writer per file (the project/agent owns its records), no duplicate copies to drift, and agents can revise a
question by bumping `questionRevision`, which makes older answers and exported workbooks stale automatically.

## Rejected
- **Dashboard writes `status: answered` into the record:** two writers on one file; races with agents.
- **Separate normalized store + section references:** an extra lookup layer with no benefit at current sizes.