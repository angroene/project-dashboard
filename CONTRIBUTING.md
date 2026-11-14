# Contributing

Thanks for considering a contribution. This project is licensed under Apache-2.0; by submitting a contribution you
agree that it may be distributed under that license.

Development may use AI-assisted implementation and review tools. Contributions, including AI-assisted contributions, are held to the same architecture, testing, review, licensing, provenance, and quality requirements as any other contribution.

## Before you start

- For anything larger than a bug fix, open an issue first and describe the problem and the approach.
- Read [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md), [docs/QUEUE.md](docs/QUEUE.md) and the decisions in
  [docs/adr/](docs/adr/). The data format and the queue protocol are contracts: changing them needs a decision record
  and, if existing data would break, a documented migration.
- Do not add private or real project data, credentials or internal paths anywhere in the repository, including tests,
  fixtures, screenshots and examples.

## Set up

Node.js 22 or newer.

```sh
npm ci
npm run build
npm test
```

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the full command list.

## What a good change looks like

- **Small and focused.** One concern per pull request. No drive-by refactors.
- **Tests ship with the behavior**, at the right level: web components and pure logic as unit tests, server behavior
  as integration tests on temporary folders, user flows in the end-to-end walk. Never weaken, delete or skip a test to
  make it pass; fix the code or explain why the test is wrong.
- **Determinism.** No test may depend on wall-clock timing, network access, or real user folders.
- **Contracts stay validated.** New fields go into the zod schemas in `src/shared/schemas.ts` with limits, and the
  server validates all input again.
- **Security-sensitive code** (paths, uploads, ZIP, Excel, auth, rendering) needs a test for the hostile case, not only
  the happy path.
- **Dependencies.** Keep them minimal and pinned. A new dependency needs a reason in the pull request and an
  acceptable license; run `npx tsx scripts/licenses.ts --out docs/THIRD_PARTY_LICENSES.md` and review the result.
- **Documentation.** Update the affected page under `docs/`. Every command in the docs must be one you ran.
- **Be honest about status.** Mark anything partial, experimental or unverified as exactly that.

## Checks to run

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e        # needs a Chromium-based browser, see docs/GETTING_STARTED.md
```

## Commits and pull requests

- Short, readable commit messages describing what changed and why.
- Describe what you tested and what you could not.
- Do not add co-author trailers or generated-by banners to commits, code or documentation.

## Reporting security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
