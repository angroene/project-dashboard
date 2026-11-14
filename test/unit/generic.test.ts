import { describe, expect, it } from "vitest";
import { defaultAnswers, defaultErrors } from "../../src/shared/validate.js";
import { fieldErrors, fieldValueError, fieldValueText } from "../../src/shared/fields.js";
import { addDays, dueDates, localDateTime } from "../../src/server/recurrence.js";
import { AnswerSchema, RecurringTemplate, TrackedFieldDef } from "../../src/shared/schemas.js";

describe("defaults", () => {
  it("builds answer values only for fields with a default", () => {
    const schema = AnswerSchema.parse({ type: "composite", fields: [
      { id: "a", label: "A", type: "single-choice", options: [{ id: "x", label: "X" }], default: "x" },
      { id: "b", label: "B", type: "free-text" },
      { id: "c", label: "C", type: "approval", default: "reject" },
    ] });
    expect(defaultAnswers(schema)).toEqual([
      { fieldId: "a", kind: "choice", optionIds: ["x"] },
      { fieldId: "c", kind: "approval", decision: "reject" },
    ]);
    expect(defaultErrors(schema)).toEqual([]);
  });

  it("a reject default is invalid when the schema demands a reason for rejecting", () => {
    const schema = AnswerSchema.parse({ type: "approval", requireRationaleOnReject: true, allowRationale: true, default: "reject" });
    expect(defaultErrors(schema).map((e) => e.message)).toEqual(["give a reason for rejecting"]);
  });

  it("a multiple-choice default below minSelected is invalid", () => {
    const schema = AnswerSchema.parse({ type: "multiple-choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], minSelected: 2, default: ["a"] });
    expect(defaultErrors(schema).map((e) => e.message)).toEqual(["choose at least 2"]);
  });
});

describe("tracked field values", () => {
  const def = (o: object) => TrackedFieldDef.parse({ id: "f", label: "F", ...o });
  it("checks each type", () => {
    expect(fieldValueError(def({ type: "checkbox" }), true)).toBeNull();
    expect(fieldValueError(def({ type: "checkbox" }), "true")).toBe("expected true or false");
    expect(fieldValueError(def({ type: "choice", options: [{ id: "a", label: "A" }] }), "a")).toBeNull();
    expect(fieldValueError(def({ type: "choice", options: [{ id: "a", label: "A" }] }), "b")).toBe("unknown option 'b'");
    expect(fieldValueError(def({ type: "text" }), false)).toBe("expected text");
    expect(fieldValueError(def({ type: "date" }), "2028-02-29")).toBeNull();
    expect(fieldValueError(def({ type: "date" }), "2026-02-29")).toBe("expected a date as YYYY-MM-DD");
    expect(fieldValueError(def({ type: "date" }), null)).toBeNull();
  });
  it("reports unknown field ids and renders values", () => {
    expect(fieldErrors([def({ type: "text" })], { g: "x" })).toEqual([{ fieldId: "g", message: "this card has no such field" }]);
    expect(fieldValueText(def({ type: "checkbox" }), false)).toBe("no");
    expect(fieldValueText(def({ type: "choice", options: [{ id: "a", label: "Alpha" }] }), "a")).toBe("Alpha");
    expect(fieldValueText(def({ type: "text" }), null)).toBe("—");
  });
  it("rejects bad definitions", () => {
    expect(TrackedFieldDef.safeParse({ id: "f", label: "F", type: "choice" }).success).toBe(false);
    expect(TrackedFieldDef.safeParse({ id: "f", label: "F", type: "text", options: [{ id: "a", label: "A" }] }).success).toBe(false);
    expect(TrackedFieldDef.safeParse({ id: "1f", label: "F", type: "text" }).success).toBe(false);
    expect(TrackedFieldDef.safeParse({ id: "f", label: "F", type: "script" }).success).toBe(false);
  });
});

describe("recurrence dates", () => {
  const tpl = (schedule: object) => RecurringTemplate.parse({
    schemaVersion: 1, id: "t", title: "T", schedule: { frequency: "daily", timezone: "UTC", startDate: "2026-01-01", ...schedule }, record: { recordType: "task", status: "planned" },
  });
  it("local date/time follows the time zone", () => {
    expect(localDateTime(new Date("2026-06-30T23:30:00Z"), "Europe/Amsterdam")).toEqual({ date: "2026-07-01", time: "01:30" });
    expect(localDateTime(new Date("2026-06-30T23:30:00Z"), "America/Los_Angeles")).toEqual({ date: "2026-06-30", time: "16:30" });
  });
  it("adds days across month and leap-year boundaries", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("due dates respect time, cursor, window, start and end", () => {
    const now = new Date("2026-03-10T08:00:00Z");
    expect(dueDates(tpl({ time: "09:00" }), now, undefined)).toEqual([]);
    expect(dueDates(tpl({ time: "09:00", catchUpDays: 2 }), now, undefined)).toEqual(["2026-03-08", "2026-03-09"]);
    expect(dueDates(tpl({ time: "08:00", catchUpDays: 2 }), now, "2026-03-08")).toEqual(["2026-03-09", "2026-03-10"]);
    expect(dueDates(tpl({ time: "08:00", catchUpDays: 2 }), now, "2026-03-10")).toEqual([]);
    expect(dueDates(tpl({ time: "08:00", endDate: "2026-03-09", catchUpDays: 5 }), now, undefined)).toEqual(["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(dueDates(tpl({ time: "08:00", startDate: "2026-03-11" }), now, undefined)).toEqual([]);
  });
  it("rejects bad schedules", () => {
    const ok = (s: object) => RecurringTemplate.safeParse({ schemaVersion: 1, id: "t", title: "T", schedule: { frequency: "daily", timezone: "UTC", startDate: "2026-01-01", ...s }, record: {} }).success;
    expect(ok({})).toBe(true);
    expect(ok({ timezone: "Nowhere/City" })).toBe(false);
    expect(ok({ time: "24:00" })).toBe(false);
    expect(ok({ startDate: "2026-02-30" })).toBe(false);
    expect(ok({ frequency: "weekly" })).toBe(false);
    expect(ok({ catchUpDays: 32 })).toBe(false);
  });
});
