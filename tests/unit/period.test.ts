import { describe, expect, it } from "vitest";
import { utcPeriodStart } from "../../src/domain/period.js";

describe("utcPeriodStart", () => {
  it("maps a mid-month instant to the first day of its month", () => {
    expect(utcPeriodStart(new Date("2026-10-15T10:00:00.000Z"))).toBe("2026-10-01");
  });

  it("keeps the very last millisecond of October in October", () => {
    expect(utcPeriodStart(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10-01");
  });

  it("starts November exactly at 00:00:00.000 UTC", () => {
    expect(utcPeriodStart(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
  });

  it("rolls over the year", () => {
    expect(utcPeriodStart(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-01");
    expect(utcPeriodStart(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
  });

  it("uses UTC, not the local timezone (01:00 at +03:00 on Nov 1 is still October in UTC)", () => {
    expect(utcPeriodStart(new Date("2026-11-01T01:00:00+03:00"))).toBe("2026-10-01");
  });
});
