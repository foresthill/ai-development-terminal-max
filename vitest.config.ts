import { defineConfig } from "vitest/config";

// Unit tests run in Node (pure logic only — no DOM/WKWebView). Rendering and
// WKWebView-specific behaviour cannot be tested here; those need the real app.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
