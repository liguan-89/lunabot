import { describe, expect, it } from "vitest";
import { compatBaseUrlProblem, MAX_COMPAT_BASE_URL_LENGTH } from "./compat-base-url";

describe("compatBaseUrlProblem", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["https://api.example.com/v1", null],
    ["http://localhost:11434/v1", null],
    ["api.example.com/v1", "invalid-url"],
    ["ftp://api.example.com/v1", "invalid-url"],
    ["https://user:pass@api.example.com/v1", "unsafe-url"],
    ["https://api.example.com/v1?key=secret", "unsafe-url"],
    ["https://api.example.com/v1#fragment", "unsafe-url"],
    [`https://api.example.com/${"a".repeat(MAX_COMPAT_BASE_URL_LENGTH)}`, "too-long"],
  ])("checks %j", (value, problem) => {
    expect(compatBaseUrlProblem(value)).toBe(problem);
  });
});
