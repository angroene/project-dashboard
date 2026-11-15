/**
 * Access control. Loopback-only deployments may run without auth; any other bind needs a token
 * (read from a file, never logged) exchanged for an HttpOnly, SameSite=Strict session cookie.
 * State-changing requests additionally need `X-PCC-Request: 1` and a same-origin Origin header.
 *
 * Scripts and agents may instead send `Authorization: Bearer <token>`: either the operator token (full access, same as
 * a browser session) or a scoped agent token from `agentTokensFile`, limited to listed projects and scopes.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id } from "../shared/schemas.js";
import type { Config } from "./config.js";

const COOKIE = "pcc_session";
const PUBLIC_ROUTES = new Set(["/api/session", "/api/auth/login", "/api/auth/logout"]);
const MAX_SESSIONS = 1000;
const MAX_FAILURE_ENTRIES = 10_000;

export const AGENT_SCOPES = ["read", "publish", "consume"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const AgentTokensFile = z.object({
  schemaVersion: z.literal(1),
  tokens: z.array(z.object({
    // The name is written into history entries; "user…" is reserved for the dashboard user (ADR 0015).
    name: z.string().regex(/^[A-Za-z0-9._:@-]{1,60}$/)
      .refine((n) => !n.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith("user"), "token names must not start with \"user\" (reserved for the dashboard user)"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Project ids this token may use; "*" = every project on the server. */
    projects: z.array(z.union([Id, z.literal("*")])).min(1).max(200),
    scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  })).max(500),
}).superRefine((f, ctx) => {
  const names = new Set<string>();
  const hashes = new Set<string>();
  for (const t of f.tokens) {
    if (names.has(t.name)) ctx.addIssue({ code: "custom", message: `duplicate token name '${t.name}'` });
    if (hashes.has(t.sha256)) ctx.addIssue({ code: "custom", message: `token '${t.name}' reuses another token's hash` });
    names.add(t.name);
    hashes.add(t.sha256);
  }
});

export interface AgentGrant {
  name: string;
  projects: ReadonlySet<string>;
  scopes: ReadonlySet<AgentScope>;
}

/**
 * Which scope an agent token needs for a routed API path. Anything not listed (answering questions, read state,
 * Excel, ZIP, diagnostics, reindex, the live-update stream) is reserved for the operator.
 */
const AGENT_ROUTES: Record<string, AgentScope> = {
  "GET /api/projects": "read",
  "GET /api/projects/:projectId": "read",
  "GET /api/projects/:projectId/capabilities": "read",
  "GET /api/projects/:projectId/navigation": "read",
  "GET /api/projects/:projectId/sections/:sectionId/records": "read",
  "GET /api/projects/:projectId/records/:recordId": "read",
  "GET /api/projects/:projectId/records/:recordId/source": "read",
  "GET /api/projects/:projectId/progress": "read",
  "GET /api/projects/:projectId/activity": "read",
  "GET /api/projects/:projectId/attention": "read",
  "GET /api/projects/:projectId/attachments/:attachmentId": "read",
  "GET /api/projects/:projectId/queue": "read",
  "GET /api/projects/:projectId/queue/:answerId": "read",
  "GET /api/projects/:projectId/templates": "read",
  "PUT /api/projects/:projectId/records/:recordId": "publish",
  "PATCH /api/projects/:projectId/records/:recordId": "publish",
  "PUT /api/projects/:projectId/activity/:eventId": "publish",
  "PUT /api/projects/:projectId/progress": "publish",
  "POST /api/projects/:projectId/uploads": "publish",
  "POST /api/projects/:projectId/queue/claim": "consume",
  "POST /api/projects/:projectId/queue/:answerId/complete": "consume",
  "POST /api/projects/:projectId/queue/:answerId/fail": "consume",
  "POST /api/projects/:projectId/queue/recover": "consume",
};

const agentOfRequest = new WeakMap<FastifyRequest, AgentGrant>();

/** The scoped agent behind this request, or undefined for the operator (session, operator token or no-auth mode). */
export function agentOf(req: FastifyRequest): AgentGrant | undefined {
  return agentOfRequest.get(req);
}

export function agentMayUseProject(grant: AgentGrant | undefined, projectId: string): boolean {
  return !grant || grant.projects.has("*") || grant.projects.has(projectId);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

export class Auth {
  private tokenHash: Buffer | null = null;
  private agents: { hash: Buffer; grant: AgentGrant }[] = [];
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly cfg: Config) {
    if (cfg.auth.mode === "token") {
      const token = fs.readFileSync(cfg.auth.tokenFile!, "utf8").trim();
      if (token.length < 16) throw new Error("auth token in tokenFile must be at least 16 characters");
      this.tokenHash = sha256(token);
    }
    if (cfg.agentTokensFile) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(cfg.agentTokensFile, "utf8"));
      } catch (e) {
        throw new Error(`agentTokensFile unreadable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
      const parsed = AgentTokensFile.safeParse(raw);
      if (!parsed.success) throw new Error(`agentTokensFile invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      this.agents = parsed.data.tokens.map((t) => ({
        hash: Buffer.from(t.sha256, "hex"),
        grant: { name: t.name, projects: new Set(t.projects), scopes: new Set(t.scopes) },
      }));
      if (this.tokenHash && this.agents.some((a) => a.hash.equals(this.tokenHash!))) {
        throw new Error("agentTokensFile: an agent token must not equal the operator token");
      }
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

  private throttled(ip: string): boolean {
    const f = this.failures.get(ip);
    return !!f && f.until > Date.now();
  }

  private recordFailure(ip: string): void {
    if (this.failures.size > MAX_FAILURE_ENTRIES) this.failures.clear();
    const count = (this.failures.get(ip)?.count ?? 0) + 1;
    this.failures.set(ip, { count, until: count >= 5 ? Date.now() + Math.min(300_000, 2 ** (count - 5) * 15_000) : 0 });
  }

  register(app: FastifyInstance): void {
    app.post("/api/auth/login", async (req, reply) => {
      if (!this.required) return { ok: true };
      const ip = req.ip;
      if (this.throttled(ip)) return reply.code(429).send({ error: "rate-limited", message: "too many attempts; wait and retry" });
      const token = (req.body as { token?: unknown } | undefined)?.token;
      const ok = typeof token === "string" && token.length < 1024 && crypto.timingSafeEqual(sha256(token.trim()), this.tokenHash!);
      if (!ok) {
        this.recordFailure(ip);
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

  /** Resolves a bearer token: "operator", an agent grant, or null when it matches nothing. Constant-time per entry. */
  private bearer(token: string): "operator" | AgentGrant | null {
    if (token.length >= 1024) return null;
    const h = sha256(token);
    let found: "operator" | AgentGrant | null = null;
    if (this.tokenHash && crypto.timingSafeEqual(h, this.tokenHash)) found = "operator";
    for (const a of this.agents) if (crypto.timingSafeEqual(h, a.hash)) found = a.grant;
    return found;
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
    const authz = req.headers.authorization;
    if (this.required && typeof authz === "string" && /^bearer /i.test(authz)) {
      if (this.throttled(req.ip)) return void reply.code(429).send({ error: "rate-limited", message: "too many attempts; wait and retry" });
      const who = this.bearer(authz.slice(7).trim());
      if (!who) {
        this.recordFailure(req.ip);
        return void reply.code(401).send({ error: "unauthorized", message: "unknown bearer token" });
      }
      if (who === "operator") return;
      const scope = AGENT_ROUTES[`${method === "HEAD" ? "GET" : method} ${route}`];
      if (!scope) return void reply.code(403).send({ error: "forbidden", message: `token '${who.name}' may not call this endpoint` });
      if (!who.scopes.has(scope)) return void reply.code(403).send({ error: "forbidden", message: `token '${who.name}' lacks the '${scope}' scope` });
      const pid = (req.params as { projectId?: string } | undefined)?.projectId;
      // Same answer as for a project that does not exist, so a token cannot probe other projects' ids.
      if (pid !== undefined && !agentMayUseProject(who, pid)) return void reply.code(404).send({ error: "not-found", message: `project ${pid} not found or unavailable` });
      agentOfRequest.set(req, who);
      return;
    }
    if (!this.isAuthenticated(req)) return void reply.code(401).send({ error: "unauthorized", message: "sign in required" });
  };
}

/** Hex SHA-256 of a token, as stored in agentTokensFile. */
export function tokenSha256(token: string): string {
  return sha256(token.trim()).toString("hex");
}
