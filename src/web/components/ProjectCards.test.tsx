import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsLanding } from "./ProjectCards";
import { card, mockFetch, renderWithProviders } from "../test/utils";

const response = (projects: ReturnType<typeof card>[], diagnosticsCount = 0) => ({ productName: "Example Center", projects, diagnosticsCount });

describe("ProjectsLanding", () => {
  it("shows a loading state, then one card per project with the published percentage", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "alpha", displayName: "Alpha Example", progress: { overallPercent: 64, label: "Milestones", method: "Owner estimate", stale: false } })]) });
    renderWithProviders(<ProjectsLanding />);
    expect(screen.getByText(/Loading projects/)).toHaveAttribute("role", "status");
    const link = await screen.findByRole("link", { name: /Alpha Example/ });
    expect(link).toHaveAttribute("href", "#/p/alpha");
    expect(screen.getByRole("heading", { level: 1, name: "Example Center" })).toBeInTheDocument();
    const bar = within(link).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "64");
    expect(bar).toHaveAccessibleName("Alpha Example: Milestones");
    expect(link).toHaveTextContent("64%");
    expect(link).toHaveTextContent(/Method: Owner estimate/);
  });

  it("shows Not reported and no bar or percentage when the project publishes no progress", async () => {
    mockFetch({ "GET /api/projects": response([card({ id: "beta", displayName: "Beta Example", progress: { overallPercent: null, label: "Overall progress", method: "", stale: false } })]) });
    renderWithProviders(<ProjectsLanding />);
    const link = await screen.findByRole("link", { name: /Beta Example/ });
    expect(link).toHaveTextContent("Not reported");
    expect(within(link).queryByRole("progressbar")).toBeNull();
    expect(link.textContent).not.toMatch(/\d+%/);
  });

  it("rounds but never invents a percentage, and flags stale progress in text", async () => {
    mockFetch({ "GET /api/projects": response([card({ progress: { overallPercent: 12.6, label: "Done", method: "", stale: true } })]) });
    renderWithProviders(<ProjectsLanding />);
    const link = await screen.findByRole("link", { name: /Alpha Example/ });
    expect(link).toHaveTextContent("13%");
    expect(link).toHaveTextContent("Stale");
  });

  it("shows attention counts as text, separately for questions, unread updates, pickup and blockers", async () => {
    mockFetch({
      "GET /api/projects": response([
        card({ id: "busy", displayName: "Busy Example", awaitingResponse: 3, unreadUpdates: 1, awaitingPickup: 2, blocked: 1, active: 4 }),
        card({ id: "calm", displayName: "Calm Example" }),
      ]),
    });
    renderWithProviders(<ProjectsLanding />);
    const busy = await screen.findByRole("link", { name: /Busy Example/ });
    expect(busy).toHaveTextContent("Needs attention");
    expect(busy).toHaveTextContent("3 questions need response");
    expect(busy).toHaveTextContent("1 unread update");
    expect(busy).toHaveTextContent("2 submitted · awaiting pickup");
    expect(busy).toHaveTextContent("1 blocked");
    expect(busy).toHaveTextContent("4 active");
    const calm = screen.getByRole("link", { name: /Calm Example/ });
    expect(calm).toHaveTextContent("Up to date");
    expect(calm).toHaveTextContent("0 questions need response");
    expect(calm).not.toHaveTextContent("blocked");
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
    expect(await screen.findByRole("link", { name: /Alpha Example/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.count("GET", "/api/projects")).toBe(2);
  });
});
