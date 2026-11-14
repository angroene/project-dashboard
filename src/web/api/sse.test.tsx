import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { InvalidateEvent } from "../../shared/api";

type Listener = (ev: unknown) => void;

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, ev: unknown = {}) {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.emit("open");
  }
  /** Transient network error: the browser keeps retrying on its own. */
  softError() {
    this.readyState = FakeEventSource.CONNECTING;
    this.emit("error");
  }
  /** The browser gave up (e.g. non-200 response). */
  hardError() {
    this.readyState = FakeEventSource.CLOSED;
    this.emit("error");
  }
  message(ev: unknown) {
    this.emit("invalidate", { data: typeof ev === "string" ? ev : JSON.stringify(ev) });
  }
}

const last = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

function seed(qc: QueryClient) {
  const keys = [
    ["projects"],
    ["diagnostics"],
    ["project", "a", "detail"],
    ["project", "a", "navigation"],
    ["project", "a", "progress"],
    ["project", "a", "activity"],
    ["project", "a", "records", "s1", {}],
    ["project", "a", "attention"],
    ["project", "a", "record", "R-1"],
    ["project", "a", "record", "R-2"],
    ["project", "b", "records", "s1", {}],
  ];
  for (const k of keys) qc.setQueryData(k, 1);
  return (k: unknown[]) => qc.getQueryState(k)!.isInvalidated;
}

describe("applyInvalidation", () => {
  const run = async (ev: Parameters<typeof import("./sse").applyInvalidation>[1]) => {
    const { applyInvalidation } = await import("./sse");
    const qc = new QueryClient();
    const stale = seed(qc);
    applyInvalidation(qc, ev);
    return stale;
  };

  it("progress scope touches only that project's progress", async () => {
    const stale = await run({ projectId: "a", scopes: ["progress"] });
    expect(stale(["project", "a", "progress"])).toBe(true);
    expect(stale(["project", "a", "activity"])).toBe(false);
    expect(stale(["projects"])).toBe(false);
  });

  it("projects scope refreshes lists, diagnostics and project detail", async () => {
    const stale = await run({ projectId: "a", scopes: ["projects"] });
    expect(stale(["projects"])).toBe(true);
    expect(stale(["diagnostics"])).toBe(true);
    expect(stale(["project", "a", "detail"])).toBe(true);
    expect(stale(["project", "a", "navigation"])).toBe(false);
  });

  it("records scope without ids refreshes lists, attention and every record of the project only", async () => {
    const stale = await run({ projectId: "a", scopes: ["records"] });
    expect(stale(["project", "a", "records", "s1", {}])).toBe(true);
    expect(stale(["project", "a", "attention"])).toBe(true);
    expect(stale(["project", "a", "record", "R-1"])).toBe(true);
    expect(stale(["project", "a", "record", "R-2"])).toBe(true);
    expect(stale(["project", "b", "records", "s1", {}])).toBe(false);
  });

  it("records scope with ids refreshes only those record details", async () => {
    const stale = await run({ projectId: "a", scopes: ["answers"], recordIds: ["R-2"] });
    expect(stale(["project", "a", "record", "R-2"])).toBe(true);
    expect(stale(["project", "a", "record", "R-1"])).toBe(false);
    expect(stale(["project", "a", "attention"])).toBe(true);
  });

  it("a null project id applies to every project", async () => {
    const stale = await run({ projectId: null, scopes: ["navigation"] });
    expect(stale(["project", "a", "navigation"])).toBe(true);
  });

  it("no scopes invalidates nothing", async () => {
    const stale = await run({ projectId: "a", scopes: [] });
    expect(stale(["project", "a", "records", "s1", {}])).toBe(false);
    expect(stale(["projects"])).toBe(false);
  });
});

describe("useServerEvents", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(enabled = true) {
    const mod = await import("./sse");
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const view = renderHook(() => ({ fallback: mod.useSseFallback() }));
    const hook = renderHook(({ on }) => mod.useServerEvents(qc, on), { initialProps: { on: enabled } });
    return { qc, invalidate, view, hook };
  }

  it("does not connect while disabled", async () => {
    await setup(false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("connects to /api/updates and applies invalidate events", async () => {
    const { qc } = await setup();
    expect(last().url).toBe("/api/updates");
    qc.setQueryData(["project", "a", "progress"], 1);
    act(() => last().message({ projectId: "a", scopes: ["progress"] } satisfies InvalidateEvent));
    expect(qc.getQueryState(["project", "a", "progress"])!.isInvalidated).toBe(true);
  });

  it("ignores a malformed event with a warning and keeps working", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setup();
    expect(() => act(() => last().message("{not json"))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to polling after three consecutive errors and recovers on open", async () => {
    const { view, invalidate } = await setup();
    act(() => last().open());
    expect(view.result.current.fallback).toBe(false);
    act(() => last().softError());
    act(() => last().softError());
    expect(view.result.current.fallback).toBe(false);
    act(() => last().softError());
    expect(view.result.current.fallback).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => last().open());
    expect(view.result.current.fallback).toBe(false);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("a successful open resets the error count", async () => {
    const { view } = await setup();
    act(() => last().softError());
    act(() => last().softError());
    act(() => last().open());
    act(() => last().softError());
    act(() => last().softError());
    expect(view.result.current.fallback).toBe(false);
  });

  it("does not refresh everything on the first open, only after missed events", async () => {
    const { invalidate } = await setup();
    act(() => last().open());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("when the browser closes the connection, falls back at once and reconnects after 60 s", async () => {
    const { view } = await setup();
    const first = last();
    act(() => first.hardError());
    expect(first.closed).toBe(true);
    expect(view.result.current.fallback).toBe(true);
    act(() => void vi.advanceTimersByTime(59_999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => last().open());
    expect(view.result.current.fallback).toBe(false);
  });

  it("keeps retrying every 60 s while the server stays unreachable", async () => {
    await setup();
    act(() => last().hardError());
    act(() => void vi.advanceTimersByTime(60_000));
    act(() => last().hardError());
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("unmount closes the live source", async () => {
    const { hook } = await setup();
    const live = last();
    hook.unmount();
    expect(live.closed).toBe(true);
  });

  it("unmount cancels a pending reconnect", async () => {
    const { hook } = await setup();
    act(() => last().hardError());
    hook.unmount();
    act(() => void vi.advanceTimersByTime(120_000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("uses the polling fallback when EventSource is unavailable", async () => {
    vi.stubGlobal("EventSource", undefined);
    const { view } = await setup();
    expect(view.result.current.fallback).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
