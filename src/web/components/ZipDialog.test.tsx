import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ZipPreflight } from "../../shared/api";
import { ZipDialog } from "./ZipDialog";
import { mockFetch, renderWithProviders } from "../test/utils";

const PRE = "/api/projects/p1/download/zip/preflight";
const ZIP = "/api/projects/p1/download/zip";

const pre = (over: Partial<ZipPreflight> = {}): ZipPreflight => ({
  available: [
    { id: "a1", fileName: "report.pdf", mimeType: "application/pdf", bytes: 2048 },
    { id: "a2", fileName: "notes.txt", mimeType: "text/plain", bytes: 10 },
  ] as ZipPreflight["available"],
  missing: [],
  totalBytes: 2058,
  ...over,
});

const zipReply = (name = "p1_documents_2026-11-10.zip") => ({ status: 200, body: {}, headers: { "Content-Disposition": `attachment; filename="${name}"` } });

function renderDialog(onClose = vi.fn()) {
  renderWithProviders(<ZipDialog recordIds={["R-1", "R-2"]} onClose={onClose} />, { project: { pid: "p1" } });
  return onClose;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

describe("ZipDialog", () => {
  it("sends the selected record ids to preflight and lists the available files", async () => {
    const api = mockFetch({ [`POST ${PRE}`]: pre() });
    renderDialog();
    expect(screen.getByText("Checking attachments…")).toBeInTheDocument();
    expect(await screen.findByText(/2 files available/)).toBeInTheDocument();
    expect(api.calls[0].body).toEqual({ recordIds: ["R-1", "R-2"] });
    const list = screen.getByRole("list");
    expect(within(list).getByText(/report\.pdf/)).toBeInTheDocument();
    expect(within(list).getByText(/notes\.txt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeEnabled();
  });

  it("uses singular wording for one file", async () => {
    mockFetch({ [`POST ${PRE}`]: pre({ available: pre().available.slice(0, 1) }) });
    renderDialog();
    expect(await screen.findByText(/1 file available/)).toBeInTheDocument();
  });

  it("warns about unavailable attachments and disables download when nothing is available", async () => {
    mockFetch({
      [`POST ${PRE}`]: pre({
        available: [],
        totalBytes: 0,
        missing: [
          { attachmentId: "att-9", recordId: "R-1", reason: "file missing on disk" },
          { attachmentId: "att-10", reason: "too large" },
        ],
      }),
    });
    renderDialog();
    expect(await screen.findByText("2 attachments are unavailable and will not be included:")).toBeInTheDocument();
    expect(screen.getByText("att-9")).toBeInTheDocument();
    expect(screen.getByText(/\(R-1\)/)).toBeInTheDocument();
    expect(screen.getByText(/file missing on disk/)).toBeInTheDocument();
    expect(screen.getByText(/too large/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeDisabled();
  });

  it("uses singular wording for one missing attachment", async () => {
    mockFetch({ [`POST ${PRE}`]: pre({ missing: [{ attachmentId: "att-9", reason: "gone" }] }) });
    renderDialog();
    expect(await screen.findByText("1 attachment is unavailable and will not be included:")).toBeInTheDocument();
  });

  it("downloads the ZIP, toasts the server file name and closes", async () => {
    const api = mockFetch({ [`POST ${PRE}`]: pre(), [`POST ${ZIP}`]: zipReply() });
    const onClose = renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Download ZIP" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.calls.find((c) => c.path === ZIP)?.body).toEqual({ recordIds: ["R-1", "R-2"] });
    expect(await screen.findByText("Downloaded p1_documents_2026-11-10.zip")).toBeInTheDocument();
  });

  it("reports a failed download as an error toast and stays open", async () => {
    mockFetch({ [`POST ${PRE}`]: pre(), [`POST ${ZIP}`]: { status: 500, body: { error: "internal", message: "disk full" } } });
    const onClose = renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByText("ZIP download failed: disk full")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeEnabled();
  });

  it("shows a preflight error with retry, and Cancel closes", async () => {
    let fail = true;
    const api = mockFetch({ [`POST ${PRE}`]: () => (fail ? { status: 403, body: { error: "forbidden", message: "not allowed" } } : pre()) });
    const onClose = renderDialog();
    expect(await screen.findByText("not allowed")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/2 files available/)).toBeInTheDocument();
    expect(api.count("POST", PRE)).toBe(2);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
