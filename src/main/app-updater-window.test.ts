import { describe, expect, it } from "vitest";
import { appUpdaterWindowDocument, appUpdaterWindowUrl } from "./app-updater-window";

describe("Orbit updater window", () => {
  it("renders a self-contained, sandbox-friendly progress window", () => {
    const document = appUpdaterWindowDocument();

    expect(document).toContain("Content-Security-Policy");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain('role="status"');
    expect(document).toContain("Keep this window open while Orbit rebuilds.");
    expect(document).toContain("window.setOrbitUpdaterStatus");
    expect(appUpdaterWindowUrl()).toMatch(/^data:text\/html;charset=utf-8,/);
  });
});
