import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttachmentRef, RecordDetail } from "../../shared/api";
import type { AnswerSchema } from "../../shared/schemas";
import { RecordDetailView } from "./RecordDetail";
import { detail, mockFetch, node, renderWithProviders } from "../test/utils";

const PID = "p1";
const REC = (id: string) => `/api/projects/${PID}/records/${id}`;

const att = (over: Partial<AttachmentRef> & Pick<AttachmentRef, "id">): AttachmentRef => ({
  title: "",
  fileName: `${over.id}.txt`,
  mimeType: "text/plain",
  bytes: 2048,
  available: true,
  url: `/api/projects/${PID}/attachments/${over.id}`,
  ...over,
});

const schema: AnswerSchema = {
  type: "single-choice",
  options: [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue" },
  ],
  allowOther: false,
  allowExplanation: false,
  required: true,
};

function question(uiState: NonNullable<RecordDetail["question"]>["uiState"], over: Partial<RecordDetail> = {}) {
  return detail({
    id: "Q-1",
    title: "Pick a colour",
    recordType: "question",
    question: { uiState, revision: 2, requiresResponse: true },
    answerSchema: schema,
    ...over,
  });
}

const submitted = (state: "pending" | "processing" | "processed" | "failed", over: Partial<NonNullable<RecordDetail["submittedAnswer"]>> = {}) => ({
  answerId: "A-1",
  submittedAt: "2026-11-10T10:00:00Z",
  source: "dashboard" as const,
  processingState: state,
  answers: [{ fieldId: "answer", kind: "choice" as const, optionIds: ["red"] }],
  attachments: [],
  ...over,
});

const loaded = () => waitFor(() => expect(document.querySelector(".detail")).not.toBeNull());

function show(d: RecordDetail, nodes = [node({ id: "cards", displayType: "expandable-card", title: "Work items" })]) {
  const api = mockFetch({ [`GET ${REC(d.id)}`]: d });
  const view = renderWithProviders(<RecordDetailView id={d.id} />, { project: { pid: PID, nodes } });
  return { api, ...view };
}

describe("RecordDetailView", () => {
  it("shows loading, then the rendered markdown body and the percent bar", async () => {
    show(detail({ id: "T-1", title: "Task", bodyMarkdown: "Some **bold** words", percent: 40.4 }));
    expect(screen.getByText("Loading details…")).toBeInTheDocument();
    expect(await screen.findByText("bold")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Task progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("shows a retryable error with the server message when the record cannot be loaded", async () => {
    let fail = true;
    mockFetch({ [`GET ${REC("T-1")}`]: () => (fail ? { status: 404, body: { error: "not-found", message: "Record vanished" } } : detail({ id: "T-1", title: "Task" })) });
    renderWithProviders(<RecordDetailView id="T-1" />, { project: { pid: PID } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load details: Record vanished");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(document.querySelector(".detail")).not.toBeNull();
  });

  it("renders metadata (booleans as Yes/No), task id, links and linked records resolved through navigation", async () => {
    const nodes = [node({ id: "board", displayType: "page-tab", title: "Board" })];
    show(
      detail({
        id: "T-1",
        title: "Task",
        taskId: "TASK-77",
        createdAt: "2026-11-01T10:00:00Z",
        metadata: { owner: "Sam", blocking: true, retries: 0, archived: false },
        links: [{ title: "Runbook", url: "https://example.org/runbook" }],
        linkedRecords: [{ id: "T-2", title: "Follow-up", sectionId: "board", recordType: "task" }],
      }),
      nodes,
    );
    await screen.findByText("Task");
    const meta = document.querySelector(".meta-table") as HTMLElement;
    expect(within(meta).getByText("TASK-77")).toBeInTheDocument();
    expect(within(meta).getByText("owner").nextSibling).toHaveTextContent("Sam");
    expect(within(meta).getByText("blocking").nextSibling).toHaveTextContent("Yes");
    expect(within(meta).getByText("archived").nextSibling).toHaveTextContent("No");
    expect(within(meta).getByText("retries").nextSibling).toHaveTextContent("0");
    const link = screen.getByRole("link", { name: "Runbook" });
    expect(link).toHaveAttribute("href", "https://example.org/runbook");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: /T-2.*Follow-up/ })).toHaveAttribute("href", "#/p/p1/board?record=T-2");
  });

  it("lists history entries with the author when known", async () => {
    show(detail({ id: "T-1", title: "Task", history: [{ at: "2026-11-02T10:00:00Z", text: "Created", by: "sam" }, { at: "2026-11-03T10:00:00Z", text: "Closed" }] }));
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("· sam — Created");
    expect(items[1]).toHaveTextContent("— Closed");
    expect(items[1]).not.toHaveTextContent("·");
  });

  describe("attachments", () => {
    it("shows downloadable attachments with title, file name and size, and marks missing ones unavailable", async () => {
      show(
        detail({
          id: "T-1",
          title: "Task",
          attachments: [att({ id: "a1", title: "Test report", fileName: "report.txt", bytes: 2048 }), att({ id: "a2", title: "", fileName: "plain.txt", bytes: 10 }), att({ id: "a3", title: "Lost file", available: false })],
        }),
      );
      const list = await screen.findByRole("heading", { name: "Attachments" });
      const items = within(list.parentElement!).getAllByRole("listitem");
      const first = within(items[0]).getByRole("link", { name: /Test report/ });
      expect(first).toHaveAttribute("href", `/api/projects/${PID}/attachments/a1`);
      expect(first).toHaveAttribute("download", "report.txt");
      expect(items[0]).toHaveTextContent("report.txt · 2.0 KB");
      expect(within(items[1]).getByRole("link")).toHaveTextContent("plain.txt");
      expect(items[2]).toHaveTextContent("Lost file");
      expect(items[2]).toHaveTextContent("unavailable");
      expect(within(items[2]).queryByRole("link")).toBeNull();
    });

    it("omits the section when there are no attachments", async () => {
      show(detail({ id: "T-1", title: "Task" }));
      await loaded();
      expect(screen.queryByRole("heading", { name: "Attachments" })).toBeNull();
    });

    it("offers a direct download for one available attachment and a zip for several", async () => {
      show(detail({ id: "T-1", title: "Task", actions: ["download"], attachments: [att({ id: "a1", fileName: "one.txt" })] }));
      expect(await screen.findByRole("link", { name: "↓ Download" })).toHaveAttribute("download", "one.txt");
    });

    it("downloads several attachments as a zip through the API and confirms with the file name", async () => {
      const d = detail({ id: "T-1", title: "Task", actions: ["download"], attachments: [att({ id: "a1" }), att({ id: "a2" }), att({ id: "a3", available: false })] });
      const api = mockFetch({
        [`GET ${REC("T-1")}`]: d,
        // Plain string body: Node 22's Response cannot read a jsdom Blob.
        [`POST /api/projects/${PID}/download/zip`]: () => new Response("zip", { status: 200 }),
      });
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      renderWithProviders(<RecordDetailView id="T-1" />, { project: { pid: PID } });
      await userEvent.click(await screen.findByRole("button", { name: /Download all/ }));
      expect(await screen.findByText(/Downloaded/)).toBeInTheDocument();
      expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ recordIds: ["T-1"] });
    });

    it("hides download when no attachment is available", async () => {
      show(detail({ id: "T-1", title: "Task", actions: ["download"], attachments: [att({ id: "a1", available: false })] }));
      await loaded();
      expect(screen.queryByText(/Download/)).toBeNull();
    });
  });

  describe("questions", () => {
    it("needs-response with a schema shows the answer form", async () => {
      show(question("needs-response"));
      expect(await screen.findByRole("button", { name: "Submit response" })).toBeInTheDocument();
      expect(screen.getByText("Question revision").nextSibling).toHaveTextContent("2");
    });

    it("needs-response without a schema tells the user to reply through the project", async () => {
      show(question("needs-response", { answerSchema: undefined }));
      expect(await screen.findByText(/publishes no answer form/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
    });

    it("answered outside the dashboard shows a notice instead of a form", async () => {
      show(question("answered", { answerSchema: undefined, question: { uiState: "answered", revision: 1, requiresResponse: true, answeredAt: "2026-11-09T10:00:00Z" } }));
      expect(await screen.findByText(/outside the dashboard\. No response is needed/)).toBeInTheDocument();
    });

    it("informational questions show neither form nor notice", async () => {
      show(question("informational", { answerSchema: undefined }));
      await screen.findByText("Question revision");
      expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
      expect(screen.queryByText(/No response is needed/)).toBeNull();
    });

    it("a pending submitted answer is read-only: no form and no Answer again", async () => {
      show(question("submitted", { submittedAnswer: submitted("pending") }));
      expect(await screen.findByText("Your submitted answer")).toBeInTheDocument();
      expect(screen.getByText("Submitted · Awaiting pickup")).toBeInTheDocument();
      expect(screen.getByText(/not yet picked up by the project/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Answer again" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();
    });

    it("a processed answer shows its result note and offers no re-answer", async () => {
      show(question("processed", { submittedAnswer: submitted("processed", { resultNote: "Applied to config" }) }));
      expect(await screen.findByText("Result note:")).toBeInTheDocument();
      expect(screen.getByText(/Applied to config/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Answer again" })).toBeNull();
    });

    it("a failed answer shows the failure reason and Answer again opens a fresh form that submits a new answer", async () => {
      const d = question("failed", { submittedAnswer: submitted("failed", { resultNote: "Consumer rejected the value" }) });
      const api = mockFetch({
        [`GET ${REC("Q-1")}`]: d,
        [`POST /api/projects/${PID}/questions/Q-1/answers`]: { answerId: "A-2", questionId: "Q-1", processingState: "pending", duplicate: false },
      });
      renderWithProviders(<RecordDetailView id="Q-1" />, { project: { pid: PID } });
      expect(await screen.findByText("Failure reason:")).toBeInTheDocument();
      expect(screen.getByText(/Consumer rejected the value/)).toBeInTheDocument();
      expect(screen.getByText("Failed")).toHaveClass("pill-danger");
      expect(screen.queryByRole("button", { name: "Submit response" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Answer again" }));
      expect(screen.queryByRole("button", { name: "Answer again" })).toBeNull();
      expect(screen.getByText("Your submitted answer")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("radio", { name: /Blue/ }));
      await userEvent.click(screen.getByRole("button", { name: "Submit response" }));
      await waitFor(() => expect(api.count("POST", `/api/projects/${PID}/questions/Q-1/answers`)).toBe(1));
      const sent = api.calls.find((c) => c.method === "POST")!;
      expect(sent.body).toMatchObject({ questionRevision: 2 });
      expect(JSON.stringify(sent.body)).toContain("blue");
    });

    it("a failed answer without a schema cannot be answered again", async () => {
      show(question("failed", { answerSchema: undefined, submittedAnswer: submitted("failed") }));
      expect(await screen.findByText("Your submitted answer")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Answer again" })).toBeNull();
    });

    it("shows attachments that were part of the submitted answer", async () => {
      show(question("processed", { submittedAnswer: submitted("processed", { attachments: [att({ id: "up1", title: "Photo", fileName: "photo.png" })] }) }));
      const view = (await screen.findByText("Your submitted answer")).closest(".answer-view") as HTMLElement;
      expect(within(view).getByRole("link", { name: /Photo/ })).toHaveAttribute("download", "photo.png");
    });
  });

  describe("actions", () => {
    it("mark read posts the record id, clears the unread action and confirms", async () => {
      let unread = true;
      const api = mockFetch({
        [`GET ${REC("T-1")}`]: () => detail({ id: "T-1", title: "Task", actions: ["mark-read"], unread }),
        [`POST /api/projects/${PID}/records/mark-read`]: () => {
          unread = false;
          return { marked: 1 };
        },
      });
      renderWithProviders(<RecordDetailView id="T-1" />, { project: { pid: PID } });
      await userEvent.click(await screen.findByRole("button", { name: /Mark read/ }));
      expect(await screen.findByText("Marked as read")).toBeInTheDocument();
      expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ recordIds: ["T-1"] });
      await waitFor(() => expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull());
    });

    it("mark read failure is reported and the button stays", async () => {
      mockFetch({
        [`GET ${REC("T-1")}`]: detail({ id: "T-1", title: "Task", actions: ["mark-read"], unread: true }),
        [`POST /api/projects/${PID}/records/mark-read`]: { status: 500, body: { error: "internal", message: "Nope" } },
      });
      renderWithProviders(<RecordDetailView id="T-1" />, { project: { pid: PID } });
      await userEvent.click(await screen.findByRole("button", { name: /Mark read/ }));
      expect(await screen.findByText(/Could not mark as read: .*Nope/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Mark read/ })).toBeEnabled();
    });

    it("mark read is not offered for an already read record", async () => {
      show(detail({ id: "T-1", title: "Task", actions: ["mark-read"], unread: false }));
      await loaded();
      expect(screen.queryByRole("button", { name: /Mark read/ })).toBeNull();
    });

    it("copy puts a concise plain-text summary on the clipboard", async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      show(detail({ id: "T-1", title: "Task", actions: ["copy"], bodyMarkdown: "LONG BODY" }));
      await userEvent.click(await screen.findByRole("button", { name: /Copy/ }));
      expect(writeText).toHaveBeenCalledTimes(1);
      const text = (writeText.mock.calls[0] as unknown as [string])[0];
      expect(text).toContain("T-1 · Task");
      expect(text).not.toContain("LONG BODY");
      expect(await screen.findByText("Copied T-1 to clipboard")).toBeInTheDocument();
    });

    it("renders no action bar when no action applies", async () => {
      show(detail({ id: "T-1", title: "Task", actions: [] }));
      await loaded();
      expect(document.querySelector(".detail-actions")).toBeNull();
    });
  });
});
