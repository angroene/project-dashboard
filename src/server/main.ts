import { buildApp } from "./app.js";
import { isLoopback, loadConfig } from "./config.js";
import { startRecurrence } from "./recurrence.js";

async function main() {
  const cfg = loadConfig();
  const t0 = performance.now();
  const { app, store } = await buildApp(cfg);
  const indexMs = Math.round(performance.now() - t0);
  store.startWatching();
  const stopRecurrence = cfg.recurrenceSeconds > 0
    ? startRecurrence(store, cfg.recurrenceSeconds * 1000, (msg, err) => app.log.warn({ err }, msg))
    : () => {};
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    { projects: store.projects.size, broken: store.broken.length, diagnostics: store.diagnostics().length, indexMs, auth: cfg.auth.mode, loopback: isLoopback(cfg.host) },
    "Agents Project Dashboard ready",
  );
  const shutdown = async () => {
    stopRecurrence();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
});
