/**
 * Server configuration: optional JSON file (PCC_CONFIG or ./pcc.config.json) overridden by env vars.
 * No secret values live here; the auth token is read from a file whose path is configured.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseCidr } from "./netmatch.js";

export const DEFAULT_UPLOAD_TYPES: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".log"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
};

export const AUTH_MODES = ["required", "local-network", "disabled"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

const AuthModeSchema = z.preprocess(
  (v) => (v === "token" ? "required" : v), // "token" is the former name of "required"
  z.string().superRefine((v, ctx) => {
    if ((AUTH_MODES as readonly string[]).includes(v)) return;
    ctx.addIssue({
      code: "custom",
      message: v === "none"
        ? `auth.mode "none" was removed: use "local-network" with trustedNetworks (for example ["127.0.0.1/32","::1/128"]) or, deliberately, "disabled"`
        : `auth.mode must be one of ${AUTH_MODES.join(", ")}`,
    });
  }),
);

const ConfigSchema = z.object({
  productName: z.string().min(1).max(80).default("Agents Project Dashboard"),
  dataRoot: z.string().min(1),
  /** Additional project roots registered by the operator (absolute paths). Projects cannot register themselves here. */
  extraProjectRoots: z.array(z.string()).default([]),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8790),
  /** Directory with the built UI (vite build output). */
  webRoot: z.string().optional(),
  auth: z
    .object({
      /**
       * Dashboard login (ADR 0019). "required": every client signs in. "local-network": clients whose address is in
       * trustedNetworks need no login, all others sign in. "disabled": nobody signs in. Agent tokens are checked in
       * every mode.
       */
      mode: AuthModeSchema.default("required").transform((m) => m as AuthMode),
      /** File holding the access token (one line). Never logged. */
      tokenFile: z.string().optional(),
      /** CIDR ranges allowed in without login in "local-network" mode. Never inferred. */
      trustedNetworks: z.array(z.string()).default([]),
      /** Host names (Host header) usable for login-free access besides IP addresses and "localhost" (DNS rebinding). */
      allowedHosts: z.array(z.string().min(1).max(253)).default([]),
      /** Second opt-in for "disabled" on an address other machines can reach. */
      disabledOnNetwork: z.boolean().default(false),
      user: z.string().max(80).default("operator"),
      sessionHours: z.number().min(1).max(24 * 90).default(24 * 30),
    })
    .default({ mode: "required", trustedNetworks: [], allowedHosts: [], disabledOnNetwork: false, user: "operator", sessionHours: 720 }),
  /**
   * Addresses or CIDR ranges of reverse proxies whose X-Forwarded-For header is believed. Empty (default): the header
   * is ignored and the client address is the socket's.
   */
  trustedProxies: z.array(z.string()).default([]),
  /**
   * JSON file with scoped API tokens for agents and scripts. It holds SHA-256 hashes only, never tokens.
   * Scoped tokens are sent as `Authorization: Bearer <token>`; see docs/AGENT_INTEGRATION.md.
   */
  agentTokensFile: z.string().optional(),
  tls: z.object({ certFile: z.string(), keyFile: z.string() }).optional(),
  /** Set when a TLS-terminating reverse proxy is in front; marks cookies Secure. */
  behindHttpsProxy: z.boolean().default(false),
  /** Explicit opt-out of the HTTPS requirement for non-loopback binds (token travels in clear text). */
  allowInsecureRemote: z.boolean().default(false),
  uploads: z
    .object({
      maxBytes: z.number().int().min(1024).max(200 * 1024 * 1024).default(20 * 1024 * 1024),
      maxFiles: z.number().int().min(1).max(50).default(10),
      allowedMimeTypes: z.array(z.string()).optional(),
    })
    .default({ maxBytes: 20 * 1024 * 1024, maxFiles: 10 }),
  xlsx: z
    .object({ maxBytes: z.number().int().default(5 * 1024 * 1024), maxRows: z.number().int().default(5000) })
    .default({ maxBytes: 5 * 1024 * 1024, maxRows: 5000 }),
  watch: z.boolean().default(true),
  /** Periodic stat-based reconciliation in seconds (safety net for missed watcher events); 0 disables. */
  reconcileSeconds: z.number().int().min(0).default(60),
  /** How often recurring templates are checked for due occurrences, in seconds; 0 disables the scheduler. */
  recurrenceSeconds: z.number().int().min(0).default(60),
  /** How long a starting server waits for another server on the same data root to stop (ADR 0016). */
  writerLockWaitSeconds: z.number().int().min(0).max(600).default(35),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "silent"]).default("info"),
});
export type Config = z.infer<typeof ConfigSchema> & { allowedUploadTypes: Record<string, string[]> };

/** Mode-specific rules (ADR 0019). Nothing is inferred: trusted networks and proxies are only what is configured. */
function checkAuth(cfg: z.infer<typeof ConfigSchema>): void {
  const a = cfg.auth;
  if (a.mode === "required" && !a.tokenFile) {
    throw new Error(`auth.mode "required" (the default) needs auth.tokenFile (PCC_AUTH_TOKEN_FILE). For login-free access on this machine only, set auth.mode "local-network" with trustedNetworks ["127.0.0.1/32","::1/128"].`);
  }
  if (a.mode === "local-network") {
    if (!a.trustedNetworks.length) {
      throw new Error(`auth.mode "local-network" needs auth.trustedNetworks (PCC_TRUSTED_NETWORKS), for example 192.168.1.0/24; ranges are never detected automatically`);
    }
    for (const n of a.trustedNetworks) {
      const r = parseCidr(n);
      // /0 admits everyone; split halves (0.0.0.0/1 + 128.0.0.0/1) would do the same. No LAN or VPN needs more than /8.
      if (r.prefix === 0) throw new Error(`auth.trustedNetworks '${n}' admits every address; use auth.mode "disabled" if that is really intended`);
      if (r.prefix < 8) throw new Error(`auth.trustedNetworks '${n}' is wider than /8; list the networks clients really use`);
    }
  } else if (a.trustedNetworks.length) {
    throw new Error(`auth.trustedNetworks only applies to auth.mode "local-network" (mode is "${a.mode}")`);
  }
  if (a.mode === "disabled" && !isLoopback(cfg.host) && !a.disabledOnNetwork) {
    throw new Error(`Refusing to bind ${cfg.host} with auth.mode "disabled": every machine that reaches it would have full access. Bind 127.0.0.1, use "required" or "local-network", or confirm with auth.disabledOnNetwork (PCC_AUTH_DISABLED_ON_NETWORK=1).`);
  }
  for (const p of cfg.trustedProxies) {
    if (parseCidr(p).prefix === 0) throw new Error(`trustedProxies '${p}' would let any client forge its address; list the proxy's own address`);
  }
  for (const h of a.allowedHosts) {
    if (!/^[a-z0-9.-]+$/i.test(h)) throw new Error(`auth.allowedHosts '${h}': host names only (no port, scheme or wildcard)`);
  }
}

/** Lines printed prominently at start-up for modes that let clients in without signing in. */
export function authWarnings(cfg: Config): string[] {
  if (cfg.auth.mode === "disabled") {
    return [
      `AUTHENTICATION IS DISABLED (auth.mode "disabled").`,
      `Anyone who can reach ${cfg.host}:${cfg.port} can read, change and delete dashboard data, answer questions and upload files.`,
      isLoopback(cfg.host) ? "The server listens on this machine only." : `The server listens on ${cfg.host}: other machines can reach it.`,
      `Use auth.mode "required" or "local-network" unless this is a deliberate, isolated setup.`,
    ];
  }
  if (cfg.auth.mode === "local-network") {
    return [`Login-free access for ${cfg.auth.trustedNetworks.join(", ")} (auth.mode "local-network"); every other address must sign in.`];
  }
  return [];
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function loadConfig(overrides: Partial<z.input<typeof ConfigSchema>> = {}): Config {
  const file = process.env.PCC_CONFIG ?? path.resolve("pcc.config.json");
  let fromFile: Record<string, unknown> = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  const env: Record<string, unknown> = {};
  if (process.env.PCC_DATA_ROOT) env.dataRoot = process.env.PCC_DATA_ROOT;
  if (process.env.PCC_HOST) env.host = process.env.PCC_HOST;
  if (process.env.PCC_PORT) env.port = Number(process.env.PCC_PORT);
  if (process.env.PCC_WEB_ROOT) env.webRoot = process.env.PCC_WEB_ROOT;
  if (process.env.PCC_TLS_CERT || process.env.PCC_TLS_KEY) {
    if (!process.env.PCC_TLS_CERT || !process.env.PCC_TLS_KEY) throw new Error("set both PCC_TLS_CERT and PCC_TLS_KEY (or neither)");
    env.tls = { certFile: process.env.PCC_TLS_CERT, keyFile: process.env.PCC_TLS_KEY };
  }
  if (process.env.PCC_AGENT_TOKENS_FILE) env.agentTokensFile = process.env.PCC_AGENT_TOKENS_FILE;
  if (process.env.PCC_BEHIND_HTTPS_PROXY) env.behindHttpsProxy = process.env.PCC_BEHIND_HTTPS_PROXY === "1" || process.env.PCC_BEHIND_HTTPS_PROXY === "true";
  if (process.env.PCC_TRUSTED_PROXIES !== undefined) env.trustedProxies = list(process.env.PCC_TRUSTED_PROXIES);
  const authEnv: Record<string, unknown> = {};
  if (process.env.PCC_AUTH_MODE) authEnv.mode = process.env.PCC_AUTH_MODE;
  if (process.env.PCC_AUTH_TOKEN_FILE) authEnv.tokenFile = process.env.PCC_AUTH_TOKEN_FILE;
  if (process.env.PCC_TRUSTED_NETWORKS !== undefined) authEnv.trustedNetworks = list(process.env.PCC_TRUSTED_NETWORKS);
  if (process.env.PCC_ALLOWED_HOSTS !== undefined) authEnv.allowedHosts = list(process.env.PCC_ALLOWED_HOSTS);
  if (process.env.PCC_AUTH_DISABLED_ON_NETWORK) authEnv.disabledOnNetwork = process.env.PCC_AUTH_DISABLED_ON_NETWORK === "1" || process.env.PCC_AUTH_DISABLED_ON_NETWORK === "true";
  const merged = { ...fromFile, ...env, ...overrides } as Record<string, unknown>;
  if (Object.keys(authEnv).length) {
    merged.auth = { ...(fromFile.auth as object), ...authEnv, ...((overrides.auth as object | undefined) ?? {}) };
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const cfg = parsed.data;
  cfg.dataRoot = path.resolve(cfg.dataRoot);
  cfg.extraProjectRoots = cfg.extraProjectRoots.map((p) => path.resolve(p));
  const allowed = cfg.uploads.allowedMimeTypes
    ? Object.fromEntries(cfg.uploads.allowedMimeTypes.filter((m) => DEFAULT_UPLOAD_TYPES[m]).map((m) => [m, DEFAULT_UPLOAD_TYPES[m]]))
    : DEFAULT_UPLOAD_TYPES;

  checkAuth(cfg);
  if (!isLoopback(cfg.host) && !cfg.tls && !cfg.behindHttpsProxy && !cfg.allowInsecureRemote) {
    throw new Error(`Refusing to bind ${cfg.host} without HTTPS. Set tls.certFile/tls.keyFile (PCC_TLS_CERT/PCC_TLS_KEY), or behindHttpsProxy when a TLS proxy is in front, or allowInsecureRemote to accept clear-text tokens.`);
  }
  if (cfg.tls) {
    for (const f of [cfg.tls.certFile, cfg.tls.keyFile]) {
      if (!f || !fs.existsSync(f)) throw new Error(`TLS file not found: ${f ? path.basename(f) : "(unset)"} — set both PCC_TLS_CERT and PCC_TLS_KEY`);
    }
  }
  return { ...cfg, allowedUploadTypes: allowed };
}
