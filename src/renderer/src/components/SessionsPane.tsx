import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import type { SessionSummary } from "@shared/types";
import { ChevronIcon, PlusIcon } from "./FileIcons";
import { IconClose, IconFolder, IconHistory, IconStarFilled } from "./icons";

const PINNED_KEY = "openshell.pinnedSessions";

interface WorkspaceMenuState {
  directory: string;
  x: number;
  y: number;
}

interface SessionMenuState {
  id: string;
  title: string;
  x: number;
  y: number;
}

function readPinned(): string[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function SessionRow({
  summary,
  running,
  focused,
  pinned,
  busy,
  onOpen,
  onClose,
  onTogglePin,
  onDelete
}: {
  summary: SessionSummary;
  running: boolean;
  focused: boolean;
  pinned: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose?: () => void;
  onTogglePin: () => void;
  onDelete?: (e: React.MouseEvent) => void;
}): ReactNode {
  return (
    <div
      className={`sessions-row ${focused ? "focused" : ""} ${running ? "running" : ""}`}
      onClick={onOpen}
      title={summary.directory}
      onContextMenu={onDelete ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDelete(e);
      } : undefined}
    >
      {running ? (
        <span className={`agent-dot live ${busy ? "busy" : ""}`} />
      ) : (
        <IconHistory className="sessions-row-icon" />
      )}
      <span className="sessions-row-main">
        <span className="sessions-row-title">{summary.title}</span>
      </span>
      <button
        className={`sessions-row-pin ${pinned ? "pinned" : ""}`}
        title={pinned ? "Unpin session" : "Pin session"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        <IconStarFilled />
      </button>
      {onClose && (
        <button
          className="sessions-row-close"
          title={`Close the ${summary.title} session`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

export function SessionsPane(): ReactNode {
  const {
    panels,
    panelViews,
    activeSessionID,
    focusSession,
    closePanel,
    reopenSession,
    deleteSession,
    openSession,
    selectFolder,
    sessions,
    savedWorkspaces,
    saveWorkspace,
    removeWorkspace,
    activeSessions,
    loadSessions,
  } = useStore();
  const [pinnedIDs, setPinnedIDs] = useState<string[]>(readPinned);
  const [openNowOpen, setOpenNowOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!workspaceMenu && !sessionMenu) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!workspaceMenuRef.current?.contains(event.target as Node) &&
        !sessionMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceMenu(null);
        setSessionMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setWorkspaceMenu(null);
        setSessionMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [workspaceMenu, sessionMenu]);

  const runningPanels = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const openSessionInfos = useMemo(() => {
    const seen = new Set<string>();
    const result = [] as typeof activeSessions;
    for (const info of activeSessions) {
      if (seen.has(info.id)) continue;
      seen.add(info.id);
      result.push(info);
    }
    for (const info of panels) {
      if (seen.has(info.id)) continue;
      seen.add(info.id);
      result.push(info);
    }
    return result;
  }, [activeSessions, panels]);
  const byID = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const openSummaries = useMemo(
    () =>
      openSessionInfos.map((info) => ({
        id: info.id,
        title: info.title ?? byID.get(info.id)?.title ?? info.directory.split(/[\\/]/).filter(Boolean).pop() ?? info.directory,
        directory: info.directory,
        updatedAt: byID.get(info.id)?.updatedAt ?? 0
      })),
    [openSessionInfos, byID]
  );
  const known = useMemo(() => {
    const seen = new Set(sessions.map((s) => s.id));
    return [...byID.values(), ...openSummaries.filter((p) => !seen.has(p.id))];
  }, [sessions, openSummaries, byID]);
  const recents = useMemo(() => [...known].sort((a, b) => b.updatedAt - a.updatedAt), [known]);
  const openNowIDs = useMemo(() => new Set(openSummaries.map((summary) => summary.id)), [openSummaries]);
  const history = useMemo(
    () => recents.filter((summary) => !openNowIDs.has(summary.id)),
    [recents, openNowIDs]
  );

  // Keep Open now visible whenever it has entries to show.
  useEffect(() => {
    if (openSummaries.length > 0) setOpenNowOpen(true);
  }, [openSummaries.length]);

  const togglePin = (id: string): void => {
    setPinnedIDs((current) => {
      const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
      window.localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });
  };

  const openRow = (summary: SessionSummary): void => {
    if (runningPanels.has(summary.id)) focusSession(summary.id);
    else void reopenSession(summary.id, false, summary.directory);
  };

  const askDeleteRow = (summary: { id: string; title: string }, x: number, y: number): void => {
    setWorkspaceMenu(null);
    setSessionMenu({ id: summary.id, title: summary.title, x, y });
  };

  const newSession = (): void => {
    void selectFolder();
  };

  const toggleProject = (directory: string): void => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  };

  return (
    <div className="sessions-pane">
      <div className="sessions-actions">
        <button className="sessions-new" onClick={newSession} title="Choose a folder for a new session">
          <PlusIcon />
          New Session
        </button>
      </div>

      <section className="sessions-section">
        <div className="section-trigger">
          <button
            className={`section-toggle ${openNowOpen ? "open" : ""}`}
            aria-expanded={openNowOpen}
            onClick={() => setOpenNowOpen((open) => !open)}
          >
            <span>Open now</span>
            <span className="section-chevron">
              <ChevronIcon open={openNowOpen} />
            </span>
          </button>
        </div>
        {openNowOpen && (
          <div className="sessions-section-list">
          {openSummaries.length === 0 ? (
            <div className="sessions-empty">No open sessions.</div>
          ) : (
            openSummaries.map((summary) => {
              const panel = runningPanels.get(summary.id);
              return (
                <SessionRow
                  key={summary.id}
                  summary={summary}
                  running
                  focused={summary.id === activeSessionID}
                  pinned={pinnedIDs.includes(summary.id)}
                  busy={Boolean(panel && panelViews[panel.workspace.id]?.busy)}
                  onOpen={() => openRow(summary)}
                  onClose={() => closePanel(summary.id)}
                  onTogglePin={() => togglePin(summary.id)}
                  onDelete={(e) => askDeleteRow(summary, e.clientX, e.clientY)}
                />
              );
            })
          )}
          </div>
        )}
      </section>

      <section className="sessions-section">
        <div className="section-trigger sessions-workspaces-trigger">
          <button
            className={`section-toggle ${workspacesOpen ? "open" : ""}`}
            aria-expanded={workspacesOpen}
            onClick={() => setWorkspacesOpen((open) => !open)}
          >
            <span>Workspaces</span>
          </button>
          <button
            className="sessions-workspace-add"
            type="button"
            title="Save a workspace in Orbit"
            aria-label="Save a workspace in Orbit"
            onClick={() => void saveWorkspace()}
          >
            <PlusIcon />
          </button>
          <span className="section-chevron sessions-workspaces-chevron">
            <ChevronIcon open={workspacesOpen} />
          </span>
        </div>
        {workspacesOpen && (
          <div className="sessions-section-list sessions-project-list">
          {savedWorkspaces.length === 0 ? (
            <div className="sessions-empty">No saved workspaces found.</div>
          ) : (
            savedWorkspaces.map((workspace) => {
              const workspaceSessions = recents.filter((summary) => summary.directory === workspace.directory);
              const expanded = expandedProjects.has(workspace.directory);
              const workspaceDisplayName = workspace.name.trim()
                || workspace.directory.split(/[\\/]/).filter(Boolean).pop()
                || "workspace";
              return (
                <div
                  key={workspace.directory}
                  className="sessions-project"
                >
                  <div
                    className={`sessions-project-head ${expanded ? "open" : ""}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setWorkspaceMenu({
                        directory: workspace.directory,
                        x: event.clientX,
                        y: event.clientY
                      });
                    }}
                  >
                    <button
                      className="sessions-project-open"
                      type="button"
                      aria-label={`Open workspace ${workspaceDisplayName}`}
                      onClick={() => void openSession(workspace.directory)}
                      title={workspace.directory}
                    >
                      <IconFolder className="sessions-row-icon" />
                      <span className="sessions-row-title">{workspaceDisplayName}</span>
                      <span className="sessions-project-count">{workspaceSessions.length}</span>
                    </button>
                    <button
                      className="sessions-project-disclosure"
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${workspaceDisplayName} sessions`}
                      aria-expanded={expanded}
                      title={`${expanded ? "Collapse" : "Expand"} session history`}
                      onClick={() => toggleProject(workspace.directory)}
                    >
                      <span className="section-chevron"><ChevronIcon open={expanded} /></span>
                    </button>
                  </div>
                  {expanded && (
                    <div className="sessions-project-sessions">
                      {workspaceSessions.length === 0 ? (
                        <div className="sessions-empty">No sessions yet.</div>
                      ) : workspaceSessions.map((s) => {
                        const panel = runningPanels.get(s.id);
                        return (
                          <SessionRow
                            key={s.id}
                            summary={s}
                            running={openNowIDs.has(s.id)}
                            focused={s.id === activeSessionID}
                            pinned={pinnedIDs.includes(s.id)}
                            busy={Boolean(panel && panelViews[panel.workspace.id]?.busy)}
                            onOpen={() => openRow(s)}
                            onClose={openNowIDs.has(s.id) ? () => closePanel(s.id) : undefined}
                            onTogglePin={() => togglePin(s.id)}
                            onDelete={(e) => askDeleteRow(s, e.clientX, e.clientY)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
          </div>
        )}
      </section>

      <section className="sessions-section grow">
        <div className="section-trigger">
          <button
            className={`section-toggle ${historyOpen ? "open" : ""}`}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <span>History</span>
            <span className="section-chevron">
              <ChevronIcon open={historyOpen} />
            </span>
          </button>
        </div>
        {historyOpen && (
          <div className="sessions-section-list">
          {history.length === 0 ? (
            <div className="sessions-empty">No closed sessions yet.</div>
          ) : (
            history.map((summary) => {
              return (
                <SessionRow
                  key={summary.id}
                  summary={summary}
                  running={false}
                  focused={false}
                  pinned={pinnedIDs.includes(summary.id)}
                  busy={false}
                  onOpen={() => openRow(summary)}
                  onTogglePin={() => togglePin(summary.id)}
                  onDelete={(e) => askDeleteRow(summary, e.clientX, e.clientY)}
                />
              );
            })
          )}
          </div>
        )}
      </section>
      {workspaceMenu && (
        <div
          ref={workspaceMenuRef}
          className="sessions-context-menu"
          style={{ left: Math.max(4, Math.min(workspaceMenu.x, window.innerWidth - 190)), top: Math.max(4, Math.min(workspaceMenu.y, window.innerHeight - 70)) }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="sessions-context-item"
            onClick={() => {
              removeWorkspace(workspaceMenu.directory);
              setWorkspaceMenu(null);
            }}
          >
            Remove from Orbit
          </button>
        </div>
      )}
      {sessionMenu && (
        <div
          ref={sessionMenuRef}
          className="sessions-context-menu"
          style={{ left: Math.max(4, Math.min(sessionMenu.x, window.innerWidth - 190)), top: Math.max(4, Math.min(sessionMenu.y, window.innerHeight - 70)) }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="sessions-context-item sessions-context-danger"
            title={`Permanently delete "${sessionMenu.title}" from opencode`}
            onClick={() => {
              const id = sessionMenu.id;
              setSessionMenu(null);
              void deleteSession(id);
            }}
          >
            Delete session
          </button>
        </div>
      )}
    </div>
  );
}
