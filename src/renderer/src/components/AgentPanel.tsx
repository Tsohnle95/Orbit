import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePanel, useStore } from "../store";
import { OpenCodeTimeline, PermissionPrompt } from "./OpenCodeTimeline";
import { FormPrompt } from "./FormPrompt";
import { OpenCodeTodoDock } from "./OpenCodeTodoDock";
import type { SessionInfo, TranscriptItem } from "@shared/types";
import { IconArrowLeft, IconClose, IconFolderOpen, IconMoreVertical } from "./icons";
import { AgentTui } from "./AgentTui";
import { OrbitMark } from "./OrbitMark";
import { MAX_AGENT_PANELS } from "../agent-panels";
import { Composer } from "./Composer";
import { TurnTimer, useAgentUsage } from "./AgentUsage";
import { useAgentScroll } from "./agent-scroll";
import { useMenuDismiss } from "./use-menu-dismiss";

type PanelMode = "gui" | "tui";

function panelModeStorageKey(sessionID: string): string {
  return `orbit.agent-panel-mode.${sessionID}`;
}

function readPanelMode(sessionID: string | undefined): PanelMode {
  if (!sessionID) return "gui";
  try {
    return window.localStorage.getItem(panelModeStorageKey(sessionID)) === "tui" ? "tui" : "gui";
  } catch {
    return "gui";
  }
}

function savePanelMode(sessionID: string | undefined, mode: PanelMode): void {
  if (!sessionID) return;
  try {
    window.localStorage.setItem(panelModeStorageKey(sessionID), mode);
  } catch {
    return;
  }
}

export function AgentPanel({
  session,
  sessionChoices,
  visibleSessionIDs,
  agentPanelLimitReached,
  agentModeActive,
  onSessionSelect,
  isAnchor: _isAnchor,
  onFocus,
  onClose,
  onResizeLeft,
  onResizeRight,
  onPanelDrag,
  onPanelDragEnd
}: {
  session?: SessionInfo | null;
  sessionChoices?: SessionInfo[];
  visibleSessionIDs?: ReadonlySet<string>;
  agentPanelLimitReached?: boolean;
  agentModeActive?: boolean;
  onSessionSelect?: (sessionID: string) => void | Promise<void>;
  isAnchor?: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  onResizeLeft?: (e: React.MouseEvent) => void;
  onResizeRight?: (e: React.MouseEvent) => void;
  onPanelDrag?: (delta: number) => void;
  onPanelDragEnd?: () => void;
}): ReactNode {
  const {
    session: storeSession,
    sessions,
    reopenSession,
    providerUsage,
    providerUsageLoading,
    refreshProviderUsage,
    selectPanelDirectory,
    commitStagedRevert,
    clearStagedRevert,
    runtimes,
    selectFolder
  } = useStore();
  const activeSession = session === undefined ? storeSession : session;
  const view = usePanel(activeSession?.workspace);
  const { busy, todos, transcript, sessionUsage, compactionBaseline, currentModel, turnStartedAt, assistantStatus } = view;
  const { scrollRef, onScroll } = useAgentScroll(activeSession, transcript, busy, view.queuedMessages);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const panelDragRef = useRef<number | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(() => readPanelMode(activeSession?.id));
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [tuiNotice, setTuiNotice] = useState("");
  const runtime = runtimes?.find((item) => item.id === (activeSession?.runtimeID ?? "opencode"));
  const tuiAvailable = Boolean(activeSession) && (runtime?.capabilities.tui ?? (activeSession?.runtimeID ?? "opencode") === "opencode");
  const startPanelDrag = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!onPanelDrag || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    let hasDragged = false;
    panelDragRef.current = startX;
    const move = (moveEvent: MouseEvent): void => {
      if (panelDragRef.current === null) return;
      if (!hasDragged) {
        if (Math.abs(moveEvent.clientX - startX) < 4) return;
        hasDragged = true;
      }
      const delta = moveEvent.clientX - panelDragRef.current;
      panelDragRef.current = moveEvent.clientX;
      onPanelDrag(delta);
    };
    const stop = (): void => {
      panelDragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      if (hasDragged) onPanelDragEnd?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };
  const parent = activeSession?.parentID ? sessions.find((item) => item.id === activeSession.parentID) : undefined;

  useEffect(() => {
    const savedMode = readPanelMode(activeSession?.id);
    setPanelMode(savedMode === "tui" && tuiAvailable ? "tui" : "gui");
    setModeMenuOpen(false);
    setTuiNotice("");
  }, [activeSession?.id, activeSession?.workspace.id, activeSession?.workspace.generation, tuiAvailable]);

  const { usageButton, usagePopup } = useAgentUsage({ sessionUsage, compactionBaseline, currentModel,
    providerUsage, providerUsageLoading, refreshProviderUsage, panelRef });

  useMenuDismiss(modeMenuOpen, panelRef, useCallback(() => setModeMenuOpen(false), []));

  const choosePanelMode = (next: "gui" | "tui"): void => {
    setModeMenuOpen(false);
    if (next === "tui") {
      if (!tuiAvailable) {
        setTuiNotice("TUI is unavailable for this runtime.");
        return;
      }
      setTuiNotice("");
      setPanelMode("tui");
      savePanelMode(activeSession?.id, "tui");
      return;
    }
    setTuiNotice("");
    setPanelMode("gui");
    savePanelMode(activeSession?.id, "gui");
  };

  const chooseSession = (sessionID: string): void => {
    void onSessionSelect?.(sessionID);
    setModeMenuOpen(false);
  };

  const sessionLabel = (choice: SessionInfo): string =>
    choice.title ?? choice.directory.split(/[\\/]/).filter(Boolean).pop() ?? choice.agent ?? choice.id;

  const handleTuiExit = (exitCode: number | null): void => {
    setPanelMode("gui");
    savePanelMode(activeSession?.id, "gui");
    setTuiNotice(exitCode === 0 ? "Agent TUI exited." : `Agent TUI exited${exitCode === null ? "" : ` with code ${exitCode}`}.`);
  };

  const handleTuiError = (message: string): void => {
    setPanelMode("gui");
    savePanelMode(activeSession?.id, "gui");
    setTuiNotice(message);
  };

  const lastAssistantId = useMemo(() => {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const item = transcript[i];
      if (item.kind === "assistant") return item.id;
    }
    return null;
  }, [transcript]);

  const pendingPermission = useMemo(
    () => [...transcript]
      .reverse()
      .find((item): item is Extract<TranscriptItem, { kind: "permission" }> => item.kind === "permission" && item.pending),
    [transcript]
  );

  // Approvals and forms are interactive: the surface the user is watching owns
  // them. The embedded TUI renders its own prompts in the terminal, so drawing
  // the panel dock there would ask the same question twice.
  const interactivePrompts = (
    <>
      {pendingPermission && <PermissionPrompt item={pendingPermission} session={activeSession} />}
      {activeSession && (view.pendingForms ?? []).map((form) => (
        <FormPrompt key={form.id} form={form} workspace={activeSession.workspace} />
      ))}
    </>
  );

  return (
    <div
      className="agent-panel"
      ref={panelRef}
      onMouseDownCapture={onFocus}
    >
      {onResizeLeft && <div className="panel-resize-handle panel-resize-left" onMouseDown={onResizeLeft} />}
      {onResizeRight && <div className="panel-resize-handle panel-resize-right" onMouseDown={onResizeRight} />}
      <div className="agent-header" ref={headerRef} onMouseDown={startPanelDrag}>
        {activeSession?.parentID && (
          <button
            className="icon-btn agent-session-back"
            title={`Back to ${parent?.title ?? "parent session"}`}
            aria-label={`Back to ${parent?.title ?? "parent session"}`}
            onClick={() => void reopenSession(activeSession.parentID!)}
          >
            <IconArrowLeft />
          </button>
        )}
        {!activeSession?.parentID && <span className="agent-orb" aria-hidden="true"><OrbitMark size={16} /></span>}
        <div className="agent-identity">
          <div className="agent-identity-line">
            {onClose ? (
              <button
                className={`agent-status-dot agent-close ${busy || assistantStatus?.isWorking ? "working" : "idle"}`}
                title="Close model panel"
                aria-label="Close model panel"
                onClick={() => onClose()}
              >
                <IconClose />
              </button>
            ) : (
              <span
                className={`agent-status-dot ${busy || assistantStatus?.isWorking ? "working" : "idle"}`}
                title={assistantStatus?.statusText ?? (busy ? "Working" : "Idle")}
                aria-label={assistantStatus?.statusText ?? (busy ? "Working" : "Idle")}
              />
            )}
            {activeSession?.parentID ? (
              <span className="agent-title">
                {activeSession.title ?? sessions.find((item) => item.id === activeSession.id)?.title ?? activeSession.agent ?? activeSession.directory?.split("/").filter(Boolean).pop() ?? (parent ? `${parent.title} subagent` : "Subagent session")}
                {activeSession.agent && activeSession.agent !== activeSession.title && (
                  <span className="agent-subagent">@{activeSession.agent}</span>
                )}
              </span>
            ) : (
              <span className="agent-title">Agent</span>
            )}
          </div>
          {!activeSession?.parentID && (activeSession?.directory ? (
              <button
                className="agent-workspace"
                title={`Change workspace — currently ${activeSession.directory}`}
                aria-label="Change workspace"
                onClick={() => void selectPanelDirectory(activeSession.workspace)}
              >
                <IconFolderOpen />
                <span>{activeSession.directory.split("/").filter(Boolean).pop()}</span>
              </button>
            ) : (
              <button
                className="agent-workspace"
                title="Open a workspace"
                aria-label="Open a workspace"
                onClick={() => void selectFolder()}
              >
                <IconFolderOpen />
                <span>Add workspace</span>
              </button>
            ))}
          {(busy || assistantStatus?.isWorking) && assistantStatus?.statusText && (
            <span className="agent-status-text">{assistantStatus.statusText}</span>
          )}
          {activeSession?.parentID && !(busy || assistantStatus?.isWorking) && (
            <span className="agent-status-text">
              Delegated agent{activeSession.agent ? ` · @${activeSession.agent}` : ""} · idle
            </span>
          )}
        </div>
        <TurnTimer startedAt={turnStartedAt} />
        <div className="agent-header-actions">
          {usageButton}
          {modeMenuOpen && (
            <div className="agent-mode-menu" role="menu" aria-label="Agent panel options">
              <button
                role="menuitemradio"
                aria-checked={panelMode === "gui"}
                className={panelMode === "gui" ? "selected" : ""}
                onClick={() => choosePanelMode("gui")}
              >
                <span>GUI</span>
                <small>Orbit agent panel</small>
              </button>
              <button
                role="menuitemradio"
                aria-checked={panelMode === "tui"}
                className={`${panelMode === "tui" ? "selected" : ""} ${!tuiAvailable ? "disabled" : ""}`}
                title={tuiAvailable ? "Open the runtime TUI in this panel" : "TUI is unavailable for this runtime"}
                onClick={() => choosePanelMode("tui")}
              >
                <span>TUI</span>
                <small>{tuiAvailable ? "Terminal interface" : "Unavailable"}</small>
              </button>
              {sessionChoices && sessionChoices.length > 0 && (
                <>
                  <div className="agent-mode-menu-divider" />
                  <div className="agent-mode-menu-heading">Active sessions</div>
                  {sessionChoices.map((choice) => (
                    (() => {
                      const visible = visibleSessionIDs?.has(choice.id) ?? false;
                      const disabled = Boolean(agentModeActive && agentPanelLimitReached && !visible);
                      return (
                        <button
                          key={choice.id}
                          role="menuitemcheckbox"
                          aria-checked={visible}
                          className={`${visible ? "selected" : ""} ${disabled ? "disabled" : ""}`}
                          title={disabled ? `Agent panel limit reached (${MAX_AGENT_PANELS})` : choice.directory}
                          disabled={disabled}
                          onClick={() => chooseSession(choice.id)}
                        >
                          <span>{sessionLabel(choice)}</span>
                          <small>{disabled ? "Agent panel limit reached" : visible ? (agentModeActive ? "In Agent Mode" : "Current coding workspace") : agentModeActive ? "Add to Agent Mode" : "Switch workspace"}</small>
                        </button>
                      );
                    })()
                  ))}
                </>
              )}
            </div>
          )}
          <button
            className={`icon-btn agent-mode-menu-toggle ${modeMenuOpen ? "open" : ""}`}
            title="Agent panel options"
            aria-label="Agent panel options"
            aria-expanded={modeMenuOpen}
            onClick={() => setModeMenuOpen((open) => !open)}
          >
            <IconMoreVertical />
          </button>
        </div>
      </div>
      {usagePopup}

      {panelMode === "tui" && activeSession ? (
        <AgentTui workspace={activeSession.workspace} onExit={handleTuiExit} onError={handleTuiError} />
      ) : (
        <>
          <div className="agent-scroll" ref={scrollRef} onScroll={onScroll}>
            {tuiNotice && <div className="agent-tui-notice">{tuiNotice}</div>}
            {transcript.length === 0 && (
              <div className="agent-empty">
                <p>Tell the agent what to work on.</p>
                <p className="agent-empty-sub">
                  It will stream its progress here, and every file it touches will show up under{" "}
                  <b>Changes</b> with a red/green diff.
                </p>
              </div>
            )}
            <OpenCodeTimeline
              transcript={transcript}
              busy={busy}
              lastAssistantId={lastAssistantId}
              session={activeSession}
            />
          </div>

          <div data-component="session-prompt-dock">
            {interactivePrompts}
            {view.stagedRevert && activeSession && (
              <div data-component="dock-prompt" data-kind="revert">
                <div data-slot="permission-header">Undo staged</div>
                <p className="provider-note">Messages and file changes after this point will be removed.</p>
                <div data-slot="permission-actions">
                  <button className="btn btn-danger" onClick={() => void commitStagedRevert(activeSession.workspace)}>Commit undo</button>
                  <button className="btn" onClick={() => void clearStagedRevert(activeSession.workspace)}>Discard</button>
                </div>
              </div>
            )}
            <OpenCodeTodoDock todos={todos} />
            <Composer session={activeSession} />
          </div>
        </>
      )}
    </div>
  );
}
