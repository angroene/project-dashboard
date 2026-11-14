/** Negative-path coverage that the other suites do not exercise. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { makeApp, makeDataRoot, multipartBody, PNG_1x1, POST_HEADERS, question, section, writeJson } from "./helpers.js";
import { loadConfig } from "../src/server/config.js";
import { buildApp } from "../src/server/app.js";
import { claimNext, failAnswer } from "../src/server/answers.js";
import { storeUpload } from "../src/server/uploads.js";
import type { ImportPreview, NavigationResponse, ProjectsResponse, RecordPage } from "../src/shared/api.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });
let keyN = 0;
const key = () => `gapkey${Date.now()}${keyN++}`;
const choice = (optionIds: string[]) => ({ fieldId: "response", kind: "choice", optionIds });
const answerBody = (optionIds = ["a"], k = key()) => JSON.stringify({ questionRevision: 1, answers: [choice(optionIds)], idempotencyKey: k });
const TOKEN = "gap-token-0123456789abcdef";

async function setup(extra: Record<string, unknown> = {}, root = makeDataRoot()) {
  const h = await makeApp(root, extra);
  apps.push(h);
  const submit = (project: string, q: string, optionIds = ["a"], k = key()) =>
    h.app.inject({ method: "POST", url: `/api/projects/${project}/questions/${q}/answers`, headers: POST_HEADERS, payload: answerBody(optionIds, k) });
  return { root, ...h, submit };
}
type T = Awaited<ReturnType<typeof setup>>;

async function setupAuth() {
  const root = makeDataRoot();
  const tokenFile = path.join(root, "token.txt");
  fs.writeFileSync(tokenFile, TOKEN);
  const h = await makeApp(root, { auth: { mode: "token", tokenFile } });
  apps.push(h);
  const login = await h.app.inject({ method: "POST", url: "/api/auth/login", headers: POST_HEADERS, payload: JSON.stringify({ token: TOKEN }) });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  return { root, ...h, cookie };
}

function upload(t: T, project: string, parts: Parameters<typeof multipartBody>[0]) {
  const mp = multipartBody(parts);
  return t.app.inject({ method: "POST", url: `/api/projects/${project}/uploads`, payload: mp.payload, headers: mp.headers });
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
}

describe("1. HTTP: authentication on every route family", () => {
  it("returns 401 without a session for read, queue, attachment, upload, export, import, zip, admin and SSE routes", async () => {
    const t = await setupAuth();
    const gets = [
      "/api/projects/alpha", "/api/projects/alpha/navigation", "/api/projects/alpha/sections/qs/records", "/api/projects/alpha/records/Q1",
      "/api/projects/alpha/progress", "/api/projects/alpha/activity", "/api/projects/alpha/attention", "/api/projects/alpha/attachments/ATT-1",
      "/api/projects/alpha/queue", "/api/projects/alpha/queue/ANS-X", "/api/diagnostics", "/api/updates", "/api/nope",
    ];
    for (const url of gets) {
      const r = await t.app.inject(url);
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error).toBe("unauthorized");
    }
    const posts = [
      "/api/projects/alpha/questions/Q1/answers", "/api/projects/alpha/uploads", "/api/projects/alpha/records/mark-read",
      "/api/projects/alpha/export/xlsx", "/api/projects/alpha/import/xlsx/preview", "/api/projects/alpha/import/xlsx/commit",
      "/api/projects/alpha/download/zip/preflight", "/api/projects/alpha/download/zip", "/api/projects/alpha/queue/claim",
      "/api/projects/alpha/queue/ANS-X/complete", "/api/projects/alpha/queue/ANS-X/fail", "/api/projects/alpha/queue/recover", "/api/admin/reindex",
    ];
    for (const url of posts) {
      const r = await t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: "{}" });
      expect(r.statusCode, url).toBe(401);
    }
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications"))).toHaveLength(0);
    expect(listFiles(path.join(t.root, "projects", "alpha", "attachments", "answers"))).toHaveLength(0);
  });

  it("rejects a forged or logged-out session cookie, and the session works before logout", async () => {
    const t = await setupAuth();
    expect((await t.app.inject({ url: "/api/projects/alpha/queue", headers: { cookie: t.cookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/projects/alpha/queue", headers: { cookie: "pcc_session=forged-session-id" } })).statusCode).toBe(401);
    const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...POST_HEADERS, cookie: t.cookie }, payload: "{}" });
    expect(out.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/projects/alpha/queue", headers: { cookie: t.cookie } })).statusCode).toBe(401);
  });

  it("the session endpoint stays public and reports unauthenticated without leaking the token", async () => {
    const t = await setupAuth();
    const r = await t.app.inject("/api/session");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ authRequired: true, authenticated: false });
    expect(r.body).not.toContain(TOKEN);
  });

  it("rate-limits repeated failed logins with 429, even for the right token during the lockout", async () => {
    const t = await setupAuth();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await t.app.inject({ method: "POST", url: "/api/auth/login", headers: POST_HEADERS, payload: JSON.stringify({ token: `wrong-${i}` }) })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: POST_HEADERS, payload: JSON.stringify({ token: TOKEN }) });
    expect(ok.statusCode).toBe(429);
  });
});

describe("1. HTTP: CSRF on every write route family", () => {
  const writes = [
    "/api/projects/alpha/questions/Q1/answers", "/api/projects/alpha/uploads", "/api/projects/alpha/records/mark-read",
    "/api/projects/alpha/export/xlsx", "/api/projects/alpha/import/xlsx/preview", "/api/projects/alpha/import/xlsx/commit",
    "/api/projects/alpha/download/zip/preflight", "/api/projects/alpha/download/zip", "/api/projects/alpha/queue/claim",
    "/api/projects/alpha/queue/ANS-X/complete", "/api/projects/alpha/queue/ANS-X/fail", "/api/projects/alpha/queue/recover", "/api/admin/reindex",
  ];

  it("403 csrf without X-PCC-Request, whatever the route or method", async () => {
    const t = await setup();
    for (const url of writes) {
      const r = await t.app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "{}" });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe("csrf");
    }
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect((await t.app.inject({ method, url: "/api/projects/alpha/records/Q1" })).statusCode, method).toBe(403);
    }
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications"))).toHaveLength(0);
  });

  it("403 csrf for a cross-origin Origin on every write route, a wrong header value and an unparsable Origin", async () => {
    const t = await setup();
    for (const url of writes) {
      const r = await t.app.inject({ method: "POST", url, headers: { ...POST_HEADERS, origin: "http://evil.example", host: "127.0.0.1:8790" }, payload: "{}" });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe("csrf");
    }
    const wrong = await t.app.inject({ method: "POST", url: writes[0], headers: { "x-pcc-request": "0", "content-type": "application/json" }, payload: answerBody() });
    expect(wrong.statusCode).toBe(403);
    const garbage = await t.app.inject({ method: "POST", url: writes[0], headers: { ...POST_HEADERS, origin: "not a url", host: "127.0.0.1:8790" }, payload: answerBody() });
    expect(garbage.statusCode).toBe(403);
    const same = await t.app.inject({ method: "POST", url: writes[0], headers: { ...POST_HEADERS, origin: "http://127.0.0.1:8790", host: "127.0.0.1:8790" }, payload: answerBody() });
    expect(same.statusCode).toBe(201);
  });

  it("CSRF is decided before authentication: a forged unauthenticated request gets 403", async () => {
    const t = await setupAuth();
    const r = await t.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: { "content-type": "application/json", origin: "http://evil.example", host: "127.0.0.1:8790" }, payload: "{}" });
    expect(r.statusCode).toBe(403);
  });
});

describe("1. HTTP: 404s, methods, malformed input, invalid ids", () => {
  it("404 for unknown project, section, record, attachment, question and answer across route families", async () => {
    const t = await setup();
    const gets = [
      "/api/projects/nope", "/api/projects/nope/navigation", "/api/projects/nope/sections/qs/records", "/api/projects/nope/records/Q1",
      "/api/projects/nope/progress", "/api/projects/nope/activity", "/api/projects/nope/attention", "/api/projects/nope/attachments/ATT-1",
      "/api/projects/nope/queue", "/api/projects/alpha/sections/nope/records", "/api/projects/alpha/records/NOPE",
      "/api/projects/alpha/attachments/NOPE", "/api/projects/alpha/queue/ANS-NOPE", "/api/projects/beta/records/T1",
    ];
    for (const url of gets) {
      const r = await t.app.inject(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error).toBe("not-found");
    }
    const posts: [string, unknown][] = [
      ["/api/projects/nope/questions/Q1/answers", JSON.parse(answerBody())],
      ["/api/projects/alpha/questions/NOPE/answers", JSON.parse(answerBody())],
      ["/api/projects/alpha/questions/T1/answers", JSON.parse(answerBody())],
      ["/api/projects/nope/queue/claim", { owner: "w" }],
      ["/api/projects/nope/export/xlsx", { questionIds: ["Q1"] }],
      ["/api/projects/nope/import/xlsx/commit", { previewId: "a".repeat(24), questionIds: ["Q1"] }],
      ["/api/projects/nope/download/zip/preflight", {}],
      ["/api/projects/nope/records/mark-read", {}],
    ];
    for (const [url, body] of posts) {
      const r = await t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: JSON.stringify(body) });
      expect(r.statusCode, url).toBe(404);
    }
    // completing or failing an answer that does not exist is a state conflict, not a lookup: the documented 409 wrong-state
    for (const action of ["complete", "fail"]) {
      const r = await t.app.inject({ method: "POST", url: `/api/projects/alpha/queue/ANS-NOPE/${action}`, headers: POST_HEADERS, payload: JSON.stringify({ owner: "w", reason: "x" }) });
      expect(r.statusCode, action).toBe(409);
      expect(r.json().error).toBe("wrong-state");
    }
  });

  it("404 for unknown /api endpoints, and 404 or 405 for unsupported methods on real paths", async () => {
    const t = await setup();
    for (const url of ["/api/nope", "/api/projects/alpha/nope", "/api/projects/alpha/records/Q1/extra"]) {
      const r = await t.app.inject(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json()).toMatchObject({ error: "not-found" });
    }
    const real = ["/api/projects", "/api/projects/alpha", "/api/projects/alpha/records/Q1", "/api/projects/alpha/queue", "/api/projects/alpha/queue/claim", "/api/session", "/api/diagnostics"];
    for (const url of real) {
      // PUT and PATCH on a record are the publish API (test/agent-api.test.ts); DELETE stays unsupported.
      const methods = url.endsWith("/records/Q1") ? (["DELETE"] as const) : (["DELETE", "PUT", "PATCH"] as const);
      for (const method of methods) {
        const r = await t.app.inject({ method, url, headers: POST_HEADERS, payload: "{}" });
        expect([404, 405], `${method} ${url}`).toContain(r.statusCode);
        expect(r.body).not.toMatch(/Q1|synthetic/);
      }
    }
    for (const [method, url] of [["POST", "/api/projects/alpha/progress"], ["POST", "/api/projects"], ["GET", "/api/projects/alpha/queue/recover"], ["GET", "/api/projects/alpha/export/xlsx"], ["GET", "/api/admin/reindex"]] as const) {
      const r = await t.app.inject({ method, url, headers: POST_HEADERS, payload: method === "POST" ? "{}" : undefined });
      expect([400, 404, 405], `${method} ${url}`).toContain(r.statusCode);
    }
    expect((await t.app.inject("/api/projects/alpha/records/Q1")).statusCode).toBe(200);
  });

  it("400 for malformed JSON, wrong shapes and bad field values on JSON routes", async () => {
    const t = await setup();
    const urls = ["/api/projects/alpha/questions/Q1/answers", "/api/projects/alpha/queue/claim", "/api/projects/alpha/export/xlsx", "/api/projects/alpha/import/xlsx/commit", "/api/projects/alpha/records/mark-read"];
    for (const url of urls) {
      const bad = await t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: "{ not json" });
      expect(bad.statusCode, url).toBe(400);
      expect(bad.json().error).toBe("bad-request");
      const truncated = await t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: '{"questionRevision": 1, "answers": [' });
      expect(truncated.statusCode, url).toBe(400);
    }
    for (const payload of ["[]", "null", "42", '"str"']) {
      const r = await t.app.inject({ method: "POST", url: urls[0], headers: POST_HEADERS, payload });
      expect(r.statusCode, payload).toBe(400);
    }
    const text = await t.app.inject({ method: "POST", url: urls[0], headers: { "x-pcc-request": "1", "content-type": "text/plain" }, payload: answerBody() });
    expect([400, 415]).toContain(text.statusCode);
    const wrongTypes = await t.app.inject({ method: "POST", url: urls[0], headers: POST_HEADERS, payload: JSON.stringify({ questionRevision: "1", answers: [], idempotencyKey: "short" }) });
    expect(wrongTypes.statusCode).toBe(400);
    expect((await t.app.inject("/api/projects/alpha/records/Q1")).json().question.uiState).toBe("needs-response");
  });

  it("413 for a JSON body over 1 MB, without creating anything", async () => {
    const t = await setup();
    const big = JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "text", text: "x".repeat(1024 * 1024 + 10) }], idempotencyKey: key() });
    const r = await t.app.inject({ method: "POST", url: "/api/projects/alpha/questions/QTEXT/answers", headers: POST_HEADERS, payload: big });
    expect(r.statusCode).toBe(413);
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications"))).toHaveLength(0);
    const just = JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "text", text: "x".repeat(900 * 1024) }], idempotencyKey: key() });
    const underLimit = await t.app.inject({ method: "POST", url: "/api/projects/alpha/questions/QTEXT/answers", headers: POST_HEADERS, payload: just });
    expect(underLimit.statusCode).not.toBe(413);
    expect(underLimit.statusCode).toBe(400);
  });

  it("invalid ids in params (traversal, encoded slashes, absolute, over-long) never reach the filesystem", async () => {
    const t = await setup();
    const bad = ["..", "%2e%2e", "..%2f..%2fproject.json", "%2e%2e%2f%2e%2e%2fproject.json", "..%5c..%5cproject.json", "a%2fb", "%2fetc%2fpasswd", "C%3A%5CWindows", "x".repeat(300), "%00", "a%20b", "-lead"];
    const forbidden = /schemaVersion|displayName/;
    for (const id of bad) {
      for (const url of [
        `/api/projects/${id}`, `/api/projects/${id}/navigation`, `/api/projects/alpha/records/${id}`, `/api/projects/alpha/attachments/${id}`,
        `/api/projects/alpha/queue/${id}`, `/api/projects/alpha/sections/${id}/records`, `/api/projects/${id}/records/Q1`,
      ]) {
        const r = await t.app.inject(url);
        expect([400, 404], url).toContain(r.statusCode);
        expect(r.body, url).not.toMatch(forbidden);
        expect(r.body, url).not.toContain(t.root);
      }
      for (const url of [`/api/projects/alpha/questions/${id}/answers`, `/api/projects/alpha/queue/${id}/complete`, `/api/projects/alpha/queue/${id}/fail`]) {
        const r = await t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: JSON.stringify({ owner: "w", reason: "x", questionRevision: 1, answers: [choice(["a"])], idempotencyKey: key() }) });
        expect([400, 404], url).toContain(r.statusCode);
      }
    }
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications"))).toHaveLength(0);
  });

  it("invalid ids and values in request bodies and queries are rejected with 400", async () => {
    const t = await setup();
    const post = (url: string, body: unknown) => t.app.inject({ method: "POST", url, headers: POST_HEADERS, payload: JSON.stringify(body) });
    expect((await post("/api/projects/alpha/export/xlsx", { questionIds: ["../x"] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/export/xlsx", { questionIds: [] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/export/xlsx", { questionIds: ["T1"] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/export/xlsx", { questionIds: ["NOPE"] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/records/mark-read", { recordIds: ["../../x"] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/download/zip/preflight", { attachmentIds: ["..\\..\\project.json"] })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/queue/claim", { owner: "bad owner!" })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/queue/claim", { owner: "w", leaseSeconds: 1 })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/queue/claim", { owner: "w", answerId: "../x" })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/queue/ANS-X/fail", { owner: "w" })).statusCode).toBe(400);
    expect((await post("/api/projects/alpha/import/xlsx/commit", { previewId: "../../etc", questionIds: ["Q1"] })).statusCode).toBe(400);
    expect((await t.app.inject("/api/projects/alpha/queue?limit=0")).statusCode).toBe(400);
    expect((await t.app.inject("/api/projects/alpha/queue?limit=99999")).statusCode).toBe(400);
    expect((await t.app.inject("/api/projects/alpha/queue?after=../x")).statusCode).toBe(400);
  });

  it("garbage cursors and out-of-range limits degrade safely on list routes", async () => {
    const t = await setup();
    for (const cursor of ["%25%25%25", "bm90LWpzb24", Buffer.from("[1,2]").toString("base64url"), "x".repeat(5000)]) {
      expect((await t.app.inject(`/api/projects/alpha/sections/qs/records?cursor=${cursor}`)).statusCode, cursor.slice(0, 10)).toBe(200);
      expect((await t.app.inject(`/api/projects/alpha/activity?cursor=${cursor}`)).statusCode).toBe(200);
    }
    const big = (await t.app.inject("/api/projects/alpha/sections/qs/records?limit=100000&status=all")).json() as RecordPage;
    expect(big.items.length).toBeLessThanOrEqual(200);
    const none = (await t.app.inject("/api/projects/alpha/sections/qs/records?sort=bogus&status=nonsense")).json() as RecordPage;
    expect(none.items).toHaveLength(0);
  });

  it("error responses never contain absolute server paths", async () => {
    const t = await setup();
    const exe = multipartBody([{ name: "file", filename: "x.exe", content: Buffer.from("MZ") }]);
    const requests: { method?: "GET" | "POST"; url: string; payload?: string | Buffer; headers?: Record<string, string> }[] = [
      { url: "/api/projects/nope" }, { url: "/api/projects/broken" }, { url: "/api/projects/alpha/records/nope" }, { url: "/api/projects/alpha/attachments/ATT-GONE" },
      { url: "/api/projects/alpha/records/bad" }, { url: "/api/projects/alpha/attachments/..%2f..%2fproject.json" }, { url: "/api/nope" },
      { method: "POST", url: "/api/projects/alpha/questions/Q1/answers", headers: POST_HEADERS, payload: "{ nope" },
      { method: "POST", url: "/api/projects/alpha/questions/Q1/answers", headers: POST_HEADERS, payload: JSON.stringify({ questionRevision: 1, answers: [choice(["zzz"])], idempotencyKey: key() }) },
      { method: "POST", url: "/api/projects/alpha/uploads", headers: exe.headers, payload: exe.payload },
      { method: "POST", url: "/api/projects/alpha/import/xlsx/preview", headers: exe.headers, payload: exe.payload },
      { method: "POST", url: "/api/projects/alpha/import/xlsx/commit", headers: POST_HEADERS, payload: JSON.stringify({ previewId: "a".repeat(24), questionIds: ["Q1"] }) },
      { method: "POST", url: "/api/projects/alpha/queue/ANS-NOPE/complete", headers: POST_HEADERS, payload: JSON.stringify({ owner: "w" }) },
    ];
    const roots = [t.root, t.root.replace(/\\/g, "/"), t.root.replace(/\\/g, "\\\\"), process.cwd(), process.cwd().replace(/\\/g, "/")];
    for (const rq of requests) {
      const r = await t.app.inject({ method: rq.method ?? "GET", url: rq.url, headers: rq.headers, payload: rq.payload } as never);
      expect(r.statusCode, rq.url).toBeGreaterThanOrEqual(400);
      for (const needle of roots) expect(r.body, `${rq.url} leaks ${needle}`).not.toContain(needle);
      expect(r.body, rq.url).not.toMatch(/[A-Za-z]:[\\/]|\/(tmp|home|var|Users)\//);
    }
    for (const url of ["/api/diagnostics", "/api/projects"]) {
      const body = (await t.app.inject(url)).body;
      for (const needle of roots) expect(body, url).not.toContain(needle);
    }
  });
});

describe("2. Config and manifests", () => {
  const withToken = (content: string) => {
    const root = makeDataRoot();
    const tokenFile = path.join(root, "token.txt");
    fs.writeFileSync(tokenFile, content);
    return { root, tokenFile };
  };

  it("loadConfig refuses token mode without a token file and out-of-range or missing values", () => {
    const root = makeDataRoot();
    expect(() => loadConfig({ dataRoot: root, auth: { mode: "token" } } as never)).toThrow(/tokenFile/);
    expect(() => loadConfig({ dataRoot: root, auth: { mode: "basic" } } as never)).toThrow();
    expect(() => loadConfig({ dataRoot: root, port: 0 } as never)).toThrow();
    expect(() => loadConfig({ dataRoot: root, port: 70000 } as never)).toThrow();
    expect(() => loadConfig({ dataRoot: root, uploads: { maxBytes: 10 } } as never)).toThrow();
    expect(() => loadConfig({} as never)).toThrow();
  });

  it("every non-loopback host form is refused without a token", () => {
    const root = makeDataRoot();
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.2"]) {
      expect(() => loadConfig({ dataRoot: root, host } as never), host).toThrow(/Refusing to bind/);
    }
  });

  it("a missing TLS key file or a TLS block without a key is refused, naming only the file", () => {
    const root = makeDataRoot();
    const cert = path.join(root, "cert.pem");
    fs.writeFileSync(cert, "x");
    const missing = path.join(root, "missing-key.pem");
    expect(() => loadConfig({ dataRoot: root, tls: { certFile: cert, keyFile: missing } } as never)).toThrow(/TLS file not found: missing-key\.pem/);
    try { loadConfig({ dataRoot: root, tls: { certFile: cert, keyFile: missing } } as never); } catch (e) { expect((e as Error).message).not.toContain(root); }
    expect(() => loadConfig({ dataRoot: root, tls: { certFile: cert } } as never)).toThrow();
  });

  it("refuses to start with a token shorter than 16 characters or an empty/missing token file", async () => {
    for (const short of ["", "short", "123456789012345"]) {
      const { root, tokenFile } = withToken(short);
      const cfg = loadConfig({ dataRoot: root, watch: false, reconcileSeconds: 0, logLevel: "silent", auth: { mode: "token", tokenFile } } as never);
      await expect(buildApp(cfg, { logger: false }), JSON.stringify(short)).rejects.toThrow(/at least 16 characters/);
    }
    const { root } = withToken("x");
    const cfg = loadConfig({ dataRoot: root, watch: false, reconcileSeconds: 0, logLevel: "silent", auth: { mode: "token", tokenFile: path.join(root, "absent.txt") } } as never);
    await expect(buildApp(cfg, { logger: false })).rejects.toThrow();
    const padded = withToken(" " + "a".repeat(15) + " ");
    const cfg2 = loadConfig({ dataRoot: padded.root, watch: false, reconcileSeconds: 0, logLevel: "silent", auth: { mode: "token", tokenFile: padded.tokenFile } } as never);
    await expect(buildApp(cfg2, { logger: false })).rejects.toThrow(/at least 16/);
    const ok = withToken("  " + "a".repeat(16) + "\n");
    const h = await makeApp(ok.root, { auth: { mode: "token", tokenFile: ok.tokenFile } });
    apps.push(h);
    expect((await h.app.inject("/api/session")).statusCode).toBe(200);
  });

  it("a missing data root yields a diagnostic and an empty project list, not a crash", async () => {
    const root = makeDataRoot();
    const h = await makeApp(path.join(root, "does-not-exist"));
    apps.push(h);
    expect(((await h.app.inject("/api/projects")).json() as ProjectsResponse).projects).toEqual([]);
    expect(h.store.diagnostics().map((d) => d.message).join()).toMatch(/data root not found/);
  });

  async function withProjects(manifests: Record<string, unknown>) {
    const root = makeDataRoot();
    for (const [dir, m] of Object.entries(manifests)) writeJson(path.join(root, "projects", dir, "project.json"), m);
    const h = await makeApp(root);
    apps.push(h);
    return { root, h };
  }

  it("project.json with unsafe paths (absolute, .., drive letter, UNC) makes only that project unavailable", async () => {
    const bad = (id: string, extra: Record<string, unknown>) => ({ schemaVersion: 1, id, displayName: id, ...extra });
    const { root, h } = await withProjects({
      u1: bad("u1", { rootSection: "/etc" }),
      u2: bad("u2", { rootSection: "../sections" }),
      u3: bad("u3", { progressFile: "C:\\Windows\\win.ini" }),
      u4: bad("u4", { allowedAttachmentRoot: "..\\..\\x" }),
      u5: bad("u5", { artifactRoots: ["docs", "a/../../b"] }),
      u6: bad("u6", { activityDir: "\\\\server\\share" }),
      u7: bad("u7", { artifactRoots: ["D:/data"] }),
    });
    const keys = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    for (const k of keys) {
      expect(h.store.get(k), k).toBeUndefined();
      expect(h.store.broken.map((b) => b.key), k).toContain(k);
      expect((await h.app.inject(`/api/projects/${k}`)).statusCode, k).toBe(404);
    }
    const reasons = h.store.broken.filter((b) => keys.includes(b.key)).map((b) => b.reason).join("\n");
    expect(reasons).not.toContain(root);
    expect(h.store.get("alpha")).toBeDefined();
    expect(h.store.get("beta")).toBeDefined();
  });

  it("malformed project.json variants are reported as unavailable without hiding other projects", async () => {
    const keys = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    const { h } = await withProjects({
      m1: "", m2: "[]", m3: "null", m4: { schemaVersion: 99, id: "m4", displayName: "x" }, m5: { schemaVersion: 1, displayName: "no id" },
      m6: { schemaVersion: 1, id: "../m6", displayName: "bad id" }, m7: { schemaVersion: 1, id: "m7", displayName: "" }, m8: '{"schemaVersion":1,"id":"m8"',
    });
    const brokenKeys = h.store.broken.map((b) => b.key);
    for (const k of keys) {
      expect(brokenKeys, k).toContain(k);
      expect(h.store.get(k), k).toBeUndefined();
    }
    expect(h.store.get("alpha")).toBeDefined();
    expect(h.store.get("beta")).toBeDefined();
  });

  it("a project directory without project.json is listed only as an unavailable card", async () => {
    const root = makeDataRoot();
    fs.mkdirSync(path.join(root, "projects", "empty-dir"), { recursive: true });
    const h = await makeApp(root);
    apps.push(h);
    const cards = ((await h.app.inject("/api/projects")).json() as ProjectsResponse).projects;
    expect(cards.find((c) => c.id === "empty-dir")).toMatchObject({ available: false });
    expect(h.store.get("empty-dir")).toBeUndefined();
    expect((await h.app.inject("/api/projects/empty-dir")).statusCode).toBe(404);
    expect(cards.filter((c) => c.available).map((c) => c.id)).toEqual(["alpha", "beta"]);
  });

  it("section.json: unsupported displayType, bad id, missing schemaVersion, bad JSON and duplicate ids are diagnosed and ignored", async () => {
    const root = makeDataRoot();
    const s = path.join(root, "projects", "alpha", "sections", "dev");
    writeJson(path.join(s, "work", "qs-again", "section.json"), section("qs", "expandable-card", "Duplicate of qs"));
    writeJson(path.join(s, "badtype", "section.json"), section("badtype", "carousel", "Unsupported"));
    writeJson(path.join(s, "badslug", "section.json"), section("Bad Slug", "page-tab", "Bad slug"));
    writeJson(path.join(s, "nover", "section.json"), { id: "nover", displayType: "page-tab", title: "No schema version" });
    writeJson(path.join(s, "badjson", "section.json"), "{ nope");
    const h = await makeApp(root);
    apps.push(h);
    expect(h.store.diagnostics().map((d) => d.message).join("\n")).toMatch(/duplicate section id 'qs'/);
    const nav = (await h.app.inject("/api/projects/alpha/navigation")).json() as NavigationResponse;
    const ids: string[] = [];
    const walk = (nodes: unknown[]) => { for (const n of nodes as { id: string; children?: unknown[] }[]) { ids.push(n.id); walk(n.children ?? []); } };
    walk(nav.nodes);
    for (const bad of ["badtype", "badslug", "Bad Slug", "nover", "badjson"]) expect(ids, bad).not.toContain(bad);
    expect(ids.filter((i) => i === "qs")).toHaveLength(1);
    expect(ids).not.toContain("qs-again");
    expect(((await h.app.inject("/api/projects/alpha/sections/qs/records?status=all")).json() as RecordPage).total).toBeGreaterThan(0);
  });

  it("a duplicate section id in a different branch is diagnosed and the first section keeps its records", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "work", "qs-again", "section.json"), section("qs", "expandable-card", "Duplicate of qs"));
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "work", "qs-again", "records", "ZZ1.json"), question("ZZ1"));
    const h = await makeApp(root);
    apps.push(h);
    expect(h.store.diagnostics().map((d) => d.message).join("\n")).toMatch(/duplicate section id 'qs'/);
    expect(h.store.get("alpha")!.sections.get("qs")!.manifest.title).toBe("Questions");
  });

  it("a duplicate record id in another section is diagnosed and never serves the duplicate's data", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "work", "tasks", "records", "dupq.json"), question("Q1", { title: "IMPOSTOR TITLE" }));
    const h = await makeApp(root);
    apps.push(h);
    expect(h.store.diagnostics().map((d) => d.message).join("\n")).toMatch(/duplicate record id 'Q1'/);
    expect(JSON.stringify((await h.app.inject("/api/projects/alpha/records/Q1")).json())).not.toContain("IMPOSTOR");
  });

  it("a duplicate attachment id across records is diagnosed", async () => {
    const root = makeDataRoot();
    writeJson(path.join(root, "projects", "alpha", "sections", "dev", "work", "tasks", "records", "T3.json"),
      { schemaVersion: 1, id: "T3", recordType: "task", title: "T3", status: "open", updatedAt: "2026-11-01T10:00:00Z", attachments: [{ id: "ATT-1", path: "documents/adr-1.md" }] });
    const h = await makeApp(root);
    apps.push(h);
    expect(h.store.diagnostics().map((d) => d.message).join("\n")).toMatch(/duplicate attachment id 'ATT-1'/);
  });
});

describe("3. Uploads", () => {
  const stored = (root: string) => listFiles(path.join(root, "projects", "alpha", "attachments", "answers"));

  it("rejects disallowed extensions (double, case and dotfile variants) and publishes nothing", async () => {
    const t = await setup();
    for (const name of ["run.exe", "script.js", "page.html", "image.svg", "arch.zip", "noext", "evil.png.exe", "x.PHP", "a.png.", ".png"]) {
      const r = await upload(t, "alpha", [{ name: "file", filename: name, content: PNG_1x1, type: "image/png" }]);
      expect(r.statusCode, name).toBe(422);
      expect(r.json().error).toBe("upload-rejected");
    }
    expect(stored(t.root)).toHaveLength(0);
  });

  it("rejects content that does not match the extension for each sniffed type", async () => {
    const t = await setup();
    const cases: [string, Buffer][] = [
      ["a.png", Buffer.from("GIF89a....")], ["a.jpg", PNG_1x1], ["a.gif", PNG_1x1], ["a.webp", PNG_1x1], ["a.pdf", Buffer.from("<html>")],
      ["a.docx", Buffer.from("plain text")], ["a.xlsx", PNG_1x1], ["a.pptx", Buffer.from("%PDF-1.4")], ["a.txt", Buffer.from([0x41, 0x00, 0x42])], ["a.md", Buffer.from([0x00, 0x01])],
    ];
    for (const [name, content] of cases) {
      const r = await upload(t, "alpha", [{ name: "file", filename: name, content }]);
      expect(r.statusCode, name).toBe(422);
      expect(r.json().message, name).toMatch(/does not match/);
    }
    expect(stored(t.root)).toHaveLength(0);
    expect((await upload(t, "alpha", [{ name: "file", filename: "UP.PNG", content: PNG_1x1 }])).statusCode).toBe(201);
  });

  it("rejects empty and oversize files, leaving no temp part, and accepts exactly the limit", async () => {
    const t = await setup({ uploads: { maxBytes: 2048, maxFiles: 3 } });
    expect((await upload(t, "alpha", [{ name: "file", filename: "e.txt", content: Buffer.alloc(0) }])).statusCode).toBe(422);
    expect((await upload(t, "alpha", [{ name: "file", filename: "ok.txt", content: Buffer.alloc(2048, 65) }])).statusCode).toBe(201);
    const over = await upload(t, "alpha", [{ name: "file", filename: "big.png", content: Buffer.concat([PNG_1x1, Buffer.alloc(3000)]) }]);
    expect(over.statusCode).toBe(422);
    expect(over.json().message).toMatch(/larger than/);
    expect(stored(t.root).filter((f) => f.endsWith(".part"))).toHaveLength(0);
    expect(stored(t.root).filter((f) => !f.endsWith(".meta.json"))).toHaveLength(1);
  });

  it("a request with more files than allowed is refused with a 4xx and leaves no temp part", async () => {
    const t = await setup({ uploads: { maxBytes: 1024 * 1024, maxFiles: 2 } });
    const r = await upload(t, "alpha", [1, 2, 3].map((i) => ({ name: "file", filename: `f${i}.png`, content: PNG_1x1, type: "image/png" })));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(r.body).not.toContain(t.root);
    expect(stored(t.root).filter((f) => f.endsWith(".part"))).toHaveLength(0);
    expect((await upload(t, "alpha", [1, 2].map((i) => ({ name: "file", filename: `f${i}.png`, content: PNG_1x1 })))).statusCode).toBe(201);
  });

  it("a mixed batch with one bad file answers 422 and lists what was accepted", async () => {
    const t = await setup();
    const r = await upload(t, "alpha", [{ name: "file", filename: "good.png", content: PNG_1x1 }, { name: "file", filename: "bad.exe", content: Buffer.from("MZ") }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().details.accepted).toHaveLength(1);
  });

  it("no file, a non-multipart body, an unknown or non-question questionId and an unknown project are rejected", async () => {
    const t = await setup();
    const png = { name: "file", filename: "a.png", content: PNG_1x1 };
    expect((await upload(t, "alpha", [{ name: "note", value: "hi" }])).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: "/api/projects/alpha/uploads", headers: POST_HEADERS, payload: "{}" })).statusCode).toBe(400);
    expect((await upload(t, "alpha", [{ name: "questionId", value: "NOPE" }, png])).statusCode).toBe(400);
    expect((await upload(t, "alpha", [{ name: "questionId", value: "T1" }, png])).statusCode).toBe(400);
    expect((await upload(t, "alpha", [{ name: "questionId", value: "../x" }, png])).statusCode).toBe(400);
    expect((await upload(t, "nope", [png])).statusCode).toBe(404);
    expect(stored(t.root)).toHaveLength(0);
  });

  it("path traversal in the filename cannot place a file outside the upload folder", async () => {
    const t = await setup();
    const names = ["../../../evil.png", "..\\..\\evil.png", "/etc/evil.png", "C:\\Windows\\evil.png", "a/b/../../../evil.png", "%2e%2e%2fevil.png", "..%5cevil.png", "evil.png\u0000.exe"];
    const before = new Set(listFiles(t.root));
    for (const name of names) {
      const r = await upload(t, "alpha", [{ name: "file", filename: name, content: PNG_1x1, type: "image/png" }]);
      expect([201, 422, 400], name).toContain(r.statusCode);
      if (r.statusCode === 201) expect(r.json().attachments[0].originalName, name).not.toMatch(/[\\/]|\.\./);
    }
    const uploadDir = path.resolve(path.join(t.root, "projects", "alpha", "attachments", "answers"));
    for (const f of listFiles(t.root).filter((x) => !before.has(x))) expect(path.resolve(f).startsWith(uploadDir + path.sep), f).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(t.root), "evil.png"))).toBe(false);
  });

  it("a stream that errors mid-upload leaves no stored file, no sidecar and no index entry", async () => {
    const t = await setup();
    const p = t.store.get("alpha")!;
    let sent = false;
    const broken = new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(PNG_1x1.subarray(0, 20));
        setImmediate(() => this.destroy(new Error("client went away")));
      },
    });
    await expect(storeUpload(t.cfg, p, broken as never, "half.png", "tester")).rejects.toThrow(/client went away/);
    expect(stored(t.root)).toHaveLength(0);
    expect(p.uploads.size).toBe(0);
    const trunc = Object.assign(Readable.from([PNG_1x1]), { truncated: true });
    await expect(storeUpload(t.cfg, p, trunc as never, "cut.png", "tester")).rejects.toThrow(/larger than/);
    expect(stored(t.root)).toHaveLength(0);
    expect(p.uploads.size).toBe(0);
  });

  it("a client that aborts the HTTP request mid-multipart leaves nothing published", async () => {
    const t = await setup();
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const mp = multipartBody([{ name: "file", filename: "cut.png", content: Buffer.concat([PNG_1x1, Buffer.alloc(100_000, 1)]), type: "image/png" }]);
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/projects/alpha/uploads", method: "POST", headers: { ...mp.headers, "content-length": String(mp.payload.length) } });
      req.on("error", () => resolve());
      req.write(mp.payload.subarray(0, 600));
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(stored(t.root)).toHaveLength(0);
  });

  it("forged attachment ids in an answer are rejected: nonexistent, record attachment, other project, other question", async () => {
    const t = await setup();
    const up = async (project: string, q?: string) => {
      const r = await upload(t, project, [...(q ? [{ name: "questionId", value: q }] : []), { name: "file", filename: "a.png", content: PNG_1x1 }]);
      expect(r.statusCode).toBe(201);
      return r.json().attachments[0].attachmentId as string;
    };
    const betaUpload = await up("beta");
    const otherQ = await up("alpha", "QCOMP");
    const send = (ids: string[]) => t.app.inject({
      method: "POST", url: "/api/projects/alpha/questions/QFILE/answers", headers: POST_HEADERS,
      payload: JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "files", attachmentIds: ids }], idempotencyKey: key() }),
    });
    for (const [label, id] of [["nonexistent", "UPL-doesnotexist00"], ["record attachment", "ATT-1"], ["other project", betaUpload], ["other question", otherQ], ["traversal", "../x"], ["empty", ""]] as const) {
      expect([400, 422], label).toContain((await send([id])).statusCode);
    }
    expect((await send([])).statusCode).toBe(422);
    const dup = await up("alpha");
    expect((await send([dup, dup])).statusCode).toBeGreaterThanOrEqual(400);
    expect((await send(["UPL-fake0", "UPL-fake1", "UPL-fake2"])).statusCode).toBeGreaterThanOrEqual(400);
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications", "answers", "pending"))).toHaveLength(0);
    expect(listFiles(path.join(t.root, "projects", "alpha", "communications", "claims"))).toHaveLength(0);
    const good = await up("alpha", "QFILE");
    expect((await send([good])).statusCode).toBe(201);
  });
});

describe("4. Data integrity", () => {
  const comm = (root: string, ...p: string[]) => path.join(root, "projects", "alpha", "communications", ...p);

  it("concurrent submits of different answers to one question revision give exactly one 201", async () => {
    const t = await setup();
    const res = await Promise.all(["a", "b", "a", "b", "a", "b", "a", "b"].map((o) => t.submit("alpha", "Q1", [o])));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409 && r.json().error === "already-answered")).toBe(true);
    const winner = res.find((r) => r.statusCode === 201)!.json().answerId as string;
    expect(fs.readdirSync(comm(t.root, "answers", "pending"))).toEqual([`${winner}.json`]);
    expect(fs.readdirSync(comm(t.root, "claims"))).toHaveLength(1);
    expect(fs.readdirSync(comm(t.root, "answers", ".staging"))).toHaveLength(0);
  });

  it("the same idempotency key submitted concurrently yields one 201 and replays for the rest", async () => {
    const t = await setup();
    const k = key();
    const res = await Promise.all(Array.from({ length: 6 }, () => t.submit("alpha", "Q2", ["a"], k)));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(new Set(res.map((r) => r.json().answerId)).size).toBe(1);
    expect(fs.readdirSync(comm(t.root, "answers", "pending"))).toHaveLength(1);
  });

  it("idempotency replay survives a restart, and another key is not a replay", async () => {
    const root = makeDataRoot();
    const t1 = await setup({}, root);
    const k = key();
    const first = await t1.submit("alpha", "Q3", ["a"], k);
    expect(first.statusCode).toBe(201);
    await t1.app.close();
    apps.pop();
    const t2 = await setup({}, root);
    const replay = await t2.submit("alpha", "Q3", ["b"], k);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ answerId: first.json().answerId, replayed: true });
    expect((await t2.submit("alpha", "Q3", ["a"], key())).statusCode).toBe(409);
    expect(fs.readdirSync(comm(root, "answers", "pending"))).toHaveLength(1);
  });

  it("an idempotency key is scoped to its question: the same key on another question is a fresh answer", async () => {
    const t = await setup();
    const k = key();
    const a = await t.submit("alpha", "Q1", ["a"], k);
    const b = await t.submit("alpha", "Q2", ["a"], k);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().answerId).not.toBe(b.json().answerId);
  });

  it("re-answering after a failed answer keeps the earlier failed file and publishes a new answer", async () => {
    const t = await setup();
    const p = t.store.get("alpha")!;
    const first = (await t.submit("alpha", "Q4", ["a"])).json().answerId as string;
    expect((await claimNext(t.store, p, "worker", 60, first))!.answerId).toBe(first);
    await failAnswer(t.store, p, first, "worker", "unusable", false);
    const failedFile = comm(t.root, "answers", "failed", `${first}.json`);
    const before = fs.readFileSync(failedFile, "utf8");
    expect((await t.app.inject("/api/projects/alpha/records/Q4")).json().question.uiState).toBe("failed");
    const second = await t.submit("alpha", "Q4", ["b"]);
    expect(second.statusCode).toBe(201);
    const secondId = second.json().answerId as string;
    expect(secondId).not.toBe(first);
    expect(fs.readFileSync(failedFile, "utf8")).toBe(before);
    expect(fs.existsSync(comm(t.root, "answers", "pending", `${secondId}.json`))).toBe(true);
    expect(fs.readdirSync(comm(t.root, "claims-history")).some((f) => f.includes(first))).toBe(true);
    expect((await t.app.inject("/api/projects/alpha/records/Q4")).json().submittedAnswer.answerId).toBe(secondId);
    expect((await t.app.inject(`/api/projects/alpha/queue/${first}`)).json().processingState).toBe("failed");
    expect((await t.submit("alpha", "Q4", ["a"])).statusCode).toBe(409);
  });

  it("concurrent re-answers after a failure still give exactly one new answer and keep the failed file", async () => {
    const t = await setup();
    const p = t.store.get("alpha")!;
    const first = (await t.submit("alpha", "Q5", ["a"])).json().answerId as string;
    await claimNext(t.store, p, "w", 60, first);
    await failAnswer(t.store, p, first, "w", "bad", false);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => t.submit("alpha", "Q5", [i % 2 ? "a" : "b"])));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(fs.readdirSync(comm(t.root, "answers", "pending"))).toHaveLength(1);
    expect(fs.existsSync(comm(t.root, "answers", "failed", `${first}.json`))).toBe(true);
  });

  it("concurrent HTTP claims get distinct answers, and surplus claimers get 204", async () => {
    const t = await setup();
    const ids = (await Promise.all(["Q1", "Q2", "Q3"].map((q) => t.submit("alpha", q)))).map((r) => r.json().answerId as string);
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      t.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: POST_HEADERS, payload: JSON.stringify({ owner: `w${i}` }) })));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(3);
    expect(claims.filter((c) => c.statusCode === 204)).toHaveLength(2);
    const got = claims.filter((c) => c.statusCode === 200).map((c) => c.json().answerId as string);
    expect(new Set(got).size).toBe(3);
    expect([...got].sort()).toEqual([...ids].sort());
    expect(fs.readdirSync(comm(t.root, "answers", "pending"))).toHaveLength(0);
    expect(fs.readdirSync(comm(t.root, "answers", "processing"))).toHaveLength(3);
  });

  it("many claimers racing for one specific answerId: one 200, the rest 409 not-pending", async () => {
    const t = await setup();
    const id = (await t.submit("alpha", "Q1")).json().answerId as string;
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      t.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: POST_HEADERS, payload: JSON.stringify({ owner: `w${i}`, answerId: id }) })));
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(res.find((r) => r.statusCode === 409)!.json().error).toBe("not-pending");
  });

  it("queue transitions reject wrong owner and wrong state with the documented codes", async () => {
    const t = await setup();
    const id = (await t.submit("alpha", "Q1")).json().answerId as string;
    const call = (action: string, body: unknown) => t.app.inject({ method: "POST", url: `/api/projects/alpha/queue/${id}/${action}`, headers: POST_HEADERS, payload: JSON.stringify(body) });
    expect((await call("complete", { owner: "w1" })).statusCode).toBe(409);
    expect((await call("fail", { owner: "w1", reason: "x" })).statusCode).toBe(409);
    await t.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: POST_HEADERS, payload: JSON.stringify({ owner: "w1", answerId: id }) });
    expect((await call("complete", { owner: "w2" })).json().error).toBe("not-owner");
    expect((await call("fail", { owner: "w2", reason: "x" })).json().error).toBe("not-owner");
    expect((await call("complete", { owner: "w1" })).statusCode).toBe(200);
    expect((await call("complete", { owner: "w1" })).json().error).toBe("wrong-state");
    expect((await call("fail", { owner: "w1", reason: "late" })).json().error).toBe("wrong-state");
  });
});

describe("5. Excel import", () => {
  async function exportBook(t: T, project: string, ids: string[]) {
    const r = await t.app.inject({ method: "POST", url: `/api/projects/${project}/export/xlsx`, headers: POST_HEADERS, payload: JSON.stringify({ questionIds: ids }) });
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    return wb;
  }
  const rowOf = (wb: ExcelJS.Workbook, qid: string) => {
    const ws = wb.getWorksheet("Answers")!;
    for (let i = 2; i <= ws.rowCount; i++) if (ws.getRow(i).getCell(2).value === qid) return ws.getRow(i);
    throw new Error(qid);
  };
  const preview = async (t: T, wb: ExcelJS.Workbook, project = "alpha") => {
    const mp = multipartBody([{ name: "file", filename: "answers.xlsx", content: Buffer.from(await wb.xlsx.writeBuffer()) }]);
    return t.app.inject({ method: "POST", url: `/api/projects/${project}/import/xlsx/preview`, payload: mp.payload, headers: mp.headers });
  };
  const commit = (t: T, previewId: string, questionIds: string[], project = "alpha") =>
    t.app.inject({ method: "POST", url: `/api/projects/${project}/import/xlsx/commit`, headers: POST_HEADERS, payload: JSON.stringify({ previewId, questionIds }) });
  const noAnswers = (t: T, project = "alpha") => expect(listFiles(path.join(t.root, "projects", project, "communications"))).toHaveLength(0);

  it("a workbook exported from another project is rejected at preview and nothing can be committed from it", async () => {
    const t = await setup();
    const wb = await exportBook(t, "beta", ["Q1"]);
    rowOf(wb, "Q1").getCell(12).value = "Keep upright";
    const pv = (await preview(t, wb)).json() as ImportPreview;
    expect(pv.errors.join()).toMatch(/belongs to project 'beta'/);
    expect(pv.totals.ready).toBe(0);
    expect(pv.rows.filter((r) => r.status === "ready")).toHaveLength(0);
    const c = await commit(t, pv.previewId, ["Q1"]);
    if (c.statusCode === 200) expect(c.json().results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    else expect(c.statusCode).toBeGreaterThanOrEqual(400);
    noAnswers(t);
    noAnswers(t, "beta");
  });

  it("a preview created for one project cannot be committed through another project", async () => {
    const t = await setup();
    const wb = await exportBook(t, "alpha", ["Q1"]);
    rowOf(wb, "Q1").getCell(12).value = "Keep upright";
    const pv = (await preview(t, wb)).json() as ImportPreview;
    expect(pv.rows.find((r) => r.questionId === "Q1")!.status).toBe("ready");
    const cross = await commit(t, pv.previewId, ["Q1"], "beta");
    if (cross.statusCode === 200) expect(cross.json().results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    else expect(cross.statusCode).toBeGreaterThanOrEqual(400);
    noAnswers(t, "beta");
    noAnswers(t);
  });

  it("a row whose question is revised between preview and commit is rejected at commit; a fresh preview flags it stale", async () => {
    const t = await setup();
    const wb = await exportBook(t, "alpha", ["Q1", "Q2"]);
    rowOf(wb, "Q1").getCell(12).value = "Keep upright";
    rowOf(wb, "Q2").getCell(12).value = "Keep upright";
    const pv = (await preview(t, wb)).json() as ImportPreview;
    expect(pv.rows.find((r) => r.questionId === "Q2")!.status).toBe("ready");
    const p = t.store.get("alpha")!;
    const file = p.records.get("Q2")!.file;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.questionRevision = 2;
    fs.writeFileSync(file, JSON.stringify(rec));
    await t.store.applyChanges(p.dir, [path.relative(p.dir, file).replace(/\\/g, "/")]);
    const c = await commit(t, pv.previewId, ["Q1", "Q2"]);
    expect(c.statusCode).toBe(200);
    const res = Object.fromEntries((c.json().results as { questionId: string; ok: boolean }[]).map((r) => [r.questionId, r.ok]));
    expect(res).toEqual({ Q1: true, Q2: false });
    expect(fs.readdirSync(path.join(p.dir, "communications", "answers", "pending"))).toHaveLength(1);
    const again = (await preview(t, wb)).json() as ImportPreview;
    expect(again.rows.find((r) => r.questionId === "Q2")!.status).toBe("stale");
  });

  it("formulas in an answer or comment cell are rejected and cannot be committed", async () => {
    const t = await setup();
    const wb = await exportBook(t, "alpha", ["Q1", "Q2", "QTEXT"]);
    rowOf(wb, "Q1").getCell(12).value = { formula: "HYPERLINK(\"http://evil\",\"a\")", result: "Align to surface" } as never;
    rowOf(wb, "Q2").getCell(12).value = "Keep upright";
    rowOf(wb, "Q2").getCell(13).value = { formula: "A1&B1" } as never;
    rowOf(wb, "QTEXT").getCell(12).value = { sharedFormula: "L2", result: "typed" } as never;
    const pv = (await preview(t, wb)).json() as ImportPreview;
    const by = Object.fromEntries(pv.rows.map((r) => [r.questionId, r]));
    expect(by.Q1.status).toBe("invalid");
    expect(by.Q1.messages.join()).toMatch(/formula/);
    expect(by.Q2.status).not.toBe("ready");
    expect(by.Q2.messages.join()).toMatch(/formula/);
    expect(by.QTEXT.status).not.toBe("ready");
    const c = await commit(t, pv.previewId, ["Q1", "Q2", "QTEXT"]);
    expect(c.statusCode).toBe(200);
    expect(c.json().results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    noAnswers(t);
  });

  it("commit with an unknown or malformed previewId fails and writes nothing", async () => {
    const t = await setup();
    const unknown = await commit(t, "a".repeat(24), ["Q1"]);
    expect([404, 409, 410, 422]).toContain(unknown.statusCode);
    expect(unknown.json().error).toBeTruthy();
    expect(unknown.body).not.toContain(t.root);
    for (const bad of ["", "short", "A".repeat(24), "g".repeat(24), "a".repeat(25), "../".repeat(8)]) {
      expect((await commit(t, bad, ["Q1"])).statusCode, bad).toBe(400);
    }
    expect((await commit(t, "a".repeat(24), [])).statusCode).toBe(400);
    noAnswers(t);
  });

  it("committing question ids that are not in the preview fails per question and writes nothing", async () => {
    const t = await setup();
    const wb = await exportBook(t, "alpha", ["Q1"]);
    rowOf(wb, "Q1").getCell(12).value = "Keep upright";
    const pv = (await preview(t, wb)).json() as ImportPreview;
    const c = await commit(t, pv.previewId, ["Q5", "NOPE", "T1"]);
    expect(c.statusCode).toBe(200);
    expect(c.json().results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    noAnswers(t);
  });

  it("rejects non-.xlsx names, oversize workbooks, missing files and non-multipart bodies at preview", async () => {
    const t = await setup({ xlsx: { maxBytes: 20 * 1024, maxRows: 5000 } });
    const buf = Buffer.from(await (await exportBook(t, "alpha", ["Q1"])).xlsx.writeBuffer());
    const send = (parts: Parameters<typeof multipartBody>[0]) => {
      const mp = multipartBody(parts);
      return t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", payload: mp.payload, headers: mp.headers });
    };
    expect((await send([{ name: "file", filename: "answers.csv", content: buf }])).statusCode).toBe(400);
    expect((await send([{ name: "file", filename: "big.xlsx", content: Buffer.concat([buf, Buffer.alloc(40 * 1024, 1)]) }])).statusCode).toBe(413);
    expect((await send([{ name: "other", value: "x" }])).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: "/api/projects/alpha/import/xlsx/preview", headers: POST_HEADERS, payload: "{}" })).statusCode).toBe(400);
  });

  it("a workbook with more rows than the configured maximum is not importable", async () => {
    const t = await setup({ xlsx: { maxBytes: 5 * 1024 * 1024, maxRows: 3 } });
    const wb = await exportBook(t, "alpha", ["Q1", "Q2", "Q3", "Q4", "Q5"]);
    for (const q of ["Q1", "Q2", "Q3", "Q4", "Q5"]) rowOf(wb, q).getCell(12).value = "Keep upright";
    const r = await preview(t, wb);
    if (r.statusCode === 200) {
      const pv = r.json() as ImportPreview;
      expect(pv.errors.length).toBeGreaterThan(0);
      expect(pv.totals.ready).toBe(0);
    } else {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("6. Question states in counts", () => {
  it("a submitted answer is not needs-response in card, attention, navigation, filter and section count, through retry and failure", async () => {
    const t = await setup();
    const cardOf = async () => ((await t.app.inject("/api/projects")).json() as ProjectsResponse).projects.find((p) => p.id === "alpha")!;
    const attention = async () => ((await t.app.inject("/api/projects/alpha/attention")).json() as { questions: { id: string }[] }).questions.map((q) => q.id);
    const sectionCount = async () => ((await t.app.inject("/api/projects/alpha/sections/qs/records?status=all")).json() as RecordPage).needsResponseCount;
    const navCount = async () => {
      const nav = (await t.app.inject("/api/projects/alpha/navigation")).json() as NavigationResponse;
      const found: unknown[] = [];
      const walk = (nodes: unknown[]) => {
        for (const n of nodes as { id: string; counts?: { awaitingResponse: number }; children?: unknown[] }[]) {
          if (n.id === "qs") found.push(n.counts?.awaitingResponse);
          walk(n.children ?? []);
        }
      };
      walk(nav.nodes);
      return found[0];
    };
    const base = (await cardOf()).awaitingResponse;
    expect(base).toBeGreaterThan(0);
    expect(await attention()).toContain("Q1");
    expect(await sectionCount()).toBe(base);
    expect(await navCount()).toBe(base);

    const first = await t.submit("alpha", "Q1");
    expect(first.statusCode).toBe(201);
    const id = first.json().answerId as string;
    const check = async (label: string) => {
      expect((await cardOf()).awaitingResponse, `${label} card`).toBe(base - 1);
      expect(await attention(), `${label} attention`).not.toContain("Q1");
      expect(await sectionCount(), `${label} section`).toBe(base - 1);
      expect(await navCount(), `${label} nav`).toBe(base - 1);
      const needs = (await t.app.inject("/api/projects/alpha/sections/qs/records?status=needs-response")).json() as RecordPage;
      expect(needs.items.map((r) => r.id), `${label} filter`).not.toContain("Q1");
      expect(needs.total, `${label} filter total`).toBe(base - 1);
    };
    await check("pending");
    const p = t.store.get("alpha")!;
    await claimNext(t.store, p, "w", 60, id);
    await check("processing");
    await failAnswer(t.store, p, id, "w", "retry later", true);
    await check("retry-pending");
    await claimNext(t.store, p, "w", 60, id);
    await failAnswer(t.store, p, id, "w", "dead", false);
    expect((await t.app.inject("/api/projects/alpha/records/Q1")).json().question.uiState).toBe("failed");
    await check("failed");
  });

  it("informational, closed, withdrawn and answered questions are never counted as needing a response", async () => {
    const root = makeDataRoot();
    const recs = path.join(root, "projects", "beta", "sections", "backlog", "records");
    writeJson(path.join(recs, "QCLOSED.json"), question("QCLOSED", { status: "closed" }));
    writeJson(path.join(recs, "QWITH.json"), question("QWITH", { status: "withdrawn" }));
    writeJson(path.join(recs, "QANS.json"), question("QANS", { status: "answered" }));
    writeJson(path.join(recs, "QINFO.json"), question("QINFO", { requiresResponse: false, answerSchema: undefined }));
    const t = await setup({}, root);
    const card = ((await t.app.inject("/api/projects")).json() as ProjectsResponse).projects.find((p) => p.id === "beta")!;
    expect(card.awaitingResponse).toBe(1);
    const att = (await t.app.inject("/api/projects/beta/attention")).json() as { questions: { id: string }[] };
    expect(att.questions.map((q) => q.id)).toEqual(["Q1"]);
    const sec = (await t.app.inject("/api/projects/beta/sections/backlog/records?status=all")).json() as RecordPage;
    expect(sec.needsResponseCount).toBe(1);
    const states = Object.fromEntries(sec.items.map((r) => [r.id, r.question?.uiState]));
    expect(states).toMatchObject({ Q1: "needs-response", QCLOSED: "closed", QWITH: "closed", QANS: "answered", QINFO: "informational" });
    const closed = await t.submit("beta", "QCLOSED");
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe("not-open");
  });
});

describe("regression: sibling sections with the same id", () => {
  it("two sibling sections sharing an id are diagnosed and only the first is kept", async () => {
    const root = makeDataRoot();
    const dev = path.join(root, "projects", "alpha", "sections", "dev");
    writeJson(path.join(dev, "dupdesk", "section.json"), section("desk", "page-tab", "Impostor desk", { order: 9 }));
    const h = await makeApp(root);
    apps.push(h);
    expect(h.store.diagnostics().map((d) => d.message).join("\n")).toMatch(/duplicate section id 'desk'/);
    expect(h.store.get("alpha")!.sections.get("desk")!.manifest.title).toBe("Desk");
    const nav = (await h.app.inject("/api/projects/alpha/navigation")).json() as NavigationResponse;
    const ids: string[] = [];
    const walk = (nodes: unknown[]) => { for (const n of nodes as { id: string; children?: unknown[] }[]) { ids.push(n.id); walk(n.children ?? []); } };
    walk(nav.nodes);
    expect(ids.filter((i) => i === "desk")).toHaveLength(1);
  });
});
