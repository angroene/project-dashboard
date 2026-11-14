import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiagnosticsResponse } from "../../shared/api";
import { Diagnostics } from "./Diagnostics";
import { mockFetch, renderWithProviders } from "../test/utils";

const data: DiagnosticsResponse = {
  indexedAt: "2026-11-10T10:00:00Z",
  projects: [
    { id: "alpha", records: 12, sections: 3, indexMs: 42 },
    { id: "beta", records: 0, sections: 1, indexMs: 5 },
  ],
  diagnostics: [
    { level: "error", projectId: "alpha", path: "cards/bad.md", message: "Invalid front matter" },
    { level: "warning", message: "Unknown status label" },
  ],
};

describe("Diagnostics", () => {
  it("lists problems with level, project and path, using a dash when absent", async () => {
    mockFetch({ "GET /api/diagnostics": data });
    renderWithProviders(<Diagnostics />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Problems (2)" })).toBeInTheDocument();
    const [problems] = screen.getAllByRole("table");
    const rows = within(problems).getAllByRole("row");
    expect(within(rows[1]).getByText("Error")).toBeInTheDocument();
    expect(within(rows[1]).getByText("alpha")).toBeInTheDocument();
    expect(within(rows[1]).getByText("cards/bad.md")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Invalid front matter")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Warning")).toBeInTheDocument();
    expect(within(rows[2]).getAllByText("—")).toHaveLength(2);
    expect(screen.getByText(/Index built/)).toBeInTheDocument();
  });

  it("shows the per-project index table", async () => {
    mockFetch({ "GET /api/diagnostics": data });
    renderWithProviders(<Diagnostics />);
    await screen.findByRole("heading", { name: "Project index" });
    const index = screen.getAllByRole("table")[1];
    const rows = within(index).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("alpha")).toBeInTheDocument();
    expect(within(rows[1]).getByText("12")).toBeInTheDocument();
    expect(within(rows[1]).getByText("42 ms")).toBeInTheDocument();
  });

  it("says so when there are no problems", async () => {
    mockFetch({ "GET /api/diagnostics": { ...data, diagnostics: [] } });
    renderWithProviders(<Diagnostics />);
    expect(await screen.findByText("No configuration problems found.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Problems (0)" })).toBeInTheDocument();
  });

  it("links back to all projects", async () => {
    mockFetch({ "GET /api/diagnostics": data });
    renderWithProviders(<Diagnostics />);
    expect(screen.getByRole("link", { name: "All projects" })).toHaveAttribute("href", "#/");
    await screen.findByText("Problems (2)");
  });

  it("shows an error with a working retry when the request fails", async () => {
    let fail = true;
    const api = mockFetch({ "GET /api/diagnostics": () => (fail ? { status: 500, body: { error: "internal", message: "index unavailable" } } : data) });
    renderWithProviders(<Diagnostics />);
    expect(await screen.findByText(/index unavailable/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Problems (2)")).toBeInTheDocument();
    expect(api.count("GET", "/api/diagnostics")).toBe(2);
  });
});
