import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportPreview } from "../../shared/api";
import { ImportDialog } from "./ImportDialog";
import { mockFetch, renderWithProviders } from "../test/utils";

const PREVIEW = "/api/projects/p1/import/xlsx/preview";
const COMMIT = "/api/projects/p1/import/xlsx/commit";

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  previewId: "pv-1",
  projectId: "p1",
  fileName: "answers.xlsx",
  totals: { ready: 2, blank: 1, invalid: 1, stale: 0, "already-answered": 0, "needs-dashboard": 0 },
  rows: [
    { questionId: "Q-1", title: "Pick a colour", status: "ready", messages: [] },
    { questionId: "Q-2", title: "Pick a size", status: "ready", messages: ["note one", "note two"] },
    { questionId: "Q-3", title: "Untouched", status: "blank", messages: [] },
    { questionId: "Q-4", title: "Broken", status: "invalid", messages: ["value not allowed"] },
  ],
  errors: [],
  expiresAt: "2026-11-10T12:00:00Z",
  ...over,
});

/** XMLHttpRequest stand-in answering each upload with the next scripted reply (or a network error). */
function fakeXhr(replies: ({ status: number; body: unknown } | "network-error")[]) {
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
        if (reply === "network-error") return this.onerror?.();
        this.status = reply.status;
        this.responseText = JSON.stringify(reply.body);
        this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return sent;
}

const xlsx = (name = "answers.xlsx") => new File(["x"], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

function renderDialog(onClose = vi.fn()) {
  const r = renderWithProviders(<ImportDialog onClose={onClose} />, { project: { pid: "p1" } });
  return { onClose, ...r };
}

async function uploadFile(file = xlsx()) {
  await userEvent.upload(screen.getByLabelText("Workbook (.xlsx)"), file);
  await userEvent.click(screen.getByRole("button", { name: "Preview import" }));
}

describe("ImportDialog: upload step", () => {
  it("disables Preview until a file is chosen", async () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Preview import" })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText("Workbook (.xlsx)"), xlsx());
    expect(screen.getByRole("button", { name: "Preview import" })).toBeEnabled();
  });

  it("uploads the workbook as multipart and shows the preview with totals and rows", async () => {
    const sent = fakeXhr([{ status: 200, body: preview() }]);
    renderDialog();
    await uploadFile();
    expect(await screen.findByText(/answers\.xlsx · preview valid until/)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(PREVIEW);
    expect(sent[0].headers["x-pcc-request"]).toBe("1");
    expect((sent[0].form.get("file") as File).name).toBe("answers.xlsx");

    const totals = screen.getByRole("list", { name: "Preview totals" });
    expect(within(totals).getByText("2 · Ready to submit")).toBeInTheDocument();
    expect(within(totals).getByText("1 · Invalid")).toBeInTheDocument();
    expect(within(totals).getByText("0 · Stale (question changed)")).toBeInTheDocument();

    expect(screen.getByText("note one; note two")).toBeInTheDocument();
    expect(screen.getByText("value not allowed")).toBeInTheDocument();
    expect(screen.getByText("Pick a colour")).toBeInTheDocument();
  });

  it("shows the server error and stays on the upload step when the preview is rejected", async () => {
    fakeXhr([{ status: 400, body: { error: "bad-request", message: "only .xlsx files can be imported" } }]);
    renderDialog();
    await uploadFile(xlsx("answers.xlsx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("only .xlsx files can be imported");
    expect(screen.getByRole("button", { name: "Preview import" })).toBeEnabled();
  });

  it("reports a network failure", async () => {
    fakeXhr(["network-error"]);
    renderDialog();
    await uploadFile();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error during upload");
  });

  it("Cancel closes the dialog", async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ImportDialog: preview step", () => {
  it("shows workbook-level problems", async () => {
    fakeXhr([{ status: 200, body: preview({ errors: ["Workbook belongs to another project"], rows: [], totals: preview().totals }) }]);
    renderDialog();
    await uploadFile();
    expect(await screen.findByText("Workbook belongs to another project")).toBeInTheDocument();
    expect(screen.getByText("Workbook problems:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit 0 selected answers/ })).toBeDisabled();
  });

  it("preselects only ready rows; other statuses get no checkbox", async () => {
    fakeXhr([{ status: 200, body: preview() }]);
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    expect(screen.getByRole("checkbox", { name: "Submit answer for Q-1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Submit answer for Q-2" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Submit answer for Q-3" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Submit answer for Q-4" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit 2 selected answers" })).toBeEnabled();
  });

  it("commits only the ticked rows and shows per-row results", async () => {
    fakeXhr([{ status: 200, body: preview() }]);
    const api = mockFetch({
      [`POST ${COMMIT}`]: { results: [{ questionId: "Q-2", ok: true, answerId: "A-2" }] },
    });
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    await userEvent.click(screen.getByRole("checkbox", { name: "Submit answer for Q-1" }));
    expect(screen.getByRole("button", { name: "Submit 1 selected answer" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Submit 1 selected answer" }));

    expect(await screen.findByText("Submitted · Awaiting pickup")).toBeInTheDocument();
    expect(api.calls[0].body).toEqual({ previewId: "pv-1", questionIds: ["Q-2"] });
    expect(await screen.findByText("Imported 1 of 1 answers · awaiting pickup")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Submit answer for Q-2" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Choose another file" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("surfaces partial failures from the commit", async () => {
    fakeXhr([{ status: 200, body: preview() }]);
    mockFetch({
      [`POST ${COMMIT}`]: {
        results: [
          { questionId: "Q-1", ok: true, answerId: "A-1" },
          { questionId: "Q-2", ok: false, message: "question changed" },
        ],
      },
    });
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    await userEvent.click(screen.getByRole("button", { name: "Submit 2 selected answers" }));
    expect(await screen.findByText("question changed")).toBeInTheDocument();
    expect(screen.getByText("Imported 1 of 2 answers · awaiting pickup")).toBeInTheDocument();
  });

  it("shows a commit error and allows retry", async () => {
    fakeXhr([{ status: 200, body: preview() }]);
    let fail = true;
    mockFetch({
      [`POST ${COMMIT}`]: () => (fail ? { status: 410, body: { error: "gone", message: "preview expired" } } : { results: [{ questionId: "Q-1", ok: true }, { questionId: "Q-2", ok: true }] }),
    });
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    await userEvent.click(screen.getByRole("button", { name: "Submit 2 selected answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("preview expired");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Submit 2 selected answers" }));
    await waitFor(() => expect(screen.getByText("Imported 2 of 2 answers · awaiting pickup")).toBeInTheDocument());
    expect(screen.queryByText("preview expired")).not.toBeInTheDocument();
  });

  it("unticking every row disables submit", async () => {
    fakeXhr([{ status: 200, body: preview({ rows: preview().rows.slice(0, 1) }) }]);
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    await userEvent.click(screen.getByRole("checkbox", { name: "Submit answer for Q-1" }));
    expect(screen.getByRole("button", { name: "Submit 0 selected answers" })).toBeDisabled();
  });

  it("Choose another file returns to the upload step", async () => {
    fakeXhr([{ status: 200, body: preview() }]);
    renderDialog();
    await uploadFile();
    await screen.findByText(/preview valid until/);
    await userEvent.click(screen.getByRole("button", { name: "Choose another file" }));
    expect(screen.getByLabelText("Workbook (.xlsx)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview import" })).toBeDisabled();
  });

  it("renders unknown row statuses without crashing", async () => {
    const odd = preview({ rows: [{ questionId: "Q-9", title: "Odd", status: "mystery" as never, messages: [] }] });
    fakeXhr([{ status: 200, body: odd }]);
    renderDialog();
    await uploadFile();
    expect(await screen.findByText("mystery")).toBeInTheDocument();
  });

  it("the close button and Escape request close", async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent(screen.getByRole("dialog", { hidden: true }), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
