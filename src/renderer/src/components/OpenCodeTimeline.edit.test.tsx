import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, TranscriptItem } from "@shared/types";
import { OpenCodeTimeline } from "./OpenCodeTimeline";

const storeState = vi.hoisted(() => ({
  agents: [] as { id: string; name: string }[],
  sessions: [] as unknown[],
  session: null as SessionInfo | null,
  reopenSession: vi.fn(),
  openFile: vi.fn(),
  focusSession: vi.fn(),
  replyPermission: vi.fn()
}));

vi.mock("../store", () => ({
  useStore: () => storeState
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATCH = [
  "Index: src/renderer/src/styles/_foundation.scss",
  "===================================================================",
  "--- src/renderer/src/styles/_foundation.scss",
  "+++ src/renderer/src/styles/_foundation.scss",
  "@@ -3,7 +3,8 @@",
  "   --bg-panel: rgba(27, 25, 21, 0.82);",
  "-  --sidebar-surface-color: rgba(23, 23, 27, 0.72);",
  "+  --panel-surface-color: rgba(23, 23, 27, 0.72);",
  "+  --panel-aura-x: 50%;",
  " ",
  "   --text: #ece7dc;"
].join("\n");

const editTool = (
  id: string,
  metadata: Record<string, unknown> | undefined,
  input: Record<string, unknown> = { path: "src/renderer/src/styles/_foundation.scss" }
): TranscriptItem => ({
  kind: "assistant",
  id,
  messageID: id,
  completed: true,
  parts: [{
    kind: "tool",
    id: `${id}:tool`,
    tool: {
      id: `${id}:tool`,
      title: "edit",
      detail: "",
      status: "success",
      input: JSON.stringify(input),
      inputValue: input,
      ...(metadata ? { metadata } : {})
    }
  }]
});

describe("edit tool diff cards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    storeState.agents = [];
    storeState.sessions = [];
    storeState.session = null;
    storeState.reopenSession.mockReset();
    storeState.openFile.mockReset();
    storeState.focusSession.mockReset();
    storeState.replyPermission.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the full path and addition/deletion stats from metadata.files", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[editTool("assistant-1", {
          files: [{ file: "src/renderer/src/styles/_foundation.scss", patch: PATCH, status: "modified", additions: 2, deletions: 1 }]
        })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const card = container.querySelector("[data-component='edit-tool']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("src/renderer/src/styles/_foundation.scss");
    expect(card?.querySelector("[data-slot='edit-stat-add']")?.textContent).toBe("+2");
    expect(card?.querySelector("[data-slot='edit-stat-del']")?.textContent).toBe("-1");
  });

  it("expands into a colorized unified diff without the patch header", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[editTool("assistant-1", {
          files: [{ file: "src/app.ts", patch: PATCH, status: "modified", additions: 2, deletions: 1 }]
        })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const trigger = container.querySelector("[data-slot='collapsible-trigger']") as HTMLButtonElement | null;
    expect(trigger?.disabled).toBe(false);
    expect(document.querySelector("[data-component='patch-diff']")).toBeNull();

    act(() => trigger?.click());

    const lines = [...container.querySelectorAll("[data-component='patch-diff-line']")];
    expect(lines.map((line) => line.getAttribute("data-kind"))).toEqual(["hunk", "context", "del", "add", "add", "context", "context"]);
    expect(container.querySelector("[data-component='patch-diff']")?.textContent).not.toContain("Index:");
    expect(container.querySelector("[data-component='patch-diff']")?.textContent).not.toContain("+++");
  });

  it("opens the edited file in the editor pane from the path subtitle", () => {
    storeState.session = { id: "session-1", directory: "/repo", workspace: { id: "workspace-1", generation: 1 } };
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[editTool("assistant-1", {
          files: [{ file: "src/app.ts", patch: PATCH, additions: 1, deletions: 0 }]
        })]}
        busy={false}
        lastAssistantId={null}
        session={storeState.session}
      />
    ));

    const subtitle = container.querySelector("[data-slot='basic-tool-tool-subtitle']") as HTMLElement | null;
    act(() => subtitle?.click());
    expect(storeState.focusSession).toHaveBeenCalledWith("session-1");
    expect(storeState.openFile).toHaveBeenCalledWith("src/app.ts", undefined, storeState.session.workspace);
  });

  it("renders one section per file when a part edits several files", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[editTool("assistant-1", {
          files: [
            { file: "src/a.ts", patch: PATCH, status: "modified", additions: 2, deletions: 1 },
            { file: "src/b.ts", patch: PATCH, status: "added", additions: 2, deletions: 0 }
          ]
        })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const card = container.querySelector("[data-component='edit-tool']");
    expect(card?.textContent).toContain("2 files");
    const groupedSummary = card?.querySelector("[data-slot='edit-tool-summary']");
    expect(groupedSummary?.textContent).toBe("src/a.ts2 files+4-1");
    expect(groupedSummary?.querySelector("[data-slot='basic-tool-tool-subtitle']")).not.toBeNull();
    expect(groupedSummary?.querySelector("[data-slot='edit-tool-meta']")).not.toBeNull();

    const trigger = container.querySelector("[data-slot='collapsible-trigger']") as HTMLButtonElement | null;
    act(() => trigger?.click());

    expect(container.querySelectorAll("[data-component='edit-tool-file']")).toHaveLength(2);
    expect([...container.querySelectorAll("[data-slot='edit-tool-file-status']")].map((node) => node.textContent))
      .toEqual(["modified", "added"]);
  });

  it("delegates to the generic tool card for edit parts without file metadata", () => {
    act(() => root.render(
      <OpenCodeTimeline transcript={[editTool("assistant-1", undefined)]} busy={false} lastAssistantId={null} />
    ));

    expect(container.querySelector("[data-component='tool-part-wrapper']")).not.toBeNull();
    expect(container.querySelector("[data-slot='edit-tool-stats']")).toBeNull();
    expect(container.querySelector("[data-component='patch-diff']")).toBeNull();
  });
});
