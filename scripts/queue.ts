/**
 * Answer-queue utility for external consumers (works on the files directly; no server needed).
 *   npx tsx scripts/queue.ts <dataRoot> <projectId> list
 *   npx tsx scripts/queue.ts <dataRoot> <projectId> claim <owner> [leaseSeconds]
 *   npx tsx scripts/queue.ts <dataRoot> <projectId> complete <answerId> <owner> [note]
 *   npx tsx scripts/queue.ts <dataRoot> <projectId> fail <answerId> <owner> <reason> [--retry]
 *   npx tsx scripts/queue.ts <dataRoot> <projectId> recover
 * Output is JSON on stdout. Same lock/rename protocol as the server, so both can run at once.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store, ANSWERS_DIR } from "../src/server/store.js";
import { claimNext, completeAnswer, failAnswer, recoverExpiredLeases } from "../src/server/answers.js";
import { PROCESSING_STATES } from "../src/shared/schemas.js";

const [dataRoot, projectId, cmd, ...rest] = process.argv.slice(2);
if (!dataRoot || !projectId || !cmd) {
  console.error("usage: queue.ts <dataRoot> <projectId> list|claim|complete|fail|recover ...");
  process.exit(2);
}
const store = new Store(loadConfig({ dataRoot, watch: false, reconcileSeconds: 0 } as never));
await store.init();
const p = store.get(projectId);
if (!p) {
  console.error(`project ${projectId} not found`);
  process.exit(2);
}
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
switch (cmd) {
  case "list": {
    const out: Record<string, string[]> = {};
    for (const st of PROCESSING_STATES) {
      const dir = path.join(p.dir, ANSWERS_DIR, st);
      out[st] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
    }
    print(out);
    break;
  }
  case "claim":
    print(await claimNext(store, p, rest[0] ?? "cli", Number(rest[1] ?? 600)));
    break;
  case "complete":
    print(await completeAnswer(store, p, rest[0], rest[1], rest[2]));
    break;
  case "fail":
    print(await failAnswer(store, p, rest[0], rest[1], rest[2] ?? "failed", rest.includes("--retry")));
    break;
  case "recover":
    print({ recovered: await recoverExpiredLeases(store, p) });
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
