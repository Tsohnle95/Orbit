import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionSummary, TranscriptItem } from "@shared/types";
import { OpenCodeTimeline } from "./OpenCodeTimeline";

const storeState = vi.hoisted(() => ({
  agents: [] as { id: string; name: string }[],
  sessions: [] as SessionSummary[],
  session: null as SessionInfo | null,
  reopenSession: vi.fn(),
  openFile: vi.fn(),
  focusSession: vi.fn(),
  replyPermission: vi.fn(),
  stageRevert: vi.fn()
}));

vi.mock("../store", () => ({
  useStore: () => storeState
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assistant = (id: string): TranscriptItem => ({
  kind: "assistant",
  id,
  messageID: id,
  completed: true,
  parts: [{ kind: "text", id: `${id}:text`, text: id, complete: true }]
});

const reasoningAssistant = (complete: boolean): TranscriptItem => ({
  kind: "assistant",
  id: "assistant-reasoning",
  messageID: "assistant-reasoning",
  completed: complete,
  parts: [{ kind: "reasoning", id: "reasoning-1", text: "Inspecting the code", complete }]
});

const toolAssistant = (id: string, title: string, input: Record<string, unknown>, metadata?: Record<string, unknown>): TranscriptItem => ({
  kind: "assistant",
  id,
  messageID: id,
  completed: true,
  parts: [{
    kind: "tool",
    id: `${id}:tool`,
    tool: {
      id: `${id}:tool`,
      title,
      detail: "",
      status: "success",
      input: JSON.stringify(input),
      inputValue: input,
      ...(metadata ? { metadata } : {})
    }
  }]
});

const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: "Untitled",
  directory: "/repo",
  updatedAt: 100,
  ...overrides
});

const events: Array<[string, TranscriptItem, string]> = [
  ["shell", { kind: "shell", id: "event", shellID: "shell", command: "pwd", status: "exited", exit: 0 }, "ShellMessage"],
  ["compaction", { kind: "compaction", id: "event", status: "completed", reason: "auto", summary: "summary" }, "Compaction"],
  ["synthetic", { kind: "synthetic", id: "event", text: "visible synthetic" }, "SessionEvent"],
  ["skill", { kind: "skill", id: "event", skill: "review", name: "Review", text: "loaded" }, "SessionEvent"],
  ["status", { kind: "status", id: "event", text: "working", tone: "info" }, "StatusNote"],
  ["divider", { kind: "divider", id: "event" }, "TurnDivider"]
];

describe("OpenCodeTimeline chronology", () => {
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
    storeState.stageRevert.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders completed reasoning as a collapsed Thought row with its first line", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[reasoningAssistant(true)]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelector("[data-slot='reasoning-part-title']")?.textContent).toBe("Thought");
    expect(container.querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("Inspecting the code");
    expect(container.querySelector("[data-slot='reasoning-part-content']")).toBeNull();
  });

  it("keeps live reasoning collapsed and follows its latest line", () => {
    const live = reasoningAssistant(false) as Extract<TranscriptItem, { kind: "assistant" }>;
    live.parts = [{ kind: "reasoning", id: "reasoning-1", text: "Inspecting the code\nChecking events", complete: false }];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[live]}
        busy
        lastAssistantId="assistant-reasoning"
      />
    ));

    expect(container.querySelector("[data-slot='reasoning-part-title'] [data-component='text-shimmer']")?.getAttribute("aria-label")).toBe("Thinking");
    expect(container.querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("Checking events");
    expect(container.querySelector("[data-slot='reasoning-part-content']")).toBeNull();
  });

  it("keeps the live reasoning preview on the newest streamed text", () => {
    const live = reasoningAssistant(false) as Extract<TranscriptItem, { kind: "assistant" }>;
    live.parts = [{ kind: "reasoning", id: "reasoning-1", text: "**Inspecting the repository structure and current events**", complete: false }];
    act(() => root.render(
      <OpenCodeTimeline transcript={[live]} busy lastAssistantId="assistant-reasoning" />
    ));

    const first = container.querySelector("[data-slot='reasoning-part-summary']");
    expect(first?.textContent).toBe("Inspecting the repository structure and current events");
    expect(first?.getAttribute("data-follow-end")).toBe("true");
    expect(container.querySelector("[data-component='reasoning-part']")?.getAttribute("data-state")).toBe("running");

    live.parts = [{ kind: "reasoning", id: "reasoning-1", text: "Earlier thought\n**Checking the latest streamed event now**", complete: false }];
    act(() => root.render(
      <OpenCodeTimeline transcript={[{ ...live }]} busy lastAssistantId="assistant-reasoning" />
    ));

    expect(container.querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("Checking the latest streamed event now");
  });

  it("does not manufacture token streaming for a one-shot reasoning chunk", () => {
    const live = reasoningAssistant(false) as Extract<TranscriptItem, { kind: "assistant" }>;
    live.parts = [{ kind: "reasoning", id: "reasoning-1", text: "Inspecting plans and lessons", complete: true }];
    act(() => root.render(
      <OpenCodeTimeline transcript={[live]} busy lastAssistantId="assistant-reasoning" />
    ));

    const summary = container.querySelector("[data-slot='reasoning-part-summary']");
    expect(summary?.textContent).toBe("Inspecting plans and lessons");
    expect(container.querySelector("[data-component='reasoning-part']")?.getAttribute("data-state")).toBe("ok");
  });

  it("opens absolute read paths relative to the tool session workspace", () => {
    const session: SessionInfo = {
      id: "session-read",
      directory: "/repo",
      workspace: { id: "workspace-read", generation: 4 }
    };
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[toolAssistant("read", "read", { filePath: "/repo/docs/README.md" })]}
        busy={false}
        lastAssistantId={null}
        session={session}
      />
    ));

    const subtitle = container.querySelector("[data-slot='basic-tool-tool-subtitle']") as HTMLElement | null;
    act(() => subtitle?.click());

    expect(storeState.focusSession).toHaveBeenCalledWith("session-read");
    expect(storeState.openFile).toHaveBeenCalledWith("docs/README.md", undefined, session.workspace);
  });

  it("renders one inline working item while the first stream item is pending", () => {
    act(() => root.render(
      <OpenCodeTimeline transcript={[]} busy lastAssistantId={null} statusText="preparing response" />
    ));

    const working = container.querySelector("[data-component='inline-working']");
    expect(working?.getAttribute("role")).toBe("status");
    expect(working?.querySelector("[data-component='text-shimmer']")?.getAttribute("aria-label")).toBe("Preparing response");
    expect(container.querySelector("[data-component='live-activity-dock']")).toBeNull();
  });

  it("replaces the inline placeholder with the real stream item instead of duplicating it", () => {
    const live = reasoningAssistant(false) as Extract<TranscriptItem, { kind: "assistant" }>;
    live.parts = [{ kind: "reasoning", id: "reasoning-live", text: "Inspecting the lesson", complete: false }];

    act(() => root.render(
      <OpenCodeTimeline transcript={[live]} busy lastAssistantId={live.id} statusText="thinking" />
    ));

    expect(container.querySelector("[data-component='reasoning-part']")).not.toBeNull();
    expect(container.querySelector("[data-component='inline-working']")).toBeNull();
    expect(container.querySelector("[data-component='live-activity-dock']")).toBeNull();
  });

  it("renders reasoning blocks independently in their assistant node", () => {
    const transcript: TranscriptItem[] = [{
      kind: "assistant",
      id: "assistant-reasoning",
      messageID: "assistant-reasoning",
      completed: true,
      parts: [
        { kind: "reasoning", id: "reasoning-1", text: "Inspecting the code", complete: true },
        { kind: "reasoning", id: "reasoning-2", text: "Inspecting the code", complete: true },
        { kind: "reasoning", id: "reasoning-3", text: "Planning the fix", complete: true }
      ]
    }];
    act(() => root.render(<OpenCodeTimeline transcript={transcript} busy={false} lastAssistantId={null} />));

    const thoughts = container.querySelectorAll("[data-component='reasoning-part']");
    expect(thoughts).toHaveLength(3);
    expect(Array.from(thoughts, (thought) => thought.querySelector("[data-slot='reasoning-part-summary']")?.textContent)).toEqual([
      "Inspecting the code",
      "Inspecting the code",
      "Planning the fix"
    ]);
  });

  it("keeps assistant steps as stable keyed nodes while their own reasoning changes", () => {
    const first: TranscriptItem = {
      kind: "assistant",
      id: "assistant-reasoning",
      messageID: "assistant-reasoning",
      completed: false,
      parts: [
        { kind: "reasoning", id: "reasoning-1", text: "Before", complete: true },
        ...((toolAssistant("tool", "bash", { command: "pwd" }) as Extract<TranscriptItem, { kind: "assistant" }>).parts)
      ]
    };
    const second: TranscriptItem = {
      kind: "assistant",
      id: "assistant-commentary",
      messageID: "assistant-commentary",
      completed: false,
      parts: [{ kind: "reasoning", id: "commentary-1", text: "After", complete: false }]
    };
    act(() => root.render(<OpenCodeTimeline transcript={[first, second]} busy lastAssistantId="assistant-commentary" />));

    const thoughts = container.querySelectorAll("[data-component='reasoning-part']");
    const thought = thoughts[1];
    expect(thoughts).toHaveLength(2);
    expect(thought.querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("After");

    const latest = {
      ...second,
      parts: [{ kind: "reasoning" as const, id: "commentary-1", text: "After\nLatest", complete: false }]
    };
    act(() => root.render(<OpenCodeTimeline transcript={[first, latest]} busy lastAssistantId="assistant-commentary" />));

    const updatedThoughts = container.querySelectorAll("[data-component='reasoning-part']");
    expect(updatedThoughts[1]).toBe(thought);
    expect(updatedThoughts[1].querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("Latest");
  });

  it("keeps reasoning at its chronological node instead of moving it to a synthetic footer", () => {
    const live = assistant("assistant-live") as Extract<TranscriptItem, { kind: "assistant" }>;
    live.completed = false;
    live.parts = [
      { kind: "reasoning", id: "reasoning-live", text: "Inspecting", complete: false },
      { kind: "text", id: "text-live", text: "Growing answer", complete: false }
    ];
    const shell: TranscriptItem = { kind: "shell", id: "shell-live", shellID: "shell-live", command: "pwd", status: "running" };
    act(() => root.render(
      <OpenCodeTimeline transcript={[live, shell]} busy lastAssistantId="assistant-live" />
    ));

    const list = container.querySelector("[data-slot='session-turn-list']")!;
    const thought = container.querySelector("[data-component='reasoning-part']");
    expect(list.firstElementChild?.querySelector("[data-component='reasoning-part']")).toBe(thought);
    expect(container.querySelector("[data-component='turn-status']")).toBeNull();

    live.parts = [
      { kind: "reasoning", id: "reasoning-live", text: "Inspecting\nComparing", complete: false },
      { kind: "text", id: "text-live", text: "Growing answer with another streamed paragraph", complete: false }
    ];
    act(() => root.render(
      <OpenCodeTimeline transcript={[{ ...live }, shell]} busy lastAssistantId="assistant-live" />
    ));

    expect(container.querySelector("[data-component='reasoning-part']")).toBe(thought);
    expect(list.firstElementChild?.querySelector("[data-component='reasoning-part']")).toBe(thought);
    expect(container.querySelector("[data-slot='reasoning-part-summary']")?.textContent).toBe("Inspecting");
  });

  it("marks reasoning as running only when it is the streaming tail block", () => {
    const live = reasoningAssistant(false) as Extract<TranscriptItem, { kind: "assistant" }>;
    live.parts = [
      { kind: "reasoning", id: "reasoning-1", text: "Inspecting", complete: false },
      { kind: "text", id: "text-1", text: "Visible update", complete: false }
    ];
    act(() => root.render(<OpenCodeTimeline transcript={[live]} busy lastAssistantId="assistant-reasoning" />));

    expect(container.querySelector("[data-component='reasoning-part']")?.getAttribute("data-state")).toBe("ok");
    expect(container.querySelector("[data-component='markdown']")?.textContent).toBe("Visible update");
  });

  it("renders native text updates immediately without a client-side typewriter queue", () => {
    const live = assistant("assistant-live") as Extract<TranscriptItem, { kind: "assistant" }>;
    live.completed = false;
    live.parts = [{ kind: "text", id: "text-live", text: "Start", complete: false }];
    act(() => root.render(<OpenCodeTimeline transcript={[live]} busy lastAssistantId="assistant-live" />));

    const update = `Start ${"streamed content ".repeat(80)}`;
    live.parts = [{ kind: "text", id: "text-live", text: update, complete: false }];
    act(() => root.render(<OpenCodeTimeline transcript={[{ ...live }]} busy lastAssistantId="assistant-live" />));

    expect(container.querySelector("[data-component='markdown']")?.textContent).toBe(update.trim());
  });

  it("hides arbitrary generic tool arguments and exposes long details as a tooltip", () => {
    const generic = toolAssistant("tool", "tool", { limit: 40, content: "private" }) as Extract<TranscriptItem, { kind: "assistant" }>;
    const transcript: TranscriptItem[] = [{
      ...generic,
      parts: [{
        kind: "tool",
        id: "tool:part",
        tool: { id: "tool:part", title: "tool", detail: "a very long diagnostic detail", status: "success", input: JSON.stringify({ limit: 40, content: "private" }) }
      }]
    }];
    act(() => root.render(<OpenCodeTimeline transcript={transcript} busy={false} lastAssistantId={null} />));

    expect(container.querySelector("[data-slot='basic-tool-tool-title']")?.textContent).toBe("Tool call");
    expect(container.textContent).not.toContain("limit=40");
    expect(container.textContent).not.toContain("content=private");
    expect(container.querySelector("[data-slot='basic-tool-tool-subtitle']")?.getAttribute("title")).toBe("a very long diagnostic detail");
  });

  it("shows tool input and output in an expandable disclosure", () => {
    const generic = toolAssistant("tool", "custom_tool", { query: "stream events" }) as Extract<TranscriptItem, { kind: "assistant" }>;
    generic.parts[0] = generic.parts[0].kind === "tool"
      ? { ...generic.parts[0], tool: { ...generic.parts[0].tool, output: "event payload" } }
      : generic.parts[0];
    act(() => root.render(<OpenCodeTimeline transcript={[generic]} busy={false} lastAssistantId={null} />));

    act(() => container.querySelector<HTMLButtonElement>("[data-slot='collapsible-trigger']")!.click());
    expect([...container.querySelectorAll("[data-slot='tool-io-label']")].map((node) => node.textContent)).toEqual(["IN", "OUT"]);
    expect(container.querySelector("[data-component='tool-io']")?.textContent).toContain("stream events");
    expect(container.querySelector("[data-component='tool-io']")?.textContent).toContain("event payload");
  });

  it("automatically reveals live command output and keeps explicit state visible", async () => {
    const running = toolAssistant("tool", "bash", { command: "npm test" }) as Extract<TranscriptItem, { kind: "assistant" }>;
    running.completed = false;
    const part = running.parts[0];
    if (part.kind === "tool") {
      part.tool.status = "running";
      part.tool.output = "RUN  v3.2.7";
    }

    await act(async () => root.render(<OpenCodeTimeline transcript={[running]} busy lastAssistantId="tool" />));

    expect(container.querySelector("[data-slot='tool-state']")?.textContent).toContain("Running");
    expect(container.querySelector("[data-slot='collapsible-content']")).not.toBeNull();
    expect([...container.querySelectorAll("[data-slot='tool-io-label']")].map((node) => node.textContent)).toEqual(["COMMAND", "OUTPUT"]);
    expect(container.querySelector("[data-slot='tool-io-text']")?.textContent).toBe(JSON.stringify({ command: "npm test" }, null, 2));
  });

  it("keeps failed calls compact while surfacing their error inline", () => {
    const failed = toolAssistant("tool", "tool", { path: "/repo/source b", limit: 2000 }) as Extract<TranscriptItem, { kind: "assistant" }>;
    const part = failed.parts[0];
    if (part.kind === "tool") {
      part.tool.status = "failed";
      part.tool.output = "File not found: /repo/source b";
    }

    act(() => root.render(<OpenCodeTimeline transcript={[failed]} busy={false} lastAssistantId={null} />));

    expect(container.querySelector("[data-slot='basic-tool-tool-title']")?.textContent).toBe("Inspect");
    expect(container.querySelector("[data-slot='tool-state']")?.textContent).toContain("Failed");
    expect(container.querySelector("[data-slot='tool-error-summary']")?.textContent).toBe("File not found: /repo/source b");
    expect(container.querySelector("[data-slot='collapsible-content']")).toBeNull();
  });

  it.each(events)("keeps an interleaved %s event between assistant runs", (_name, event, row) => {
    act(() => root.render(
      <OpenCodeTimeline transcript={[assistant("before"), event, assistant("after")]} busy={false} lastAssistantId={null} />
    ));

    expect([...container.querySelectorAll("[data-timeline-row]")].map((node) => node.getAttribute("data-timeline-row")))
      .toEqual(["AssistantMessage", row, "AssistantMessage"]);
  });

  it("groups only contiguous assistant messages", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[assistant("one"), assistant("two"), events[4][1], assistant("three"), assistant("four")]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const rowText = (node: Element): string | null => {
      const clone = node.cloneNode(true) as Element;
      clone.querySelectorAll("[data-slot='assistant-message-head']").forEach((head) => head.remove());
      return clone.textContent;
    };

    expect([...container.querySelectorAll("[data-timeline-row]")].map(rowText))
      .toEqual(["one", "two", "working", "three", "four"]);
  });

  it("shows the Orbit name head for the first prose group and after activity", () => {
    const message: TranscriptItem = {
      kind: "assistant",
      id: "a1",
      messageID: "a1",
      completed: true,
      parts: [
        { kind: "text", id: "t1", text: "intro", complete: true },
        { kind: "tool", id: "tool1", tool: { id: "tool1", title: "read", detail: "", status: "success", input: "{}", inputValue: {} } },
        { kind: "text", id: "t2", text: "outro", complete: true }
      ]
    };
    act(() => root.render(<OpenCodeTimeline transcript={[message]} busy={false} lastAssistantId={null} />));

    const heads = [...container.querySelectorAll("[data-slot='assistant-message-head']")];
    expect(heads).toHaveLength(2);
    expect(heads.every((head) => head.textContent === "Orbit")).toBe(true);
    expect(heads[0]?.querySelector("[data-slot='assistant-avatar']")).not.toBeNull();
  });

  it("renders status notes as quiet inline markers, not boxes", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{ kind: "status", id: "event", text: "Interrupted", tone: "info" }]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const note = container.querySelector("[data-component='session-note']");
    expect(note?.getAttribute("data-tone")).toBe("info");
    expect(note?.querySelector(".codicon-info")).toBeTruthy();
    expect(note?.querySelector("[data-slot='session-note-text']")?.textContent).toBe("Interrupted");
  });

  it("summarizes contiguous completed exploration while retaining expandable call details", () => {
    const read = toolAssistant("read", "read", { filePath: "/repo/src/main.ts" }) as Extract<TranscriptItem, { kind: "assistant" }>;
    const grep = toolAssistant("grep", "grep", { pattern: "stream", path: "/repo/src" }) as Extract<TranscriptItem, { kind: "assistant" }>;
    const transcript: TranscriptItem[] = [{ ...read, parts: [...read.parts, ...grep.parts] }];
    act(() => root.render(<OpenCodeTimeline transcript={transcript} busy={false} lastAssistantId={null} />));

    expect(container.querySelector("[data-slot='context-tool-title']")?.textContent).toBe("Explored 2 items");
    expect(container.querySelector("[data-slot='context-tool-preview']")?.textContent).toContain("main.ts");
    expect(container.querySelector("[data-slot='context-tool-list']")).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>("[data-slot='context-tool-trigger']")!.click());

    const titles = [...container.querySelectorAll("[data-slot='basic-tool-tool-title']")].map((node) => node.textContent);
    expect(titles).toEqual(["Read", "Grep"]);
  });

  it("infers an inspect call and target from a generic path-shaped tool record", () => {
    const generic = toolAssistant("tool", "tool", { path: "/repo/source b", limit: 2000 }) as Extract<TranscriptItem, { kind: "assistant" }>;
    act(() => root.render(<OpenCodeTimeline transcript={[generic]} busy={false} lastAssistantId={null} />));

    expect(container.querySelector("[data-slot='basic-tool-tool-title']")?.textContent).toBe("Inspect");
    expect(container.querySelector("[data-slot='basic-tool-tool-subtitle']")?.textContent).toBe("/repo/source b");
  });
});

describe("completed assistant layout", () => {
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
    storeState.stageRevert.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders one row per group with no phantom action rows between assistant messages", () => {
    const session = { id: "session-1", workspace: "/repo", directory: "/repo" } as unknown as SessionInfo;
    const transcript: TranscriptItem[] = [
      {
        kind: "assistant",
        id: "a1",
        messageID: "a1",
        completed: true,
        parts: [
          { kind: "reasoning", id: "r1", text: "thinking", complete: true },
          { kind: "tool", id: "t1", tool: { id: "t1", title: "read", detail: "README.md", status: "success", input: "{}", inputValue: {} } }
        ]
      },
      {
        kind: "assistant",
        id: "a2",
        messageID: "a2",
        completed: true,
        parts: [{ kind: "text", id: "p1", text: "Answer", complete: true }]
      }
    ];
    act(() => root.render(<OpenCodeTimeline transcript={transcript} busy={false} lastAssistantId={null} session={session} />));

    const rows = Array.from(container.querySelectorAll("[data-timeline-row]")).map((row) => row.getAttribute("data-timeline-row"));
    expect(rows).toEqual(["AssistantActivity", "AssistantMessage"]);

    const actions = container.querySelector("[data-component='turn-actions']");
    expect(actions).toBeNull();
    const options = container.querySelector("[data-component='response-options']");
    expect(options).not.toBeNull();
    const activityRow = container.querySelector("[data-timeline-row='AssistantActivity']");
    expect(options?.parentElement).toBe(activityRow?.querySelector("[data-component='assistant-options-footer']"));
  });

  it("reveals copy and revert actions from the response options button", () => {
    const session: SessionInfo = {
      id: "session-1",
      directory: "/repo",
      workspace: { id: "workspace-1", generation: 1 }
    };
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{
          kind: "assistant",
          id: "assistant-1",
          messageID: "assistant-1",
          completed: true,
          parts: [{ kind: "text", id: "text-1", text: "Answer", complete: true }]
        }]}
        busy={false}
        lastAssistantId={null}
        session={session}
      />
    ));

    expect(container.querySelector("[data-slot='text-part-copy-button']")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>("[data-slot='response-options-button']");
    expect(button?.getAttribute("aria-expanded")).toBe("false");

    act(() => button?.click());

    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect([...container.querySelectorAll("[data-slot='response-options-item']")].map((item) => item.textContent?.trim()))
      .toEqual(["Copy response", "Revert from here"]);

    act(() => container.querySelectorAll<HTMLButtonElement>("[data-slot='response-options-item']")[1]?.click());
    expect(storeState.stageRevert).toHaveBeenCalledWith(session.workspace, "assistant-1");
  });
});

describe("subagent dispatch links", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    storeState.agents = [{ id: "build", name: "Build" }];
    storeState.sessions = [];
    storeState.session = { id: "session-parent", directory: "/repo", workspace: { id: "workspace-1", generation: 1 } };
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

  it("renders a task tool card that opens the resolved child session", () => {
    storeState.sessions = [summary("session-child", {
      title: "Run the tests",
      agent: "build",
      parentID: "session-parent",
      updatedAt: 200
    })];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[toolAssistant("assistant-1", "subagent", { agent: "build", description: "Run the tests", prompt: "run them" })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const card = container.querySelector("[data-component='task-tool-card']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Run the tests");
    expect(card?.textContent).toContain("@build");

    const surface = card?.querySelector("[data-component='task-tool-surface']") as HTMLButtonElement | null;
    expect(surface?.disabled).toBe(false);
    act(() => surface?.click());
    expect(storeState.reopenSession).toHaveBeenCalledWith("session-child");
  });

  it("resolves the task tool fallback by description and agent when metadata is absent", () => {
    storeState.sessions = [
      summary("session-other", { title: "Review docs", agent: "plan", parentID: "session-parent", updatedAt: 300 }),
      summary("session-child", { title: "Run the tests", agent: "build", parentID: "session-parent", updatedAt: 200 })
    ];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[toolAssistant("assistant-1", "task", { subagent_type: "build", description: "Run the tests" })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const surface = container.querySelector("[data-component='task-tool-surface']") as HTMLButtonElement | null;
    expect(surface?.disabled).toBe(false);
    act(() => surface?.click());
    expect(storeState.reopenSession).toHaveBeenCalledWith("session-child");
  });

  it("disables the task tool card when no child session resolves", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[toolAssistant("assistant-1", "subagent", { agent: "build", description: "Run the tests" })]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const surface = container.querySelector("[data-component='task-tool-surface']") as HTMLButtonElement | null;
    expect(surface?.disabled).toBe(true);
  });

  it("turns a subagent synthetic tag into a clickable link to the child session", () => {
    storeState.sessions = [summary("session-child", {
      title: "Run the tests",
      agent: "build",
      parentID: "session-parent",
      updatedAt: 200
    })];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{
          kind: "synthetic",
          id: "synthetic-1",
          text: '<subagent id="session-child" state="completed" description="Run the tests">\n</subagent>',
          description: "Run the tests"
        }]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.textContent).not.toContain("<subagent");
    const card = container.querySelector("[data-component='subagent-link-card']");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-state")).toBe("completed");
    expect(card?.textContent).toContain("Run the tests");
    expect(card?.textContent).toContain("@build");

    const surface = card?.querySelector("[data-component='subagent-link-surface']") as HTMLButtonElement | null;
    expect(surface?.disabled).toBe(false);
    act(() => surface?.click());
    expect(storeState.reopenSession).toHaveBeenCalledWith("session-child");
  });

  it("opens the child by id from a subagent synthetic tag even when the sessions list is stale", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{
          kind: "synthetic",
          id: "synthetic-1",
          text: '<subagent id="session-child" state="running" description="Run the tests">\n</subagent>',
          description: "Run the tests"
        }]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const surface = container.querySelector("[data-component='subagent-link-surface']") as HTMLButtonElement | null;
    expect(surface?.disabled).toBe(false);
    act(() => surface?.click());
    expect(storeState.reopenSession).toHaveBeenCalledWith("session-child");
  });

  it("collapses tool and synthetic records for one child into one descriptive card", () => {
    storeState.sessions = [summary("session-child", {
      title: "Inspect the renderer",
      agent: "build",
      parentID: "session-parent"
    })];
    const synthetic: TranscriptItem = {
      kind: "synthetic",
      id: "dispatch-child",
      text: '<subagent id="session-child" agent="build" description="Inspect the renderer" state="completed" />'
    };
    const dispatch = toolAssistant(
      "assistant-1",
      "subagent",
      { agent: "build", description: "Inspect the renderer" },
      { sessionID: "session-child" }
    ) as Extract<TranscriptItem, { kind: "assistant" }>;
    const dispatchPart = dispatch.parts[0];
    if (dispatchPart?.kind === "tool") dispatchPart.tool.status = "running";
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[
          dispatch,
          synthetic
        ]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelectorAll("[data-component='task-tool-card'], [data-component='subagent-link-card']")).toHaveLength(1);
    expect(container.querySelector("[data-component='task-tool-kind']")?.textContent).toBe("Delegated agent");
    expect(container.querySelector("[data-slot='delegated-agent-content']")).not.toBeNull();
    expect(container.querySelector("[data-slot='delegated-agent-tail']")).not.toBeNull();
    expect(container.querySelector("[data-slot='task-tool-status-label']")?.textContent).toBe("Complete");
    expect(container.querySelector("[data-component='task-tool-spinner']")).toBeNull();
    expect(container.querySelector("[data-slot='basic-tool-tool-subtitle']")).toBeNull();
    expect(container.querySelector("[data-component='task-tool-surface']")?.getAttribute("aria-label"))
      .toBe("Open delegated agent session: Inspect the renderer");
  });

  it("consolidates repeated tool snapshots for one child into one stable card", () => {
    storeState.sessions = [summary("session-child", {
      title: "Inspect the renderer",
      agent: "build",
      parentID: "session-parent"
    })];
    const first = toolAssistant("assistant-1", "subagent", { agent: "build", description: "Inspect the renderer" }, { sessionID: "session-child" });
    act(() => root.render(
      <OpenCodeTimeline transcript={[first]} busy lastAssistantId="assistant-1" />
    ));
    const initialCard = container.querySelector("[data-component='task-tool-card']");

    act(() => root.render(
      <OpenCodeTimeline
        transcript={[
          first,
          toolAssistant("assistant-2", "subagent", { agent: "build", description: "Inspect the renderer" }, { sessionID: "session-child" }),
          toolAssistant("assistant-3", "task", { agent: "build", description: "Inspect the renderer" }, { sessionID: "session-child" })
        ]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelectorAll("[data-component='task-tool-card']")).toHaveLength(1);
    expect(container.querySelector("[data-component='task-tool-card']")).toBe(initialCard);
    expect(container.querySelector("[data-component='task-tool-title']")?.textContent).toBe("Inspect the renderer");
  });

  it("keeps one dispatch card while the child session graph is still arriving", () => {
    storeState.sessions = [];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[
          toolAssistant("assistant-1", "subagent", { agent: "build", description: "Inspect the renderer" }),
          {
            kind: "synthetic",
            id: "dispatch-child",
            text: '<subagent id="session-child" agent="build" description="Inspect the renderer" state="running" />'
          }
        ]}
        busy
        lastAssistantId="assistant-1"
      />
    ));

    expect(container.querySelectorAll("[data-component='task-tool-card'], [data-component='subagent-link-card']")).toHaveLength(1);
    expect(container.querySelector("[data-component='task-tool-card']")).not.toBeNull();
  });

  it("keeps deliberate matching dispatches from separate user turns", () => {
    storeState.sessions = [];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[
          { kind: "user", id: "user-1", text: "Inspect it" },
          toolAssistant("assistant-1", "subagent", { agent: "build", description: "Inspect the renderer" }),
          { kind: "user", id: "user-2", text: "Inspect it again" },
          toolAssistant("assistant-2", "subagent", { agent: "build", description: "Inspect the renderer" })
        ]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelectorAll("[data-component='task-tool-card']")).toHaveLength(2);
  });

  it("keeps cards for distinct child sessions separate", () => {
    storeState.sessions = [
      summary("session-child-a", { title: "First task", parentID: "session-parent" }),
      summary("session-child-b", { title: "Second task", parentID: "session-parent" })
    ];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[
          toolAssistant("assistant-1", "subagent", { description: "First task" }, { sessionID: "session-child-a" }),
          { kind: "synthetic", id: "dispatch-b", text: '<subagent id="session-child-b" description="Second task" state="running" />' }
        ]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelectorAll("[data-component='task-tool-card'], [data-component='subagent-link-card']")).toHaveLength(2);
  });

  it("resolves legacy agent=/prompt= synthetic input to the matching child session", () => {
    storeState.sessions = [summary("session-child", {
      title: "Run the tests",
      agent: "build",
      parentID: "session-parent",
      updatedAt: 200
    })];
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{
          kind: "synthetic",
          id: "synthetic-1",
          text: "agent=build\nprompt=Run the test suite and report failures"
        }]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    const card = container.querySelector("[data-component='subagent-link-card']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Run the tests");
    const surface = card?.querySelector("[data-component='subagent-link-surface']") as HTMLButtonElement | null;
    act(() => surface?.click());
    expect(storeState.reopenSession).toHaveBeenCalledWith("session-child");
  });

  it("leaves synthetic text alone when it is not a subagent dispatch", () => {
    act(() => root.render(
      <OpenCodeTimeline
        transcript={[{ kind: "synthetic", id: "synthetic-1", text: "plain system note", description: "Note" }]}
        busy={false}
        lastAssistantId={null}
      />
    ));

    expect(container.querySelector("[data-component='subagent-link-card']")).toBeNull();
    expect(container.querySelector("[data-component='session-message']")).not.toBeNull();
  });
});
