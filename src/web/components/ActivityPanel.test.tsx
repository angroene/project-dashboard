import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityPage } from "../../shared/api";
import { ActivityPanel } from "./ActivityPanel";
import { mockFetch, renderWithProviders, type Call } from "../test/utils";

const PID = "p1";
const ACTIVITY = `/api/projects/${PID}/activity`;
const MARK = `/api/projects/${PID}/records/mark-read`;

type Ev = ActivityPage["items"][number];
function ev(over: Partial<Ev> & Pick<Ev, "id" | "summary">): Ev {
  return { schemaVersion: 1, at: "2026-01-05T10:00:00Z", area: "", action: "update", status: "info", unread: false, ...over } as Ev;
}
const pageOf = (items: Ev[], extra: Partial<ActivityPage> = {}): ActivityPage => ({ items, nextCursor: null, unreadCount: 0, ...extra });

describe("ActivityPanel", () => {
  it("shows the empty message when there is no activity", async () => {
    mockFetch({ [`GET ${ACTIVITY}`]: pageOf([]) });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    expect(await screen.findByText("No activity reported yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("requests the page size and groups events by day, newest day first as delivered", async () => {
    const api = mockFetch({
      [`GET ${ACTIVITY}`]: pageOf([
        ev({ id: "E-1", summary: "Build finished", at: "2026-01-05T10:30:00Z" }),
        ev({ id: "E-2", summary: "Build started", at: "2026-01-05T10:00:00Z" }),
        ev({ id: "E-3", summary: "Older work", at: "2026-01-03T10:00:00Z" }),
      ]),
    });
    renderWithProviders(<ActivityPanel pageSize={7} />, { project: { pid: PID } });
    await screen.findByText("Build finished");
    expect(api.calls[0].query.get("limit")).toBe("7");
    expect(api.calls[0].query.has("cursor")).toBe(false);
    const days = screen.getAllByRole("heading", { level: 3 });
    expect(days).toHaveLength(2);
    expect(within(days[0].parentElement!).getAllByRole("listitem")).toHaveLength(2);
    expect(within(days[1].parentElement!).getAllByRole("listitem")).toHaveLength(1);
  });

  it("renders status pill, metadata and a record link only when the event has a record", async () => {
    mockFetch({
      [`GET ${ACTIVITY}`]: pageOf([
        ev({ id: "E-1", summary: "Deploy failed", status: "failure", area: "release", action: "deploy", source: "ci", recordId: "T-5" }),
        ev({ id: "E-2", summary: "Note added", status: "success" }),
      ]),
    });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    const failed = (await screen.findByText("Deploy failed")).closest("li")!;
    expect(within(failed).getByText("Failure")).toHaveClass("pill-danger");
    expect(failed).toHaveTextContent("release · deploy · ci");
    expect(within(failed).getByRole("link", { name: "Open record" })).toHaveAttribute("href", "#/p/p1?record=T-5");
    const ok = screen.getByText("Note added").closest("li")!;
    expect(within(ok).getByText("Success")).toHaveClass("pill-ok");
    expect(within(ok).queryByRole("link")).toBeNull();
  });

  it("marks one update read, announces it with the singular, and refetches", async () => {
    let unread = true;
    const api = mockFetch({
      [`GET ${ACTIVITY}`]: () => pageOf([ev({ id: "E-1", summary: "Fresh news", unread })], { unreadCount: unread ? 1 : 0 }),
      [`POST ${MARK}`]: () => {
        unread = false;
        return { marked: 1 };
      },
    });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    const item = (await screen.findByText("Fresh news")).closest("li")!;
    expect(item).toHaveClass("unread");
    await userEvent.click(within(item).getByRole("button", { name: /Mark read/ }));
    expect(await screen.findByText("Marked 1 update as read")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ activityIds: ["E-1"] });
    await waitFor(() => expect(screen.getByText("Fresh news").closest("li")).not.toHaveClass("unread"));
    expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull();
  });

  it("mark all read sends allActivity and uses the plural", async () => {
    const api = mockFetch({
      [`GET ${ACTIVITY}`]: pageOf([ev({ id: "E-1", summary: "One", unread: true }), ev({ id: "E-2", summary: "Two", unread: true })], { unreadCount: 2 }),
      [`POST ${MARK}`]: { marked: 2 },
    });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    expect(await screen.findByText("2 unread")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(await screen.findByText("Marked 2 updates as read")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ allActivity: true });
  });

  it("reports a failed mark-read as an error toast and re-enables the buttons", async () => {
    mockFetch({
      [`GET ${ACTIVITY}`]: pageOf([ev({ id: "E-1", summary: "One", unread: true })], { unreadCount: 1 }),
      [`POST ${MARK}`]: { status: 500, body: { error: "internal", message: "Store is read-only" } },
    });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    expect(await screen.findByText(/Could not mark as read: .*Store is read-only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeEnabled();
  });

  it("loads further pages with the cursor and drops events repeated across pages", async () => {
    const api = mockFetch({
      [`GET ${ACTIVITY}`]: ({ query }: Call) =>
        query.get("cursor") === "c2"
          ? pageOf([ev({ id: "E-2", summary: "Second", at: "2026-01-05T09:00:00Z" }), ev({ id: "E-3", summary: "Third", at: "2026-01-05T08:00:00Z" })])
          : pageOf([ev({ id: "E-1", summary: "First" }), ev({ id: "E-2", summary: "Second", at: "2026-01-05T09:00:00Z" })], { nextCursor: "c2" }),
    });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    await userEvent.click(await screen.findByRole("button", { name: "Load more activity" }));
    expect(await screen.findByText("Third")).toBeInTheDocument();
    expect(screen.getAllByText("Second")).toHaveLength(1);
    expect(api.calls[1].query.get("cursor")).toBe("c2");
    expect(screen.queryByRole("button", { name: "Load more activity" })).toBeNull();
  });

  it("shows a retryable error when the first page fails", async () => {
    mockFetch({ [`GET ${ACTIVITY}`]: { status: 503, body: { error: "unavailable", message: "Try later" } } });
    renderWithProviders(<ActivityPanel />, { project: { pid: PID } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Try later");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
