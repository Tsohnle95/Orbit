import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store";
import { useOptionalTheme } from "../theme";
import { terminalThemeForAppearance } from "../appearances";
import { IconAdd, IconChevronDown, IconChevronUp, IconServer } from "./icons";
import type { ViteServerInfo, WorkspaceIdentity } from "@shared/types";
import { PendingTerminalOutput, removeTerminal, terminalDirectoryCommand, type TerminalTabs } from "../terminal-state";

function relativeServerDirectory(root: string, directory: string): string {
  const base = root.replace(/[\\/]+$/, "");
  if (directory === base) return "";
  if (directory.startsWith(`${base}/`) || directory.startsWith(`${base}\\`)) {
    return directory.slice(base.length + 1).split(/[\\/]/).join("/");
  }
  return directory;
}

function viteServerLabel(server: ViteServerInfo, root: string): string {
  const relative = relativeServerDirectory(root, server.directory);
  const entry = server.entry || "index.html";
  return relative ? `${relative}/${entry}` : entry;
}

interface TermInstanceProps {
  id: string;
  active: boolean;
  height: number;
  workspace: WorkspaceIdentity;
  onRegister: (id: string, writer: (data: string) => void) => void;
  onUnregister: (id: string) => void;
}

function TermInstance({ id, active, height, workspace, onRegister, onUnregister }: TermInstanceProps): ReactNode {
  const theme = useOptionalTheme()?.theme ?? "prism";
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalThemeForAppearance(theme)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* hidden */
    }

    term.onData((data) => {
      void window.openshell.terminalInput(workspace, id, data);
    });

    onRegister(id, (data) => term.write(data));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
      void window.openshell.terminalResize(workspace, id, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);

    void window.openshell.terminalResize(workspace, id, term.cols, term.rows).catch(() => {});

    return () => {
      onUnregister(id);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      void window.openshell.terminalStop(workspace, id).catch(() => {});
    };
  }, [id, workspace, onRegister, onUnregister]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalThemeForAppearance(theme);
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
      void window.openshell.terminalResize(workspace, id, term.cols, term.rows).catch(() => {});
    });
    term.focus();
  }, [active, height, id, workspace]);

  return (
    <div className={`terminal-host ${active ? "" : "hidden"}`} ref={hostRef} />
  );
}

export function TerminalTray({
  height,
  snapped,
  request,
  onClose,
  onExpand
}: {
  height: number;
  snapped: boolean;
  request?: { id: number; directory: string } | null;
  onClose: () => void;
  onExpand: () => void;
}): ReactNode {
  const { session, activePath } = useStore();
  const workspace = session!.workspace;
  const sessionDirectory = session!.directory;
  const [{ terms, activeId }, setTabs] = useState<TerminalTabs>({ terms: [], activeId: null });
  const [notice, setNotice] = useState("");
  const [viteStarting, setViteStarting] = useState(false);
  const [viteServers, setViteServers] = useState<ViteServerInfo[]>([]);
  const [viteMenu, setViteMenu] = useState<{ x: number; y: number } | null>(null);
  const counterRef = useRef(0);
  const bootTokenRef = useRef(0);
  const handledRequestRef = useRef<number | null>(null);
  const writersRef = useRef<Map<string, (data: string) => void>>(new Map());
  const pendingOutputRef = useRef(new PendingTerminalOutput());

  const onRegister = useCallback((id: string, writer: (data: string) => void): void => {
    writersRef.current.set(id, writer);
    for (const data of pendingOutputRef.current.register(id)) writer(data);
  }, []);

  const onUnregister = useCallback((id: string): void => {
    writersRef.current.delete(id);
    pendingOutputRef.current.remove(id);
  }, []);

  useEffect(() => {
    const off = window.openshell.onMessage((msg) => {
      if (msg.kind === "terminal-data") {
        const terminal = msg.terminal;
        const writer = writersRef.current.get(terminal.id);
        if (writer) writer(terminal.data);
        else pendingOutputRef.current.write(terminal.id, terminal.data);
      } else if (msg.kind === "terminal-exit") {
        const id = msg.terminal.id;
        writersRef.current.delete(id);
        pendingOutputRef.current.remove(id);
        setTabs((current) => removeTerminal(current, id));
      }
    });
    return off;
  }, []);

  useEffect(() => {
    setViteStarting(false);
    setViteServers([]);
    setViteMenu(null);
  }, [workspace.id]);

  const refreshServers = useCallback(async (): Promise<void> => {
    try {
      const running = await window.openshell.viteServers();
      setViteServers(running.filter((server) => server.workspaceId === workspace.id));
    } catch {
      setViteServers([]);
    }
  }, [workspace.id]);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const createTerminal = useCallback(async (directory = ""): Promise<void> => {
    setNotice("");
    const id = `term-${crypto.randomUUID()}`;
    pendingOutputRef.current.awaitRegistration(id);
    const count = ++counterRef.current;
    const name = directory.split("/").filter(Boolean).pop() ?? `Terminal ${count}`;
    setTabs((current) => ({ terms: [...current.terms, { id, name }], activeId: id }));
    try {
      const startedDirectory = await window.openshell.terminalStart(workspace, id, directory);
      if (directory && !startedDirectory) {
        const command = terminalDirectoryCommand(window.openshell.platform, sessionDirectory, directory);
        if (command) await window.openshell.terminalInput(workspace, id, command);
      }
    } catch (err) {
      pendingOutputRef.current.remove(id);
      setTabs((current) => removeTerminal(current, id));
      setNotice(err instanceof Error ? err.message : "Could not start a terminal");
    }
  }, [sessionDirectory, workspace]);

  useEffect(() => {
    const token = ++bootTokenRef.current;
    setTabs({ terms: [], activeId: null });
    writersRef.current.clear();
    pendingOutputRef.current.clear();
    void (async () => {
      const id = `term-${crypto.randomUUID()}`;
      pendingOutputRef.current.awaitRegistration(id);
      const name = `Terminal ${++counterRef.current}`;
      setTabs({ terms: [{ id, name }], activeId: id });
      try {
        await window.openshell.terminalStart(workspace, id, "");
        if (token !== bootTokenRef.current) {
          void window.openshell.terminalStop(workspace, id).catch(() => {});
          return;
        }
      } catch (err) {
        if (token === bootTokenRef.current) {
          pendingOutputRef.current.remove(id);
          setTabs((current) => removeTerminal(current, id));
          setNotice(err instanceof Error ? err.message : "Could not start a terminal");
        }
      }
    })();
    return () => {
      bootTokenRef.current++;
    };
  }, [workspace]);

  useEffect(() => {
    if (!request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    void createTerminal(request.directory);
  }, [createTerminal, request]);

  const openVite = (): void => {
    if (viteStarting) return;
    setNotice("");
    setViteStarting(true);
    const entryPath = activePath && !activePath.startsWith("/") && /\.html?$/i.test(activePath)
      ? activePath
      : undefined;
    const toggle = entryPath
      ? window.openshell.viteToggle(workspace, entryPath)
      : window.openshell.viteToggle(workspace);
    void toggle
      .then(async (result) => {
        if (!result.running) setNotice("Vite server stopped");
        await refreshServers();
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : "Could not start the Vite server");
      })
      .finally(() => setViteStarting(false));
  };

  const stopVite = (serverID: string): void => {
    void window.openshell.viteStop(serverID)
      .then(() => refreshServers())
      .catch(() => {});
  };

  const stopAllVite = (): void => {
    void window.openshell.viteStopAll()
      .then(() => refreshServers())
      .catch(() => {});
  };

  const closeTerminal = (id: string): void => {
    void window.openshell.terminalStop(workspace, id).catch(() => {});
    const next = removeTerminal({ terms, activeId }, id);
    writersRef.current.delete(id);
    pendingOutputRef.current.remove(id);
    setTabs(next);
    if (next.terms.length === 0) onClose();
  };

  return (
    <div className="terminal-tray" style={{ "--terminal-height": `${height}px` } as CSSProperties}>
      <div
        className={`terminal-header ${snapped ? "snapped" : ""}`}
        title={snapped ? "Click to expand terminal" : undefined}
        onClick={snapped ? onExpand : undefined}
      >
        {snapped && (
          <span className="terminal-snap-hint" title="Drag up or click to expand">
            <IconChevronUp />
          </span>
        )}
        {terms.map((term) => (
          <span
            key={term.id}
            className={`terminal-tab ${term.id === activeId ? "active" : ""}`}
            onClick={() => setTabs((current) => ({ ...current, activeId: term.id }))}
          >
            {term.name}
            <button
              className="terminal-tab-close"
              title={`Close ${term.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(term.id);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button className="terminal-add" title="New terminal" onClick={() => void createTerminal()}>
          <IconAdd />
        </button>
        <button
          className={`terminal-add${viteServers.length > 0 ? " running" : ""}`}
          title={viteStarting
            ? "Starting the Vite server…"
            : viteServers.length === 1
              ? `${viteServers[0].url} — click to stop, right-click to manage`
              : viteServers.length > 1
                ? `${viteServers.length} Vite servers running — click to toggle this page, right-click to manage`
                : "Serve this workspace with Vite and open it in a browser"}
          disabled={viteStarting}
          data-testid="vite-btn"
          onClick={() => openVite()}
          onContextMenu={(e) => {
            if (viteServers.length === 0) return;
            e.preventDefault();
            setViteMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <IconServer />
        </button>
        {notice && <span className="terminal-notice" title={notice}>{notice}</span>}
        <button className="terminal-close" title="Close the terminal panel (⌥O)" onClick={onClose}>
          <IconChevronDown />
        </button>
      </div>
      <div className={`terminal-body ${snapped ? "hidden" : ""}`}>
        {terms.map((term) => (
          <TermInstance
            key={term.id}
            id={term.id}
            active={term.id === activeId}
            height={height}
            workspace={workspace}
            onRegister={onRegister}
            onUnregister={onUnregister}
          />
        ))}
        {terms.length === 0 && <div className="terminal-empty">No terminal open. Press + to start one.</div>}
      </div>
      {viteMenu && (
        <>
          <div
            className="vite-menu-layer"
            onClick={() => setViteMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setViteMenu(null);
            }}
          />
          <div className="ctx-menu above" style={{ left: viteMenu.x, top: viteMenu.y }} data-testid="vite-menu">
            {viteServers.map((server) => (
              <button
                key={server.id}
                className="ctx-item"
                onClick={() => {
                  setViteMenu(null);
                  stopVite(server.id);
                }}
              >
                Stop {viteServerLabel(server, sessionDirectory)}
              </button>
            ))}
            {viteServers.length > 1 && (
              <button
                className="ctx-item"
                onClick={() => {
                  setViteMenu(null);
                  stopAllVite();
                }}
              >
                Stop all servers
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
