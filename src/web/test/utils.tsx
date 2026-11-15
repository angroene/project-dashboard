import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { NavNode, ProjectCard, RecordDetail, RecordPage, RecordSummary, SessionInfo } from "../../shared/api";
import { buildNavIndex, ProjectContext, SessionContext, type ProjectCtx } from "../context";
import { ToastProvider } from "../components/Toasts";

// ------------------------------------------------------------ fetch mock --
export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | unknown;
type Handler = (call: Call) => Reply | Promise<Reply>;

/**
 * Replaces global fetch. Routes are keyed "METHOD /path" (no query string); a handler returns the JSON body,
 * or { status, body } for errors. Unknown routes answer 404 so tests fail with a visible error.
 */
export function mockFetch(routes: Record<string, Handler | unknown>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call: Call = { method, path: url.pathname, query: url.searchParams, headers, body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return json({ error: "not-found", message: `no mock for ${method} ${url.pathname}` }, 404);
    const reply = typeof route === "function" ? await (route as Handler)(call) : route;
    if (reply && typeof reply === "object" && "status" in reply && typeof (reply as { status: unknown }).status === "number") {
      const r = reply as { status: number; body?: unknown; headers?: Record<string, string> };
      return json(r.body ?? {}, r.status, r.headers);
    }
    return json(reply, 200);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    count: (method: string, path: string | RegExp) => calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))).length,
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// ------------------------------------------------------------- rendering --
export const session: SessionInfo = {
  authMode: "required",
  authRequired: false,
  authenticated: true,
  user: "operator",
  productName: "Test Dashboard",
  uploadLimits: { maxBytes: 1024 * 1024, maxFiles: 5, allowedMimeTypes: ["image/png", "image/jpeg", "text/plain"] },
};

export function newQueryClient() {
  // Same caching policy as the app (main.tsx), without retries so errors surface immediately.
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false, retry: false } } });
}

export function renderWithProviders(
  ui: ReactElement,
  opts: { project?: Partial<ProjectCtx> & { nodes?: NavNode[] }; session?: SessionInfo; client?: QueryClient } = {},
) {
  const client = opts.client ?? newQueryClient();
  const ctx: ProjectCtx | null = opts.project
    ? { pid: opts.project.pid ?? "p1", navIndex: opts.project.navIndex ?? buildNavIndex(opts.project.nodes ?? []), focus: opts.project.focus ?? null }
    : null;
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SessionContext.Provider value={opts.session ?? session}>
          {ctx ? <ProjectContext.Provider value={ctx}>{children}</ProjectContext.Provider> : children}
        </SessionContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return { ...result, client, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

// ------------------------------------------------------------- builders --
export function card(over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    id: "alpha",
    displayName: "Alpha Example",
    description: "First example project",
    order: 10,
    accent: "indigo",
    available: true,
    progress: { overallPercent: 64, label: "Milestones", method: "Owner estimate", updatedAt: "2026-11-01T10:00:00Z", stale: false },
    awaitingResponse: 0,
    awaitingPickup: 0,
    unreadUpdates: 0,
    blocked: 0,
    active: 0,
    ...over,
  };
}

export function node(over: Partial<NavNode> & Pick<NavNode, "id" | "displayType" | "title">): NavNode {
  return {
    description: "",
    order: 10,
    defaultOpen: false,
    views: [],
    actions: ["copy", "open-detail"],
    filters: { sort: "updated-desc" },
    pageSize: 25,
    counts: { records: 0, awaitingResponse: 0, unread: 0 },
    children: [],
    ...over,
  };
}

export function summary(over: Partial<RecordSummary> & Pick<RecordSummary, "id" | "title">): RecordSummary {
  return {
    recordType: "task",
    sectionId: "cards",
    summary: "",
    status: "in-progress",
    statusLabel: "In progress",
    statusCategory: "active",
    statusTone: "info",
    priority: "none",
    updatedAt: "2026-11-10T10:00:00Z",
    attachmentCount: 0,
    unread: false,
    actions: ["copy", "open-detail"],
    ...over,
  };
}

export function detail(over: Partial<RecordDetail> & Pick<RecordDetail, "id" | "title">): RecordDetail {
  return {
    ...summary(over),
    revision: "0123456789abcdef",
    fieldDefs: [],
    canComment: false,
    bodyMarkdown: "",
    attachments: [],
    links: [],
    linkedRecords: [],
    metadata: {},
    history: [],
    ...over,
  };
}

export function page(items: RecordSummary[], extra: Partial<{ statusCounts: Record<string, number>; statusLabels: Record<string, string>; unfilteredTotal: number; nextCursor: string | null; needsResponseCount: number } & Pick<RecordPage, "fieldDefs" | "fieldCounts" | "templates" | "canComment">> = {}) {
  return {
    sectionId: "cards", total: items.length, unfilteredTotal: extra.unfilteredTotal ?? items.length, statusCounts: extra.statusCounts ?? {}, statusLabels: extra.statusLabels ?? {},
    ...(extra.needsResponseCount !== undefined ? { needsResponseCount: extra.needsResponseCount } : {}),
    fieldDefs: extra.fieldDefs ?? [], fieldCounts: extra.fieldCounts ?? {}, templates: extra.templates ?? [], canComment: extra.canComment ?? false,
    items, nextCursor: extra.nextCursor ?? null,
  };
}
