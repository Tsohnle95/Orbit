import { describe, expect, it } from "vitest";
import { tuiCommandForRuntime } from "./tui-command";

describe("runtime TUI commands", () => {
  it("resumes OpenCode sessions", () => {
    expect(tuiCommandForRuntime("opencode", "session-1")).toEqual({ command: "opencode", args: ["--session", "session-1"] });
  });

  it("rejects DeepSeek TUI sessions while that runtime is disabled", () => {
    expect(() => tuiCommandForRuntime("deepseek", "session-2")).toThrow("TUI is not supported");
  });

  it("rejects unknown runtimes", () => {
    expect(() => tuiCommandForRuntime("unknown", "session-3")).toThrow("TUI is not supported");
  });
});
