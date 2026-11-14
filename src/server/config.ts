/**
 * Server configuration: optional JSON file (PCC_CONFIG or ./pcc.config.json) overridden by env vars.
 * No secret values live here; the auth token is read from a file whose path is configured.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
      mode: z.enum(["none", "token"]).default("none"),
      /** File holding the access token (one line). Never logged. */
      tokenFile: z.string().optional(),
      user: z.string().max(80).default("operator"),
      sessionHours: z.number().min(1).max(24 * 90).default(24 * 30),
    })
    .default({ mode: "none", user: "operator", sessionHours: 720 }),
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
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "silent"]).default("info"),
});
export type Config = z.infer<typeof ConfigSchema> & { allowedUploadTypes: Record<string, string[]> };

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
  const merged = { ...fromFile, ...env, ...overrides } as Record<string, unknown>;
  if (process.env.PCC_AUTH_TOKEN_FILE) {
    merged.auth = { ...(merged.auth as object), mode: "token", tokenFile: process.env.PCC_AUTH_TOKEN_FILE };
  }
  const cfg = ConfigSchema.parse(merged);
  cfg.dataRoot = path.resolve(cfg.dataRoot);
  cfg.extraProjectRoots = cfg.extraProjectRoots.map((p) => path.resolve(p));
  const allowed = cfg.uploads.allowedMimeTypes
    ? Object.fromEntries(cfg.uploads.allowedMimeTypes.filter((m) => DEFAULT_UPLOAD_TYPES[m]).map((m) => [m, DEFAULT_UPLOAD_TYPES[m]]))
    : DEFAULT_UPLOAD_TYPES;

  if (!isLoopback(cfg.host) && cfg.auth.mode !== "token") {
    throw new Error(`Refusing to bind ${cfg.host} without authentication. Set auth.mode "token" with auth.tokenFile (or PCC_AUTH_TOKEN_FILE), or bind 127.0.0.1.`);
  }
  if (cfg.auth.mode === "token" && !cfg.auth.tokenFile) throw new Error("auth.mode token needs auth.tokenFile");
  if (cfg.agentTokensFile && cfg.auth.mode !== "token") {
    throw new Error("agentTokensFile needs auth.mode \"token\": without authentication every client already has full access, so scoped tokens would restrict nothing");
  }
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
