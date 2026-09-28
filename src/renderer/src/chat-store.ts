import type { AssistantPartView, TranscriptItem } from "@shared/types";
import { formatFailure, normalizeFailure } from "@shared/errors";
import { partFromProjection, type ChatStreamEvent } from "./chat-stream";
import { Binary } from "./binary";

export const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"]);
const DELTA_OVERLAP_FIELDS = ["text", "output", "input"] as const;
const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"]);
const TERMINAL_TURN_FINISHES = new Set(["stop", "length", "content-filter", "error", "unknown"]);

export interface ChatMessageRecord {
  id: string;
  sessionID: string;
  role: string;
  time: { created?: number; completed?: number; end?: number };
  finish?: unknown;
  error?: unknown;
  retry?: { attempt: number; message: string; next?: number };
  [key: string]: unknown;
}

export function findTurnStartedAt(
  messages: ChatMessageRecord[] | undefined,
  fallbackMessageID?: string
): number | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index];
    if (record.role === "user") {
      return typeof record.time.created === "number" ? record.time.created : null;
    }
  }
  const fallback = fallbackMessageID ? messages.find((record) => record.id === fallbackMessageID) : undefined;
  return typeof fallback?.time.created === "number" ? fallback.time.created : null;
}

export interface ChatPartRecord {
  id: string;
  messageID: string;
  sessionID?: string;
  type: string;
  seq?: number;
  text?: string;
  state?: Record<string, unknown>;
  time?: { created?: number; completed?: number; end?: number };
  [key: string]: unknown;
}

export type ChatSessionStatus =
  | { type: "busy" }
  | { type: "idle" }
  | { type: "error" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface ChatDirectoryState {
  message: Record<string, ChatMessageRecord[]>;
  part: Record<string, ChatPartRecord[]>;
  session_status: Record<string, ChatSessionStatus>;
}

export type ChatMaterializationReason = "missing-owning-message" | "orphan-delta" | "missing-delta-part";

export type ChatEventResult =
  | boolean
  | {
      changed: boolean;
      materialization: {
        type: "incomplete-session-snapshot";
        reason: ChatMaterializationReason;
        sessionID?: string;
        messageID: string;
        partID?: string;
      };
    };

export interface ChatStateSnapshot {
  message: Record<string, ChatMessageRecord[]>;
  session_status: Record<string, ChatSessionStatus>;
}

function eventMessageID(data: Record<string, any>): string {
  return String(data.assistantMessageID ?? data.messageID ?? "");
}

function eventToolID(data: Record<string, any>): string {
  return String(data.callID ?? data.id ?? "");
}

function textPartID(messageID: string, type: "text" | "reasoning", ordinal: unknown): string {
  return `${messageID}:${type}:${Number(ordinal ?? 0)}`;
}

function sameTypeCount(draft: ChatDirectoryState, messageID: string, type: string): number {
  return (draft.part[messageID] ?? []).filter((part) => part.type === type).length;
}

function resolvedOrdinal(
  draft: ChatDirectoryState,
  messageID: string,
  type: "text" | "reasoning",
  ordinal: unknown
): number {
  if (ordinal !== undefined) return Number(ordinal);
  return Math.max(0, sameTypeCount(draft, messageID, type) - 1);
}

function eventOrdinal(data: Record<string, any>): number {
  return Number(data.ordinal ?? 0);
}

function toolPartID(messageID: string, callID: string): string {
  return `${messageID}:tool:${callID}`;
}

function errorText(error: unknown, fallbackCode = "ORBIT_RUNTIME_FAILURE", fallbackMessage = "Operation failed"): string {
  return formatFailure(error, fallbackCode, fallbackMessage);
}

export interface RateLimitAction {
  reason?: string;
  message?: string;
  link?: string;
}

export function buildRateLimitNotice(action: RateLimitAction | null | undefined, sessionID: string): TranscriptItem | null {
  if (!action) return null;
  const reason = action.reason;
  if (reason !== "free_tier_limit" && reason !== "account_rate_limit") return null;
  const base = String(
    action.message ??
      (reason === "free_tier_limit"
        ? "OpenCode Go free usage limit reached."
        : "OpenCode Go usage limit reached.")
  );
  const link = typeof action.link === "string" && action.link ? action.link : "";
  const text = link && !base.includes(link) ? `${base} → ${link}` : base;
  return { kind: "status", id: `${sessionID}-ratelimit-${reason}`, text, tone: "error" };
}

function partFieldValue(part: ChatPartRecord, field: string): string | undefined {
  if (field === "text") return typeof part.text === "string" ? part.text : undefined;
  const value = part.state?.[field];
  return typeof value === "string" ? value : undefined;
}

function setPartFieldValue(part: ChatPartRecord, field: string, value: string): ChatPartRecord {
  if (field === "text") return { ...part, text: value };
  return { ...part, state: { ...part.state, [field]: value } };
}

function getUpdatedDeltaFields(previous: ChatPartRecord, next: ChatPartRecord): string[] {
  const dedupeFields: string[] = [];
  for (const field of DELTA_OVERLAP_FIELDS) {
    const previousValue = partFieldValue(previous, field);
    const nextValue = partFieldValue(next, field);
    if (!previousValue || !nextValue) continue;
    if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
      dedupeFields.push(field);
    }
  }
  return dedupeFields;
}

function getPartEndTime(part: ChatPartRecord): number | undefined {
  const stateEnd = part.state?.time as { end?: unknown } | undefined;
  if (typeof stateEnd?.end === "number") return stateEnd.end;
  const timeCompleted = part.time?.completed;
  return typeof timeCompleted === "number" ? timeCompleted : undefined;
}

function getToolStatus(part: ChatPartRecord): string | undefined {
  if (part.type !== "tool") return undefined;
  const status = part.state?.status;
  return typeof status === "string" ? status : undefined;
}

function shouldPreserveExistingPart(previous: ChatPartRecord, next: ChatPartRecord): boolean {
  if (previous.type !== "tool" || next.type !== "tool") return false;

  const previousStatus = getToolStatus(previous);
  const nextStatus = getToolStatus(next);
  if (previousStatus && FINAL_TOOL_STATUSES.has(previousStatus) && (!nextStatus || !FINAL_TOOL_STATUSES.has(nextStatus))) {
    return true;
  }
  if (previousStatus && FINAL_TOOL_STATUSES.has(previousStatus) && nextStatus && FINAL_TOOL_STATUSES.has(nextStatus) && previousStatus !== nextStatus) {
    return true;
  }

  const previousEnd = getPartEndTime(previous);
  const nextEnd = getPartEndTime(next);
  if (typeof previousEnd === "number" && typeof nextEnd !== "number") return true;

  return false;
}

function areSessionStatusesEqual(left: ChatSessionStatus | undefined, right: ChatSessionStatus): boolean {
  if (left === right) return true;
  if (!left || left.type !== right.type) return false;
  if (left.type === "retry" && right.type === "retry") {
    return left.attempt === right.attempt && left.message === right.message && left.next === right.next;
  }
  return true;
}

function setChatSessionStatus(draft: ChatDirectoryState, sessionID: string, status: ChatSessionStatus): boolean {
  if (areSessionStatusesEqual(draft.session_status[sessionID], status)) return false;
  draft.session_status = { ...draft.session_status, [sessionID]: status };
  return true;
}

function failLatestIncomplete(
  draft: ChatDirectoryState,
  sessionID: string,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string
): boolean {
  const messages = draft.message[sessionID];
  if (!messages) return false;
  const failure = normalizeFailure(error, fallbackCode, fallbackMessage);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const incomplete = !message.time?.completed && !message.finish;
    if (!incomplete && !message.retry) continue;
    const next = [...messages];
    next[index] = {
      ...message,
      ...(incomplete ? { time: { ...message.time, completed: Date.now() }, error: failure } : {}),
      retry: undefined
    };
    draft.message[sessionID] = next;
    return true;
  }
  return false;
}

function areJsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return left === right;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function areMessageUpdateFieldsEqual(existing: ChatMessageRecord, next: ChatMessageRecord): boolean {
  if (existing.role !== next.role) return false;
  if (existing.finish !== next.finish) return false;
  if (existing.time?.completed !== next.time?.completed) return false;

  const fields = ["summary", "error", "cost", "tokens", "structured", "model", "tools", "format", "variant", "agent", "system"];
  for (const field of fields) {
    if (!areJsonEquivalent(existing[field], next[field])) return false;
  }

  return true;
}

function hasMessage(draft: ChatDirectoryState, sessionID: string, messageID: string): boolean {
  const messages = draft.message[sessionID];
  if (!messages) return false;
  return Binary.search(messages, messageID, (message) => message.id).found;
}

function retryRecord(value: unknown): ChatMessageRecord["retry"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const attempt = Number(raw.attempt ?? 1);
  const message = errorText((raw as { error?: unknown }).error, "ORBIT_RETRY_SCHEDULED", "Retrying");
  const next = Number(raw.at ?? 0) || undefined;
  return { attempt, message, ...(next !== undefined ? { next } : {}) };
}

export function insertMessage(draft: ChatDirectoryState, sessionID: string, message: ChatMessageRecord): void {
  const messages = draft.message[sessionID] ?? [];
  const result = Binary.search(messages, message.id, (item) => item.id);
  const next = [...messages];
  if (result.found) {
    next[result.index] = message;
  } else {
    next.splice(result.index, 0, message);
  }
  draft.message[sessionID] = next;
}

export function insertUserMessage(
  draft: ChatDirectoryState,
  sessionID: string,
  id: string,
  text: string,
  model?: Record<string, unknown>
): void {
  insertMessage(draft, sessionID, {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    ...(model && typeof model === "object" ? { model } : {})
  });
}

function maxPartSeq(parts: ChatPartRecord[]): number {
  return parts.reduce((max, part) => Math.max(max, typeof part.seq === "number" ? part.seq : 0), 0);
}

function insertPart(draft: ChatDirectoryState, part: ChatPartRecord): void {
  const parts = draft.part[part.messageID] ?? [];
  const result = Binary.search(parts, part.id, (item) => item.id);
  const next = [...parts];
  if (result.found) {
    next[result.index] = part;
  } else {
    const staged = typeof part.seq === "number" ? part : { ...part, seq: maxPartSeq(parts) + 1 };
    next.splice(result.index, 0, staged);
  }
  draft.part[part.messageID] = next;
}

function upsertPart(draft: ChatDirectoryState, next: ChatPartRecord): boolean {
  const parts = draft.part[next.messageID];
  if (!parts) {
    draft.part[next.messageID] = [next];
    return true;
  }
  const result = Binary.search(parts, next.id, (part) => part.id);
  if (result.found) {
    const previous = parts[result.index];
    if (shouldPreserveExistingPart(previous, next)) return false;
    const dedupeFields = getUpdatedDeltaFields(previous, next);
    const carried = { ...next, ...(typeof previous.seq === "number" ? { seq: previous.seq } : {}) };
    const replaced = dedupeFields.length > 0
      ? { ...carried, __dedupeNextDeltaFields: dedupeFields }
      : carried;
    const replacedParts = [...parts];
    replacedParts[result.index] = replaced;
    draft.part[next.messageID] = replacedParts;
    return true;
  }
  const inserted = [...parts];
  inserted.splice(result.index, 0, { ...next, seq: typeof next.seq === "number" ? next.seq : maxPartSeq(parts) + 1 });
  draft.part[next.messageID] = inserted;
  return true;
}

function applyDelta(
  draft: ChatDirectoryState,
  props: { sessionID?: string; messageID: string; partID: string; field: string; delta: string }
): ChatEventResult {
  const parts = draft.part[props.messageID];
  if (!parts) {
    return {
      changed: false,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "orphan-delta",
        sessionID: props.sessionID,
        messageID: props.messageID,
        partID: props.partID
      }
    };
  }
  const result = Binary.search(parts, props.partID, (part) => part.id);
  if (!result.found) {
    return {
      changed: false,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-delta-part",
        sessionID: props.sessionID,
        messageID: props.messageID,
        partID: props.partID
      }
    };
  }
  const existing = parts[result.index];
  const dedupeFields = (existing as unknown as { __dedupeNextDeltaFields?: string[] }).__dedupeNextDeltaFields ?? [];
  const shouldDedupe = dedupeFields.includes(props.field);
  const existingValue = partFieldValue(existing, props.field);
  const merged = shouldDedupe && existingValue && existingValue.endsWith(props.delta)
    ? existingValue
    : (existingValue ?? "") + props.delta;
  const updated = setPartFieldValue(existing, props.field, merged) as unknown as { __dedupeNextDeltaFields?: string[] } & ChatPartRecord;
  updated.__dedupeNextDeltaFields = dedupeFields.filter((field) => field !== props.field);
  const next = [...parts];
  next[result.index] = updated as ChatPartRecord;
  draft.part[props.messageID] = next;
  return true;
}

function basePart(messageID: string, sessionID: string, partID: string, type: string, created: number): ChatPartRecord {
  return {
    id: partID,
    messageID,
    sessionID,
    type,
    time: { created }
  };
}

function textSnapshot(
  messageID: string,
  sessionID: string,
  partID: string,
  type: "text" | "reasoning",
  text: string,
  created: number,
  state?: Record<string, unknown>
): ChatPartRecord {
  return {
    ...basePart(messageID, sessionID, partID, type, created),
    text,
    ...(state ? { state } : {}),
    time: { created, completed: created }
  };
}

export function completeLatestIncomplete(draft: ChatDirectoryState, sessionID: string): boolean {
  const messages = draft.message[sessionID];
  if (!messages) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const incomplete = !message.time?.completed && !message.finish;
    if (!incomplete && !message.retry) continue;
    const next = [...messages];
    next[index] = {
      ...message,
      ...(incomplete ? { time: { ...message.time, completed: Date.now() } } : {}),
      retry: undefined
    };
    draft.message[sessionID] = next;
    return true;
  }
  return false;
}

export function attachRetryToLatestAssistant(
  draft: ChatDirectoryState,
  sessionID: string,
  retry: { attempt: number; message: string; next?: number }
): boolean {
  const messages = draft.message[sessionID];
  if (!messages) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const next = [...messages];
    next[index] = { ...message, retry };
    draft.message[sessionID] = next;
    return true;
  }
  return false;
}

export function snapshotChatState(draft: ChatDirectoryState): ChatStateSnapshot {
  return {
    message: { ...draft.message },
    session_status: { ...draft.session_status }
  };
}

export function applyChatEvent(draft: ChatDirectoryState, routedSessionID: string, event: ChatStreamEvent): ChatEventResult {
  const data = event.data;
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : routedSessionID;

  switch (event.type) {
    case "session.status": {
      const raw = data.status as { type?: unknown; attempt?: unknown; message?: unknown; next?: unknown } | undefined;
      const status: ChatSessionStatus | null = raw?.type === "busy"
        ? { type: "busy" }
        : raw?.type === "idle"
          ? { type: "idle" }
          : raw?.type === "retry"
            ? { type: "retry", attempt: Number(raw.attempt ?? 1), message: formatFailure(raw.message, "ORBIT_RETRY_SCHEDULED", "Retrying"), next: Number(raw.next ?? 0) }
            : raw?.type === "error"
              ? { type: "error" }
              : null;
      if (!status) return false;
      if (areSessionStatusesEqual(draft.session_status[sessionID], status)) return false;
      draft.session_status = { ...draft.session_status, [sessionID]: status };
      return true;
    }
    case "session.idle": {
      const completed = completeLatestIncomplete(draft, sessionID);
      const status: ChatSessionStatus = { type: "idle" };
      if (!completed && areSessionStatusesEqual(draft.session_status[sessionID], status)) return false;
      draft.session_status = { ...draft.session_status, [sessionID]: status };
      return true;
    }
    case "session.error": {
      const failed = failLatestIncomplete(draft, sessionID, data.error, "ORBIT_SESSION_ERROR", "Session failed");
      return setChatSessionStatus(draft, sessionID, { type: "error" }) || failed;
    }
    case "message.updated": {
      const info = (data.info ?? data) as Record<string, any>;
      const messageID = String(info.id ?? "");
      const infoSessionID = typeof info.sessionID === "string" ? info.sessionID : sessionID;
      if (!messageID || !infoSessionID) return false;
      const next: ChatMessageRecord = {
        ...info,
        id: messageID,
        sessionID: infoSessionID,
        role: String(info.role ?? info.type ?? "assistant"),
        time: { created: Number(info.time?.created ?? event.created), completed: Number(info.time?.completed ?? 0) || undefined },
        finish: info.finish,
        ...(info.error ? { error: info.error } : {}),
        ...(retryRecord(info.retry) ? { retry: retryRecord(info.retry) } : {})
      };
      const terminal = next.role === "assistant" && (
        TERMINAL_TURN_FINISHES.has(String(next.finish ?? "")) || Boolean(next.error)
      );
      const statusChanged = terminal
        ? setChatSessionStatus(draft, infoSessionID, next.error ? { type: "error" } : { type: "idle" })
        : false;
      const messages = draft.message[infoSessionID] ?? [];
      const result = Binary.search(messages, messageID, (message) => message.id);
      if (result.found) {
        const existing = messages[result.index];
        if (areMessageUpdateFieldsEqual(existing, next)) return statusChanged;
        const replaced = [...messages];
        replaced[result.index] = next;
        draft.message[infoSessionID] = replaced;
      } else {
        const inserted = [...messages];
        inserted.splice(result.index, 0, next);
        draft.message[infoSessionID] = inserted;
      }
      return true;
    }
    case "message.removed": {
      const messageID = String(data.messageID ?? "");
      if (!messageID) return false;
      const messages = draft.message[sessionID];
      if (messages) {
        const result = Binary.search(messages, messageID, (message) => message.id);
        if (result.found) {
          const next = [...messages];
          next.splice(result.index, 1);
          if (next.length === 0) delete draft.message[sessionID];
          else draft.message[sessionID] = next;
        }
      }
      if (messageID in draft.part) delete draft.part[messageID];
      return true;
    }
    case "message.part.updated": {
      const part = (data.part ?? data) as Record<string, any>;
      if (SKIP_PARTS.has(String(part.type))) return false;
      const messageID = String(part.messageID ?? data.messageID ?? "");
      const partSessionID = typeof part.sessionID === "string" ? part.sessionID : sessionID;
      if (!messageID) return false;
      const missingOwningMessage = !hasMessage(draft, partSessionID, messageID);
      let next: ChatPartRecord = {
        ...part,
        id: String(part.id ?? ""),
        messageID,
        sessionID: partSessionID,
        type: String(part.type ?? "")
      };
      if (!next.id) return false;
      if (next.type === "tool") {
        const parts = draft.part[messageID] ?? [];
        const callID = String(part.callID ?? next.id);
        const canonicalID = toolPartID(messageID, callID);
        const canonical = Binary.search(parts, canonicalID, (item) => item.id);
        if (canonical.found) {
          const previous = parts[canonical.index];
          next = {
            ...previous,
            ...next,
            id: canonicalID,
            callID,
            state: { ...previous.state, ...next.state }
          };
        } else if (!Binary.search(parts, next.id, (item) => item.id).found) {
          next.id = canonicalID;
        }
      }
      upsertPart(draft, next);
      return missingOwningMessage
        ? {
            changed: true,
            materialization: {
              type: "incomplete-session-snapshot",
              reason: "missing-owning-message",
              sessionID: partSessionID,
              messageID,
              partID: next.id
            }
          }
        : true;
    }
    case "message.part.removed": {
      const messageID = String(data.messageID ?? "");
      const partID = String(data.partID ?? "");
      if (!messageID || !partID) return false;
      const parts = draft.part[messageID];
      if (!parts) return false;
      const result = Binary.search(parts, partID, (part) => part.id);
      if (!result.found) return false;
      const next = [...parts];
      next.splice(result.index, 1);
      if (next.length === 0) delete draft.part[messageID];
      else draft.part[messageID] = next;
      return true;
    }
    case "message.part.delta": {
      const deltaMessageID = String(data.messageID ?? "");
      const deltaPartID = String(data.partID ?? "");
      const parts = draft.part[deltaMessageID];
      let resolvedPartID = deltaPartID;
      if (parts && !Binary.search(parts, deltaPartID, (item) => item.id).found) {
        const alias = toolPartID(deltaMessageID, deltaPartID);
        if (Binary.search(parts, alias, (item) => item.id).found) resolvedPartID = alias;
      }
      return applyDelta(draft, {
        sessionID,
        messageID: deltaMessageID,
        partID: resolvedPartID,
        field: String(data.field ?? "text"),
        delta: String(data.delta ?? "")
      });
    }
    case "session.step.started": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const messages = draft.message[sessionID] ?? [];
      const next = messages.map((message) => {
        if (message.role !== "assistant" || message.id === messageID) return message;
        if (message.time?.completed || message.finish) return message;
        return { ...message, retry: undefined, time: { ...message.time, completed: event.created } };
      });
      draft.message[sessionID] = next;
      insertMessage(draft, sessionID, {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: event.created }
      });
      setChatSessionStatus(draft, sessionID, { type: "busy" });
      return true;
    }
    case "session.step.ended": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      insertMessage(draft, sessionID, {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: event.created, completed: event.created },
        finish: data.finish
      });
      if (TERMINAL_TURN_FINISHES.has(String(data.finish ?? ""))) {
        setChatSessionStatus(draft, sessionID, { type: "idle" });
      }
      return true;
    }
    case "session.step.failed": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      insertMessage(draft, sessionID, {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: event.created, completed: event.created },
        error: normalizeFailure(data.error, "ORBIT_STEP_FAILED", "Step failed")
      });
      setChatSessionStatus(draft, sessionID, { type: "error" });
      return true;
    }
    case "session.text.started": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const seq = data.ordinal === undefined ? sameTypeCount(draft, messageID, "text") : eventOrdinal(data);
      const partID = textPartID(messageID, "text", seq);
      const parts = draft.part[messageID] ?? [];
      const result = Binary.search(parts, partID, (part) => part.id);
      if (result.found) return false;
      insertPart(draft, basePart(messageID, sessionID, partID, "text", event.created));
      return true;
    }
    case "session.text.delta":
      return applyDelta(draft, {
        sessionID,
        messageID: eventMessageID(data),
        partID: textPartID(eventMessageID(data), "text", resolvedOrdinal(draft, eventMessageID(data), "text", data.ordinal)),
        field: "text",
        delta: String(data.delta ?? "")
      });
    case "session.text.ended": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const seq = data.ordinal === undefined ? Math.max(0, sameTypeCount(draft, messageID, "text") - 1) : eventOrdinal(data);
      const partID = textPartID(messageID, "text", seq);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      const state = data.state && typeof data.state === "object"
        ? data.state as Record<string, unknown>
        : undefined;
      if (!existing.found) {
        insertPart(draft, textSnapshot(messageID, sessionID, partID, "text", String(data.text ?? ""), event.created, state));
        return true;
      }
      const previous = parts[existing.index];
      const previousText = typeof previous.text === "string" ? previous.text : "";
      const nextText = String(data.text ?? "");
      return upsertPart(draft, {
        ...textSnapshot(
          messageID,
          sessionID,
          partID,
          "text",
          nextText.length >= previousText.length ? nextText : previousText,
          event.created,
          state ?? previous.state
        ),
        time: { created: previous.time?.created ?? event.created, completed: event.created }
      });
    }
    case "session.reasoning.started": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const seq = data.ordinal === undefined ? sameTypeCount(draft, messageID, "reasoning") : eventOrdinal(data);
      const partID = textPartID(messageID, "reasoning", seq);
      const parts = draft.part[messageID] ?? [];
      const result = Binary.search(parts, partID, (part) => part.id);
      if (result.found) return false;
      insertPart(draft, basePart(messageID, sessionID, partID, "reasoning", event.created));
      return true;
    }
    case "session.reasoning.delta":
      return applyDelta(draft, {
        sessionID,
        messageID: eventMessageID(data),
        partID: textPartID(eventMessageID(data), "reasoning", resolvedOrdinal(draft, eventMessageID(data), "reasoning", data.ordinal)),
        field: "text",
        delta: String(data.delta ?? "")
      });
    case "session.reasoning.ended": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const seq = data.ordinal === undefined ? Math.max(0, sameTypeCount(draft, messageID, "reasoning") - 1) : eventOrdinal(data);
      const partID = textPartID(messageID, "reasoning", seq);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      if (!existing.found) {
        insertPart(draft, textSnapshot(messageID, sessionID, partID, "reasoning", String(data.text ?? ""), event.created));
        return true;
      }
      const previous = parts[existing.index];
      const previousText = typeof previous.text === "string" ? previous.text : "";
      const nextText = String(data.text ?? "");
      return upsertPart(draft, {
        ...textSnapshot(messageID, sessionID, partID, "reasoning", nextText.length >= previousText.length ? nextText : previousText, event.created),
        time: { created: previous.time?.created ?? event.created, completed: event.created }
      });
    }
    case "session.tool.input.started": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      const partID = toolPartID(messageID, callID);
      const parts = draft.part[messageID] ?? [];
      const result = Binary.search(parts, partID, (part) => part.id);
      if (result.found) return false;
      insertPart(draft, {
        ...basePart(messageID, sessionID, partID, "tool", event.created),
        ...(typeof data.name === "string" && data.name ? { name: data.name } : {}),
        callID,
        state: { status: "running", input: "" }
      });
      return true;
    }
    case "session.tool.input.delta": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      return applyDelta(draft, {
        sessionID,
        messageID,
        partID: toolPartID(messageID, callID),
        field: "input",
        delta: String(data.delta ?? "")
      });
    }
    case "session.tool.input.ended": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      const partID = toolPartID(messageID, callID);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      if (!existing.found) {
        insertPart(draft, {
          ...basePart(messageID, sessionID, partID, "tool", event.created),
          callID,
          state: { status: "running", input: String(data.text ?? "") }
        });
        return true;
      }
      const previous = parts[existing.index];
      const previousInput = typeof previous.state?.input === "string" ? previous.state.input : "";
      const nextInput = String(data.text ?? "");
      return upsertPart(draft, {
        ...previous,
        state: {
          ...previous.state,
          input: nextInput.length >= previousInput.length ? nextInput : previousInput
        }
      });
    }
    case "session.tool.called": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      const partID = toolPartID(messageID, callID);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      const previous = existing.found ? parts[existing.index] : undefined;
      const part: ChatPartRecord = {
        ...basePart(messageID, sessionID, partID, "tool", event.created),
        ...(typeof data.name === "string" && data.name ? { name: data.name } : {}),
        callID,
        state: {
          ...(previous?.state ?? {}),
          status: "running",
          input: data.input,
          ...(data.metadata ? { metadata: data.metadata } : {})
        },
        time: { created: previous?.time?.created ?? event.created },
        ...(typeof data.executed === "boolean" ? { executed: data.executed } : {}),
        ...(data.state && typeof data.state === "object" ? { providerState: data.state } : {})
      };
      if (!existing.found) {
        insertPart(draft, part);
        return true;
      }
      return upsertPart(draft, part);
    }
    case "session.tool.progress": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      const partID = toolPartID(messageID, callID);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      if (!existing.found) {
        insertPart(draft, {
          ...basePart(messageID, sessionID, partID, "tool", event.created),
          callID,
          state: { status: "running", progress: data.progress ?? data.metadata, ...(data.metadata ? { metadata: data.metadata } : {}) }
        });
        return true;
      }
      const previous = parts[existing.index];
      const next = [...parts];
      next[existing.index] = {
        ...previous,
        state: {
          ...previous.state,
          progress: data.progress ?? data.metadata,
          ...(data.metadata ? { metadata: data.metadata } : {})
        }
      };
      draft.part[messageID] = next;
      return true;
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const messageID = eventMessageID(data);
      const callID = eventToolID(data);
      if (!messageID || !callID) return false;
      const partID = toolPartID(messageID, callID);
      const parts = draft.part[messageID] ?? [];
      const existing = Binary.search(parts, partID, (part) => part.id);
      const previous = existing.found ? parts[existing.index] : undefined;
      const failed = event.type === "session.tool.failed";
      const next: ChatPartRecord = {
        ...basePart(messageID, sessionID, partID, "tool", event.created),
        ...(typeof previous?.name === "string" ? { name: previous.name } : {}),
        callID,
        state: {
          ...(previous?.state ?? {}),
          status: failed ? "error" : "completed",
          time: { start: previous?.time?.created ?? event.created, end: event.created },
          ...(data.metadata ? { metadata: data.metadata } : {}),
          progress: undefined,
          ...(data.content !== undefined ? { content: data.content } : {}),
          ...(data.output !== undefined ? { output: data.output } : {}),
          ...(failed ? { error: data.error } : {})
        },
        time: { created: previous?.time?.created ?? event.created, completed: event.created },
        ...(typeof data.executed === "boolean" ? { executed: data.executed } : {}),
        ...(data.resultState && typeof data.resultState === "object" ? { providerResultState: data.resultState } : {})
      };
      if (!existing.found) {
        insertPart(draft, next);
        return true;
      }
      return upsertPart(draft, next);
    }
    case "session.retry.scheduled": {
      const messageID = eventMessageID(data);
      if (!messageID) return false;
      const retry = {
        attempt: Number(data.attempt ?? 1),
        message: errorText(data.error, "ORBIT_RETRY_SCHEDULED", "Retrying"),
        next: Number(data.at ?? data.next ?? 0) || undefined
      };
      setChatSessionStatus(draft, sessionID, {
        type: "retry",
        attempt: retry.attempt,
        message: retry.message,
        next: retry.next ?? 0
      });
      const messages = draft.message[sessionID] ?? [];
      const result = Binary.search(messages, messageID, (message) => message.id);
      if (result.found) {
        const next = [...messages];
        next[result.index] = { ...messages[result.index], retry };
        draft.message[sessionID] = next;
      } else {
        insertMessage(draft, sessionID, { id: messageID, sessionID, role: "assistant", time: { created: event.created }, retry });
      }
      return true;
    }
    case "session.execution.started":
      return setChatSessionStatus(draft, sessionID, { type: "busy" });
    case "session.execution.succeeded": {
      const completed = completeLatestIncomplete(draft, sessionID);
      return setChatSessionStatus(draft, sessionID, { type: "idle" }) || completed;
    }
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const failed = event.type === "session.execution.failed"
        ? failLatestIncomplete(draft, sessionID, data.error, "ORBIT_EXECUTION_FAILED", "Execution failed")
        : completeLatestIncomplete(draft, sessionID);
      return setChatSessionStatus(draft, sessionID, { type: "error" }) || failed;
    }
    default:
      return false;
  }
}

export function projectAssistantItems(draft: ChatDirectoryState, sessionID: string): TranscriptItem[] {
  const messages = draft.message[sessionID] ?? [];
  const out: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const storedParts = draft.part[message.id] ?? [];
    // OpenCode's canonical parts are ID-ordered; V2 stream parts use synthetic IDs
    // and retain the order in which the server reported their steps.
    const orderedParts = storedParts.every((part) => part.id.startsWith("prt_"))
      ? storedParts
      : storedParts
          .map((part, index) => ({ part, index }))
          .sort((left, right) => {
            const leftSeq = typeof left.part.seq === "number" ? left.part.seq : Number.MAX_SAFE_INTEGER;
            const rightSeq = typeof right.part.seq === "number" ? right.part.seq : Number.MAX_SAFE_INTEGER;
            return leftSeq === rightSeq ? left.index - right.index : leftSeq - rightSeq;
          })
          .map(({ part }) => part);
    const projected = orderedParts.flatMap((part): AssistantPartView[] => {
      const view = partFromProjection(part as Record<string, any>, Number(message.time?.created ?? 0));
      return view ? [view] : [];
    });
    const parts: AssistantPartView[] = [];
    const toolIndexes = new Map<string, number>();
    for (const part of projected) {
      if (part.kind !== "tool") {
        parts.push(part);
        continue;
      }
      const existingIndex = toolIndexes.get(part.tool.id);
      if (existingIndex === undefined) {
        toolIndexes.set(part.tool.id, parts.length);
        parts.push(part);
        continue;
      }
      const existing = parts[existingIndex];
      if (existing.kind !== "tool") continue;
      parts[existingIndex] = {
        ...part,
        tool: {
          ...existing.tool,
          ...part.tool,
          title: part.tool.title.toLowerCase().replace(/[^a-z]/g, "") === "tool" ? existing.tool.title : part.tool.title,
          detail: part.tool.detail || existing.tool.detail,
          input: part.tool.input || existing.tool.input,
          inputValue: part.tool.inputValue ?? existing.tool.inputValue,
          output: part.tool.output ?? existing.tool.output,
          paths: part.tool.paths?.length ? part.tool.paths : existing.tool.paths,
          metadata: part.tool.metadata ?? existing.tool.metadata
        }
      };
    }
    const retry = message.retry;
    const projectedItem: Extract<TranscriptItem, { kind: "assistant" }> = {
      kind: "assistant",
      id: message.id,
      messageID: message.id,
      parts,
      completed: Boolean(message.time?.completed ?? message.finish ?? (message.error && !message.retry)),
      ...(retry && typeof retry === "object"
        ? {
            retry: {
              attempt: Number((retry as Record<string, unknown>).attempt ?? 1),
              message: formatFailure((retry as Record<string, unknown>).message, "ORBIT_RETRY_SCHEDULED", "Retrying"),
              next: Number((retry as Record<string, unknown>).next ?? 0) || undefined
            }
          }
        : {}),
      ...(message.error ? { error: errorText(message.error) } : {})
    };
    out.push(projectedItem);
  }
  return out;
}

function recordFromView(messageID: string, sessionID: string, view: Extract<TranscriptItem, { kind: "assistant" }>["parts"][number]): ChatPartRecord {
  if (view.kind === "text" || view.kind === "reasoning") {
    return {
      id: view.id,
      messageID,
      sessionID,
      type: view.kind,
      text: view.text,
      time: view.complete ? { completed: 1 } : {}
    };
  }
  const tool = view.tool;
  const callID = tool.id;
  return {
    id: toolPartID(messageID, callID),
    messageID,
    sessionID,
    type: "tool",
    ...(tool.title !== "tool" ? { name: tool.title } : {}),
    callID,
    state: {
      status: tool.status === "running" ? "running" : tool.status === "success" ? "completed" : "error",
      input: tool.inputValue ?? tool.input ?? "",
      ...(tool.output !== undefined ? { output: tool.output } : {}),
      ...(tool.metadata ? { metadata: tool.metadata } : {}),
      ...(tool.progress !== undefined ? { progress: tool.progress } : {})
    },
    time: { created: tool.startedAt, ...(tool.duration !== undefined && tool.startedAt ? { completed: tool.startedAt + tool.duration } : {}) },
    ...(tool.executed !== undefined ? { executed: tool.executed } : {}),
    ...(tool.providerState ? { providerState: tool.providerState } : {}),
    ...(tool.providerResultState ? { providerResultState: tool.providerResultState } : {})
  };
}

export function hydrateChatState(draft: ChatDirectoryState, sessionID: string, transcript: TranscriptItem[]): void {
  for (const item of transcript) {
    if (item.kind !== "assistant") continue;
    const messages = draft.message[sessionID] ?? [];
    const messageResult = Binary.search(messages, item.id, (message) => message.id);
    const hydratedMessage: ChatMessageRecord = {
      id: item.id,
      sessionID,
      role: "assistant",
      time: { ...(item.completed ? { completed: 1 } : {}) },
      ...(item.error ? { error: { message: item.error } } : {}),
      ...(item.retry ? { retry: item.retry } : {})
    };
    if (messageResult.found) {
      const previous = messages[messageResult.index];
      const next = [...messages];
      next[messageResult.index] = {
        ...previous,
        ...hydratedMessage,
        time: hydratedMessage.time.completed
          ? { ...previous.time, completed: previous.time?.completed ?? hydratedMessage.time.completed }
          : previous.time,
        error: previous.error ?? hydratedMessage.error,
        retry: previous.retry ?? hydratedMessage.retry
      };
      draft.message[sessionID] = next;
    } else {
      insertMessage(draft, sessionID, hydratedMessage);
    }
    for (const view of item.parts) {
      const record = recordFromView(item.id, sessionID, view);
      const parts = draft.part[item.id] ?? [];
      const partResult = Binary.search(parts, record.id, (part) => part.id);
      if (!partResult.found) {
        insertPart(draft, record);
        continue;
      }
      const previous = parts[partResult.index];
      const next = [...parts];
      if (previous.type === "tool" && record.type === "tool") {
        const previousStatus = getToolStatus(previous);
        const previousFinished = Boolean(previousStatus && FINAL_TOOL_STATUSES.has(previousStatus));
        next[partResult.index] = previousFinished
          ? {
              ...previous,
              ...(record.name ? { name: record.name } : {}),
              state: { ...record.state, ...previous.state },
              time: { ...record.time, ...previous.time }
            }
          : { ...previous, ...record, state: { ...previous.state, ...record.state }, time: { ...previous.time, ...record.time } };
      } else if ((previous.type === "text" || previous.type === "reasoning") && record.type === previous.type) {
        next[partResult.index] = {
          ...record,
          text: typeof previous.text === "string" && previous.text.length > String(record.text ?? "").length
            ? previous.text
            : record.text,
          time: { ...record.time, ...(previous.time?.completed ? { completed: previous.time.completed } : {}) }
        };
      } else {
        next[partResult.index] = record;
      }
      draft.part[item.id] = next;
    }
  }
}
