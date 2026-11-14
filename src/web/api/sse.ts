import { useEffect, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { InvalidateEvent } from "../../shared/api";
import { qk } from "./client";

type Scope = InvalidateEvent["scopes"][number];

/**
 * Invalidates only the react-query entries affected by a change.
 * Used for server "invalidate" events and after local mutations.
 */
export function applyInvalidation(qc: QueryClient, ev: { projectId: string | null; scopes: Scope[]; recordIds?: string[] }): void {
  const scopes = new Set(ev.scopes);
  const sub = new Set<string>();
  const recordIds = ev.recordIds ?? [];
  const touchesRecords = scopes.has("records") || scopes.has("answers");

  if (scopes.has("projects")) {
    sub.add("detail");
    void qc.invalidateQueries({ queryKey: qk.projects });
    void qc.invalidateQueries({ queryKey: qk.diagnostics });
  }
  if (scopes.has("navigation")) sub.add("navigation");
  if (scopes.has("progress")) sub.add("progress");
  if (scopes.has("activity")) sub.add("activity");
  if (touchesRecords) {
    sub.add("records");
    sub.add("attention");
    if (recordIds.length === 0) sub.add("record");
  }

  const matchesProject = (key: readonly unknown[]) => key[0] === "project" && (ev.projectId == null || key[1] === ev.projectId);
  if (sub.size > 0) {
    void qc.invalidateQueries({ predicate: (q) => matchesProject(q.queryKey) && sub.has(String(q.queryKey[2])) });
  }
  if (touchesRecords && recordIds.length > 0) {
    const ids = new Set(recordIds);
    void qc.invalidateQueries({
      predicate: (q) => matchesProject(q.queryKey) && q.queryKey[2] === "record" && ids.has(String(q.queryKey[3])),
    });
  }
}

let fallback = false;
const listeners = new Set<() => void>();
function setFallback(v: boolean): void {
  if (fallback === v) return;
  fallback = v;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while live updates are unavailable; the projects list then polls every 60 s. */
export function useSseFallback(): boolean {
  return useSyncExternalStore(subscribe, () => fallback);
}

const MAX_ERRORS_BEFORE_FALLBACK = 3;
const RECONNECT_AFTER_CLOSE_MS = 60_000;

/** One app-wide EventSource on /api/updates. */
export function useServerEvents(qc: QueryClient, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === "undefined") {
      setFallback(true);
      return;
    }
    let es: EventSource | null = null;
    let errors = 0;
    let missedEvents = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      es = new EventSource("/api/updates");
      es.addEventListener("open", () => {
        errors = 0;
        setFallback(false);
        if (missedEvents) {
          missedEvents = false;
          // Events may have been missed while disconnected: refresh whatever is on screen.
          void qc.invalidateQueries();
        }
      });
      es.addEventListener("invalidate", (ev) => {
        try {
          applyInvalidation(qc, JSON.parse((ev as MessageEvent<string>).data) as InvalidateEvent);
        } catch (e) {
          console.warn("Ignoring malformed invalidate event", e);
        }
      });
      es.addEventListener("error", () => {
        errors++;
        missedEvents = true;
        if (es && es.readyState === EventSource.CLOSED) {
          // The browser gave up (e.g. non-200 response); retry ourselves later.
          es.close();
          es = null;
          setFallback(true);
          if (!disposed) timer = setTimeout(connect, RECONNECT_AFTER_CLOSE_MS);
        } else if (errors >= MAX_ERRORS_BEFORE_FALLBACK) {
          setFallback(true);
        }
      });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [qc, enabled]);
}
