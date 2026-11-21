# ADR 0023 — Pinned cards

**Status:** Proposed · **Date:** 2026-11-18 · Builds on ADR 0022

## Context

A daily Yes / No value (ADR 0022) is something the user should see and change at a glance, from wherever they are in
the project. Inside a tab it is one card among many, and the user has to open the right tab first. The root of a
project holds one display type only (tabs or cards), so a card cannot simply sit next to the tabs.

## Decision

- An optional `pinned` flag on an `expandable-card` (default `false`). The project page shows the card's **newest
  record** (in the card's `sort` order) in a compact panel above the tabs, on every view of the project: no filters,
  toolbar, templates list or paging. The row is the normal record row, so a Yes / No field saves on tap and the row
  expands to the record detail.
- On the pinned row, user-editable **`choice`** fields are answered the same way: one button per option, a tap saves
  it at once. Together with a daily template (ADR 0022) this gives a generic **daily pinned choice**: the card's field
  holds the question and its answers, the template's `record.fields` the default, `schedule.time` the nightly reset.
  Nothing has to be answered; an untouched day has the default. In tab lists choice fields stay as text (a long list
  of rows full of buttons is noisy), and Yes / No keeps its row buttons everywhere.
- The full card stays where it is in the tree, with its history, filters and actions.
- `pinned` on a tab is ignored and reported as a warning diagnostic; the navigation API reports `pinned: false` for it.
- Several pinned cards show in tree order.

## Consequences

- Nesting rules (one display type per container) are unchanged; existing projects are unaffected.
- The newest record by `updated-desc` is the scheduler's new day as soon as it is created. If the user changes an
  older day's value afterwards, that day is the newest until the next record; the pinned panel shows the record's
  title (with its date), so this is visible.
- The pinned panel costs one extra request (`limit=1`) per pinned card.

## Rejected alternatives

- **A new "daily question" record type with options and a default:** a second answer model next to questions
  (ADR 0011) and tracked fields; the choice field already has options, validation, history, filters and the
  current-value API.
- **Choice buttons on every row:** cards with several choice fields and many rows become walls of buttons.

- **Allowing a card at the root next to tabs:** breaks the one-type-per-container rule that the layout, the
  navigation API and the diagnostics rely on.
- **Moving the whole card above the tabs:** a growing daily history would push the tabs down; the history belongs in
  the card.
- **Showing the template's current record (`/templates/:t/current`):** exact for daily templates, but ties a generic
  layout flag to templates and needs a second lookup; the newest-record rule works for any card.
