/**
 * Access control. Loopback-only deployments may run without auth; any other bind needs a token
 * (read from a file, never logged) exchanged for an HttpOnly, SameSite=Strict session cookie.
 * State-changing requests additionally need `X-PCC-Request: 1` and a same-origin Origin header.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

const COOKIE = "pcc_session";
const PUBLIC_ROUTES = new Set(["/api/session", "/api/auth/login", "/api/auth/logout"]);
const MAX_SESSIONS = 1000;
const MAX_FAILURE_ENTRIES = 10_000;

export class Auth {
  private tokenHash: Buffer | null = null;
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly cfg: Config) {
    if (cfg.auth.mode === "token") {
      const token = fs.readFileSync(cfg.auth.tokenFile!, "utf8").trim();
      if (token.length < 16) throw new Error("auth token in tokenFile must be at least 16 characters");
      this.tokenHash = crypto.createHash("sha256").update(token).digest();
    }
  }

  get required(): boolean {
    return this.cfg.auth.mode === "token";
  }

  isAuthenticated(req: FastifyRequest): boolean {
    if (!this.required) return true;
    const sid = req.cookies?.[COOKIE];
    if (!sid) return false;
    const exp = this.sessions.get(sid);
    if (!exp) return false;
    if (exp < Date.now()) { this.sessions.delete(sid); return false; }
    return true;
  }

  private secureCookie(): boolean {
    return !!this.cfg.tls || this.cfg.behindHttpsProxy;
  }

  register(app: FastifyInstance): void {
    app.post("/api/auth/login", async (req, reply) => {
      if (!this.required) return { ok: true };
      const ip = req.ip;
      const f = this.failures.get(ip);
      if (f && f.until > Date.now()) return reply.code(429).send({ error: "rate-limited", message: "too many attempts; wait and retry" });
      const token = (req.body as { token?: unknown } | undefined)?.token;
      const ok = typeof token === "string" && token.length < 1024 &&
        crypto.timingSafeEqual(crypto.createHash("sha256").update(token.trim()).digest(), this.tokenHash!);
      if (!ok) {
        if (this.failures.size > MAX_FAILURE_ENTRIES) this.failures.clear();
        const count = (f?.count ?? 0) + 1;
        this.failures.set(ip, { count, until: count >= 5 ? Date.now() + Math.min(300_000, 2 ** (count - 5) * 15_000) : 0 });
        return reply.code(401).send({ error: "unauthorized", message: "wrong access token" });
      }
      this.failures.delete(ip);
      const sid = crypto.randomBytes(32).toString("base64url");
      const ms = this.cfg.auth.sessionHours * 3_600_000;
      for (const [k, exp] of this.sessions) if (exp < Date.now()) this.sessions.delete(k);
      while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(sid, Date.now() + ms);
      reply.setCookie(COOKIE, sid, { httpOnly: true, sameSite: "strict", secure: this.secureCookie(), path: "/", maxAge: Math.floor(ms / 1000) });
      return { ok: true };
    });
    app.post("/api/auth/logout", async (req, reply) => {
      const sid = req.cookies?.[COOKIE];
      if (sid) this.sessions.delete(sid);
      reply.clearCookie(COOKIE, { path: "/" });
      return { ok: true };
    });
  }

  /** onRequest guard for /api routes. */
  guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Decide on the *routed* pattern (already decoded/normalised by the router), never on the raw URL:
    // "/%61pi/projects" routes to "/api/projects" and must be guarded the same way.
    const route = req.routeOptions?.url ?? "";
    let decoded = "";
    try { decoded = decodeURIComponent(req.url.split("?")[0]).toLowerCase(); } catch { decoded = req.url.toLowerCase(); }
    const isApi = route.startsWith("/api/") || route === "/api" || decoded.startsWith("/api");
    const method = req.method.toUpperCase();
    // CSRF guard applies to every state-changing request, API or not (static routes have no POST handlers anyway).
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      if (req.headers["x-pcc-request"] !== "1") {
        return void reply.code(403).send({ error: "csrf", message: "missing X-PCC-Request header" });
      }
      const origin = req.headers.origin;
      if (origin && origin !== "null") {
        let host: string;
        try { host = new URL(origin).host; } catch { host = ""; }
        if (host !== req.headers.host) return void reply.code(403).send({ error: "csrf", message: "cross-origin request rejected" });
      }
    }
    if (!isApi) return; // the static UI shell is public; it holds no project data
    if (PUBLIC_ROUTES.has(route)) return;
    if (!this.isAuthenticated(req)) return void reply.code(401).send({ error: "unauthorized", message: "sign in required" });
  };
}
