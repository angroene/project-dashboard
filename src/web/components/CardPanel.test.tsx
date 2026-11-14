import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NavNode } from "../../shared/api";
import { CardPanel } from "./CardPanel";
import { detail, mockFetch, newQueryClient, node, page, renderWithProviders, summary, type Call } from "../test/utils";

const PID = "p1";
const LIST = `/api/projects/${PID}/sections/cards/records`;

function cardNode(over: Partial<NavNode> = {}): NavNode {
  return node({ id: "cards", displayType: "expandable-card", title: "Work items", counts: { records: 2, awaitingResponse: 0, unread: 0 }, ...over });
}

const rowA = summary({ id: "T-1", title: "Calibrate sensors", summary: "Short summary A", status: "doing", statusLabel: "Doing now", statusTone: "info" });
const rowB = summary({ id: "T-2", title: "Write release notes", summary: "Short summary B", status: "waiting-review", statusLabel: "Waiting for review", statusTone: "warn" });

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("CardPanel", () => {
  it("is collapsed by default: no records request until expanded; expand/collapse toggles aria-expanded and visibility", async () => {
    const api = mockFetch({ [`GET ${LIST}`]: page([rowA, rowB]) });
    renderWithProviders(<CardPanel node={cardNode()} />, { project: { pid: PID } });
    const toggle = screen.getByRole("button", { name: /Work items/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(api.count("GET", LIST)).toBe(0);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Calibrate sensors")).toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Calibrate sensors")).not.toBeVisible();
    await userEvent.click(toggle);
    expect(api.count("GET", LIST)).toBe(1); // re-opening reuses the loaded list
  });

  it("shows status pills from the project's workflow label and tone, not from built-in status names", async () => {
    mockFetch({ [`GET ${LIST}`]: page([rowA, rowB]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    const row = (await screen.findByText("Write release notes")).closest("li")!;
    const pill = within(row).getByText("Waiting for review");
    expect(pill).toHaveClass("pill-warn");
    expect(within(row).queryByText("waiting-review")).toBeNull();
  });

  it("expands one row at a time independently and fetches its detail only when expanded", async () => {
    const api = mockFetch({
      [`GET ${LIST}`]: page([rowA, rowB]),
      [`GET /api/projects/${PID}/records/T-1`]: detail({ ...rowA, bodyMarkdown: "Full **body** text" }),
    });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    const rowToggle = await screen.findByRole("button", { name: /Calibrate sensors/ });
    expect(api.count("GET", /\/records\/T-/)).toBe(0);
    await userEvent.click(rowToggle);
    expect(rowToggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("body")).toBeInTheDocument();
    expect(api.count("GET", `/api/projects/${PID}/records/T-1`)).toBe(1);
    expect(api.count("GET", `/api/projects/${PID}/records/T-2`)).toBe(0);
    expect(screen.getByRole("button", { name: /Write release notes/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("filters by status: default status from the manifest, chips labelled from the workflow, All sends status=all", async () => {
    const api = mockFetch({
      [`GET ${LIST}`]: ({ query }: Call) =>
        query.get("status") === "all"
          ? page([rowA, rowB], { statusCounts: { doing: 1, "waiting-review": 1 }, statusLabels: { doing: "Doing now", "waiting-review": "Waiting for review" } })
          : page([rowA], { statusCounts: { doing: 1, "waiting-review": 1 }, statusLabels: { doing: "Doing now", "waiting-review": "Waiting for review" }, unfilteredTotal: 2 }),
    });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true, filters: { sort: "title", defaultStatus: "doing" } })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    expect(api.calls[0].query.get("status")).toBe("doing");
    expect(api.calls[0].query.get("sort")).toBe("title");
    const chips = screen.getByRole("group", { name: "Filter by status" });
    expect(within(chips).getByRole("button", { name: /Doing now/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(chips).getByRole("button", { name: /^All/ }));
    expect(await screen.findByText("Write release notes")).toBeInTheDocument();
    expect(api.calls.at(-1)!.query.get("status")).toBe("all");
    expect(within(chips).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    // The label of a status first seen under "All" is learned from its rows.
    expect(within(chips).getByRole("button", { name: /Waiting for review/ })).toBeInTheDocument();
  });

  it("offers a Needs response chip for answerable sections that sends status=needs-response", async () => {
    const q1 = summary({ id: "Q-1", recordType: "question", title: "Pick a colour", status: "open" });
    const q2 = summary({ id: "Q-2", recordType: "question", title: "Already answered", status: "open" });
    const api = mockFetch({
      [`GET ${LIST}`]: ({ query }: Call) =>
        query.get("status") === "needs-response"
          ? page([q1], { statusCounts: { open: 2 }, needsResponseCount: 1, unfilteredTotal: 2 })
          : page([q1, q2], { statusCounts: { open: 2 }, needsResponseCount: 1 }),
    });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await screen.findByText("Already answered");
    const chips = screen.getByRole("group", { name: "Filter by status" });
    const needs = within(chips).getByRole("button", { name: /Needs response/ });
    expect(needs).toHaveTextContent("1");
    expect(needs).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(needs);
    await waitFor(() => expect(screen.queryByText("Already answered")).toBeNull());
    expect(api.calls.at(-1)!.query.get("status")).toBe("needs-response");
    expect(needs).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Pick a colour")).toBeInTheDocument();
  });

  it("shows no Needs response chip when the section has no answerable questions", async () => {
    mockFetch({ [`GET ${LIST}`]: page([rowA, rowB], { statusCounts: { doing: 1, "waiting-review": 1 } }) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    expect(screen.queryByRole("button", { name: /Needs response/ })).toBeNull();
  });

  it("debounces the search box and sends q", async () => {
    const api = mockFetch({ [`GET ${LIST}`]: page([rowA]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    await userEvent.type(screen.getByRole("searchbox", { name: /Search Work items/ }), "sens");
    await waitFor(() => expect(api.calls.at(-1)!.query.get("q")).toBe("sens"));
    expect(api.calls.filter((c) => c.query.has("q")).length).toBe(1);
  });

  it("copies selected records as concise plain text and announces success", async () => {
    const writeText = stubClipboard();
    mockFetch({ [`GET ${LIST}`]: page([rowA, rowB]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true, actions: ["copy"] })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    expect(screen.queryByRole("button", { name: /Copy selected/ })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Calibrate sensors" }));
    await userEvent.click(screen.getByRole("button", { name: /Copy selected/ }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("T-1 · Calibrate sensors\nStatus: Doing now\nShort summary A");
    expect(await screen.findByText("Copied 1 record to clipboard")).toBeInTheDocument();
  });

  it("reports a clipboard failure instead of claiming success", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    mockFetch({ [`GET ${LIST}`]: page([rowA]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true, actions: ["copy"] })} />, { project: { pid: PID } });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Calibrate sensors" }));
    await userEvent.click(screen.getByRole("button", { name: /Copy selected/ }));
    expect(await screen.findByText(/Could not copy 1 record/)).toBeInTheDocument();
  });

  it("offers bulk actions only when the section allows them and the selection supports them", async () => {
    const question = summary({ id: "Q-1", title: "Pick a colour", recordType: "question", question: { uiState: "needs-response", revision: 1, requiresResponse: true } });
    const withFile = summary({ id: "D-1", title: "Design doc", recordType: "document", attachmentCount: 2 });
    mockFetch({ [`GET ${LIST}`]: page([rowA, question, withFile]) });
    const r = renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true, actions: ["copy", "export-xlsx", "bulk-download"] })} />, { project: { pid: PID } });
    await screen.findByText("Pick a colour");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Calibrate sensors" }));
    expect(screen.getByRole("button", { name: /Copy selected/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export to Excel/ })).toBeNull(); // no question selected
    expect(screen.queryByRole("button", { name: /Download ZIP/ })).toBeNull(); // nothing with files selected
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Pick a colour" }));
    expect(screen.getByRole("button", { name: "↓ Export to Excel (1)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Design doc" }));
    expect(screen.getByRole("button", { name: "↓ Download ZIP (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import Excel/ })).toBeNull();

    // Same selection in a section without those actions: no buttons, no checkboxes.
    r.unmount();
    mockFetch({ [`GET ${LIST}`]: page([rowA, question, withFile]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true, actions: ["open-detail"] })} />, { project: { pid: PID } });
    await screen.findByText("Pick a colour");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("select all on page selects every loaded row and reports the count", async () => {
    mockFetch({ [`GET ${LIST}`]: page([rowA, rowB]) });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all on page" }));
    expect(screen.getByRole("checkbox", { name: "Select Calibrate sensors" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Write release notes" })).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("loads further pages with the cursor", async () => {
    const api = mockFetch({
      [`GET ${LIST}`]: ({ query }: Call) => (query.get("cursor") === "c2" ? page([rowB]) : page([rowA], { nextCursor: "c2", unfilteredTotal: 2 })),
    });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await screen.findByText("Calibrate sensors");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Write release notes")).toBeInTheDocument();
    expect(api.calls.at(-1)!.query.get("cursor")).toBe("c2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("load more during a background refresh", () => {
  it("is disabled while the loaded pages are being refreshed, so the refresh is not discarded", async () => {
    let release: (() => void) | null = null;
    let firstPageCalls = 0;
    mockFetch({
      [`GET ${LIST}`]: async ({ query }: Call) => {
        if (query.get("cursor")) return page([rowB]);
        firstPageCalls++;
        if (firstPageCalls > 1) await new Promise<void>((r) => { release = r; });
        return page([rowA], { nextCursor: "c2", unfilteredTotal: 2 });
      },
    });
    const client = newQueryClient();
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID }, client });
    await screen.findByText("Calibrate sensors");
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    void client.invalidateQueries();
    await waitFor(() => expect(release).not.toBeNull());
    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
    release!();
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled());
  });
});

describe("record actions", () => {
  async function openRow(actions: string[], unread: boolean, attachments: { id: string; available: boolean }[] = []) {
    let isUnread = unread;
    const s = () => summary({ id: "R-1", title: "Release checklist", unread: isUnread, actions: actions as never, attachmentCount: attachments.length });
    const api = mockFetch({
      [`GET ${LIST}`]: () => page([s()]),
      [`GET /api/projects/${PID}/records/R-1`]: () => detail({
        ...s(),
        createdAt: "2026-11-09T09:00:00Z",
        attachments: attachments.map((a) => ({ id: a.id, title: `${a.id}.md`, fileName: `${a.id}.md`, mimeType: "text/markdown", bytes: 10, available: a.available, url: `/api/projects/${PID}/attachments/${a.id}` })),
      }),
      [`POST /api/projects/${PID}/records/mark-read`]: () => {
        isUnread = false;
        return { marked: 1, unreadUpdates: 0 };
      },
    });
    renderWithProviders(<CardPanel node={cardNode({ defaultOpen: true })} />, { project: { pid: PID } });
    await userEvent.click(await screen.findByRole("button", { name: /Release checklist/ }));
    await screen.findByText("Updated");
    return api;
  }

  it("shows only the actions the record allows", async () => {
    await openRow(["copy"], true);
    expect(screen.getByRole("button", { name: "⧉ Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull(); // unread, but mark-read not allowed
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
  });

  it("Mark read appears only for unread records and posts the record id with the CSRF header", async () => {
    const api = await openRow(["mark-read"], true);
    await userEvent.click(screen.getByRole("button", { name: /Mark read/ }));
    await waitFor(() => expect(api.count("POST", `/api/projects/${PID}/records/mark-read`)).toBe(1));
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ recordIds: ["R-1"] });
    expect(post.headers["x-pcc-request"]).toBe("1");
    expect(post.headers["content-type"]).toBe("application/json");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull());
  });

  it("no Mark read button for a record that is already read", async () => {
    await openRow(["mark-read", "copy"], false);
    expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull();
  });

  it("Download links a single available attachment; unavailable ones are shown greyed, not linked", async () => {
    await openRow(["download"], false, [
      { id: "doc-a", available: true },
      { id: "doc-b", available: false },
    ]);
    const dl = screen.getByRole("link", { name: "↓ Download" });
    expect(dl).toHaveAttribute("href", `/api/projects/${PID}/attachments/doc-a`);
    expect(screen.getByText("doc-b.md").closest("li")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("link", { name: /doc-b/ })).toBeNull();
  });
});
