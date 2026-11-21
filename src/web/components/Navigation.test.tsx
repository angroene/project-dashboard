import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NavigationResponse, NavNode } from "../../shared/api";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { attentionResponse, card, mockFetch, node, page, renderWithProviders, summary } from "../test/utils";

const PID = "p1";

function routes(nav: NavigationResponse, extra: Record<string, unknown> = {}) {
  return mockFetch({
    [`GET /api/projects/${PID}`]: card({ id: PID, displayName: "Example Project" }),
    [`GET /api/projects/${PID}/navigation`]: nav,
    [`GET /api/projects/${PID}/progress`]: { overallPercent: null, label: "Progress", method: "", stale: false, breakdown: [] },
    [`GET /api/projects/${PID}/attention`]: attentionResponse(),
    [`GET /api/projects/${PID}/activity`]: { items: [], nextCursor: null, unreadCount: 0 },
    ...extra,
  });
}

const recordsRoute = (sectionId: string, title: string) => ({
  [`GET /api/projects/${PID}/sections/${sectionId}/records`]: page([summary({ id: `${sectionId}-r1`, title, sectionId })]),
});

/** main-tab → page-tabs → cards, plus a main-tab holding a card directly. Titles are parameters. */
function mainTabNav(t: { areaA: string; areaB: string; view1: string; view2: string }): NavigationResponse {
  const nodes: NavNode[] = [
    node({
      id: "area-a",
      displayType: "main-tab",
      title: t.areaA,
      description: "first area",
      counts: { records: 2, awaitingResponse: 2, unread: 1 },
      children: [
        node({ id: "view-1", displayType: "page-tab", title: t.view1, children: [node({ id: "card-1", displayType: "expandable-card", title: "Card One", defaultOpen: true })] }),
        node({ id: "view-2", displayType: "page-tab", title: t.view2, children: [node({ id: "card-2", displayType: "expandable-card", title: "Card Two", defaultOpen: true })] }),
      ],
    }),
    node({ id: "area-b", displayType: "main-tab", title: t.areaB, children: [node({ id: "card-3", displayType: "expandable-card", title: "Card Three" })] }),
  ];
  return { projectId: PID, rootChildType: "main-tab", nodes };
}

describe("ProjectWorkspace navigation (manifest-driven)", () => {
  it.each([
    { areaA: "Engineering", areaB: "Design", view1: "Backlog", view2: "Reviews" },
    { areaA: "Studio Floor", areaB: "Archive", view1: "Today", view2: "Later" },
  ])("renders main-tabs as work areas with labels from the manifest ($areaA / $areaB)", async (t) => {
    routes(mainTabNav(t));
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: [] }} />);
    const areas = await screen.findByRole("navigation", { name: "Work areas" });
    const links = within(areas).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([expect.stringContaining(t.areaA), expect.stringContaining(t.areaB)]);
    expect(links[0]).toHaveAttribute("href", `#/p/${PID}/area-a`);
    // Screen readers get "2 need response"; the visible short form "to answer" is aria-hidden.
    // jsdom's name computation drops the separators' trailing spaces; browsers keep them.
    expect(links[0]).toHaveAccessibleName(new RegExp(String.raw`^${t.areaA}:\s*first area,\s*2 need response,\s*1 unread$`));
    expect(links[0]).toHaveTextContent("to answer");
    // No area selected → project overview, no tab list.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Needs your attention" })).toBeInTheDocument();
  });

  it("selecting a main-tab shows its page-tabs with the first selected and that tab's open cards", async () => {
    const api = routes(mainTabNav({ areaA: "Engineering", areaB: "Design", view1: "Backlog", view2: "Reviews" }), recordsRoute("card-1", "Row in card one"));
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-a"] }} />);
    const tablist = await screen.findByRole("tablist", { name: "Engineering" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Backlog", "Reviews"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    const areas = screen.getByRole("navigation", { name: "Work areas" });
    expect(within(areas).getByRole("link", { name: /Engineering/ })).toHaveAttribute("aria-current", "page");
    expect(within(areas).getByRole("link", { name: /Design/ })).not.toHaveAttribute("aria-current");
    expect(await screen.findByText("Row in card one")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Backlog");
    expect(screen.queryByText("Card Two")).toBeNull();
    expect(api.count("GET", `/api/projects/${PID}/sections/card-2/records`)).toBe(0);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("All projects");
    expect(crumbs).toHaveTextContent("Engineering");
    expect(crumbs).toHaveTextContent("Backlog");
  });

  it("a main-tab may hold expandable cards directly (collapsed unless defaultOpen)", async () => {
    const api = routes(mainTabNav({ areaA: "A", areaB: "B", view1: "V1", view2: "V2" }));
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-b"] }} />);
    const toggle = await screen.findByRole("button", { name: /Card Three/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(api.count("GET", /\/records$/)).toBe(0);
  });

  it("page-tabs at the root render a root tab bar; the path selects the tab", async () => {
    const nav: NavigationResponse = {
      projectId: PID,
      rootChildType: "page-tab",
      nodes: [
        node({ id: "milestones", displayType: "page-tab", title: "Milestones", children: [node({ id: "ms", displayType: "expandable-card", title: "Milestone list", defaultOpen: true })] }),
        node({ id: "backlog", displayType: "page-tab", title: "Backlog", children: [node({ id: "bl", displayType: "expandable-card", title: "Backlog items", defaultOpen: true })] }),
      ],
    };
    routes(nav, recordsRoute("bl", "Backlog row"));
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["backlog"] }} />);
    const tablist = await screen.findByRole("tablist", { name: "Example Project views" });
    expect(within(tablist).getByRole("tab", { name: "Backlog" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Backlog row")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Work areas" })).toBeNull();
  });

  it("expandable cards at the root render next to the overview", async () => {
    const nav: NavigationResponse = {
      projectId: PID,
      rootChildType: "expandable-card",
      nodes: [node({ id: "inbox", displayType: "expandable-card", title: "Inbox" }), node({ id: "notes", displayType: "expandable-card", title: "Notes" })],
    };
    routes(nav);
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: [] }} />);
    expect(await screen.findByRole("button", { name: /Inbox/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Notes/ })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Work areas" })).toBeNull();
  });

  it("a pinned card shows its newest record above the tabs on every view; the full card stays in its tab", async () => {
    const yesNo = { id: "go", label: "Going?", type: "yes-no" as const, editableBy: ["user" as const], filter: false };
    const nav: NavigationResponse = {
      projectId: PID,
      rootChildType: "page-tab",
      nodes: [
        node({ id: "work", displayType: "page-tab", title: "Work", children: [node({ id: "tasks", displayType: "expandable-card", title: "Tasks", defaultOpen: true })] }),
        node({ id: "desk", displayType: "page-tab", title: "Desk", children: [node({ id: "daily", displayType: "expandable-card", title: "Tonight", pinned: true, defaultOpen: true })] }),
      ],
    };
    const api = routes(nav, {
      ...recordsRoute("tasks", "Task row"),
      [`GET /api/projects/${PID}/sections/daily/records`]: { ...page([summary({ id: "day-2", title: "Tonight day 2", sectionId: "daily", fields: { go: true } })]), fieldDefs: [yesNo] },
    });
    const r = renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: [] }} />);
    const pinned = await screen.findByRole("region", { name: "Tonight" });
    expect(await within(pinned).findByText("Tonight day 2")).toBeInTheDocument();
    expect(within(pinned).getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
    // Above the tabs, without the list chrome, and fetched as a single newest record.
    const tablist = screen.getByRole("tablist", { name: "Example Project views" });
    expect(pinned.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pinned).queryByRole("searchbox")).toBeNull();
    expect(api.calls.some((c) => c.path.endsWith("/sections/daily/records") && c.query.get("limit") === "1")).toBe(true);
    // Another tab: still on top.
    r.rerender(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["work"] }} />);
    expect(await screen.findByText("Task row")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tonight" })).toBeInTheDocument();
    // Its own tab: the pinned copy plus the full card with its list.
    r.rerender(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["desk"] }} />);
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByRole("searchbox")).toBeInTheDocument();
  });

  it("a pinned card answers a choice field with one button per option; a tap saves that option, no Submit", async () => {
    const plan = { id: "plan", label: "Tonight's plan", type: "choice" as const, editableBy: ["user" as const], filter: false,
      options: [{ id: "test", label: "Play-test" }, { id: "review", label: "Review only" }, { id: "off", label: "Night off" }] };
    const nav: NavigationResponse = {
      projectId: PID,
      rootChildType: "page-tab",
      nodes: [node({ id: "desk", displayType: "page-tab", title: "Desk", children: [node({ id: "daily", displayType: "expandable-card", title: "Tonight", pinned: true })] })],
    };
    const saved: unknown[] = [];
    routes(nav, {
      [`GET /api/projects/${PID}/sections/daily/records`]: { ...page([summary({ id: "day-1", title: "Tonight day 1", sectionId: "daily", fields: { plan: "test" } })]), fieldDefs: [plan] },
      [`POST /api/projects/${PID}/records/day-1/user-update`]: (c: { body: unknown }) => { saved.push(c.body); return { revision: "r2" }; },
    });
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: [] }} />);
    const pinned = await screen.findByRole("region", { name: "Tonight" });
    const group = await within(pinned).findByRole("group", { name: "Tonight's plan: Tonight day 1" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Play-test", "Review only", "Night off"]);
    expect(within(group).getByRole("button", { name: "Play-test" })).toHaveAttribute("aria-pressed", "true");
    expect(within(pinned).queryByRole("button", { name: /Submit/ })).toBeNull();
    await userEvent.click(within(group).getByRole("button", { name: "Night off" }));
    await waitFor(() => expect(saved).toEqual([{ fields: { plan: "off" } }]));
    expect(within(group).getByRole("button", { name: "Night off" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reports an unknown section in the path instead of guessing", async () => {
    routes(mainTabNav({ areaA: "A", areaB: "B", view1: "V1", view2: "V2" }));
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["renamed-away"] }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("“renamed-away” does not exist");
  });

  it("tabs are keyboard operable: arrows, Home and End move focus and select the tab", async () => {
    routes(mainTabNav({ areaA: "Area", areaB: "Other", view1: "One", view2: "Two" }), { ...recordsRoute("card-1", "r1"), ...recordsRoute("card-2", "r2") });
    renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-a"] }} />);
    const one = await screen.findByRole("tab", { name: "One" });
    const two = screen.getByRole("tab", { name: "Two" });
    expect(one).toHaveAttribute("tabindex", "0");
    expect(two).toHaveAttribute("tabindex", "-1");
    one.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(two).toHaveFocus();
    expect(window.location.hash).toBe(`#/p/${PID}/area-a/view-2`);
    await userEvent.keyboard("{ArrowRight}"); // wraps around
    expect(one).toHaveFocus();
    expect(window.location.hash).toBe(`#/p/${PID}/area-a/view-1`);
    await userEvent.keyboard("{End}");
    expect(two).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(one).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(two).toHaveFocus();
  });

  it("switching tabs back uses cached data: no refetch of the list or the navigation", async () => {
    const api = routes(mainTabNav({ areaA: "Area", areaB: "Other", view1: "One", view2: "Two" }), { ...recordsRoute("card-1", "Row one"), ...recordsRoute("card-2", "Row two") });
    const r = renderWithProviders(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-a", "view-1"] }} />);
    await screen.findByText("Row one");
    r.rerender(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-a", "view-2"] }} />);
    await screen.findByText("Row two");
    r.rerender(<ProjectWorkspace route={{ kind: "project", projectId: PID, path: ["area-a", "view-1"] }} />);
    // Cached content renders immediately, without a loading state.
    expect(screen.getByText("Row one")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true"));
    expect(api.count("GET", `/api/projects/${PID}/sections/card-1/records`)).toBe(1);
    expect(api.count("GET", `/api/projects/${PID}/sections/card-2/records`)).toBe(1);
    expect(api.count("GET", `/api/projects/${PID}/navigation`)).toBe(1);
    expect(api.count("GET", `/api/projects/${PID}`)).toBe(1);
  });
});
