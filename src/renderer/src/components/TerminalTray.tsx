import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store";
import { useOptionalTheme } from "../theme";
import { IconAdd, IconChevronDown, IconChevronUp, IconServer } from "./icons";
import type { WorkspaceIdentity } from "@shared/types";
import { PendingTerminalOutput, removeTerminal, terminalDirectoryCommand, type TerminalTabs } from "../terminal-state";

const THEME = {
  background: "#121317",
  foreground: "#e8eaef",
  cursor: "#d97757",
  cursorAccent: "#0d0e11",
  selectionBackground: "#2e4d78",
  black: "#17181d",
  red: "#f16d6b",
  green: "#4cc38a",
  yellow: "#e0af68",
  blue: "#d97757",
  magenta: "#c99ff2",
  cyan: "#6fc3df",
  white: "#e8eaef",
  brightBlack: "#626b78",
  brightRed: "#ff8b85",
  brightGreen: "#6fd8a8",
  brightYellow: "#eec27f",
  brightBlue: "#e68a68",
  brightMagenta: "#dcb8ff",
  brightCyan: "#8fd8ef",
  brightWhite: "#ffffff"
};

// Same palette as the embedded agent TUI; the transparent background lets the
// window's glass show through so the kitty tray matches the app background.
const KITTY_THEME = {
  background: "rgba(2, 2, 4, 0)",
  foreground: "#f4f4fa",
  cursor: "#00a2ce",
  cursorAccent: "#020204",
  selectionBackground: "#2e4d78",
  black: "#020204",
  red: "#ff4b67",
  green: "#5bd69a",
  yellow: "#e0a85a",
  blue: "#00a2ce",
  magenta: "#c99ff2",
  cyan: "#6fc3df",
  white: "#f4f4fa",
  brightBlack: "#a6a9b8",
  brightRed: "#ff8b85",
  brightGreen: "#82e8b4",
  brightYellow: "#f0c780",
  brightBlue: "#25b8dd",
  brightMagenta: "#dcb8ff",
  brightCyan: "#8fd8ef",
  brightWhite: "#ffffff"
};

interface TermInstanceProps {
  id: string;
  active: boolean;
  height: number;
  workspace: WorkspaceIdentity;
  onRegister: (id: string, writer: (data: string) => void) => void;
  onUnregister: (id: string) => void;
}

function TermInstance({ id, active, height, workspace, onRegister, onUnregister }: TermInstanceProps): ReactNode {
  const theme = useOptionalTheme()?.theme ?? "original";
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
      allowTransparency: theme === "kitty",
      theme: theme === "kitty" ? KITTY_THEME : THEME
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
    term.options.theme = theme === "kitty" ? KITTY_THEME : THEME;
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
  const [viteUrl, setViteUrl] = useState<string | null>(null);
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
    setViteUrl(null);
    setViteMenu(null);
  }, [workspace.id]);

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
    const start = entryPath
      ? window.openshell.viteStart(workspace, entryPath)
      : window.openshell.viteStart(workspace);
    void start
      .then((preview) => setViteUrl(preview.url))
      .catch((error) => {
        setViteUrl(null);
        setNotice(error instanceof Error ? error.message : "Could not start the Vite server");
      })
      .finally(() => setViteStarting(false));
  };

  const stopVite = (): void => {
    if (!viteUrl) return;
    void window.openshell.viteStop(workspace)
      .then(() => setViteUrl(null))
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
          className={`terminal-add${viteUrl ? " running" : ""}`}
          title={viteStarting ? "Starting the Vite server…" : viteUrl ? `${viteUrl} — right-click to stop the server` : "Serve this workspace with Vite and open it in a browser"}
          disabled={viteStarting}
          data-testid="vite-btn"
          onClick={() => openVite()}
          onContextMenu={(e) => {
            if (!viteUrl) return;
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
            <button
              className="ctx-item"
              onClick={() => {
                setViteMenu(null);
                stopVite();
              }}
            >
              Stop Vite server
            </button>
          </div>
        </>
      )}
    </div>
  );
}
