import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/agent-token.ts");
const run = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", SCRIPT, ...args], { timeout: 30000 }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
  });

describe("agent-token script", () => {
  it("refuses names that read as the dashboard user's and writes no token file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apd-tok-"));
    for (const name of ["user", "user-ci", "User2", "u.s.e.r"]) {
      const out = path.join(dir, `${name}.token`);
      const r = await run([name, out, "--projects", "alpha", "--scopes", "read"]);
      expect(r.code, name).toBe(2);
      expect(r.stderr, name).toContain(`name '${name}' must not start with "user"`);
      expect(r.stderr, name).toContain("choose another name");
      expect(fs.existsSync(out), name).toBe(false);
    }
  });

  it("creates a token for a valid name; the entry loads on the server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apd-tok-"));
    const out = path.join(dir, "ci-user.token");
    const r = await run(["ci-user", out, "--projects", "alpha", "--scopes", "read,publish"]);
    expect(r.code, r.stderr).toBe(0);
    const entry = JSON.parse(r.stdout) as { name: string; sha256: string };
    expect(entry.name).toBe("ci-user");
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(out, "utf8").trim().length).toBeGreaterThan(20);
  });
});
