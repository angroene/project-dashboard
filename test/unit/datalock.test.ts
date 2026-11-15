import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriterLock, DataRootInUse, LOCK_FILE } from "../../src/server/datalock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "apd-lock-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("writer lock (one server per data root)", () => {
  it("refuses a second server while the first one is alive, with who holds it", async () => {
    const root = tmp();
    const first = await acquireWriterLock(root, { staleMs: 400, heartbeatMs: 50 });
    const second = acquireWriterLock(root, { staleMs: 400, heartbeatMs: 50, waitMs: 600 });
    await expect(second).rejects.toBeInstanceOf(DataRootInUse);
    await expect(second).rejects.toThrow(`pid ${process.pid}`);
    await first.release();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
  });

  it("lets the next server start once the first released the lock, even while it waits", async () => {
    const root = tmp();
    const first = await acquireWriterLock(root, { staleMs: 2000, heartbeatMs: 100 });
    const next = acquireWriterLock(root, { staleMs: 2000, heartbeatMs: 100, waitMs: 3000 });
    await wait(200);
    await first.release();
    const lock = await next;
    expect(fs.readFileSync(lock.file, "utf8")).toContain(lock.token);
    await lock.release();
  });

  it("takes over a lock left behind by a process that is gone, and the old owner learns it lost the lock", async () => {
    const root = tmp();
    let lostTo = "";
    const old = await acquireWriterLock(root, { staleMs: 300, heartbeatMs: 60_000, onLost: (h) => { lostTo = h; } });
    // The old owner stops refreshing (crashed): its lock goes stale.
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(old.file, past, past);
    const fresh = await acquireWriterLock(root, { staleMs: 300, heartbeatMs: 60_000, waitMs: 100 });
    expect(fs.readFileSync(fresh.file, "utf8")).toContain(fresh.token);
    expect(await fresh.owns()).toBe(true);
    expect(await old.owns()).toBe(false);
    await old.release(); // must not remove the new owner's lock
    expect(fs.readFileSync(fresh.file, "utf8")).toContain(fresh.token);
    await fresh.release();
    expect(lostTo).toBe(""); // heartbeat never ran (60 s); release alone does not report
  });

  it("an owner whose lock was replaced stops (onLost) at its next heartbeat", async () => {
    const root = tmp();
    let lost = "";
    const lock = await acquireWriterLock(root, { staleMs: 5000, heartbeatMs: 40, onLost: (h) => { lost = h; } });
    fs.writeFileSync(lock.file, JSON.stringify({ pid: 4242, host: "other-host", startedAt: "2026-01-01T00:00:00Z", token: "x" }));
    await wait(200);
    expect(lost).toContain("pid 4242 on other-host");
    await lock.release();
    expect(fs.existsSync(lock.file)).toBe(true); // not ours any more: left alone
  });

  it("keeps a live lock fresh with its heartbeat", async () => {
    const root = tmp();
    const lock = await acquireWriterLock(root, { staleMs: 300, heartbeatMs: 50 });
    await wait(600);
    // Older than staleMs since creation, but refreshed: still refuses others.
    await expect(acquireWriterLock(root, { staleMs: 300, heartbeatMs: 50, waitMs: 100 })).rejects.toBeInstanceOf(DataRootInUse);
    await lock.release();
  });
});
