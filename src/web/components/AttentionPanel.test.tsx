import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttentionPanel } from "./AttentionPanel";
import { mockFetch, node, renderWithProviders, summary } from "../test/utils";

const PID = "p1";
const ATTENTION = `/api/projects/${PID}/attention`;

const question = summary({
  id: "Q-1",
  title: "Pick a vendor",
  recordType: "question",
  sectionId: "decisions",
  unread: true,
  question: { uiState: "needs-response", revision: 1, requiresResponse: true, dueAt: "2026-12-01T10:00:00Z" },
});
const update = summary({ id: "T-9", title: "Sensors calibrated", sectionId: "orphan-section" });

const nodes = [node({ id: "work", displayType: "main-tab", title: "Work", children: [node({ id: "decisions", displayType: "page-tab", title: "Decisions" })] })];

describe("AttentionPanel", () => {
  it("shows a loading state first, then the empty message when nothing needs attention", async () => {
    mockFetch({ [`GET ${ATTENTION}`]: { questions: [], unreadRecords: [] } });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID } });
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(await screen.findByText("Nothing needs your attention.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("lists questions and unread updates in separate groups with counts", async () => {
    mockFetch({ [`GET ${ATTENTION}`]: { questions: [question], unreadRecords: [update, summary({ id: "T-10", title: "Second update" })] } });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    expect(await screen.findByRole("heading", { level: 3, name: "Questions awaiting your response (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Unread updates (2)" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("Nothing needs your attention.")).toBeNull();
  });

  it("links each item to its tab path with the record focused, and shows section, state and due date", async () => {
    mockFetch({ [`GET ${ATTENTION}`]: { questions: [question], unreadRecords: [] } });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    const link = await screen.findByRole("link", { name: /Pick a vendor/ });
    expect(link).toHaveAttribute("href", "#/p/p1/work/decisions?record=Q-1");
    const item = link.closest("li")!;
    expect(within(item).getByText("Q-1")).toBeInTheDocument();
    expect(item).toHaveTextContent("Decisions");
    expect(item).toHaveTextContent("Needs response");
    expect(item).toHaveTextContent(/due/);
    expect(within(item).getByText("Needs response")).toHaveClass("pill-warn");
  });

  it("falls back to a root link and omits the section when the record's section is not in navigation", async () => {
    mockFetch({ [`GET ${ATTENTION}`]: { questions: [], unreadRecords: [update] } });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    const link = await screen.findByRole("link", { name: /Sensors calibrated/ });
    expect(link).toHaveAttribute("href", "#/p/p1?record=T-9");
    const meta = link.closest("li")!;
    expect(meta).not.toHaveTextContent("Decisions");
    expect(meta).not.toHaveTextContent(/due/);
  });

  it("shows the server error and retries on request", async () => {
    let fail = true;
    const api = mockFetch({
      [`GET ${ATTENTION}`]: () => (fail ? { status: 500, body: { error: "internal", message: "Disk unavailable" } } : { questions: [], unreadRecords: [update] }),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: /Sensors calibrated/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.count("GET", ATTENTION)).toBe(2);
  });
});
