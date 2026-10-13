import type {
  AgentOption,
  ModelOption,
  PendingFormRequest,
  SessionInboxEntry,
  SessionInfo,
  SessionRevertStage,
  SessionUsage,
  TodoItem,
  TranscriptItem
} from "@shared/types";
import { findTurnStartedAt, type ChatDirectoryReadView } from "./chat-store";
import { resolveSessionActivity } from "./session-activity";
import { getActiveAssistantContext, resolveAssistantStatus, type SessionAbortFlag } from "./assistant-status";
import { createMessageQueueTarget, getQueueForTarget, type MessageQueueState, type QueuedMessage } from "./message-queue";
import type { StreamingReadView } from "./streaming";
import type { PanelView } from "./store-contract";

export interface PanelProjectionSources {
  busyBySession: Readonly<Record<string, boolean>>;
  transcriptsBySession: Readonly<Record<string, TranscriptItem[]>>;
  todosByWorkspace: Readonly<Record<string, TodoItem[]>>;
  usageBySession: Readonly<Record<string, SessionUsage>>;
  compactionBaselineBySession: Readonly<Record<string, number>>;
  modelsByWorkspace: Readonly<Record<string, ModelOption[]>>;
  currentModelByWorkspace: Readonly<Record<string, ModelOption | null>>;
  agentsByWorkspace: Readonly<Record<string, AgentOption[]>>;
  currentAgentByWorkspace: Readonly<Record<string, AgentOption | null>>;
  streamingStore: StreamingReadView;
  messageQueue: MessageQueueState;
  inboxBySession: Readonly<Record<string, SessionInboxEntry[]>>;
  formsBySession: Readonly<Record<string, PendingFormRequest[]>>;
  stagedReverts: Readonly<Record<string, SessionRevertStage | null>>;
  sessionAbortFlags: Readonly<Record<string, SessionAbortFlag>>;
  chatStates: ReadonlyMap<string, ChatDirectoryReadView>;
}

export function projectPanelViews(panels: readonly SessionInfo[], sources: PanelProjectionSources): Record<string, PanelView> {
  const {
    busyBySession, transcriptsBySession, todosByWorkspace, usageBySession,
    compactionBaselineBySession, modelsByWorkspace, currentModelByWorkspace,
    agentsByWorkspace, currentAgentByWorkspace, streamingStore, messageQueue,
    inboxBySession, formsBySession, stagedReverts, sessionAbortFlags
  } = sources;

  const views: Record<string, PanelView> = {};
  for (const panel of panels) {
    const transcript = transcriptsBySession[panel.id] ?? [];
    const trailingAssistant = [...transcript].reverse().find((item) => item.kind === "assistant");
    const trailingAssistantIncomplete = trailingAssistant?.kind === "assistant" && !trailingAssistant.completed;
    const pendingPermissions = transcript.filter((item) => item.kind === "permission" && item.pending).length;
    const activity = resolveSessionActivity({
      sessionId: panel.id,
      statusType: panel.id in busyBySession
        ? (busyBySession[panel.id]
            ? (trailingAssistant?.kind === "assistant" && trailingAssistant.retry ? "retry" : "busy")
            : "idle")
        : undefined,
      trailingAssistantIncomplete,
      pendingPermissions
    });
    const streamingID = trailingAssistantIncomplete ? streamingStore.streamingMessageIds.get(panel.id) : null;
    const streaming = streamingID ? streamingStore.messageStreamStates.get(streamingID) ?? null : null;
    const chatState = sources.chatStates.get(panel.id);
    const rawMessages = chatState?.message[panel.id] ?? [];
    const rawParts = trailingAssistant?.kind === "assistant"
      ? chatState?.part[trailingAssistant.id] ?? []
      : [];
    const turnStartedAt = activity.isWorking
      ? findTurnStartedAt(
          rawMessages,
          trailingAssistant?.kind === "assistant" ? trailingAssistant.messageID : undefined
        )
      : null;
    const activeContext = getActiveAssistantContext(rawMessages);
    const statusSnapshot = resolveAssistantStatus({
      assistantId: activeContext.assistantId,
      model: activeContext.model,
      activity,
      parts: rawParts,
      pendingPermissions,
      abortFlag: sessionAbortFlags[panel.id] ?? null,
      retryInfo: trailingAssistant?.kind === "assistant" && trailingAssistant.retry
        ? { attempt: trailingAssistant.retry.attempt, next: trailingAssistant.retry.next }
        : null
    });
    const queueTarget = createMessageQueueTarget(panel.id, panel.workspace.id);
    const localQueue = queueTarget ? getQueueForTarget(messageQueue, queueTarget) : [];
    const queuedMessages: QueuedMessage[] = [
      ...(inboxBySession[panel.id] ?? []).map((entry) => ({
        id: entry.id,
        content: entry.text,
        createdAt: entry.createdAt,
        attachmentCount: entry.attachmentCount
      })),
      ...localQueue
    ];
    const pendingForms = formsBySession[panel.id] ?? [];
    const compactionBaseline = compactionBaselineBySession[panel.id] ?? null;
    views[panel.workspace.id] = {
      session: panel,
      busy: activity.isWorking,
      transcript,
      todos: todosByWorkspace[panel.workspace.id] ?? [],
      sessionUsage: usageBySession[panel.id] ?? null,
      compactionBaseline,
      models: modelsByWorkspace[panel.workspace.id] ?? [],
      currentModel: currentModelByWorkspace[panel.workspace.id] ?? null,
      agents: agentsByWorkspace[panel.workspace.id] ?? [],
      currentAgent: currentAgentByWorkspace[panel.workspace.id] ?? null,
      activity,
      assistantStatus: statusSnapshot?.working ?? null,
      forming: statusSnapshot?.forming ?? null,
      activeModel: statusSnapshot?.activeModel ?? null,
      streaming,
      turnStartedAt,
      queuedCount: queuedMessages.length,
      queuedMessages,
      pendingForms,
      stagedRevert: stagedReverts[panel.id] ?? null
    };
  }
  return views;
}
