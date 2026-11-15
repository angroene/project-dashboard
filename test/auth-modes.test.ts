/**
 * Dashboard login modes (ADR 0019): "required", "local-network" and "disabled", applied to every API route, with
 * client addresses from the socket or from explicitly trusted proxies only, and agent tokens enforced in every mode.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { tokenSha256 } from "../src/server/auth.js";
import { authWarnings, loadConfig } from "../src/server/config.js";
import { makeApp, makeDataRoot, POST_HEADERS, writeJson } from "./helpers.js";

const OPERATOR = "operator-token-0123456789abcdef";
const READER = "reader-agent-token-0123456789abcd";
const PUBLISHER = "alpha-publisher-token-0123456789a";
const apps: { app: FastifyInstance }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });

interface Opts { mode: string; trustedNetworks?: string[]; trustedProxies?: string[]; allowedHosts?: string[]; operatorToken?: boolean }

async function server(o: Opts) {
  const root = makeDataRoot();
  const manifestFile = path.join(root, "projects", "alpha", "project.json");
  writeJson(manifestFile, { ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), publishing: { enabled: true, sections: ["tasks"] } });
  const tokenFile = path.join(root, "operator.txt");
  fs.writeFileSync(tokenFile, OPERATOR);
  const agentTokensFile = path.join(root, "agents.json");
  writeJson(agentTokensFile, { schemaVersion: 1, tokens: [
    { name: "reader", sha256: tokenSha256(READER), projects: ["alpha"], scopes: ["read"] },
    { name: "alpha-publisher", sha256: tokenSha256(PUBLISHER), projects: ["alpha"], scopes: ["read", "publish"] },
  ] });
  const auth: Record<string, unknown> = { mode: o.mode, trustedNetworks: o.trustedNetworks ?? [], allowedHosts: o.allowedHosts ?? [] };
  if (o.operatorToken !== false) auth.tokenFile = tokenFile;
  const h = await makeApp(root, { auth, agentTokensFile, trustedProxies: o.trustedProxies ?? [] });
  apps.push(h);
  const call = async (method: string, url: string, opt: { ip?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(method === "GET" ? {} : POST_HEADERS), ...(opt.headers ?? {}) };
    const r = await h.app.inject({ method: method as "GET", url, headers, remoteAddress: opt.ip ?? "127.0.0.1",
      ...(method === "GET" ? {} : { payload: JSON.stringify(opt.body ?? {}) }) });
    let body: Record<string, unknown> = {};
    try { body = r.body ? (r.json() as Record<string, unknown>) : {}; } catch { body = { raw: r.body.slice(0, 40) }; }
    return { status: r.statusCode, body, headers: r.headers };
  };
  const login = async (ip?: string) => {
    const r = await call("POST", "/api/auth/login", { ip, body: { token: OPERATOR } });
    expect(r.status).toBe(200);
    return String(r.headers["set-cookie"]).split(";")[0]!;
  };
  return { ...h, call, login };
}

const PARAMS: Record<string, string> = {
  projectId: "alpha", recordId: "T1", sectionId: "tasks", attachmentId: "ATT-1", eventId: "E9", templateId: "daily",
  answerId: "ANS-1", id: "QFILE",
};
const PUBLIC = new Set(["/api/session", "/api/auth/login", "/api/auth/logout"]);

/** Every API route the server registered (from Fastify's own route table), with path parameters filled in. */
function apiRoutes(app: FastifyInstance): { method: string; url: string; route: string }[] {
  const out: { method: string; url: string; route: string }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^([│ ]*)(?:├── |└── )(\S+) \(([^)]+)\)/.exec(line);
    if (!m) continue;
    stack.length = m[1]!.length / 4;
    stack.push(m[2]!);
    const route = stack.join("");
    if (!route.startsWith("/api/") || PUBLIC.has(route)) continue;
    for (const method of m[3]!.split(", ")) {
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      out.push({ method, route, url: route.replace(/:([A-Za-z]+)/g, (_, k: string) => PARAMS[k] ?? "x") });
    }
  }
  return out;
}

/** The live-update stream never ends for an admitted client; it is checked only for refusals. */
const finite = (r: { route: string }) => r.route !== "/api/updates";

describe("auth configuration", () => {
  const root = () => makeDataRoot();
  const tokenFile = (r: string) => { const f = path.join(r, "op.txt"); fs.writeFileSync(f, OPERATOR); return f; };

  it("defaults to required, which needs a token file; disabled is never the default", () => {
    const r = root();
    expect(() => loadConfig({ dataRoot: r } as never)).toThrow(/auth.mode "required" \(the default\) needs auth.tokenFile/);
    expect(loadConfig({ dataRoot: r, auth: { tokenFile: tokenFile(r) } } as never).auth.mode).toBe("required");
    expect(() => loadConfig({ dataRoot: r, auth: {} } as never)).toThrow(/needs auth.tokenFile/);
  });

  it("accepts the former name token, refuses none and unknown modes with a clear message", () => {
    const r = root();
    expect(loadConfig({ dataRoot: r, auth: { mode: "token", tokenFile: tokenFile(r) } } as never).auth.mode).toBe("required");
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "none" } } as never)).toThrow(/"none" was removed: use "local-network"/);
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "open" } } as never)).toThrow(/must be one of required, local-network, disabled/);
  });

  it("local-network needs explicit, valid, non-universal ranges; ranges only apply to that mode", () => {
    const r = root();
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "local-network" } } as never)).toThrow(/needs auth.trustedNetworks .* never detected automatically/);
    for (const bad of ["192.168.1.0/33", "192.168.1", "10.0.0.0/8/1", "fd00::/129", "lan", "10.0.0.0/x"]) {
      expect(() => loadConfig({ dataRoot: r, auth: { mode: "local-network", trustedNetworks: [bad] } } as never), bad).toThrow(bad);
    }
    for (const all of ["0.0.0.0/0", "::/0"]) {
      expect(() => loadConfig({ dataRoot: r, auth: { mode: "local-network", trustedNetworks: [all] } } as never), all).toThrow(/admits every address/);
    }
    // Split halves cover everything too.
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "local-network", trustedNetworks: ["0.0.0.0/1", "128.0.0.0/1"] } } as never)).toThrow(/wider than \/8/);
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "local-network", trustedNetworks: ["2000::/3"] } } as never)).toThrow(/wider than \/8/);
    expect(() => loadConfig({ dataRoot: r, auth: { mode: "required", tokenFile: tokenFile(r), trustedNetworks: ["10.0.0.0/8"] } } as never))
      .toThrow(/only applies to auth.mode "local-network"/);
    const ok = loadConfig({ dataRoot: r, auth: { mode: "local-network", trustedNetworks: ["192.168.1.0/24", "fd00::/8", "10.1.2.3"] } } as never);
    expect(ok.auth.trustedNetworks).toEqual(["192.168.1.0/24", "fd00::/8", "10.1.2.3"]);
  });

  it("refuses a proxy list that would trust everyone and malformed allowed hosts", () => {
    const r = root();
    const base = { dataRoot: r, auth: { mode: "required", tokenFile: tokenFile(r) } };
    expect(() => loadConfig({ ...base, trustedProxies: ["0.0.0.0/0"] } as never)).toThrow(/would let any client forge its address/);
    expect(() => loadConfig({ ...base, trustedProxies: ["proxy.lan"] } as never)).toThrow(/not an IP address/);
    expect(() => loadConfig({ ...base, auth: { ...base.auth, allowedHosts: ["*.lan"] } } as never)).toThrow(/host names only/);
    expect(() => loadConfig({ ...base, auth: { ...base.auth, allowedHosts: ["dash.lan:8790"] } } as never)).toThrow(/host names only/);
  });

  it("disabled on a reachable address needs a second explicit opt-in, and prints a prominent warning", () => {
    const r = root();
    expect(() => loadConfig({ dataRoot: r, host: "0.0.0.0", allowInsecureRemote: true, auth: { mode: "disabled" } } as never)).toThrow(/Refusing to bind 0.0.0.0 with auth.mode "disabled"/);
    const cfg = loadConfig({ dataRoot: r, host: "0.0.0.0", allowInsecureRemote: true, auth: { mode: "disabled", disabledOnNetwork: true } } as never);
    const w = authWarnings(cfg).join("\n");
    expect(w).toContain("AUTHENTICATION IS DISABLED");
    expect(w).toContain("other machines can reach it");
    expect(authWarnings(loadConfig({ dataRoot: r, auth: { mode: "disabled" } } as never)).join("\n")).toContain("this machine only");
    expect(authWarnings(loadConfig({ dataRoot: r, auth: { mode: "required", tokenFile: tokenFile(r) } } as never))).toEqual([]);
  });

  it("reads every setting from environment variables", () => {
    const r = root();
    const keys = ["PCC_AUTH_MODE", "PCC_TRUSTED_NETWORKS", "PCC_TRUSTED_PROXIES", "PCC_ALLOWED_HOSTS", "PCC_AUTH_DISABLED_ON_NETWORK", "PCC_AUTH_TOKEN_FILE"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, { PCC_AUTH_MODE: "local-network", PCC_TRUSTED_NETWORKS: "192.168.1.0/24, fd00::/8", PCC_TRUSTED_PROXIES: "10.0.0.2",
        PCC_ALLOWED_HOSTS: "dash.lan", PCC_AUTH_TOKEN_FILE: tokenFile(r) });
      const cfg = loadConfig({ dataRoot: r } as never);
      expect(cfg.auth).toMatchObject({ mode: "local-network", trustedNetworks: ["192.168.1.0/24", "fd00::/8"], allowedHosts: ["dash.lan"] });
      expect(cfg.trustedProxies).toEqual(["10.0.0.2"]);
      Object.assign(process.env, { PCC_AUTH_MODE: "disabled", PCC_TRUSTED_NETWORKS: "", PCC_AUTH_DISABLED_ON_NETWORK: "1" });
      expect(loadConfig({ dataRoot: r, host: "0.0.0.0", allowInsecureRemote: true } as never).auth.disabledOnNetwork).toBe(true);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe("required mode", () => {
  it("refuses every API route without a session, from any address, and admits a signed-in client", async () => {
    const s = await server({ mode: "required" });
    const routes = apiRoutes(s.app);
    expect(routes.length).toBeGreaterThanOrEqual(35);
    expect(routes.map((r) => `${r.method} ${r.route}`)).toEqual(expect.arrayContaining([
      "POST /api/projects/:projectId/uploads", "GET /api/projects/:projectId/attachments/:attachmentId",
      "PUT /api/projects/:projectId/records/:recordId", "POST /api/projects/:projectId/records/:recordId/user-update",
      "POST /api/admin/reindex", "GET /api/updates",
    ]));
    for (const ip of ["127.0.0.1", "192.168.1.9"]) {
      for (const r of routes) expect((await s.call(r.method, r.url, { ip })).status, `${r.method} ${r.url} from ${ip}`).toBe(401);
    }
    const cookie = await s.login();
    for (const r of routes.filter(finite)) expect((await s.call(r.method, r.url, { headers: { cookie } })).status, `${r.method} ${r.url}`).not.toBe(401);
    expect((await s.call("GET", "/api/session")).body).toMatchObject({ authMode: "required", authRequired: true, authenticated: false });
  });
});

describe("local-network mode", () => {
  const LAN = { mode: "local-network", trustedNetworks: ["10.0.0.0/8", "fd00::/8"] };

  it("admits trusted addresses without login on every route and refuses all others", async () => {
    const s = await server(LAN);
    const routes = apiRoutes(s.app);
    for (const ip of ["10.1.2.3", "::ffff:10.1.2.3", "fd00::5"]) {
      for (const r of routes.filter(finite)) expect((await s.call(r.method, r.url, { ip })).status, `${r.method} ${r.url} from ${ip}`).not.toBe(401);
    }
    for (const ip of ["192.168.1.9", "127.0.0.1", "11.0.0.1", "fe80::1"]) {
      for (const r of routes) expect((await s.call(r.method, r.url, { ip })).status, `${r.method} ${r.url} from ${ip}`).toBe(401);
    }
    expect((await s.call("GET", "/api/session", { ip: "10.1.2.3" })).body).toMatchObject({ authMode: "local-network", authRequired: false, authenticated: true });
    expect((await s.call("GET", "/api/session", { ip: "192.168.1.9" })).body).toMatchObject({ authRequired: true, authenticated: false });
    // Outside the trusted ranges the operator token still works.
    const cookie = await s.login("192.168.1.9");
    expect((await s.call("GET", "/api/projects", { ip: "192.168.1.9", headers: { cookie } })).status).toBe(200);
  });

  it("ignores X-Forwarded-For from clients when no proxy is configured", async () => {
    const s = await server(LAN);
    for (const xff of ["10.1.2.3", "10.1.2.3, 10.1.2.4", "fd00::1"]) {
      for (const r of apiRoutes(s.app)) {
        const res = await s.call(r.method, r.url, { ip: "192.168.1.9", headers: { "x-forwarded-for": xff, "x-real-ip": "10.1.2.3", forwarded: "for=10.1.2.3" } });
        expect(res.status, `${r.method} ${r.url} spoofing ${xff}`).toBe(401);
      }
    }
  });

  it("believes X-Forwarded-For only from a configured proxy, and only the address that proxy saw", async () => {
    const s = await server({ ...LAN, trustedProxies: ["192.168.1.2"] });
    const get = (ip: string, xff?: string) => s.call("GET", "/api/projects", { ip, headers: xff ? { "x-forwarded-for": xff } : {} });
    expect((await get("192.168.1.2", "10.1.2.3")).status).toBe(200); // the proxy reports a trusted client
    expect((await get("192.168.1.2", "8.8.8.8")).status).toBe(401); // the proxy reports an outside client
    // A client behind the proxy prepends a forged trusted address: the proxy appends the real one, which counts.
    expect((await get("192.168.1.2", "10.1.2.3, 8.8.8.8")).status).toBe(401);
    expect((await get("192.168.1.2")).status).toBe(401); // the proxy itself is not a trusted network
    expect((await get("192.168.1.3", "10.1.2.3")).status).toBe(401); // another machine is not the proxy
    // Uploads behind the proxy follow the same rule.
    expect((await s.call("POST", "/api/projects/alpha/uploads", { ip: "192.168.1.2", headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(401);
  });

  it("refuses login-free access for an unknown Host name (DNS rebinding) unless it is allowed", async () => {
    const s = await server({ ...LAN, allowedHosts: ["dash.lan"] });
    const get = (host: string) => s.call("GET", "/api/projects", { ip: "10.1.2.3", headers: { host } });
    expect((await get("attacker.example")).status).toBe(401);
    expect((await get("attacker.example:8790")).status).toBe(401);
    expect((await get("dash.lan:8790")).status).toBe(200);
    expect((await get("DASH.LAN")).status).toBe(200);
    expect((await get("10.0.0.5:8790")).status).toBe(200);
    expect((await get("[fd00::5]:8790")).status).toBe(200);
    expect((await get("localhost:8790")).status).toBe(200);
    expect((await get("[::1")).status).toBe(401); // malformed IPv6 literal
  });

  it("without an operator token, outside clients cannot sign in", async () => {
    const s = await server({ ...LAN, operatorToken: false });
    const r = await s.call("POST", "/api/auth/login", { ip: "192.168.1.9", body: { token: OPERATOR } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("login-unavailable");
    expect((await s.call("GET", "/api/projects", { ip: "192.168.1.9" })).status).toBe(401);
  });
});

describe("disabled mode", () => {
  it("admits every address on every route, keeps the CSRF guard and reports the mode", async () => {
    const s = await server({ mode: "disabled", operatorToken: false });
    for (const ip of ["127.0.0.1", "8.8.8.8", "2001:db8::1"]) {
      for (const r of apiRoutes(s.app).filter(finite)) expect((await s.call(r.method, r.url, { ip })).status, `${r.method} ${r.url} from ${ip}`).not.toBe(401);
    }
    const noCsrf = await s.app.inject({ method: "PUT", url: "/api/projects/alpha/progress", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(noCsrf.statusCode).toBe(403);
    expect((await s.call("GET", "/api/session")).body).toMatchObject({ authMode: "disabled", authRequired: false });
    expect((await s.call("GET", "/api/projects", { headers: { host: "attacker.example" } })).status).toBe(401);
  });
});

describe("agent tokens in every mode", () => {
  const MODES: Opts[] = [
    { mode: "required" },
    { mode: "local-network", trustedNetworks: ["127.0.0.0/8"] },
    { mode: "disabled", operatorToken: false },
  ];
  for (const m of MODES) {
    it(`${m.mode}: scopes and project limits apply, unknown tokens are refused`, async () => {
      const s = await server(m);
      const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
      // An unknown token is refused even where the dashboard needs no login: it is never treated as "no token".
      expect((await s.call("GET", "/api/projects", { headers: bearer("not-a-token-0123456789") })).status).toBe(401);
      expect((await s.call("GET", "/api/projects/alpha", { headers: bearer(READER) })).status).toBe(200);
      const put = await s.call("PUT", "/api/projects/alpha/progress", { headers: bearer(READER), body: { progress: { overallPercent: 5, label: "x", method: "y" } } });
      expect(put.status).toBe(403);
      expect(String(put.body.message)).toContain("lacks the 'publish' scope");
      expect((await s.call("GET", "/api/projects/beta", { headers: bearer(PUBLISHER) })).status).toBe(404);
      expect((await s.call("POST", "/api/admin/reindex", { headers: bearer(PUBLISHER) })).status).toBe(403);
      expect((await s.call("POST", "/api/projects/alpha/records/T1/user-update", { headers: bearer(PUBLISHER), body: {} })).status).toBe(403);
      const ok = await s.call("PUT", "/api/projects/alpha/progress", { headers: bearer(PUBLISHER), body: { progress: { overallPercent: 5, label: "x", method: "y" } } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
  }
});
