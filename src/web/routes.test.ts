import { afterEach, describe, expect, it, vi } from "vitest";
import { attentionHref, diagnosticsHref, homeHref, navigate, parseHash, projectHref } from "./routes";

describe("parseHash", () => {
  it("maps empty and root hashes to home", () => {
    for (const h of ["", "#", "#/", "#//"]) expect(parseHash(h)).toEqual({ kind: "home" });
  });

  it("recognises diagnostics only as a single segment", () => {
    expect(parseHash("#/diagnostics")).toEqual({ kind: "diagnostics" });
    expect(parseHash("#/diagnostics/extra")).toEqual({ kind: "notfound" });
  });

  it("parses project id, tab path and record", () => {
    expect(parseHash("#/p/alpha")).toEqual({ kind: "project", projectId: "alpha", path: [], record: undefined });
    expect(parseHash("#/p/alpha/work/board?record=T-1")).toEqual({ kind: "project", projectId: "alpha", path: ["work", "board"], record: "T-1" });
  });

  it("treats an empty record parameter as no record and ignores other parameters", () => {
    expect(parseHash("#/p/alpha?record=")).toMatchObject({ record: undefined });
    expect(parseHash("#/p/alpha?other=1")).toMatchObject({ record: undefined });
  });

  it("returns notfound for unknown roots and a project without id", () => {
    expect(parseHash("#/nope")).toEqual({ kind: "notfound" });
    expect(parseHash("#/p")).toEqual({ kind: "notfound" });
    expect(parseHash("#/p/")).toEqual({ kind: "notfound" });
  });

  it("decodes escaped segments and keeps malformed escapes verbatim instead of throwing", () => {
    expect(parseHash("#/p/a%20b/c%2Fd")).toMatchObject({ projectId: "a b", path: ["c/d"] });
    expect(parseHash("#/p/100%/x")).toMatchObject({ projectId: "100%", path: ["x"] });
  });

  it("ignores empty segments from doubled or trailing slashes", () => {
    expect(parseHash("#/p//alpha//work/")).toMatchObject({ projectId: "alpha", path: ["work"] });
  });
});

describe("attention deep links", () => {
  it("parses a known group and ignores an unknown one", () => {
    expect(parseHash(attentionHref("alpha", "actions"))).toEqual({ kind: "project", projectId: "alpha", path: [], attention: "actions" });
    expect(parseHash("#/p/alpha?attention=everything")).toEqual({ kind: "project", projectId: "alpha", path: [] });
    expect(parseHash("#/p/a%20b?attention=updates&record=R1")).toEqual({ kind: "project", projectId: "a b", path: [], record: "R1", attention: "updates" });
  });
});

describe("projectHref", () => {
  it("builds the minimal and full forms", () => {
    expect(homeHref).toBe("#/");
    expect(diagnosticsHref).toBe("#/diagnostics");
    expect(projectHref("alpha")).toBe("#/p/alpha");
    expect(projectHref("alpha", ["work", "board"], "T-1")).toBe("#/p/alpha/work/board?record=T-1");
  });

  it("round-trips ids containing reserved characters", () => {
    const cases: [string, string[], string | undefined][] = [
      ["a b", ["x/y", "z?q"], "R #1&2"],
      ["100%", ["é ü"], undefined],
      ["p", [], "T=1"],
    ];
    for (const [pid, path, record] of cases) {
      expect(parseHash(projectHref(pid, path, record))).toEqual({ kind: "project", projectId: pid, path, record });
    }
  });

  it("omits the query for an empty record id", () => {
    expect(projectHref("alpha", [], "")).toBe("#/p/alpha");
  });
});

describe("navigate", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("sets the hash for a normal navigation", () => {
    navigate("#/diagnostics");
    expect(window.location.hash).toBe("#/diagnostics");
  });

  it("does nothing when already at the target", () => {
    window.location.hash = "#/diagnostics";
    const spy = vi.fn();
    window.addEventListener("hashchange", spy);
    navigate("#/diagnostics");
    window.removeEventListener("hashchange", spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it("replace updates the URL without adding history and still notifies listeners", () => {
    const spy = vi.fn();
    window.addEventListener("hashchange", spy);
    const len = history.length;
    navigate("#/p/alpha", { replace: true });
    window.removeEventListener("hashchange", spy);
    expect(window.location.hash).toBe("#/p/alpha");
    expect(history.length).toBe(len);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
