import { useEffect, useSyncExternalStore } from "react";
import type { Query, QueryClient } from "@tanstack/react-query";
import type { InvalidateEvent } from "../../shared/api";
import { qk } from "./client";

type Scope = InvalidateEvent["scopes"][number];
type Predicate = (q: Query) => boolean;

/** Per client: queries that were invalidated while a fetch was running, refreshed again when it settles. */
const followUps = new WeakMap<QueryClient, Set<string>>();

/**
 * Invalidates without cancelling a fetch that is already running. React Query's default would cancel it, which drops
 * a user's "Load more" when a live update arrives during the page load. A query that was busy is refreshed again
 * once its fetch settles, so the change is never lost.
 */
export function invalidate(qc: QueryClient, predicate: Predicate): void {
  let busy = followUps.get(qc);
  if (!busy) {
    const set = new Set<string>();
    followUps.set(qc, set);
    busy = set;
    qc.getQueryCache().subscribe((ev) => {
      const q = ev.query;
      if (ev.type !== "updated" || q.state.fetchStatus !== "idle" || !set.delete(q.queryHash)) return;
      void qc.invalidateQueries({ queryKey: q.queryKey, exact: true }, { cancelRefetch: false });
    });
  }
  for (const q of qc.getQueryCache().findAll({ predicate })) if (q.state.fetchStatus !== "idle") busy.add(q.queryHash);
  void qc.invalidateQueries({ predicate }, { cancelRefetch: false });
}

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
    invalidate(qc, (q) => q.queryKey[0] === qk.projects[0] || q.queryKey[0] === qk.diagnostics[0]);
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
    invalidate(qc, (q) => matchesProject(q.queryKey) && sub.has(String(q.queryKey[2])));
  }
  if (touchesRecords && recordIds.length > 0) {
    const ids = new Set(recordIds);
    invalidate(qc, (q) => matchesProject(q.queryKey) && q.queryKey[2] === "record" && ids.has(String(q.queryKey[3])));
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
          invalidate(qc, () => true);
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
