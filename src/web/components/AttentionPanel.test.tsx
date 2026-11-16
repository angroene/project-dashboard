import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttentionGroup, AttentionPage, RecordSummary } from "../../shared/api";
import { AttentionPanel } from "./AttentionPanel";
import { attentionResponse, mockFetch, node, renderWithProviders, summary } from "../test/utils";

const PID = "p1";
const ATTENTION = `/api/projects/${PID}/attention`;
const groupPath = (g: AttentionGroup) => `${ATTENTION}/${g}`;
const pageOf = (group: AttentionGroup, items: RecordSummary[], all = false, nextCursor: string | null = null, total = items.length): AttentionPage => ({ group, all, total, items, nextCursor });

const question = summary({
  id: "Q-1",
  title: "Pick a vendor",
  recordType: "question",
  sectionId: "decisions",
  question: { uiState: "needs-response", revision: 1, requiresResponse: true, dueAt: "2026-12-01T10:00:00Z" },
});
const answered = summary({
  id: "Q-0",
  title: "Old vendor question",
  recordType: "question",
  sectionId: "decisions",
  question: { uiState: "processed", revision: 1, requiresResponse: true },
});
const action = summary({ id: "A-1", title: "Plug in the test rig", sectionId: "decisions", requiresAction: true, actionOutstanding: true });
const update = summary({ id: "T-9", title: "Sensors calibrated", sectionId: "orphan-section", unread: true });
const update2 = summary({ id: "T-10", title: "Second update", unread: true });

const nodes = [node({ id: "work", displayType: "main-tab", title: "Work", children: [node({ id: "decisions", displayType: "page-tab", title: "Decisions" })] })];

describe("AttentionPanel", () => {
  it("shows a loading state first, then a compact All caught up with no group lists when nothing is pending", async () => {
    mockFetch({ [`GET ${ATTENTION}`]: attentionResponse({ totals: { questions: 4, actions: 0, responses: 2, updates: 9 }, unreadActivity: 2 }) });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID } });
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    const status = await screen.findByText(/All caught up/);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("2 unread activity events below");
    // History exists but stays hidden until Show all.
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Show all" })).not.toBeChecked();
  });

  it("separates Questions, Actions and Updates with accurate pending counts, and lists only pending items", async () => {
    const api = mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 1, actions: 1, responses: 0, updates: 2 } }),
      [`GET ${groupPath("questions")}`]: pageOf("questions", [question]),
      [`GET ${groupPath("actions")}`]: pageOf("actions", [action]),
      [`GET ${groupPath("updates")}`]: pageOf("updates", [update, update2]),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    expect(await screen.findByRole("button", { name: "Questions: 1 awaiting your answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions: 1 to do" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updates: 2 unread" })).toBeInTheDocument();
    // A group with nothing pending is not rendered; its index chip is plain text.
    expect(screen.queryByRole("button", { name: /^Responses/ })).toBeNull();
    const index = screen.getByRole("navigation", { name: "Attention groups" });
    expect(within(index).getByRole("link", { name: /Questions\s*1\s*pending/ })).toBeInTheDocument();
    expect(within(index).queryByRole("link", { name: /Responses/ })).toBeNull();
    expect(within(index).getByText("Responses")).toBeInTheDocument();
    await screen.findByRole("link", { name: /Second update/ });
    expect(within(screen.getByRole("region", { name: "Actions" })).getByText("To do")).toHaveClass("pill-warn");
    // Default lists ask the server for pending items only.
    expect(api.calls.filter((c) => c.path.startsWith(`${ATTENTION}/`)).every((c) => c.query.get("all") === null)).toBe(true);
  });

  it("links each item to its tab path with the record focused, and shows section, state and due date", async () => {
    mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 1, actions: 0, responses: 0, updates: 1 } }),
      [`GET ${groupPath("questions")}`]: pageOf("questions", [question]),
      [`GET ${groupPath("updates")}`]: pageOf("updates", [update]),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    const link = await screen.findByRole("link", { name: /Pick a vendor/ });
    expect(link).toHaveAttribute("href", "#/p/p1/work/decisions?record=Q-1");
    const item = link.closest("li")!;
    expect(within(item).getByText("Q-1")).toBeInTheDocument();
    expect(item).toHaveTextContent("Decisions");
    expect(item).toHaveTextContent(/due/);
    expect(within(item).getByText("Needs response")).toHaveClass("pill-warn");
    // Not in navigation: root link, no section name.
    const orphan = await screen.findByRole("link", { name: /Sensors calibrated/ });
    expect(orphan).toHaveAttribute("href", "#/p/p1?record=T-9");
    expect(orphan.closest("li")).not.toHaveTextContent("Decisions");
  });

  it("Show all reveals answered and read history without changing anything, and is off again on reopen", async () => {
    const api = mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 1, actions: 0, responses: 0, updates: 0 }, totals: { questions: 2, actions: 0, responses: 0, updates: 0 } }),
      [`GET ${groupPath("questions")}`]: (c: { query: URLSearchParams }) => (c.query.get("all") === "1" ? pageOf("questions", [question, answered], true) : pageOf("questions", [question])),
    });
    const { unmount } = renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    await screen.findByRole("link", { name: /Pick a vendor/ });
    expect(screen.queryByRole("link", { name: /Old vendor question/ })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show all" }));
    expect(await screen.findByRole("link", { name: /Old vendor question/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Questions (2, 1 pending)" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.method !== "GET")).toBe(false);
    unmount();
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    expect(await screen.findByRole("checkbox", { name: "Show all" })).not.toBeChecked();
  });

  it("selects unread items in one group and marks only those read; questions without unread are not selectable", async () => {
    let unread = [update, update2];
    const api = mockFetch({
      [`GET ${ATTENTION}`]: () => attentionResponse({ counts: { questions: 1, actions: 0, responses: 0, updates: unread.length } }),
      [`GET ${groupPath("questions")}`]: pageOf("questions", [question]),
      [`GET ${groupPath("updates")}`]: () => pageOf("updates", unread),
      [`POST /api/projects/${PID}/records/mark-read`]: (c: { body: { recordIds: string[] } }) => {
        unread = unread.filter((r) => !c.body.recordIds.includes(r.id));
        return { marked: c.body.recordIds.length, unreadUpdates: unread.length };
      },
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    const questions = await screen.findByRole("region", { name: "Questions" });
    await within(questions).findByRole("link", { name: /Pick a vendor/ });
    expect(within(questions).queryByRole("checkbox")).toBeNull();
    expect(within(questions).queryByRole("button", { name: /Mark selected/ })).toBeNull();

    const updates = screen.getByRole("region", { name: "Updates" });
    await within(updates).findByRole("link", { name: /Second update/ });
    const markBtn = within(updates).getByRole("button", { name: "Mark selected as read" });
    expect(markBtn).toBeDisabled();
    await userEvent.click(within(updates).getByRole("checkbox", { name: "Select Sensors calibrated" }));
    expect(within(updates).getByRole("button", { name: "Mark selected as read (1)" })).toBeEnabled();
    await userEvent.click(within(updates).getByRole("checkbox", { name: /Select all unread shown \(2\)/ }));
    expect(within(updates).getByRole("button", { name: "Mark selected as read (2)" })).toBeEnabled();
    await userEvent.click(within(updates).getByRole("checkbox", { name: "Select Second update" }));
    await userEvent.click(within(updates).getByRole("button", { name: "Mark selected as read (1)" }));
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ recordIds: ["T-9"] });
    // The read item leaves the default list; the counter follows; the question is untouched.
    await waitFor(() => expect(screen.queryByRole("link", { name: /Sensors calibrated/ })).toBeNull());
    expect(await screen.findByRole("button", { name: "Updates: 1 unread" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pick a vendor/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Updates" })).getByText("1 marked as read")).toBeInTheDocument();
  });

  it("keeps a selection across a background refresh that adds a newer record", async () => {
    let items = [update];
    mockFetch({
      [`GET ${ATTENTION}`]: () => attentionResponse({ counts: { questions: 0, actions: 0, responses: 0, updates: items.length } }),
      [`GET ${groupPath("updates")}`]: () => pageOf("updates", items),
    });
    const { client } = renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Sensors calibrated" }));
    items = [update2, update];
    await client.invalidateQueries();
    expect(await screen.findByRole("link", { name: /Second update/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Sensors calibrated" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Second update" })).not.toBeChecked();
  });

  it("loads further pages on request and shows each record once", async () => {
    const first = Array.from({ length: 3 }, (_, i) => summary({ id: `U-${i}`, title: `Update ${i}`, unread: true }));
    mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 0, actions: 0, responses: 0, updates: 4 } }),
      [`GET ${groupPath("updates")}`]: (c: { query: URLSearchParams }) =>
        c.query.get("cursor") ? pageOf("updates", [first[2]!, summary({ id: "U-3", title: "Update 3", unread: true })], false, null, 4) : pageOf("updates", first, false, "next", 4),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    await userEvent.click(await screen.findByRole("button", { name: "Show more (3 of 4)" }));
    expect(await screen.findByRole("link", { name: /Update 3/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Update 2/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("opens the group named in the deep link", async () => {
    mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 0, actions: 1, responses: 0, updates: 0 } }),
      [`GET ${groupPath("actions")}`]: pageOf("actions", [action]),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes, attention: "actions" } });
    const btn = await screen.findByRole("button", { name: "Actions: 1 to do" });
    await waitFor(() => expect(btn).toHaveFocus());
  });

  it("shows the server error and retries on request", async () => {
    let fail = true;
    const api = mockFetch({
      [`GET ${ATTENTION}`]: () => (fail ? { status: 500, body: { error: "internal", message: "Disk unavailable" } } : attentionResponse({ counts: { questions: 0, actions: 0, responses: 0, updates: 1 } })),
      [`GET ${groupPath("updates")}`]: pageOf("updates", [update]),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: /Sensors calibrated/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.count("GET", ATTENTION)).toBe(2);
  });

  it("folds the whole panel, and each group on its own; open by default", async () => {
    mockFetch({
      [`GET ${ATTENTION}`]: attentionResponse({ counts: { questions: 1, actions: 0, responses: 0, updates: 1 } }),
      [`GET ${groupPath("questions")}`]: pageOf("questions", [question]),
      [`GET ${groupPath("updates")}`]: pageOf("updates", [update]),
    });
    renderWithProviders(<AttentionPanel />, { project: { pid: PID, nodes } });
    const panel = screen.getByRole("button", { name: "Needs your attention" });
    expect(panel).toHaveAttribute("aria-expanded", "true");
    const unread = await screen.findByRole("button", { name: "Updates: 1 unread" });
    expect(await screen.findByRole("link", { name: /Sensors calibrated/ })).toBeVisible();

    await userEvent.click(unread);
    expect(unread).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Sensors calibrated/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Pick a vendor/ })).toBeVisible();

    await userEvent.click(panel);
    expect(panel).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Pick a vendor/ })).toBeNull();
    await userEvent.click(panel);
    expect(screen.getByRole("link", { name: /Pick a vendor/ })).toBeVisible();
    // Each group keeps its own state while the panel is folded.
    expect(screen.getByRole("button", { name: "Updates: 1 unread" })).toHaveAttribute("aria-expanded", "false");
  });
});
