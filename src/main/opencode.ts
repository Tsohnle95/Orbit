import { execFile, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { constants, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { shell } from "electron";
import { OpenCode } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { LatestGeneration, sameWorkspace } from "@shared/generation";
import type {
  AssistantPartView,
  AgentOption,
  CommandOption,
  ExternalKind,
  ExternalOpenResult,
  FileWriteIdentity,
  FileBaseline,
  ImportResult,
  OpenFileWorkspaceResult,
  PendingPermissionRequest,
  PermissionReply,
  ProjectInfo,
  FormAnswers,
  PendingFormRequest,
  PromptDelivery,
  PromptFile,
  SessionInboxEntry,
  McpServerOption,
  PluginOption,
  SkillOption,
  SessionRevertStage,
  ProviderCredentialAnswers,
  ProviderFormField,
  ProviderIntegration,
  ProviderOAuthAttempt,
  ProviderOAuthPoll,
  ProviderUsageResult,
  ReferenceOption,
  RecoveryRecord,
  ReopenedSession,
  RuntimeID,
  RuntimeManifest,
  OpenCodeSyncResult,
  SessionInfo,
  SessionSelection,
  SessionSummary,
  SessionTranscript,
  SessionUsage,
  TodoItem,
  ToolContentView,
  ToolCallView,
  TranscriptItem,
  TreeEntry,
  ModelOption
} from "@shared/types";
import {
  disposableSession,
  expiredSession,
  hasConversation,
  retainOutput,
  retainToolContent,
  SESSION_RETENTION_MS,
  type SessionTokenUsage
} from "@shared/retention";
import type { WorkspaceIdentity } from "@shared/types";
import { fetchProviderUsage } from "./provider-usage";
import { WorkspaceOperationCoordinator } from "./operation-coordinator";
import { BackendEventLoop } from "./backend-event-loop";
import { createStreamPipeline, type RawStreamEvent } from "./stream-pipeline";
import { knownBaseline, observedBaseline, preserveBaseline, unknownBaseline } from "./file-baseline";
import { movePathToTrash } from "./trash";
import {
  assertPermissionSession,
  assertWorkspaceTarget,
  captureWorkspaceTarget,
  type ActiveWorkspaceTarget
} from "./workspace-target";
import {
  absoluteFilePath,
  absoluteFilePaths,
  assertWorkspace,
  canonicalWorkspaceRoot,
  confinedPath,
  fileContent,
  fileName,
  MAX_WORKSPACE_FILE_BYTES,
  relativePath
} from "./workspace-security";
import { resolvePtyDirectory } from "./pty-directory";
import type { RuntimeAdapter } from "./runtimes/runtime-adapter";
import { tuiCommandForRuntime } from "./tui-command";
import type { TerminalCommand } from "./terminal";
import { RuntimeSessionIndex } from "./runtimes/runtime-session-index";
import { normalizePendingForm } from "@shared/forms";
import { formatFailure, normalizeFailure } from "@shared/errors";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo", ".nx",
  ".svn", ".hg", ".idea", ".vscode", ".openshell-recovery", "dist", "out", "build", "target", "coverage", ".pytest_cache",
  ".opencode", ".claude", ".cursor", ".aider", ".windsurf", ".codeium", ".roo", ".gemini", ".kilocode", ".continue"
]);

const MAX_WATCHED_FILE_BYTES = 2 * 1024 * 1024;

const RECOVERY_DIR = ".openshell-recovery";

const RECOVERY_SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;
const RECOVERY_INTERRUPTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const BUILTIN_COMMANDS: {
  name: string;
  description: string;
  run: (client: Client, sessionID: string) => Promise<unknown>;
}[] = [
  {
    name: "compact",
    description: "Summarize the session to free up context",
    run: (client, sessionID) => client.session.compact({ sessionID })
  },
  {
    name: "compress",
    description: "Alias of /compact — summarize the session to free up context",
    run: (client, sessionID) => client.session.compact({ sessionID })
  }
];

interface RecoveryTransaction {
  version: 1;
  id: string;
  operation: "save" | "rename";
  originalPath: string;
  targetPath?: string;
  createdAt: number;
  phase: "initialized" | "temporary-ready" | "source-held" | "held-validated" | "target-installed" | "failed" | "complete";
  acknowledged: string[];
  reason?: RecoveryRecord["reason"];
}

function modelID(model: { id?: string; modelID?: string }): string {
  return model.id ?? model.modelID ?? "";
}

function variantIDs(variants: unknown): string[] {
  if (!Array.isArray(variants)) return [];
  return variants
    .map((variant) => typeof variant === "string" ? variant : (variant as { id?: string })?.id ?? "")
    .filter(Boolean);
}

function collectFilePaths(obj: unknown): string[] {
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if ((k === "filePath" || k === "file_path" || k === "path") && typeof v === "string" && !v.startsWith("http")) {
        out.push(v);
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(obj);
  return [...new Set(out)];
}

function toolDetailText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.filePath === "string") return o.filePath;
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.command === "string") return `$ ${o.command}`;
  return "";
}

function toolInputText(input: unknown): string {
  if (input == null) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolTitleText(input: unknown, name: string): string {
  if (name) return name;
  if (!input || typeof input !== "object") return "tool";
  const o = input as Record<string, unknown>;
  if (typeof o.tool === "string" && o.tool) return o.tool;
  if ("command" in o) return "bash";
  if ("filePath" in o || "file_path" in o) return "file";
  if ("query" in o) return "search";
  if ("url" in o) return "web";
  if ("prompt" in o) return "prompt";
  return "tool";
}

function toolContentText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string })?.type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("\n");
}

function toolContentViews(content: unknown): ToolContentView[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const items = content.flatMap((raw): ToolContentView[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (item.type === "text") return [{ type: "text", text: String(item.text ?? "") }];
    if (item.type !== "file" || typeof item.uri !== "string" || typeof item.mime !== "string") return [];
    return [{
      type: "file",
      uri: item.uri,
      mime: item.mime,
      ...(typeof item.name === "string" ? { name: item.name } : {})
    }];
  });
  return items.length > 0 ? items : undefined;
}

function eventSessionID(...values: unknown[]): string | undefined {
  const pending = [...values];
  const seen = new Set<unknown>();
  for (let depth = 0; pending.length > 0 && depth < 16; depth += 1) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const source = value as Record<string, unknown>;
    for (const key of ["sessionID", "sessionId"]) {
      if (typeof source[key] === "string" && source[key]) return source[key] as string;
    }
    // `form` holds the true session for form.created, which unlike
    // form.replied/cancelled has no top-level sessionID.
    for (const key of ["data", "properties", "info", "part", "message", "error", "form"]) {
      if (source[key] && typeof source[key] === "object") pending.push(source[key]);
    }
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function replayToolCard(part: Record<string, unknown>): ToolCallView {
  const state = (part.state ?? {}) as Record<string, unknown>;
  const input = state.input;
  const status = ["completed", "success"].includes(String(state.status))
    ? "success"
    : ["error", "failed", "aborted", "timeout", "cancelled"].includes(String(state.status))
      ? "failed"
      : "running";
  const time = (part.time ?? state.time ?? {}) as Record<string, number | undefined>;
  const ran = time.ran ?? time.created ?? Date.now();
  const completed = time.completed;
  return {
    id: String(part.callID ?? part.id),
    title: toolTitleText(input, String(part.name ?? part.tool ?? "")),
    detail: toolDetailText(input),
    status,
    input: toolInputText(input),
    output: retainOutput(
      toolContentText(state.content as unknown[] | undefined) ||
      (state.error !== undefined
        ? formatFailure(state.error, "ORBIT_TOOL_FAILED", "Tool failed")
        : String(state.output ?? ""))
    ),
    startedAt: time.created ?? Date.now(),
    duration: completed ? Math.max(0, completed - ran) : undefined,
    paths: collectFilePaths(input),
    metadata: record(state.metadata),
    inputValue: input,
    content: retainToolContent(toolContentViews(state.content)),
    ...(typeof part.executed === "boolean" ? { executed: part.executed } : {}),
    providerState: record(part.providerState),
    providerResultState: record(part.providerResultState)
  };
}

function todoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content : "";
    const rawStatus = typeof item.status === "string" ? item.status : "pending";
    const status = ["pending", "in_progress", "completed", "cancelled"].includes(rawStatus)
      ? rawStatus as TodoItem["status"]
      : "pending";
    if (!content) return [];
    return [{
      id: typeof item.id === "string" && item.id ? item.id : `todo-${index}`,
      content,
      status,
      ...(typeof item.priority === "string" ? { priority: item.priority } : {})
    }];
  });
}

function replayTodos(messages: unknown[]): TodoItem[] {
  let result: TodoItem[] = [];
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const info = (msg.info ?? msg) as Record<string, unknown>;
    const parts = Array.isArray(msg.parts)
      ? msg.parts as Record<string, unknown>[]
      : Array.isArray(info.content)
        ? info.content as Record<string, unknown>[]
        : [];
    for (const part of parts) {
      const name = String(part.tool ?? part.name).toLowerCase().replace(/[^a-z]/g, "");
      if (part.type !== "tool" || name !== "todowrite") continue;
      const state = part.state && typeof part.state === "object"
        ? part.state as Record<string, unknown>
        : {};
      const metadata = state.metadata && typeof state.metadata === "object"
        ? state.metadata as Record<string, unknown>
        : {};
      const input = state.input && typeof state.input === "object"
        ? state.input as Record<string, unknown>
        : {};
      const next = todoItems(metadata.todos ?? input.todos);
      if (next.length > 0) result = next;
    }
  }
  return result;
}

export function replayTranscript(messages: unknown[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const info = (msg.info ?? msg) as Record<string, unknown>;
    const parts = Array.isArray(msg.parts) ? (msg.parts as Record<string, unknown>[]) : [];
    const type = info.type ?? info.role;
    if (type === "user") {
      const text = String(
        info.text ?? parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
      );
      const files = Array.isArray(info.files) ? info.files as Record<string, unknown>[] : [];
      const attachments = files.flatMap((file): { name: string }[] =>
        typeof file.name === "string" && file.name ? [{ name: file.name }] : []
      );
      if (text.trim()) {
        out.push({
          kind: "user",
          id: String(info.id),
          text,
          ...(attachments.length > 0 ? { attachments } : {})
        });
      }
      continue;
    }
    if (type === "agent-switched") {
      out.push({
        kind: "selection",
        id: String(info.id),
        selection: "agent",
        title: "Agent switched",
        detail: String(info.agent ?? "")
      });
      continue;
    }
    if (type === "model-switched") {
      const model = record(info.model);
      const id = String(model?.id ?? "");
      const provider = String(model?.providerID ?? "");
      out.push({
        kind: "selection",
        id: String(info.id),
        selection: "model",
        title: "Model switched",
        detail: [provider, id].filter(Boolean).join(" / ")
      });
      continue;
    }
    if (type === "synthetic") {
      out.push({
        kind: "synthetic",
        id: String(info.id),
        text: String(info.text ?? ""),
        ...(typeof info.description === "string" ? { description: info.description } : {})
      });
      continue;
    }
    if (type === "system") {
      out.push({ kind: "system", id: String(info.id), text: String(info.text ?? "") });
      continue;
    }
    if (type === "skill") {
      out.push({
        kind: "skill",
        id: String(info.id),
        skill: String(info.skill ?? ""),
        name: String(info.name ?? info.skill ?? "Skill"),
        text: String(info.text ?? "")
      });
      continue;
    }
    if (type === "shell") {
      const output = record(info.output);
      const status = ["running", "exited", "timeout", "killed"].includes(String(info.status))
        ? String(info.status) as "running" | "exited" | "timeout" | "killed"
        : "running";
      out.push({
        kind: "shell",
        id: String(info.id),
        shellID: String(info.shellID ?? info.id),
        command: String(info.command ?? ""),
        status,
        ...(typeof output?.output === "string" ? { output: retainOutput(output.output) } : {}),
        ...(["number", "string"].includes(typeof info.exit) ? { exit: info.exit as number | string } : {})
      });
      continue;
    }
    if (type === "assistant") {
      const content = parts.length > 0
        ? parts
        : Array.isArray(info.content) ? (info.content as Record<string, unknown>[]) : [];
      const completed = Boolean(
        (info.time as Record<string, unknown> | undefined)?.completed ?? info.finish ?? info.error
      );
      const assistantParts = content.flatMap((part, index): AssistantPartView[] => {
        const id = String(part.id ?? `${String(info.id)}:${String(part.type)}:${index}`);
        if (part.type === "text" || part.type === "reasoning") {
          const time = (part.time ?? {}) as Record<string, unknown>;
          return [{
            kind: part.type,
            id,
            text: String(part.text ?? ""),
            complete: Boolean(time.end ?? time.completed ?? completed)
          }];
        }
        if (part.type === "tool") return [{ kind: "tool", id, tool: replayToolCard(part) }];
        return [];
      });
      if (assistantParts.length > 0 || !completed || info.retry || info.error) {
        out.push({
          kind: "assistant",
          id: String(info.id),
          messageID: String(info.id),
          parts: assistantParts,
          completed,
          ...(info.retry && typeof info.retry === "object"
            ? {
                retry: {
                  attempt: Number((info.retry as Record<string, unknown>).attempt ?? 1),
                  message: formatFailure(
                    (info.retry as Record<string, unknown>).error,
                    "ORBIT_RETRY_SCHEDULED",
                    "Retrying"
                  ),
                  next: Number((info.retry as Record<string, unknown>).at ?? 0) || undefined
                }
              }
            : {}),
          ...(info.error ? { error: formatFailure(info.error, "ORBIT_ASSISTANT_FAILED", "Assistant failed") } : {})
        });
      }
      continue;
    }
    if (type === "compaction") {
      const status = ["running", "completed", "failed"].includes(String(info.status))
        ? String(info.status) as "running" | "completed" | "failed"
        : "completed";
      out.push({
        kind: "compaction",
        id: String(info.id),
        status,
        reason: info.reason === "manual" ? "manual" : "auto",
        summary: String(info.summary ?? ""),
        ...(typeof info.recent === "string" ? { recent: info.recent } : {}),
        ...(info.error ? { error: formatFailure(info.error, "ORBIT_COMPACTION_FAILED", "Compaction failed") } : {})
      });
    }
  }
  return out;
}

type Client = ReturnType<typeof OpenCode.make>;

function isAcceptedNoContentInterrupt(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { reason?: unknown; cause?: unknown };
  if (value.reason !== "UnexpectedStatus" || !value.cause || typeof value.cause !== "object") return false;
  return (value.cause as { status?: unknown }).status === 204;
}

interface WatchContext {
  root: string;
  sessionID: string;
  workspace: WorkspaceIdentity;
  snapshots: Map<string, FileBaseline>;
  lastKnown: Map<string, string>;
  hasGit: boolean | null;
  gitRoot?: string | null;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  identities?: Map<string, string>;
  deletedPaths?: Set<string>;
  recentMoves?: Map<string, number>;
  importing?: number;
  suppressedUntil?: Map<string, number>;
}

export interface SessionContext {
  workspace: WorkspaceIdentity;
  sessionID: string;
  directory: string;
  sessionInfo: SessionInfo;
  watchContext: WatchContext;
  watcher: FSWatcher | null;
  activations: LatestGeneration;
  runtime?: RuntimeAdapter | null;
}

export type MutationPhase =
  | "save:temporary-ready"
  | "save:source-held"
  | "save:held-validated"
  | "save:target-installed"
  | "rename:source-inspected"
  | "rename:source-held"
  | "rename:target-installed";

type MutationPhaseHandler = (phase: MutationPhase, source: string, target: string) => void | Promise<void>;

/** Parse the semantic-version major from an OpenCode CLI or service version. */
export function serverMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = /(?:^|[^\d])v?(\d+)\.\d+\.\d+(?=$|[^\d])/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

function exactServerVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const match = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^\d])/.exec(version.trim());
  return match?.[1] ?? null;
}

export const MIN_SUPPORTED_SERVER_MAJOR = 2;

/** Providers Orbit surfaces in Settings, in display order. Every other
 *  integration the runtime catalog reports stays hidden. Command Code ships as
 *  a community plugin and plugin releases have registered both `commandcode`
 *  and `command-code` as the auth provider id, so both are accepted. */
export const SUPPORTED_PROVIDER_IDS = ["opencode-go", "command-code", "commandcode", "openai"];

/** Keep the V2 API contract boundary: allow V2 patch/minor updates, but never
 *  connect this client to V1 or legacy beta services. */
export function serverVersionPredicate(installedVersion: string | null): (version: string) => boolean {
  const installedMajor = serverMajor(installedVersion);
  return (version) => {
    if (serverMajor(version) !== MIN_SUPPORTED_SERVER_MAJOR) return false;
    return installedMajor === null || installedMajor === MIN_SUPPORTED_SERVER_MAJOR;
  };
}

export class OpenShellBackend {
  private client: Client | null = null;
  private endpoint: Endpoint | null = null;
  private serviceFile: string | undefined = undefined;
  private updatingOpenCode = false;
  private readonly contexts = new Map<string, SessionContext>();
  private primary: string | null = null;
  private listeners = new Set<(msg: unknown) => void>();
  private stopped = false;
  private readonly eventLoop = new BackendEventLoop();
  private readonly activations = new LatestGeneration();
  private readonly mutations = new WorkspaceOperationCoordinator();
  private lastEnsureAt = 0;
  private readonly ensureCooldownMs = 30_000;
  private lastPruneAt = 0;
  private pruning = false;
  private readonly pruneCooldownMs = 24 * 60 * 60 * 1000;
  private streamConnectedOnce = false;
  private readonly runtimeAdapters = new Map<string, RuntimeAdapter>();
  private readonly runtimeSubscriptions = new Map<string, AbortController>();

  constructor(
    private readonly mutationPhase: MutationPhaseHandler = () => {},
    private readonly runtimeFactory?: (runtimeID: RuntimeID, directory: string) => RuntimeAdapter,
    private readonly runtimeSessionIndex = new RuntimeSessionIndex()
  ) {}

  onMessage(cb: (msg: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(msg: unknown): void {
    for (const cb of this.listeners) cb(msg);
  }

  private contextFor(expected: WorkspaceIdentity): SessionContext {
    assertWorkspace(expected, this.contexts.get(expected.id)?.workspace ?? null);
    const context = this.contexts.get(expected.id);
    if (!context || !sameWorkspace(expected, context.workspace)) throw new Error("stale workspace");
    return context;
  }

  private currentContext(context: SessionContext): boolean {
    return this.contexts.get(context.workspace.id) === context;
  }

  private contextBySessionID(sessionID: string): SessionContext | null {
    for (const context of this.contexts.values()) {
      if (context.sessionID === sessionID) return context;
    }
    return null;
  }

  private primaryContext(): SessionContext | null {
    return this.primary ? (this.contexts.get(this.primary) ?? null) : null;
  }

  private workspaceRoot(expected: WorkspaceIdentity): string {
    return this.contextFor(expected).directory;
  }

  private activeTarget(workspace: WorkspaceIdentity): ActiveWorkspaceTarget {
    const context = this.contextFor(workspace);
    return captureWorkspaceTarget(workspace, {
      workspace: context.workspace,
      sessionID: context.sessionID,
      directory: context.directory
    });
  }

  private assertTarget(target: ActiveWorkspaceTarget): void {
    const context = this.contextFor(target.workspace);
    assertWorkspaceTarget(target, {
      workspace: context.workspace,
      sessionID: context.sessionID,
      directory: context.directory
    });
  }

  beginActivation(requestGeneration: number): number {
    if (!Number.isSafeInteger(requestGeneration) || requestGeneration < 1) {
      throw new Error("invalid activation generation");
    }
    return this.activations.accept();
  }

  private static discoverFiles(): string[] {
    if (process.platform !== "darwin") return [];
    const desktop = path.join(homedir(), "Library", "Application Support", "ai.opencode.desktop", "opencode", "service.json");
    return [desktop];
  }

  private static streamFailureLimit = 3;

  private static serverVersionPredicate(installedVersion: string | null): (version: string) => boolean {
    return serverVersionPredicate(installedVersion);
  }

  /** Version of the V2 `opencode` on PATH, or null when it cannot be probed. */
  private async installedServerVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("opencode", ["--version"], { timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : stdout.trim().split("\n")[0]?.trim() || null);
      });
    });
  }

  private async discoverEndpoint(version: (value: string) => boolean): Promise<{ endpoint: Endpoint; file?: string } | null> {
    const files = [undefined, ...OpenShellBackend.discoverFiles()];
    for (const file of files) {
      const endpoint = await Service.discover({ ...(file ? { file } : {}), version }).catch(() => null);
      if (endpoint) return { endpoint, ...(file ? { file } : {}) };
    }
    return null;
  }

  async connect(): Promise<boolean> {
    const version = OpenShellBackend.serverVersionPredicate(await this.installedServerVersion());
    const existing = await this.discoverEndpoint(version);
    const endpoint = existing?.endpoint ?? (await this.ensureBounded(version));
    if (!endpoint) return false;
    this.endpoint = endpoint;
    this.serviceFile = existing?.file;
    this.client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint)
    });
    this.scheduleRetentionPrune();
    return true;
  }

  async syncOpenCode(): Promise<OpenCodeSyncResult> {
    return this.manageOpenCode(false);
  }

  async updateOpenCode(): Promise<OpenCodeSyncResult> {
    return this.manageOpenCode(true);
  }

  private async installedOpenCodeVersion(): Promise<string> {
    const version = exactServerVersion(await this.installedServerVersion());
    if (!version) throw new Error("OpenCode was not found on Orbit's PATH. Install it or correct Orbit's PATH, then try again.");
    return version;
  }

  private async runOpenCodeUpgrade(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("opencode", ["upgrade"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      const appendTail = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(-12000);
      child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("OpenCode's updater timed out after five minutes."));
      }, 5 * 60 * 1000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Could not run OpenCode's updater: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(`${stdout}\n${stderr}`);
          return;
        }
        const detail = (stderr.trim() || stdout.trim()).slice(-2400);
        reject(new Error(detail || `OpenCode's updater exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`));
      });
    });
  }

  private async ensureExactOpenCodeVersion(version: string, file: string | undefined): Promise<Endpoint> {
    const ensure = Service.ensure({
      command: ["opencode", "serve", "--service"],
      version,
      ...(file ? { file } : {})
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ensure,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for the synced OpenCode service to start.")), 60_000);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async manageOpenCode(update: boolean): Promise<OpenCodeSyncResult> {
    if (this.updatingOpenCode) throw new Error("An OpenCode update or sync is already in progress.");
    this.updatingOpenCode = true;
    try {
      const previousVersion = await this.installedOpenCodeVersion();
      const upgradeOutput = update ? await this.runOpenCodeUpgrade() : "";
      const version = await this.installedOpenCodeVersion();
      if (update && version === previousVersion && /may be managed by a package manager|install anyways\?/i.test(upgradeOutput)) {
        throw new Error("OpenCode could not identify its install method. Update it through its package manager, then use Sync installed version.");
      }
      if (serverMajor(version) !== MIN_SUPPORTED_SERVER_MAJOR) {
        throw new Error(`OpenCode ${version} is installed, but Orbit currently requires OpenCode V2.`);
      }

      const serviceFile = this.serviceFile;
      const resumeEventLoop = this.eventLoop.active();
      if (resumeEventLoop) await this.eventLoop.stop();
      this.client = null;
      this.endpoint = null;
      try {
        const endpoint = await this.ensureExactOpenCodeVersion(version, serviceFile);
        this.endpoint = endpoint;
        this.serviceFile = serviceFile;
        this.client = OpenCode.make({
          baseUrl: endpoint.url,
          headers: Service.headers(endpoint)
        });
        this.scheduleRetentionPrune();
        this.emit({ kind: "event", type: "server.connected", data: {} });
      } finally {
        if (resumeEventLoop && !this.stopped) this.start();
      }
      return { version, previousVersion, cliUpdated: version !== previousVersion };
    } finally {
      this.updatingOpenCode = false;
    }
  }

  /**
   * Connection details for the shared global OpenCode daemon, so the mobile
   * server can attach to the same backend and share sessions with the desktop.
   */
  mobileEndpoint(): { url: string; username: string; password: string } | null {
    const endpoint = this.endpoint;
    if (!endpoint) return null;
    return {
      url: endpoint.url,
      username: endpoint.auth?.username ?? "opencode",
      password: endpoint.auth?.password ?? ""
    };
  }

  private scheduleRetentionPrune(): void {
    if (this.pruning || Date.now() - this.lastPruneAt < this.pruneCooldownMs) return;
    this.lastPruneAt = Date.now();
    this.pruning = true;
    void this.pruneExpiredSessions()
      .catch(() => {})
      .finally(() => {
        this.pruning = false;
      });
  }

  private async pruneExpiredSessions(): Promise<number> {
    if (!this.client) return 0;
    const now = Date.now();
    let removed = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const res = await this.client.session.list({ limit: 100, order: "asc", ...(cursor ? { cursor } : {}) });
      const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
      for (const s of arr as Array<{
        id?: string;
        title?: string;
        tokens?: SessionTokenUsage;
        time?: { updated?: number; created?: number };
      }>) {
        if (!s.id || this.contextBySessionID(s.id)) continue;
        if (!expiredSession(s.time, now) && !disposableSession(s.time, s.title, s.tokens, now)) continue;
        await this.client.session.remove({ sessionID: s.id }).then(() => {
          removed += 1;
        }).catch(() => {});
      }
      const next = Array.isArray(res) ? undefined : (res as { cursor?: { next?: string | null } }).cursor?.next;
      if (!next) break;
      cursor = next;
    }
    return removed;
  }

  private async ensureBounded(version: (value: string) => boolean): Promise<Endpoint | null> {
    if (Date.now() - this.lastEnsureAt < this.ensureCooldownMs) return null;
    this.lastEnsureAt = Date.now();
    const attempt = Service.ensure({
      command: ["opencode", "serve", "--service"],
      version
    }).catch(() => null);
    const timeout = sleep(10_000).then(() => null);
    return Promise.race([attempt, timeout]);
  }

  start(): void {
    this.stopped = false;
    this.eventLoop.start(
      (signal, generation) => this.runEventLoop(signal, generation),
      (error) => this.emit({
        kind: "event",
        type: "global.error",
        data: { error: normalizeFailure(error, "ORBIT_EVENT_LOOP_FAILED", "Background event loop failed") }
      })
    );
  }

  private startRuntimeSubscription(sessionID: string, runtime: RuntimeAdapter): void {
    if (this.runtimeSubscriptions.has(sessionID)) return;
    const controller = new AbortController();
    this.runtimeSubscriptions.set(sessionID, controller);
    void (async () => {
      try {
        for await (const envelope of runtime.subscribe(controller.signal)) {
          if (controller.signal.aborted) break;
          const event = envelope.event;
          const targetSessionID = envelope.sessionID ?? sessionID;
          if (event.type === "execution.started") {
            this.emit({ kind: "event", type: "session.execution.started", data: { sessionID: targetSessionID } });
          } else if (event.type === "execution.idle") {
            this.emit({ kind: "event", type: "server.connected", data: {} });
            this.emit({ kind: "event", type: "session.idle", data: { sessionID: targetSessionID } });
          } else if (event.type === "execution.error") {
            this.emit({ kind: "event", type: "server.connected", data: {} });
            this.emit({
              kind: "event",
              type: "session.error",
              data: {
                sessionID: targetSessionID,
                error: { code: event.code ?? "ORBIT_RUNTIME_EXECUTION_FAILED", message: event.message }
              }
            });
          } else if (event.type === "stream.event") {
            this.emit({
              kind: "event",
              type: event.eventType,
              data: {
                id: envelope.eventID,
                created: event.created,
                data: { ...event.data, sessionID: targetSessionID }
              }
            });
          } else if (event.type === "transcript.changed") {
            this.emit({ kind: "event", type: "server.connected", data: {} });
          } else if (event.type === "todo.updated") {
            this.emit({ kind: "event", type: "todo.updated", data: { sessionID: targetSessionID, todos: event.todos } });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const failure = normalizeFailure(error, "ORBIT_RUNTIME_STREAM_FAILED", "Runtime event stream failed");
          this.emit({ kind: "event", type: "session.error", data: { sessionID, error: failure } });
        }
      } finally {
        if (this.runtimeSubscriptions.get(sessionID) === controller) this.runtimeSubscriptions.delete(sessionID);
      }
    })();
  }

  private async runEventLoop(signal: AbortSignal, generation: number): Promise<void> {
    const pipeline = createStreamPipeline({
      subscribe: (attemptSignal) => this.subscribeEvents(attemptSignal, generation),
      onEvents: (directory, events) => this.deliverEvents(directory, events, generation),
      onReconnect: () => this.handleStreamReconnect(),
      onStreamError: (reason) => this.handleStreamError(reason),
      onStreamFailure: (failures) => this.handleStreamFailure(failures),
      onStreamEnd: () => {
        // The SSE stream ended (cleanly or via heartbeat abort). Emit
        // server.connected so the renderer re-materializes session state
        // from the service, recovering any terminal events (e.g.
        // session.execution.succeeded) that were lost when the stream
        // went silent mid-response.
        this.emit({ kind: "event", type: "server.connected", data: {} });
      }
    });
    await pipeline.run(signal);
  }

  /** A stream delivered its first event, so it is live: unless this is the
   *  first connection, ask the renderer to re-materialize open sessions (a
   *  reconnect may have missed terminal events). The pipeline only calls this
   *  for streams that actually delivered an event, and it resets its own
   *  failure streak when it does. */
  private handleStreamReconnect(): void {
    if (!this.streamConnectedOnce) {
      this.streamConnectedOnce = true;
      return;
    }
    this.emit({ kind: "event", type: "server.connected", data: {} });
  }

  /** One call per failed subscription attempt, carrying the streak length.
   *  Once the streak reaches the limit the bound client is talking to a dead
   *  or replaced service; drop it so the next attempt re-runs connect() and
   *  discovers or ensures a live service instead of retrying the dead
   *  endpoint until an app restart. A stream that delivers an event resets the
   *  streak (see stream-pipeline), so transient reconnects never drop it. */
  private handleStreamFailure(failures: number): void {
    if (failures >= OpenShellBackend.streamFailureLimit && this.client) {
      this.client = null;
    }
  }

  /** One call per outage episode (the pipeline de-duplicates retries within a
   *  single outage): surface it so a failed run cannot disappear. */
  private handleStreamError(reason: string): void {
    this.emit({
      kind: "event",
      type: "global.error",
      data: { error: normalizeFailure(reason, "ORBIT_STREAM_FAILED", "Live event stream failed") }
    });
  }

  private async subscribeEvents(
    signal: AbortSignal,
    generation: number
  ): Promise<AsyncIterable<RawStreamEvent>> {
    while (!this.stopped && this.eventLoop.current(generation)) {
      if (!this.client && !(await this.connect())) {
        if (!this.eventLoop.current(generation)) break;
        await sleep(2000, signal);
        continue;
      }
      if (!this.eventLoop.current(generation)) break;
      return this.client!.event.subscribe({ signal });
    }
    throw Object.assign(new Error("stream aborted"), { name: "AbortError" });
  }

  private async deliverEvents(
    _directory: string,
    events: RawStreamEvent[],
    generation: number
  ): Promise<void> {
    for (const evt of events) {
      if (this.stopped || !this.eventLoop.current(generation)) return;
      const typed = evt as {
        type?: string;
        event?: string;
        data?: unknown;
        properties?: unknown;
        location?: { directory?: string };
      };
      const type = typed.type ?? typed.event ?? "unknown";
      const eventData = typed.data ?? typed.properties;
      let forwardedEvent: RawStreamEvent = evt;
      // The global daemon is shared with external `opencode` terminal
      // sessions. Interactive prompts for sessions Orbit never opened must
      // not reach the renderer, where they would otherwise be misattributed
      // to the focused panel. (Child/subagent transcript streams still flow;
      // the renderer keeps them in separate stored state.)
      if (type === "form.created" || type === "form.replied" || type === "form.cancelled") {
        const ownerID = eventSessionID(eventData, evt, typed.location);
        if (!ownerID || !this.contextBySessionID(ownerID)) {
          // A form can be raised by a session Orbit never opened: a delegated
          // child session, a location-scoped "global" form, or an external
          // `opencode` TUI sharing the directory. Route it to the panels for
          // that location so the prompt is answerable in the GUI rather than
          // living only in the terminal. Sessions outside every open
          // workspace still have no matching location and are dropped.
          const ownerSessionIDs = await this.sessionIDsAtLocation(typed.location);
          if (ownerSessionIDs.length === 0) continue;
          forwardedEvent = { ...evt, orbitSessionIDs: ownerSessionIDs } as RawStreamEvent;
        }
      } else if (
        type === "permission.asked" || type === "permission.replied" ||
        type === "permission.v2.asked" || type === "permission.v2.replied" ||
        type === "session.inbox.enqueued" || type === "session.inbox.delivered" ||
        type === "session.inbox.cancelled"
      ) {
        const ownerID = eventSessionID(eventData, evt, typed.location);
        if (!ownerID || !this.contextBySessionID(ownerID)) continue;
      }
      this.emit({ kind: "event", type, data: forwardedEvent });
      try {
        await this.handleServerEvent(type, eventData, typed.location);
      } catch (error) {
        const failure = normalizeFailure(error, "ORBIT_EVENT_HANDLER_FAILED", `Failed handling ${type}`);
        const sessionID = eventSessionID(eventData, evt, typed.location);
        const data = { error: { ...failure, message: `${type}: ${failure.message}` }, eventType: type };
        this.emit(sessionID
          ? { kind: "event", type: "session.error", data: { sessionID, ...data } }
          : { kind: "event", type: "global.error", data });
      }
      if (!this.eventLoop.current(generation)) return;
    }
  }

  private async handleServerEvent(
    type: string,
    data: unknown,
    location?: { directory?: string }
  ): Promise<void> {
    if (type === "session.tool.called") {
      const input = (data as { input?: unknown }).input;
      const sessionID = (data as { sessionID?: string }).sessionID;
      const context = sessionID ? this.contextBySessionID(sessionID) : null;
      if (context) await this.snapshotInputs(context, input);
    } else if (type === "filesystem.changed") {
      const f = data as { file: string; event: "add" | "change" | "unlink" };
      if (typeof f?.file !== "string") return;
      const reportedRoot = typeof location?.directory === "string"
        ? await this.reportedRoot(location.directory)
        : null;
      if (!reportedRoot) return;
      for (const context of this.contexts.values()) {
        if (reportedRoot !== context.directory) continue;
        const abs = this.abs(f.file, context.directory);
        const rel = path.relative(context.directory, abs);
        if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        await this.onFsChanged(context.watchContext, abs, f.event);
      }
    }
  }

  private readonly reportedRoots = new Map<string, string>();

  private async sessionIDsAtLocation(location?: { directory?: string }): Promise<string[]> {
    if (typeof location?.directory !== "string") return [];
    const reportedRoot = await this.reportedRoot(location.directory);
    return [...this.contexts.values()]
      .filter((context) => context.directory === reportedRoot)
      .map((context) => context.sessionID);
  }

  private async reportedRoot(directory: string): Promise<string> {
    const cached = this.reportedRoots.get(directory);
    if (cached !== undefined) return cached;
    const resolved = await fsp.realpath(directory).catch(() => path.resolve(directory));
    this.reportedRoots.set(directory, resolved);
    return resolved;
  }

  // ---------- filesystem watching + agent baselines ----------

  private currentWatch(context: WatchContext): boolean {
    return this.contexts.get(context.workspace.id)?.watchContext === context;
  }

  private abs(rel: string, root: string): string {
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  }

  private relKey(abs: string, root: string): string {
    const rel = path.isAbsolute(abs) ? path.relative(root, abs) : abs;
    return rel.split(path.sep).join("/");
  }

  private recoveryRoot(root: string): string {
    return path.join(root, RECOVERY_DIR);
  }

  private async checkedRecoveryRoot(root: string, create = false): Promise<string> {
    const recoveryRoot = await confinedPath(root, RECOVERY_DIR);
    const stat = await fsp.lstat(recoveryRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat && create) {
      await fsp.mkdir(recoveryRoot, { mode: 0o700 });
      return confinedPath(root, RECOVERY_DIR);
    }
    if (stat && !stat.isDirectory()) throw new Error("invalid recovery directory");
    return recoveryRoot;
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fsp.open(directory, "r").catch((error) => {
      if (["EISDIR", "EINVAL", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    });
    if (!handle) return;
    try {
      await handle.sync().catch((error) => {
        if (!["EINVAL", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      });
    } finally {
      await handle.close();
    }
  }

  private async writeRecoveryTransaction(directory: string, transaction: RecoveryTransaction): Promise<void> {
    const temporary = path.join(directory, `manifest-${randomUUID()}.tmp`);
    const handle = await fsp.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(transaction, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, path.join(directory, "manifest.json"));
    await this.syncDirectory(directory);
  }

  private async createRecoveryTransaction(
    root: string,
    operation: RecoveryTransaction["operation"],
    originalPath: string,
    targetPath?: string
  ): Promise<{ directory: string; transaction: RecoveryTransaction }> {
    const id = `${Date.now()}-${randomUUID()}`;
    const recoveryRoot = await this.checkedRecoveryRoot(root, true);
    const directory = path.join(recoveryRoot, id);
    await fsp.mkdir(directory);
    const transaction: RecoveryTransaction = {
      version: 1,
      id,
      operation,
      originalPath,
      ...(targetPath ? { targetPath } : {}),
      createdAt: Date.now(),
      phase: "initialized",
      acknowledged: []
    };
    await this.writeRecoveryTransaction(directory, transaction);
    await this.syncDirectory(recoveryRoot);
    return { directory, transaction };
  }

  private validRecoveryTransaction(value: unknown, id: string): value is RecoveryTransaction {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const transaction = value as Partial<RecoveryTransaction>;
    const phases = ["initialized", "temporary-ready", "source-held", "held-validated", "target-installed", "failed", "complete"];
    const artifacts = transaction.operation === "save"
      ? ["temporary", "original", "proposed"]
      : ["rename-source"];
    try {
      relativePath(transaction.originalPath);
      if (transaction.operation === "rename") relativePath(transaction.targetPath);
    } catch {
      return false;
    }
    return transaction.version === 1 &&
      transaction.id === id &&
      /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) &&
      (transaction.operation === "save" || transaction.operation === "rename") &&
      typeof transaction.createdAt === "number" && Number.isSafeInteger(transaction.createdAt) && transaction.createdAt > 0 &&
      typeof transaction.phase === "string" && phases.includes(transaction.phase) &&
      Array.isArray(transaction.acknowledged) &&
      transaction.acknowledged.every((artifact) => typeof artifact === "string" && artifacts.includes(artifact));
  }

  private async readRecoveryTransactions(root: string): Promise<Array<{
    directory: string;
    transaction: RecoveryTransaction;
  }>> {
    const recoveryRoot = await this.checkedRecoveryRoot(root);
    const entries = await fsp.readdir(recoveryRoot, { withFileTypes: true }).catch(() => []);
    const transactions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (!/^\d{13}-[0-9a-f-]{36}$/.test(entry.name)) return null;
      try {
        const directory = await confinedPath(root, `${RECOVERY_DIR}/${entry.name}`);
        const manifest = await confinedPath(root, `${RECOVERY_DIR}/${entry.name}/manifest.json`);
        if (!(await fsp.lstat(manifest)).isFile()) return null;
        const transaction = JSON.parse(await fsp.readFile(manifest, "utf8")) as unknown;
        if (!this.validRecoveryTransaction(transaction, entry.name)) return null;
        return { directory, transaction };
      } catch {
        return null;
      }
    }));
    return transactions.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  private async recoveryRecords(root: string): Promise<RecoveryRecord[]> {
    const transactions = await this.readRecoveryTransactions(root);
    const records: RecoveryRecord[] = [];
    for (const { directory, transaction } of transactions) {
      const artifacts = transaction.operation === "save"
        ? [["temporary", "temporary"] as const, ["original", "original"] as const, ["proposed", "proposed"] as const]
        : [["rename-source", "source"] as const];
      for (const [artifact, name] of artifacts) {
        const file = await confinedPath(root, `${this.relKey(directory, root)}/${name}`);
        if (!(await fsp.lstat(file).catch(() => null))?.isFile()) continue;
        records.push({
          id: `${transaction.id}:${artifact}`,
          artifact,
          originalPath: transaction.originalPath,
          recoveryPath: this.relKey(file, root),
          createdAt: transaction.createdAt,
          acknowledged: transaction.acknowledged.includes(artifact),
          reason: transaction.reason ?? (transaction.phase === "complete" ? "saved" : "save-failed")
        });
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  private async reconcileRecovery(root: string, current: () => boolean = () => true): Promise<void> {
    const transactions = await this.readRecoveryTransactions(root);
    for (const item of transactions) {
      if (!current()) throw new Error("activation superseded");
      const { directory, transaction } = item;
      if (transaction.phase === "complete" || transaction.phase === "failed") continue;
      if (transaction.phase !== "source-held" && transaction.phase !== "held-validated") continue;
      const original = await confinedPath(root, `${this.relKey(directory, root)}/${transaction.operation === "rename" ? "source" : "original"}`);
      if (!(await fsp.lstat(original).catch(() => null))?.isFile()) continue;
      const canonical = await confinedPath(root, transaction.originalPath);
      if (transaction.operation === "rename" && transaction.targetPath) {
        const target = await confinedPath(root, transaction.targetPath);
        const [heldStat, targetStat] = await Promise.all([
          fsp.stat(original),
          fsp.stat(target).catch(() => null)
        ]);
        if (targetStat && heldStat.dev === targetStat.dev && heldStat.ino === targetStat.ino) {
          if (!current()) throw new Error("activation superseded");
          transaction.phase = "complete";
          transaction.reason = "renamed";
          transaction.acknowledged = ["rename-source"];
          await this.writeRecoveryTransaction(directory, transaction);
          continue;
        }
      }
      if (await fsp.lstat(canonical).catch(() => null)) continue;
      if (!current()) throw new Error("activation superseded");
      const parentRel = path.posix.dirname(transaction.originalPath);
      const parent = parentRel === "." ? root : await confinedPath(root, parentRel);
      await fsp.mkdir(parent, { recursive: true });
      await confinedPath(root, transaction.originalPath);
      if (!current()) throw new Error("activation superseded");
      try {
        await fsp.link(original, canonical);
        await this.syncDirectory(parent);
        transaction.phase = "complete";
        transaction.reason = "crash-recovered";
        await this.writeRecoveryTransaction(directory, transaction);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  private async emitRecoveryFor(context: SessionContext): Promise<void> {
    const records = await this.recoveryRecords(context.directory);
    if (!this.currentContext(context)) return;
    this.emit({ kind: "recovery", recovery: { workspace: context.workspace, records } });
  }

  private async purgeExpiredRecovery(root: string, current: () => boolean): Promise<void> {
    const transactions = await this.readRecoveryTransactions(root).catch(() => []);
    const now = Date.now();
    for (const { directory, transaction } of transactions) {
      if (!current()) return;
      const settled = transaction.phase === "complete" || transaction.phase === "failed" || transaction.acknowledged.length > 0;
      const interrupted = transaction.phase === "source-held" || transaction.phase === "held-validated";
      if (!settled && !interrupted) continue;
      const retention = settled ? RECOVERY_SETTLED_RETENTION_MS : RECOVERY_INTERRUPTED_RETENTION_MS;
      if (now - transaction.createdAt < retention) continue;
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    await this.syncDirectory(path.join(root, RECOVERY_DIR)).catch(() => {});
  }

  async listRecovery(workspace: WorkspaceIdentity): Promise<RecoveryRecord[]> {
    return this.recoveryRecords(this.workspaceRoot(workspace));
  }

  async acknowledgeRecovery(workspace: WorkspaceIdentity, id: string): Promise<void> {
    const root = this.workspaceRoot(workspace);
    const match = /^(\d{13}-[0-9a-f-]{36}):(temporary|original|proposed|rename-source)$/.exec(id);
    if (!match) throw new Error("invalid recovery record");
    const item = (await this.readRecoveryTransactions(root)).find(({ transaction }) => transaction.id === match[1]);
    if (!item) throw new Error("recovery record not found");
    const { directory, transaction } = item;
    const artifact = match[2];
    if (!(await this.recoveryRecords(root)).some((record) => record.id === id)) throw new Error("recovery record not found");
    if (!transaction.acknowledged.includes(artifact)) transaction.acknowledged.push(artifact);
    await this.writeRecoveryTransaction(directory, transaction);
    await this.emitRecoveryFor(this.contextFor(workspace));
  }

  async openRecovery(workspace: WorkspaceIdentity, id: string): Promise<void> {
    const root = this.workspaceRoot(workspace);
    const record = (await this.recoveryRecords(root)).find((candidate) => candidate.id === id);
    if (!record) throw new Error("recovery record not found");
    const match = /^(\d{13}-[0-9a-f-]{36}):(temporary|original|proposed|rename-source)$/.exec(id);
    if (!match) throw new Error("invalid recovery record");
    const names: Record<RecoveryRecord["artifact"], string> = {
      temporary: "temporary",
      original: "original",
      proposed: "proposed",
      "rename-source": "source"
    };
    const artifact = await confinedPath(root, `${RECOVERY_DIR}/${match[1]}/${names[record.artifact]}`);
    if (!(await fsp.lstat(artifact)).isFile()) throw new Error("recovery record not found");
    const result = await shell.openPath(artifact);
    if (result) throw new Error(result);
  }

  private shouldSkip(abs: string, root: string): boolean {
    const rel = path.relative(root, abs);
    return rel.split(path.sep).some((segment) => SKIP_DIRS.has(segment));
  }

  private isGitMetadata(abs: string, root: string): boolean {
    const rel = path.relative(root, abs);
    return rel === ".git" || rel.startsWith(`.git${path.sep}`);
  }

  private async snapshotInputs(context: SessionContext, input: unknown): Promise<void> {
    const watchContext = context.watchContext;
    if (!this.currentContext(context)) return;
    for (const rel of collectFilePaths(input)) {
      const abs = this.abs(rel, watchContext.root);
      if (watchContext.snapshots.has(abs)) continue;
      try {
        const content = await this.readFile(context.workspace, this.relKey(abs, watchContext.root));
        if (this.currentWatch(watchContext)) {
          watchContext.snapshots.set(abs, knownBaseline(content ?? "", content !== null));
        }
      } catch {
        /* ignore */
      }
    }
  }

  private async gitShow(context: WatchContext, rel: string): Promise<string | null> {
    if (context.hasGit === false) return null;
    if (context.hasGit === null) {
      let cur: string | null = context.root;
      let gitRoot: string | null = null;
      while (cur) {
        try {
          await fsp.access(path.join(cur, ".git"));
          gitRoot = cur;
          break;
        } catch {
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
      if (!this.currentWatch(context)) return null;
      if (gitRoot) {
        context.hasGit = true;
        (context as { gitRoot: string | null }).gitRoot = gitRoot;
      } else {
        context.hasGit = false;
        (context as { gitRoot: string | null }).gitRoot = null;
        return null;
      }
    }
    const gitRoot = (context as { gitRoot: string | null }).gitRoot ?? context.root;
    const abs = path.isAbsolute(rel) ? rel : path.join(context.root, rel);
    const relGit = path.relative(gitRoot, abs).split(path.sep).join("/");
    if (!relGit || relGit.startsWith("..")) return null;
    return new Promise((resolve) => {
      execFile(
        "git",
        ["show", `HEAD:${relGit}`],
        { cwd: gitRoot, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
        (err, stdout) => {
          resolve(err ? null : stdout);
        }
      );
    });
  }

  private startWatcher(context: SessionContext): void {
    try {
      context.watcher = watch(context.directory, { recursive: true }, (event, filename) => {
        if (!this.currentContext(context)) return;
        if (!filename || typeof filename !== "string") return;
        const abs = this.abs(filename, context.directory);
        if (this.isGitMetadata(abs, context.directory)) {
          this.scheduleGitRefresh(context.watchContext);
          return;
        }
        if (this.shouldSkip(abs, context.directory)) return;
        this.scheduleWatch(context.watchContext, abs, event);
      });
      context.watcher.on("error", (err) => console.error("[orbit] watcher error:", err));
      console.log("[orbit] watching", context.directory);
    } catch (err) {
      console.error("[orbit] fs.watch unavailable, live updates disabled:", err);
    }
  }

  private stopWatcher(context: SessionContext): void {
    for (const t of context.watchContext.timers.values()) clearTimeout(t);
    context.watchContext.timers.clear();
    context.watcher?.close();
    context.watcher = null;
  }

  private scheduleWatch(context: WatchContext, abs: string, event: string): void {
    if ((context.importing ?? 0) > 0) return;
    const now = Date.now();
    const suppressedUntil = context.suppressedUntil ?? (context.suppressedUntil = new Map());
    for (const [prefix, until] of suppressedUntil) {
      if (until <= now) suppressedUntil.delete(prefix);
      else if (abs === prefix || abs.startsWith(`${prefix}${path.sep}`)) return;
    }
    const existing = context.timers.get(abs);
    if (existing) clearTimeout(existing);
    context.timers.set(
      abs,
      setTimeout(() => {
        context.timers.delete(abs);
        if (this.currentWatch(context)) void this.onFsChanged(context, abs, event);
      }, 200)
    );
  }

  private scheduleGitRefresh(context: WatchContext): void {
    const key = path.join(context.root, ".git");
    const existing = context.timers.get(key);
    if (existing) clearTimeout(existing);
    context.timers.set(key, setTimeout(() => {
      context.timers.delete(key);
      if (this.currentWatch(context)) void this.refreshGitBaselines(context);
    }, 200));
  }

  private async refreshGitBaselines(context: WatchContext): Promise<void> {
    for (const [abs] of context.snapshots) {
      if (!this.currentWatch(context)) return;
      const rel = this.relKey(abs, context.root);
      const git = await this.gitShow(context, rel);
      if (!this.currentWatch(context)) return;
      const baseline = observedBaseline(true, git);
      let content: string | null = null;
      try {
        content = await fsp.readFile(abs, "utf8");
      } catch {
      }
      context.snapshots.set(abs, baseline);
      if (content === null) context.lastKnown.delete(abs);
      else context.lastKnown.set(abs, content);
      this.emitFileUpdate(context, abs, content, baseline);
    }
  }

  private async onFsChanged(context: WatchContext, abs: string, event: string): Promise<void> {
    if (!this.currentWatch(context)) return;
    if ((context.importing ?? 0) > 0) return;
    const now = Date.now();
    const suppressedUntil = context.suppressedUntil ?? (context.suppressedUntil = new Map());
    for (const [prefix, until] of suppressedUntil) {
      if (until <= now) suppressedUntil.delete(prefix);
      else if (abs === prefix || abs.startsWith(`${prefix}${path.sep}`)) return;
    }
    if (this.isGitMetadata(abs, context.root)) {
      await this.refreshGitBaselines(context);
      return;
    }
    if (this.shouldSkip(abs, context.root)) return;
    let stat: Awaited<ReturnType<typeof fsp.stat>> | null = null;
    try {
      stat = await fsp.stat(abs);
    } catch {
      /* missing */
    }
    if (!this.currentWatch(context)) return;
    if (!stat || !stat.isFile()) {
      const movedUntil = context.recentMoves?.get(abs);
      if (movedUntil !== undefined) {
        if (movedUntil > Date.now()) return;
        context.recentMoves?.delete(abs);
      }
      if (event === "unlink" || context.lastKnown.has(abs) || context.snapshots.has(abs)) {
        let baseline = context.snapshots.get(abs);
        if (!baseline) {
          const lastKnown = context.lastKnown.get(abs);
          if (lastKnown !== undefined) {
            baseline = knownBaseline(lastKnown);
          } else {
            const git = await this.gitShow(context, this.relKey(abs, context.root));
            if (!this.currentWatch(context)) return;
            baseline = observedBaseline(context.hasGit === true, git);
          }
        }
        if (!this.currentWatch(context)) return;
        context.snapshots.set(abs, baseline);
        context.lastKnown.delete(abs);
        (context.deletedPaths ??= new Set()).add(abs);
        this.emitFileUpdate(context, abs, null, baseline);
      }
      return;
    }
    if (stat.size > MAX_WATCHED_FILE_BYTES) return;
    let content: string;
    try {
      content = await fsp.readFile(abs, "utf8");
    } catch {
      return;
    }
    if (!this.currentWatch(context)) return;
    const identity = this.fileIdentity(stat);
    const movedFrom = identity ? await this.missingIdentitySource(context, abs, identity) : null;
    if (!this.currentWatch(context)) return;
    if (movedFrom && identity) {
      const oldBaseline = await this.baselineForObservedPath(context, movedFrom);
      if (!this.currentWatch(context)) return;
      const targetBaseline = await this.baselineForObservedPath(context, abs);
      if (!this.currentWatch(context)) return;
      if (!context.deletedPaths?.has(movedFrom)) {
        context.snapshots.set(movedFrom, oldBaseline);
        context.lastKnown.delete(movedFrom);
        this.emitFileUpdate(context, movedFrom, null, oldBaseline);
      }
      context.snapshots.set(abs, targetBaseline);
      context.lastKnown.set(abs, content);
      context.identities?.delete(movedFrom);
      context.identities?.set(abs, identity);
      context.deletedPaths?.delete(movedFrom);
      context.deletedPaths?.delete(abs);
      (context.recentMoves ??= new Map()).set(movedFrom, Date.now() + 2_000);
      this.emitFileUpdate(context, abs, content, targetBaseline, undefined, this.relKey(movedFrom, context.root));
      return;
    }
    if (identity) (context.identities ??= new Map()).set(abs, identity);
    context.deletedPaths?.delete(abs);
    if (content === context.lastKnown.get(abs)) return;
    context.lastKnown.set(abs, content);
    if (!context.snapshots.has(abs)) {
      const git = await this.gitShow(context, this.relKey(abs, context.root));
      if (!this.currentWatch(context)) return;
      const baseline = observedBaseline(context.hasGit === true, git);
      context.snapshots.set(abs, baseline);
    }
    this.emitFileUpdate(context, abs, content);
  }

  private emitFileUpdate(
    context: WatchContext,
    abs: string,
    content: string | null,
    baselineOverride?: FileBaseline,
    write?: FileWriteIdentity,
    movedFrom?: string
  ): void {
    const baseline =
      baselineOverride !== undefined
        ? baselineOverride
        : (context.snapshots.get(abs) ?? unknownBaseline);
    if (!this.currentWatch(context)) return;
    this.emit({
      kind: "file-update",
      file: {
        workspace: context.workspace,
        sessionID: context.sessionID,
        path: this.relKey(abs, context.root),
        ...(movedFrom ? { movedFrom } : {}),
        baseline,
        content,
        deleted: content === null,
        ...(write ? { write } : {})
      }
    });
  }

  private fileIdentity(stat: Awaited<ReturnType<typeof fsp.stat>>): string | null {
    if (!Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino <= 0) return null;
    return `${stat.dev}:${stat.ino}`;
  }

  private async missingIdentitySource(context: WatchContext, abs: string, identity: string): Promise<string | null> {
    const candidates = [...(context.identities ?? [])]
      .filter(([candidate, value]) => candidate !== abs && value === identity)
      .map(([candidate]) => candidate);
    const missing: string[] = [];
    for (const candidate of candidates) {
      const stat = await fsp.stat(candidate).catch(() => null);
      if (!this.currentWatch(context)) return null;
      if (!stat) missing.push(candidate);
    }
    return missing.length === 1 ? missing[0] : null;
  }

  private async baselineForObservedPath(context: WatchContext, abs: string): Promise<FileBaseline> {
    const established = context.snapshots.get(abs);
    if (established) return established;
    const git = await this.gitShow(context, this.relKey(abs, context.root));
    return observedBaseline(context.hasGit === true, git);
  }

  private async captureDirectMutation(context: WatchContext, abs: string): Promise<{
    baseline: FileBaseline;
    content: string | null;
  }> {
    const established = context.snapshots.get(abs);
    try {
      const content = await fsp.readFile(abs, "utf8");
      return { baseline: established ?? knownBaseline(content), content };
    } catch {
      return { baseline: established ?? unknownBaseline, content: null };
    }
  }

  private async canonicalExternalFile(value: string): Promise<string> {
    const original = absoluteFilePath(value);
    return fsp.realpath(original).then((real) => {
      return fsp.stat(real).then((stat) => {
        if (!stat.isFile()) throw new Error("not a file");
        return real;
      });
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(original);
      throw error;
    });
  }

  private async readExternalText(abs: string): Promise<string | null> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return null;
    if (stat.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("file is too large to open");
    return fsp.readFile(abs, "utf8").catch(() => null);
  }

  private async copyExternal(source: string, target: string, isDir: boolean): Promise<string[]> {
    const copied: string[] = [];
    let files = 0;
    let bytes = 0;
    const MAX_FILES = 10000;
    const MAX_BYTES = 2 * 1024 * 1024 * 1024;
    const copyFile = async (from: string, to: string): Promise<void> => {
      const stat = await fsp.stat(from);
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error("import is too large");
      await fsp.copyFile(from, to);
    };
    const walk = async (from: string, to: string): Promise<void> => {
      const stat = await fsp.lstat(from);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        await fsp.mkdir(to, { recursive: true });
        const entries = await fsp.readdir(from, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
          await walk(path.join(from, entry.name), path.join(to, entry.name));
        }
        return;
      }
      if (stat.isFile()) {
        files += 1;
        if (files > MAX_FILES) throw new Error("too many files to import");
        await copyFile(from, to);
        copied.push(to);
      }
    };
    if (isDir) {
      await walk(source, target);
    } else {
      await copyFile(source, target);
      copied.push(target);
    }
    return copied;
  }

  // ---------- session + API ----------

  private async activateSession(info: Omit<SessionInfo, "workspace">, runtime: RuntimeAdapter | null = null): Promise<SessionInfo> {
    const directory = await canonicalWorkspaceRoot(info.directory);
    const existing = this.contextBySessionID(info.id);
    if (existing && existing.directory === directory) return existing.sessionInfo;
    const context: SessionContext = {
      workspace: Object.freeze({ id: randomUUID(), generation: this.activations.accept() }),
      sessionID: info.id,
      directory,
      sessionInfo: { ...info, directory } as SessionInfo,
      watchContext: {
        root: directory,
        sessionID: info.id,
        workspace: {} as WorkspaceIdentity,
        snapshots: new Map(),
        lastKnown: new Map(),
        hasGit: null,
        gitRoot: null,
        timers: new Map()
      },
      watcher: null,
      activations: new LatestGeneration(),
      runtime
    };
    context.sessionInfo = { ...info, directory, workspace: context.workspace };
    context.watchContext.workspace = context.workspace;
    const generation = context.activations.accept();
    if (existing) {
      existing.activations.invalidate();
      this.stopWatcher(existing);
      this.contexts.delete(existing.workspace.id);
    }
    this.contexts.set(context.workspace.id, context);
    this.primary = context.workspace.id;
    await this.reconcileRecovery(directory, () => context.activations.current(generation) && this.currentContext(context));
    if (!context.activations.current(generation) || !this.currentContext(context)) throw new Error("activation superseded");
    void this.purgeExpiredRecovery(directory, () => context.activations.current(generation) && this.currentContext(context));
    this.startWatcher(context);
    this.emit({ kind: "session", session: context.sessionInfo });
    await this.emitRecoveryFor(context);
    return context.sessionInfo;
  }

  private async resolveOpenCodeSessionDirectory(directory: string, projectID?: string): Promise<{ directory: string; relocated: boolean }> {
    try {
      return { directory: await canonicalWorkspaceRoot(directory), relocated: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !projectID || projectID === "global" || !this.client) throw error;
    }
    const res = await this.client.project.list();
    const projects = (Array.isArray(res) ? res : (res as { data?: unknown }).data ?? []) as Array<{ id?: string; canonical?: string }>;
    const current = projects.find((project) => project.id === projectID)?.canonical;
    if (!current) throw new Error(`Session workspace no longer exists: ${directory}`);
    try {
      return { directory: await canonicalWorkspaceRoot(current), relocated: true };
    } catch {
      throw new Error(`Session workspace no longer exists: ${directory}`);
    }
  }

  async openSession(directory: string, acceptedGeneration?: number, runtimeID: RuntimeID = "opencode"): Promise<SessionInfo> {
    if (acceptedGeneration !== undefined && !Number.isSafeInteger(acceptedGeneration)) {
      throw new Error("invalid activation generation");
    }
    if (runtimeID === "deepseek") {
      const runtimeFactory = this.runtimeFactory;
      if (!runtimeFactory) throw new Error("DeepSeek Harness runtime is disabled");
      const runtimeDirectory = await canonicalWorkspaceRoot(directory);
      const runtime = runtimeFactory(runtimeID, runtimeDirectory);
      if (!(await runtime.connect())) throw new Error("DeepSeek Harness is not available");
      const draft = await runtime.createSession(runtimeDirectory);
      this.runtimeAdapters.set(draft.id, runtime);
      this.startRuntimeSubscription(draft.id, runtime);
      await this.runtimeSessionIndex.put({
        id: draft.id,
        runtimeID: "deepseek",
        title: draft.title ?? path.basename(runtimeDirectory),
        directory: runtimeDirectory,
        updatedAt: Date.now(),
        ...(draft.parentID ? { parentID: draft.parentID } : {}),
        ...(draft.agent ? { agent: draft.agent } : {})
      });
      return this.activateSession({ ...draft, runtimeID: "deepseek" }, runtime);
    }
    if (runtimeID !== "opencode") throw new Error(`Unsupported runtime: ${runtimeID}`);
    if (!this.client) throw new Error("not connected to opencode service");
    const res = await this.client.session.create({
      location: { directory }
    });
    const info = res as {
      id?: string;
      title?: string;
      parentID?: string;
      agent?: string;
      data?: { id?: string; title?: string; parentID?: string; agent?: string };
    };
    const id = info.id ?? info.data?.id;
    if (!id) throw new Error("session create returned no id");
    return this.activateSession({
      id,
      runtimeID: "opencode",
      directory,
      ...(info.parentID ?? info.data?.parentID ? { parentID: info.parentID ?? info.data?.parentID } : {}),
      ...(info.title ?? info.data?.title ? { title: info.title ?? info.data?.title } : {}),
      ...(info.agent ?? info.data?.agent ? { agent: info.agent ?? info.data?.agent } : {})
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const persistedRuntimeSummaries = await this.runtimeSessionIndex.list();
    const liveRuntimeSummaries = (await Promise.all([...new Set(this.runtimeAdapters.values())].map((runtime) => runtime.listSessions().catch(() => [])))).flat();
    const runtimeSummaries = [...new Map([...persistedRuntimeSummaries, ...liveRuntimeSummaries]
      .filter((summary) => summary.runtimeID !== "deepseek")
      .map((summary) => [summary.id, summary])).values()];
    if (!this.client) return runtimeSummaries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    const summaries: SessionSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && summaries.length < 30; page += 1) {
      const res = await this.client.session.list({ limit: 50, order: "desc", ...(cursor ? { cursor } : {}) });
      const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
      for (const s of arr as Array<{
        id?: string;
        title?: string;
        parentID?: string;
        agent?: string;
        tokens?: SessionTokenUsage;
        location?: { directory?: string };
        time?: { updated?: number; created?: number };
      }>) {
        const directory = s.location?.directory;
        if (!s.id || !directory) continue;
        const updated = s.time?.updated ?? s.time?.created ?? 0;
        if (expiredSession(s.time, Date.now())) continue;
        if (!hasConversation(s.title, s.tokens)) continue;
        summaries.push({
          id: s.id,
          runtimeID: "opencode",
          title: s.title?.trim() ? s.title : path.basename(directory),
          directory,
          updatedAt: updated,
          ...(s.parentID ? { parentID: s.parentID } : {}),
          ...(s.agent ? { agent: s.agent } : {})
        });
        if (summaries.length >= 30) break;
      }
      const next = Array.isArray(res) ? undefined : (res as { cursor?: { next?: string | null } }).cursor?.next;
      if (!next) break;
      cursor = next;
    }
    return [...runtimeSummaries, ...summaries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  }

  private async loadSessionMessages(sessionID: string): Promise<unknown[]> {
    if (!this.client) throw new Error("not connected to opencode service");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const messages: unknown[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 200; page += 1) {
          const input = cursor ? { sessionID, cursor } : { sessionID, order: "asc" as const };
          const messagesRes = await this.client.message.list(input);
          if (Array.isArray(messagesRes)) {
            messages.push(...(messagesRes as unknown[]));
            break;
          }
          const paged = messagesRes as { data?: unknown; cursor?: { next?: string | null } };
          messages.push(...((paged.data ?? []) as unknown[]));
          const next = paged.cursor?.next;
          if (!next) break;
          cursor = next;
        }
        return messages;
      } catch (err) {
        lastError = err;
        if (attempt === 0) await sleep(400);
      }
    }
    throw new Error(`could not load conversation history (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  }

  private async sessionDirectory(sessionID: string, nativeRuntimeID: RuntimeID, persistedDirectory?: string): Promise<string> {
    if (nativeRuntimeID === "deepseek") {
      const runtime = this.runtimeAdapters.get(sessionID);
      if (runtime) return (await runtime.sessionInfo(sessionID)).directory;
      if (persistedDirectory) return persistedDirectory;
      throw new Error("DeepSeek session directory is unavailable");
    }
    if (!this.client) throw new Error("not connected to opencode service");
    const res = await this.client.session.get({ sessionID });
    const info = res as { location?: { directory?: string }; data?: { location?: { directory?: string } } };
    const directory = info.location?.directory ?? info.data?.location?.directory;
    if (!directory) throw new Error("session not found");
    const resolved = await this.resolveOpenCodeSessionDirectory(directory, (res as { projectID?: string }).projectID);
    return resolved.directory;
  }

  async openSessionById(sessionID: string, acceptedGeneration?: number, runtimeID?: RuntimeID): Promise<ReopenedSession> {
    if (acceptedGeneration !== undefined && !Number.isSafeInteger(acceptedGeneration)) {
      throw new Error("invalid activation generation");
    }
    let runtime = this.runtimeAdapters.get(sessionID);
    const persistedRuntime = await this.runtimeSessionIndex.get(sessionID);
    const nativeRuntimeID: RuntimeID = runtime ? runtime.manifest.id : persistedRuntime?.runtimeID ?? "opencode";
    const requested = runtimeID ?? nativeRuntimeID;
    if (!this.contextBySessionID(sessionID) && requested !== nativeRuntimeID) {
      const remapped = await this.openSession(
        await this.sessionDirectory(sessionID, nativeRuntimeID, persistedRuntime?.directory),
        acceptedGeneration,
        requested
      );
      return { session: remapped, transcript: [], todos: [], usage: null };
    }
    if (nativeRuntimeID === "deepseek") {
      if (!runtime && persistedRuntime) {
        const runtimeFactory = this.runtimeFactory;
        if (!runtimeFactory) throw new Error("DeepSeek Harness runtime is disabled");
        runtime = runtimeFactory("deepseek", persistedRuntime.directory);
        if (!(await runtime.connect())) throw new Error("DeepSeek Harness is not available");
        this.runtimeAdapters.set(sessionID, runtime);
        this.startRuntimeSubscription(sessionID, runtime);
      }
      if (!runtime) throw new Error("DeepSeek session runtime is not active");
      const [draft, history] = await Promise.all([runtime.sessionInfo(sessionID), runtime.sessionTranscript(sessionID)]);
      const session = await this.activateSession({ ...draft, runtimeID: "deepseek" }, runtime);
      return { session, ...history, usage: null };
    }
    if (runtimeID && runtimeID !== "opencode") throw new Error(`Unsupported runtime: ${runtimeID}`);
    if (!this.client) throw new Error("not connected to opencode service");
    const res = await this.client.session.get({ sessionID });
    const info = res as {
      id?: string;
      projectID?: string;
      title?: string;
      parentID?: string;
      agent?: string;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
      location?: { directory?: string };
      data?: {
        id?: string;
        projectID?: string;
        title?: string;
        parentID?: string;
        agent?: string;
        cost?: number;
        tokens?: {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
        location?: { directory?: string };
      };
    };
    const id = info.id ?? info.data?.id;
    const directory = info.location?.directory ?? info.data?.location?.directory;
    if (!id || !directory) throw new Error("session not found");
    const resolved = await this.resolveOpenCodeSessionDirectory(directory, info.projectID ?? info.data?.projectID);
    if (resolved.relocated) await this.client.session.move({ sessionID: id, directory: resolved.directory });
    const usage: SessionUsage | null = (() => {
      const raw = info.data ?? info;
      const cost = raw.cost;
      const tokens = raw.tokens;
      // Cost is display-only; local providers may omit it while still
      // reporting tokens. Require tokens (they drive the context display)
      // but coerce a missing cost to 0 instead of dropping the snapshot,
      // mirroring the renderer's live-event normalization.
      if (!tokens) return null;
      const num = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
      return {
        cost: num(cost),
        tokens: {
          input: num(tokens.input),
          output: num(tokens.output),
          reasoning: num(tokens.reasoning),
          cache: {
            read: num(tokens.cache?.read),
            write: num(tokens.cache?.write)
          }
        }
      };
    })();
    const history = await this.loadSessionMessages(id);
    const session = await this.activateSession({
      id,
      runtimeID: "opencode",
      directory: resolved.directory,
      ...(info.parentID ?? info.data?.parentID ? { parentID: info.parentID ?? info.data?.parentID } : {}),
      ...(info.title ?? info.data?.title ? { title: info.title ?? info.data?.title } : {}),
      ...(info.agent ?? info.data?.agent ? { agent: info.agent ?? info.data?.agent } : {})
    });
    return { session, transcript: replayTranscript(history), todos: replayTodos(history), usage };
  }

  async sessionTranscript(sessionID: string): Promise<SessionTranscript> {
    const runtime = this.runtimeAdapters.get(sessionID);
    if (runtime) return runtime.sessionTranscript(sessionID);
    if (!this.client) throw new Error("not connected to opencode service");
    const history = await this.loadSessionMessages(sessionID);
    return { transcript: replayTranscript(history), todos: replayTodos(history) };
  }

  async sessionUsage(sessionID: string): Promise<SessionUsage | null> {
    if (this.runtimeAdapters.get(sessionID)) return null;
    if (!this.client) return null;
    const res = await this.client.session.get({ sessionID }).catch(() => null);
    if (!res) return null;
    const raw = (res as { data?: Record<string, unknown> }).data ?? res as Record<string, unknown>;
    const cost = raw.cost;
    const tokens = raw.tokens as Record<string, unknown> | undefined;
    // See openSessionById above: tokens are required, cost coerces to 0 so
    // cost-less local providers still get a refreshable usage snapshot.
    if (!tokens) return null;
    const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
    const cache = tokens.cache as Record<string, unknown> | undefined;
    return {
      cost: num(cost),
      tokens: {
        input: num(tokens.input),
        output: num(tokens.output),
        reasoning: num(tokens.reasoning),
        cache: { read: num(cache?.read), write: num(cache?.write) }
      }
    };
  }

  async getState(): Promise<SessionInfo | null> {
    return this.primaryContext()?.sessionInfo ?? null;
  }

  async activeSessions(): Promise<SessionInfo[]> {
    const sessions = [...this.contexts.values()].map((context) => context.sessionInfo);
    if (sessions.length > 1) {
      const primaryIndex = sessions.findIndex((session) => session.workspace.id === this.primary);
      if (primaryIndex >= 0 && primaryIndex !== sessions.length - 1) {
        sessions.push(sessions.splice(primaryIndex, 1)[0]);
      }
    }
    return sessions;
  }

  async closeSession(workspace: WorkspaceIdentity): Promise<void> {
    const context = this.contextFor(workspace);
    context.activations.invalidate();
    this.stopWatcher(context);
    this.contexts.delete(workspace.id);
    if (this.primary === workspace.id) {
      const keys = [...this.contexts.keys()];
      this.primary = keys.length > 0 ? keys[keys.length - 1] : null;
    }
  }

  async deleteSession(sessionID: string): Promise<void> {
    // DeepSeek sessions have no delete RPC; only the native opencode
    // service supports destroying a session server-side.
    if (this.runtimeAdapters.get(sessionID) || await this.runtimeSessionIndex.get(sessionID)) {
      throw new Error("Deleting DeepSeek sessions is not supported yet; close the session instead");
    }
    if (!this.client) throw new Error("not connected to opencode service");
    const context = this.contextBySessionID(sessionID);
    if (context) await this.closeSession(context.workspace);
    await this.client.session.remove({ sessionID });
  }

  async workspaceDirectory(workspace: WorkspaceIdentity): Promise<string> {
    return this.contextFor(workspace).directory;
  }

  /** Working directory for a PTY spawned in this panel. Panels outlive their
   *  folder when a workspace moves underneath them, and a PTY spawned into a
   *  missing directory dies with a bare exit code 1, so fall back to the
   *  session's current location before giving up. */
  async ptyDirectory(workspace: WorkspaceIdentity): Promise<string> {
    const context = this.contextFor(workspace);
    const nativeRuntimeID = context.sessionInfo.runtimeID ?? context.runtime?.manifest.id ?? "opencode";
    const sessionDirectory = await this.sessionDirectory(context.sessionID, nativeRuntimeID).catch(() => null);
    return resolvePtyDirectory({
      captured: context.directory,
      sessionDirectory,
      isDirectory: async (directory) => {
        try {
          return (await fsp.stat(directory)).isDirectory();
        } catch {
          return false;
        }
      }
    });
  }

  async tuiCommand(workspace: WorkspaceIdentity): Promise<TerminalCommand> {
    const context = this.contextFor(workspace);
    const runtimeID = context.sessionInfo.runtimeID ?? context.runtime?.manifest.id ?? "opencode";
    if (context.runtime && !context.runtime.manifest.capabilities.tui) {
      throw new Error(`${context.runtime.manifest.name} TUI is not available; install its TUI profile first`);
    }
    return tuiCommandForRuntime(runtimeID, context.sessionID);
  }

  async providerUsage(): Promise<ProviderUsageResult[]> {
    return fetchProviderUsage();
  }

  async runtimeManifests(): Promise<RuntimeManifest[]> {
    const probe = (command: string, args: string[] = ["--version"]) => new Promise<{ available: boolean; version: string | null }>((resolve) => {
      execFile(command, args, { timeout: 5000 }, (error, stdout) =>
        resolve({ available: !error, version: error ? null : stdout.trim().split("\n")[0] || null }));
    });
    const opencode = await probe("opencode");
    const opencodeCompatible = opencode.available && serverVersionPredicate(opencode.version)(opencode.version ?? "");
    return [
      {
        protocolVersion: 1,
        id: "opencode",
        name: "OpenCode",
        version: opencode.version,
        available: Boolean(this.client) || opencodeCompatible,
        capabilities: {
          attachments: true,
          commands: true,
          models: true,
          agents: true,
          permissions: true,
          providerCredentials: true,
          sessionFork: true,
          sessionResume: true,
          steering: false,
          tui: opencodeCompatible
        }
      }
    ];
  }

  async sessionSelection(workspace: WorkspaceIdentity): Promise<SessionSelection | null> {
    const context = this.contextFor(workspace);
    if (context.runtime) return context.runtime.sessionSelection(context.sessionID);
    if (!this.client) return null;
    const res = await this.client.session.get({ sessionID: context.sessionID }).catch(() => null);
    if (!this.currentContext(context)) return null;
    if (!res) return null;
     const s = res as { agent?: string; model?: { id?: string; modelID?: string; providerID?: string; variant?: string } };
    const out: SessionSelection = {};
    const m = s.model;
     const id = m ? modelID(m) : "";
     if (id && m?.providerID) {
       out.model = { id, providerID: m.providerID, name: id, ...(m.variant ? { variant: m.variant } : {}) };
    }
    if (s.agent) out.agent = { id: s.agent, name: s.agent };
    return out.model || out.agent ? out : null;
  }

  async prompt(workspace: WorkspaceIdentity, text: string, files: PromptFile[] = [], delivery?: PromptDelivery): Promise<SessionTranscript> {
    const target = this.activeTarget(workspace);
    const context = this.contextFor(workspace);
    if (context.runtime) {
      if (files.length > 0) throw new Error("DeepSeek Harness attachments are not supported yet");
      await context.runtime.prompt(target.sessionID, text);
      await this.runtimeSessionIndex.touch(target.sessionID);
      this.assertTarget(target);
      return context.runtime.sessionTranscript(target.sessionID);
    }
    if (!this.client) throw new Error("no active session");
    const fileSpecs = await Promise.all(
      files.map(async (file) => {
        const stat = await fsp.stat(file.path);
        if (!stat.isFile()) throw new Error(`${path.basename(file.path)} is not a file`);
        if (stat.size > 10 * 1024 * 1024) {
          throw new Error(`${path.basename(file.path)} is larger than 10 MB`);
        }
        return {
          uri: pathToFileURL(file.path).toString(),
          name: path.basename(file.path),
          ...(file.mention ? { mention: file.mention } : {})
        };
      })
    );
    this.assertTarget(target);
    await this.client.session.prompt({
      sessionID: target.sessionID,
      text,
      ...(fileSpecs.length > 0 ? { files: fileSpecs } : {}),
      ...(delivery ? { delivery } : {})
    });
    this.assertTarget(target);
    return this.sessionTranscript(target.sessionID);
  }

  async listInbox(workspace: WorkspaceIdentity): Promise<SessionInboxEntry[]> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    const res = await this.client.session.inbox.list({ sessionID: target.sessionID });
    const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (arr as Array<Record<string, unknown>>).flatMap((entry): SessionInboxEntry[] => {
      if (entry.type !== "user") return [];
      const payload = entry.payload as Record<string, unknown> | undefined;
      const files = Array.isArray(payload?.files) ? payload!.files : [];
      const delivery: SessionInboxEntry["delivery"] = entry.delivery === "queue"
        ? "queue"
        : entry.delivery === "steer"
          ? "steer"
          : undefined;
      return [{
        id: String(entry.id ?? ""),
        text: String(payload?.text ?? ""),
        attachmentCount: files.length,
        createdAt: Number(entry.timeCreated ?? 0),
        ...(delivery ? { delivery } : {})
      }].filter((item) => item.id !== "");
    });
  }

  async cancelInbox(workspace: WorkspaceIdentity, inboxID: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    try {
      await this.client.session.inbox.cancel({ sessionID: target.sessionID, inboxID });
    } catch (error) {
      const tag = (error as { _tag?: unknown } | null)?._tag;
      if (tag === "ConflictError") return;
      throw error;
    }
  }

  async steerInbox(workspace: WorkspaceIdentity, inboxID: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    await this.client.session.inbox.update({ sessionID: target.sessionID, inboxID, delivery: "steer" });
  }
  async listForms(workspace: WorkspaceIdentity): Promise<PendingFormRequest[]> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    const [sessionResult, globalResult] = await Promise.all([
      this.client.session.form.list({ sessionID: target.sessionID }),
      this.client.form.list({ location: { directory: target.directory } }).catch(() => null)
    ]);
    this.assertTarget(target);
    const sessionForms = Array.isArray(sessionResult)
      ? sessionResult
      : (sessionResult as { data?: unknown }).data ?? [];
    // `form.list` is location-scoped and returns every pending form for the
    // directory, including ones owned by child or external sessions. Include
    // them so reconciliation keeps event-delivered prompts visible.
    const locationForms = globalResult && typeof globalResult === "object" && Array.isArray((globalResult as { data?: unknown }).data)
      ? (globalResult as { data: Array<Record<string, unknown>> }).data
      : [];
    const normalized = [...sessionForms as Array<Record<string, unknown>>, ...locationForms]
      .map(normalizePendingForm)
      .filter((form): form is PendingFormRequest => form !== null);
    return [...new Map(normalized.map((form) => [form.id, form])).values()];
  }

  async replyForm(workspace: WorkspaceIdentity, formID: string, answers: FormAnswers, formSessionID?: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    const sessionID = await this.formSessionID(target, formSessionID);
    await this.client.session.form.reply(
      { sessionID, formID, answer: answers },
      sessionID === "global" ? this.globalFormRequestOptions(target.directory) : undefined
    );
  }

  async cancelForm(workspace: WorkspaceIdentity, formID: string, formSessionID?: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    const sessionID = await this.formSessionID(target, formSessionID);
    await this.client.session.form.cancel(
      { sessionID, formID },
      sessionID === "global" ? this.globalFormRequestOptions(target.directory) : undefined
    );
  }

  /** Resolve the session a form reply/cancel should target. A form surfaced to
   *  this workspace's panel may belong to the active session, a location-global
   *  form, or another session at the same directory (a delegated child or an
   *  external `opencode` TUI). Any other session is rejected so a renderer
   *  cannot reach across workspaces. */
  private async formSessionID(target: ActiveWorkspaceTarget, requested?: string): Promise<string> {
    if (requested === undefined || requested === target.sessionID) return target.sessionID;
    if (requested === "global") return requested;
    const listed = await this.client?.form
      .list({ location: { directory: target.directory } })
      .catch(() => null);
    const forms = listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
      ? (listed as { data: Array<{ sessionID?: unknown }> }).data
      : [];
    if (forms.some((form) => form.sessionID === requested)) return requested;
    throw new Error("form does not belong to the active workspace session");
  }

  private globalFormRequestOptions(directory: string): { headers: Record<string, string> } {
    return { headers: { "x-opencode-directory": encodeURIComponent(directory) } };
  }

  async listCommands(workspace: WorkspaceIdentity): Promise<CommandOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const location = { location: { directory: target.directory } };
    const [commands, skills] = await Promise.all([
      this.client.command.list(location).catch(() => []),
      this.client.skill.list(location).catch(() => [])
    ]);
    this.assertTarget(target);
    const commandArr = Array.isArray(commands) ? commands : (commands as { data?: unknown }).data ?? [];
    const skillArr = Array.isArray(skills) ? skills : (skills as { data?: unknown }).data ?? [];
    const commandItems = (commandArr as { name?: string; description?: string }[])
      .map((c) => ({ name: c.name ?? "", ...(c.description ? { description: c.description } : {}), kind: "command" as const }))
      .filter((c) => c.name.length > 0);
    const skillItems = (skillArr as { id?: string; name?: string; description?: string }[])
      .map((s) => ({
        name: s.name ?? s.id ?? "",
        ...(s.description ? { description: s.description } : {}),
        kind: "skill" as const
      }))
      .filter((s) => s.name.length > 0);
    const builtinItems = BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
      kind: "command" as const
    }));
    return [...builtinItems, ...commandItems, ...skillItems];
  }

  async runCommand(workspace: WorkspaceIdentity, name: string, args: string = ""): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness commands are not supported yet");
    if (!this.client) throw new Error("no active session");
    const builtin = BUILTIN_COMMANDS.find((command) => command.name === name);
    if (builtin) {
      await builtin.run(this.client, target.sessionID);
      this.assertTarget(target);
      return;
    }
    const skills = await this.client.skill
      .list({ location: { directory: target.directory } })
      .catch(() => []);
    this.assertTarget(target);
    const skillArr = Array.isArray(skills) ? skills : (skills as { data?: unknown }).data ?? [];
    const selectedSkill = (skillArr as { id?: string; name?: string }[]).find(
      (s) => s.name === name || s.id === name
    );
    if (selectedSkill) {
      const id = selectedSkill.id ?? selectedSkill.name;
      if (!id) throw new Error("skill has no identifier");
      await this.client.session.skill({ sessionID: target.sessionID, id });
      this.assertTarget(target);
      return;
    }
    await this.client.session.command({
      sessionID: target.sessionID,
      name,
      text: args ?? ""
    });
    this.assertTarget(target);
  }

  async searchFiles(workspace: WorkspaceIdentity, query: string): Promise<ReferenceOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.file.find({
      location: { directory: target.directory },
      query,
      type: "file"
    });
    this.assertTarget(target);
    const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (arr as { path?: string }[])
      .filter((r) => r.path && r.path !== RECOVERY_DIR && !r.path.startsWith(`${RECOVERY_DIR}/`))
      .map((r) => {
        const rel = r.path as string;
        return {
          name: path.basename(rel),
          path: path.join(target.directory, rel),
          rel
        };
      });
  }

  async interrupt(workspace: WorkspaceIdentity): Promise<void> {
    const target = this.activeTarget(workspace);
    const runtime = this.contextFor(workspace).runtime;
    if (runtime) {
      await runtime.interrupt(target.sessionID);
      this.assertTarget(target);
      return;
    }
    if (!this.client) throw new Error("no active session");
    try {
      await this.client.session.interrupt({ sessionID: target.sessionID });
    } catch (error) {
      if (!isAcceptedNoContentInterrupt(error)) throw error;
    }
    this.assertTarget(target);
  }

  async listModels(workspace: WorkspaceIdentity): Promise<ModelOption[]> {
    const target = this.activeTarget(workspace);
    const runtime = this.contextFor(workspace).runtime;
    if (runtime) return runtime.listModels(target.sessionID);
    if (!this.client) return [];
    const res = await this.client.model.list(
      { location: { directory: target.directory } }
    );
    this.assertTarget(target);
    const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (arr as {
      id?: string;
      providerID?: string;
      name?: string;
      enabled?: boolean;
      variants?: { id?: string }[];
      limit?: { context?: number };
    }[])
      .filter((m) => m.enabled !== false)
       .map((m) => ({
         id: modelID(m),
         providerID: m.providerID ?? "",
         name: m.name ?? modelID(m) ?? "model",
         variants: variantIDs(m.variants),
         ...(typeof m.limit?.context === "number" && Number.isFinite(m.limit.context) && m.limit.context > 0
           ? { limit: { context: m.limit.context } }
           : {})
      }))
      .filter((m) => m.id && m.providerID);
  }

  async listProviderIntegrations(workspace: WorkspaceIdentity): Promise<ProviderIntegration[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.integration.list({ location: { directory: target.directory } });
    this.assertTarget(target);
    const rows = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    const catalog = rows as Array<{
      id?: string;
      name?: string;
      methods?: Array<{
        id?: string;
        type?: string;
        label?: string;
        names?: string[];
        form?: Array<Record<string, unknown>>;
      }>;
      connections?: Array<{ type?: string; id?: string; label?: string; name?: string }>;
    }>;
    return SUPPORTED_PROVIDER_IDS.flatMap((id) => catalog.filter((row) => row.id === id)).map((row) => {
      const methods = row.methods ?? [];
      const keyMethod = methods.find((method) => method.type === "key");
      const fields = (keyMethod?.form ?? []).flatMap((field): ProviderFormField[] => {
        if (typeof field.key !== "string" || !["string", "number", "integer", "boolean", "multiselect", "external"].includes(String(field.type))) return [];
        const defaultValue = field.default;
        return [{
          key: field.key,
          type: field.type as ProviderFormField["type"],
          ...(typeof field.title === "string" ? { title: field.title } : {}),
          ...(typeof field.description === "string" ? { description: field.description } : {}),
          ...(typeof field.required === "boolean" ? { required: field.required } : {}),
          ...(typeof field.placeholder === "string" ? { placeholder: field.placeholder } : {}),
          ...(typeof field.url === "string" ? { url: field.url } : {}),
          ...(typeof field.minimum === "number" && Number.isFinite(field.minimum) ? { minimum: field.minimum } : {}),
          ...(typeof field.maximum === "number" && Number.isFinite(field.maximum) ? { maximum: field.maximum } : {}),
          ...(typeof field.minLength === "number" && Number.isSafeInteger(field.minLength) ? { minLength: field.minLength } : {}),
          ...(typeof field.maxLength === "number" && Number.isSafeInteger(field.maxLength) ? { maxLength: field.maxLength } : {}),
          ...(typeof field.pattern === "string" ? { pattern: field.pattern } : {}),
          ...(typeof field.minItems === "number" && Number.isSafeInteger(field.minItems) ? { minItems: field.minItems } : {}),
          ...(typeof field.maxItems === "number" && Number.isSafeInteger(field.maxItems) ? { maxItems: field.maxItems } : {}),
          ...(Array.isArray(field.when) ? {
            when: field.when.flatMap((condition): Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }> => {
              if (!condition || typeof condition !== "object" || typeof condition.key !== "string" ||
                  (condition.op !== "eq" && condition.op !== "neq") ||
                  !["string", "number", "boolean"].includes(typeof condition.value)) return [];
              return [{ key: condition.key, op: condition.op, value: condition.value as string | number | boolean }];
            })
          } : {}),
          ...(Array.isArray(field.options) ? {
            options: field.options.flatMap((option): Array<{ value: string; label: string; description?: string }> => {
              if (!option || typeof option !== "object" || typeof option.value !== "string" || typeof option.label !== "string") return [];
              return [{ value: option.value, label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }];
            })
          } : {}),
          ...(typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean" ||
              (Array.isArray(defaultValue) && defaultValue.every((value) => typeof value === "string"))
            ? { default: defaultValue as ProviderFormField["default"] }
            : {})
        }];
      });
      const connections = row.connections ?? [];
      return {
        id: row.id ?? "",
        name: row.name ?? row.id ?? "Provider",
        keyMethod: keyMethod ? { ...(keyMethod.label ? { label: keyMethod.label } : {}), fields } : null,
        credentials: connections.flatMap((connection) => connection.type === "credential" && connection.id
          ? [{ id: connection.id, label: connection.label ?? "default" }]
          : []),
        environment: {
          names: [...new Set(methods.flatMap((method) => method.type === "env" ? (method.names ?? []) : []))],
          connected: connections.flatMap((connection) => connection.type === "env" && connection.name ? [connection.name] : [])
        },
        oauth: methods.flatMap((method) => method.type === "oauth" && method.id
          ? [{ id: method.id, label: method.label ?? "OAuth" }]
          : [])
      };
    });
  }

  async connectProviderKey(
    workspace: WorkspaceIdentity,
    integrationID: string,
    key: string,
    label: string | undefined,
    answers: ProviderCredentialAnswers
  ): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness provider setup is not supported yet");
    if (!SUPPORTED_PROVIDER_IDS.includes(integrationID)) throw new Error(`${integrationID} is not a supported provider`);
    if (!this.client) throw new Error("no active session");
    await this.client.integration.connect.key({
      integrationID,
      location: { directory: target.directory },
      key,
      ...(label ? { label } : {}),
      ...(Object.keys(answers).length > 0 ? { answer: answers } : {})
    });
    this.assertTarget(target);
  }

  async startProviderOAuth(workspace: WorkspaceIdentity, integrationID: string, methodID: string): Promise<ProviderOAuthAttempt> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness provider setup is not supported yet");
    if (!SUPPORTED_PROVIDER_IDS.includes(integrationID)) throw new Error(`${integrationID} is not a supported provider`);
    if (!this.client) throw new Error("no active session");
    const res = await this.client.integration.oauth.connect({
      integrationID,
      methodID,
      location: { directory: target.directory }
    });
    const data = (res as { data?: Record<string, unknown> }).data ?? {};
    return {
      attemptID: String(data.attemptID ?? ""),
      url: typeof data.url === "string" ? data.url : "",
      instructions: typeof data.instructions === "string" ? data.instructions : "",
      mode: data.mode === "code" ? "code" : "auto"
    };
  }

  async pollProviderOAuth(workspace: WorkspaceIdentity, integrationID: string, attemptID: string): Promise<ProviderOAuthPoll> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    const res = await this.client.integration.oauth.status({
      integrationID,
      attemptID,
      location: { directory: target.directory }
    });
    const data = (res as { data?: Record<string, unknown> }).data ?? {};
    const status = data.status;
    if (status === "complete") return { status: "complete" };
    if (status === "expired") return { status: "expired" };
    if (status === "failed") return { status: "failed", message: typeof data.message === "string" ? data.message : "Authorization failed" };
    return { status: "pending" };
  }

  async completeProviderOAuth(workspace: WorkspaceIdentity, integrationID: string, attemptID: string, code?: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness provider setup is not supported yet");
    if (!this.client) throw new Error("no active session");
    await this.client.integration.oauth.complete({
      integrationID,
      attemptID,
      location: { directory: target.directory },
      ...(code ? { code } : {})
    });
    this.assertTarget(target);
  }

  async cancelProviderOAuth(workspace: WorkspaceIdentity, integrationID: string, attemptID: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    await this.client.integration.oauth.cancel({
      integrationID,
      attemptID,
      location: { directory: target.directory }
    });
  }

  async stageRevert(workspace: WorkspaceIdentity, messageID: string, files: boolean): Promise<SessionRevertStage> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    const res = await this.client.session.revert.stage({
      sessionID: target.sessionID,
      messageID,
      ...(files ? { files: true } : {})
    });
    const row = (Array.isArray(res) ? res[0] : res) as Record<string, unknown>;
    return {
      messageID: typeof row?.messageID === "string" ? row.messageID : messageID,
      ...(typeof row?.partID === "string" ? { partID: row.partID } : {}),
      ...(typeof row?.snapshot === "string" ? { snapshot: row.snapshot } : {})
    };
  }

  async commitRevert(workspace: WorkspaceIdentity): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    await this.client.session.revert.commit({ sessionID: target.sessionID });
  }

  async clearRevert(workspace: WorkspaceIdentity): Promise<void> {
    const target = this.activeTarget(workspace);
    if (!this.client) throw new Error("no active session");
    this.assertTarget(target);
    await this.client.session.revert.clear({ sessionID: target.sessionID });
  }

  async listMcpServers(workspace: WorkspaceIdentity): Promise<McpServerOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.mcp.list({ location: { directory: target.directory } }).catch(() => []);
    this.assertTarget(target);
    const rows = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (rows as Array<Record<string, unknown>>).flatMap((row) => {
      const name = typeof row.name === "string" ? row.name : "";
      if (!name) return [];
      const status = typeof row.status === "string" ? row.status : "unknown";
      return [{ name, status }];
    });
  }

  async listPlugins(workspace: WorkspaceIdentity): Promise<PluginOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.plugin.list({ location: { directory: target.directory } }).catch(() => []);
    this.assertTarget(target);
    const rows = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (rows as Array<Record<string, unknown>>).flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) return [];
      const source = row.source as Record<string, unknown> | undefined;
      return [{
        id,
        source: source && typeof source.type === "string" ? source.type : "unknown",
        status: typeof row.status === "string" ? row.status : "unknown"
      }];
    });
  }

  async listSkills(workspace: WorkspaceIdentity): Promise<SkillOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.skill.list({ location: { directory: target.directory } }).catch(() => []);
    this.assertTarget(target);
    const rows = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (rows as Array<Record<string, unknown>>).flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      const name = typeof row.name === "string" ? row.name : "";
      if (!id || !name) return [];
      return [{
        id,
        name,
        ...(typeof row.description === "string" ? { description: row.description } : {}),
        ...(row.slash === true ? { slash: true } : {}),
        ...(typeof row.location === "string" ? { location: row.location } : {})
      }];
    });
  }

  async removeProviderCredential(workspace: WorkspaceIdentity, credentialID: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness provider setup is not supported yet");
    if (!this.client) throw new Error("no active session");
    await this.client.credential.remove({ credentialID });
    this.assertTarget(target);
  }

  async switchModel(workspace: WorkspaceIdentity, id: string, providerID: string, variant?: string): Promise<void> {
    const target = this.activeTarget(workspace);
    const runtime = this.contextFor(workspace).runtime;
    if (runtime) {
      await runtime.switchModel(target.sessionID, id, providerID, variant);
      this.assertTarget(target);
      return;
    }
    if (!this.client) throw new Error("no active session");
    await this.client.session.switchModel({
      sessionID: target.sessionID,
      model: { id, providerID, ...(variant ? { variant } : {}) }
    });
    this.assertTarget(target);
  }

  async listAgents(workspace: WorkspaceIdentity): Promise<AgentOption[]> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) return [];
    const res = await this.client.agent.list(
      { location: { directory: target.directory } }
    );
    this.assertTarget(target);
    const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    return (arr as { id?: string; name?: string; color?: string }[])
      .map((a) => ({
        id: a.id ?? "",
        name: a.name ?? a.id ?? "agent",
        ...(a.color ? { color: a.color } : {})
      }))
      .filter((a) => a.id);
  }

  async switchAgent(workspace: WorkspaceIdentity, id: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness agent presets are not supported yet");
    if (!this.client) throw new Error("no active session");
    await this.client.session.switchAgent({ sessionID: target.sessionID, agent: id });
    this.assertTarget(target);
  }

  async modelDefault(workspace: WorkspaceIdentity): Promise<ModelOption | null> {
    const target = this.activeTarget(workspace);
    const runtime = this.contextFor(workspace).runtime;
    if (runtime) return (await runtime.sessionSelection(target.sessionID))?.model ?? null;
    if (!this.client) return null;
    const res = await this.client.model.default(
      { location: { directory: target.directory } }
    );
    this.assertTarget(target);
    const data = res as {
      data?: { id?: string; providerID?: string; name?: string; variants?: { id?: string }[]; variant?: string; limit?: { context?: number } };
    };
     const m = data?.data ?? (res as {
       id?: string;
       modelID?: string;
      providerID?: string;
      name?: string;
      variants?: { id?: string }[];
      variant?: string;
      limit?: { context?: number };
    });
     const id = m ? modelID(m) : "";
     if (!id || !m?.providerID) return null;
     return {
       id,
       providerID: m.providerID,
       name: m.name ?? id,
       variants: variantIDs(m.variants),
      ...(m.variant ? { variant: m.variant } : {}),
      ...(typeof m.limit?.context === "number" && Number.isFinite(m.limit.context) && m.limit.context > 0
        ? { limit: { context: m.limit.context } }
        : {})
    };
  }

  async replyPermission(workspace: WorkspaceIdentity, requestID: string, reply: PermissionReply, sessionID: string): Promise<void> {
    const target = this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) throw new Error("DeepSeek Harness approval responses are not supported yet");
    if (!this.client) throw new Error("no active session");
    assertPermissionSession(target, sessionID);
    await this.client.permission.reply({
      sessionID: target.sessionID,
      requestID,
      decision: reply
    });
    this.assertTarget(target);
  }

  async listPermissions(workspace: WorkspaceIdentity): Promise<PendingPermissionRequest[]> {
    this.activeTarget(workspace);
    if (this.contextFor(workspace).runtime) return [];
    if (!this.client) throw new Error("no active session");
    const res = await this.client.permission.request.list();
    const rows = Array.isArray(res) ? res : ((res as { data?: unknown } | null)?.data ?? []);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row): PendingPermissionRequest[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const sessionID = typeof record.sessionID === "string" ? record.sessionID : "";
      if (!id || !sessionID) return [];
      return [{
        id,
        sessionID,
        action: typeof record.action === "string" && record.action ? record.action : "unknown",
        resources: Array.isArray(record.resources) ? record.resources.map(String) : []
      }];
    });
  }

  async listDir(workspace: WorkspaceIdentity, rel: string): Promise<TreeEntry[]> {
    const root = this.workspaceRoot(workspace);
    const clean = relativePath(rel, true);
    const abs = await confinedPath(root, clean, true);
    this.contextFor(workspace);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    this.contextFor(workspace);
    return entries
      .filter((e) => !(clean === "" && e.name === RECOVERY_DIR))
      .map((e) => ({
        path: clean ? `${clean}/${e.name}` : e.name,
        type: e.isDirectory() ? "directory" : "file"
      }));
  }

  async revealInFileManager(workspace: WorkspaceIdentity, rel: string): Promise<void> {
    const root = this.workspaceRoot(workspace);
    const clean = relativePath(rel, true);
    const abs = await confinedPath(root, clean, true);
    this.contextFor(workspace);
    const item = await fsp.lstat(abs).catch(() => null);
    if (!item || (!item.isFile() && !item.isDirectory())) throw new Error("workspace item is no longer available");
    this.contextFor(workspace);
    shell.showItemInFolder(abs);
  }

  async readFile(workspace: WorkspaceIdentity, rel: string): Promise<string | null> {
    const root = this.workspaceRoot(workspace);
    const clean = relativePath(rel);
    const abs = await confinedPath(root, clean);
    const context = this.contextFor(workspace);
    const content = await this.readExternalText(abs);
    this.contextFor(workspace);
    if (content !== null) {
      const stat = await fsp.stat(abs).catch(() => null);
      this.contextFor(workspace);
      const identity = stat?.isFile() ? this.fileIdentity(stat) : null;
      if (identity) (context.watchContext.identities ??= new Map()).set(abs, identity);
    }
    return content;
  }

  async resolveExternalOpen(workspace: WorkspaceIdentity, value: string): Promise<ExternalOpenResult> {
    const abs = await this.canonicalExternalFile(value);
    const root = this.workspaceRoot(workspace);
    this.contextFor(workspace);
    const content = await this.readExternalText(abs);
    const rel = path.relative(root, abs);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    return inside
      ? { kind: "relative", rel: rel.split(path.sep).join("/"), content }
      : { kind: "standalone", path: abs, content };
  }

  async statExternal(value: string): Promise<ExternalKind> {
    const abs = absoluteFilePath(value);
    const real = await fsp.realpath(abs).catch(() => null);
    if (!real) return { kind: "missing" };
    const stat = await fsp.stat(real).catch(() => null);
    if (!stat) return { kind: "missing" };
    if (stat.isDirectory()) return { kind: "directory" };
    if (stat.isFile()) return { kind: "file" };
    return { kind: "missing" };
  }

  async writeStandaloneFile(
    value: string,
    content: string,
    expectedContent: string,
    overwrite: boolean
  ): Promise<void> {
    const abs = await this.canonicalExternalFile(value);
    const cleanContent = fileContent(content);
    const expected = fileContent(expectedContent);
    const dir = path.dirname(abs);
    await fsp.mkdir(dir, { recursive: true });
    const temporary = path.join(dir, `.openshell-${randomUUID()}.tmp`);
    try {
      const handle = await fsp.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(cleanContent, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const current = await fsp.readFile(abs, "utf8").catch(() => null);
      if (!overwrite && current !== null && current !== expected) throw new Error("file changed on disk");
      try {
        await fsp.rename(temporary, abs);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "EPERM") {
          await fsp.rm(abs, { force: true });
          await fsp.rename(temporary, abs);
        } else {
          throw error;
        }
      }
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async openFileWorkspace(value: string, acceptedGeneration?: number, runtimeID: RuntimeID = "opencode"): Promise<OpenFileWorkspaceResult> {
    if (acceptedGeneration !== undefined && !Number.isSafeInteger(acceptedGeneration)) {
      throw new Error("invalid activation generation");
    }
    const abs = absoluteFilePath(value);
    const real = await fsp.realpath(abs);
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new Error("workspace file is not a file");
    const parent = path.dirname(real);
    const session = await this.openSession(parent, acceptedGeneration, runtimeID);
    return { session, path: path.relative(parent, real).split(path.sep).join("/") };
  }

  async importExternal(
    workspace: WorkspaceIdentity,
    destDir: string,
    sources: string[]
  ): Promise<ImportResult[]> {
    return this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const cleanDest = relativePath(destDir, true);
      const destAbs = await confinedPath(root, cleanDest, true);
      const restartWatcher = context.watcher !== null;
      if (restartWatcher) this.stopWatcher(context);
      watchContext.importing = (watchContext.importing ?? 0) + 1;
      try {
        await fsp.mkdir(destAbs, { recursive: true });
        await confinedPath(root, cleanDest, true);
        this.contextFor(workspace);
        const results: ImportResult[] = [];
        for (const source of sources) {
        const real = await fsp.realpath(source).catch(() => null);
        const name = path.basename(source);
        const rel = cleanDest ? `${cleanDest}/${name}` : name;
        if (!real) {
          results.push({ name, rel, imported: false, reason: "not found" });
          continue;
        }
        const relToRoot = path.relative(root, real);
        const underRoot = relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot);
        const target = path.join(destAbs, name);
        if (underRoot) {
          results.push({ name, rel, imported: false, reason: "already in the workspace" });
          continue;
        }
        const occupied = await fsp.lstat(target).then(() => true).catch(() => false);
        if (occupied) {
          results.push({ name, rel, imported: false, reason: "already exists" });
          continue;
        }
        try {
          const stat = await fsp.stat(real);
          const copied = await this.copyExternal(real, target, stat.isDirectory());
          for (const abs of copied) {
            const content = await fsp.readFile(abs, "utf8").catch(() => null);
            if (content === null) continue;
            watchContext.snapshots.set(abs, knownBaseline(content));
            watchContext.lastKnown.set(abs, content);
          }
          results.push({ name, rel, imported: true });
        } catch (error) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          results.push({ name, rel, imported: false, reason: error instanceof Error ? error.message : String(error) });
        }
        }
        return results;
      } finally {
        const prefix = `${destAbs}${path.sep}`;
        for (const [abs, timer] of watchContext.timers) {
          if (abs === destAbs || abs.startsWith(prefix)) {
            clearTimeout(timer);
            watchContext.timers.delete(abs);
          }
        }
        watchContext.importing = Math.max(0, (watchContext.importing ?? 1) - 1);
        (watchContext.suppressedUntil ??= new Map()).set(destAbs, Date.now() + 10_000);
        if (restartWatcher && this.currentWatch(watchContext)) this.startWatcher(context);
      }
    });
  }

  async writeFile(
    workspace: WorkspaceIdentity,
    rel: string,
    content: string,
    write: FileWriteIdentity
  ): Promise<void> {
    const cleanContent = fileContent(content);
    if (
      !write ||
      typeof write.id !== "string" ||
      write.id.length < 1 ||
      write.id.length > 128 ||
      write.workspaceID !== workspace.id ||
      !Number.isSafeInteger(write.revision) ||
      write.revision < 0 ||
      typeof write.expectedContent !== "string" ||
      typeof write.overwrite !== "boolean"
    ) throw new Error("invalid file write identity");
    const expectedContent = fileContent(write.expectedContent);
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const cleanRel = relativePath(rel);
      const abs = await confinedPath(root, cleanRel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await confinedPath(root, cleanRel);
      this.contextFor(workspace);
      const recovery = await this.createRecoveryTransaction(root, "save", cleanRel);
      const temporary = path.join(recovery.directory, "temporary");
      const holding = path.join(recovery.directory, "original");
      const proposed = path.join(recovery.directory, "proposed");
      let sourceHeld = false;
      let targetInstalled = false;
      try {
        const temporaryHandle = await fsp.open(temporary, "wx", 0o600);
        try {
          await temporaryHandle.writeFile(cleanContent, "utf8");
          await temporaryHandle.sync();
        } finally {
          await temporaryHandle.close();
        }
        await fsp.copyFile(temporary, proposed, constants.COPYFILE_EXCL);
        const proposedHandle = await fsp.open(proposed, "r");
        try {
          await proposedHandle.sync();
        } finally {
          await proposedHandle.close();
        }
        const existing = await fsp.stat(abs).catch(() => null);
        if (existing) await fsp.chmod(temporary, existing.mode);
        recovery.transaction.phase = "temporary-ready";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.syncDirectory(recovery.directory);
        await this.mutationPhase("save:temporary-ready", abs, temporary);
        await confinedPath(root, cleanRel);
        this.contextFor(workspace);
        await fsp.rename(abs, holding);
        await this.syncDirectory(path.dirname(abs));
        await this.syncDirectory(recovery.directory);
        sourceHeld = true;
        recovery.transaction.phase = "source-held";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.mutationPhase("save:source-held", holding, abs);
        const heldContent = await fsp.readFile(holding, "utf8");
        if (!write.overwrite && heldContent !== expectedContent) {
          throw new Error("file changed on disk");
        }
        recovery.transaction.phase = "held-validated";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.mutationPhase("save:held-validated", holding, abs);
        await fsp.link(temporary, abs);
        await this.syncDirectory(path.dirname(abs));
        targetInstalled = true;
        recovery.transaction.phase = "target-installed";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.mutationPhase("save:target-installed", temporary, abs);
        if (await fsp.readFile(abs, "utf8") !== cleanContent) {
          throw new Error("file changed during save");
        }
        recovery.transaction.phase = "complete";
        recovery.transaction.reason = "saved";
        recovery.transaction.acknowledged = ["temporary", "original", "proposed"];
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
      } catch (error) {
        if (sourceHeld && !targetInstalled) {
          try {
            await fsp.link(holding, abs);
          } catch {}
        }
        recovery.transaction.phase = "failed";
        recovery.transaction.reason = "save-failed";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction).catch(() => {});
        const current = await fsp.readFile(abs, "utf8").catch(() => null);
        this.emitFileUpdate(watchContext, abs, current);
        await this.emitRecoveryFor(context);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}; recovery artifacts preserved in ${this.relKey(recovery.directory, root)}`);
      }
      this.contextFor(workspace);
      watchContext.snapshots.set(
        abs,
        preserveBaseline(watchContext.snapshots.get(abs), knownBaseline(expectedContent))
      );
      watchContext.lastKnown.set(abs, cleanContent);
      this.emitFileUpdate(watchContext, abs, cleanContent, undefined, write);
      await this.emitRecoveryFor(context);
    });
  }

  async createFile(workspace: WorkspaceIdentity, rel: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const clean = relativePath(rel);
      const abs = await confinedPath(root, clean);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await confinedPath(root, clean);
      this.contextFor(workspace);
      await fsp.writeFile(abs, "", { flag: "wx" });
      this.contextFor(workspace);
      watchContext.snapshots.set(abs, preserveBaseline(watchContext.snapshots.get(abs), knownBaseline("", false)));
      watchContext.lastKnown.set(abs, "");
      this.emitFileUpdate(watchContext, abs, "");
    });
  }

  async createDir(workspace: WorkspaceIdentity, rel: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const abs = await confinedPath(root, relativePath(rel));
      this.contextFor(workspace);
      await fsp.mkdir(abs, { recursive: false });
    });
  }

  async deletePath(workspace: WorkspaceIdentity, rel: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const abs = await confinedPath(root, relativePath(rel));
      const captured = await this.captureDirectMutation(watchContext, abs);
      this.contextFor(workspace);
      await movePathToTrash(abs, (target) => shell.trashItem(target));
      this.contextFor(workspace);
      watchContext.snapshots.set(abs, captured.baseline);
      watchContext.lastKnown.delete(abs);
      this.emitFileUpdate(watchContext, abs, null, captured.baseline);
    });
  }

  async detachPath(workspace: WorkspaceIdentity, rel: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const abs = await confinedPath(root, relativePath(rel));
      const detachedRoot = path.join(homedir(), ".openshell-detached");
      await fsp.mkdir(detachedRoot, { recursive: true });
      const target = path.join(detachedRoot, `${randomUUID()}-${path.basename(abs)}`);
      await fsp.rename(abs, target);
      this.contextFor(workspace);
      watchContext.snapshots.delete(abs);
      watchContext.lastKnown.delete(abs);
      this.emitFileUpdate(watchContext, abs, null, unknownBaseline);
    });
  }

  async renamePath(workspace: WorkspaceIdentity, rel: string, newName: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const abs = await confinedPath(root, relativePath(rel));
      const parent = this.relKey(path.dirname(abs), root);
      const target = await confinedPath(root, parent ? `${parent}/${fileName(newName)}` : fileName(newName));
      if (target === abs) return;
      this.contextFor(workspace);
      const source = await fsp.lstat(abs);
      if (source.isDirectory()) {
        const occupied = await fsp.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (occupied) throw new Error(`destination already exists: ${path.basename(target)}`);
        this.contextFor(workspace);
        try {
          await fsp.rename(abs, target);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code?.includes("EEXIST") || code === "ENOTEMPTY") {
            throw new Error(`destination already exists: ${path.basename(target)}`);
          }
          throw error;
        }
        this.contextFor(workspace);
        return;
      }
      const captured = await this.captureDirectMutation(watchContext, abs);
      await this.mutationPhase("rename:source-inspected", abs, target);
      const recovery = await this.createRecoveryTransaction(
        root,
        "rename",
        this.relKey(abs, root),
        this.relKey(target, root)
      );
      const holding = path.join(recovery.directory, "source");
      let installed = false;
      try {
        await fsp.rename(abs, holding);
        await this.syncDirectory(path.dirname(abs));
        await this.syncDirectory(recovery.directory);
        recovery.transaction.phase = "source-held";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.mutationPhase("rename:source-held", holding, abs);
        await fsp.link(holding, target);
        await this.syncDirectory(path.dirname(target));
        installed = true;
        recovery.transaction.phase = "target-installed";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
        await this.mutationPhase("rename:target-installed", holding, target);
        recovery.transaction.phase = "complete";
        recovery.transaction.reason = "renamed";
        recovery.transaction.acknowledged = ["rename-source"];
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction);
      } catch (error) {
        if (!installed) {
          try {
            await fsp.link(holding, abs);
            await this.syncDirectory(path.dirname(abs));
          } catch {}
        }
        recovery.transaction.phase = "failed";
        recovery.transaction.reason = "rename-failed";
        await this.writeRecoveryTransaction(recovery.directory, recovery.transaction).catch(() => {});
        await this.emitRecoveryFor(context);
        if ((error as NodeJS.ErrnoException).code?.includes("EEXIST")) {
          throw new Error(`destination already exists: ${path.basename(target)}`);
        }
        throw error;
      }
      this.contextFor(workspace);
      watchContext.snapshots.set(abs, captured.baseline);
      watchContext.lastKnown.delete(abs);
      watchContext.snapshots.set(target, captured.baseline);
      this.emitFileUpdate(watchContext, abs, null, captured.baseline);
      if (!this.currentWatch(watchContext)) return;
      if (captured.content !== null) watchContext.lastKnown.set(target, captured.content);
      else watchContext.lastKnown.delete(target);
      this.emitFileUpdate(watchContext, target, captured.content, captured.baseline);
    });
  }

  async movePath(workspace: WorkspaceIdentity, rel: string, newParent: string): Promise<void> {
    await this.mutations.run(workspace, async () => {
      const root = this.workspaceRoot(workspace);
      const context = this.contextFor(workspace);
      const watchContext = context.watchContext;
      if (!this.currentWatch(watchContext)) throw new Error("stale workspace");
      const clean = relativePath(rel);
      if (clean === RECOVERY_DIR || clean.startsWith(`${RECOVERY_DIR}/`)) {
        throw new Error("cannot move the recovery directory");
      }
      const parentRel = relativePath(newParent, true);
      if (parentRel === RECOVERY_DIR || parentRel.startsWith(`${RECOVERY_DIR}/`)) {
        throw new Error("cannot move into the recovery directory");
      }
      if (parentRel === clean || parentRel.startsWith(`${clean}/`)) {
        throw new Error("cannot move a folder into itself");
      }
      const abs = await confinedPath(root, clean);
      const parentDir = await confinedPath(root, parentRel, true);
      const parentStat = await fsp.lstat(parentDir).catch(() => null);
      if (!parentStat?.isDirectory()) throw new Error("destination folder does not exist");
      const name = path.basename(abs);
      const target = await confinedPath(root, parentRel ? `${parentRel}/${name}` : name);
      if (target === abs) throw new Error("entry is already in that folder");
      const occupied = await fsp.lstat(target).catch(() => null);
      if (occupied) throw new Error(`destination already exists: ${name}`);
      const captured = await this.captureDirectMutation(watchContext, abs);
      this.contextFor(workspace);
      try {
        await fsp.rename(abs, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EXDEV") throw new Error("cannot move across filesystems");
        if (code?.includes("EEXIST")) throw new Error(`destination already exists: ${name}`);
        throw error;
      }
      this.contextFor(workspace);
      watchContext.snapshots.set(abs, captured.baseline);
      watchContext.lastKnown.delete(abs);
      this.emitFileUpdate(watchContext, abs, null, captured.baseline);
      if (!this.currentWatch(watchContext)) return;
      if (captured.content !== null) {
        watchContext.snapshots.set(target, captured.baseline);
        watchContext.lastKnown.set(target, captured.content);
        this.emitFileUpdate(watchContext, target, captured.content, captured.baseline);
      }
    });
  }

  async listProjects(): Promise<ProjectInfo[]> {
    if (!this.client) return [];
    const res = await this.client.project.list();
    const arr = Array.isArray(res) ? res : (res as { data?: unknown }).data ?? [];
    const projects = await Promise.all((arr as { canonical?: string; directory?: string; name?: string }[])
      .map(async (p) => {
        const directory = p.canonical ?? p.directory;
        if (!directory) return null;
        const canonical = await canonicalWorkspaceRoot(directory).catch(() => null);
        return canonical ? { directory: canonical, name: p.name ?? path.basename(canonical) } : null;
      }));
    const available = projects.filter((project): project is ProjectInfo => project !== null);
    return [...new Map([...available].reverse().map((project) => [project.directory, project])).values()].reverse();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activations.invalidate();
    for (const context of this.contexts.values()) {
      context.activations.invalidate();
      this.stopWatcher(context);
    }
    this.contexts.clear();
    this.primary = null;
    for (const controller of this.runtimeSubscriptions.values()) controller.abort();
    this.runtimeSubscriptions.clear();
    const runtimes = [...new Set(this.runtimeAdapters.values())];
    this.runtimeAdapters.clear();
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => {})));
    await this.eventLoop.stop();
  }
}
