import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsLanding } from "./ProjectCards";
import { card, mockFetch, renderWithProviders } from "../test/utils";

const response = (projects: ReturnType<typeof card>[], diagnosticsCount = 0) => ({ productName: "Example Center", projects, diagnosticsCount });

describe("ProjectsLanding", () => {
  const cardOf = (name: string) => screen.getByRole("link", { name }).closest(".project") as HTMLElement;
  const expand = async (name: string) => {
    await userEvent.click(screen.getByRole("button", { name: `Show details for ${name}` }));
    return cardOf(name);
  };

  it("shows a loading state, then one collapsed card per project: name, then its published percentage", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "alpha", displayName: "Alpha Example", progress: { overallPercent: 64, label: "Milestones", method: "Owner estimate", stale: false } })]) });
    renderWithProviders(<ProjectsLanding />);
    expect(screen.getByText(/Loading projects/)).toHaveAttribute("role", "status");
    const link = await screen.findByRole("link", { name: "Alpha Example" });
    expect(link).toHaveAttribute("href", "#/p/alpha");
    expect(screen.getByRole("heading", { level: 1, name: "Example Center" })).toBeInTheDocument();
    const box = cardOf("Alpha Example");
    // Collapsed: one compact bar with an accessible percentage; the details are hidden.
    const bars = within(box).getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute("aria-valuenow", "64");
    expect(bars[0]).toHaveAttribute("aria-valuetext", "64%");
    expect(bars[0]).toHaveAccessibleName("Alpha Example: Milestones");
    expect(screen.getByRole("button", { name: "Show details for Alpha Example" })).toHaveAttribute("aria-expanded", "false");
    expect(box.querySelector(".project-details")).not.toBeVisible();
    await expand("Alpha Example");
    expect(screen.getByRole("button", { name: "Hide details for Alpha Example" })).toHaveAttribute("aria-expanded", "true");
    const details = box.querySelector(".project-details") as HTMLElement;
    expect(details).toBeVisible();
    expect(within(details).getByRole("progressbar")).toHaveAccessibleName("Alpha Example: Milestones");
    expect(details).toHaveTextContent("64%");
    expect(details).toHaveTextContent(/Method: Owner estimate/);
    expect(within(details).getByRole("link", { name: /Open project/ })).toHaveAttribute("href", "#/p/alpha");
  });

  it("shows no status line, bar or percentage when there is neither attention nor progress; details say Not reported", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "beta", displayName: "Beta Example", progress: { overallPercent: null, label: "Overall progress", method: "", stale: false } })]) });
    renderWithProviders(<ProjectsLanding />);
    await screen.findByRole("link", { name: "Beta Example" });
    const box = cardOf("Beta Example");
    expect(within(box).queryByRole("progressbar")).toBeNull();
    expect(box.querySelector(".project-line")).toBeEmptyDOMElement();
    expect(box.querySelector(".project-line")!.textContent).not.toMatch(/\d+%|attention/);
    await expand("Beta Example");
    expect(box).toHaveTextContent("Not reported");
    expect(within(box).queryByRole("progressbar")).toBeNull();
    expect(box.textContent).not.toMatch(/\d+%/);
  });

  it("rounds but never invents a percentage, and flags stale progress in text", async () => {
    mockFetch({ "GET /api/projects": response([card({ progress: { overallPercent: 12.6, label: "Done", method: "", stale: true } })]) });
    renderWithProviders(<ProjectsLanding />);
    await screen.findByRole("link", { name: "Alpha Example" });
    expect(cardOf("Alpha Example").querySelector(".project-line")).toHaveTextContent("13%");
    const box = await expand("Alpha Example");
    expect(box).toHaveTextContent("13%");
    expect(box).toHaveTextContent("Stale");
  });

  it("prefers 'N require attention' over progress when collapsed, counting only items that need action", async () => {
    mockFetch({
      "GET /api/projects": response([
        card({ id: "busy", displayName: "Busy Example", awaitingResponse: 3, outstandingActions: 2, requireAttention: 4, unreadUpdates: 1, awaitingPickup: 2, blocked: 1, active: 4 }),
        card({ id: "calm", displayName: "Calm Example", unreadUpdates: 7 }),
      ]),
    });
    renderWithProviders(<ProjectsLanding />);
    await screen.findByRole("link", { name: "Busy Example" });
    const busy = cardOf("Busy Example");
    const need = within(busy).getByRole("link", { name: /4 require attention/ });
    expect(need).toHaveAttribute("href", "#/p/busy?attention=questions");
    expect(within(busy.querySelector(".project-line") as HTMLElement).queryByRole("progressbar")).toBeNull();
    // Unread updates alone are informational: no attention line, the progress bar instead.
    const calm = cardOf("Calm Example");
    expect(calm).not.toHaveTextContent(/attention/);
    expect(within(calm).getByRole("progressbar")).toBeInTheDocument();
    await expand("Busy Example");
    expect(busy).toHaveTextContent("3 questions need response");
    expect(busy).toHaveTextContent("2 actions to do");
    expect(busy).toHaveTextContent("1 unread update");
    expect(busy).toHaveTextContent("2 submitted · awaiting pickup");
    expect(busy).toHaveTextContent("1 blocked");
    expect(busy).toHaveTextContent("4 active");
    await expand("Calm Example");
    expect(calm).toHaveTextContent("0 questions need response");
    expect(calm).toHaveTextContent("7 unread updates");
    expect(calm).not.toHaveTextContent("blocked");
  });

  it("expands and collapses from the keyboard without opening the project, one card at a time", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "a", displayName: "A very long project name that keeps going and going past the width of a phone screen" }), card({ id: "b", displayName: "Second" })]) });
    renderWithProviders(<ProjectsLanding />);
    const toggle = await screen.findByRole("button", { name: /Show details for A very long project name/ });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(window.location.hash).not.toContain("#/p/a");
    expect(screen.getByRole("button", { name: "Show details for Second" })).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeVisible();
  });

  it("renders an unavailable project as a non-link card with its reason", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "broken", displayName: "Broken Example", available: false, unavailableReason: "project.json: invalid JSON" })], 1) });
    renderWithProviders(<ProjectsLanding />);
    await screen.findByText("Broken Example");
    expect(screen.queryByRole("link", { name: /Broken Example/ })).toBeNull();
    expect(screen.getByText("project.json: invalid JSON")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1 configuration problem/ })).toHaveAttribute("href", "#/diagnostics");
  });

  it("shows an empty state when no projects are registered", async () => {
    mockFetch({ "GET /api/projects": response([]) });
    renderWithProviders(<ProjectsLanding />);
    expect(await screen.findByRole("heading", { name: "No projects registered" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /configuration problem/ })).toBeNull();
  });

  it("keeps a load error visible and recovers on Retry", async () => {
    let fail = true;
    const api = mockFetch({
      "GET /api/projects": () => (fail ? { status: 500, body: { error: "internal", message: "index not ready" } } : response([card()])),
    });
    renderWithProviders(<ProjectsLanding />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load projects: index not ready");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Alpha Example" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.count("GET", "/api/projects")).toBe(2);
  });
});
