# ADR 0016 — One server per data root

**Status:** Accepted · **Date:** 2026-11-15 · Amends ADR 0014

## Context

Partial record updates (agent `PATCH`, the user's field changes and comments) read the record, change it and write it
back atomically, serialised by an in-process lock. Two server processes on the same data have separate locks: when
both update one record at the same time, one change is lost while both calls succeed. Recurrence was exactly-once
across processes (ADR 0014), which suggested that several servers on one data folder were supported.

## Decision

- Only one server may use a data root. At start-up the server creates `<dataRoot>/.apd-writer.lock` exclusively,
  holding its pid, host, start time and a random token, and refreshes its modification time every 10 seconds.
- A lock not refreshed for 30 seconds belongs to a process that is gone (crash, killed container) and is taken over.
  A starting server waits up to 35 seconds for a live owner to stop (an upgrade replacing a container), then refuses to
  start, naming the holder.
- Just before it starts listening the server checks once more that the lock file is its own, which settles two
  servers that took over the same stale lock at the same moment. Backups leave the lock file out.
- If the lock is replaced while the server runs (another server took it over), the server stops at once rather than
  keep writing. On normal shutdown it removes its own lock, never another one's.
- The lock works on local disks and shared file systems alike; it relies only on exclusive create, rename and
  modification times. Extra project roots outside the data root are not locked; the documentation says not to share
  them between servers.

## Consequences

- Silent lost updates between two servers become a clear start-up error.
- A server that crashes delays the next start by up to 30 seconds.
- Exactly-once occurrence creation (ADR 0014) stays as a second safety net.

## Rejected alternatives

- **Cross-process lock per record write** (lock files around every update): adds a file system round trip and stale
  lock handling to every write for a setup nobody needs; one server per data folder is the deployment model.
- **Compare-and-swap on rename** (re-check the revision just before replacing the file): narrows the race but cannot
  close it without a lock, because check and rename are separate steps.
- **pid-only lock**: pids are meaningless across hosts and containers (every container's server is pid 1).
- **Document the limit only**: leaves silent data loss for anyone who starts a second server by mistake.
