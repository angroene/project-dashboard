import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionInfo } from "../shared/api";
import { apiGet, apiPost, errorMessage, qk } from "./api/client";
import { useServerEvents } from "./api/sse";
import { SessionContext } from "./context";
import { homeHref, useRoute, type Route } from "./routes";
import { ErrorNote, Loading } from "./components/common";
import { Login } from "./components/Login";
import { ProjectsLanding } from "./components/ProjectCards";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { Diagnostics } from "./components/Diagnostics";
import { useToast } from "./components/Toasts";

const DEFAULT_PRODUCT = "Agents Project Dashboard";

export function App() {
  const session = useQuery({ queryKey: qk.session, queryFn: ({ signal }) => apiGet<SessionInfo>("/api/session", signal), staleTime: 5 * 60_000 });
  const s = session.data;
  const productName = s?.productName || DEFAULT_PRODUCT;
  const authed = !!s && (!s.authRequired || s.authenticated);

  useEffect(() => {
    document.title = productName;
  }, [productName]);

  if (session.isPending) {
    return (
      <Shell productName={productName} session={null}>
        <Loading label="Connecting…" />
      </Shell>
    );
  }
  if (session.isError || !s) {
    return (
      <Shell productName={productName} session={null}>
        <ErrorNote prefix="Could not reach the dashboard server" error={session.error} onRetry={() => void session.refetch()} />
      </Shell>
    );
  }
  if (!authed) {
    return (
      <Shell productName={productName} session={s}>
        <Login productName={productName} />
      </Shell>
    );
  }
  return (
    <SessionContext.Provider value={s}>
      <Shell productName={productName} session={s}>
        <AuthedApp />
      </Shell>
    </SessionContext.Provider>
  );
}

function Shell({ productName, session, children }: { productName: string; session: SessionInfo | null; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const signOut = async () => {
    try {
      await apiPost("/api/auth/logout", {});
    } catch (e) {
      toast(`Sign out failed: ${errorMessage(e)}`, "error");
      return;
    }
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    await qc.invalidateQueries({ queryKey: qk.session });
  };
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <a className="brand" href={homeHref}>
          <span className="logo" aria-hidden="true">
            ◈
          </span>
          <span>{productName}</span>
        </a>
        <nav className="header-nav" aria-label="Global">
          <a className="btn ghost" href={homeHref}>
            <span aria-hidden="true">⌂</span> All projects
          </a>
          {session?.authRequired && session.authenticated && (
            <button type="button" className="btn ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main className="shell" id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}

function routeScope(r: Route): string {
  return r.kind === "project" ? `project:${r.projectId}` : r.kind;
}

function AuthedApp() {
  const qc = useQueryClient();
  useServerEvents(qc, true);
  const route = useRoute();
  useScrollMemory(route);

  switch (route.kind) {
    case "home":
      return <ProjectsLanding />;
    case "diagnostics":
      return <Diagnostics />;
    case "project":
      return <ProjectWorkspace key={route.projectId} route={route} />;
    default:
      return (
        <div className="panel">
          <h1>Page not found</h1>
          <p>
            <a href={homeHref}>Back to all projects</a>
          </p>
        </div>
      );
  }
}

/**
 * Remembers scroll per page (landing / each project / diagnostics) and restores it when switching back.
 * Tab changes within one project keep the current scroll position.
 */
function useScrollMemory(route: Route): void {
  const positions = useRef(new Map<string, number>());
  const scope = routeScope(route);
  const current = useRef(scope);
  const first = useRef(true);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => positions.current.set(current.current, window.scrollY));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    current.current = scope;
    if (first.current) {
      first.current = false;
      return;
    }
    const y = positions.current.get(scope) ?? 0;
    const raf = requestAnimationFrame(() => {
      window.scrollTo(0, y);
      document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [scope]);
}
