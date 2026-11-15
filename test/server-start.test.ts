/** The real server entry point (src/server/main.ts) as a process: it takes the writer lock before serving. */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE } from "../src/server/datalock.js";

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function start(dataRoot: string, waitSeconds: number) {
  const port = await freePort();
  const config = path.join(dataRoot, "..", `config-${path.basename(dataRoot)}.json`);
  fs.writeFileSync(config, JSON.stringify({ dataRoot, port, watch: false, recurrenceSeconds: 0, writerLockWaitSeconds: waitSeconds, logLevel: "info",
    auth: { mode: "local-network", trustedNetworks: ["127.0.0.1/32"] } }));
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/server/main.ts")], {
    env: { ...process.env, PCC_CONFIG: config, PCC_DATA_ROOT: "", PCC_PORT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const exited = new Promise<number>((r) => child.on("exit", (code) => r(code ?? -1)));
  return { child, exited, output: () => out };
}

describe("server start-up", () => {
  it("refuses to start while another server holds the data root, and takes the lock when it is free", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "apd-start-"));
    const root = path.join(base, "data");
    fs.mkdirSync(path.join(root, "projects"), { recursive: true });

    // Another live server's lock (fresh): this one must give up after its wait.
    fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify({ pid: 4242, host: "other-host", startedAt: "2026-01-01T00:00:00Z", token: "t" }));
    const refused = await start(root, 1);
    const code = await Promise.race([refused.exited, new Promise<number>((r) => setTimeout(() => r(-2), 20_000))]);
    if (code === -2) refused.child.kill();
    expect(code, refused.output()).toBe(1);
    expect(refused.output()).toContain("in use by another server (pid 4242 on other-host");

    fs.rmSync(path.join(root, LOCK_FILE));
    const ok = await start(root, 1);
    try {
      const deadline = Date.now() + 20_000;
      while (!ok.output().includes("Agents Project Dashboard ready") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(ok.output()).toContain("Agents Project Dashboard ready");
      expect(JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), "utf8")).pid).toBe(ok.child.pid);
    } finally {
      ok.child.kill();
      await ok.exited;
    }
  }, 60_000);
});
