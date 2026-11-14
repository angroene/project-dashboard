# ADR 0003 — Answer queue: one file per answer, exclusive claim files, lock-file consumer claims

**Status:** Accepted · **Date:** 2026-11-13

## Decision
- Each answer is `communications/answers/<state>/<answerId>.json`, state = pending | processing | processed | failed.
  `answerId` is opaque and time-ordered (`ANS-<base36 ms>-<random>`).
- Submission: write to `answers/.staging/`, create `communications/claims/<questionId>@r<revision>.json` with
  O_EXCL, then rename into `pending/`. The claim file is the duplicate guard across processes. A crash between
  steps is repaired at startup (staged answers with a matching claim are published, others removed).
- Same idempotency key: the original answer is returned (HTTP 200, `replayed: true`). Different key on an
  answered revision: 409. A `failed` answer may be replaced (old claim moved to `claims-history/`).
- Consumers claim the oldest pending answer by creating `answers/.locks/<answerId>.lock` with O_EXCL, renaming
  to `processing/` and writing a lease (owner, expiresAt). Complete: `processed/`. Fail: `failed/`, or back to
  `pending/` when retryable. Expired leases and stale locks (> 5 min) are recovered.
- Counts come from directory listings and small claim files, never from opening every answer.

## Evidence
`test/server.test.ts`: 12 concurrent submissions give exactly one 201; two concurrent claimers get different answers.
Rename-only arbitration was tried first and **failed on Windows** (both claimers got the same answer), hence the lock file.

## Rejected
- A central answers-list JSON (multi-writer rewrite).
- Rename-only claims (not a reliable arbiter on Windows/NTFS under concurrency).