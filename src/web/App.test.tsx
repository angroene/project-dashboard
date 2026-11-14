import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionInfo } from "../shared/api";
import { App } from "./App";
import { card, mockFetch, node, renderWithProviders, session } from "./test/utils";

const open: SessionInfo = { ...session, authRequired: false, authenticated: true, productName: "Example Center" };
const locked: SessionInfo = { ...session, authRequired: true, authenticated: false, productName: "Example Center" };
const signedIn: SessionInfo = { ...locked, authenticated: true };

const projects = { productName: "Example Center", projects: [card({ id: "alpha", displayName: "Alpha Example" })], diagnosticsCount: 0 };
const nav = { rootChildType: "expandable-card", nodes: [node({ id: "cards", displayType: "expandable-card", title: "Work items" })] };

function projectRoutes() {
  return {
    "GET /api/projects": projects,
    "GET /api/projects/alpha": card({ id: "alpha", displayName: "Alpha Example", description: "First example project" }),
    "GET /api/projects/alpha/navigation": nav,
    "GET /api/projects/alpha/sections/cards/records": { sectionId: "cards", total: 0, unfilteredTotal: 0, statusCounts: {}, statusLabels: {}, items: [], nextCursor: null },
  };
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
  });
}

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "";
    document.title = "";
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  it("shows a connecting state while the session loads", () => {
    mockFetch({ "GET /api/session": () => new Promise(() => {}) });
    renderWithProviders(<App />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agents Project Dashboard/ })).toBeInTheDocument();
  });

  it("explains an unreachable server and retries the session request", async () => {
    let up = false;
    const api = mockFetch({
      "GET /api/session": () => (up ? open : { status: 502, body: { error: "bad-gateway", message: "Upstream down" } }),
      ...projectRoutes(),
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the dashboard server: Upstream down");
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: /Alpha Example/ })).toBeInTheDocument();
    expect(api.count("GET", "/api/session")).toBe(2);
  });

  it("requires login when auth is required and the visitor is not authenticated: no project data is requested", async () => {
    const api = mockFetch({ "GET /api/session": locked, ...projectRoutes() });
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(api.count("GET", "/api/projects")).toBe(0);
  });

  it("swaps the login gate for the app after signing in", async () => {
    let authed = false;
    mockFetch({
      "GET /api/session": () => (authed ? signedIn : locked),
      "POST /api/auth/login": () => {
        authed = true;
        return {};
      },
      ...projectRoutes(),
    });
    renderWithProviders(<App />);
    await userEvent.type(await screen.findByLabelText("Access token"), "secret-token");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("link", { name: /Alpha Example/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("shows no login when auth is not required, and no Sign out button", async () => {
    mockFetch({ "GET /api/session": open, ...projectRoutes() });
    renderWithProviders(<App />);
    expect(await screen.findByRole("link", { name: /Alpha Example/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("sets the document title and header brand from the session product name", async () => {
    mockFetch({ "GET /api/session": open, ...projectRoutes() });
    renderWithProviders(<App />);
    await screen.findByRole("link", { name: /Alpha Example/ });
    expect(document.title).toBe("Example Center");
    expect(screen.getAllByRole("link", { name: /Example Center/ })[0]).toHaveAttribute("href", "#/");
  });

  it("falls back to the default product name when the session has none", async () => {
    mockFetch({ "GET /api/session": { ...open, productName: "" }, ...projectRoutes() });
    renderWithProviders(<App />);
    await screen.findByRole("link", { name: /Alpha Example/ });
    expect(document.title).toBe("Agents Project Dashboard");
  });

  it("signing out clears cached data and returns to the login gate", async () => {
    let authed = true;
    const api = mockFetch({
      "GET /api/session": () => (authed ? signedIn : locked),
      "POST /api/auth/logout": () => {
        authed = false;
        return {};
      },
      ...projectRoutes(),
    });
    const { client } = renderWithProviders(<App />);
    await screen.findByRole("link", { name: /Alpha Example/ });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(api.count("POST", "/api/auth/logout")).toBe(1);
    expect(client.getQueryData(["projects"])).toBeUndefined();
  });

  it("keeps the user signed in and reports an error when sign out fails", async () => {
    mockFetch({
      "GET /api/session": signedIn,
      "POST /api/auth/logout": { status: 500, body: { error: "internal", message: "Session store down" } },
      ...projectRoutes(),
    });
    renderWithProviders(<App />);
    await screen.findByRole("link", { name: /Alpha Example/ });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/Sign out failed: .*Session store down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("routes from the project list into a project workspace and back", async () => {
    mockFetch({ "GET /api/session": open, ...projectRoutes() });
    renderWithProviders(<App />);
    const link = await screen.findByRole("link", { name: /Alpha Example/ });
    expect(link).toHaveAttribute("href", "#/p/alpha");
    await userEvent.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha Example" })).toBeInTheDocument();
    expect(screen.getByText("First example project")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Work items/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("All projects");

    await userEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "All projects" }));
    expect(await screen.findByRole("link", { name: /Alpha Example/ })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
  });

  it("opens a project directly from the URL hash and reacts to later hash changes", async () => {
    window.location.hash = "#/p/alpha";
    mockFetch({ "GET /api/session": open, ...projectRoutes() });
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha Example" })).toBeInTheDocument();
    go("#/");
    expect(await screen.findByRole("heading", { level: 1, name: "Example Center" })).toBeInTheDocument();
  });

  it("shows an error note in the workspace when the project does not exist", async () => {
    window.location.hash = "#/p/ghost";
    mockFetch({
      "GET /api/session": open,
      "GET /api/projects/ghost": { status: 404, body: { error: "not-found", message: "Unknown project ghost" } },
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load project: Unknown project ghost");
  });

  it("shows an error note on the landing page when the project list fails", async () => {
    mockFetch({
      "GET /api/session": open,
      "GET /api/projects": { status: 500, body: { error: "internal", message: "Index unavailable" } },
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load projects: Index unavailable");
  });

  it("renders the diagnostics page for #/diagnostics", async () => {
    window.location.hash = "#/diagnostics";
    mockFetch({
      "GET /api/session": open,
      "GET /api/diagnostics": { indexedAt: "2026-11-10T10:00:00Z", projects: [], diagnostics: [] },
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
  });

  it("shows a not-found page with a way back for unknown routes", async () => {
    window.location.hash = "#/nowhere";
    mockFetch({ "GET /api/session": open, ...projectRoutes() });
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to all projects" })).toHaveAttribute("href", "#/");
  });

  it("remounts the workspace when switching between projects", async () => {
    window.location.hash = "#/p/alpha";
    mockFetch({
      "GET /api/session": open,
      ...projectRoutes(),
      "GET /api/projects/beta": card({ id: "beta", displayName: "Beta Example" }),
      "GET /api/projects/beta/navigation": { rootChildType: null, nodes: [] },
    });
    renderWithProviders(<App />);
    await screen.findByRole("heading", { level: 1, name: "Alpha Example" });
    go("#/p/beta");
    expect(await screen.findByRole("heading", { level: 1, name: "Beta Example" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Alpha Example" })).toBeNull());
    expect(await screen.findByText("No sections yet")).toBeInTheDocument();
  });
});
