import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrackedFieldDef } from "../../shared/schemas";
import { TrackedFields } from "./RecordFields";
import { RecordRow } from "./RecordRow";
import { BackToTop } from "./BackToTop";
import { detail, mockFetch, renderWithProviders, summary } from "../test/utils";

const PID = "p1";
const UPDATE = `/api/projects/${PID}/records/tonight-2026-11-16/user-update`;
const yesNo: TrackedFieldDef = { id: "answer", label: "Available tonight?", type: "yes-no", editableBy: ["user"], filter: false };
const agentYesNo: TrackedFieldDef = { id: "ready", label: "Build ready", type: "yes-no", editableBy: ["agent"], filter: false };

describe("Yes / No fields", () => {
  it("shows the stored value as the pressed button and saves a tap at once, without a submit step", async () => {
    const api = mockFetch({ [`POST ${UPDATE}`]: { recordId: "tonight-2026-11-16", unchanged: false, revision: "bbbbbbbbbbbbbbbb" } });
    renderWithProviders(<TrackedFields d={detail({ id: "tonight-2026-11-16", title: "Available tonight? 2026-11-16", fieldDefs: [yesNo, agentYesNo], fields: { answer: true, ready: false }, revision: "aaaaaaaaaaaaaaaa" })} />, { project: { pid: PID } });
    const group = screen.getByRole("group", { name: "Available tonight?" });
    expect(within(group).getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    // Agent-only: shown as text.
    expect(screen.queryByRole("group", { name: "Build ready" })).toBeNull();
    expect(screen.getByText("no")).toBeInTheDocument();
    // Tapping the current value sends nothing.
    await userEvent.click(within(group).getByRole("button", { name: "Yes" }));
    expect(api.count("POST", UPDATE)).toBe(0);
    await userEvent.click(within(group).getByRole("button", { name: "No" }));
    await waitFor(() => expect(api.count("POST", UPDATE)).toBe(1));
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ fields: { answer: false }, ifRevision: "aaaaaaaaaaaaaaaa" });
    expect(within(group).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Available tonight? saved")).toBeInTheDocument();
  });

  it("answers from the record row; a failed save shows the error and falls back to the stored value", async () => {
    let fail = false;
    const api = mockFetch({
      [`POST ${UPDATE}`]: () => (fail ? { status: 500, body: { error: "internal", message: "disk full" } } : { recordId: "x", unchanged: false, revision: "cccccccccccccccc" }),
    });
    const r = summary({ id: "tonight-2026-11-16", title: "Available tonight? 2026-11-16", fields: { answer: true } });
    const { rerender } = renderWithProviders(<RecordRow summary={r} selectable={false} selected={false} onSelect={() => undefined} fieldDefs={[yesNo]} />, { project: { pid: PID } });
    const group = screen.getByRole("group", { name: "Available tonight?: Available tonight? 2026-11-16" });
    await userEvent.click(within(group).getByRole("button", { name: "No" }));
    await waitFor(() => expect(api.count("POST", UPDATE)).toBe(1));
    // A row tap is a field-level update (no revision).
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ fields: { answer: false } });
    expect(within(group).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Available tonight?: no saved")).toBeInTheDocument();
    // The list reloads with the stored value.
    rerender(<RecordRow summary={{ ...r, fields: { answer: false } }} selectable={false} selected={false} onSelect={() => undefined} fieldDefs={[yesNo]} />);
    fail = true;
    await userEvent.click(within(group).getByRole("button", { name: "Yes" }));
    expect(await screen.findByText(/Could not save Available tonight\?: disk full/)).toBeInTheDocument();
    await waitFor(() => expect(within(group).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true"));
    // The value is not repeated as plain text under the title.
    expect(screen.queryByText(/· Available tonight\?:/)).toBeNull();
  });
});

describe("BackToTop", () => {
  it("appears only after scrolling down, scrolls to the top and moves focus to the page heading", async () => {
    mockFetch({});
    let scrolled: ScrollToOptions | undefined;
    window.scrollTo = ((o: ScrollToOptions) => { scrolled = o; }) as typeof window.scrollTo;
    renderWithProviders(
      <main>
        <h1 tabIndex={-1}>Page</h1>
        <BackToTop />
      </main>,
    );
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
    await act(async () => {
      Object.defineProperty(window, "scrollY", { value: 1200, configurable: true });
      fireEvent.scroll(window);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const btn = await screen.findByRole("button", { name: "Back to top" });
    await userEvent.click(btn);
    expect(scrolled?.top).toBe(0);
    expect(screen.getByRole("heading", { name: "Page" })).toHaveFocus();
    await act(async () => {
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      fireEvent.scroll(window);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull());
  });
});
