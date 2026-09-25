// @vitest-environment node
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  shell: { trashItem: vi.fn() }
}));
vi.mock("@opencode/client", () => ({ OpenCode: { make: vi.fn() } }));
vi.mock("@opencode/client/service", () => ({ Service: {} }));

import { MAX_RETAINED_OUTPUT_CHARS } from "@shared/retention";
import { replayTranscript } from "./opencode";

describe("replay retention", () => {
  it("reconstructs failed tools and assistant messages as settled", () => {
    const transcript = replayTranscript([{
      info: {
        id: "assistant-1",
        role: "assistant",
        error: { message: "provider failed" }
      },
      parts: [{
        id: "tool-1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: { status: "failed", error: { message: "File not found" } }
      }]
    }]);

    expect(transcript[0]).toMatchObject({
      kind: "assistant",
      completed: true,
      error: "[ORBIT_ASSISTANT_FAILED] provider failed",
      parts: [{ kind: "tool", tool: { status: "failed" } }]
    });
  });

  it("bounds completed projected tool output while retaining file content", () => {
    const output = "x".repeat(MAX_RETAINED_OUTPUT_CHARS * 2);
    const transcript = replayTranscript([{
      info: { id: "assistant-1", role: "assistant" },
      parts: [{
        id: "tool-1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "completed",
          output,
          content: [
            { type: "text", text: output },
            { type: "file", uri: "file:///result", mime: "text/plain", name: "result.txt" }
          ]
        }
      }]
    }]);
    const assistant = transcript[0];
    const part = assistant?.kind === "assistant" ? assistant.parts[0] : undefined;

    expect(part?.kind === "tool" ? part.tool.output?.length : 0).toBe(MAX_RETAINED_OUTPUT_CHARS);
    expect(part?.kind === "tool" ? part.tool.output : "").toContain("characters omitted");
    expect(part?.kind === "tool" ? part.tool.content : undefined).toEqual([
      { type: "file", uri: "file:///result", mime: "text/plain", name: "result.txt" }
    ]);
  });
});
