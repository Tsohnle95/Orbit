import { describe, expect, it } from "vitest";
import { tuiCommandForRuntime } from "./tui-command";

describe("runtime TUI commands", () => {
  it("resumes OpenCode sessions", () => {
    expect(tuiCommandForRuntime("opencode", "session-1")).toEqual({ command: "opencode", args: ["--session", "session-1"] });
  });

  it("resumes DeepSeek sessions through the TUI profile", () => {
    expect(tuiCommandForRuntime("deepseek", "session-2")).toEqual({ command: "dsh", args: ["--profile", "tui", "--resume", "session-2"] });
  });

  it("rejects unknown runtimes", () => {
    expect(() => tuiCommandForRuntime("unknown", "session-3")).toThrow("TUI is not supported");
  });
});
