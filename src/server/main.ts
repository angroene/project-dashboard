import { buildApp } from "./app.js";
import { authWarnings, isLoopback, loadConfig } from "./config.js";
import { acquireWriterLock } from "./datalock.js";
import { startRecurrence } from "./recurrence.js";

async function main() {
  const cfg = loadConfig();
  const warnings = authWarnings(cfg);
  if (cfg.auth.mode === "disabled") {
    const bar = "!".repeat(78);
    console.error([bar, ...warnings.map((w) => `!! ${w}`), bar].join("\n"));
  } else for (const w of warnings) console.error(w);
  // Before anything reads or writes the data: a second server on the same data root would lose updates.
  const lock = await acquireWriterLock(cfg.dataRoot, {
    waitMs: cfg.writerLockWaitSeconds * 1000,
    onLost: (holder) => {
      console.error(`writer lock on ${cfg.dataRoot} was taken over by ${holder}; stopping so two servers never write the same data`);
      process.exit(1);
    },
  });
  const t0 = performance.now();
  const { app, store } = await buildApp(cfg);
  const indexMs = Math.round(performance.now() - t0);
  store.startWatching();
  const stopRecurrence = cfg.recurrenceSeconds > 0
    ? startRecurrence(store, cfg.recurrenceSeconds * 1000, (msg, err) => app.log.warn({ err }, msg))
    : () => {};
  // Two servers that took over the same stale lock at the same moment: only the one whose file is in place goes on.
  if (!(await lock.owns())) throw new Error(`writer lock on ${cfg.dataRoot} was taken by another server during start-up`);
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    { projects: store.projects.size, broken: store.broken.length, diagnostics: store.diagnostics().length, indexMs, auth: cfg.auth.mode, loopback: isLoopback(cfg.host) },
    "Agents Project Dashboard ready",
  );
  const shutdown = async () => {
    stopRecurrence();
    await app.close();
    await lock.release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
});
