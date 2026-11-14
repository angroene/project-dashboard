import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnswerSchema } from "../../shared/schemas";
import { QuestionForm } from "./QuestionForm";
import { detail, mockFetch, renderWithProviders } from "../test/utils";

const PID = "p1";
const SUBMIT = `/api/projects/${PID}/questions/Q-1/answers`;
const accepted = { answerId: "A-1", questionId: "Q-1", processingState: "pending", duplicate: false };

const single = (over: Partial<Extract<AnswerSchema, { type: "single-choice" }>> = {}): AnswerSchema => ({
  type: "single-choice",
  options: [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue", description: "Calm and cool" },
  ],
  allowOther: true,
  allowExplanation: true,
  required: true,
  ...over,
});

function renderForm(schema: AnswerSchema, revision = 3) {
  const d = detail({ id: "Q-1", title: "Pick a colour", recordType: "question", question: { uiState: "needs-response", revision, requiresResponse: true }, answerSchema: schema });
  return renderWithProviders(<QuestionForm detail={d} />, { project: { pid: PID } });
}

const submitBtn = () => screen.getByRole("button", { name: "Submit response" });

/** Minimal XMLHttpRequest stand-in: records uploads and answers each with the next scripted reply. */
function fakeXhr(replies: { status: number; body: unknown }[]) {
  const sent: { url: string; headers: Record<string, string>; form: FormData }[] = [];
  class FakeXhr {
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    statusText = "";
    responseText = "";
    private url = "";
    private headers: Record<string, string> = {};
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    }
    send(form: FormData) {
      sent.push({ url: this.url, headers: this.headers, form });
      const reply = replies.shift() ?? { status: 500, body: { error: "internal", message: "no scripted reply" } };
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.status = reply.status;
        this.responseText = JSON.stringify(reply.body);
        this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return sent;
}

describe("QuestionForm: single choice", () => {
  it("requires a choice, keeps the error visible, and submits the exact request body once fixed", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(single());
    await userEvent.click(submitBtn());
    const group = screen.getByRole("group", { name: /Your response/ });
    expect(within(group).getByText("required")).toBeInTheDocument();
    expect(group).toHaveClass("has-error");
    expect(screen.getByRole("radio", { name: "Red" })).toHaveFocus();
    expect(api.count("POST", SUBMIT)).toBe(0);

    await userEvent.click(screen.getByRole("radio", { name: /Blue/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Explanation (optional)" }), "matches the logo");
    await userEvent.click(submitBtn());
    expect(await screen.findByText("Submitted · Awaiting pickup")).toBeInTheDocument();
    expect(api.count("POST", SUBMIT)).toBe(1);
    const call = api.calls.find((c) => c.method === "POST")!;
    expect(call.headers["x-pcc-request"]).toBe("1");
    expect(call.body).toEqual({
      questionRevision: 3,
      answers: [{ fieldId: "response", kind: "choice", optionIds: ["blue"], explanation: "matches the logo" }],
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("Other needs a description; the text is sent as otherText", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(single());
    expect(screen.queryByRole("textbox", { name: "Describe your other choice" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Other" }));
    await userEvent.click(submitBtn());
    expect(screen.getByText("describe the 'Other' choice")).toBeInTheDocument();
    expect(api.count("POST", SUBMIT)).toBe(0);
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your other choice" }), "Teal");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "choice", optionIds: ["__other"], otherText: "Teal" }]);
  });

  it("does not offer Other or an explanation unless the schema allows them", () => {
    mockFetch({});
    renderForm(single({ allowOther: false, allowExplanation: false }));
    expect(screen.queryByRole("radio", { name: "Other" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });
});

describe("QuestionForm: multiple choice", () => {
  const multi: AnswerSchema = {
    type: "multiple-choice",
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Gamma" },
    ],
    allowOther: true,
    allowExplanation: false,
    required: true,
    minSelected: 1,
    maxSelected: 2,
  };

  it("enforces the maximum, and submits the selected options plus Other", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(multi);
    expect(screen.getByText("Choose up to 2.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Gamma" }));
    await userEvent.click(submitBtn());
    expect(screen.getByText("choose at most 2")).toBeInTheDocument();
    expect(api.count("POST", SUBMIT)).toBe(0);
    await userEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Gamma" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Other" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Describe your other choice" }), "Delta");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "choice", optionIds: ["a", "__other"], otherText: "Delta" }]);
  });
});

describe("QuestionForm: free text", () => {
  const text: AnswerSchema = { type: "free-text", required: true, minLength: 5, maxLength: 40, multiline: true, placeholder: "Your notes" };

  it("shows a live character count, enforces the minimum length and submits the text", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(text);
    const box = screen.getByRole("textbox", { name: "Response" });
    expect(box).toHaveAttribute("maxlength", "40");
    expect(box).toHaveAccessibleDescription("0 / 40 characters (minimum 5)");
    await userEvent.type(box, "abc");
    expect(screen.getByText("3 / 40 characters (minimum 5)")).toBeInTheDocument();
    await userEvent.click(submitBtn());
    expect(screen.getByText("at least 5 characters")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(box, "defg");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "text", text: "abcdefg" }]);
  });

  it("an optional empty field submits no value for it", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm({ ...text, required: false });
    expect(screen.getByRole("group", { name: /Your response\s*\(optional\)/ })).toBeInTheDocument();
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([]);
  });
});

describe("QuestionForm: approval", () => {
  const approval: AnswerSchema = { type: "approval", required: true, allowRationale: true, requireRationaleOnReject: true };

  it("requires a rationale when rejecting, not when approving", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(approval);
    expect(screen.getByText("Rationale (required when rejecting)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Reject" }));
    await userEvent.click(submitBtn());
    expect(screen.getByText("give a reason for rejecting")).toBeInTheDocument();
    expect(api.count("POST", SUBMIT)).toBe(0);
    await userEvent.type(screen.getByRole("textbox", { name: /Rationale/ }), "Scope too large");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "approval", decision: "reject", rationale: "Scope too large" }]);
  });

  it("approve without rationale is valid", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(approval);
    await userEvent.click(screen.getByRole("radio", { name: "Approve" }));
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "approval", decision: "approve" }]);
  });
});

describe("QuestionForm: file upload", () => {
  const files: AnswerSchema = { type: "file-upload", required: true, minFiles: 1, maxFiles: 2, allowComment: true };
  const png = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type: "image/png" });

  it("uploads each file with the question id first, then submits the returned attachment ids", async () => {
    const sent = fakeXhr([
      { status: 201, body: { attachments: [{ attachmentId: "ATT-1", fileName: "a.png", mimeType: "image/png", bytes: 10 }] } },
      { status: 201, body: { attachments: [{ attachmentId: "ATT-2", fileName: "b.png", mimeType: "image/png", bytes: 10 }] } },
    ]);
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(files);
    await userEvent.click(submitBtn());
    expect(screen.getByText("required")).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText(/Choose files/), [png("a.png"), png("b.png")]);
    expect(screen.getByRole("button", { name: /Remove\s*a\.png/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Comment (optional)" }), "two screenshots");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe(`/api/projects/${PID}/uploads`);
    expect(sent[0].headers["x-pcc-request"]).toBe("1");
    expect([...sent[0].form.keys()]).toEqual(["questionId", "file"]);
    expect(sent[0].form.get("questionId")).toBe("Q-1");
    expect((sent[1].form.get("file") as File).name).toBe("b.png");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "files", attachmentIds: ["ATT-1", "ATT-2"], comment: "two screenshots" }]);
  });

  it("rejects disallowed types and oversize files before uploading", async () => {
    const sent = fakeXhr([]);
    const api = mockFetch({});
    renderForm(files);
    await userEvent.upload(screen.getByLabelText(/Choose files/), [new File(["x"], "notes.pdf", { type: "application/pdf" })], { applyAccept: false });
    expect(screen.getByText("notes.pdf: file type application/pdf is not allowed")).toBeInTheDocument();
    await userEvent.click(submitBtn());
    expect(screen.getAllByText("notes.pdf: file type application/pdf is not allowed").length).toBeGreaterThan(1);
    await userEvent.click(screen.getByRole("button", { name: /Remove\s*notes\.pdf/ }));
    await userEvent.upload(screen.getByLabelText(/Choose files/), [png("huge.png", 2 * 1024 * 1024)]);
    await userEvent.click(submitBtn());
    expect(screen.getAllByText(/huge.png is too large/).length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("limits the number of files and says how many were not added", async () => {
    fakeXhr([]);
    mockFetch({});
    renderForm(files);
    await userEvent.upload(screen.getByLabelText(/Choose files/), [png("1.png"), png("2.png"), png("3.png")]);
    expect(screen.getByText("Only 2 files are allowed; 1 not added.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove\s*3\.png/ })).toBeNull();
    expect(screen.getByLabelText(/Choose files/)).toBeDisabled();
  });

  it("an upload failure stays visible; retry uploads only the failed file and keeps the same idempotency key", async () => {
    const sent = fakeXhr([
      { status: 201, body: { attachments: [{ attachmentId: "ATT-1", fileName: "a.png", mimeType: "image/png", bytes: 10 }] } },
      { status: 413, body: { error: "too-large", message: "file exceeds the limit" } },
      { status: 201, body: { attachments: [{ attachmentId: "ATT-3", fileName: "b.png", mimeType: "image/png", bytes: 10 }] } },
    ]);
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(files);
    await userEvent.upload(screen.getByLabelText(/Choose files/), [png("a.png"), png("b.png")]);
    await userEvent.click(submitBtn());
    expect(await screen.findByText("Upload failed for b.png: file exceeds the limit")).toBeInTheDocument();
    expect(screen.getByText("Uploaded")).toBeInTheDocument();
    expect(submitBtn()).toBeEnabled();
    expect(api.count("POST", SUBMIT)).toBe(0);
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect(sent).toHaveLength(3);
    expect((sent[2].form.get("file") as File).name).toBe("b.png");
    expect((api.calls[0].body as { answers: { attachmentIds: string[] }[] }).answers[0].attachmentIds).toEqual(["ATT-1", "ATT-3"]);
  });
});

describe("QuestionForm: composite and server errors", () => {
  const composite: AnswerSchema = {
    type: "composite",
    fields: [
      { id: "choice", label: "Direction", type: "single-choice", options: [{ id: "n", label: "North" }, { id: "s", label: "South" }], allowOther: false, allowExplanation: false, required: true },
      { id: "why", label: "Why", help: "One sentence is enough.", type: "free-text", required: true, minLength: 1, maxLength: 200, multiline: false },
    ],
  };

  it("labels each field, shows help, and validates every field at once", async () => {
    mockFetch({});
    renderForm(composite);
    expect(screen.getByRole("group", { name: /Direction\s*\(required\)/ })).toBeInTheDocument();
    const why = screen.getByRole("group", { name: /Why/ });
    expect(why).toHaveAccessibleDescription("One sentence is enough.");
    await userEvent.click(submitBtn());
    expect(screen.getAllByText("required")).toHaveLength(2);
    expect(why).toHaveAccessibleDescription(/One sentence is enough\.\s*required/);
  });

  it("server field errors and the general message stay visible; the form stays editable and resubmits with the same key", async () => {
    let attempt = 0;
    const api = mockFetch({
      [`POST ${SUBMIT}`]: () =>
        ++attempt === 1
          ? { status: 422, body: { error: "validation", message: "The answer does not match the question", fieldErrors: [{ fieldId: "why", message: "too vague" }] } }
          : accepted,
    });
    renderForm(composite);
    await userEvent.click(screen.getByRole("radio", { name: "North" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Why" }), "dunno");
    await userEvent.click(submitBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent("The answer does not match the question");
    expect(screen.getByText("too vague")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Why" })).toHaveValue("dunno");
    expect(screen.getByRole("textbox", { name: "Why" })).toBeEnabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Why" }), " — closer to the river");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    const [first, second] = api.calls.filter((c) => c.method === "POST").map((c) => c.body as { idempotencyKey: string; answers: unknown[] });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.answers).toEqual([
      { fieldId: "choice", kind: "choice", optionIds: ["n"] },
      { fieldId: "why", kind: "text", text: "dunno — closer to the river" },
    ]);
  });

  it("a network failure is reported and the button re-enables", async () => {
    mockFetch({});
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    renderForm(single({ allowOther: false }));
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    await userEvent.click(submitBtn());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    expect(screen.getByRole("radio", { name: "Red" })).toBeChecked();
  });
});

describe("configured defaults", () => {
  it("pre-selects the default, says so, and sends nothing until the user submits", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(single({ default: "blue" }));
    expect(screen.getByRole("radio", { name: /Blue/ })).toBeChecked();
    expect(screen.getByTestId("field-default")).toHaveTextContent("Suggested default: Blue");
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls).toHaveLength(0);
  });

  it("the user can change the default; the changed value is what is submitted", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm(single({ default: "blue" }));
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "choice", optionIds: ["red"] }]);
  });

  it("an accepted default is submitted as an ordinary answer only when the user submits", async () => {
    const api = mockFetch({ [`POST ${SUBMIT}`]: accepted });
    renderForm({ type: "approval", required: true, allowRationale: true, requireRationaleOnReject: false, default: "approve" });
    expect(screen.getByRole("radio", { name: "Approve" })).toBeChecked();
    expect(screen.getByTestId("field-default")).toHaveTextContent("Suggested default: Approve");
    await userEvent.click(submitBtn());
    await screen.findByText("Submitted · Awaiting pickup");
    expect((api.calls[0].body as { answers: unknown[] }).answers).toEqual([{ fieldId: "response", kind: "approval", decision: "approve" }]);
  });

  it("pre-fills multiple-choice and free-text defaults", () => {
    mockFetch({});
    renderForm({
      type: "composite",
      fields: [
        { id: "langs", label: "Languages", type: "multiple-choice", required: true, options: [{ id: "en", label: "English" }, { id: "nl", label: "Dutch" }], allowOther: false, allowExplanation: false, minSelected: 1, default: ["nl"] },
        { id: "note", label: "Note", type: "free-text", required: false, minLength: 0, maxLength: 100, multiline: false, default: "as before" },
        { id: "plain", label: "Plain", type: "free-text", required: false, minLength: 0, maxLength: 100, multiline: false },
      ],
    } as AnswerSchema);
    expect(screen.getByRole("checkbox", { name: "Dutch" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "English" })).not.toBeChecked();
    expect(screen.getByDisplayValue("as before")).toBeInTheDocument();
    expect(screen.getAllByTestId("field-default")).toHaveLength(2);
  });
});
