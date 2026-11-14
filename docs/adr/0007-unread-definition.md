# ADR 0007 — What counts as an unread update

**Status:** Accepted · **Date:** 2026-11-13

An unread update is (a) an activity event the user has not marked read, or (b) a record with
`notifyUser: true` whose `updatedAt` is newer than when the user marked it read. Questions waiting for an
answer are counted separately (`awaitingResponse`) and are never "unread" unless they also set `notifyUser`.
Read state is stored per user in `<project>/user-state/<user>.json` (backend-owned) and changes only through an
explicit mark-read action; opening a project or a record never marks anything read.

**Rejected:** marking read on open (opening something is not the same as having read it); read flags inside records (multi-writer).