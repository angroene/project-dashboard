# ADR 0001 — Backend runtime: TypeScript on Node.js with Fastify

**Status:** Accepted (first release) · **Date:** 2026-11-13

## Context
The UI is React and a typed backend that shares schemas with the UI is wanted; no runtime was fixed in advance.
Earlier prototypes were static JSON served by a plain file server (no backend). Target machines run Node 22 or newer
(developed on Node 24), including small ARM boards.

## Decision
TypeScript on Node >= 22 with Fastify 5. One zod schema module (`src/shared/schemas.ts`) validates on the
server and gives the UI its types. Libraries: exceljs (xlsx), yazl/yauzl (zip), @fastify/multipart (uploads).
All versions pinned exactly; `npm audit` clean at time of writing (uuid inside exceljs overridden to 11.1.1).

## Rejected alternatives
- **Extend the Python static server:** no typed contract shared with React; uploads, xlsx and SSE would be new code anyway.
- **Java/Kotlin:** a second language for the same schemas; heavier on small machines.
- **Database (SQLite):** JSON files are the authoritative store by design; an in-memory index is enough at measured sizes (about 300 synthetic records index in ~0.5 s).