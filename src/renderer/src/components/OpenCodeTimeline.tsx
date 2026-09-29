import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../store";
import type { ToolCallView, TranscriptItem, SessionSummary, SessionInfo } from "@shared/types";
import { ExternalLink } from "./ExternalLink";
import { TextShimmer } from "./TextShimmer";
import { ToolStatusTitle } from "./ToolStatusTitle";
import { AnimatedCountList, type CountItem } from "./ToolCountSummary";
import { OpenCodeMarkdown as Markdown } from "./OpenCodeMarkdown";
import { OpenCodeIcon } from "./OpenCodeIcon";
import { mountTooltip } from "../opencode-markdown/tooltip";
import { animate } from "motion";
import { OpenCodeFile } from "./OpenCodeFile";
import { OpenCodeFileIcon } from "./OpenCodeFileIcon";
import { OpenCodeSpecialTool, isDismissedOpenCodeQuestion, openCodeSpecialToolTitle } from "./OpenCodeSpecialTool";
import { resolveOpenCodeTaskAgent } from "../opencode-task-agent";
import stripAnsi from "strip-ansi";

const OUTPUT_LIMIT = 6000;

async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  return clipboard.writeText(text).then(() => true, () => false);
}

function ShellSubmessage({ text, animate: reveal }: { text: string; animate: boolean }): ReactNode {
  const width = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!reveal) return;
    const animations: Array<ReturnType<typeof animate>> = [];
    const frame = requestAnimationFrame(() => {
      if (width.current) animations.push(animate(width.current, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 }));
      if (value.current) animations.push(animate(value.current, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] }));
    });
    return () => { cancelAnimationFrame(frame); animations.forEach((animation) => animation.stop()); };
  }, []);
  return <span data-component="shell-submessage" dir="ltr"><span ref={width} data-slot="shell-submessage-width" style={reveal ? { width: "0px" } : undefined}>
    <span data-slot="basic-tool-tool-subtitle"><span ref={value} data-slot="shell-submessage-value" style={reveal ? { opacity: 0, filter: "blur(2px)" } : undefined}>{text}</span></span>
  </span></span>;
}

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type AssistantPart = AssistantItem["parts"][number];
type VisibleTimelineItem = Exclude<TranscriptItem, { kind: "permission" | "pending-input" | "selection" | "system" }>;

function isInternalSystemReminder(item: Extract<TranscriptItem, { kind: "synthetic" }>): boolean {
  return /<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder>/i.test(item.text);
}

const TEXT_RENDER_PACE_MS = 24;
const TEXT_RENDER_IMMEDIATE = 512;
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/;

function nextPacedEnd(text: string, start: number): number {
  const remaining = text.length - start;
  const step = remaining <= 12 ? 2 : remaining <= 48 ? 4 : remaining <= 96 ? 8 : Math.min(256, Math.ceil(remaining / 4));
  const end = Math.min(text.length, start + step);
  const max = Math.min(text.length, end + 8);
  for (let index = end; index < max; index += 1) {
    if (TEXT_RENDER_SNAP.test(text[index] ?? "")) return index + 1;
  }
  return end;
}

function PacedMarkdown({ text, streaming, cacheKey }: { text: string; streaming: boolean; cacheKey: string }): ReactNode {
  const [visible, setVisible] = useState(text);
  const shown = useRef(text);
  const latest = useRef({ text, streaming });
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latest.current = { text, streaming };

  const sync = (value: string): void => {
    shown.current = value;
    setVisible(value);
  };
  const clear = (): void => {
    if (timeout.current === undefined) return;
    clearTimeout(timeout.current);
    timeout.current = undefined;
  };
  const run = (): void => {
    timeout.current = undefined;
    const current = latest.current;
    if (!current.streaming || !current.text.startsWith(shown.current) || current.text.length <= shown.current.length
      || current.text.length - shown.current.length <= TEXT_RENDER_IMMEDIATE) {
      sync(current.text);
      return;
    }
    const end = nextPacedEnd(current.text, shown.current.length);
    sync(current.text.slice(0, end));
    if (end < current.text.length) timeout.current = setTimeout(run, TEXT_RENDER_PACE_MS);
  };

  useLayoutEffect(() => {
    if (!streaming || !text.startsWith(shown.current) || text.length <= shown.current.length
      || text.length - shown.current.length <= TEXT_RENDER_IMMEDIATE) {
      clear();
      sync(text);
      return;
    }
    if (timeout.current === undefined) timeout.current = setTimeout(run, TEXT_RENDER_PACE_MS);
  }, [text, streaming]);

  useEffect(() => () => clear(), []);
  return <Markdown text={visible} streaming={streaming} cacheKey={cacheKey} />;
}

function CopyResponse({ text, target = "response" }: { text: string; target?: "response" | "message" }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!text) return;
    if (!await writeClipboard(text)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const label = copied ? "Copied" : `Copy ${target}`;
  return (
    <div data-component="tooltip-v2-trigger" data-tooltip={label}>
    <button data-component="icon-button-v2" data-size="normal" data-variant="ghost-muted"
      data-slot={target === "message" ? "user-message-copy-button" : "text-part-copy-button"}
      aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={() => void copy()}>
      <OpenCodeIcon name={copied ? "check" : "outline-copy"} />
    </button>
    </div>
  );
}

function TextPart({ part, streaming, showCopy, message, duration }: {
  part: Extract<AssistantPart, { kind: "text" }>;
  streaming: boolean;
  showCopy: boolean;
  message: AssistantItem;
  duration?: number;
}): ReactNode {
  const { models } = useStore();
  const text = part.text.trim();
  if (!text) return null;
  const model = models?.find((model) => model.id === message.model?.id && model.providerID === message.model?.providerID)?.name ?? message.model?.id;
  const elapsed = duration ?? (message.completedAt !== undefined && message.createdAt !== undefined ? message.completedAt - message.createdAt : undefined);
  const seconds = elapsed !== undefined && elapsed >= 0 ? Math.round(elapsed / 1000) : undefined;
  const time = seconds === undefined ? "" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const meta = [message.agent && message.agent[0].toUpperCase() + message.agent.slice(1), model, time, message.interrupted && "Interrupted"].filter(Boolean).join(" · ");
  return (
    <div data-component="text-part" data-timeline-part-id={part.id}>
      <div data-slot="text-part-body"><PacedMarkdown text={text} streaming={streaming} cacheKey={`${message.id}:${part.id}`} /></div>
      {showCopy && (
        <div data-slot="text-part-copy-wrapper" data-interrupted={message.interrupted ? "" : undefined}>
          <CopyResponse text={part.text} />
          {meta && <span data-slot="text-part-meta" className="text-12-regular text-text-weak">{meta}</span>}
        </div>
      )}
    </div>
  );
}

function parseInput(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    const partial: Record<string, string> = {};
    for (const field of ["command", "filePath", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
      const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(value);
      if (!match) continue;
      partial[field] = match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return partial;
  }
}

function fileName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(/[\\/]/).pop() ?? value;
}

// OpenCode's `getDirectory` + `relativizeProjectPath`: the parent directory of a tool path
// (trailing slash kept), stripped of the session workspace prefix when it sits underneath it.
function contextDirectory(path: string | undefined, session: SessionInfo | null): string {
  const raw = path && path.length > 0 ? path : "/";
  const trimmed = raw.replace(/[/\\]+$/, "");
  const directory = `${trimmed.split(/[\\/]/).slice(0, -1).join("/")}/`;
  if (!session) return directory;
  const workspace = session.directory.replace(/\\/g, "/").replace(/\/$/, "");
  if (workspace === "/") return directory;
  return directory.startsWith(`${workspace}/`) ? directory.slice(workspace.length) : directory;
}

function workspaceFilePath(path: string, session: SessionInfo | null): string | null {
  const normalizedPath = path.replace(/\\/g, "/");
  if (!session) return normalizedPath;
  const directory = session.directory.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalizedPath)) {
    const caseInsensitive = /^[A-Za-z]:\//.test(normalizedPath);
    const comparedPath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const comparedDirectory = caseInsensitive ? directory.toLowerCase() : directory;
    if (!comparedPath.startsWith(`${comparedDirectory}/`)) return null;
    return normalizedPath.slice(directory.length + 1);
  }
  return normalizedPath.replace(/^\.\//, "");
}

function titleCase(value: string): string {
  if (!value) return "Tool";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toolKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z_]/g, "");
}

function toolInput(tool: ToolCallView): Record<string, unknown> {
  if (tool.inputValue && typeof tool.inputValue === "object" && !Array.isArray(tool.inputValue)) {
    return tool.inputValue as Record<string, unknown>;
  }
  return parseInput(tool.input);
}

function effectiveToolKey(tool: ToolCallView): string {
  const explicit = toolKey(tool.title);
  if (!tool.metadata?.deepseek) return explicit || "tool";
  if (explicit && explicit !== "tool") return explicit;
  const input = toolInput(tool);
  if (typeof input.command === "string") return "shell";
  if (typeof input.filePath === "string" || typeof input.file_path === "string") return "read";
  if (typeof input.pattern === "string") return "grep";
  if (typeof input.query === "string") return "search";
  if (typeof input.url === "string") return "webfetch";
  if (typeof input.path === "string") return "inspect";
  if (typeof input.prompt === "string" || typeof input.description === "string") return "task";
  return explicit || "tool";
}

// Context reads are low-signal. Like OpenCode's `isContextGroupTool`, a
// contiguous run of these is folded into one `ContextToolGroup` so a burst of
// exploration never fills the transcript.
const CONTEXT_TOOL_KEYS = new Set(["read", "list", "glob", "grep"]);

function isContextTool(tool: ToolCallView): boolean {
  return CONTEXT_TOOL_KEYS.has(effectiveToolKey(tool));
}

function contextToolArgs(tool: ToolCallView): string[] {
  const name = effectiveToolKey(tool);
  const input = toolInput(tool);
  if (name === "read") {
    const args: string[] = [];
    if (typeof input.offset === "number") args.push(`offset=${input.offset}`);
    if (typeof input.limit === "number") args.push(`limit=${input.limit}`);
    return args;
  }
  if (name === "glob") return typeof input.pattern === "string" ? [`pattern=${input.pattern}`] : [];
  if (name === "grep") {
    const args: string[] = [];
    if (typeof input.pattern === "string") args.push(`pattern=${input.pattern}`);
    if (typeof input.include === "string") args.push(`include=${input.include}`);
    return args;
  }
  return [];
}

function contextToolSummary(tools: ToolCallView[]): { read: number; search: number; list: number } {
  let read = 0;
  let search = 0;
  let list = 0;
  for (const tool of tools) {
    const name = effectiveToolKey(tool);
    if (name === "read") read += 1;
    else if (name === "glob" || name === "grep") search += 1;
    else if (name === "list") list += 1;
  }
  return { read, search, list };
}

interface SubagentRef {
  id: string;
  agent: string;
  description: string;
  state: string;
}

function parseSubagentTag(text: string): SubagentRef | null {
  const match = /<subagent\b([^>]*?)\/?>[\s\S]*?(?:<\/subagent>|$)/i.exec(text);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const attr = (name: string): string => new RegExp(`${name}="([^"]*)"`, "i").exec(attrs)?.[1] ?? "";
  const id = attr("id");
  if (!id) return null;
  return { id, agent: attr("agent"), description: attr("description"), state: attr("state") };
}

function parseLegacyTaskText(text: string): SubagentRef | null {
  const agent = /(?:^|\n)\s*agent\s*=\s*([^\s]+)/i.exec(text)?.[1] ?? "";
  if (!agent) return null;
  const prompt = /(?:^|\n)\s*prompt\s*=\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
  return { id: "", agent, description: prompt, state: "" };
}

function matchChildSession(
  sessions: SessionSummary[],
  parentID: string | undefined,
  criteria: { description?: string; agent?: string }
): string {
  if (!parentID) return "";
  let candidates = sessions.filter((candidate) => candidate.parentID === parentID);
  if (criteria.description) {
    const described = candidates.filter((candidate) => candidate.title.startsWith(criteria.description!));
    if (described.length > 0) candidates = described;
    else if (!criteria.agent) return "";
  }
  if (criteria.agent) {
    const key = criteria.agent.toLowerCase();
    const byAgent = candidates.filter((candidate) =>
      candidate.agent?.toLowerCase() === key || candidate.title.includes(`@${criteria.agent}`)
    );
    if (byAgent.length === 0) return "";
    candidates = byAgent;
  }
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? "";
}

function subagentChildID(ref: SubagentRef, sessions: SessionSummary[], parentID: string | undefined): string {
  if (ref.id) return ref.id;
  return matchChildSession(sessions, parentID, {
    ...(ref.agent ? { agent: ref.agent } : {}),
    ...(ref.description ? { description: ref.description.slice(0, 60) } : {})
  });
}

function taskChildID(tool: ToolCallView, sessions: SessionSummary[], parentID: string | undefined): string {
  const input = parseInput(tool.input);
  const requested = typeof input.agent === "string"
    ? input.agent
    : typeof input.subagent_type === "string"
      ? input.subagent_type
      : "";
  const description = typeof input.description === "string" && input.description
    ? input.description
    : typeof input.prompt === "string"
      ? input.prompt.trim()
      : "";
  const metadataSession = typeof tool.metadata?.sessionId === "string"
    ? tool.metadata.sessionId
    : typeof tool.metadata?.sessionID === "string"
      ? tool.metadata.sessionID
      : "";
  return metadataSession || matchChildSession(sessions, parentID, {
    ...(description ? { description } : {}),
    ...(requested ? { agent: requested } : {})
  });
}

function dispatchSignature(agent: string, description: string): string {
  const normalizedAgent = agent.trim().toLowerCase();
  const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, " ");
  return normalizedAgent || normalizedDescription ? `dispatch:${normalizedAgent}:${normalizedDescription}` : "";
}

function taskDispatchSignature(tool: ToolCallView): string {
  const input = parseInput(tool.input);
  const agent = typeof input.agent === "string"
    ? input.agent
    : typeof input.subagent_type === "string"
      ? input.subagent_type
      : "";
  const description = typeof input.description === "string"
    ? input.description
    : typeof input.prompt === "string"
      ? input.prompt
      : "";
  return dispatchSignature(agent, description);
}

function refDispatchSignature(ref: SubagentRef): string {
  return dispatchSignature(ref.agent, ref.description);
}

function mergeSubagentTool(first: ToolCallView, latest: ToolCallView): ToolCallView {
  return {
    ...first,
    ...latest,
    id: first.id,
    detail: latest.detail || first.detail,
    input: latest.input || first.input,
    inputValue: latest.inputValue ?? first.inputValue,
    output: latest.output ?? first.output,
    paths: latest.paths?.length ? latest.paths : first.paths,
    metadata: { ...first.metadata, ...latest.metadata }
  };
}

function consolidateSubagentTools(
  transcript: TranscriptItem[],
  sessions: SessionSummary[],
  parentID: string | undefined
): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  const represented = new Map<string, { item: AssistantItem; partIndex: number }>();
  for (const entry of transcript) {
    if (entry.kind !== "assistant") {
      if (entry.kind === "user") represented.clear();
      if (entry.kind === "synthetic") {
        const ref = parseSubagentTag(entry.text) ?? parseLegacyTaskText(entry.text);
        if (ref) {
          const childID = subagentChildID(ref, sessions, parentID);
          const key = childID ? `child:${childID}` : refDispatchSignature(ref);
          const previous = represented.get(key);
          const existing = previous?.item.parts[previous.partIndex];
          if (previous && existing?.kind === "tool" && ref.state) {
            const settledState = ref.state.toLowerCase();
            const status = ["failed", "error", "cancelled"].includes(settledState)
              ? "failed"
              : ["complete", "completed", "success"].includes(settledState)
                ? "success"
                : existing.tool.status;
            previous.item.parts[previous.partIndex] = {
              ...existing,
              tool: { ...existing.tool, status }
            };
          }
        }
      }
      result.push(entry);
      continue;
    }
    const item: AssistantItem = { ...entry, parts: [] };
    for (const part of entry.parts) {
      if (part.kind !== "tool" || !["task", "subagent"].includes(toolKey(part.tool.title))) {
        item.parts.push(part);
        continue;
      }
      const childID = taskChildID(part.tool, sessions, parentID);
      const signature = taskDispatchSignature(part.tool);
      const key = childID ? `child:${childID}` : signature || `call:${part.tool.id}`;
      const previous = represented.get(key);
      if (!previous) {
        represented.set(key, { item, partIndex: item.parts.length });
        item.parts.push(part);
        continue;
      }
      const existing = previous.item.parts[previous.partIndex];
      if (existing?.kind !== "tool") continue;
      previous.item.parts[previous.partIndex] = {
        ...existing,
        tool: mergeSubagentTool(existing.tool, part.tool)
      };
    }
    result.push(item);
  }
  return result;
}

function toolPresentation(tool: ToolCallView): { title: string; subtitle: string; path?: string } {
  const name = effectiveToolKey(tool);
  const input = toolInput(tool);
  const native = tool.metadata?.deepseek;
  const nativeRecord = native && typeof native === "object" && !Array.isArray(native) ? native as Record<string, unknown> : null;
  const rawView = nativeRecord?.resultView ?? nativeRecord?.callView;
  const view = rawView && typeof rawView === "object" && !Array.isArray(rawView) ? rawView as Record<string, unknown> : null;
  // OpenCode's `GenericTool` fallback names an unrecognized tool by its raw id.
  let title = `Called \`${tool.title}\``;
  let subtitle = tool.detail.replace(/^\$\s*/, "");
  let path: string | undefined;
  if (name === "read") {
    title = "Read";
    path = typeof input.filePath === "string" ? input.filePath : typeof input.file_path === "string" ? input.file_path : tool.paths?.[0];
    subtitle = fileName(path);
  } else if (name === "list") {
    title = "List";
    path = typeof input.path === "string" ? input.path : tool.paths?.[0];
    subtitle = fileName(path);
  } else if (name === "inspect") {
    title = "Inspect";
    path = typeof input.path === "string" ? input.path : tool.paths?.[0];
    subtitle = typeof path === "string" ? path : subtitle;
  } else if (name === "glob") {
    title = "Glob";
    subtitle = typeof input.pattern === "string" ? input.pattern : subtitle;
  } else if (name === "grep") {
    title = "Grep";
    subtitle = typeof input.pattern === "string" ? input.pattern : subtitle;
  } else if (name === "webfetch") {
    title = "Webfetch";
    subtitle = typeof input.url === "string" ? input.url : subtitle;
  } else if (name === "websearch" || name === "search") {
    title = "Web Search";
    subtitle = typeof input.query === "string" ? input.query : subtitle;
  } else if (name === "task") {
    title = "Task";
    subtitle = typeof input.description === "string" ? input.description : subtitle;
  } else if (name === "bash" || name === "shell") {
    title = "Shell";
    subtitle = typeof input.command === "string" ? input.command : subtitle;
  } else if (name === "edit") {
    title = "Edit";
    path = typeof input.filePath === "string" ? input.filePath : typeof input.file_path === "string" ? input.file_path : tool.paths?.[0];
    subtitle = fileName(path);
  } else if (name === "write") {
    title = "Write";
    path = typeof input.filePath === "string" ? input.filePath : typeof input.file_path === "string" ? input.file_path : tool.paths?.[0];
    subtitle = fileName(path);
  } else if (name === "patch" || name === "apply_patch") {
    title = "Patch";
  } else if (name === "question") {
    title = "Questions";
  }
  if (view?.card === "terminal") {
    title = "Shell";
    subtitle = typeof view.title === "string" ? view.title : subtitle;
  } else if (view?.card === "read") {
    title = "Read";
    path = typeof view.path === "string" ? view.path : path;
    subtitle = typeof view.title === "string" ? view.title : fileName(path);
  } else if (view?.card === "search" && typeof view.title === "string") {
    subtitle = view.title;
  } else if (view?.card === "web" && typeof view.url === "string") {
    subtitle = view.url;
  }
  return { title, subtitle, path };
}

function formatDuration(duration: number): string {
  const seconds = Math.max(0, Math.floor(duration / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function progressText(progress: string): string {
  const direct = progress.trim();
  if (!direct) return "";
  try {
    const value = JSON.parse(direct) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return direct;
    const record = value as Record<string, unknown>;
    for (const key of ["message", "status", "detail", "phase", "title"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  } catch {
    return direct;
  }
  return direct;
}


interface EditFileEntry {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  content?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

function editFileEntries(tool: ToolCallView): EditFileEntry[] {
  const input = toolInput(tool);
  const path = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : tool.paths?.[0] ?? "";
  const candidates = Array.isArray(tool.metadata?.files) ? tool.metadata.files
    : tool.metadata?.filediff ? [tool.metadata.filediff] : [];
  const entries = candidates.flatMap((entry): EditFileEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const file = [value.relativePath, value.file, value.filePath, path].find((field): field is string => typeof field === "string" && !!field);
    if (!file) return [];
    return [{
      file,
      patch: typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : undefined,
      before: typeof value.before === "string" ? value.before : undefined,
      after: typeof value.after === "string" ? value.after : undefined,
      status: typeof value.type === "string" ? value.type : typeof value.status === "string" ? value.status : undefined,
      additions: typeof value.additions === "number" ? value.additions : undefined,
      deletions: typeof value.deletions === "number" ? value.deletions : undefined
    }];
  });
  if (entries.length) return entries;
  const native = tool.metadata?.deepseek as { resultView?: { diffs?: unknown[] }; callView?: { diffs?: unknown[] } } | undefined;
  const diffs = native?.resultView?.diffs ?? native?.callView?.diffs;
  if (Array.isArray(diffs)) return diffs.flatMap((entry): EditFileEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.newText !== "string") return [];
    return [{ file: value.path, before: typeof value.oldText === "string" ? value.oldText : "", after: value.newText }];
  });
  return [{
    file: path,
    before: typeof input.oldString === "string" ? input.oldString : "",
    after: typeof input.newString === "string" ? input.newString : "",
    content: typeof input.content === "string" ? input.content : undefined
  }];
}

function isEditCardTool(tool: ToolCallView): boolean {
  return ["edit", "write", "patch", "apply_patch"].includes(toolKey(tool.title));
}

function DiffChanges({ file }: { file: Pick<EditFileEntry, "additions" | "deletions"> }): ReactNode {
  return <div data-component="diff-changes" data-variant="numbers">
    <span data-slot="diff-changes-additions">+{file.additions ?? 0}</span>
    <span data-slot="diff-changes-deletions">-{file.deletions ?? 0}</span>
  </div>;
}

function ToolFileAccordion({ file, write = false, patch = false, activatePath }: {
  file: EditFileEntry; write?: boolean; patch?: boolean; activatePath: () => void;
}): ReactNode {
  const [open, setOpen] = useState(!["delete", "deleted", "removed"].includes(file.status ?? ""));
  const slash = file.file.lastIndexOf("/");
  const action = ["add", "added", "created"].includes(file.status ?? "") ? "Created"
    : ["delete", "deleted", "removed"].includes(file.status ?? "") ? "Deleted" : file.status === "move" ? "Moved" : null;
  return <div data-slot="accordion-item" data-type={file.status} data-expanded={open ? "" : undefined}>
    <h3 data-slot="accordion-header" data-component="sticky-accordion-header">
      <button type="button" data-slot="accordion-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <div data-slot="apply-patch-trigger-content">
          <div data-slot="apply-patch-file-info">
            <OpenCodeFileIcon path={file.file} />
            <div data-slot="apply-patch-file-name-container">
              {slash >= 0 && <span data-slot="apply-patch-directory">{"\u202a" + file.file.slice(0, slash + 1) + "\u202c"}</span>}
              <span data-slot="apply-patch-filename" onClick={(event) => { event.stopPropagation(); activatePath(); }}>{fileName(file.file)}</span>
            </div>
          </div>
          <div data-slot="apply-patch-trigger-actions">
            {!write && (patch && action ? <span data-slot="apply-patch-change" data-type={action === "Deleted" ? "removed" : action === "Created" ? "added" : "modified"}>{action}</span> : <DiffChanges file={file} />)}
            <OpenCodeIcon name="chevron-grabber-vertical" />
          </div>
        </div>
      </button>
    </h3>
    {open && <div data-slot="accordion-content" data-expanded="">
      <div data-component={write ? "write-content" : patch ? "apply-patch-file-diff" : "edit-content"}>
        {write ? <OpenCodeFile mode="text" file={file.file} contents={file.content ?? file.after ?? ""} />
          : <OpenCodeFile mode="diff" file={file.file} patch={file.patch} before={file.before} after={file.after} />}
      </div>
    </div>}
  </div>;
}

function EditToolCard({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const [open, setOpen] = useState(false);
  const files = editFileEntries(tool);
  const name = toolKey(tool.title);
  const write = name === "write";
  const patch = name === "patch" || name === "apply_patch";
  const pending = tool.status === "running";
  const path = files[0]?.file ?? "";
  const multi = files.length > 1;
  const activatePath = (path: string): void => {
    const target = workspaceFilePath(path, session);
    if (!target) return;
    if (session) focusSession?.(session.id);
    void openFile(target, undefined, session?.workspace);
  };
  const diagnostics = tool.metadata?.diagnostics;
  const messages = diagnostics && typeof diagnostics === "object" && path
    ? (diagnostics as Record<string, unknown>)[path] : undefined;
  const errors = Array.isArray(messages) ? messages.filter((value) => value?.severity === 1).slice(0, 3) : [];
  return <div data-component={write ? "write-tool" : patch || multi ? "apply-patch-tool" : "edit-tool"} data-tool={name} data-status={tool.status} data-timeline-part-id={tool.id}>
    <div data-component="collapsible" className="tool-collapsible" data-expanded={open ? "" : undefined}>
      <button type="button" data-slot="collapsible-trigger" aria-expanded={open} onClick={() => { if (!pending) setOpen((value) => !value); }}>
        <div data-component="tool-trigger"><div data-slot="basic-tool-tool-trigger-content"><div data-slot="basic-tool-tool-info">
          {multi ? <div data-slot="basic-tool-tool-info-structured"><div data-slot="basic-tool-tool-info-main">
            <span data-slot="basic-tool-tool-title"><TextShimmer text="Patch" active={pending} /></span>
            <span data-slot="basic-tool-tool-subtitle">{files.length + " files"}</span>
          </div></div> : <div data-component={write ? "write-trigger" : "edit-trigger"}>
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">
                <span data-slot="message-part-title-text"><TextShimmer text={write ? "Write" : patch ? "Patch" : "Edit"} active={pending} /></span>
                {!pending && <span data-slot="message-part-title-filename" onClick={(event) => { event.stopPropagation(); activatePath(path); }}>{fileName(path)}</span>}
              </div>
              {!pending && path.includes("/") && <div data-slot="message-part-path"><span data-slot="message-part-directory">{path.slice(0, path.lastIndexOf("/") + 1)}</span></div>}
            </div>
            <div data-slot="message-part-actions">{!pending && !write && (patch || files[0]?.additions !== undefined) && <DiffChanges file={files[0]} />}</div>
          </div>}
        </div></div>{!pending && <span data-slot="collapsible-arrow"><span data-slot="collapsible-arrow-icon"><OpenCodeIcon name="chevron-down" /></span></span>}</div>
      </button>
      {open && <div data-slot="collapsible-content" data-expanded="">
        {path && <div data-component="accordion" data-scope="apply-patch" style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" } as CSSProperties}>
          {files.map((file) => <ToolFileAccordion key={file.file} file={file} write={write} patch={patch} activatePath={() => activatePath(file.file)} />)}
        </div>}
        {errors.length > 0 && <div data-component="diagnostics">{errors.map((value, index) => <div data-slot="diagnostic" key={index}>
          <span data-slot="diagnostic-label">Error</span><span data-slot="diagnostic-location">{"[" + (value.range.start.line + 1) + ":" + (value.range.start.character + 1) + "]"}</span><span data-slot="diagnostic-message">{value.message}</span>
        </div>)}</div>}
      </div>}
    </div>
  </div>;
}

function ToolErrorCard({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const presentation = toolPresentation(tool);
  const errorTitles: Record<string, string> = { read: "Read", list: "List", glob: "Glob", grep: "Grep", task: "Task", webfetch: "Webfetch", bash: "Shell", shell: "Shell", patch: "Patch", apply_patch: "Patch", question: "Questions" };
  presentation.title = tool.title === "websearch" ? openCodeSpecialToolTitle(tool)! : errorTitles[tool.title] ?? tool.title;
  const failurePath = presentation.path;
  const cleaned = (tool.output ?? "").replace(/^Error:\s*/, "").trim();
  const prefix = `${effectiveToolKey(tool)} `;
  const tail = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
  const segments = tail.split(": ");
  const head = segments[0]?.trim();
  // OpenCode capitalizes the error head: "bash: ..." -> "Bash".
  const subtitle = segments.length <= 1 || !head ? "Failed" : head[0].toUpperCase() + head.slice(1);
  const body = segments.length <= 1 ? cleaned : segments.slice(1).join(": ").trim() || cleaned;
  const activateSubtitle = failurePath
    ? (): void => {
        const target = workspaceFilePath(failurePath, session);
        if (!target) return;
        if (session) focusSession?.(session.id);
        void openFile(target, undefined, session?.workspace);
      }
    : undefined;
  const copy = (): void => {
    if (!cleaned) return;
    void navigator.clipboard?.writeText(cleaned).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div data-component="tool-part-wrapper" data-tool={effectiveToolKey(tool)} data-variant="inline" data-status="failed" data-timeline-part-id={tool.id}>
      <div data-component="card" data-kind="tool-error-card" data-variant="error" data-open={open ? "true" : "false"}>
      <div data-component="collapsible" className="tool-collapsible" data-open={open ? "true" : "false"}>
        <button data-slot="collapsible-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <div data-component="tool-trigger" data-clickable="true">
            <div data-slot="basic-tool-tool-trigger-content">
              <span data-slot="basic-tool-tool-indicator" data-component="tool-error-card-icon" style={{ strokeWidth: 1.5 }}><OpenCodeIcon name="circle-ban-sign" /></span>
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">{presentation.title}</span>
                    <span
                      data-slot="basic-tool-tool-subtitle"
                      className={activateSubtitle ? "clickable" : undefined}
                      onClick={activateSubtitle
                        ? (event) => {
                            event.stopPropagation();
                            activateSubtitle();
                          }
                        : undefined}
                    >
                      {subtitle}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <span data-slot="collapsible-arrow"><span data-slot="collapsible-arrow-icon"><OpenCodeIcon name="chevron-down" /></span></span>
          </div>
        </button>
        {open && (
          <div data-slot="collapsible-content">
            <div data-slot="tool-error-card-content">
              <div data-slot="tool-error-card-copy">
                <div data-component="tooltip-trigger" data-tooltip={copied ? "Copied" : "Copy error"}><button
                  data-component="icon-button" data-size="normal" data-variant="ghost" aria-label={copied ? "Copied" : "Copy error"}
                  data-slot="tool-error-card-copy-button" onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    copy();
                  }}
                >
                  <OpenCodeIcon name={copied ? "check" : "copy"} />
                </button></div>
              </div>
              <div data-slot="tool-error-card-description">{body}</div>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function SessionProgressIndicator(): ReactNode {
  const dots = Array.from({ length: 25 }, (_, index) => ({
    index,
    x: 1.5 + (index % 5) * 3,
    y: 1.5 + Math.floor(index / 5) * 3
  }));
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" data-component="session-progress-indicator-v2" aria-hidden="true">
      {dots.map((dot) => <rect data-dot={dot.index} x={dot.x} y={dot.y} width="2" height="2" key={dot.index} />)}
    </svg>
  );
}

function SubagentIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 5C4.5 4.72386 4.72386 4.5 5 4.5H11C11.2761 4.5 11.5 4.72386 11.5 5V11C11.5 11.2761 11.2761 11.5 11 11.5H5C4.72386 11.5 4.5 11.2761 4.5 11V5Z" fill="currentColor" />
      <path d="M13.5 2C13.7761 2 14 2.22386 14 2.5V13.5C14 13.7761 13.7761 14 13.5 14H2.5C2.22386 14 2 13.7761 2 13.5V2.5C2 2.22386 2.22386 2 2.5 2H13.5ZM3 13H13V3H3V13Z" fill="currentColor" />
    </svg>
  );
}

function DelegatedAgentCard({
  id,
  title,
  agent,
  description,
  state,
  tone,
  childID,
  onOpen
}: {
  id: string;
  title: string;
  agent: string;
  description: string;
  state: string;
  tone: "working" | "complete" | "failed";
  childID: string;
  onOpen: () => void;
}): ReactNode {
  const { agents } = useStore();
  const appearance = resolveOpenCodeTaskAgent(agent, agents);
  const agentTitle = appearance.name ?? "Agent";
  return (
    <div data-component="collapsible" className="tool-collapsible">
      <button data-slot="collapsible-trigger" data-hide-details="true" disabled={!childID}
        aria-label={childID ? `Open delegated agent session: ${title}` : `Delegated agent: ${title}`} onClick={onOpen}>
        <div data-component="tool-trigger" data-hide-details="true" data-clickable={childID ? "true" : undefined}>
          <div data-slot="basic-tool-tool-trigger-content"><div data-slot="basic-tool-tool-info">
            <div data-component="task-tool-card" data-state={state} data-timeline-part-id={id} style={{ "--task-agent-color": appearance.v2Color, "--task-agent-legacy-color": appearance.color } as CSSProperties}>
              <div data-component="task-tool-surface">
                <div data-slot="basic-tool-tool-info-structured"><div data-slot="basic-tool-tool-info-main">
                  <span data-component={tone === "working" ? "task-tool-spinner" : "task-tool-icon"}>
                    {tone === "working" ? <SessionProgressIndicator /> : <SubagentIcon />}
                  </span>
                  <span data-component="task-tool-title">{agentTitle}</span>
                  {description && <span data-slot="basic-tool-tool-subtitle">{description}</span>}
                </div></div>
              </div>
              {childID && <span data-component="task-tool-action"><OpenCodeIcon name="square-arrow-top-right" /></span>}
            </div>
          </div></div>
        </div>
      </button>
    </div>
  );
}

function TaskTool({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { agents, sessions, reopenSession } = useStore();
  const input = parseInput(tool.input);
  const requested = typeof input.agent === "string"
    ? input.agent
    : typeof input.subagent_type === "string"
      ? input.subagent_type
      : "";
  const configured = agents.find((agent) =>
    agent.id.toLowerCase() === requested.toLowerCase() || agent.name.toLowerCase() === requested.toLowerCase()
  );
  const description = typeof input.description === "string" && input.description
    ? input.description
    : typeof input.prompt === "string"
      ? input.prompt.trim()
      : "";
  const childSession = taskChildID(tool, sessions, session?.id);
  const resolved = sessions.find((candidate) => candidate.id === childSession);
  const agentName = configured?.name ?? requested;
  const title = resolved?.title.trim()
    ? resolved.title
    : agentName
      ? titleCase(agentName)
      : "Subagent";
  const detail = description || childSession;
  const subtitle = tool.metadata?.background === true && detail ? `${detail} (background)` : detail;
  const running = tool.status === "running";
  return <DelegatedAgentCard
    id={tool.id}
    title={title}
    agent={agentName}
    description={subtitle}
    state={tool.status}
    tone={running ? "working" : tool.status === "failed" ? "failed" : "complete"}
    childID={childSession}
    onOpen={() => childSession && void reopenSession(childSession)}
  />;
}

function SubagentLink({ item, session }: { item: Extract<TranscriptItem, { kind: "synthetic" }>; session: SessionInfo | null }): ReactNode {
  const { agents, sessions, reopenSession } = useStore();
  const ref = parseSubagentTag(item.text) ?? parseLegacyTaskText(item.text);
  const childID = ref ? subagentChildID(ref, sessions, session?.id) : "";
  const resolved = sessions.find((candidate) => candidate.id === childID);
  const configured = ref?.agent
    ? agents.find((agent) =>
        agent.id.toLowerCase() === ref.agent.toLowerCase() || agent.name.toLowerCase() === ref.agent.toLowerCase()
      )
    : undefined;
  const agentName = resolved?.agent ?? configured?.name ?? ref?.agent ?? "";
  const state = ref?.state ?? "";
  const failed = state === "error" || state === "cancelled";
  const running = !state || state === "running";
  const title = resolved?.title.trim()
    ? resolved.title
    : ref?.id
      ? ref.description || "Subagent"
      : agentName
        ? titleCase(agentName)
        : "Subagent";
  const detail = ref?.description
    ? (ref.description.length > 100 ? `${ref.description.slice(0, 100)}…` : ref.description)
    : "";
  return <DelegatedAgentCard
    id={item.id}
    title={title}
    agent={agentName}
    description={detail}
    state={state || "running"}
    tone={failed ? "failed" : running ? "working" : "complete"}
    childID={childID}
    onOpen={() => childID && void reopenSession(childID)}
  />;
}

function ToolPart({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const [open, setOpen] = useState(false);
  const presentation = toolPresentation(tool);
  const output = tool.output ?? "";
  const input = tool.inputValue === undefined
    ? tool.input ?? ""
    : typeof tool.inputValue === "string"
      ? tool.inputValue
      : JSON.stringify(tool.inputValue, null, 2);
  const files = tool.content?.filter((item) => item.type === "file") ?? [];
  const native = tool.metadata?.deepseek;
  const nativeRecord = native && typeof native === "object" && !Array.isArray(native) ? native as Record<string, unknown> : null;
  const subCalls = Array.isArray(nativeRecord?.subCalls) ? nativeRecord.subCalls.flatMap((item): ToolCallView[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.title !== "string") return [];
    const status = value.status === "success" || value.status === "failed" ? value.status : "running";
    return [{
      id: value.id,
      title: value.title,
      detail: typeof value.detail === "string" ? value.detail : "",
      status,
      ...(typeof value.input === "string" ? { input: value.input } : {}),
      ...(value.inputValue !== undefined ? { inputValue: value.inputValue } : {}),
      ...(typeof value.output === "string" ? { output: value.output } : {}),
      ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {})
    }];
  }) : [];
  const expandable = input.length > 0 || output.length > 0 || files.length > 0 || subCalls.length > 0;
  const displayInput = input.length > OUTPUT_LIMIT ? `${input.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : input;
  const displayOutput = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : output;
  const shellInput = toolInput(tool);
  const shell = ["bash", "shell"].includes(effectiveToolKey(tool));
  const shellCommand = typeof shellInput.command === "string" ? shellInput.command : "";
  const shellOutput = stripAnsi(output || (typeof tool.metadata?.output === "string" ? tool.metadata.output : "")).replace(/\r\n?/g, "\n");
  const shellText = `$ ${shellCommand || (typeof tool.metadata?.command === "string" ? tool.metadata.command : "")}${shellOutput ? `\n\n${shellOutput}` : ""}`;
  const sawPending = useRef(tool.status === "running").current;
  const [copied, setCopied] = useState(false);
  const copyShell = (): void => {
    if (!shellText.trim()) return;
    void writeClipboard(shellText).then((success) => {
      if (!success) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const activateSubtitle = (): void => {
    if (!presentation.path) return;
    const target = workspaceFilePath(presentation.path, session);
    if (!target) return;
    if (session) focusSession?.(session.id);
    void openFile(target, undefined, session?.workspace);
  };

  if (toolKey(tool.title) === "todowrite") return null;
  if (isDismissedOpenCodeQuestion(tool)) return <OpenCodeSpecialTool tool={tool} />;
  if (tool.status === "failed") return <ToolErrorCard tool={tool} session={session} />;
  if (toolKey(tool.title) === "task" || toolKey(tool.title) === "subagent") return <TaskTool tool={tool} session={session} />;
  if (isEditCardTool(tool)) return <EditToolCard tool={tool} session={session} />;
  if (!shell && !nativeRecord) return <OpenCodeSpecialTool tool={tool} />;

  return (
    <div data-component="tool-part-wrapper" data-tool={effectiveToolKey(tool)} data-variant="inline" data-status={tool.status} data-timeline-part-id={tool.id}>
      <div data-component="collapsible" className="tool-collapsible" data-expanded={open ? "true" : undefined}>
        <button
          data-slot="collapsible-trigger"
          aria-expanded={open}
          disabled={!expandable}
          onClick={() => expandable && setOpen((value) => !value)}
        >
          <div data-component="tool-trigger" data-clickable={expandable ? "true" : undefined}>
            <div data-slot="basic-tool-tool-trigger-content">
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">
                      <TextShimmer text={presentation.title} active={tool.status === "running"} />
                    </span>
                    {shell ? !open && shellCommand && <ShellSubmessage text={shellCommand} animate={sawPending} /> : presentation.subtitle && (
                      <span
                        data-slot="basic-tool-tool-subtitle"
                        className={presentation.path ? "clickable" : undefined}
                        title={presentation.subtitle}
                        onClick={(event) => {
                          if (!presentation.path) return;
                          event.stopPropagation();
                          activateSubtitle();
                        }}
                      >
                        {presentation.subtitle}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {expandable && <span data-slot="collapsible-arrow"><span data-slot="collapsible-arrow-icon"><OpenCodeIcon name="chevron-down" /></span></span>}
          </div>
        </button>
        {tool.progress && tool.status === "running" && (
          <div data-slot="tool-progress"><TextShimmer text={progressText(tool.progress)} /></div>
        )}
        {expandable && open && (
          <div data-slot="collapsible-content">
            {shell && (input || output) ? (
              <div data-component="bash-output" dir="ltr">
                <div data-slot="bash-copy">
                  <div data-component="tooltip-v2-trigger" data-tooltip={copied ? "Copied" : "Copy"}><button
                    data-component="icon-button-v2" data-size="normal" data-variant="ghost-muted" aria-label={copied ? "Copied" : "Copy"} onMouseDown={(event) => event.preventDefault()}
                    data-slot="bash-copy-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyShell();
                    }}
                  >
                    <OpenCodeIcon name={copied ? "check" : "outline-copy"} />
                  </button></div>
                </div>
                <div data-slot="bash-scroll" data-scrollable="" tabIndex={0} role="region" aria-label="Scrollable content"><pre data-slot="bash-pre"><code>{shellText}</code></pre></div>
              </div>
            ) : (input || output) ? (
              <div data-component="tool-io">
                {input && (
                  <div data-component="tool-io-section">
                    <span data-slot="tool-io-label">IN</span>
                    <pre data-slot="tool-io-text">{displayInput}</pre>
                  </div>
                )}
                {input && output && <span data-slot="tool-io-divider" />}
                {output && (
                  <div data-component="tool-io-section">
                    <span data-slot="tool-io-label">OUT</span>
                    <pre data-slot="tool-io-text">{displayOutput}</pre>
                  </div>
                )}
              </div>
            ) : null}
            {files.length > 0 && (
              <div data-component="tool-files">
                {files.map((file) => (
                  <ExternalLink href={file.uri} key={`${file.uri}:${file.name ?? ""}`}>
                    <span className="codicon codicon-file" />
                    <span>{file.name ?? file.uri}</span>
                    <span data-slot="tool-file-mime">{file.mime}</span>
                  </ExternalLink>
                ))}
              </div>
            )}
            {subCalls.length > 0 && (
              <div data-component="nested-tool-calls">
                {subCalls.map((subCall) => <ToolPart tool={subCall} session={session} key={subCall.id} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ tag, children, previous }: { tag: string; children: ReactNode; previous?: boolean }): ReactNode {
  return (
    <div data-timeline-row={tag} data-previous-assistant-part={previous ? "true" : undefined} className="opencode-row">
      <div data-component="session-turn">
        <div data-slot="session-turn-message-container">{children}</div>
      </div>
    </div>
  );
}

const THINKING_LABEL = "Thinking";

function ThinkingHeading({ text }: { text: string }): ReactNode {
  const [state, setState] = useState({ current: text, old: "", width: "auto", swapping: false });
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const entering = useRef<HTMLSpanElement>(null);
  const leaving = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    setState((previous) => {
      if (previous.current === text) return previous;
      if (text.startsWith(previous.current)) return { ...previous, current: text };
      return { ...previous, current: text, old: previous.current, swapping: true };
    });
  }, [text]);

  useLayoutEffect(() => {
    const width = Math.max(entering.current?.scrollWidth ?? 0, leaving.current?.scrollWidth ?? 0);
    if (width > 0) setState((previous) => {
      const prior = Number.parseFloat(previous.width);
      return Number.isFinite(prior) && prior >= width ? previous : { ...previous, width: `${width}px` };
    });
    if (!state.swapping) return;
    if (typeof requestAnimationFrame !== "function") {
      setState((previous) => ({ ...previous, swapping: false }));
      return;
    }
    const frame = requestAnimationFrame(() => {
      void root.current?.offsetHeight;
      setState((previous) => ({ ...previous, swapping: false }));
    });
    return () => cancelAnimationFrame(frame);
  }, [state.current, state.old, state.swapping]);

  useEffect(() => {
    let cancelled = false;
    let frame: number | undefined;
    const finish = (): void => {
      if (cancelled) return;
      if (typeof requestAnimationFrame !== "function") {
        setReady(true);
        return;
      }
      frame = requestAnimationFrame(() => setReady(true));
    };
    const fonts = document.fonts;
    if (fonts) void fonts.ready.finally(finish);
    else finish();
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <span
      ref={root}
      data-component="text-reveal"
      data-slot="session-turn-thinking-heading"
      data-ready={ready ? "true" : "false"}
      data-swapping={state.swapping ? "true" : "false"}
      aria-label={text}
      style={{ "--text-reveal-duration": "700ms", "--text-reveal-travel": "25px" } as CSSProperties}
    >
      <span data-slot="text-reveal-track" style={{ width: state.width }}>
        <span data-slot="text-reveal-entering" ref={entering} aria-hidden="true">{state.current}</span>
        <span data-slot="text-reveal-leaving" ref={leaving} aria-hidden="true">{state.old}</span>
      </span>
    </span>
  );
}

function SessionTurnThinking({ heading }: { heading?: string }): ReactNode {
  return (
    <TimelineRow tag="AssistantWorking">
      <div data-slot="session-turn-thinking" role="status" aria-live="polite">
        <TextShimmer text={THINKING_LABEL} tone="thinking" />
        {heading && <ThinkingHeading text={heading} />}
      </div>
    </TimelineRow>
  );
}

function UserMessage({ item, session, busy }: { item: Extract<TranscriptItem, { kind: "user" }>; session: SessionInfo | null; busy: boolean }): ReactNode {
  const { stageRevert, models } = useStore();
  const model = models?.find((model) => model.id === item.model?.id && model.providerID === item.model?.providerID)?.name ?? item.model?.id;
  const head = [item.agent && item.agent[0].toUpperCase() + item.agent.slice(1), model].filter(Boolean).join("\u00a0·\u00a0");
  const stamp = item.createdAt === undefined ? "" : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(item.createdAt);
  return (
    <TimelineRow tag="UserMessage">
      <div data-slot="session-turn-message-content" aria-live="off">
        <div data-component="user-message">
          {item.text && <div data-slot="user-message-body"><div data-slot="user-message-text" dir="auto">{item.text}</div></div>}
          {item.attachments && item.attachments.length > 0 && (
            <div data-slot="user-message-attachments">
              {item.attachments.map((attachment) => (
                <div data-slot="user-message-attachment" data-type="file" key={attachment.name}>
                  <div data-slot="user-message-attachment-file"><span className="codicon codicon-file" /><span data-slot="user-message-attachment-name">{attachment.name}</span></div>
                </div>
              ))}
            </div>
          )}
          {item.text && <div data-slot="user-message-copy-wrapper">
            {(head || stamp) && <span data-slot="user-message-meta-wrap">
              {head && <span data-slot="user-message-meta" className="text-12-regular text-text-weak">{head}</span>}
              {head && stamp && <span className="text-12-regular text-text-weak">{ "\u00a0·\u00a0" }</span>}
              {stamp && <span data-slot="user-message-meta-tail" className="text-12-regular text-text-weak">{stamp}</span>}
            </span>}
            {session && <div data-component="tooltip-v2-trigger" data-tooltip="Revert message"><button data-component="icon-button-v2" data-size="normal" data-variant="ghost-muted" aria-label="Revert message" disabled={busy}
              onMouseDown={(event) => event.preventDefault()} onClick={() => void stageRevert(session.workspace, item.id)}><OpenCodeIcon name="reset" /></button></div>}
            <CopyResponse text={item.text} target="message" />
          </div>}
        </div>
      </div>
    </TimelineRow>
  );
}

// OpenCode hides reasoning parts by default (`showReasoningSummaries: false`); only the
// turn-level thinking heading reflects them. `ActivityPart` therefore excludes reasoning.
type RenderablePart = Exclude<AssistantPart, { kind: "reasoning" }>;
type ActivityPart = Extract<RenderablePart, { kind: "tool" }>;
function isContextActivityPart(part: ActivityPart): boolean {
  return isContextTool(part.tool);
}

function ContextToolRow({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const name = effectiveToolKey(tool);
  const input = toolInput(tool);
  const base = toolPresentation(tool);
  // OpenCode's `contextToolTrigger`: list/glob/grep subtitle is the search directory; the
  // pattern/include live in `contextToolArgs` so they are never shown twice.
  const presentation =
    name === "list" || name === "glob" || name === "grep"
      ? { title: base.title, subtitle: contextDirectory(typeof input.path === "string" ? input.path : undefined, session), path: base.path }
      : base;
  const args = contextToolArgs(tool);
  const activateSubtitle = presentation.path
    ? (): void => {
        const target = workspaceFilePath(presentation.path!, session);
        if (!target) return;
        if (session) focusSession?.(session.id);
        void openFile(target, undefined, session?.workspace);
      }
    : undefined;
  return (
    <div data-slot="context-tool-group-item">
      <div data-component="tool-trigger">
        <div data-slot="basic-tool-tool-trigger-content">
          <div data-slot="basic-tool-tool-info">
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">
                  <TextShimmer text={presentation.title} active={tool.status === "running"} />
                </span>
                {presentation.subtitle && (
                  <span
                    data-slot="basic-tool-tool-subtitle"
                    className={activateSubtitle ? "clickable" : undefined}
                    title={presentation.subtitle}
                    onClick={activateSubtitle
                      ? (event) => {
                          event.stopPropagation();
                          activateSubtitle();
                        }
                      : undefined}
                  >
                    {presentation.subtitle}
                  </span>
                )}
                {args.map((arg) => <span data-slot="basic-tool-tool-arg" key={arg}>{arg}</span>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextToolGroup({ tools, session, working = false }: { tools: ToolCallView[]; session: SessionInfo | null; working?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const summary = contextToolSummary(tools);
  const pending = working || tools.some((tool) => tool.status === "running");
  const items: CountItem[] = [
    { key: "read", count: summary.read },
    { key: "search", count: summary.search },
    { key: "list", count: summary.list }
  ];
  return (
    <div
      data-component="context-tool-group"
      className="tool-collapsible"
      data-timeline-part-ids={tools.map((tool) => tool.id).join(",")}
      data-expanded={open ? "true" : undefined}
    >
      <button data-slot="collapsible-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <div data-component="context-tool-group-trigger">
          <span data-slot="context-tool-group-title">
            <span data-slot="context-tool-group-label">
              <ToolStatusTitle active={pending} activeText="Exploring" doneText="Explored" split={false} />
            </span>
            <span data-slot="context-tool-group-summary">
              <AnimatedCountList items={items} fallback="" />
            </span>
          </span>
          <span data-slot="collapsible-arrow"><span data-slot="collapsible-arrow-icon"><OpenCodeIcon name="chevron-down" /></span></span>
        </div>
      </button>
      {open && (
        <div data-slot="collapsible-content">
          <div data-component="context-tool-group-list">
            {tools.map((tool) => <ContextToolRow tool={tool} session={session} key={tool.id} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// Mirrors OpenCode's `renderable` with `showReasoningSummaries: false`: reasoning is never
// rendered as a part, `todowrite` is hidden, and empty text parts are dropped.
function renderableAssistantPart(part: AssistantPart): part is RenderablePart {
  if (part.kind === "reasoning") return false;
  if (part.kind === "tool") return toolKey(part.tool.title) !== "todowrite" && !(part.tool.title === "question" && part.tool.status === "running");
  return Boolean(part.text.trim());
}

// Port of OpenCode's `reasoningHeading`/`cleanHeading` (timeline rows) so the thinking row
// surfaces the same heading a user would see in OpenCode.
function cleanHeading(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim();
}

function reasoningHeading(text: string): string | undefined {
  const markdown = text.replace(/\r\n?/g, "\n");

  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (html?.[1]) {
    const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "));
    if (value) return value;
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m);
  if (atx?.[1]) {
    const value = cleanHeading(atx[1]);
    if (value) return value;
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m);
  if (setext?.[1]) {
    const value = cleanHeading(setext[1]);
    if (value) return value;
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m);
  if (strong?.[1]) {
    const value = cleanHeading(strong[1]);
    if (value) return value;
  }

  return undefined;
}

function latestReasoningHeading(items: AssistantItem[]): string | undefined {
  let latest: string | undefined;
  for (const item of items) {
    for (const part of item.parts) {
      if (part.kind !== "reasoning" || !part.text) continue;
      const heading = reasoningHeading(part.text);
      if (heading) latest = heading;
    }
  }
  return latest;
}

// OpenCode groups all assistant messages of a turn into one assistant part stream before
// folding context runs. Orbit renders a contiguous run of assistant transcript items through
// this component so context runs can span message boundaries.
function AssistantRun({
  items,
  streaming,
  copyPartID,
  session,
  duration
}: {
  items: AssistantItem[];
  streaming: boolean;
  copyPartID: string | null;
  session: SessionInfo | null;
  duration?: number;
}): ReactNode {
  const rows: ReactNode[] = [];
  type Entry = { kind: "part"; part: RenderablePart; message: AssistantItem } | { kind: "context"; id: string; tools: ToolCallView[] };
  const groups: Entry[] = [];
  for (const message of items) for (const part of message.parts.filter(renderableAssistantPart)) {
    if (part.kind === "tool" && isContextActivityPart(part)) {
      const last = groups.at(-1);
      if (last?.kind === "context") last.tools.push(part.tool);
      else groups.push({ kind: "context", id: part.id, tools: [part.tool] });
    } else groups.push({ kind: "part", part, message });
  }
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const part = group.kind === "part" ? group.part : undefined;
    const key = group.kind === "context" ? group.id : group.part.id;
    rows.push(
      <TimelineRow tag={part?.kind === "text" ? "AssistantMessage" : "AssistantActivity"} previous={index > 0} key={key}>
        <div data-slot="session-turn-assistant-content">
          {group.kind === "context" ? <ContextToolGroup tools={group.tools} session={session} working={streaming && index === groups.length - 1} />
            : group.part.kind === "text" ? <TextPart part={group.part} streaming={!group.message.completed}
                showCopy={group.part.id === copyPartID} message={group.message} duration={duration} />
            : <ToolPart tool={group.part.tool} session={session} />}
        </div>
      </TimelineRow>
    );
  }

  for (const item of items) {
    if (item.retry) {
      rows.push(
        <TimelineRow tag="Retry" previous key={`${item.id}:retry`}>
          <div data-slot="session-turn-retry">
            <span className="spinner" />
            <div>
              <div data-slot="session-turn-retry-message">{item.retry.message.slice(0, 80)}</div>
              <div data-slot="session-turn-retry-info">Retrying · attempt {item.retry.attempt}</div>
            </div>
          </div>
        </TimelineRow>
      );
    }
    if (item.error) {
      rows.push(
        <TimelineRow tag="Error" previous key={`${item.id}:error`}>
          <div data-component="card" data-variant="error" className="error-card">{item.error.replace(/^Error:\s*/, "")}</div>
        </TimelineRow>
      );
    }
  }
  return <>{rows}</>;
}

function renderTurnBody(
  body: TimelineTurn["body"],
  busy: boolean,
  lastAssistantId: string | null,
  session: SessionInfo | null,
  turnStartedAt?: number
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const completedAt = body.filter((item): item is AssistantItem => item.kind === "assistant").at(-1)?.completedAt;
  const duration = turnStartedAt !== undefined && completedAt !== undefined ? completedAt - turnStartedAt : undefined;
  const copyPartID = busy ? null : body
    .flatMap((item) => item.kind === "assistant" ? item.parts : [])
    .filter((part): part is Extract<AssistantPart, { kind: "text" }> => part.kind === "text" && Boolean(part.text.trim()))
    .at(-1)?.id ?? null;
  let run: AssistantItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    nodes.push(
      <AssistantRun
        items={items}
        streaming={busy && items.some((item) => item.id === lastAssistantId)}
        copyPartID={copyPartID}
        duration={duration}
        session={session}
        key={`assistant-run:${items[0].id}`}
      />
    );
  };
  for (const item of body) {
    if (item.kind === "assistant") {
      run.push(item);
      continue;
    }
    flush();
    nodes.push(<TimelineEvent item={item} session={session} key={item.id} />);
  }
  flush();
  return nodes;
}

type TimelineTurn = {
  id: string;
  user?: Extract<TranscriptItem, { kind: "user" }>;
  body: Exclude<VisibleTimelineItem, { kind: "user" }>[];
};

function buildTurns(timeline: VisibleTimelineItem[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  for (const item of timeline) {
    if (item.kind === "user") {
      current = { id: item.id, user: item, body: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: item.id, body: [] };
      turns.push(current);
    }
    current.body.push(item);
  }
  return turns;
}

function TimelineEvent({
  item,
  session
}: {
  item: Exclude<VisibleTimelineItem, { kind: "user" | "assistant" }>;
  session: SessionInfo | null;
}): ReactNode {
  const { sessions } = useStore();
  if (item.kind === "status") {
    const icon = item.tone === "error" ? "codicon-error" : item.tone === "success" ? "codicon-check" : "codicon-info";
    return (
      <TimelineRow tag="StatusNote">
        <div data-component="session-note" data-tone={item.tone}>
          <span className={`codicon ${icon}`} data-slot="session-note-icon" />
          <span data-slot="session-note-text">{item.text}</span>
        </div>
      </TimelineRow>
    );
  }
  if (item.kind === "divider") {
    return (
      <TimelineRow tag="TurnDivider">
        <div data-component="compaction-part">
          <span data-slot="compaction-part-line" />
          <span data-slot="compaction-part-label">Session compacted</span>
          <span data-slot="compaction-part-line" />
        </div>
      </TimelineRow>
    );
  }
  if (item.kind === "shell") {
    return (
      <TimelineRow tag="ShellMessage">
        <div data-slot="session-turn-assistant-content">
          <ToolPart session={session} tool={{
            id: item.shellID,
            title: "shell",
            detail: item.command ? `$ ${item.command}` : "",
            status: item.status === "running" ? "running" : item.status === "exited" && (!item.exit || item.exit === 0)
              ? "success"
              : "failed",
            input: JSON.stringify({ command: item.command }),
            inputValue: { command: item.command },
            output: item.output
          }} />
        </div>
      </TimelineRow>
    );
  }
  if (item.kind === "compaction") {
    const label = item.status === "running"
      ? "Compacting session"
      : item.status === "failed"
        ? "Compaction failed"
        : "Session compacted";
    return (
      <TimelineRow tag="Compaction">
        <div data-component="compaction-message" data-status={item.status}>
          <div data-component="compaction-part">
            <span data-slot="compaction-part-line" />
            <span data-slot="compaction-part-label">
              {item.status === "running" ? <TextShimmer text={label} /> : label}
            </span>
            <span data-slot="compaction-part-line" />
          </div>
          {item.summary && <Markdown text={item.summary} streaming={item.status === "running"} />}
          {item.error && (
            <div data-component="session-note" data-tone="error">
              <span className="codicon codicon-error" data-slot="session-note-icon" />
              <span data-slot="session-note-text">{item.error}</span>
            </div>
          )}
        </div>
      </TimelineRow>
    );
  }
  if (item.kind === "synthetic") {
    const ref = parseSubagentTag(item.text) ?? parseLegacyTaskText(item.text);
    if (ref && subagentChildID(ref, sessions, session?.id)) {
      return (
        <TimelineRow tag="SubagentLink">
          <SubagentLink item={item} session={session} />
        </TimelineRow>
      );
    }
  }
  const label = item.kind === "skill"
    ? `Skill activated · ${item.name}`
    : item.kind === "synthetic"
      ? item.description || "System message"
      : "System message";
  const text = item.text;
  return (
    <TimelineRow tag="SessionEvent">
      <div data-component="session-message" data-kind={item.kind}>
        <div data-slot="session-message-label">{label}</div>
        {item.kind === "skill" && item.skill && (
          <div data-slot="session-message-detail">{item.skill}</div>
        )}
        {text && <Markdown text={text} streaming={false} />}
      </div>
    </TimelineRow>
  );
}

export function PermissionPrompt({ item, session }: { item: Extract<TranscriptItem, { kind: "permission" }>; session: SessionInfo | null }): ReactNode {
  const { replyPermission } = useStore();
  if (!item.pending) return null;
  return (
    <div data-component="dock-prompt" data-kind="permission">
      <div data-slot="permission-header">Permission required</div>
      <div data-slot="permission-action">{item.action}</div>
      {item.resources.map((resource) => <code key={resource}>{resource}</code>)}
      <div data-slot="permission-actions">
        <button className="btn btn-primary" onClick={() => void replyPermission(item.requestID, "once", session?.id)}>Allow once</button>
        <button className="btn" onClick={() => void replyPermission(item.requestID, "always", session?.id)}>Always</button>
        <button className="btn btn-danger" onClick={() => void replyPermission(item.requestID, "reject", session?.id)}>Deny</button>
      </div>
    </div>
  );
}

export const OpenCodeTimeline = memo(function OpenCodeTimeline({
  transcript,
  busy,
  lastAssistantId,
  session
}: {
  transcript: TranscriptItem[];
  busy: boolean;
  lastAssistantId: string | null;
  session?: SessionInfo | null;
}): ReactNode {
  const store = useStore();
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => root.current ? mountTooltip(root.current) : undefined, []);
  useLayoutEffect(() => {
    const html = document.documentElement;
    const sync = (): void => {
      if (root.current) root.current.dataset.colorScheme = getComputedStyle(html).colorScheme === "light" ? "light" : "dark";
    };
    const observer = new MutationObserver(sync);
    observer.observe(html, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);
  const activeSession = session === undefined ? store.session : session;
  const consolidatedTranscript = useMemo(
    () => consolidateSubagentTools(transcript, store.sessions, activeSession?.id),
    [transcript, store.sessions, activeSession?.id]
  );
  const representedSubagents = useMemo(() => {
    const ids = new Set<string>();
    let turn = 0;
    for (const item of consolidatedTranscript) {
      if (item.kind === "user") {
        turn += 1;
        continue;
      }
      if (item.kind !== "assistant") continue;
      for (const part of item.parts) {
        if (part.kind !== "tool" || !["task", "subagent"].includes(toolKey(part.tool.title))) continue;
        const childID = taskChildID(part.tool, store.sessions, activeSession?.id);
        if (childID) ids.add(`${turn}:child:${childID}`);
        const signature = taskDispatchSignature(part.tool);
        if (signature) ids.add(`${turn}:${signature}`);
      }
    }
    return ids;
  }, [consolidatedTranscript, store.sessions, activeSession?.id]);
  const timeline = useMemo(() => {
    const visible: VisibleTimelineItem[] = [];
    let turn = 0;
    for (const item of consolidatedTranscript) {
      if (item.kind === "user") turn += 1;
      if (item.kind === "permission" || item.kind === "pending-input" || item.kind === "selection" || item.kind === "system") {
        continue;
      }
      if (item.kind === "synthetic") {
        const ref = parseSubagentTag(item.text) ?? parseLegacyTaskText(item.text);
        const childID = ref ? subagentChildID(ref, store.sessions, activeSession?.id) : "";
        if (childID && representedSubagents.has(`${turn}:child:${childID}`)) continue;
        if (ref && representedSubagents.has(`${turn}:${refDispatchSignature(ref)}`)) continue;
      }
      if (item.kind !== "synthetic" || !isInternalSystemReminder(item)) visible.push(item);
    }
    return visible;
  }, [consolidatedTranscript, representedSubagents, store.sessions, activeSession?.id]);
  const turns = useMemo(() => buildTurns(timeline), [timeline]);
  const activeAssistants = useMemo(
    () => (turns.at(-1)?.body ?? []).filter((item): item is AssistantItem => item.kind === "assistant"),
    [turns]
  );
  const thinkingHeading = useMemo(() => latestReasoningHeading(activeAssistants), [activeAssistants]);
  const activeTurnError = activeAssistants.some((item) => Boolean(item.error));
  const activeTurnRetry = activeAssistants.some((item) => Boolean(item.retry));
  const showThinking = busy && !activeTurnError && !activeTurnRetry;

  return (
    <div ref={root} data-slot="session-turn-list" className="opencode-timeline" data-new-layout="">
      {turns.map((turn, index) => {
        return (
          <div data-component="session-turn-group" key={turn.id}>
            {turn.user && index > 0 && <div data-timeline-row="TurnGap" aria-hidden="true" />}
            {turn.user && <UserMessage item={turn.user} session={activeSession} busy={busy} />}
            {renderTurnBody(turn.body, busy && index === turns.length - 1, lastAssistantId, activeSession, turn.user?.createdAt)}
          </div>
        );
      })}
      {showThinking && <SessionTurnThinking heading={thinkingHeading} />}
    </div>
  );
});
