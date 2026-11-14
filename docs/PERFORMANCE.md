# Performance model

How the dashboard stays fast with thousands of records, and how to find out why it is not. Numbers below are
measurements from one development machine with synthetic data; they show the shape of the system, not a guarantee.

## How loading works

1. **Index at startup.** The server reads every project once (manifest, sections, record summaries) into an
   in-memory index, then validates and repairs the answer queue. The index holds summaries only: id, type, title,
   status, priority, timestamps, attachment count.
2. **Project list is O(projects).** `GET /api/projects` returns small cards (counts, progress) from the index and a
   short-lived cache. It never opens record files.
3. **Navigation is one small request per project**: the validated section tree with badge counts.
4. **Lists are paged summaries.** A section returns up to `limit` rows (default is the section's `pageSize`, at most 200)
   with a keyset cursor, so inserts and deletes do not skip or repeat rows. Filtering, search (`q`, substring of id,
   title and summary) and sorting run on the index.
5. **Detail is lazy.** Opening a record reads that one file from disk: body, attachments, history, answer schema. Bodies
   and attachments are never part of list responses.
6. **Queue counts come from directory listings and small claim files**, never from opening every answer. Consumers list
   pending ids through `GET /queue` ([QUEUE.md](QUEUE.md)).
7. **Code splitting.** The Markdown renderer and the question form are loaded on first use.

## Keeping it current without reloading

- **File watcher.** Changes under a project are batched (about 200 ms), the affected files are re-read, and the server
  emits an `invalidate` event with the project, the scopes (records, navigation, progress, activity, answers) and record
  ids.
- **Live updates.** The browser holds one Server-Sent Events connection (`GET /api/updates`). On an event it refetches
  only the affected queries. If the stream fails it falls back to polling the project list every 60 seconds.
- **Reconciliation.** Every 60 seconds (`reconcileSeconds`) the server compares file modification times, which
  catches missed watcher events (network shares, some containers). Changes there can take up to a minute to appear.
- **Client cache.** The UI uses a query cache with a 30 second freshness window, so switching tabs reuses loaded data
  instead of reloading; invalidation events and explicit refresh bypass it. Mutations invalidate exactly what they
  change.

## Measured (synthetic data, one machine)

Run on the two example projects (17 records) with `npm run perf -- examples`, Node 24 on Windows:

| Measure | Result |
|---|---|
| Server start and index | about 300 ms |
| `GET /api/projects` cold | about 38 ms |
| File change to invalidate event | about 220 ms |
| Server memory (RSS) | about 160 MB |

A larger synthetic set (`npm run fixtures`, about 300 records in 3 projects) indexed in about 0.5 s; the first page of its
biggest section (116 questions) was served in a few milliseconds, and warm `GET /api/projects` stayed under 1 ms.
Browser checks on that data: first card visible around 300 ms cold, project open 20 to 30 ms, tab switch 15 ms
(cached) to 37 ms (uncached), record expand 60 to 110 ms. The numbers are in `docs/perf/` and
`docs/screenshots/e2e-results.json`; regenerate them on your hardware before quoting them.

## Measuring on your data

```sh
npm run perf -- <dataRoot> --out perf.json     # works on a temporary copy; your data is not modified
```

It reports index time per project, API latencies (cold and warm), payload sizes, change propagation and memory.
`GET /api/diagnostics` also lists the index time of every project (`indexMs`).

## Diagnosing slow first loads and tab switches

| Symptom | Likely cause | Check |
|---|---|---|
| Slow server start | Very large projects, slow disk or network share | `indexMs` per project in `/api/diagnostics`; move the data root to a local disk |
| Project list slow | A project unavailable or still indexing | `/api/diagnostics`; the log line `ready` shows `indexMs` |
| First tab open slow, later ones fast | Cold index plus lazy chunks (Markdown, form) loading | Browser network panel: list request size and time |
| Every tab switch refetches | Live updates arriving constantly (a producer rewriting files in a loop) | Network panel: repeated `invalidate`; stop the noisy writer or write less often |
| Huge list payloads | `limit` set very high | Keep pages at 25 to 50; use filters and search |
| Changes appear late | Watcher not delivering (network share, some Docker mounts) | They arrive within `reconcileSeconds` (60); lower it, or use a local disk |
| High memory | Very many records in one server | RSS in the `perf` output; split into two instances |
| Many `invalid` records | Diagnostics work on every reload | Fix the files listed in Diagnostics |

Guidelines for producers: write one file per record or event, never one growing list; write atomically; do not rewrite
unchanged files (a changed modification time triggers a reread and an unread update); keep `bodyMarkdown` for detail and
`summary` short.
