# Example projects

Three fictional, self-contained projects. They contain no real data, no external dependencies and no credentials.
`examples/` is a ready-to-use **data root**: each project sits under `examples/projects/`.

| Project | Layout | Shows |
|---|---|---|
| [`lantern-web-app`](projects/lantern-web-app) | `main-tab` -> `page-tab` -> `expandable-card` | Overview tab with progress, attention and activity panels; Build tab with Planning and Quality pages; tasks, issues, a review with an attachment, tracked fields ("Reviewed", "Decision", agent-set "Checks passed"), comments and an external code-review reference; single-choice, approval (with a default answer) and free-text questions; published progress; activity events |
| [`tidepool-notebook`](projects/tidepool-notebook) | `expandable-card` directly at the root | A research notebook with no progress file ("Not reported"); a **custom issue workflow** (`observed`, `investigating`, `awaiting-data`, `confirmed`, `dismissed`, strict); multiple-choice and composite questions; generic records with metadata; a **daily recurring template** ("Daily field log", Honolulu time, shipped `paused`; resume it in the Observations card) with one earlier occurrence and default answers |
| [`showcase-garden`](projects/showcase-garden) | `main-tab` -> `page-tab` -> `expandable-card`, and `main-tab` -> `expandable-card` | **One working instance of every supported type**, in named sections: all display types and section views, every card action, filters and paging, every record type, every answer type (with defaults), all tracked field types, a daily Yes / No item ("Available for the evening check?"), an active recurring question, a paused template, open and completed actions, unread updates, a custom task workflow, attachments and an artifact root, progress and activity. Catalogue: [docs/ITEM_TYPES.md](../docs/ITEM_TYPES.md) |

All three load with zero diagnostics.

`showcase-garden` starts with unanswered, answered, processed and closed questions, open and completed actions,
unread updates, and pending tasks. States that the server keeps (submitted answers awaiting pickup, read items) are
not shipped: they appear once you answer a question or mark items read. Today's daily records are created by the
server when it starts (or within a minute of the project being copied in).

## Run them

The server writes answers, uploads and read state into its data root, so run it on a **copy**:

```sh
npm run build
cp -r examples demo-data
PCC_DATA_ROOT=demo-data PCC_WEB_ROOT=dist/web npm start
# http://127.0.0.1:8790
```

Then follow the producer walkthrough in [docs/QUEUE.md](../docs/QUEUE.md#walkthrough-write-a-question-answer-it-consume-the-answer),
which uses `lantern-web-app`.

## Use one as a template

Copy a folder to `<yourDataRoot>/projects/<name>/`, change `id` and `displayName` in `project.json` (ids must be
unique per server), and edit the section and record files. The format is described in
[docs/PROJECT_FORMAT.md](../docs/PROJECT_FORMAT.md).
