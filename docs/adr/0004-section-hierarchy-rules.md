# ADR 0004 — Section hierarchy rules

**Status:** Accepted · **Date:** 2026-11-13

Allowed children: root -> main-tab | page-tab | expandable-card; main-tab -> page-tab | expandable-card;
page-tab -> expandable-card; expandable-card -> records only. All children of one container share one display
type (mixed siblings: the majority type is kept, the others are reported in diagnostics). Max depth 3.
Folders without `section.json` are ignored. Section ids are unique per project.

**Why:** covers every arrangement needed (three levels, tabs only, cards only) without
ambiguous layouts (cards and tabs side by side) or nested tab bars. Cycles are impossible (folders) and depth is bounded.

**Rejected:** free nesting (unbounded UI states); fixed three levels (projects must be free to choose their arrangement).