/** Remote-exposure rules and built-in HTTPS. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeDataRoot, tmpRoot } from "./helpers.js";
import { loadConfig } from "../src/server/config.js";
import { buildApp } from "../src/server/app.js";

function hasOpenssl(): boolean {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe("remote exposure", () => {
  it("refuses a non-loopback bind with a token but without HTTPS", () => {
    const root = makeDataRoot();
    const tokenFile = path.join(root, "token.txt");
    fs.writeFileSync(tokenFile, "x".repeat(32));
    expect(() => loadConfig({ dataRoot: root, host: "0.0.0.0", auth: { mode: "token", tokenFile } } as never)).toThrow(/without HTTPS/);
    expect(() => loadConfig({ dataRoot: root, host: "0.0.0.0", behindHttpsProxy: true, auth: { mode: "token", tokenFile } } as never)).not.toThrow();
    expect(() => loadConfig({ dataRoot: root, host: "0.0.0.0", allowInsecureRemote: true, auth: { mode: "token", tokenFile } } as never)).not.toThrow();
  });

  it("names a missing TLS file without leaking its directory", () => {
    const root = makeDataRoot();
    expect(() => loadConfig({ dataRoot: root, tls: { certFile: path.join(root, "nope.pem"), keyFile: path.join(root, "k.pem") } } as never))
      .toThrow(/TLS file not found: nope\.pem/);
  });

  it.skipIf(!hasOpenssl())("serves HTTPS with a Secure session cookie", async () => {
    const root = makeDataRoot();
    const dir = tmpRoot();
    const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const tokenFile = path.join(dir, "token.txt");
    fs.writeFileSync(tokenFile, "test-token-0123456789abcdef");
    const cfg = loadConfig({ dataRoot: root, watch: false, reconcileSeconds: 0, logLevel: "silent", tls: { certFile: cert, keyFile: key }, auth: { mode: "token", tokenFile } } as never);
    const { app } = await buildApp(cfg, { logger: false });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as { port: number }).port;
      const res = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        const req = https.request({ host: "127.0.0.1", port, path: "/api/auth/login", method: "POST", rejectUnauthorized: false,
          headers: { "content-type": "application/json", "x-pcc-request": "1" } }, (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0, cookie: String(r.headers["set-cookie"] ?? "") });
        });
        req.on("error", reject);
        req.end(JSON.stringify({ token: "test-token-0123456789abcdef" }));
      });
      expect(res.status).toBe(200);
      expect(res.cookie).toMatch(/Secure/);
      expect(res.cookie).toMatch(/HttpOnly/);
    } finally {
      await app.close();
    }
  });
});
