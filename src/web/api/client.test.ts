import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError, apiGet, apiPost, filenameFromDisposition, qk, setUnauthorizedHandler } from "./client";
import { applyInvalidation } from "./sse";
import { mockFetch } from "../test/utils";

describe("api client", () => {
  it("POST sends the CSRF header and JSON body; GET does not send it", async () => {
    const api = mockFetch({ "POST /api/x": { ok: true }, "GET /api/y": { v: 1 } });
    await expect(apiPost("/api/x", { a: 1 })).resolves.toEqual({ ok: true });
    await expect(apiGet("/api/y")).resolves.toEqual({ v: 1 });
    expect(api.calls[0].headers["x-pcc-request"]).toBe("1");
    expect(api.calls[0].body).toEqual({ a: 1 });
    expect(api.calls[1].headers["x-pcc-request"]).toBeUndefined();
  });

  it("turns error bodies into ApiRequestError with field errors; non-JSON bodies fall back to the status line", async () => {
    mockFetch({ "POST /api/x": { status: 422, body: { error: "validation", message: "bad", fieldErrors: [{ fieldId: "f", message: "m" }] } } });
    const err = await apiPost("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(422);
    expect((err as ApiRequestError).message).toBe("bad");
    expect((err as ApiRequestError).fieldErrors).toEqual([{ fieldId: "f", message: "m" }]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" })));
    await expect(apiGet("/api/z")).rejects.toThrow("502 Bad Gateway");
  });

  it("calls the unauthorized handler on 401, except for auth and session endpoints", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch({ "GET /api/projects": { status: 401, body: { error: "unauthorized", message: "login" } }, "GET /api/session": { status: 401, body: { error: "unauthorized", message: "login" } } });
    await apiGet("/api/session").catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled();
    await apiGet("/api/projects").catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(() => {});
  });

  it.each([
    ['attachment; filename="report.xlsx"', "report.xlsx"],
    ["attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "résumé.pdf"],
    ['attachment; filename="../../etc/passwd"', ".._.._etc_passwd"],
    ["attachment; filename*=UTF-8''%E0%A4%A; filename=plain.txt", "plain.txt"],
    ["inline", null],
    [null, null],
  ])("filenameFromDisposition(%s) = %s", (header, expected) => {
    expect(filenameFromDisposition(header)).toBe(expected);
  });
});

describe("applyInvalidation", () => {
  function seeded() {
    const qc = new QueryClient();
    const keys = [
      qk.projects,
      qk.diagnostics,
      qk.projectDetail("a"),
      qk.navigation("a"),
      qk.records("a", "s", { status: "", q: "", sort: "updated-desc", limit: 25 }),
      qk.record("a", "R-1"),
      qk.record("a", "R-2"),
      qk.progress("a"),
      qk.activity("a"),
      qk.attention("a"),
      qk.records("b", "s", { status: "", q: "", sort: "updated-desc", limit: 25 }),
    ];
    for (const k of keys) qc.setQueryData(k, {});
    const stale = () => qc.getQueryCache().getAll().filter((q) => q.state.isInvalidated).map((q) => JSON.stringify(q.queryKey.slice(0, 4)));
    return { qc, stale };
  }

  it("records with ids: list, attention and only the named record of that project", () => {
    const { qc, stale } = seeded();
    applyInvalidation(qc, { projectId: "a", scopes: ["records"], recordIds: ["R-1"] });
    expect(stale().sort()).toEqual(['["project","a","attention"]', '["project","a","record","R-1"]', '["project","a","records","s"]'].sort());
  });

  it("records without ids invalidate every record detail of the project", () => {
    const { qc, stale } = seeded();
    applyInvalidation(qc, { projectId: "a", scopes: ["records"] });
    expect(stale()).toEqual(expect.arrayContaining(['["project","a","record","R-1"]', '["project","a","record","R-2"]']));
    expect(stale()).not.toContain('["project","b","records","s"]');
  });

  it("projects scope refreshes the landing list, diagnostics and project detail", () => {
    const { qc, stale } = seeded();
    applyInvalidation(qc, { projectId: "a", scopes: ["projects", "progress", "activity", "navigation"] });
    expect(stale().sort()).toEqual(['["projects"]', '["diagnostics"]', '["project","a","detail"]', '["project","a","navigation"]', '["project","a","progress"]', '["project","a","activity"]'].sort());
  });

  it("a null project id applies to every project", () => {
    const { qc, stale } = seeded();
    applyInvalidation(qc, { projectId: null, scopes: ["records"], recordIds: ["X"] });
    expect(stale()).toEqual(expect.arrayContaining(['["project","a","records","s"]', '["project","b","records","s"]']));
  });
});
