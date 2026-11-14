import { useMemo, useSyncExternalStore } from "react";

export type ProjectRoute = { kind: "project"; projectId: string; path: string[]; record?: string };
export type Route = { kind: "home" } | { kind: "diagnostics" } | ProjectRoute | { kind: "notfound" };

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses `#/`, `#/diagnostics`, `#/p/:projectId[/:sectionId...][?record=:recordId]`. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q + 1) : "";
  const segs = pathPart.split("/").filter(Boolean).map(safeDecode);
  if (segs.length === 0) return { kind: "home" };
  if (segs[0] === "diagnostics" && segs.length === 1) return { kind: "diagnostics" };
  if (segs[0] === "p" && segs[1]) {
    const record = new URLSearchParams(query).get("record") ?? undefined;
    return { kind: "project", projectId: segs[1], path: segs.slice(2), record: record || undefined };
  }
  return { kind: "notfound" };
}

export const homeHref = "#/";
export const diagnosticsHref = "#/diagnostics";

export function projectHref(projectId: string, path: string[] = [], record?: string): string {
  const p = path.map((s) => "/" + encodeURIComponent(s)).join("");
  return `#/p/${encodeURIComponent(projectId)}${p}${record ? "?record=" + encodeURIComponent(record) : ""}`;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function useRoute(): Route {
  const hash = useHash();
  return useMemo(() => parseHash(hash), [hash]);
}

export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) {
    history.replaceState(history.state, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (window.location.hash !== href) {
    window.location.hash = href;
  }
}
