# ADR 0008 — Configurable per-project status workflows

**Status:** Accepted · **Date:** 2026-11-13

## Context

Records carry a `status` string. The first version fixed one vocabulary per record type (for example
`planned in-progress blocked done cancelled` for tasks). That works for one team and fails for the next:
a research notebook wants `observed / investigating / confirmed`, a support queue wants `new / triaged / resolved`.

The dashboard still has to do things that need to understand a status without knowing its name:

- count items that are active or blocked on the project card and in section headers,
- colour badges consistently,
- decide what counts as finished when filtering.

The answer queue is different: it depends on question statuses (`open` accepts an answer; the other values are
set by producers). Those transitions are part of the queue contract (ADR 0003),
not a presentation choice.

## Decision

1. A project may declare, in `project.json`, `workflows.<recordType>` for `task`, `issue`, `review`, `progress`,
   `activity`, `document` and `generic`:

   ```json
   "workflows": {
     "issue": {
       "unknownStatus": "warn",
       "statuses": [
         { "id": "observed", "label": "Observed", "category": "open" },
         { "id": "investigating", "label": "Investigating", "category": "active" },
         { "id": "confirmed", "label": "Confirmed", "category": "done", "tone": "ok" }
       ]
     }
   }
   ```

2. Every status belongs to exactly one fixed **category**: `open`, `active`, `waiting`, `blocked`, `done`,
   `closed`. Counts (active, blocked) and default colours derive from the category, so any vocabulary behaves
   correctly. `tone` (`neutral info ok warn danger`) overrides the category's default colour only.
3. A declared workflow **replaces** the built-in default for that record type as a whole; it is not merged.
   Built-in defaults are `DEFAULT_WORKFLOWS` in `src/shared/schemas.ts`. Types without a declaration use them.
4. `unknownStatus` decides what happens to a record whose status is not in the workflow:
   `warn` (default) shows the record as `open` with a humanised label and adds a warning to the diagnostics view;
   `strict` ignores the record and reports an error. Strict suits projects where a typo should be loud.
5. **Question statuses stay fixed** (`open answered processed closed withdrawn`). The queue and the derived
   question state depend on them.
6. Status ids are lower-case slugs (`^[a-z0-9][a-z0-9-]{0,63}$`), unique within a workflow, 1 to 64 statuses,
   labels up to 60 characters. The record's own `statusLabel` still overrides the displayed label for that record.
7. Workflows are part of the project manifest, so they are validated with it. A malformed `workflows` block makes
   the project manifest invalid and the project unavailable; the diagnostics view names the field.

## Rejected alternatives

- **Hardcoded enums per record type (the previous behaviour).** Simple and strongly typed, but forces every
  project into one team's vocabulary. Projects either misuse the nearest status or stop using the type. Rejected
  because the dashboard is meant to be project-independent.
- **Free-form status strings with no categories.** Maximum freedom, but the dashboard could no longer tell "blocked"
  from "done", so counts, colours and "hide finished work" would break or need per-project code. The category is the
  small piece of structure that keeps the generic features working.
- **Workflows per section.** More granular, but one record type would then mean different things in different
  places of the same project, the same status id could carry two categories, and project-level counts would need
  to resolve a workflow per record. Sections already organise the layout; they do not own the vocabulary.
  A project that needs two vocabularies can use two record types or distinct status ids within one workflow.
- **Merging a project workflow into the default.** Makes it impossible to remove a default status and makes the
  effective vocabulary hard to read from the manifest alone. Replacement keeps `project.json` the single source of
  truth.

## Consequences

- Existing projects keep working: with no `workflows` block the defaults apply.
- Changing a workflow never rewrites records. A record whose status is no longer listed follows `unknownStatus`.
- Excel export, import and the answer queue are unaffected; they only touch questions.
- Adding a sixth category later would be a breaking change for every project that relies on counts, so the
  category list is deliberately small and closed.
