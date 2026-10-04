import { describe, expect, it } from "vitest";
import { formatContextShare } from "../lib/format";

describe("formatContextShare", () => {
  it("rounds a 0..1 share to a whole percent (BBP-96: 0.084573 read as 8%, not 0.084573%)", () => {
    expect(formatContextShare(0.084573)).toBe("8%");
  });

  it("rounds down below the half-point", () => {
    expect(formatContextShare(0.004)).toBe("0%");
  });

  it("rounds up at the half-point", () => {
    expect(formatContextShare(0.005)).toBe("1%");
  });

  it("handles the empty and full ends", () => {
    expect(formatContextShare(0)).toBe("0%");
    expect(formatContextShare(1)).toBe("100%");
  });
});
