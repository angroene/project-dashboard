import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TemplateSummary } from "../../shared/api";
import { FieldFilter, Templates } from "./CardExtras";
import { mockFetch, renderWithProviders } from "../test/utils";

const PID = "p1";

describe("FieldFilter", () => {
  it("offers any / each value with counts / not set", async () => {
    mockFetch({});
    const onChange = vi.fn();
    renderWithProviders(<FieldFilter def={{ id: "reviewed", label: "Reviewed", type: "checkbox", editableBy: ["user"], filter: true }} counts={{ true: 2, "": 5 }} value="*" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Filter by Reviewed" });
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Reviewed: any", "Reviewed: Yes (2)", "Reviewed: No (0)", "Reviewed: not set (5)"]);
    await userEvent.selectOptions(select, "true");
    expect(onChange).toHaveBeenCalledWith("true");
  });
});

describe("Templates", () => {
  const t = (over: Partial<TemplateSummary>): TemplateSummary => ({
    id: "checkin", sectionId: "daily", title: "Daily check-in", state: "active",
    schedule: { frequency: "daily", time: "09:00", timezone: "Europe/Amsterdam", startDate: "2026-11-01", catchUpDays: 0 }, ...over,
  });

  it("pauses an active template and resumes a paused one", async () => {
    const url = `/api/projects/${PID}/templates/checkin/state`;
    const api = mockFetch({ [`POST ${url}`]: t({ state: "paused" }) });
    renderWithProviders(<Templates items={[t({ lastDate: "2026-11-13" })]} />, { project: { pid: PID } });
    await userEvent.click(screen.getByText("Recurring templates (1)"));
    expect(screen.getByText(/last 2026-11-13/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.count("POST", url)).toBe(1));
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ state: "paused" });
  });

  it("shows a template's error and offers no pause for disabled templates", async () => {
    mockFetch({});
    renderWithProviders(<Templates items={[t({ state: "disabled", error: "unknown time zone" })]} />, { project: { pid: PID } });
    await userEvent.click(screen.getByText("Recurring templates (1)"));
    expect(screen.getByText(/unknown time zone/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause|Resume/ })).toBeNull();
  });
});
