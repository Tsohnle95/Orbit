import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store";
import type { ToolCallView, TranscriptItem, SessionSummary, SessionInfo } from "@shared/types";
import { ExternalLink } from "./ExternalLink";
import { TextShimmer } from "./TextShimmer";
import { ToolStatusTitle } from "./ToolStatusTitle";
import { AnimatedCountList, type CountItem } from "./ToolCountSummary";
import { project, type Block, type Projection } from "../markdown-stream";

const OUTPUT_LIMIT = 6000;

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type AssistantPart = AssistantItem["parts"][number];
type VisibleTimelineItem = Exclude<TranscriptItem, { kind: "permission" | "pending-input" | "selection" | "system" }>;

function isInternalSystemReminder(item: Extract<TranscriptItem, { kind: "synthetic" }>): boolean {
  return /<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder>/i.test(item.text);
}

const CODE_TOKEN_PATTERN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|\b(?:as|async|await|break|case|catch|class|const|continue|def|else|export|extends|for|from|function|if|import|in|interface|let|new|of|return|static|switch|throw|try|type|var|while|with|yield)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
const CODE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "else", "export",
  "extends", "for", "from", "function", "if", "import", "in", "interface", "let", "new", "of", "return",
  "static", "switch", "throw", "try", "type", "var", "while", "with", "yield"
]);

function highlightCode(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CODE_TOKEN_PATTERN)) {
    const value = match[0];
    const index = match.index ?? cursor;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const kind = value.startsWith("//") || value.startsWith("/*") || value.startsWith("#")
      ? "comment"
      : value.startsWith("\"") || value.startsWith("'") || value.startsWith("`")
        ? "string"
        : /^\d/.test(value)
          ? "number"
          : CODE_KEYWORDS.has(value)
            ? "keyword"
            : "function";
    nodes.push(<span data-code-token={kind} key={`${index}:${kind}`}>{value}</span>);
    cursor = index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const MARKDOWN_COMPONENTS: Components = {
  a: ExternalLink,
  code({ children, className }) {
    const value = String(children ?? "");
    const block = Boolean(className) || value.includes("\n");
    const codeText = value.replace(/\n$/, "");
    return (
      block ? (
        <>
          <code className={className} data-code-language={className?.match(/language-([\w+-]+)/)?.[1] ?? "text"}>
            {highlightCode(codeText)}
          </code>
          <CopyResponse text={codeText} target="code" />
        </>
      ) : (
        <code className={className} data-code-language={className?.match(/language-([\w+-]+)/)?.[1] ?? "text"}>
          {children}
        </code>
      )
    );
  }
};

// One projected markdown block. OpenCode keys/memoizes each block so frozen blocks never
// re-render while the tail streams; `display: contents` keeps the wrapper out of layout.
const MarkdownBlock = memo(function MarkdownBlock({ block }: { block: Block }): ReactNode {
  const source = block.mode === "code" ? block.raw : block.src;
  return (
    <div
      data-markdown-block=""
      data-markdown-complete={block.mode === "code" ? (block.complete ? "true" : "false") : undefined}
      style={{ display: "contents" }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{source}</ReactMarkdown>
    </div>
  );
});

function Markdown({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const projectionRef = useRef<Projection | undefined>(undefined);
  const projection = useMemo(() => {
    const next = project(projectionRef.current, text, streaming);
    projectionRef.current = next;
    return next;
  }, [text, streaming]);
  if (!text) return null;
  return (
    <div data-component="markdown" data-streaming={streaming ? "true" : "false"}>
      {projection.blocks.map((block, index) => (
        <MarkdownBlock block={block} key={`${index}:${block.mode}`} />
      ))}
    </div>
  );
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

function PacedMarkdown({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
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
  return <Markdown text={visible} streaming={streaming} />;
}

function CopyResponse({ text, target = "response" }: { text: string; target?: "response" | "code" }): ReactNode {
  const [copied, setCopied] = useState(false);
  const label = target === "code" ? "code" : "response";
  const copy = async (): Promise<void> => {
    if (!text) return;
    const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      data-slot={target === "code" ? "code-block-copy-button" : "text-part-copy-button"}
      className="icon-btn"
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void copy()}
    >
      <span className={`codicon codicon-${copied ? "check" : "copy"}`} />
    </button>
  );
}

function ResponseOptions({
  text,
  showRevert,
  onRevert
}: {
  text: string;
  showRevert: boolean;
  onRevert?: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const copy = async (): Promise<void> => {
    if (!text) return;
    const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    setOpen(false);
  };

  return (
    <div data-component="response-options" ref={menuRef}>
      <button
        data-slot="response-options-button"
        className="icon-btn"
        aria-label="Response options"
        title="Response options"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="codicon codicon-kebab-vertical" />
      </button>
      {open && (
        <div data-slot="response-options-menu" role="menu">
          <button
            data-slot="response-options-item"
            className="response-option"
            role="menuitem"
            disabled={!text}
            onClick={() => void copy()}
          >
            <span className={`codicon codicon-${copied ? "check" : "copy"}`} />
            {copied ? "Copied" : "Copy response"}
          </button>
          {showRevert && onRevert && (
            <button
              data-slot="response-options-item"
              className="response-option"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRevert();
              }}
            >
              <span className="codicon codicon-discard" />
              Revert from here
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TextPart({
  part,
  streaming,
  showLabel = false,
  showRevert = false,
  onRevert
}: {
  part: Extract<AssistantPart, { kind: "text" }>;
  streaming: boolean;
  showLabel?: boolean;
  showRevert?: boolean;
  onRevert?: () => void;
}): ReactNode {
  const text = part.text.trim();
  if (!text) return null;
  return (
    <div data-component="text-part" data-copyable={!streaming ? "true" : undefined} data-timeline-part-id={part.id}>
      {showLabel && (
        <div data-slot="assistant-message-head">
          <span data-slot="assistant-avatar" aria-hidden="true" />
          <span data-slot="assistant-name">Orbit</span>
        </div>
      )}
      <div data-slot="text-part-body">
        <PacedMarkdown text={text} streaming={streaming} />
      </div>
      {!streaming && (
        <div data-slot="text-part-copy-wrapper">
          <ResponseOptions text={text} showRevert={showRevert} onRevert={onRevert} />
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
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function toolInput(tool: ToolCallView): Record<string, unknown> {
  if (tool.inputValue && typeof tool.inputValue === "object" && !Array.isArray(tool.inputValue)) {
    return tool.inputValue as Record<string, unknown>;
  }
  return parseInput(tool.input);
}

function effectiveToolKey(tool: ToolCallView): string {
  const explicit = toolKey(tool.title);
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
  status?: string;
  additions?: number;
  deletions?: number;
}

function editFileEntries(tool: ToolCallView): EditFileEntry[] {
  const files = tool.metadata?.files;
  if (!Array.isArray(files)) {
    const native = tool.metadata?.deepseek;
    const nativeRecord = native && typeof native === "object" && !Array.isArray(native) ? native as Record<string, unknown> : null;
    const rawView = nativeRecord?.resultView ?? nativeRecord?.callView;
    const view = rawView && typeof rawView === "object" && !Array.isArray(rawView) ? rawView as Record<string, unknown> : null;
    if (view?.card !== "diff" || !Array.isArray(view.diffs)) return [];
    return view.diffs.flatMap((entry): EditFileEntry[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const diff = entry as Record<string, unknown>;
      if (typeof diff.path !== "string" || typeof diff.newText !== "string") return [];
      const oldText = typeof diff.oldText === "string" ? diff.oldText : "";
      const oldLines = oldText.split("\n");
      const newLines = diff.newText.split("\n");
      return [{
        file: diff.path,
        patch: [`--- ${diff.path}`, `+++ ${diff.path}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n"),
        status: oldText ? "modified" : "created",
        additions: newLines.length,
        deletions: oldText ? oldLines.length : 0
      }];
    });
  }
  return files.flatMap((entry): EditFileEntry[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.file !== "string" || !record.file) return [];
    return [{
      file: record.file,
      ...(typeof record.patch === "string" && record.patch ? { patch: record.patch } : {}),
      ...(typeof record.status === "string" && record.status ? { status: record.status } : {}),
      ...(typeof record.additions === "number" ? { additions: record.additions } : {}),
      ...(typeof record.deletions === "number" ? { deletions: record.deletions } : {})
    }];
  });
}

const PATCH_HEADER_PATTERN = /^(Index: |={4,}|--- |\+\+\+ )/;

function patchBody(patch: string): string[] {
  const lines = patch.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let hunkStarted = false;
  return lines.filter((line) => {
    if (line.startsWith("@@")) {
      hunkStarted = true;
      return true;
    }
    return hunkStarted || !PATCH_HEADER_PATTERN.test(line);
  });
}

function PatchDiff({ patch }: { patch: string }): ReactNode {
  return (
    <div data-component="patch-diff">
      {patchBody(patch).map((line, index) => (
        <div
          data-component="patch-diff-line"
          data-kind={line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context"}
          key={index}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function isEditCardTool(tool: ToolCallView): boolean {
  if (["edit", "write", "patch", "apply_patch"].includes(toolKey(tool.title))) return editFileEntries(tool).length > 0;
  return false;
}

function EditToolCard({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const [open, setOpen] = useState(false);
  const files = editFileEntries(tool);
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const path = files[0]?.file ?? tool.paths?.[0];
  const expandable = files.some((file) => file.patch);
  if (files.length === 0) return <ToolPart tool={tool} session={session} />;
  const activatePath = (): void => {
    if (!path) return;
    const target = workspaceFilePath(path, session);
    if (!target) return;
    if (session) focusSession?.(session.id);
    void openFile(target, undefined, session?.workspace);
  };
  return (
    <div data-component="edit-tool" data-variant="inline" data-tool={toolKey(tool.title)} data-status={tool.status} data-timeline-part-id={tool.id}>
      <div className="tool-collapsible" data-expanded={open ? "true" : undefined}>
        <button
          data-slot="collapsible-trigger"
          disabled={!expandable}
          onClick={() => expandable && setOpen((value) => !value)}
        >
          <div data-component="tool-trigger" data-clickable={expandable ? "true" : undefined}>
            <span data-slot="tool-status-icon" data-state={tool.status} aria-hidden="true">
              {tool.status === "running"
                ? <span className="spinner" />
                : <span className={`codicon codicon-${tool.status === "failed" ? "error" : "check"}`} />}
            </span>
            <div data-slot="basic-tool-tool-trigger-content">
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main" data-layout="edit">
                    <span data-slot="basic-tool-tool-title">
                      <TextShimmer text={titleCase(tool.title)} active={tool.status === "running"} />
                    </span>
                    <span data-slot="edit-tool-summary">
                      {path && (
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          className="clickable"
                          title={`${path} · open in editor`}
                          onClick={(event) => {
                            event.stopPropagation();
                            activatePath();
                          }}
                        >
                          {path}
                        </span>
                      )}
                      {(files.length > 1 || additions > 0 || deletions > 0) && (
                        <span data-slot="edit-tool-meta">
                          {files.length > 1 && <span data-slot="edit-tool-file-count">{files.length} files</span>}
                          {(additions > 0 || deletions > 0) && (
                            <span data-slot="edit-tool-stats">
                              {additions > 0 && <span data-slot="edit-stat-add">+{additions}</span>}
                              {deletions > 0 && <span data-slot="edit-stat-del">-{deletions}</span>}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <ToolState tool={tool} />
            {expandable && <span data-slot="collapsible-arrow" className="codicon codicon-chevron-down" />}
          </div>
        </button>
        {expandable && open && (
          <div data-slot="collapsible-content">
            {files.map((file) => (
              <div data-component="edit-tool-file" key={file.file}>
                {(files.length > 1 || file.status) && (
                  <div data-slot="edit-tool-file-head">
                    <span data-slot="edit-tool-file-path">{file.file}</span>
                    {file.status && <span data-slot="edit-tool-file-status">{file.status}</span>}
                    {(file.additions ?? 0) > 0 && <span data-slot="edit-stat-add">+{file.additions}</span>}
                    {(file.deletions ?? 0) > 0 && <span data-slot="edit-stat-del">-{file.deletions}</span>}
                  </div>
                )}
                {file.patch && <PatchDiff patch={file.patch} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolState({ tool }: { tool: ToolCallView }): ReactNode {
  if (tool.status === "success" && (tool.duration === undefined || tool.duration < 1000)) return null;
  const label = tool.status === "running"
    ? "Running"
    : tool.status === "failed"
      ? "Failed"
      : tool.duration !== undefined
        ? formatDuration(tool.duration)
        : "Done";
  return (
    <span data-slot="tool-state" data-state={tool.status}>
      {tool.status === "running" && <span data-slot="tool-state-pulse" aria-hidden="true" />}
      {label}
    </span>
  );
}

function ToolErrorCard({ tool, session }: { tool: ToolCallView; session: SessionInfo | null }): ReactNode {
  const { openFile, focusSession } = useStore();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const presentation = toolPresentation(tool);
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
      <div data-kind="tool-error-card" data-open={open ? "true" : "false"} className="tool-collapsible" data-expanded={open ? "true" : undefined}>
        <button data-slot="collapsible-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <div data-component="tool-trigger" data-clickable="true">
            <span data-slot="tool-status-icon" data-state="failed" aria-hidden="true"><span className="codicon codicon-error" /></span>
            <div data-slot="basic-tool-tool-trigger-content">
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
            <span data-slot="collapsible-arrow" className="codicon codicon-chevron-down" />
          </div>
        </button>
        {open && (
          <div data-slot="collapsible-content">
            <div data-slot="tool-error-card-content">
              <div data-slot="tool-error-card-copy">
                <button
                  data-slot="tool-error-card-copy-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    copy();
                  }}
                >
                  {copied ? "Copied" : "Copy error"}
                </button>
              </div>
              <div data-slot="tool-error-card-description">{body}</div>
            </div>
          </div>
        )}
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
  component,
  surface,
  id,
  title,
  agent,
  description,
  status,
  state,
  tone,
  childID,
  onOpen
}: {
  component: "task-tool-card" | "subagent-link-card";
  surface: "task-tool-surface" | "subagent-link-surface";
  id: string;
  title: string;
  agent: string;
  description: string;
  status: string;
  state: string;
  tone: "working" | "complete" | "failed";
  childID: string;
  onOpen: () => void;
}): ReactNode {
  const detail = description.trim() && description.trim() !== title.trim() ? description.trim() : "";
  return (
    <div data-component={component} data-state={state} data-timeline-part-id={id}>
      <button
        data-component={surface}
        className="delegated-agent-surface"
        disabled={!childID}
        aria-label={childID ? `Open delegated agent session: ${title}` : `Delegated agent: ${title}`}
        title={childID ? `Open ${title} session` : undefined}
        onClick={onOpen}
      >
        <span data-component={tone === "working" ? "task-tool-spinner" : tone === "failed" ? "subagent-link-state" : "task-tool-icon"}>
          {tone === "working" ? <SessionProgressIndicator /> : tone === "failed" ? <span className="codicon codicon-error" /> : <SubagentIcon />}
        </span>
        <span data-slot="delegated-agent-content">
          <span data-slot="delegated-agent-meta">
            <span data-component="task-tool-kind">Delegated agent</span>
            {agent && <span data-component="task-tool-agent">@{agent}</span>}
          </span>
          <span data-component="task-tool-title">{title}</span>
          {detail && <span data-slot="basic-tool-tool-subtitle">{detail}</span>}
        </span>
        <span data-slot="delegated-agent-tail">
          <span data-component="task-tool-status" data-status={tone} title={status}>
            <span data-slot="task-tool-status-dot" />
            <span data-slot="task-tool-status-label">{status}</span>
          </span>
          {childID && <span className="codicon codicon-chevron-right" data-slot="task-tool-open" />}
        </span>
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
  const agentName = resolved?.agent ?? configured?.name ?? requested;
  const title = resolved?.title.trim()
    ? resolved.title
    : agentName
      ? titleCase(agentName)
      : "Subagent";
  const detail = description || childSession;
  const subtitle = tool.metadata?.background === true && detail ? `${detail} (background)` : detail;
  const running = tool.status === "running";
  return <DelegatedAgentCard
    component="task-tool-card"
    surface="task-tool-surface"
    id={tool.id}
    title={title}
    agent={agentName}
    description={subtitle}
    status={running ? "Working" : tool.status === "failed" ? "Failed" : "Complete"}
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
  const statusLabel = state ? titleCase(state) : "Running";
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
    component="subagent-link-card"
    surface="subagent-link-surface"
    id={item.id}
    title={title}
    agent={agentName}
    description={detail}
    status={statusLabel}
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
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current || !output || tool.status !== "running") return;
    autoExpandedRef.current = true;
    setOpen(true);
  }, [output, tool.status]);
  const displayInput = input.length > OUTPUT_LIMIT ? `${input.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : input;
  const displayOutput = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : output;
  const shellInput = toolInput(tool);
  const shell = ["bash", "shell"].includes(effectiveToolKey(tool));
  const shellCommand = typeof shellInput.command === "string" ? shellInput.command : "";
  const shellText = `$ ${shellCommand}${displayOutput ? `\n\n${displayOutput}` : ""}`;
  const [copied, setCopied] = useState(false);
  const copyShell = (): void => {
    if (!shellText.trim()) return;
    void navigator.clipboard?.writeText(shellText).then(() => {
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
  if (tool.status === "failed") return <ToolErrorCard tool={tool} session={session} />;
  if (toolKey(tool.title) === "task" || toolKey(tool.title) === "subagent") return <TaskTool tool={tool} session={session} />;

  return (
    <div data-component="tool-part-wrapper" data-tool={effectiveToolKey(tool)} data-variant="inline" data-status={tool.status} data-timeline-part-id={tool.id}>
      <div className="tool-collapsible" data-expanded={open ? "true" : undefined}>
        <button
          data-slot="collapsible-trigger"
          disabled={!expandable}
          onClick={() => expandable && setOpen((value) => !value)}
        >
          <div data-component="tool-trigger" data-clickable={expandable ? "true" : undefined}>
            <span data-slot="tool-status-icon" data-state={tool.status} aria-hidden="true">
              {tool.status === "running"
                ? <span className="spinner" />
                : <span className="codicon codicon-check" />}
            </span>
            <div data-slot="basic-tool-tool-trigger-content">
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">
                      {presentation.title}
                    </span>
                    {presentation.subtitle && (
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
            <ToolState tool={tool} />
            {expandable && <span data-slot="collapsible-arrow" className="codicon codicon-chevron-down" />}
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
                  <button
                    data-slot="bash-copy-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyShell();
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre data-slot="bash-pre">{shellText}</pre>
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
    <div data-timeline-row={tag} className="opencode-row">
      <div data-component="session-turn">
        <div data-slot="session-turn-message-container">{children}</div>
      </div>
    </div>
  );
}

const THINKING_LABEL = "Thinking";

function SessionTurnThinking({ heading }: { heading?: string }): ReactNode {
  return (
    <TimelineRow tag="AssistantWorking">
      <div data-slot="session-turn-thinking" role="status" aria-live="polite">
        <TextShimmer text={THINKING_LABEL} tone="thinking" />
        {heading && <span data-slot="session-turn-thinking-heading">{heading}</span>}
      </div>
    </TimelineRow>
  );
}

function UserMessage({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }): ReactNode {
  return (
    <TimelineRow tag="UserMessage">
      <div data-slot="session-turn-message-content" aria-live="off">
        <div data-component="user-message">
          {item.attachments && item.attachments.length > 0 && (
            <div data-slot="user-message-attachments">
              {item.attachments.map((attachment) => (
                <div data-slot="user-message-attachment" data-type="file" key={attachment.name}>
                  <div data-slot="user-message-attachment-file">
                    <span className="codicon codicon-file" />
                    <span data-slot="user-message-attachment-name">{attachment.name}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div data-slot="user-message-body">
            <div data-slot="user-message-text">{item.text}</div>
          </div>
        </div>
      </div>
    </TimelineRow>
  );
}

// OpenCode hides reasoning parts by default (`showReasoningSummaries: false`); only the
// turn-level thinking heading reflects them. `ActivityPart` therefore excludes reasoning.
type RenderablePart = Exclude<AssistantPart, { kind: "reasoning" }>;
type ActivityPart = Extract<RenderablePart, { kind: "tool" }>;
type ActivityEntry = ActivityPart | { kind: "context-group"; id: string; tools: ToolCallView[] };

function isContextActivityPart(part: ActivityPart): part is Extract<ActivityPart, { kind: "tool" }> {
  return part.kind === "tool" && isContextTool(part.tool);
}

function groupContextParts(parts: ActivityPart[]): ActivityEntry[] {
  const grouped: ActivityEntry[] = [];
  let index = 0;
  while (index < parts.length) {
    const part = parts[index];
    if (!isContextActivityPart(part)) {
      grouped.push(part);
      index += 1;
      continue;
    }
    const context: Extract<ActivityPart, { kind: "tool" }>[] = [part];
    let cursor = index + 1;
    while (cursor < parts.length && isContextActivityPart(parts[cursor])) {
      context.push(parts[cursor] as Extract<ActivityPart, { kind: "tool" }>);
      cursor += 1;
    }
    grouped.push({ kind: "context-group", id: `context:${context[0].id}`, tools: context.map((entry) => entry.tool) });
    index = cursor;
  }
  return grouped;
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

function ContextToolGroup({ tools, session }: { tools: ToolCallView[]; session: SessionInfo | null }): ReactNode {
  const [open, setOpen] = useState(false);
  const summary = contextToolSummary(tools);
  const pending = tools.some((tool) => tool.status === "running");
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
          <span data-slot="collapsible-arrow" className="codicon codicon-chevron-down" />
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
  if (part.kind === "tool") return toolKey(part.tool.title) !== "todowrite";
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

function firstReasoningHeading(items: AssistantItem[]): string | undefined {
  for (const item of items) {
    for (const part of item.parts) {
      if (part.kind !== "reasoning" || !part.text) continue;
      const heading = reasoningHeading(part.text);
      if (heading) return heading;
    }
  }
  return undefined;
}

// OpenCode groups all assistant messages of a turn into one assistant part stream before
// folding context runs. Orbit renders a contiguous run of assistant transcript items through
// this component so context runs can span message boundaries.
function AssistantRun({
  items,
  streaming,
  session
}: {
  items: AssistantItem[];
  streaming: boolean;
  session: SessionInfo | null;
}): ReactNode {
  const { stageRevert } = useStore();
  const rows: ReactNode[] = [];
  const parts = items.flatMap((item) => item.parts);
  const visibleParts = items.flatMap((item) => item.parts
    .filter(renderableAssistantPart)
    .map((part) => ({ part, messageCompleted: item.completed })));
  const responseText = parts
    .filter((part): part is Extract<AssistantPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n");
  type ActivityGroup = { kind: "activity"; entries: ActivityPart[] };
  type TextGroup = { kind: "text"; part: Extract<AssistantPart, { kind: "text" }>; streaming: boolean };
  const groups: (ActivityGroup | TextGroup)[] = [];
  for (const { part, messageCompleted } of visibleParts) {
    if (part.kind === "text") {
      groups.push({ kind: "text", part, streaming: !messageCompleted });
      continue;
    }
    const lastGroup = groups.at(-1);
    if (lastGroup && lastGroup.kind === "activity") lastGroup.entries.push(part);
    else groups.push({ kind: "activity", entries: [part] });
  }
  const lastItem = items.at(-1);
  const revertMessageID = lastItem?.messageID;
  const showRevert = Boolean(session) && items.every((item) => item.completed) && !streaming
    && !items.some((item) => item.retry);
  const revert = session && revertMessageID ? () => void stageRevert(session.workspace, revertMessageID) : undefined;
  let previous = false;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const isLastGroup = groupIndex === groups.length - 1;
    if (group.kind === "text") {
      const showLabel = groupIndex === 0 || groups[groupIndex - 1]?.kind === "activity";
      rows.push(
        <TimelineRow tag="AssistantMessage" previous={previous} key={group.part.id}>
          <div data-slot="session-turn-assistant-content">
            <TextPart
              part={group.part}
              streaming={group.streaming}
              showLabel={showLabel}
              showRevert={showRevert && isLastGroup && Boolean(session)}
              onRevert={revert}
            />
          </div>
        </TimelineRow>
      );
      previous = true;
      continue;
    }
    rows.push(
      <TimelineRow tag="AssistantActivity" previous={previous} key={`activity:${group.entries[0]?.id ?? rows.length}`}>
        <div data-slot="session-turn-assistant-content" data-component="assistant-activity-stack">
          {groupContextParts(group.entries).map((part) => {
            if (part.kind === "context-group") {
              return (
                <div data-component="assistant-activity-entry" data-kind="context" data-state="complete" key={part.id}>
                  <span data-slot="assistant-activity-marker" aria-hidden="true"><span className="codicon codicon-check" /></span>
                  <div data-slot="assistant-activity-content"><ContextToolGroup tools={part.tools} session={session} /></div>
                </div>
              );
            }
            const running = part.tool.status === "running";
            const failed = part.tool.status === "failed";
            const marker = running ? "" : failed ? "codicon-error" : "codicon-check";
            return (
              <div data-component="assistant-activity-entry" data-kind={part.kind} data-state={running ? "running" : failed ? "failed" : "complete"} key={part.id}>
                <span data-slot="assistant-activity-marker" aria-hidden="true">
                  {marker ? <span className={`codicon ${marker}`} /> : <span data-slot="assistant-activity-pulse" />}
                </span>
                <div data-slot="assistant-activity-content">
                  {failed
                    ? <ToolErrorCard tool={part.tool} session={session} />
                    : isEditCardTool(part.tool)
                      ? <EditToolCard tool={part.tool} session={session} />
                      : <ToolPart tool={part.tool} session={session} />}
                </div>
              </div>
            );
          })}
          {showRevert && isLastGroup && session && (
            <div data-component="assistant-options-footer">
              <ResponseOptions text={responseText} showRevert onRevert={revert} />
            </div>
          )}
        </div>
      </TimelineRow>
    );
    previous = true;
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
          <div data-component="session-note" data-tone="error">
            <span className="codicon codicon-error" data-slot="session-note-icon" />
            <span data-slot="session-note-text">{item.error.replace(/^Error:\s*/, "")}</span>
          </div>
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
  session: SessionInfo | null
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let run: AssistantItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    nodes.push(
      <AssistantRun
        items={items}
        streaming={busy && items.some((item) => item.id === lastAssistantId)}
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
  const thinkingHeading = useMemo(() => firstReasoningHeading(activeAssistants), [activeAssistants]);
  const activeTurnError = activeAssistants.some((item) => Boolean(item.error));
  const activeTurnRetry = activeAssistants.some((item) => Boolean(item.retry));
  const showThinking = busy && !activeTurnError && !activeTurnRetry;

  return (
    <div data-slot="session-turn-list" className="opencode-timeline">
      {turns.map((turn, index) => {
        return (
          <div data-component="session-turn-group" key={turn.id}>
            {turn.user && index > 0 && <div data-timeline-row="TurnGap" aria-hidden="true" />}
            {turn.user && <UserMessage item={turn.user} />}
            {renderTurnBody(turn.body, busy, lastAssistantId, activeSession)}
          </div>
        );
      })}
      {showThinking && <SessionTurnThinking heading={thinkingHeading} />}
    </div>
  );
});
