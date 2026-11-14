import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrackedFieldDef } from "../../shared/schemas";
import { CommentBox, ExternalRefs, TrackedFields } from "./RecordFields";
import { detail, mockFetch, renderWithProviders } from "../test/utils";

const PID = "p1";
const UPDATE = `/api/projects/${PID}/records/R-1/user-update`;
const defs: TrackedFieldDef[] = [
  { id: "reviewed", label: "Reviewed", type: "checkbox", editableBy: ["user"], filter: true },
  { id: "decision", label: "Decision", type: "choice", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], editableBy: ["user", "agent"], filter: false },
  { id: "built", label: "Built", type: "checkbox", editableBy: ["agent"], filter: false },
];
const rec = (over = {}) => detail({ id: "R-1", title: "Review", recordType: "review", fieldDefs: defs, fields: { built: true }, revision: "aaaaaaaaaaaaaaaa", ...over });

describe("TrackedFields", () => {
  it("edits user fields with the record revision, chaining its own saves, and shows agent fields read-only", async () => {
    const revs = ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
    const api = mockFetch({ [`POST ${UPDATE}`]: () => ({ recordId: "R-1", unchanged: false, revision: revs.shift() }) });
    renderWithProviders(<TrackedFields d={rec()} />, { project: { pid: PID } });
    expect(screen.queryByRole("checkbox", { name: "Built" })).toBeNull();
    expect(screen.getByText("yes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Reviewed" }));
    await waitFor(() => expect(api.count("POST", UPDATE)).toBe(1));
    // Shown at once, before the reloaded record arrives.
    expect(screen.getByRole("checkbox", { name: "Reviewed" })).toBeChecked();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Decision" }), "reject");
    await waitFor(() => expect(api.count("POST", UPDATE)).toBe(2));
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { fields: { reviewed: true }, ifRevision: "aaaaaaaaaaaaaaaa" },
      // The second save builds on the first one's revision instead of failing on the stale detail.
      { fields: { decision: "reject" }, ifRevision: "bbbbbbbbbbbbbbbb" },
    ]);
  });

  it("explains a concurrent change instead of overwriting it, and drops the unsaved value", async () => {
    mockFetch({ [`POST ${UPDATE}`]: { status: 409, body: { error: "revision-mismatch", message: "the record changed" } } });
    renderWithProviders(<TrackedFields d={rec({ revision: "dddddddddddddddd" })} />, { project: { pid: PID } });
    await userEvent.click(screen.getByRole("checkbox", { name: "Reviewed" }));
    expect(await screen.findByText(/changed meanwhile/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Reviewed" })).not.toBeChecked());
  });

  it("renders nothing when the card has no fields", () => {
    mockFetch({});
    const { container } = renderWithProviders(<TrackedFields d={rec({ fieldDefs: [] })} />, { project: { pid: PID } });
    expect(container.querySelector(".tracked-fields")).toBeNull();
  });
});

describe("ExternalRefs", () => {
  it("links the id, and labels the status as the source system's", () => {
    mockFetch({});
    renderWithProviders(<ExternalRefs items={[{ system: "tracker", id: "LAN-142", title: "Autosave", url: "https://tracker.example/LAN-142", ref: "main@3f9c2e1", status: "merged" }]} />);
    const link = screen.getByRole("link", { name: "LAN-142" });
    expect(link).toHaveAttribute("href", "https://tracker.example/LAN-142");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/tracker reports/)).toHaveTextContent("tracker reports merged");
    expect(screen.getByText("main@3f9c2e1")).toBeInTheDocument();
  });
});

describe("CommentBox", () => {
  it("is hidden unless the card allows comments", () => {
    mockFetch({});
    const { container } = renderWithProviders(<CommentBox d={rec({ canComment: false })} />, { project: { pid: PID } });
    expect(container.querySelector(".comment-box")).toBeNull();
  });

  it("sends the comment with the revision and clears the box", async () => {
    const api = mockFetch({ [`POST ${UPDATE}`]: { recordId: "R-1", unchanged: false, revision: "ffffffffffffffff" } });
    renderWithProviders(<CommentBox d={rec({ canComment: true, revision: "eeeeeeeeeeeeeeee" })} />, { project: { pid: PID } });
    const box = screen.getByRole("textbox", { name: "Add a comment" });
    await userEvent.type(box, "Please add a test");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.count("POST", UPDATE)).toBe(1));
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ comment: "Please add a test", ifRevision: "eeeeeeeeeeeeeeee" });
    await waitFor(() => expect(box).toHaveValue(""));
  });
});
