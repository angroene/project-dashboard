/**
 * One server process per data root. Record updates are read-modify-write under an in-process lock, so two servers on
 * the same data would silently lose updates. The writer lock turns that into a clear start-up error.
 *
 * The lock is `<dataRoot>/.apd-writer.lock` (owner pid, host, start time and a random token). The owner refreshes its
 * modification time every `heartbeatMs`; a lock not refreshed for `staleMs` belongs to a process that is gone (crash,
 * killed container) and is taken over. A starting server waits up to `staleMs` plus a margin for a live owner to stop,
 * which covers an upgrade where the old container is still shutting down.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCK_FILE = ".apd-writer.lock";

export interface WriterLock {
  file: string;
  token: string;
  /** True while the lock file is still this process's own. */
  owns(): Promise<boolean>;
  /** Stops the heartbeat and removes the lock if this process still owns it. */
  release(): Promise<void>;
}

export interface LockOptions {
  staleMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
  /** Called when the lock was taken by another process while this one runs (it must stop writing). */
  onLost?: (holder: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class DataRootInUse extends Error {}

const describe = (text: string) => {
  try {
    const o = JSON.parse(text) as { pid?: number; host?: string; startedAt?: string };
    return `pid ${o.pid ?? "?"} on ${o.host ?? "?"} since ${o.startedAt ?? "?"}`;
  } catch {
    return "an unreadable lock file";
  }
};

export async function acquireWriterLock(dataRoot: string, opts: LockOptions = {}): Promise<WriterLock> {
  const staleMs = opts.staleMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const waitMs = opts.waitMs ?? staleMs + 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const file = path.join(dataRoot, LOCK_FILE);
  const token = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), token }) + "\n";
  await fsp.mkdir(dataRoot, { recursive: true });

  const deadline = now() + waitMs;
  for (;;) {
    try {
      await fsp.writeFile(file, body, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let st: fs.Stats;
    let text = "";
    try {
      st = await fsp.stat(file);
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue; // removed meanwhile: try again
    }
    if (now() - st.mtimeMs > staleMs) {
      // Take over a stale lock by renaming our own file over it; re-check below that nobody else did the same.
      const tmp = `${file}.${token}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
      await sleep(50);
      if ((await fsp.readFile(file, "utf8").catch(() => "")) === body) break;
      continue;
    }
    if (now() >= deadline) {
      throw new DataRootInUse(`data root ${dataRoot} is in use by another server (${describe(text)}); stop it first, or remove ${file} if that server is gone`);
    }
    await sleep(Math.min(1_000, Math.max(50, Math.floor(staleMs / 10))));
  }

  let lost = false;
  const beat = async () => {
    if (lost) return;
    const text = await fsp.readFile(file, "utf8").catch(() => "");
    if (text !== body) {
      lost = true;
      clearInterval(timer);
      opts.onLost?.(text ? describe(text) : "nobody (the lock file was removed)");
      return;
    }
    const t = new Date(now());
    await fsp.utimes(file, t, t).catch(() => undefined);
  };
  const timer = setInterval(() => void beat(), heartbeatMs);
  timer.unref();
  return {
    file,
    token,
    async owns() {
      return !lost && (await fsp.readFile(file, "utf8").catch(() => "")) === body;
    },
    async release() {
      clearInterval(timer);
      if (lost) return;
      const text = await fsp.readFile(file, "utf8").catch(() => "");
      if (text === body) await fsp.rm(file, { force: true });
    },
  };
}
