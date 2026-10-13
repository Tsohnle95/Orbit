import { normalizeTodos, sessionUsageValues } from "@shared/session-presentation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { normalizePendingForm } from "@shared/forms";
import { formatFailure, normalizeFailure } from "@shared/errors";
import type {
  AgentFileState,
  ApprovalMode,
  BackendMessage,
  OpenFileWorkspaceResult,
  PendingPermissionRequest,
  PermissionReply,
  PromptDelivery,
  SessionRevertStage,
  FormAnswers,
  PendingFormRequest,
  PromptFile,
  ProviderUsageResult,
  RecoveryRecord,
  RuntimeManifest,
  SessionInboxEntry,
  SessionInfo,
  SessionSummary,
  SessionUsage,
  TodoItem,
  TranscriptItem,
  TreeEntry,
  UserAttachment,
  WorkspaceIdentity
} from "@shared/types";
import type { ChatStreamEvent } from "./chat-stream";
import { compactExplorerSelection, movableExplorerPaths } from "./explorer-selection";
import {
  buildRateLimitNotice,
  type ChatSnapshotReadView,
  type RateLimitAction
} from "./chat-store";
import {
  emptyStreamingStore,
  touchStreamingSession,
  type StreamingStore
} from "./streaming";
import { IDLE_ACTIVITY, resolveSessionActivity } from "./session-activity";
import type { SessionAbortFlag } from "./assistant-status";
import {
  addToQueue,
  createMessageQueueTarget,
  getMessageQueueKey,
  loadMessageQueueState,
  persistMessageQueueState,
  removeFromQueue,
  reorderQueue,
  popToInput,
  type FollowUpBehavior,
  type MessageQueueState,
  type MessageQueueTarget,
  type QueuedMessage
} from "./message-queue";
import { requestReveal } from "./reveal";
import { sameWorkspace } from "@shared/generation";
import { retainSessionRecord } from "@shared/retention";
import { useSavedWorkspaces } from "./use-saved-workspaces";
import { useWorkspaceEditor } from "./use-workspace-editor";
import { useSessionSelection } from "./use-session-selection";
import { useSessionInventory } from "./use-session-inventory";
import { useSessionChatRecords } from "./use-session-chat-records";
import { projectPanelViews } from "./panel-projection";
import type { Toast, CtxMenuState, CtxMenuApi, PendingCreate, PanelView, Store } from "./store-contract";

export type { Toast, CtxMenuState, CtxMenuApi, PendingCreate, PanelView, UnsavedEditorFile } from "./store-contract";

const CtxMenuContext = createContext<CtxMenuApi | null>(null);

export function useCtxMenu(): CtxMenuApi {
  const ctx = useContext(CtxMenuContext);
  if (!ctx) throw new Error("useCtxMenu must be used within StoreProvider");
  return ctx;
}

function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join("/"));
  return out;
}

const Ctx = createContext<Store | null>(null);

const HIDDEN_DIRS = new Set([
  ".git", "node_modules", ".next", ".venv", "__pycache__", ".cache", ".turbo", ".svn", ".hg", ".nx", ".openshell-recovery", ".orbit-recovery"
]);

function todoToolName(value: string): boolean {
  return value.toLowerCase().replace(/[^a-z]/g, "") === "todowrite";
}

function normalizeSessionUsage(value: unknown): SessionUsage | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") return null;
  const cache = tokens.cache as Record<string, unknown> | undefined;
  return sessionUsageValues(data.cost, tokens, cache);
}

function todoSnapshotFromTranscript(items: TranscriptItem[]): { key: string; todos: TodoItem[] } | null {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item.kind !== "assistant") continue;
    for (let partIndex = item.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = item.parts[partIndex];
      if (part.kind !== "tool" || !todoToolName(part.tool.title)) continue;
      const metadataTodos = part.tool.metadata?.todos;
      if (Array.isArray(metadataTodos)) {
        return { key: `${part.id}:${JSON.stringify(metadataTodos)}`, todos: normalizeTodos(metadataTodos) };
      }
      try {
        const input = JSON.parse(part.tool.input ?? "{}") as { todos?: unknown };
        return { key: `${part.id}:${part.tool.input ?? ""}`, todos: normalizeTodos(input.todos) };
      } catch {
        return { key: `${part.id}:${part.tool.input ?? ""}`, todos: [] };
      }
    }
  }
  return null;
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function dropKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function filterEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter((e) => {
    const name = e.path.split("/").pop() ?? e.path;
    if (e.type === "directory") return !HIDDEN_DIRS.has(name);
    return name !== ".DS_Store";
  });
}

const AUX_CHAT_STREAM_TYPES = new Set([
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.agent.selected",
  "session.model.selected",
  "session.synthetic",
  "session.skill.activated",
  "session.shell.started",
  "session.shell.ended",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed"
]);

function normalizeStreamEvent(msg: BackendMessage): ChatStreamEvent | null {  if (msg.kind !== "event") return null;
  const event = msg.data as Record<string, any> | undefined;
  const data = (event?.data ?? event?.properties ?? event) as Record<string, any> | undefined;
  const rawType = msg.type ?? event?.type ?? event?.event ?? "";
  const type = rawType === "permission.v2.asked"
    ? "permission.asked"
    : rawType === "permission.v2.replied"
      ? "permission.replied"
      : rawType;
  if (!data || !type) return null;
  return {
    id: String(event?.id ?? `${type}-${Date.now()}`),
    type,
    created: Number(event?.created ?? Date.now()),
    data,
    ...(Array.isArray(event?.orbitSessionIDs)
      ? { ownerSessionIDs: event.orbitSessionIDs.filter((value: unknown): value is string => typeof value === "string") }
      : {})
  };
}

const ACTIVE_CHAT_STREAM_TYPES = new Set([
  "session.step.started",
  "session.text.started",
  "session.text.delta",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.called",
  "session.tool.progress",
  "session.retry.scheduled",
  "message.part.delta"
]);

function streamEventShowsActiveWork(event: ChatStreamEvent): boolean {
  if (ACTIVE_CHAT_STREAM_TYPES.has(event.type)) return true;
  if (event.type === "message.updated") {
    const info = (event.data.info ?? event.data) as Record<string, any>;
    const role = String(info.role ?? info.type ?? "assistant");
    return role === "assistant" && !info.time?.completed && !info.finish && !info.error;
  }
  if (event.type === "message.part.updated") {
    const part = (event.data.part ?? event.data) as Record<string, any>;
    const state = part.state as Record<string, any> | undefined;
    const status = String(state?.status ?? "");
    return !part.time?.completed && !["completed", "error", "failed", "success", "aborted", "timeout", "cancelled"].includes(status);
  }
  return false;
}

function failureForStreamEvent(type: string, data: Record<string, any>): { error: unknown; code: string; message: string } | null {
  if (type === "session.step.failed") return { error: data.error, code: "ORBIT_STEP_FAILED", message: "Step failed" };
  if (type === "session.execution.failed") return { error: data.error, code: "ORBIT_EXECUTION_FAILED", message: "Execution failed" };
  if (type === "session.tool.failed") return { error: data.error, code: "ORBIT_TOOL_FAILED", message: "Tool failed" };
  if (type === "session.retry.scheduled") return { error: data.error, code: "ORBIT_RETRY_SCHEDULED", message: "Retry scheduled" };
  if (type === "message.updated" && data.info?.error) return { error: data.info.error, code: "ORBIT_ASSISTANT_FAILED", message: "Assistant failed" };
  if (type === "message.part.updated") {
    const part = (data.part ?? data) as Record<string, any>;
    const state = part.state as Record<string, any> | undefined;
    if (["error", "failed", "aborted", "timeout", "cancelled"].includes(String(state?.status))) {
      return { error: state?.error, code: "ORBIT_TOOL_FAILED", message: "Tool failed" };
    }
  }
  return null;
}

let toastId = 0;

const EMPTY_AGENT_FILES: Map<string, AgentFileState> = new Map();
const EMPTY_TREE: Record<string, TreeEntry[]> = {};
const EMPTY_EXPANDED: Set<string> = new Set();
const STALE_SESSION_LAYOUT_KEY = "orbit.sessionLayout";
const STREAM_SETTLE_MS = 60_000;
const STREAM_SETTLE_IDLE_MS = 2_000;
const STREAM_SETTLE_POLL_MS = 1_000;

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const openCtxMenu = useCallback((x: number, y: number, target: TreeEntry | null, workspaceSessionID?: string) => {
    setCtxMenu({ x, y, target, workspaceSessionID });
  }, []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const ctxMenuApi = useMemo<CtxMenuApi>(
    () => ({ ctxMenu, openCtxMenu, closeCtxMenu }),
    [ctxMenu, openCtxMenu, closeCtxMenu]
  );
  const body = useMemo(() => <StoreBody closeCtxMenu={closeCtxMenu}>{children}</StoreBody>, [children, closeCtxMenu]);
  return (
    <CtxMenuContext.Provider value={ctxMenuApi}>
      {body}
    </CtxMenuContext.Provider>
  );
}

const StoreBody = memo(function StoreBody({ children, closeCtxMenu }: { children: ReactNode; closeCtxMenu: () => void }): ReactNode {
  const [panels, setPanels] = useState<SessionInfo[]>([]);
  const [workspaceOnlyPanelIDs, setWorkspaceOnlyPanelIDs] = useState<Set<string>>(() => new Set());
  const [activeSessionID, setActiveSessionID] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeManifest[]>([]);
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>({});
  const [todosByWorkspace, setTodosByWorkspace] = useState<Record<string, TodoItem[]>>({});
  const protectedSessionIDs = useCallback(
    (): Set<string> => new Set(panelsRef.current.map((panel) => panel.id)),
    []
  );

  const {
    transcriptsBySession, rawChatReadMap, transcriptFor, hasTranscript, recordStatusFor,
    snapshotSession, reduceSessionEvent, completeLatest, attachRetry, projectSession: applyProjection,
    deriveChangedStreaming, deriveStreaming, prepareReopenedReplay, commitReplayTranscript,
    mergeMaterializedRecords, hydratePromptRecords, reconcilePromptTranscript, forgetRecords,
    appendTranscriptItem, appendUniqueTranscriptItem, replaceTranscriptItemAtTail,
    appendRateLimitNotice,
    appendPromptUser, promoteDeliveredInput, reduceAuxiliaryEvent,
    addPermissionFromEvent, resolvePermission, reconcilePermissionRows
  } = useSessionChatRecords(protectedSessionIDs);
  const [inboxBySession, setInboxBySession] = useState<Record<string, SessionInboxEntry[]>>({});
  const [formsBySession, setFormsBySession] = useState<Record<string, PendingFormRequest[]>>({});
  const [stagedReverts, setStagedReverts] = useState<Record<string, SessionRevertStage | null>>({});
  const [agentFilesByWorkspace, setAgentFilesByWorkspace] = useState<Record<string, Map<string, AgentFileState>>>({});
  const [treeByWorkspace, setTreeByWorkspace] = useState<Record<string, Record<string, TreeEntry[]>>>({});
  const [expandedByWorkspace, setExpandedByWorkspace] = useState<Record<string, Set<string>>>({});
  const [hiddenPathsByWorkspace, setHiddenPathsByWorkspace] = useState<Record<string, Set<string>>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recoveryByWorkspace, setRecoveryByWorkspace] = useState<Record<string, RecoveryRecord[]>>({});
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(
    () => (window.localStorage.getItem("approvalMode") === "approve" ? "approve" : "ask")
  );
  const [usageBySession, setUsageBySession] = useState<Record<string, SessionUsage>>({});
  const [compactionBaselineBySession, setCompactionBaselineBySession] = useState<Record<string, number>>(() => {
    try {
      const raw = window.localStorage.getItem("compactionBaseline");
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });
  const [providerUsage, setProviderUsage] = useState<ProviderUsageResult[]>([]);
  const [providerUsageLoading, setProviderUsageLoading] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<{ path: string } | null>(null);
  const [streamingStore, setStreamingStore] = useState<StreamingStore>(() => emptyStreamingStore());
  const [messageQueue, setMessageQueue] = useState<MessageQueueState>(() => loadMessageQueueState());
  const [sessionAbortFlags, setSessionAbortFlags] = useState<Record<string, SessionAbortFlag>>({});

  const activeWorkspaceID = activeSessionID
    ? (panels.find((panel) => panel.id === activeSessionID)?.workspace.id ?? null)
    : null;
  const session = activeWorkspaceID
    ? (panels.find((panel) => panel.workspace.id === activeWorkspaceID) ?? null)
    : null;

  useEffect(() => {
    if (!session) return;
    setHiddenPathsByWorkspace((current) => ({ ...current, [session.workspace.id]: new Set() }));
  }, [session?.directory, session?.workspace.id]);
  useEffect(() => {
    try {
      window.localStorage.removeItem("runtimeID");
    } catch {}
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("compactionBaseline", JSON.stringify(compactionBaselineBySession));
    } catch {}
  }, [compactionBaselineBySession]);
  const busy = session ? Boolean(busyBySession[session.id]) : false;
  const todos = session ? (todosByWorkspace[session.workspace.id] ?? []) : [];
  const transcript = session ? transcriptsBySession[session.id] ?? [] : [];
  const sessionUsage = session ? usageBySession[session.id] ?? null : null;
  const agentFiles = session ? agentFilesByWorkspace[session.workspace.id] ?? EMPTY_AGENT_FILES : EMPTY_AGENT_FILES;
  const tree = session ? treeByWorkspace[session.workspace.id] ?? EMPTY_TREE : EMPTY_TREE;
  const expanded = session ? expandedByWorkspace[session.workspace.id] ?? EMPTY_EXPANDED : EMPTY_EXPANDED;
  const hiddenPaths = session ? hiddenPathsByWorkspace[session.workspace.id] ?? EMPTY_EXPANDED : EMPTY_EXPANDED;
  const recoveryRecords = session ? recoveryByWorkspace[session.workspace.id] ?? [] : [];
  const refreshRuntimes = useCallback(async (): Promise<RuntimeManifest[]> => {
    const items = await window.openshell.runtimes();
    setRuntimes(items);
    return items;
  }, []);

  useEffect(() => {
    void refreshRuntimes().catch(() => setRuntimes([]));
  }, [refreshRuntimes]);

  useEffect(() => {
    const open = new Set(panels.map((panel) => panel.id));
    setBusyBySession((current) => {
      const entries = Object.entries(current).filter(([id]) => open.has(id) || id in transcriptsBySession);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [panels, transcriptsBySession]);

  useEffect(() => {
    let changed = false;
    const next: Record<string, number> = { ...compactionBaselineBySession };
    for (const panel of panels) {
      const transcript = transcriptsBySession[panel.id];
      const usage = usageBySession[panel.id];
      if (!transcript || !usage) continue;
      if (compactionBaselineBySession[panel.id] != null) continue;
      if (!transcript.some((item) => item.kind === "compaction")) continue;
      if (usage.tokens.input <= 10000) continue;
      next[panel.id] = Math.max(0, usage.tokens.input - 10000);
      changed = true;
    }
    if (changed) setCompactionBaselineBySession(next);
  }, [panels, transcriptsBySession, usageBySession, compactionBaselineBySession]);

  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const usageBySessionRef = useRef(usageBySession);
  usageBySessionRef.current = usageBySession;
  const compactionBaselineBySessionRef = useRef(compactionBaselineBySession);
  compactionBaselineBySessionRef.current = compactionBaselineBySession;
  const inboxBySessionRef = useRef(inboxBySession);
  inboxBySessionRef.current = inboxBySession;
  const formsBySessionRef = useRef(formsBySession);
  formsBySessionRef.current = formsBySession;
  const busyBySessionRef = useRef(busyBySession);
  busyBySessionRef.current = busyBySession;
  const sessionAbortFlagsRef = useRef(sessionAbortFlags);
  sessionAbortFlagsRef.current = sessionAbortFlags;
  const lastStreamActivityRef = useRef<Record<string, number>>({});
  const streamingRef = useRef<StreamingStore>(streamingStore);
  const messageQueueRef = useRef<MessageQueueState>(messageQueue);
  const agentFilesByWorkspaceRef = useRef(agentFilesByWorkspace);
  agentFilesByWorkspaceRef.current = agentFilesByWorkspace;
  const expandedByWorkspaceRef = useRef(expandedByWorkspace);
  expandedByWorkspaceRef.current = expandedByWorkspace;
  const pendingCreateRef = useRef(pendingCreate);
  pendingCreateRef.current = pendingCreate;
  const pendingRenameRef = useRef(pendingRename);
  pendingRenameRef.current = pendingRename;
  const todoKeysRef = useRef<Record<string, string>>({});
  const approvalModeRef = useRef<ApprovalMode>(approvalMode);
  approvalModeRef.current = approvalMode;
  const sessionRef = useRef<SessionInfo | null>(session);
  sessionRef.current = session;
  const requestSeqRef = useRef(0);
  const providerUsageSeqRef = useRef(0);
  const activationSeqRef = useRef(0);
  const userActivatedRef = useRef(false);
  const focusSeqRef = useRef(0);
  const startupRestoreStartedRef = useRef(false);
  const treeRefreshTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const toast = useCallback((text: string, tone: "info" | "error" = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const {
    activeSessions, sessions, refreshActiveSessions, addActiveSession,
    removeActiveSession, loadSessions, activeSessionFor, summaryFor,
    upsertSummary, renameSummary, removeSummary
  } = useSessionInventory(toast);

  useEffect(() => {
    const timer = setInterval(() => void refreshActiveSessions(), 1000);
    return () => clearInterval(timer);
  }, [refreshActiveSessions]);

  const panelFor = useCallback(
    (workspace: WorkspaceIdentity): SessionInfo | null =>
      panelsRef.current.find((panel) => sameWorkspace(panel.workspace, workspace)) ?? null,
    []
  );

  const panelForSession = useCallback(
    (sessionID: string): SessionInfo | null =>
      panelsRef.current.find((panel) => panel.id === sessionID) ?? null,
    []
  );

  const workspaceOfSession = useCallback(
    (sessionID: string): WorkspaceIdentity | null =>
      panelsRef.current.find((panel) => panel.id === sessionID)?.workspace ?? null,
    []
  );

  const setAgentFilesFor = useCallback((
    workspaceID: string,
    update: Map<string, AgentFileState> | ((prev: Map<string, AgentFileState>) => Map<string, AgentFileState>)
  ) => {
    setAgentFilesByWorkspace((current) => {
      const previous = current[workspaceID] ?? new Map<string, AgentFileState>();
      const next = typeof update === "function" ? update(previous) : update;
      return previous === next ? current : { ...current, [workspaceID]: next };
    });
  }, []);

  const setTreeFor = useCallback((workspaceID: string, update: (prev: Record<string, TreeEntry[]>) => Record<string, TreeEntry[]>) => {
    setTreeByWorkspace((current) => {
      const next = update(current[workspaceID] ?? {});
      return next === (current[workspaceID] ?? {}) ? current : { ...current, [workspaceID]: next };
    });
  }, []);

  const setExpandedFor = useCallback((workspaceID: string, next: Set<string>) => {
    setExpandedByWorkspace((current) =>
      current[workspaceID] === next ? current : { ...current, [workspaceID]: next });
  }, []);

  const setRecoveryFor = useCallback((workspaceID: string, records: RecoveryRecord[]) => {
    setRecoveryByWorkspace((current) =>
      current[workspaceID] === records ? current : { ...current, [workspaceID]: records });
  }, []);

  const setTodosFor = useCallback((workspaceID: string, items: TodoItem[]) => {
    setTodosByWorkspace((current) =>
      current[workspaceID] === items ? current : { ...current, [workspaceID]: items });
  }, []);

  const setSessionBusy = useCallback((sessionID: string, value: boolean) => {
    setBusyBySession((current) => current[sessionID] === value
      ? current
      : { ...current, [sessionID]: value });
  }, []);

  const reconcilePermissions = useCallback(async (): Promise<void> => {
    const panels = panelsRef.current;
    if (panels.length === 0) return;
    const workspaces = new Map<string, WorkspaceIdentity>();
    for (const panel of panels) workspaces.set(panel.workspace.id, panel.workspace);
    const fetched = new Map<string, PendingPermissionRequest[]>();
    const successfulWorkspaces = new Set<string>();
    await Promise.all([...workspaces.values()].map(async (workspace) => {
      const requests = await window.openshell.listPermissions(workspace).catch(() => null);
      if (!requests) return;
      successfulWorkspaces.add(workspace.id);
      for (const request of requests) {
        const list = fetched.get(request.sessionID) ?? [];
        list.push(request);
        fetched.set(request.sessionID, list);
      }
    }));
    for (const panel of panels) {
      // A failed permission-list request is not proof that the session has no
      // pending approvals. Keep the event-backed card until a later poll can
      // confirm the request is gone.
      if (!successfulWorkspaces.has(panel.workspace.id)) continue;
      const requests = fetched.get(panel.id) ?? [];
      reconcilePermissionRows(panel.id, requests);
    }
  }, [reconcilePermissionRows]);

  const materializingRef = useRef(new Set<string>());
  const swapPendingRef = useRef(false);
  const replacingSessionIDsRef = useRef(new Map<string, number>());

  const commitStreaming = useCallback((next: StreamingStore) => {
    streamingRef.current = next;
    setStreamingStore(next);
  }, []);

  const commitQueue = useCallback((next: MessageQueueState) => {
    messageQueueRef.current = next;
    setMessageQueue(next);
    persistMessageQueueState(next);
  }, []);

  const syncStreaming = useCallback((sessionID: string, previous: ChatSnapshotReadView) => {
    const next = deriveChangedStreaming(sessionID, previous, streamingRef.current);
    if (next) commitStreaming(next);
  }, [deriveChangedStreaming, commitStreaming]);

  const reconcileStreaming = useCallback((sessionID: string) => {
    const next = deriveStreaming(sessionID, streamingRef.current);
    if (next) commitStreaming(next);
  }, [deriveStreaming, commitStreaming]);

  useEffect(() => {
    const finalizeTrailingAssistant = (sessionID: string, reason: "settle" | "idle"): void => {
      const wasBusy = Boolean(busyBySessionRef.current[sessionID]);
      completeLatest(sessionID);
      applyProjection(sessionID);
      reconcileStreaming(sessionID);
      setSessionBusy(sessionID, false);
      if (wasBusy) {
        const detail = reason === "settle" ? "Turn stalled — recovered" : "Recovered incomplete turn";
        const id = ++toastId;
        setToasts((prev) => [...prev.slice(-3), { id, text: detail, tone: "info" }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
      }
    };
    const timer = setInterval(() => {
      const now = Date.now();
      for (const panel of panelsRef.current) {
        const transcript = transcriptFor(panel.id);
        const trailing = [...transcript].reverse().find((item) => item.kind === "assistant");
        const isBusy = Boolean(busyBySessionRef.current[panel.id]);
        if (trailing?.kind !== "assistant" || trailing.completed) {
          if (!isBusy) continue;
          const lastActivity = lastStreamActivityRef.current[panel.id];
          if (lastActivity === undefined) {
            lastStreamActivityRef.current[panel.id] = now;
            continue;
          }
          if (now - lastActivity < STREAM_SETTLE_MS) continue;
          setSessionBusy(panel.id, false);
          const id = ++toastId;
          setToasts((prev) => [...prev.slice(-3), { id, text: "Turn stalled — recovered", tone: "info" }]);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
          continue;
        }
        if (!isBusy) {
          const lastActivity = lastStreamActivityRef.current[panel.id];
          if (lastActivity === undefined) {
            lastStreamActivityRef.current[panel.id] = now;
            continue;
          }
          if (now - lastActivity < STREAM_SETTLE_IDLE_MS) continue;
          finalizeTrailingAssistant(panel.id, "idle");
          continue;
        }
        if (trailing.retry) {
          const next = trailing.retry.next;
          if (typeof next === "number" && next > now && next - now < 60_000) continue;
        }
        const lastActivity = lastStreamActivityRef.current[panel.id];
        if (lastActivity === undefined) {
          lastStreamActivityRef.current[panel.id] = now;
          continue;
        }
        if (now - lastActivity < STREAM_SETTLE_MS) continue;
        finalizeTrailingAssistant(panel.id, "settle");
      }
    }, STREAM_SETTLE_POLL_MS);
    return () => clearInterval(timer);
  }, [completeLatest, applyProjection, reconcileStreaming, setSessionBusy, transcriptFor]);

  const setFollowUpBehavior = useCallback((behavior: FollowUpBehavior) => {
    commitQueue({ ...messageQueueRef.current, followUpBehavior: behavior });
  }, [commitQueue]);

  const queueTargetFor = useCallback((workspace: WorkspaceIdentity): MessageQueueTarget | null => {
    const panel = panelFor(workspace);
    return panel ? createMessageQueueTarget(panel.id, panel.workspace.id) : null;
  }, [panelFor]);

  const { savedWorkspaces, rememberWorkspace, replaceSavedWorkspace, saveWorkspace, removeWorkspace } = useSavedWorkspaces(connected, toast);
  const {
    models, currentModel, agents, currentAgent, availableModels, lastModel,
    modelsByWorkspace, currentModelByWorkspace, agentsByWorkspace, currentAgentByWorkspace,
    loadModels, switchModel, loadAgents, switchAgent,
    applyModelSelection, applyAgentSelection
  } = useSessionSelection({ sessionRef, panelFor, notify: toast });

  const refreshInbox = useCallback(async (sessionID: string): Promise<void> => {
    const panel = panelsRef.current.find((candidate) => candidate.id === sessionID);
    if (!panel) return;
    try {
      const entries = await window.openshell.inboxList(panel.workspace);
      setInboxBySession((current) => ({ ...current, [sessionID]: entries }));
    } catch (error) {
      if (panelForSession(sessionID)) {
        toast(formatFailure(error, "ORBIT_INBOX_REFRESH_FAILED", "Queued prompts could not be refreshed"), "error");
      }
    }
  }, [panelForSession, toast]);

  const refreshForms = useCallback(async (sessionID: string): Promise<void> => {
    const panel = panelsRef.current.find((candidate) => candidate.id === sessionID);
    if (!panel) return;
    try {
      const forms = await window.openshell.formsList(panel.workspace);
      setFormsBySession((current) => ({ ...current, [sessionID]: forms }));
    } catch {}
  }, []);

  const removeQueuedMessage = useCallback((workspace: WorkspaceIdentity, messageID: string) => {
    const target = queueTargetFor(workspace);
    if (!target) return;
    if (!messageID.startsWith("queued-")) {
      setInboxBySession((current) => ({
        ...current,
        [target.sessionID]: (current[target.sessionID] ?? []).filter((entry) => entry.id !== messageID)
      }));
      window.openshell.inboxCancel(workspace, messageID).catch(() => {});
      return;
    }
    commitQueue(removeFromQueue(messageQueueRef.current, target, messageID));
  }, [queueTargetFor, commitQueue]);

  const popQueuedMessage = useCallback((workspace: WorkspaceIdentity, messageID: string): QueuedMessage | null => {
    const target = queueTargetFor(workspace);
    if (!target) return null;
    if (!messageID.startsWith("queued-")) {
      const entry = (inboxBySessionRef.current[target.sessionID] ?? []).find(
        (candidate) => candidate.id === messageID
      );
      if (!entry) return null;
      setInboxBySession((current) => ({
        ...current,
        [target.sessionID]: (current[target.sessionID] ?? []).filter((item) => item.id !== messageID)
      }));
      window.openshell.inboxCancel(workspace, messageID).catch(() => {});
      return { id: entry.id, content: entry.text, createdAt: entry.createdAt };
    }
    const popped = popToInput(messageQueueRef.current, target, messageID);
    commitQueue(popped.state);
    return popped.message;
  }, [queueTargetFor, commitQueue]);

  const reorderQueuedMessage = useCallback((workspace: WorkspaceIdentity, fromID: string, toID: string) => {
    const target = queueTargetFor(workspace);
    if (!target) return;
    commitQueue(reorderQueue(messageQueueRef.current, target, fromID, toID));
  }, [queueTargetFor, commitQueue]);

  const refreshSessionUsage = useCallback(async (sessionID: string): Promise<void> => {
    if (!panelForSession(sessionID)) return;
    try {
      const usage = await (window.openshell.sessionUsage
        ? window.openshell.sessionUsage(sessionID)
        : Promise.resolve(null));
      if (!panelForSession(sessionID) || !usage) return;
      setUsageBySession((current) => retainSessionRecord(current, sessionID, usage, protectedSessionIDs()));
    } catch {
    }
  }, [panelForSession, protectedSessionIDs]);

  const materializeSession = useCallback(async (sessionID: string): Promise<void> => {
    const panel = panelForSession(sessionID);
    if (!panel || materializingRef.current.has(sessionID)) return;
    materializingRef.current.add(sessionID);
    try {
      const [snapshot, usage] = await Promise.all([
        window.openshell.sessionTranscript(sessionID),
        window.openshell.sessionUsage
          ? window.openshell.sessionUsage(sessionID).catch(() => null)
          : Promise.resolve(null)
      ]);
      if (!panelForSession(sessionID)) return;
      const aborted = sessionAbortFlagsRef.current[sessionID]?.acknowledged === false;
      mergeMaterializedRecords(sessionID, snapshot.transcript, aborted);
      applyProjection(sessionID);
      reconcileStreaming(sessionID);
      setTodosFor(panel.workspace.id, snapshot.todos);
      if (usage) {
        setUsageBySession((current) => retainSessionRecord(current, sessionID, usage, protectedSessionIDs()));
        const hasCompaction = snapshot.transcript.some((item) => item.kind === "compaction");
        const existingBaseline = compactionBaselineBySessionRef.current[sessionID];
        if (hasCompaction && (existingBaseline == null) && usage.tokens.input > 10000) {
          const estimatedWindow = 10000;
          setCompactionBaselineBySession((prev) => ({
            ...prev,
            [sessionID]: Math.max(0, usage.tokens.input - estimatedWindow)
          }));
        }
      }
      const trailing = [...snapshot.transcript].reverse().find((item) => item.kind === "assistant");
      if (aborted || !trailing || trailing.completed) setSessionBusy(sessionID, false);
    } catch (error) {
      if (panelForSession(sessionID)) {
        toast(formatFailure(error, "ORBIT_SESSION_MATERIALIZE_FAILED", "Session state could not be refreshed"), "error");
      }
    } finally {
      materializingRef.current.delete(sessionID);
    }
  }, [panelForSession, mergeMaterializedRecords, applyProjection, reconcileStreaming, setTodosFor, setSessionBusy, protectedSessionIDs, toast]);

  const submitForm = useCallback(async (
    workspace: WorkspaceIdentity,
    formID: string,
    answers: FormAnswers,
    formSessionID?: string
  ): Promise<void> => {
    const panel = panelFor(workspace);
    if (!panel) return;
    setFormsBySession((current) => ({
      ...current,
      [panel.id]: (current[panel.id] ?? []).filter((form) => form.id !== formID)
    }));
    try {
      await window.openshell.formReply(workspace, formID, answers, formSessionID);
    } catch (err) {
      void refreshForms(panel.id);
      if (panelFor(workspace)) toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [panelFor, refreshForms, toast]);

  const dismissForm = useCallback((workspace: WorkspaceIdentity, formID: string, formSessionID?: string): void => {
    const panel = panelFor(workspace);
    if (!panel) return;
    setFormsBySession((current) => ({
      ...current,
      [panel.id]: (current[panel.id] ?? []).filter((form) => form.id !== formID)
    }));
    window.openshell.formCancel(workspace, formID, formSessionID).catch(() => {});
  }, [panelFor]);

  const sendQueuedNow = useCallback(async (workspace: WorkspaceIdentity, messageID: string): Promise<void> => {
    const panel = panelFor(workspace);
    if (!panel) return;
    if (!messageID.startsWith("queued-")) {
      setInboxBySession((current) => ({
        ...current,
        [panel.id]: (current[panel.id] ?? []).filter((entry) => entry.id !== messageID)
      }));
      try {
        await window.openshell.inboxSteer(workspace, messageID);
      } catch (err) {
        void refreshInbox(panel.id);
        const failure = formatFailure(err, "ORBIT_INBOX_STEER_FAILED", "Queued prompt could not be sent");
        appendUniqueTranscriptItem(panel.id, { kind: "status", id: `queued-steer-error-${messageID}`, text: failure, tone: "error" });
        if (panelFor(workspace)) toast(failure, "error");
      }
      return;
    }
    const popped = popQueuedMessage(workspace, messageID);
    if (!popped) return;
    const promptText = popped.content || "Review the attached files.";
    const attachments: UserAttachment[] = (popped.attachments ?? []).map((file) => ({
      name: file.path.split(/[\\/]/).pop() ?? file.path
    }));
    const createdAt = Date.now();
    const selectedAgent = currentAgentByWorkspace[panel.workspace.id];
    const selectedModel = currentModelByWorkspace[panel.workspace.id];
    appendTranscriptItem(panel.id, {
        kind: "user",
        id: `user-${createdAt}`,
        text: promptText,
        createdAt,
        ...(selectedAgent ? { agent: selectedAgent.id } : {}),
        ...(selectedModel ? { model: { id: selectedModel.id, providerID: selectedModel.providerID } } : {}),
        ...(attachments.length > 0 ? { attachments } : {})
    });
    try {
      await window.openshell.prompt(workspace, promptText, popped.attachments ?? []);
    } catch (err) {
      const failure = formatFailure(err, "ORBIT_PROMPT_FAILED", "Queued prompt failed");
      const queueTarget = createMessageQueueTarget(panel.id, panel.workspace.id);
      if (queueTarget) commitQueue(addToQueue(messageQueueRef.current, queueTarget, {
        content: promptText,
        attachments: popped.attachments
      }));
      appendTranscriptItem(panel.id, { kind: "status", id: `queued-error-${messageID}`, text: failure, tone: "error" });
      if (panelFor(workspace)) toast(failure, "error");
    }
  }, [panelFor, popQueuedMessage, appendTranscriptItem, appendUniqueTranscriptItem, toast, refreshInbox, commitQueue, currentAgentByWorkspace, currentModelByWorkspace]);

  const attachPanel = useCallback((info: SessionInfo, saveWorkspace = true): void => {
    if (saveWorkspace) rememberWorkspace(info.directory);
    panelsRef.current = panelsRef.current.some((panel) => panel.id === info.id)
      ? panelsRef.current.map((panel) => (panel.id === info.id ? info : panel))
      : [...panelsRef.current, info];
    setPanels(panelsRef.current);
    addActiveSession(info);
  }, [addActiveSession, rememberWorkspace]);

  const hydrateTranscript = useCallback(
    async (sessionID: string): Promise<void> => {
      const request = ++requestSeqRef.current;
      try {
        const reopened = await window.openshell.openSessionById(sessionID, request);
        if (!panelForSession(sessionID)) return;
        const aborted = sessionAbortFlagsRef.current[sessionID]?.acknowledged === false;
        const merged = prepareReopenedReplay(sessionID, reopened.transcript, aborted);
        reconcileStreaming(sessionID);
        commitReplayTranscript(sessionID, merged);
        const running = [...reopened.transcript].reverse().find((item) => item.kind === "assistant");
        setBusyBySession((current) => sessionID in current
          ? current
          : {
              ...current,
              [sessionID]: !aborted && Boolean(running?.kind === "assistant" && !running.completed)
            });
        if (aborted) applyProjection(sessionID);
        setTodosFor(reopened.session.workspace.id, reopened.todos);
        if (reopened.usage) {
          setUsageBySession((current) => retainSessionRecord(
            current,
            sessionID,
            reopened.usage!,
            protectedSessionIDs()
          ));
        }
      } catch (err) {
        if (panelForSession(sessionID)) {
          toast(formatFailure(err, "ORBIT_SESSION_OPEN_FAILED", "Session could not be opened"), "error");
        }
      }
    },
    [toast, panelForSession, prepareReopenedReplay, commitReplayTranscript, reconcileStreaming, applyProjection, setTodosFor, protectedSessionIDs]
  );

  const clearStagedRevert = useCallback(async (workspace: WorkspaceIdentity): Promise<void> => {
    const panel = panelFor(workspace);
    if (!panel) return;
    try {
      await window.openshell.revertClear(workspace);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setStagedReverts((current) => ({ ...current, [panel.id]: null }));
    }
  }, [panelFor, toast]);

  const commitStagedRevert = useCallback(async (workspace: WorkspaceIdentity): Promise<void> => {
    const panel = panelFor(workspace);
    if (!panel) return;
    try {
      await window.openshell.revertCommit(workspace);
      setStagedReverts((current) => ({ ...current, [panel.id]: null }));
      await hydrateTranscript(panel.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [panelFor, toast, hydrateTranscript]);

  const stageRevert = useCallback(async (workspace: WorkspaceIdentity, messageID: string): Promise<void> => {
    const panel = panelFor(workspace);
    if (!panel) return;
    try {
      const staged = await window.openshell.revertStage(workspace, messageID, true);
      setStagedReverts((current) => ({ ...current, [panel.id]: staged }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [panelFor, toast]);


  const focusSession = useCallback((sessionID: string, hydrate = true): void => {
    const panel = panelsRef.current.find((candidate) => candidate.id === sessionID);
    if (!panel) return;
    userActivatedRef.current = true;
    focusSeqRef.current += 1;
    sessionRef.current = panel;
    setActiveSessionID(sessionID);
    closeCtxMenu();
    setPendingCreate(null);
    setPendingRename(null);
    if (hydrate && !hasTranscript(sessionID)) void hydrateTranscript(sessionID);
  }, [hydrateTranscript, closeCtxMenu, hasTranscript]);

  const {
    tabs, activePath, singleFile, unsavedEditorFiles, unsavedEditorFileCount,
    activePathByWorkspace, dirtyTabsFor, doSaveRef,
    openFile, openExternalPath, setActive, setTabMode, saveAllEditorFiles,
    closeTab, saveTab, editContent, reloadTab, overwriteTab, mergeTab,
    setSingleFileFor, addCreatedFile, removePathTabs, removePathsTabs,
    renameTabs, movePathTabs, movePathsTabs, prepareFileUpdate, applyFileUpdate,
    cancelPrefix, cancelAll
  } = useWorkspaceEditor({ sessionRef, panelsRef, panelFor, focusSession, agentFilesRef: agentFilesByWorkspaceRef, notify: toast });

  const ejectPanelFromView = useCallback((sessionID: string): SessionInfo | null => {
    const closing = panelsRef.current.find((panel) => panel.id === sessionID) ?? null;
    if (!closing) return null;
    panelsRef.current = panelsRef.current.filter((panel) => panel.id !== sessionID);
    setPanels(panelsRef.current);
    const childDirectory = closing.directory.replaceAll("\\", "/").replace(/\/+$/, "");
    setHiddenPathsByWorkspace((current) => {
      let changed = false;
      const next = { ...current };
      for (const panel of panelsRef.current) {
        const parentDirectory = panel.directory.replaceAll("\\", "/").replace(/\/+$/, "");
        if (!childDirectory.startsWith(`${parentDirectory}/`)) continue;
        const relative = childDirectory.slice(parentDirectory.length + 1);
        const paths = current[panel.workspace.id];
        if (!paths?.has(relative)) continue;
        const restored = new Set(paths);
        restored.delete(relative);
        next[panel.workspace.id] = restored;
        changed = true;
      }
      return changed ? next : current;
    });
    setWorkspaceOnlyPanelIDs((current) => {
      if (!current.has(sessionID)) return current;
      const next = new Set(current);
      next.delete(sessionID);
      return next;
    });
    if (sessionRef.current?.id === sessionID) {
      const neighbor = panelsRef.current[panelsRef.current.length - 1] ?? null;
      sessionRef.current = neighbor;
      setActiveSessionID(neighbor?.id ?? null);
    }
    return closing;
  }, []);

  const detachPanel = useCallback((sessionID: string): void => {
    // Replacement without teardown: the session leaves the visible panels
    // but its backend context, Open now entry, and chat state stay alive so
    // the user can jump back to it. Only an explicit close tears it down.
    ejectPanelFromView(sessionID);
  }, [ejectPanelFromView]);

  const finishClosePanel = useCallback((sessionID: string, preserveBusy: boolean): void => {
    const closing = panelsRef.current.find((panel) => panel.id === sessionID);
    const active = activeSessionFor(sessionID);
    if (!closing && active) {
      removeActiveSession(sessionID);
      setBusyBySession((current) => dropKey(current, sessionID));
      setSessionAbortFlags((current) => dropKey(current, sessionID));
      void window.openshell.closeSession(active.workspace).catch(() => {});
      return;
    }
    const ejected = ejectPanelFromView(sessionID);
    if (!ejected) return;
    const keepActive = preserveBusy && Boolean(busyBySessionRef.current[sessionID]);
    if (!keepActive) {
      removeActiveSession(sessionID);
      forgetRecords(sessionID);
      materializingRef.current.delete(sessionID);
      setCompactionBaselineBySession((current) => {
        if (!(sessionID in current)) return current;
        const { [sessionID]: _dropped, ...rest } = current;
        void _dropped;
        return rest;
      });
    }
    if (!keepActive) {
      void window.openshell.closeSession(ejected.workspace).catch(() => {});
    }
  }, [removeActiveSession, ejectPanelFromView, activeSessionFor, forgetRecords]);

  const closePanel = useCallback((sessionID: string, preserveBusy = false): void => {
    const closing = panelsRef.current.find((panel) => panel.id === sessionID);
    const active = activeSessionFor(sessionID);
    const workspace = closing?.workspace ?? active?.workspace;
    const dirtyTabs = workspace
      ? dirtyTabsFor(workspace.id)
      : [];
    if (dirtyTabs.length > 0 && workspace) {
      if (dirtyTabs.some((tab) => tab.conflict)) {
        toast("Resolve external file conflicts before closing this workspace.", "error");
        return;
      }
      const snapshots = dirtyTabs.map((tab) => ({
        workspace,
        path: tab.path,
        content: tab.content,
        expectedContent: tab.saved,
        revision: tab.revision,
        standalone: tab.standalone
      }));
      void Promise.all(snapshots.map((snapshot) => doSaveRef.current(snapshot))).then((saved) => {
        if (saved.every(Boolean)) finishClosePanel(sessionID, preserveBusy);
      });
      return;
    }
    finishClosePanel(sessionID, preserveBusy);
  }, [finishClosePanel, toast, activeSessionFor]);

  const replacePanels = useCallback((next: SessionInfo): void => {
    for (const panel of [...panelsRef.current]) {
      if (panel.id !== next.id) detachPanel(panel.id);
    }
    attachPanel(next);
  }, [attachPanel, detachPanel]);

  const loadRecovery = useCallback(async (workspace: WorkspaceIdentity) => {
    try {
      const records = await window.openshell.recoveryRecords(workspace);
      if (panelFor(workspace)) setRecoveryFor(workspace.id, records);
    } catch (error) {
      if (panelFor(workspace)) {
        toast(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }, [toast, panelFor, setRecoveryFor]);

  useEffect(() => {
    if (connected) void loadSessions();
  }, [connected, loadSessions]);

  const deleteSession = useCallback(async (sessionID: string): Promise<void> => {
    const panel = panelForSession(sessionID);
    const summary = summaryFor(sessionID);
    const title = panel?.title ?? summary?.title ?? sessionID;
    if (!window.confirm(`Delete session "${title}"? This permanently removes it from opencode and cannot be undone.`)) return;
    try {
      if (panel) closePanel(sessionID);
      await window.openshell.deleteSession(sessionID);
      toast(`Deleted session ${title}`);
      void loadSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [panelForSession, closePanel, toast, loadSessions, summaryFor]);

  const replacePanel = useCallback((workspace: WorkspaceIdentity, info: SessionInfo): boolean => {
    const index = panelsRef.current.findIndex((panel) => sameWorkspace(panel.workspace, workspace));
    if (index === -1) return false;
    rememberWorkspace(info.directory);
    // Detach without teardown (see detachPanel): the replaced session keeps
    // its backend context and Open now entry so it stays jumpable; only an
    // explicit close ends it.
    ejectPanelFromView(panelsRef.current[index].id);
    // The eject above already removed the old entry, so the survivors after
    // `index` have shifted down one slot.
    panelsRef.current = [
      ...panelsRef.current.slice(0, index),
      info,
      ...panelsRef.current.slice(index).filter((panel) => !sameWorkspace(panel.workspace, info.workspace))
    ];
    setPanels(panelsRef.current);
    userActivatedRef.current = true;
    focusSeqRef.current += 1;
    sessionRef.current = info;
    setActiveSessionID(info.id);
    addActiveSession(info);
    return true;
  }, [addActiveSession, ejectPanelFromView, rememberWorkspace]);

  const swapPanelTo = useCallback((workspace: WorkspaceIdentity, info: SessionInfo): void => {
    if (!replacePanel(workspace, info)) {
      void window.openshell.closeSession(info.workspace).catch(() => {});
      return;
    }
    void hydrateTranscript(info.id);
    void refreshInbox(info.id);
    void refreshForms(info.id);
    void loadRecovery(info.workspace);
    void loadModels(info.workspace);
    void loadAgents(info.workspace);
    void loadSessions();
  }, [replacePanel, loadRecovery, loadModels, loadAgents, loadSessions, hydrateTranscript]);

  const openSession = useCallback(
    async (dir: string): Promise<SessionInfo | null> => {
      const request = ++requestSeqRef.current;
      const activation = ++activationSeqRef.current;
      try {
        const info = await window.openshell.openSession(dir, request);
        if (activation !== activationSeqRef.current) {
          await window.openshell.closeSession(info.workspace).catch(() => {});
          return null;
        }
        if (dir !== info.directory) replaceSavedWorkspace(dir, info.directory);
        userActivatedRef.current = true;
        replacePanels(info);
        focusSeqRef.current += 1;
        sessionRef.current = info;
        setActiveSessionID(info.id);
        void hydrateTranscript(info.id);
    void refreshInbox(info.id);
    void refreshForms(info.id);
        void loadRecovery(info.workspace);
        toast(`Opened ${info.directory}`);
        void loadModels(info.workspace);
        void loadAgents(info.workspace);
        void loadSessions();
        return info;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        return null;
      }
    },
    [replacePanels, replaceSavedWorkspace, toast, loadModels, loadAgents, loadRecovery, loadSessions, hydrateTranscript]
  );

  const addModelPanel = useCallback(
    async (dir: string) => {
      const request = ++requestSeqRef.current;
      const activation = activationSeqRef.current;
      try {
        const info = await window.openshell.openSession(dir, request);
        if (activation !== activationSeqRef.current) {
          await window.openshell.closeSession(info.workspace).catch(() => {});
          return;
        }
        const source = dir.replaceAll("\\", "/").replace(/\/+$/, "");
        for (const panel of panelsRef.current) {
          const parent = panel.directory.replaceAll("\\", "/").replace(/\/+$/, "");
          if (!source.startsWith(`${parent}/`)) continue;
          const relative = source.slice(parent.length + 1);
          setHiddenPathsByWorkspace((current) => {
            const next = new Set(current[panel.workspace.id] ?? []);
            next.add(relative);
            return { ...current, [panel.workspace.id]: next };
          });
        }
        attachPanel(info);
        userActivatedRef.current = true;
        focusSeqRef.current += 1;
        sessionRef.current = info;
        setActiveSessionID(info.id);
        void hydrateTranscript(info.id);
    void refreshInbox(info.id);
    void refreshForms(info.id);
        void loadRecovery(info.workspace);
        void loadModels(info.workspace);
        void loadAgents(info.workspace);
        void loadSessions();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [attachPanel, toast, loadModels, loadAgents, loadRecovery, loadSessions, hydrateTranscript]
  );

  const openWorkspacePanel = useCallback(async (dir: string): Promise<void> => {
    await addModelPanel(dir);
    const opened = sessionRef.current;
    if (!opened) return;
    setWorkspaceOnlyPanelIDs((current) => {
      const next = new Set(current);
      next.add(opened.id);
      return next;
    });
  }, [addModelPanel]);

  const selectAddPanel = useCallback(async (): Promise<SessionInfo | null> => {
    const request = ++requestSeqRef.current;
    const activation = activationSeqRef.current;
    try {
      const info = await window.openshell.selectFolder(request);
      if (!info) return null;
      if (activation !== activationSeqRef.current) {
        await window.openshell.closeSession(info.workspace).catch(() => {});
        return null;
      }
      attachPanel(info);
      userActivatedRef.current = true;
      focusSeqRef.current += 1;
      sessionRef.current = info;
      setActiveSessionID(info.id);
      void hydrateTranscript(info.id);
    void refreshInbox(info.id);
    void refreshForms(info.id);
      void loadRecovery(info.workspace);
      void loadModels(info.workspace);
      void loadAgents(info.workspace);
      void loadSessions();
      return info;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      return null;
    }
  }, [attachPanel, toast, loadModels, loadAgents, loadRecovery, loadSessions, hydrateTranscript]);

  const swapPanelWorkspace = useCallback(
    async (workspace: WorkspaceIdentity, pick: (request: number) => Promise<SessionInfo | null>) => {
      const request = ++requestSeqRef.current;
      const activation = activationSeqRef.current;
      swapPendingRef.current = true;
      try {
        const info = await pick(request);
        if (!info) return;
        if (activation !== activationSeqRef.current) {
          await window.openshell.closeSession(info.workspace).catch(() => {});
          return;
        }
        swapPanelTo(workspace, info);
      } catch (err) {
        if (panelFor(workspace)) toast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        swapPendingRef.current = false;
      }
    },
    [swapPanelTo, toast, panelFor]
  );

  const selectPanelDirectory = useCallback(
    (workspace: WorkspaceIdentity) =>
      swapPanelWorkspace(workspace, (request) => window.openshell.selectFolder(request)),
    [swapPanelWorkspace]
  );

  const changePanelDirectory = useCallback(
    (workspace: WorkspaceIdentity, dir: string) =>
      swapPanelWorkspace(workspace, (request) => window.openshell.openSession(dir, request)),
    [swapPanelWorkspace]
  );

  const selectFolder = useCallback(async () => {
    const request = ++requestSeqRef.current;
    const activation = ++activationSeqRef.current;
    try {
      const info = await window.openshell.selectFolder(request);
      if (info) {
        if (activation !== activationSeqRef.current) {
          await window.openshell.closeSession(info.workspace).catch(() => {});
          return;
        }
        userActivatedRef.current = true;
        replacePanels(info);
        focusSeqRef.current += 1;
        sessionRef.current = info;
        setActiveSessionID(info.id);
        void hydrateTranscript(info.id);
    void refreshInbox(info.id);
    void refreshForms(info.id);
        void loadRecovery(info.workspace);
        toast(`Opened ${info.directory}`);
        void loadModels(info.workspace);
        void loadAgents(info.workspace);
        void loadSessions();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [replacePanels, toast, loadModels, loadAgents, loadRecovery, loadSessions, hydrateTranscript]);

  const reopenSession = useCallback(
    async (sessionID: string, silent = false, directoryHint?: string): Promise<SessionInfo | null> => {
      const existing = panelForSession(sessionID);
      if (existing) {
        if (!hasTranscript(sessionID)) void hydrateTranscript(sessionID);
        if (!silent) {
          focusSession(sessionID);
          void loadSessions();
        }
        return existing;
      }
      const request = ++requestSeqRef.current;
      const activation = silent ? 0 : ++activationSeqRef.current;
      const targetWorkspace = silent ? null : sessionRef.current?.workspace ?? null;
      const previousDirectory = directoryHint ?? summaryFor(sessionID)?.directory;
      if (!silent) {
        replacingSessionIDsRef.current.set(sessionID, (replacingSessionIDsRef.current.get(sessionID) ?? 0) + 1);
      }
      try {
        const reopened = silent
          ? await window.openshell.openSessionById(sessionID, request)
          : await window.openshell.openSessionById(sessionID, request, undefined, true);
        if (!silent && activation !== activationSeqRef.current) {
          await window.openshell.closeSession(reopened.session.workspace).catch(() => {});
          return null;
        }
        if (silent) {
          attachPanel(reopened.session, false);
        } else if (targetWorkspace) {
          if (!replacePanel(targetWorkspace, reopened.session)) {
            await window.openshell.closeSession(reopened.session.workspace).catch(() => {});
            return null;
          }
        } else {
          replacePanels(reopened.session);
          userActivatedRef.current = true;
          focusSeqRef.current += 1;
          sessionRef.current = reopened.session;
          setActiveSessionID(reopened.session.id);
        }
        if (!silent && previousDirectory && previousDirectory !== reopened.session.directory) {
          replaceSavedWorkspace(previousDirectory, reopened.session.directory);
        }
        void loadRecovery(reopened.session.workspace);
        const merged = prepareReopenedReplay(reopened.session.id, reopened.transcript, false);
        reconcileStreaming(reopened.session.id);
        commitReplayTranscript(reopened.session.id, merged);
        const running = [...reopened.transcript].reverse().find((item) => item.kind === "assistant");
        setBusyBySession((current) => reopened.session.id in current
          ? current
          : {
              ...current,
              [reopened.session.id]: Boolean(running?.kind === "assistant" && !running.completed)
            });
        setTodosFor(reopened.session.workspace.id, reopened.todos);
        if (reopened.usage) {
          setUsageBySession((current) => retainSessionRecord(
            current,
            reopened.session.id,
            reopened.usage!,
            protectedSessionIDs()
          ));
        }
        void loadModels(reopened.session.workspace);
        void loadAgents(reopened.session.workspace);
        void loadSessions();
        return reopened.session;
      } catch (err) {
        if (!silent) toast(err instanceof Error ? err.message : String(err), "error");
        return null;
      } finally {
        if (!silent) {
          const pending = replacingSessionIDsRef.current.get(sessionID) ?? 0;
          if (pending <= 1) replacingSessionIDsRef.current.delete(sessionID);
          else replacingSessionIDsRef.current.set(sessionID, pending - 1);
        }
      }
    },
    [
    attachPanel,
    replacePanels,
    replacePanel,
    replaceSavedWorkspace,
    focusSession,
    panelForSession,
    prepareReopenedReplay,
    commitReplayTranscript,
    hasTranscript,
    reconcileStreaming,
    setTodosFor,
    toast,
    loadModels,
    loadAgents,
    loadSessions,
    loadRecovery,
    hydrateTranscript,
    protectedSessionIDs,
    summaryFor,
  ]
  );

  const sendPrompt = useCallback(
    async (text: string, files: PromptFile[] = [], workspace?: WorkspaceIdentity) => {
      const target = workspace ?? sessionRef.current?.workspace;
      const panel = target ? panelFor(target) : null;
      if (!panel || !target) {
        toast("[ORBIT_PROMPT_NO_SESSION] No active session is available for this prompt", "error");
        return;
      }
      const t = text.trim();
      if (!t && files.length === 0) {
        toast("[ORBIT_PROMPT_EMPTY] Enter a prompt or attach a file", "error");
        return;
      }
      const promptText = t || "Review the attached files.";
      const abortFlag = sessionAbortFlagsRef.current[panel.id];
      if (abortFlag && !abortFlag.acknowledged) {
        const nextAbortFlags = {
          ...sessionAbortFlagsRef.current,
          [panel.id]: { ...abortFlag, acknowledged: true }
        };
        sessionAbortFlagsRef.current = nextAbortFlags;
        setSessionAbortFlags(nextAbortFlags);
      }
      const transcript = transcriptFor(panel.id);
      const trailingAssistant = [...transcript].reverse().find((item) => item.kind === "assistant");
      const trailingAssistantIncomplete = trailingAssistant?.kind === "assistant" && !trailingAssistant.completed;
      const activity = resolveSessionActivity({
        sessionId: panel.id,
        statusType: trailingAssistantIncomplete && streamingRef.current.streamingMessageIds.get(panel.id)
          ? (trailingAssistant?.kind === "assistant" && trailingAssistant.retry ? "retry" : "busy")
          : undefined,
        trailingAssistantIncomplete,
        pendingPermissions: transcript.filter((item) => item.kind === "permission" && item.pending).length
      });
      const delivery: PromptDelivery | undefined = activity.isWorking
        ? messageQueueRef.current.followUpBehavior
        : undefined;
      if (delivery === "queue") toast(`Queued: ${promptText}`);
      const attachments: UserAttachment[] = files.map((file) => ({
        name: file.path.split(/[\\/]/).pop() ?? file.path
      }));
      const createdAt = Date.now();
      const selectedAgent = currentAgentByWorkspace[panel.workspace.id];
      const selectedModel = currentModelByWorkspace[panel.workspace.id];
      const userItem: TranscriptItem = {
        kind: "user",
        id: `user-${createdAt}`,
        text: promptText,
        createdAt,
        ...(selectedAgent ? { agent: selectedAgent.id } : {}),
        ...(selectedModel ? { model: { id: selectedModel.id, providerID: selectedModel.providerID } } : {}),
        ...(attachments.length > 0 ? { attachments } : {})
      };
      appendPromptUser(panel.id, userItem);
      setTodosFor(panel.workspace.id, []);
      setSessionBusy(panel.id, true);
      const applyCanonicalTranscript = (refreshed: Awaited<ReturnType<typeof window.openshell.prompt>>): void => {
        const merged = reconcilePromptTranscript(panel.id, refreshed.transcript, userItem);
        lastStreamActivityRef.current[panel.id] = Date.now();
        hydratePromptRecords(panel.id, merged);
        reconcileStreaming(panel.id);
      };
      try {
        const refreshed = await window.openshell.prompt(target, promptText, files, delivery);
        if (panelFor(target)) {
          applyCanonicalTranscript(refreshed);
          setInboxBySession((current) => {
            const list = current[panel.id];
            if (!list?.some((entry) => entry.text === promptText && entry.delivery !== "queue")) return current;
            return { ...current, [panel.id]: list.filter((entry) => entry.text !== promptText || entry.delivery === "queue") };
          });
        }
      } catch (err) {
        const failure = normalizeFailure(err, "ORBIT_PROMPT_FAILED", "Prompt failed");
        const failureText = formatFailure(failure);
        const failureID = `prompt-error-${userItem.id}`;
        appendUniqueTranscriptItem(panel.id, { kind: "status", id: failureID, text: failureText, tone: "error" });
        if (panelFor(target)) {
          if (delivery === "queue") {
            const queueTarget = createMessageQueueTarget(panel.id, panel.workspace.id);
            if (queueTarget) {
              commitQueue(addToQueue(messageQueueRef.current, queueTarget, { content: promptText, attachments: files }));
              toast(`${failureText}; queued locally: ${promptText}`, "error");
              return;
            }
          }
          setSessionBusy(panel.id, false);
          toast(failureText, "error");
        }
      }
    },
    [
    toast,
    panelFor,
    setTodosFor,
    appendUniqueTranscriptItem,
    reconcilePromptTranscript,
    setSessionBusy,
    commitQueue,
    hydratePromptRecords,
    appendPromptUser,
    reconcileStreaming,
    currentAgentByWorkspace,
    currentModelByWorkspace,
    transcriptFor,
  ]
  );

  const runCommand = useCallback(async (name: string, args = "", workspace?: WorkspaceIdentity) => {
    const target = workspace ?? sessionRef.current?.workspace;
    if (!target) return;
    try {
      await window.openshell.runCommand(target, name, args);
      if (name === "compact" || name === "compress") {
        toast("Compacting session…");
        const panel = panelFor(target);
        if (panel) {
          setTimeout(() => void refreshSessionUsage(panel.id), 1500);
          // The compaction event may arrive late (or its immediate poll may
          // race the server commit); re-poll once more as a backstop.
          setTimeout(() => void refreshSessionUsage(panel.id), 10_000);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (panelFor(target)) {
        toast(message, "error");
        throw error;
      }
    }
  }, [panelFor, toast, refreshSessionUsage]);

  const stop = useCallback(async (workspace?: WorkspaceIdentity) => {
    const target = workspace ?? sessionRef.current?.workspace;
    const panel = target ? panelFor(target) : null;
    if (!panel || !target) return;
    const abortFlag = { timestamp: Date.now(), acknowledged: false };
    const nextAbortFlags = { ...sessionAbortFlagsRef.current, [panel.id]: abortFlag };
    sessionAbortFlagsRef.current = nextAbortFlags;
    setSessionAbortFlags(nextAbortFlags);
    const previous = snapshotSession(panel.id);
    const interrupted = reduceSessionEvent(panel.id, {
      id: `local-interrupt-${abortFlag.timestamp}`,
      type: "session.execution.interrupted",
      created: abortFlag.timestamp,
      data: { sessionID: panel.id }
    });
    if (interrupted === true || (typeof interrupted !== "boolean" && interrupted.changed)) {
      applyProjection(panel.id);
    }
    syncStreaming(panel.id, previous);
    setSessionBusy(panel.id, false);
    await window.openshell.interrupt(target).catch((error) => {
      toast(formatFailure(error, "ORBIT_INTERRUPT_FAILED", "The prompt could not be interrupted"), "error");
    });
  }, [setSessionBusy, panelFor, toast, snapshotSession, reduceSessionEvent, applyProjection, syncStreaming]);

  const refreshProviderUsage = useCallback(async () => {
    const sequence = ++providerUsageSeqRef.current;
    setProviderUsageLoading(true);
    try {
      const next = await window.openshell.providerUsage();
      if (sequence === providerUsageSeqRef.current) setProviderUsage(next);
    } catch (err) {
      if (sequence === providerUsageSeqRef.current) toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      if (sequence === providerUsageSeqRef.current) setProviderUsageLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    for (const panel of panels) {
      if (!busyBySession[panel.id]) continue;
      const snapshot = todoSnapshotFromTranscript(transcriptsBySession[panel.id] ?? []);
      if (!snapshot || snapshot.key === todoKeysRef.current[panel.workspace.id]) continue;
      todoKeysRef.current[panel.workspace.id] = snapshot.key;
      setTodosFor(panel.workspace.id, snapshot.todos);
    }
  }, [panels, busyBySession, transcriptsBySession, setTodosFor]);

  const replyPermission = useCallback(
    async (requestID: string, reply: PermissionReply, sessionID?: string) => {
      const sid = sessionID ?? sessionRef.current?.id;
      const panel = sid ? panelForSession(sid) : null;
      if (!panel) return;
      try {
        await window.openshell.permissionReply(panel.workspace, requestID, reply, panel.id);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        return;
      }
      resolvePermission(panel.id, requestID, reply);
    },
    [toast, panelForSession, resolvePermission]
  );

  const toggleApprovalMode = useCallback(() => {
    setApprovalMode((current) => {
      const next = current === "approve" ? "ask" : "approve";
      approvalModeRef.current = next;
      window.localStorage.setItem("approvalMode", next);
      return next;
    });
  }, []);

  const toggleDir = useCallback(
    async (path: string) => {
      const target = sessionRef.current?.workspace;
      if (!target) return;
      const current = expandedByWorkspaceRef.current[target.id] ?? new Set<string>();
      const isOpen = current.has(path);
      setExpandedFor(target.id, (() => {
        const next = new Set(current);
        if (isOpen) next.delete(path);
        else next.add(path);
        return next;
      })());
      if (isOpen) return;
      if (!treeByWorkspace[target.id]?.[path]) {
        try {
          const entries = await window.openshell.listDir(target, path);
          if (!panelFor(target)) return;
          setTreeFor(target.id, (prev) => ({ ...prev, [path]: sortEntries(filterEntries(entries)) }));
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), "error");
        }
      }
    },
    [treeByWorkspace, toast, panelFor, setExpandedFor, setTreeFor]
  );

  const ensureRootOpen = useCallback(
    async (): Promise<void> => {
      const target = sessionRef.current?.workspace;
      if (!target) return;
      const current = expandedByWorkspaceRef.current[target.id] ?? new Set<string>();
      const wasOpen = current.has("");
      if (!wasOpen) {
        const next = new Set(current);
        next.add("");
        setExpandedFor(target.id, next);
      }
      if (wasOpen || !treeByWorkspace[target.id]?.[""]) {
        try {
          const entries = await window.openshell.listDir(target, "");
          if (!panelFor(target)) return;
          setTreeFor(target.id, (prev) => ({ ...prev, "": sortEntries(filterEntries(entries)) }));
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), "error");
        }
      }
    },
    [treeByWorkspace, toast, panelFor, setExpandedFor, setTreeFor]
  );

  const refreshTree = useCallback(async (dirs: string[], workspace?: WorkspaceIdentity): Promise<void> => {
    const unique = [...new Set(dirs)];
    const target = workspace ?? sessionRef.current?.workspace;
    if (!target) return;
    const current = expandedByWorkspaceRef.current[target.id] ?? new Set<string>();
    if (current.has("") && !unique.includes("")) unique.push("");
    await Promise.all(
      unique.map(async (dir) => {
        try {
          const entries = await window.openshell.listDir(target, dir);
          if (!panelFor(target)) return;
          setTreeFor(target.id, (prev) => ({ ...prev, [dir]: sortEntries(filterEntries(entries)) }));
        } catch {
          /* keep previous listing */
        }
      })
    );
  }, [panelFor, setTreeFor]);

  const removeFromWorkspace = useCallback((path: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    const confirmed = window.confirm(`Remove "${path}" from Orbit? The item will remain on disk.`);
    if (!confirmed) return;
    closeCtxMenu();
    setHiddenPathsByWorkspace((current) => {
      const next = new Set(current[target.id] ?? []);
      next.add(path);
      return { ...current, [target.id]: next };
    });
    void window.openshell.detachPath(target, path).then(() => {
      setHiddenPathsByWorkspace((current) => {
        const next = new Set(current[target.id] ?? []);
        next.delete(path);
        return { ...current, [target.id]: next };
      });
      void refreshTree(ancestorDirs(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""));
    }).catch((error) => toast(error instanceof Error ? error.message : String(error), "error"));
  }, [closeCtxMenu, refreshTree, toast]);

  const startCreate = useCallback((parent: string, kind: "file" | "dir") => {
    closeCtxMenu();
    setPendingRename(null);
    setPendingCreate({ parent, kind });
    const target = sessionRef.current?.workspace;
    if (!target) return;
    const current = expandedByWorkspaceRef.current[target.id] ?? new Set<string>();
    if (current.has(parent)) return;
    const next = new Set(current);
    next.add(parent);
    setExpandedFor(target.id, next);
  }, [setExpandedFor, closeCtxMenu]);

  const startRename = useCallback((path: string) => {
    closeCtxMenu();
    setPendingCreate(null);
    setPendingRename({ path });
  }, [closeCtxMenu]);

  const revealInFileManager = useCallback(async (path: string): Promise<void> => {
    closeCtxMenu();
    const target = sessionRef.current?.workspace;
    if (!target) return;
    try {
      await window.openshell.revealInFileManager(target, path);
    } catch (err) {
      if (panelFor(target)) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    }
  }, [closeCtxMenu, panelFor, toast]);

  const unhidePath = useCallback((path: string): void => {
    const target = sessionRef.current;
    if (!target || !hiddenPathsByWorkspace[target.workspace.id]?.has(path)) return;
    setHiddenPathsByWorkspace((current) => {
      const next = new Set(current[target.workspace.id] ?? []);
      next.delete(path);
      return { ...current, [target.workspace.id]: next };
    });
  }, [hiddenPathsByWorkspace]);

  const cancelPending = useCallback(() => {
    setPendingCreate(null);
    setPendingRename(null);
  }, []);

  const deleteEntry = useCallback(
    async (path: string, workspace?: WorkspaceIdentity) => {
      closeCtxMenu();
      const target = workspace ?? sessionRef.current?.workspace;
      if (!target) return;
      cancelPrefix(target, path);
      try {
        await window.openshell.deletePath(target, path);
      } catch (err) {
        if (panelFor(target)) {
          toast(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (!panelFor(target)) return;
      removePathTabs(target, path);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      void refreshTree(ancestorDirs(parent), target);
    },
    [toast, refreshTree, cancelPrefix, panelFor, removePathTabs, closeCtxMenu]
  );

  const deleteEntries = useCallback(async (paths: string[]): Promise<void> => {
    const workspace = sessionRef.current?.workspace;
    if (!workspace) return;
    closeCtxMenu();
    const selected = compactExplorerSelection(paths);
    const deleted: string[] = [];
    for (const path of selected) {
      cancelPrefix(workspace, path);
      try {
        await window.openshell.deletePath(workspace, path);
        deleted.push(path);
      } catch (err) {
        if (panelFor(workspace)) toast(err instanceof Error ? err.message : String(err), "error");
      }
    }
    if (deleted.length === 0 || !panelFor(workspace)) return;
    removePathsTabs(workspace, deleted);
    const parents = deleted.map((path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    void refreshTree(parents.flatMap((parent) => ancestorDirs(parent)), workspace);
  }, [closeCtxMenu, cancelPrefix, panelFor, toast, removePathsTabs, refreshTree]);

  const importPaths = useCallback(
    async (destDir: string, sources: string[]): Promise<void> => {
      const target = sessionRef.current?.workspace;
      if (!target || sources.length === 0) return;
      try {
        const results = await window.openshell.importExternal(target, destDir, sources);
        if (!panelFor(target)) return;
        for (const result of results) {
          if (result.imported) toast(`Imported ${result.rel}`);
          else if (hiddenPathsByWorkspace[target.id]?.has(result.rel)) {
            unhidePath(result.rel);
            continue;
          }
          else if (result.reason === "already exists" || result.reason === "already in the workspace") continue;
          else toast(`Could not import ${result.name}: ${result.reason ?? "unknown"}`, "error");
        }
        void refreshTree([...ancestorDirs(destDir)]);
      } catch (err) {
        if (panelFor(target)) toast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [toast, panelFor, refreshTree, hiddenPathsByWorkspace, unhidePath]
  );
  const dropIntoExplorer = useCallback(
    async (paths: string[]): Promise<void> => {
      if (paths.length === 0) return;
      await importPaths("", paths);
    },
    [importPaths]
  );
  const dismissChange = useCallback((path: string): void => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    const current = agentFilesByWorkspaceRef.current[target.id];
    if (!current?.has(path)) return;
    const next = new Map(current);
    next.delete(path);
    setAgentFilesFor(target.id, next);
  }, [setAgentFilesFor]);
  const dismissChanges = useCallback((): void => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    const current = agentFilesByWorkspaceRef.current[target.id];
    if (!current || current.size === 0) return;
    setAgentFilesFor(target.id, new Map());
  }, [setAgentFilesFor]);
  const attachFileWorkspace = useCallback(
    async (result: OpenFileWorkspaceResult, activation: number): Promise<SessionInfo | null> => {
      if (activation !== activationSeqRef.current) {
        await window.openshell.closeSession(result.session.workspace).catch(() => {});
        return null;
      }
      userActivatedRef.current = true;
      replacePanels(result.session);
      focusSeqRef.current += 1;
      sessionRef.current = result.session;
      setActiveSessionID(result.session.id);
      setSingleFileFor(result.session.workspace.id, result.path);
      void hydrateTranscript(result.session.id);
      void loadRecovery(result.session.workspace);
      void loadModels(result.session.workspace);
      void loadAgents(result.session.workspace);
      void loadSessions();
      await openFile(result.path, { mode: "edit" }, result.session.workspace);
      return result.session;
    },
    [replacePanels, setSingleFileFor, hydrateTranscript, loadRecovery, loadModels, loadAgents, loadSessions, openFile]
  );
  const selectFile = useCallback(
    async (): Promise<void> => {
      const request = ++requestSeqRef.current;
      const activation = ++activationSeqRef.current;
      try {
        const result = await window.openshell.selectFile(request);
        if (!result) return;
        const info = await attachFileWorkspace(result, activation);
        if (info) toast(`Opened ${result.path}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [attachFileWorkspace, toast]
  );
  const openFileWorkspace = useCallback(
    async (file: string): Promise<SessionInfo | null> => {
      const request = ++requestSeqRef.current;
      const activation = ++activationSeqRef.current;
      try {
        const result = await window.openshell.openFileWorkspace(file, request);
        const info = await attachFileWorkspace(result, activation);
        if (info) toast(`Opened ${result.path}`);
        return info;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        return null;
      }
    },
    [attachFileWorkspace, toast]
  );
  const openSourceTarget = useCallback(
    async (path: string, line: number): Promise<void> => {
      if (!path.startsWith("/")) return;
      const active = sessionRef.current?.workspace ?? null;
      if (active) {
        const openedPath = await openExternalPath(path, active);
        if (openedPath) requestReveal(openedPath, line);
        return;
      }
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (!dir || dir === path) return;
      const opened = await openSession(dir);
      if (!opened) return;
      const rel = path.slice(dir.length + 1) || path;
      await openFile(rel, { mode: "edit" }, opened.workspace);
      requestReveal(rel, line);
    },
    [openSession, openFile, openExternalPath]
  );

  const openPaths = useCallback(async (paths: string[]): Promise<void> => {
    const clean = paths
      .map((path) => path.trim())
      .filter((path) => path.length > 0 && path.startsWith("/"));
    if (clean.length === 0) return;
    for (const absolutePath of clean) {
      let kind: "file" | "directory" | "missing";
      try {
        kind = (await window.openshell.externalKind(absolutePath)).kind;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
        continue;
      }
      try {
        if (kind === "directory") {
          if (panelsRef.current.length === 0) await openSession(absolutePath);
          else await openWorkspacePanel(absolutePath);
        } else if (kind === "file") {
          if (panelsRef.current.length === 0) await openFileWorkspace(absolutePath);
          else await openExternalPath(absolutePath);
        } else {
          toast(`${absolutePath} is not available`, "error");
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    }
  }, [openSession, openWorkspacePanel, openFileWorkspace, openExternalPath, toast]);

  const commitName = useCallback(
    async (name: string) => {
      const create = pendingCreateRef.current;
      const rename = pendingRenameRef.current;
      if (!create && !rename) return;
      const trimmed = name.trim();
      if (!trimmed) {
        cancelPending();
        return;
      }
      if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
        toast("Invalid name", "error");
        return;
      }
      const target = sessionRef.current?.workspace;
      if (!target) return;
      try {
        if (create) {
          const targetPath = create.parent ? `${create.parent}/${trimmed}` : trimmed;
          await (create.kind === "file"
            ? window.openshell.createFile(target, targetPath)
            : window.openshell.createDir(target, targetPath));
          if (!panelFor(target)) return;
          setTreeFor(target.id, (prev) => {
            const current = prev[create.parent] ?? [];
            if (current.some((e) => e.path === targetPath)) return prev;
            const entry: TreeEntry = { path: targetPath, type: create.kind === "file" ? "file" : "directory" };
            return { ...prev, [create.parent]: sortEntries(filterEntries([...current, entry])) };
          });
          if (create.kind === "file") {
            addCreatedFile(target, targetPath);
          }
          void refreshTree(ancestorDirs(create.parent));
        } else if (rename) {
          const parent = rename.path.includes("/")
            ? rename.path.slice(0, rename.path.lastIndexOf("/"))
            : "";
          const newPath = parent ? `${parent}/${trimmed}` : trimmed;
          cancelPrefix(target, rename.path);
          await window.openshell.renamePath(target, rename.path, trimmed);
          if (!panelFor(target)) return;
          renameTabs(target, rename.path, newPath, trimmed, activePathByWorkspace[target.id] ?? null);
          setAgentFilesFor(target.id, (() => {
            const current = agentFilesByWorkspaceRef.current[target.id] ?? new Map<string, AgentFileState>();
            const next = new Map<string, AgentFileState>();
            for (const [p, state] of current) {
              if (p === rename.path || p.startsWith(`${rename.path}/`)) {
                next.set(`${newPath}${p.slice(rename.path.length)}`, state);
              } else {
                next.set(p, state);
              }
            }
            return next;
          })());
          void refreshTree(ancestorDirs(parent));
        }
        cancelPending();
      } catch (err) {
        if (panelFor(target)) {
          toast(err instanceof Error ? err.message : String(err), "error");
        }
      }
    },
    [toast, refreshTree, cancelPending, cancelPrefix, panelFor, addCreatedFile, renameTabs, setAgentFilesFor, setTreeFor, activePathByWorkspace]
  );

  const moveEntry = useCallback(
    async (path: string, destDir: string, workspace?: WorkspaceIdentity) => {
      const target = workspace ?? sessionRef.current?.workspace;
      if (!target) return;
      const name = path.split("/").pop() ?? path;
      const newPath = destDir ? `${destDir}/${name}` : name;
      cancelPrefix(target, path);
      try {
        await window.openshell.movePath(target, path, destDir);
      } catch (err) {
        if (panelFor(target)) {
          toast(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (!panelFor(target)) return;
      movePathTabs(target, path, newPath, name);
      setAgentFilesFor(target.id, (() => {
        const current = agentFilesByWorkspaceRef.current[target.id] ?? new Map<string, AgentFileState>();
        const next = new Map<string, AgentFileState>();
        for (const [p, state] of current) {
          if (p === path || p.startsWith(`${path}/`)) {
            if (!state.deleted) next.set(`${newPath}${p.slice(path.length)}`, state);
          } else {
            next.set(p, state);
          }
        }
        return next;
      })());
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      void refreshTree([...ancestorDirs(parent), ...ancestorDirs(destDir)], target);
    },
    [toast, refreshTree, cancelPrefix, panelFor, movePathTabs, setAgentFilesFor]
  );

  const moveEntries = useCallback(async (paths: string[], destDir: string): Promise<void> => {
    const workspace = sessionRef.current?.workspace;
    if (!workspace) return;
    const selected = movableExplorerPaths(paths, destDir);
    const moved: Array<{ path: string; newPath: string; name: string }> = [];
    for (const path of selected) {
      const name = path.split("/").pop() ?? path;
      const newPath = destDir ? `${destDir}/${name}` : name;
      cancelPrefix(workspace, path);
      try {
        await window.openshell.movePath(workspace, path, destDir);
        moved.push({ path, newPath, name });
      } catch (err) {
        if (panelFor(workspace)) toast(err instanceof Error ? err.message : String(err), "error");
      }
    }
    if (moved.length === 0 || !panelFor(workspace)) return;
    const remap = movePathsTabs(workspace, moved);
    setAgentFilesFor(workspace.id, (current) => {
      const next = new Map<string, AgentFileState>();
      for (const [path, state] of current) {
        const movedPath = remap(path);
        if (!state.deleted) next.set(movedPath, state);
      }
      return next;
    });
    const parents = moved.map(({ path }) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    void refreshTree([...parents.flatMap((parent) => ancestorDirs(parent)), ...ancestorDirs(destDir)], workspace);
  }, [cancelPrefix, panelFor, toast, movePathsTabs, setAgentFilesFor, refreshTree]);

  const openRecovery = useCallback(async (id: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    try {
      await window.openshell.openRecovery(target, id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [toast]);

  const acknowledgeRecovery = useCallback(async (id: string) => {
    const target = sessionRef.current?.workspace;
    if (!target) return;
    try {
      await window.openshell.acknowledgeRecovery(target, id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [toast]);

  useEffect(() => {
    const processMessage = (msg: BackendMessage): void => {
      if (msg.kind === "session") {
        if (msg.session) {
          addActiveSession(msg.session);
          if (!swapPendingRef.current && !replacingSessionIDsRef.current.has(msg.session.id)) {
            attachPanel(msg.session);
          }
        }
        return;
      }
      if (msg.kind === "ui-command") {
        if (msg.command === "open-source" && typeof msg.path === "string" && typeof msg.line === "number") {
          void openSourceTarget(msg.path, msg.line);
        } else if (msg.command === "open-paths" && Array.isArray(msg.data)) {
          void openPaths(msg.data.filter((entry): entry is string => typeof entry === "string"));
        }
        return;
      }
      if (msg.kind === "recovery") {
        if (msg.recovery && panelFor(msg.recovery.workspace)) {
          setRecoveryFor(msg.recovery.workspace.id, msg.recovery.records);
        }
        return;
      }
      if (msg.kind === "file-update") {
        const f = msg.file!;
        const panel = panelFor(f.workspace);
        if (!panel || f.sessionID !== panel.id) return;
        const origin = prepareFileUpdate(f);
        setAgentFilesFor(f.workspace.id, (current) => {
          const next = new Map(current);
          const clean = f.baseline.kind === "known" && (
            (!f.deleted && f.content === f.baseline.content) ||
            (f.deleted && f.baseline.exists === false)
          );
          if (clean) next.delete(f.path);
          else next.set(f.path, { baseline: f.baseline, content: f.content, deleted: f.deleted });
          return next;
        });
        applyFileUpdate(f, origin);
        const parents = new Set([
          f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "",
          ...(f.movedFrom
            ? [f.movedFrom.includes("/") ? f.movedFrom.slice(0, f.movedFrom.lastIndexOf("/")) : ""]
            : [])
        ]);
        const workspaceExpanded = expandedByWorkspaceRef.current[f.workspace.id] ?? new Set<string>();
        for (const parent of parents) {
          if (parent === f.path || !workspaceExpanded.has(parent)) continue;
          const expected = f.workspace;
          const key = `${expected.id}:${parent}`;
          const existing = treeRefreshTimersRef.current.get(key);
          if (existing) clearTimeout(existing);
          treeRefreshTimersRef.current.set(key, setTimeout(() => {
            treeRefreshTimersRef.current.delete(key);
            void window.openshell
              .listDir(expected, parent)
              .then((entries) =>
                panelFor(expected) &&
                setTreeFor(expected.id, (prev) => ({ ...prev, [parent]: sortEntries(filterEntries(entries)) }))
              )
              .catch(() => {});
          }, 50));
        }
        return;
      }
      if (msg.kind !== "event") return;
      const streamEvent = normalizeStreamEvent(msg);
      if (!streamEvent) return;
      const { data, type } = streamEvent;
      const formRecord = (data as Record<string, any>).form as Record<string, any> | undefined;
      const formSessionID = formRecord && typeof formRecord.sessionID === "string" ? formRecord.sessionID : undefined;
      const altSessionID = typeof (data as Record<string, any>).sessionId === "string"
        ? (data as Record<string, any>).sessionId as string
        : undefined;
      const addressedSessionID = typeof data.sessionID === "string"
        ? data.sessionID as string
        : (altSessionID ?? formSessionID);
      const formEvent = type === "form.created" || type === "form.replied" || type === "form.cancelled";
      // Main attaches `orbitSessionIDs` when a form belongs to a session Orbit
      // does not own directly (a location-global form, a delegated child, or an
      // external `opencode` TUI sharing the directory). Route those to the open
      // panels for the location; keep the form's true sessionID so replies and
      // cancels reach the owning session.
      const locationFormOwnerIDs = formEvent
        ? (streamEvent.ownerSessionIDs ?? []).filter((sessionID) => panelForSession(sessionID))
        : [];
      const locationForm = formEvent && locationFormOwnerIDs.length > 0;
      // The global SSE stream includes external `opencode` terminal
      // sessions and child/subagent streams. Interactive prompts must never
      // be misattributed to the focused panel: only route forms,
      // permissions, and inbox items for sessions Orbit has open, unless a
      // form was explicitly attributed to this location by main.
      if ((formEvent ||
        type === "permission.asked" || type === "permission.replied" ||
        type === "session.inbox.enqueued" || type === "session.inbox.delivered" ||
        type === "session.inbox.cancelled") &&
        (locationForm
          ? false
          : (!addressedSessionID || !panelForSession(addressedSessionID)))) {
        return;
      }
      const targetSessionID = locationForm
        ? (locationFormOwnerIDs.includes(sessionRef.current?.id ?? "") ? sessionRef.current!.id : locationFormOwnerIDs[0])
        : (addressedSessionID ?? sessionRef.current?.id);
      const targetWorkspace = targetSessionID ? workspaceOfSession(targetSessionID) : null;
      const active = Boolean(targetSessionID && targetSessionID === sessionRef.current?.id);
      if (type === "session.inbox.delivered" && targetSessionID && typeof data.inboxID === "string") {
        promoteDeliveredInput(targetSessionID, data.inboxID);
      }

      if (type === "session.inbox.enqueued" && targetSessionID && typeof data.inboxID === "string") {
        const item = data.item as Record<string, any> | undefined;
        if (item?.type === "user") {
          const payload = item.payload as Record<string, any> | undefined;
          const files = Array.isArray(payload?.files) ? payload.files : [];
          const delivery = data.delivery === "queue"
            ? "queue"
            : data.delivery === "steer"
              ? "steer"
              : typeof item.delivery === "string" && (item.delivery === "queue" || item.delivery === "steer")
                ? item.delivery
                : undefined;
          setInboxBySession((current) => ({
            ...current,
            [targetSessionID]: [
              ...(current[targetSessionID] ?? []).filter((entry) => entry.id !== data.inboxID),
              {
                id: data.inboxID,
                text: String(payload?.text ?? ""),
                attachmentCount: files.length,
                createdAt: Date.now(),
                ...(delivery ? { delivery } : {})
              }
            ]
          }));
        }
      }
      if (
        (type === "session.inbox.cancelled" || type === "session.inbox.delivered") &&
        targetSessionID &&
        typeof data.inboxID === "string"
      ) {
        setInboxBySession((current) => {
          const list = current[targetSessionID];
          if (!list?.some((entry) => entry.id === data.inboxID)) return current;
          return { ...current, [targetSessionID]: list.filter((entry) => entry.id !== data.inboxID) };
        });
      }

      switch (type) {
        case "form.created": {
          const rawForm = (data.form as Record<string, any> | undefined) ?? {};
          const trueSessionID = typeof rawForm.sessionID === "string" ? rawForm.sessionID : targetSessionID;
          const normalized = normalizePendingForm({ ...rawForm, sessionID: trueSessionID });
          const ownerIDs = locationForm ? locationFormOwnerIDs : targetSessionID ? [targetSessionID] : [];
          if (normalized && ownerIDs.length > 0 &&
              (locationForm || normalized.sessionID === "global" || normalized.sessionID === targetSessionID)) {
            setFormsBySession((current) => {
              const next = { ...current };
              for (const ownerID of ownerIDs) {
                next[ownerID] = [
                  ...(current[ownerID] ?? []).filter((form) => form.id !== normalized.id),
                  normalized
                ];
              }
              return next;
            });
          }
          break;
        }
        case "form.replied":
        case "form.cancelled": {
          const formID = typeof data.id === "string" ? data.id : "";
          const ownerIDs = locationForm ? locationFormOwnerIDs : targetSessionID ? [targetSessionID] : [];
          if (ownerIDs.length > 0 && formID) {
            setFormsBySession((current) => {
              let changed = false;
              const next = { ...current };
              for (const ownerID of ownerIDs) {
                const list = current[ownerID];
                if (!list?.some((form) => form.id === formID)) continue;
                changed = true;
                next[ownerID] = list.filter((form) => form.id !== formID);
              }
              return changed ? next : current;
            });
          }
          break;
        }
      }

      if (targetSessionID && AUX_CHAT_STREAM_TYPES.has(type)) {
        reduceAuxiliaryEvent(targetSessionID, streamEvent);
        if (type === "session.compaction.ended") {
          const currentInput = usageBySessionRef.current[targetSessionID]?.tokens.input ?? 0;
          if (currentInput > 0) {
            setCompactionBaselineBySession((prev) => ({ ...prev, [targetSessionID]: currentInput }));
          }
          void refreshSessionUsage(targetSessionID);
          // Backstop: the usage snapshot may lag the compaction commit on
          // slow/local backends. Re-poll once so the context display cannot
          // stay pinned to its pre-compaction value. refreshSessionUsage
          // no-ops when the panel is gone.
          setTimeout(() => void refreshSessionUsage(targetSessionID), 8_000);
        } else if (type === "session.compaction.failed") {
          void refreshSessionUsage(targetSessionID);
        }
      }

      switch (type) {
        case "session.step.started":
        case "session.step.ended":
        case "session.step.failed":
        case "session.text.started":
        case "session.text.delta":
        case "session.text.ended":
        case "session.reasoning.started":
        case "session.reasoning.delta":
        case "session.reasoning.ended":
        case "session.tool.input.started":
        case "session.tool.input.delta":
        case "session.tool.input.ended":
        case "session.tool.called":
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed":
        case "session.retry.scheduled":
        case "message.updated":
        case "message.removed":
        case "message.part.updated":
        case "message.part.delta":
        case "message.part.removed": {
          if (!targetSessionID) break;
          if (sessionAbortFlagsRef.current[targetSessionID]?.acknowledged === false && streamEventShowsActiveWork(streamEvent)) {
            break;
          }
          const previous = snapshotSession(targetSessionID);
          const result = reduceSessionEvent(targetSessionID, streamEvent);
          if (result === true || (typeof result !== "boolean" && result.changed)) {
            lastStreamActivityRef.current[targetSessionID] = Date.now();
            applyProjection(targetSessionID);
            const abortFlag = sessionAbortFlagsRef.current[targetSessionID];
            const abortPending = Boolean(abortFlag && !abortFlag.acknowledged);
            const sessionStatus = recordStatusFor(targetSessionID);
            if (sessionStatus?.type === "idle" || sessionStatus?.type === "error") {
              setSessionBusy(targetSessionID, false);
            } else if (!abortPending && !busyBySessionRef.current[targetSessionID] && streamEventShowsActiveWork(streamEvent)) {
              setSessionBusy(targetSessionID, true);
            }
          }
          const materialization = typeof result === "boolean" ? undefined : result.materialization;
          if (materialization) void materializeSession(materialization.sessionID ?? targetSessionID);
          const failure = failureForStreamEvent(type, data);
          if (failure && targetSessionID && result === false) {
            const failureText = formatFailure(failure.error, failure.code, failure.message);
            appendUniqueTranscriptItem(targetSessionID, { kind: "status", id: `${streamEvent.id}-failure`, text: failureText, tone: "error" });
          }
          syncStreaming(targetSessionID, previous);
          if (type === "message.part.delta" || type === "session.text.delta" || type === "session.reasoning.delta" || type === "session.tool.input.delta") {
            const touched = touchStreamingSession(streamingRef.current, targetSessionID);
            if (touched) commitStreaming(touched);
          }
          break;
        }
        case "server.connected":
        case "global.disposed": {
          void loadSessions();
          for (const panel of panelsRef.current) {
            void materializeSession(panel.id);
            void refreshForms(panel.id);
          }
          void reconcilePermissions();
          break;
        }
        case "global.error": {
          toast(formatFailure(data.error, "ORBIT_GLOBAL_FAILURE", "Background operation failed"), "error");
          break;
        }
        case "session.created": {
          const location = data.location as { directory?: string } | undefined;
          const directory = location?.directory ?? streamEvent.data.location?.directory;
          if (!targetSessionID || typeof directory !== "string") break;
          const summary: SessionSummary = {
            id: targetSessionID,
            title: typeof data.title === "string" && data.title.trim()
              ? data.title
              : directory.split(/[\\/]/).pop() ?? directory,
            directory,
            updatedAt: streamEvent.created,
            ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
            ...(typeof data.agent === "string" ? { agent: data.agent } : {})
          };
          upsertSummary(summary);
          break;
        }
        case "session.renamed": {
          if (!targetSessionID || typeof data.title !== "string") break;
          renameSummary(targetSessionID, data.title, streamEvent.created);
          break;
        }
        case "session.deleted": {
          if (targetSessionID) removeSummary(targetSessionID);
          break;
        }
        case "session.usage.updated":
        case "session.usage.recorded": {
          const usage = normalizeSessionUsage(data);
          if (!targetSessionID || !usage) break;
          setUsageBySession((current) => retainSessionRecord(
            current,
            targetSessionID,
            usage,
            protectedSessionIDs()
          ));
          break;
        }
        case "session.execution.started": {
          if (targetSessionID && sessionAbortFlagsRef.current[targetSessionID]?.acknowledged !== false) {
            const previous = snapshotSession(targetSessionID);
            reduceSessionEvent(targetSessionID, streamEvent);
            syncStreaming(targetSessionID, previous);
            // Authoritative proof the turn is alive: reset the settle quiet
            // clock so slow models (long prefill/tool gaps with no deltas)
            // cannot trip the watchdog mid-turn.
            lastStreamActivityRef.current[targetSessionID] = Date.now();
            setSessionBusy(targetSessionID, true);
          }
          break;
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          if (targetSessionID) {
            setSessionBusy(targetSessionID, false);
            const previous = snapshotSession(targetSessionID);
            const result = reduceSessionEvent(targetSessionID, streamEvent);
            if (result === true || (typeof result !== "boolean" && result.changed)) applyProjection(targetSessionID);
            syncStreaming(targetSessionID, previous);
            setSessionAbortFlags((current) => current[targetSessionID]
              ? { ...current, [targetSessionID]: { ...current[targetSessionID], acknowledged: true } }
              : current);
          }
          if (active && targetWorkspace) setTodosFor(targetWorkspace.id, []);
          const ok = type === "session.execution.succeeded";
          if (!ok && targetSessionID) {
            const errorText = type === "session.execution.failed"
              ? formatFailure(data.error, "ORBIT_EXECUTION_FAILED", "Execution failed")
              : data.error
                ? formatFailure(data.error, "ORBIT_EXECUTION_INTERRUPTED", "Execution interrupted")
                : "Interrupted";
            replaceTranscriptItemAtTail(targetSessionID, {
                kind: "status",
                id: `${streamEvent.id}-end`,
                text: errorText,
                tone: type === "session.execution.interrupted" ? "info" : "error"
            });
          }
          break;
        }
        case "session.idle": {
          if (targetSessionID) {
            setSessionBusy(targetSessionID, false);
            const previous = snapshotSession(targetSessionID);
            const result = reduceSessionEvent(targetSessionID, streamEvent);
            if (result === true || (typeof result !== "boolean" && result.changed)) applyProjection(targetSessionID);
            syncStreaming(targetSessionID, previous);
            setSessionAbortFlags((current) => current[targetSessionID]
              ? { ...current, [targetSessionID]: { ...current[targetSessionID], acknowledged: true } }
              : current);
          }
          if (active && targetWorkspace) setTodosFor(targetWorkspace.id, []);
          break;
        }
        case "session.error": {
          if (targetSessionID) {
            setSessionBusy(targetSessionID, false);
            const previous = snapshotSession(targetSessionID);
            const result = reduceSessionEvent(targetSessionID, streamEvent);
            if (result === true || (typeof result !== "boolean" && result.changed)) applyProjection(targetSessionID);
            syncStreaming(targetSessionID, previous);
            setSessionAbortFlags((current) => current[targetSessionID]
              ? { ...current, [targetSessionID]: { ...current[targetSessionID], acknowledged: true } }
              : current);
            const errorText = formatFailure(data.error, "ORBIT_SESSION_ERROR", "Session failed");
            appendUniqueTranscriptItem(targetSessionID, { kind: "status", id: `${streamEvent.id}-error`, text: errorText, tone: "error" });
          }
          break;
        }
        case "todo.updated": {
          if (targetWorkspace) setTodosFor(targetWorkspace.id, normalizeTodos(data.todos));
          break;
        }
        case "session.model.selected": {
          if (!targetWorkspace) break;
          applyModelSelection(targetWorkspace, data.model as { id?: string; providerID?: string; variant?: string } | undefined);
          break;
        }
        case "session.agent.selected": {
          if (!targetWorkspace) break;
          applyAgentSelection(targetWorkspace, data.agent as string | undefined);
          break;
        }
        case "agent.updated": {
          if (targetWorkspace) void loadAgents(targetWorkspace);
          else void loadAgents();
          break;
        }
        case "catalog.updated":
        case "models-dev.refreshed": {
          if (targetWorkspace) void loadModels(targetWorkspace);
          else void loadModels();
          break;
        }
        case "session.status": {
          const status = data.status as { type?: string; attempt?: number; message?: string; next?: number; action?: RateLimitAction } | undefined;
          const abortPending = Boolean(targetSessionID && sessionAbortFlagsRef.current[targetSessionID]?.acknowledged === false);
          const activeStatus = status?.type === "busy" || status?.type === "retry";
          if (targetSessionID && !(abortPending && activeStatus)) {
            const previous = snapshotSession(targetSessionID);
            reduceSessionEvent(targetSessionID, streamEvent);
            syncStreaming(targetSessionID, previous);
          }
          if (activeStatus && targetSessionID && !abortPending) {
            lastStreamActivityRef.current[targetSessionID] = Date.now();
          }
          if (status?.type === "busy" && targetSessionID && !abortPending) setSessionBusy(targetSessionID, true);
          if ((status?.type === "idle" || status?.type === "error") && targetSessionID) setSessionBusy(targetSessionID, false);
          if (status?.type === "retry" && targetSessionID && !abortPending) {
            setSessionBusy(targetSessionID, true);
            if (attachRetry(targetSessionID, {
              attempt: Number(status.attempt ?? 1),
              message: formatFailure(status.message, "ORBIT_RETRY_SCHEDULED", "Retrying"),
              next: status.next
            })) {
              applyProjection(targetSessionID);
            }
            if (status.action && Number(status.attempt ?? 1) === 1) {
              const notice = buildRateLimitNotice(status.action, targetSessionID);
              if (notice) {
                appendRateLimitNotice(targetSessionID, notice);
              }
            }
          }
          if (targetSessionID && !(abortPending && activeStatus)) {
            const previous = snapshotSession(targetSessionID);
            const result = reduceSessionEvent(targetSessionID, streamEvent);
            if (result === true || (typeof result !== "boolean" && result.changed)) applyProjection(targetSessionID);
            syncStreaming(targetSessionID, previous);
          }
          break;
        }
        case "permission.asked": {
          const requestID = String(data.id);
          const automatic = approvalModeRef.current === "approve";
          if (!targetSessionID) break;
          addPermissionFromEvent(targetSessionID, requestID, data);
          const panel = targetSessionID ? panelForSession(targetSessionID) : null;
          if (automatic && panel) {
            void window.openshell.permissionReply(panel.workspace, requestID, "once", panel.id);
          }
          break;
        }
        case "permission.replied": {
          const requestID = String(data.requestID ?? data.id);
          const reply = (data.reply as PermissionReply | undefined) ?? "reject";
          if (!targetSessionID) break;
          resolvePermission(targetSessionID, requestID, reply);
          break;
        }
      }
    };

    const off = window.openshell.onMessage((msg: BackendMessage) => {
      processMessage(msg);
    });

    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const tryConnect = async (): Promise<void> => {
      if (cancelled) return;
      const ok = await window.openshell.health().catch(() => false);
      if (cancelled) return;
      if (ok) {
        setConnected(true);
        return;
      }
      healthTimer = setTimeout(() => void tryConnect(), 2000);
    };
    void tryConnect();
    const permissionTimer = setInterval(() => void reconcilePermissions(), 3000);
    const formTimer = setInterval(() => {
      for (const panel of panelsRef.current) void refreshForms(panel.id);
    }, 3000);
    void window.openshell.takePendingPaths().then((paths) => {
      if (paths.length > 0) void openPaths(paths);
    }).catch(() => {});
    if (!startupRestoreStartedRef.current) {
      startupRestoreStartedRef.current = true;
      void (async () => {
        await window.openshell.health().catch(() => false);
        if (cancelled) return;
        try {
          window.localStorage.removeItem(STALE_SESSION_LAYOUT_KEY);
        } catch {}
        // Fresh launches start on the Welcome screen: only live backend
        // contexts (e.g. after a renderer reload) are re-attached. Sessions
        // from a previous process stay reachable via recents and Open now.
        const liveSessions = await refreshActiveSessions();
        const restored: SessionInfo[] = [];
        for (const live of liveSessions) {
          if (cancelled) return;
          const session = await reopenSession(live.id, true);
          if (session) restored.push(session);
        }
        if (cancelled) return;
        if (!userActivatedRef.current && restored.length > 0) {
          focusSession(restored[restored.length - 1]!.id, false);
        }
      })();
    }
    return () => {
      cancelled = true;
      clearInterval(permissionTimer);
      clearInterval(formTimer);
      if (healthTimer !== null) clearTimeout(healthTimer);
      off();
      cancelAll();
    };
  }, [
    attachPanel,
    addActiveSession,
    focusSession,
    openSourceTarget,
    loadModels,
    loadAgents,
    applyModelSelection,
    applyAgentSelection,
    loadRecovery,
    reopenSession,
    setSessionBusy,
    appendUniqueTranscriptItem,
    appendRateLimitNotice,
    replaceTranscriptItemAtTail,
    reduceAuxiliaryEvent,
    resolvePermission,
    addPermissionFromEvent,
    promoteDeliveredInput,
    panelFor,
    panelForSession,
    workspaceOfSession,
    protectedSessionIDs,
    setTodosFor,
    setRecoveryFor,
    setAgentFilesFor,
    prepareFileUpdate,
    applyFileUpdate,
    setTreeFor,
    snapshotSession,
    reduceSessionEvent,
    attachRetry,
    applyProjection,
    materializeSession,
    refreshSessionUsage,
    reconcilePermissions,
    refreshForms,
    cancelAll,
    refreshActiveSessions,
    loadSessions,
    upsertSummary,
    renameSummary,
    removeSummary,
    openPaths,
    recordStatusFor,
  ]);

  useEffect(() => {
    if (!connected || !sessionRef.current) return;
    void loadModels();
    void loadAgents();
  }, [connected, loadModels, loadAgents]);


  const panelViews = useMemo<Record<string, PanelView>>(() => projectPanelViews(panels, {
    busyBySession,
    transcriptsBySession,
    todosByWorkspace,
    usageBySession,
    compactionBaselineBySession,
    modelsByWorkspace,
    currentModelByWorkspace,
    agentsByWorkspace,
    currentAgentByWorkspace,
    streamingStore,
    messageQueue,
    inboxBySession,
    formsBySession,
    stagedReverts,
    sessionAbortFlags,
    chatStates: rawChatReadMap
  }), [
    panels,
    busyBySession,
    transcriptsBySession,
    todosByWorkspace,
    usageBySession,
    compactionBaselineBySession,
    modelsByWorkspace,
    currentModelByWorkspace,
    agentsByWorkspace,
    currentAgentByWorkspace,
    streamingStore,
    messageQueue,
    formsBySession,
    stagedReverts,
    sessionAbortFlags
  ]);

  const value = useMemo<Store>(
    () => ({
      session,
      connected,
      runtimes,
      refreshRuntimes,
      busy,
      todos,
      transcript,
      sessionUsage,
      providerUsage,
      providerUsageLoading,
      tabs,
      unsavedEditorFileCount,
      unsavedEditorFiles,
      activePath,
      singleFile,
      agentFiles,
      tree,
      expanded,
      hiddenPaths,
      toasts,
      recoveryRecords,
      models,
      availableModels,
      lastModel,
      currentModel,
      agents,
      currentAgent,
      approvalMode,
      followUpBehavior: messageQueue.followUpBehavior,
      setFollowUpBehavior,
      sessions,
      savedWorkspaces,
      saveWorkspace,
      removeWorkspace,
      activeSessions,
      panels,
      workspaceOnlyPanelIDs,
      panelViews,
      activeSessionID,
      focusSession,
      closePanel,
      openSession,
      addModelPanel,
      openWorkspacePanel,
      selectAddPanel,
      selectFolder,
      selectFile,
      openFileWorkspace,
      openExternalPath,
      importPaths,
      dropIntoExplorer,
      openPaths,
      dismissChange,
      dismissChanges,
      selectPanelDirectory,
      changePanelDirectory,
      reopenSession,
      deleteSession,
      loadSessions,
      sendPrompt,
      runCommand,
      stop,
      refreshProviderUsage,
      loadModels,
      switchModel,
      loadAgents,
      switchAgent,
      toggleApprovalMode,
      openFile,
      closeTab,
      setActive,
      setTabMode,
      editContent,
      saveTab,
      saveAllEditorFiles,
      reloadTab,
      overwriteTab,
      mergeTab,
      toggleDir,
      ensureRootOpen,
      revealInFileManager,
      replyPermission,
      removeQueuedMessage,
      popQueuedMessage,
      sendQueuedNow,
      reorderQueuedMessage,
      submitForm,
      dismissForm,
      stageRevert,
      commitStagedRevert,
      clearStagedRevert,
      pendingCreate,
      pendingRename,
      startCreate,
      startRename,
      cancelPending,
      commitName,
      deleteEntry,
      deleteEntries,
      removeFromWorkspace,
      moveEntry,
      moveEntries,
      openRecovery,
      acknowledgeRecovery
    }),
    [
      session, connected, runtimes, refreshRuntimes, busy, todos, transcript, sessionUsage, providerUsage, providerUsageLoading, tabs, unsavedEditorFileCount, unsavedEditorFiles, activePath, singleFile, agentFiles, tree, expanded, hiddenPaths, toasts, recoveryRecords,
      models, availableModels, lastModel, currentModel, agents, currentAgent, approvalMode, messageQueue.followUpBehavior, setFollowUpBehavior, sessions, savedWorkspaces, saveWorkspace, removeWorkspace, activeSessions, panels, workspaceOnlyPanelIDs, panelViews, activeSessionID,
      focusSession, closePanel, openSession, addModelPanel, openWorkspacePanel, selectAddPanel, selectFolder, selectFile, openFileWorkspace, openExternalPath, importPaths, dropIntoExplorer, selectPanelDirectory, changePanelDirectory, reopenSession, loadSessions, sendPrompt, runCommand, stop, refreshProviderUsage, loadModels, switchModel,
      loadAgents, switchAgent, toggleApprovalMode,
      openFile, closeTab, setActive, setTabMode, revealInFileManager,
      editContent, saveTab, saveAllEditorFiles, reloadTab, overwriteTab, mergeTab, toggleDir, ensureRootOpen, replyPermission,
      startCreate, startRename, cancelPending, commitName, deleteEntry, deleteEntries, removeFromWorkspace, moveEntry, moveEntries, openRecovery, acknowledgeRecovery,
      removeQueuedMessage, popQueuedMessage, sendQueuedNow, reorderQueuedMessage,
      submitForm, dismissForm,
      stageRevert, commitStagedRevert, clearStagedRevert,
      pendingCreate, pendingRename
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
});

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

const EMPTY_VIEW: PanelView = {
  session: null,
  busy: false,
  transcript: [],
  todos: [],
  sessionUsage: null,
  compactionBaseline: null,
  models: [],
  currentModel: null,
  agents: [],
  currentAgent: null,
  activity: IDLE_ACTIVITY,
  assistantStatus: null,
  forming: null,
  activeModel: null,
  streaming: null,
  turnStartedAt: null,
  queuedCount: 0,
  queuedMessages: [],
  pendingForms: [],
  stagedRevert: null
};

export function usePanel(workspace: WorkspaceIdentity | null | undefined): PanelView {
  const store = useContext(Ctx);
  if (!store) throw new Error("usePanel must be used within StoreProvider");
  if (!workspace) return EMPTY_VIEW;
  return store.panelViews[workspace.id] ?? EMPTY_VIEW;
}
