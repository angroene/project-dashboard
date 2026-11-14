#!/usr/bin/env node
/**
 * apd: command-line client for the Agents Project Dashboard HTTP API, for coding agents and scripts.
 * One file, no dependencies, Node 22 or newer. Copy it anywhere. Full reference: docs/AGENT_INTEGRATION.md.
 *
 * Configuration (environment, or the matching --flag):
 *   APD_URL         server base URL                     (default http://127.0.0.1:8790)
 *   APD_PROJECT     project id                          (--project)
 *   APD_TOKEN_FILE  file holding a bearer token; the token itself is never accepted on the command line
 *   APD_OWNER       queue consumer name for claim/complete/fail (--owner, default "apd-cli")
 *   APD_OUTBOX      folder for publish calls made while the server was unreachable (default ./.apd-outbox)
 *   APD_RETRIES     retries for transient failures (default 3); APD_TIMEOUT_MS per request (default 15000)
 * Self-signed HTTPS: start node with NODE_EXTRA_CA_CERTS=<cert.pem>.
 *
 * Output is one line of JSON on stdout. Failures print one line of JSON on stderr.
 * Exit codes: 0 ok, 1 rejected by the server, 2 usage error, 3 server unreachable (publish calls are queued in the
 * outbox), 4 outcome unknown (a non-repeatable call was interrupted; check with `apd status`).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const USAGE = `usage: apd <command> [arguments] [--flags]
discover   projects | capabilities
publish    ask --section <id> (--file f.json | --json '{...}') [--id ID]
           publish --section <id> (--file f.json | --json '{...}') [--id ID]
           update <recordId> [--status s] [--label text|none] [--summary text] [--percent n|none]
                  [--priority p] [--notify true|false] [--note text] [--by name]
           event <eventId> --action a --summary text [--status info|success|warning|failure] [--area a]
                  [--record id] [--source s]   (or --file f.json)
           progress (--file f.json | --percent n|none [--label text] [--method text])
           upload <file>... [--question <questionId>]
           source <recordId>
answers    pending [--task id] [--question id] [--state pending|processing|processed|failed] [--limit n] [--count]
           hint   (for hooks: one sentence when answers are waiting, silent otherwise, always exit 0)
           answer <answerId>  |  status <answerId>  |  download <attachmentId> --out <file> [--force]
           claim [answerId] [--lease seconds]  |  complete <answerId> [--note text]
           fail <answerId> --reason text [--retry]
offline    outbox  |  flush
common     --project <id> --url <base> --owner <name>`;

export class ApdError extends Error {
  constructor(code, message, exit, extra = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.extra = extra;
  }
}

/** Splits argv into positionals and --flags (a flag followed by another flag or nothing is boolean true). */
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = flags[key] === undefined ? next : [].concat(flags[key], next); i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function settings(flags, env) {
  const s = {
    url: String(flags.url ?? env.APD_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, ""),
    project: flags.project ?? env.APD_PROJECT,
    owner: String(flags.owner ?? env.APD_OWNER ?? "apd-cli"),
    outbox: path.resolve(env.APD_OUTBOX ?? ".apd-outbox"),
    retries: Math.max(0, Math.min(10, Number(env.APD_RETRIES ?? 3))),
    timeoutMs: Math.max(1000, Number(env.APD_TIMEOUT_MS ?? 15000)),
    token: null,
  };
  if (env.APD_TOKEN_FILE) {
    try { s.token = fs.readFileSync(env.APD_TOKEN_FILE, "utf8").trim(); } catch (e) {
      throw new ApdError("config", `APD_TOKEN_FILE cannot be read (${e.code ?? "error"})`, 2);
    }
    if (!s.token) throw new ApdError("config", "APD_TOKEN_FILE is empty", 2);
  }
  return s;
}

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Errors where the request certainly never reached the server, so any call may be repeated. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EBADPORT"]);

/**
 * One HTTP call with bounded retries. `repeatable` calls (GET, PUT, de-duplicated PATCH) are retried on any transient
 * failure; others only when the request was certainly not sent.
 */
export async function request(s, method, apiPath, { body, form, repeatable = method === "GET" || method === "PUT" || method === "PATCH", raw = false } = {}) {
  const headers = { "X-PCC-Request": "1" };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let lastErr;
  for (let attempt = 0; attempt <= s.retries; attempt++) {
    if (attempt) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetch(s.url + apiPath, {
        method,
        headers,
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(s.timeoutMs),
      });
    } catch (e) {
      const code = e?.cause?.code ?? (e?.name === "TimeoutError" ? "ETIMEDOUT" : /bad port/i.test(String(e?.cause?.message)) ? "EBADPORT" : "ENETWORK");
      lastErr = { code, sent: !NOT_SENT.has(code) };
      if (repeatable || !lastErr.sent) continue;
      throw new ApdError("outcome-unknown", `${method} interrupted (${code}); the server may or may not have applied it`, 4);
    }
    if ([502, 503, 504].includes(res.status) && repeatable) { lastErr = { code: `HTTP${res.status}`, sent: true }; continue; }
    if (res.status === 204) return { status: 204, data: null };
    if (raw && res.ok) return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
    if (res.ok) return { status: res.status, data };
    const code = data?.error ?? `http-${res.status}`;
    const extra = { status: res.status, ...(data?.fieldErrors ? { fieldErrors: data.fieldErrors } : {}), ...(data?.details ? { details: data.details } : {}) };
    if (res.status >= 500) throw new ApdError(code, data?.message ?? "server error", 3, extra);
    throw new ApdError(code, data?.message ?? `HTTP ${res.status}`, 1, extra);
  }
  throw new ApdError("unavailable", `server unreachable (${lastErr?.code ?? "unknown"})`, 3);
}

// ------------------------------------------------------------------ outbox --
/** Persists a publish call that could not be delivered. The token is never written. */
function enqueue(s, call) {
  fs.mkdirSync(s.outbox, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.json`;
  const file = path.join(s.outbox, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...call, queuedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

function outboxFiles(s) {
  if (!fs.existsSync(s.outbox)) return [];
  return fs.readdirSync(s.outbox).filter((f) => f.endsWith(".json")).sort();
}

/** Delivers a publish call; if the server is unreachable the call is queued and exit code 3 reports it. */
async function publishCall(s, method, apiPath, body) {
  try {
    return (await request(s, method, apiPath, { body })).data;
  } catch (e) {
    if (e instanceof ApdError && e.exit === 3) {
      const file = enqueue(s, { method, path: apiPath, body });
      throw new ApdError(e.code, `${e.message}; queued for 'apd flush'`, 3, { queued: path.basename(file) });
    }
    throw e;
  }
}

async function flush(s) {
  const done = [];
  const rejected = [];
  for (const name of outboxFiles(s)) {
    const file = path.join(s.outbox, name);
    const call = JSON.parse(fs.readFileSync(file, "utf8"));
    try {
      await request(s, call.method, call.path, { body: call.body });
      fs.rmSync(file);
      done.push(name);
    } catch (e) {
      if (e instanceof ApdError && e.exit === 1) {
        const dir = path.join(s.outbox, "rejected");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...call, rejected: { code: e.code, message: e.message } }, null, 2));
        fs.rmSync(file);
        rejected.push({ file: name, error: e.code, message: e.message });
        continue;
      }
      return { delivered: done, rejected, remaining: outboxFiles(s).length, stoppedBy: e.code ?? "error" };
    }
  }
  return { delivered: done, rejected, remaining: 0 };
}

// ---------------------------------------------------------------- commands --
function need(v, what) {
  if (v === undefined || v === true || v === "") throw new ApdError("usage", `missing ${what}\n${USAGE}`, 2);
  return String(v);
}

function readJsonInput(flags) {
  let text;
  if (typeof flags.json === "string") text = flags.json;
  else if (typeof flags.file === "string") {
    try { text = fs.readFileSync(flags.file === "-" ? 0 : flags.file, "utf8"); } catch (e) { throw new ApdError("usage", `cannot read ${flags.file} (${e.code ?? "error"})`, 2); }
  } else throw new ApdError("usage", `--file or --json is required\n${USAGE}`, 2);
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("object expected");
    return v;
  } catch (e) {
    throw new ApdError("usage", `input is not a JSON object: ${e.message}`, 2);
  }
}

const nullable = (v) => (v === "none" ? null : v);
const num = (v, what) => {
  if (v === undefined) return undefined;
  if (v === "none") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApdError("usage", `${what} must be a number or 'none'`, 2);
  return n;
};
const bool = (v) => (v === undefined ? undefined : v === true || v === "true");

export async function run(argv, env = process.env) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...args] = pos;
  if (!cmd || cmd === "help" || flags.help) return { help: USAGE };
  const s = settings(flags, env);
  const proj = () => `/api/projects/${enc(need(s.project, "--project (or APD_PROJECT)"))}`;

  switch (cmd) {
    case "projects": {
      const r = (await request(s, "GET", "/api/projects")).data;
      return { projects: r.projects.filter((p) => p.available !== false).map((p) => ({ id: p.id, displayName: p.displayName, awaitingResponse: p.awaitingResponse, unreadUpdates: p.unreadUpdates })) };
    }
    case "capabilities":
      return (await request(s, "GET", `${proj()}/capabilities`)).data;

    case "ask":
    case "publish": {
      const rec = readJsonInput(flags);
      if (cmd === "ask") {
        rec.recordType ??= "question";
        if (rec.recordType !== "question") throw new ApdError("usage", "ask publishes questions; use publish for other record types", 2);
        rec.status ??= "open";
        rec.requiresResponse ??= true;
        rec.questionRevision ??= 1;
      }
      const id = need(flags.id ?? rec.id, "--id (or an id in the record)");
      rec.updatedAt ??= new Date().toISOString();
      return publishCall(s, "PUT", `${proj()}/records/${enc(id)}`, { sectionId: need(flags.section, "--section"), record: rec });
    }
    case "update": {
      const id = need(args[0], "recordId");
      const body = {};
      if (flags.status !== undefined) body.status = need(flags.status, "--status value");
      if (flags.label !== undefined) body.statusLabel = nullable(need(flags.label, "--label value"));
      if (flags.summary !== undefined) body.summary = need(flags.summary, "--summary value");
      if (flags.percent !== undefined) body.percent = num(flags.percent, "--percent");
      if (flags.priority !== undefined) body.priority = need(flags.priority, "--priority value");
      if (flags.notify !== undefined) body.notifyUser = bool(flags.notify);
      // The timestamp is fixed here so a retried or replayed call is recognised as the same history entry.
      if (flags.note !== undefined) body.history = { at: new Date().toISOString(), text: need(flags.note, "--note text"), ...(flags.by ? { by: String(flags.by) } : {}) };
      if (!Object.keys(body).length) throw new ApdError("usage", "update needs at least one field flag", 2);
      return publishCall(s, "PATCH", `${proj()}/records/${enc(id)}`, body);
    }
    case "event": {
      const id = need(args[0], "eventId");
      const ev = flags.file || flags.json ? readJsonInput(flags) : {
        action: need(flags.action, "--action"),
        summary: need(flags.summary, "--summary"),
        ...(flags.status ? { status: String(flags.status) } : {}),
        ...(flags.area ? { area: String(flags.area) } : {}),
        ...(flags.record ? { recordId: String(flags.record) } : {}),
        ...(flags.source ? { source: String(flags.source) } : {}),
      };
      ev.at ??= new Date().toISOString();
      return publishCall(s, "PUT", `${proj()}/activity/${enc(id)}`, ev);
    }
    case "progress": {
      const progress = flags.file || flags.json ? readJsonInput(flags) : {
        overallPercent: num(need(flags.percent, "--percent or --file"), "--percent"),
        ...(flags.label ? { label: String(flags.label) } : {}),
        ...(flags.method ? { method: String(flags.method) } : {}),
      };
      progress.updatedAt ??= new Date().toISOString();
      return publishCall(s, "PUT", `${proj()}/progress`, { progress });
    }
    case "upload": {
      if (!args.length) throw new ApdError("usage", "upload needs at least one file", 2);
      const form = new FormData();
      if (flags.question) form.append("questionId", String(flags.question));
      for (const f of args) {
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new ApdError("usage", `not a file: ${f}`, 2);
        form.append("file", await fs.openAsBlob(f), path.basename(f));
      }
      return (await request(s, "POST", `${proj()}/uploads`, { form })).data;
    }
    case "source":
      return (await request(s, "GET", `${proj()}/records/${enc(need(args[0], "recordId"))}/source`)).data;

    case "pending": {
      const q = new URLSearchParams({ state: String(flags.state ?? "pending"), limit: String(flags.limit ?? 100) });
      if (flags.task) q.set("taskId", String(flags.task));
      if (flags.question) q.set("questionId", String(flags.question));
      const r = (await request(s, "GET", `${proj()}/queue?${q}`)).data;
      return flags.count ? { count: r.items.length, more: !!r.next } : r;
    }
    case "hint": {
      // For lifecycle hooks: one plain sentence when answers are waiting, nothing otherwise, never a failure exit.
      try {
        const r = (await request({ ...s, retries: 0, timeoutMs: Math.min(s.timeoutMs, 5000) }, "GET", `${proj()}/queue?state=pending&limit=100`)).data;
        const n = r.items.length;
        return { text: n ? `Agents Project Dashboard: ${n}${r.next ? "+" : ""} submitted answer(s) waiting in project ${s.project}. Process them at your next work boundary (skill: dashboard-process-answers).` : "" };
      } catch {
        return { text: "" };
      }
    }
    case "answer":
      return (await request(s, "GET", `${proj()}/queue/${enc(need(args[0], "answerId"))}`)).data;
    case "status": {
      const e = (await request(s, "GET", `${proj()}/queue/${enc(need(args[0], "answerId"))}`)).data;
      return { answerId: e.answerId, questionId: e.questionId, processingState: e.processingState, attempts: e.attempts, ...(e.lease ? { lease: e.lease } : {}), ...(e.result ? { result: e.result } : {}) };
    }
    case "download": {
      const out = need(flags.out, "--out");
      if (fs.existsSync(out) && !flags.force) throw new ApdError("usage", `${out} exists; pass --force to overwrite`, 2);
      const r = await request(s, "GET", `${proj()}/attachments/${enc(need(args[0], "attachmentId"))}`, { raw: true });
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, r.data);
      return { attachmentId: args[0], out, bytes: r.data.length };
    }
    case "claim": {
      const body = { owner: s.owner, ...(flags.lease ? { leaseSeconds: Number(flags.lease) } : {}), ...(args[0] ? { answerId: args[0] } : {}) };
      const r = await request(s, "POST", `${proj()}/queue/claim`, { body });
      return r.status === 204 ? { claimed: false } : { claimed: true, answer: r.data };
    }
    case "complete":
      return (await request(s, "POST", `${proj()}/queue/${enc(need(args[0], "answerId"))}/complete`, { body: { owner: s.owner, ...(flags.note ? { note: String(flags.note) } : {}) } })).data;
    case "fail":
      return (await request(s, "POST", `${proj()}/queue/${enc(need(args[0], "answerId"))}/fail`, { body: { owner: s.owner, reason: need(flags.reason, "--reason"), retryable: !!flags.retry } })).data;

    case "outbox":
      return { outbox: s.outbox, queued: outboxFiles(s) };
    case "flush":
      return flush(s);
    default:
      throw new ApdError("usage", `unknown command '${cmd}'\n${USAGE}`, 2);
  }
}

async function main() {
  try {
    const out = await run(process.argv.slice(2));
    if (out && "help" in out) { process.stdout.write(out.help + "\n"); return; }
    if (out && "text" in out) { if (out.text) process.stdout.write(out.text + "\n"); return; }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    const err = e instanceof ApdError ? e : new ApdError("internal", e?.message ?? String(e), 1);
    process.stderr.write(JSON.stringify({ ok: false, error: err.code, message: err.message, ...err.extra }) + "\n");
    process.exitCode = err.exit;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invokedDirectly) await main();
