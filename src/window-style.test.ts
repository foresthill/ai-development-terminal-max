import { describe, it, expect } from "vitest";
import { WINDOW_STYLES, getWindowStyle } from "./window-style";

// applyWindowStyle() touches the DOM (node env has none), so only the pure data
// is exercised here.
describe("window-style", () => {
  it("offers rounded + angular", () => {
    expect(WINDOW_STYLES).toEqual(["rounded", "angular"]);
  });
  it("defaults to rounded with no stored choice", () => {
    expect(getWindowStyle()).toBe("rounded");
  });
});
