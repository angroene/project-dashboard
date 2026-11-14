# ADR 0011 — Default answers are display data, never answers

**Status:** Accepted · **Date:** 2026-11-14 · Extends ADR 0002 and ADR 0003

## Context

Many questions have an obvious expected answer ("Approve the nightly build?", "Which tide today?"). Users asked to
see it pre-selected so that answering takes one click. The answer queue (ADR 0003) is the only channel agents consume,
so anything that turns a default into an answer without the user would make agents act on decisions nobody made.

## Decision

- `single-choice`, `multiple-choice`, `free-text` and `approval` answer schemas, and the same types inside
  `composite`, accept an optional `default` in the type's natural shape: an option id, a list of option ids, text, or
  `"approve"`/`"reject"`. Yes/no questions use `approval`; there is no separate boolean type. `file-upload` has none.
- The server validates a default with exactly the rules it applies to a submitted answer (`defaultErrors` builds the
  default answer and runs `validateAnswer` on it). A record with an invalid default is rejected like any invalid
  record: 422 from the publish API, an error diagnostic for a file.
- The form starts from the default and says "Suggested default: …". Nothing is sent until the user presses Submit. The
  submitted answer is stored exactly as given; the queue, the Excel import and the recurrence scheduler never fill in
  defaults.
- The field lives inside `answerSchema` rather than in a new `response.defaultValue` block, so it is versioned with
  the question (a changed default is a changed answer schema, see `questionRevision`) and old records stay valid.

## Consequences

- No new state: "default", "submitted response", "manually updated status" and "reported external status" stay four
  separate things (documented in PROJECT_FORMAT.md).
- An answer cannot tell whether the user kept or changed the default. Nothing needs to; if it ever matters, the answer
  envelope can record it without changing this contract.
- Changing a default on an answered question requires a new `questionRevision`, as for any schema change.

## Rejected alternatives

- **Auto-submitting defaults after a timeout or for recurring records**: silently makes decisions for the user and
  feeds them to agents; contradicts "agents act only on submitted answers".
- **A separate `response.defaultValue` object**: a second place to describe one question's answer, with its own
  validation and versioning.
- **A boolean answer type**: duplicates `approval`; two types for one decision would split agents' handling.
