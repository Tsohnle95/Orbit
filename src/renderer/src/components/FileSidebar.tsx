import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCtxMenu, useStore } from "../store";
import { OrbitMark } from "./OrbitMark";
import { ChevronIcon, EllipsisIcon, FileIcon, FilePlusIcon, FolderPlusIcon, PencilIcon, PlusIcon, TrashIcon } from "./FileIcons";
import { droppedFilePaths, isExternalFileDrag } from "../drop";
import type { TreeEntry } from "@shared/types";
import { SessionsPane } from "./SessionsPane";

export type SidebarTab = "sessions" | "files";

const EMPTY_HIDDEN_PATHS = new Set<string>();

function canDrop(source: string, target: string): boolean {
  if (!source || source === target) return false;
  const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  if (parent === target) return false;
  return !target.startsWith(`${source}/`);
}

interface DragHandlers {
  dragPath: string | null;
  dropDir: string | null;
  isExternalDrop: (e: React.DragEvent) => boolean;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDragEnd: () => void;
  onDirDragOver: (e: React.DragEvent, dir: string) => void;
  onDirDrop: (e: React.DragEvent, dir: string) => void;
}

function RowActions({ entry, allowFile = false, allowDir = false }: { entry: TreeEntry; allowFile?: boolean; allowDir?: boolean }): ReactNode {
  const { startCreate } = useStore();
  const { openCtxMenu } = useCtxMenu();
  const parent =
    entry.type === "directory"
      ? entry.path
      : entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "";
  const menu = (e: Pick<React.MouseEvent, "clientX" | "clientY" | "stopPropagation">): void => {
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, entry);
  };
  return (
    <span className="tree-row-actions">
      {allowFile && (
        <button
          type="button"
          className="tree-row-action"
          title="New File"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            startCreate(parent, "file");
          }}
        >
          <FilePlusIcon />
        </button>
      )}
      {allowDir && (
        <button
          type="button"
          className="tree-row-action"
          title="New Folder"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            startCreate(parent, "dir");
          }}
        >
          <FolderPlusIcon />
        </button>
      )}
      <button
        type="button"
        className="tree-row-action"
        title="More actions…"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menu(e);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <EllipsisIcon />
      </button>
    </span>
  );
}

function DirNode({
  entry,
  depth,
  drag,
  hiddenPaths
}: {
  entry: TreeEntry;
  depth: number;
  drag: DragHandlers;
  hiddenPaths: Set<string>;
}): ReactNode {
  const {
    expanded,
    tree,
    toggleDir,
    agentFiles,
    pendingRename,
    pendingCreate,
    commitName,
    cancelPending
  } = useStore();
  const { openCtxMenu } = useCtxMenu();
  const isOpen = expanded.has(entry.path);
  const hasChanges = entry.path.split("/").some((_, i) => {
    const prefix = entry.path.split("/").slice(0, i + 1).join("/");
    return agentFiles.has(prefix);
  });

  if (pendingRename?.path === entry.path) {
    return (
      <TreeNameInput
        initial={entry.path.split("/").pop() ?? ""}
        isDir
        onCommit={(v) => void commitName(v)}
        onCancel={cancelPending}
      />
    );
  }

  return (
    <div>
      <div
        className={`tree-row dir ${isOpen ? "open" : ""} ${drag.dropDir === entry.path ? "drop-target" : ""}`}
        draggable
        onClick={() => void toggleDir(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          openCtxMenu(e.clientX, e.clientY, entry);
        }}
        onDragStart={(e) => drag.onDragStart(e, entry.path)}
        onDragEnd={drag.onDragEnd}
        onDragOver={(e) => drag.onDirDragOver(e, entry.path)}
        onDrop={(e) => drag.onDirDrop(e, entry.path)}
      >
        <FileIcon name={entry.path.split("/").pop() ?? ""} isDir open={isOpen} />
        <span className="tree-name">{entry.path.split("/").pop()}</span>
        {hasChanges && <span className="tree-badge" />}
        <RowActions entry={entry} allowFile allowDir />
      </div>
      {isOpen && (
        <div className="tree-children">
          {(tree[entry.path] ?? []).filter((child) => !hiddenPaths.has(child.path)).map((child) =>
            child.type === "directory" ? (
              <DirNode key={child.path} entry={child} depth={depth + 1} drag={drag} hiddenPaths={hiddenPaths} />
            ) : (
              <FileNode key={child.path} entry={child} depth={depth + 1} drag={drag} />
            )
          )}
          {pendingCreate?.parent === entry.path && (
            <TreeNameInput
              initial={pendingCreate.kind === "file" ? "untitled.txt" : "untitled folder"}
              isDir={pendingCreate.kind === "dir"}
              onCommit={(v) => void commitName(v)}
              onCancel={cancelPending}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({
  entry,
  depth,
  drag
}: {
  entry: TreeEntry;
  depth: number;
  drag: DragHandlers;
}): ReactNode {
  const { openFile, activePath, agentFiles, pendingRename, commitName, cancelPending } =
    useStore();
  const { openCtxMenu } = useCtxMenu();
  const name = entry.path.split("/").pop() ?? entry.path;
  const changed = agentFiles.has(entry.path);
  const active = activePath === entry.path;

  if (pendingRename?.path === entry.path) {
    return (
      <TreeNameInput
        initial={name}
        isDir={false}
        onCommit={(v) => void commitName(v)}
        onCancel={cancelPending}
      />
    );
  }

  return (
    <div
      className={`tree-row file ${active ? "active" : ""}`}
      draggable
      onClick={() => void openFile(entry.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        openCtxMenu(e.clientX, e.clientY, entry);
      }}
      onDragStart={(e) => drag.onDragStart(e, entry.path)}
      onDragEnd={drag.onDragEnd}
      title={entry.path}
    >
      <FileIcon name={name} isDir={false} />
      <span className="tree-name">{name}</span>
      {changed && <span className="tree-badge changed" />}
      <RowActions entry={entry} />
    </div>
  );
}

function TreeNameInput({
  initial,
  isDir,
  onCommit,
  onCancel
}: {
  initial: string;
  isDir: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="tree-row tree-input-row">
      <FileIcon name={value || initial} isDir={isDir} />
      <input
        ref={inputRef}
        className="tree-input"
        value={value}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(value)}
      />
    </div>
  );
}

function ExplorerMenu({ onOpenTerminal }: { onOpenTerminal?: (directory: string) => void }): ReactNode {
  const { session, startCreate, startRename, revealInFileManager, deleteEntry, removeFromWorkspace, closePanel } = useStore();
  const { ctxMenu, closeCtxMenu } = useCtxMenu();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeCtxMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeCtxMenu();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu, closeCtxMenu]);

  if (!ctxMenu) return null;
  const target = ctxMenu.target;
  const workspaceRoot = target?.type === "directory" && target.path === "";
  const parent = target
    ? target.type === "directory"
      ? target.path
      : target.path.includes("/")
        ? target.path.slice(0, target.path.lastIndexOf("/"))
        : ""
    : "";
  const left = Math.min(ctxMenu.x, window.innerWidth - 190);
  const top = Math.min(ctxMenu.y, window.innerHeight - 150);

  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={{ left, top }}>
      <button className="ctx-item" onClick={() => { closeCtxMenu(); onOpenTerminal?.(parent); }}>
        Open in Integrated Terminal
      </button>
      <button className="ctx-item" onClick={() => startCreate(parent, "file")}>
        <FilePlusIcon />
        New File…
      </button>
      <button className="ctx-item" onClick={() => startCreate(parent, "dir")}>
        <FolderPlusIcon />
        New Folder…
      </button>
      {target && (
        <button className="ctx-item" onClick={() => void revealInFileManager(target.path)}>
          Reveal in File Manager
        </button>
      )}
      {workspaceRoot && session && (
        <button className="ctx-item" onClick={() => { closeCtxMenu(); closePanel(session.id); }}>
          Remove Workspace
        </button>
      )}
      {target && !workspaceRoot && (
        <>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => startRename(target.path)}>
            <PencilIcon />
            Rename…
          </button>
          <button className="ctx-item" onClick={() => removeFromWorkspace(target.path)}>
            Remove from Workspace
          </button>
          <button className="ctx-item danger" onClick={() => void deleteEntry(target.path)}>
            <TrashIcon />
            Delete
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

function useChangesDrag(initial: number): [number, (e: React.MouseEvent) => void] {
  const [height, setHeight] = useState(initial);
  const startRef = useRef<{ y: number; height: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    startRef.current = { y: e.clientY, height };
    const move = (ev: MouseEvent): void => {
      if (!startRef.current) return;
      const dy = ev.clientY - startRef.current.y;
      setHeight(Math.min(520, Math.max(90, startRef.current.height + dy)));
    };
    const up = (): void => {
      startRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return [height, onMouseDown];
}

function NoWorkspaceEmpty(): ReactNode {
  const { selectFolder } = useStore();
  return (
    <div className="tree-empty-workspace">
      <OrbitMark size={36} />
      <p className="tree-empty-workspace-text">No workspace open</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void selectFolder()}
      >
        Open a workspace
      </button>
    </div>
  );
}

export function FileSidebar({
  collapsed,
  onCollapse,
  onDrag,
  initialTab = "files",
  tab,
  onTabChange,
  onOpenTerminal
}: {
  collapsed: boolean;
  onCollapse: (open: boolean) => void;
  onDrag: (e: React.MouseEvent) => void;
  initialTab?: SidebarTab;
  tab?: SidebarTab;
  onTabChange?: (tab: SidebarTab) => void;
  onOpenTerminal?: (directory: string) => void;
}): ReactNode {
  void onCollapse;
  const {
    session,
    panels = [],
    focusSession,
    tree,
    toggleDir,
    ensureRootOpen,
    agentFiles,
    openFile,
    expanded,
    pendingCreate,
    commitName,
    cancelPending,
    moveEntry,
    startCreate,
    singleFile,
    importPaths,
    dropIntoExplorer,
    openWorkspacePanel,
    dismissChange,
    dismissChanges,
    hiddenPaths = EMPTY_HIDDEN_PATHS
  } = useStore();
  const { openCtxMenu } = useCtxMenu();
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesMenu, setChangesMenu] = useState<{ x: number; y: number; path: string | null } | null>(null);
  const changesMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!changesMenu) return;
    const onDown = (e: PointerEvent): void => {
      if (changesMenuRef.current && !changesMenuRef.current.contains(e.target as Node)) setChangesMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [changesMenu]);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [fallbackTab, setFallbackTab] = useState<SidebarTab>(initialTab);
  const activeTab = tab ?? fallbackTab;
  const switchTab = (next: SidebarTab): void => {
    if (!tab) setFallbackTab(next);
    onTabChange?.(next);
  };
  const [changesH, changesDrag] = useChangesDrag(200);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [externalDrop, setExternalDrop] = useState(false);
  const root = tree[""] ?? [];
  const orderedPanels = panels.length > 0 ? panels : session ? [session] : [];
  const loadedSessionKey = useRef<string | null>(null);

  useEffect(() => {
    const key = session ? `${session.id}::${session.directory}` : null;
    if (key && loadedSessionKey.current !== key) {
      loadedSessionKey.current = key;
      void ensureRootOpen();
    } else if (!key) {
      loadedSessionKey.current = null;
    }
  }, [session, ensureRootOpen]);

  const drag: DragHandlers = {
    dragPath,
    dropDir,
    isExternalDrop: isExternalFileDrag,
    onDragStart: (e, path) => {
      if ((e.target as HTMLElement).closest("button")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.effectAllowed = "move";
      setDragPath(path);
    },
    onDragEnd: () => {
      setDragPath(null);
      setDropDir(null);
    },
    onDirDragOver: (e, dir) => {
      if (drag.isExternalDrop(e)) {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropDir(dir);
        setExternalDrop(false);
        return;
      }
      if (!dragPath) return;
      e.stopPropagation();
      if (!canDrop(dragPath, dir)) {
        setDropDir(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropDir(dir);
    },
    onDirDrop: (e, dir) => {
      e.preventDefault();
      const external = droppedFilePaths(e);
      setDragPath(null);
      setDropDir(null);
      setExternalDrop(false);
      if (external.length > 0) {
        void (dir === "" ? dropIntoExplorer(external) : importPaths(dir, external));
        return;
      }
      const source = dragPath;
      if (!source || !canDrop(source, dir)) return;
      void moveEntry(source, dir);
    }
  };

  const onTreeDragOver = (e: React.DragEvent): void => {
    if (!dragPath && !drag.isExternalDrop(e)) return;
    if (drag.isExternalDrop(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if ((e.target as HTMLElement).closest(".tree-row")) {
        setExternalDrop(false);
        return;
      }
      setDropDir(null);
      setExternalDrop(true);
      return;
    }
    if ((e.target as HTMLElement).closest(".tree-row")) {
      setDropDir(null);
      return;
    }
    if (!dragPath) return;
    if (!canDrop(dragPath, "")) {
      setDropDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropDir("");
  };

  const onTreeDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const external = droppedFilePaths(e);
    if (external.length === 0 && (e.target as HTMLElement).closest(".tree-row")) return;
    setDragPath(null);
    setDropDir(null);
    setExternalDrop(false);
    if (external.length > 0) {
      void Promise.all(external.map(async (path) => {
        const kind = await window.openshell.externalKind(path).catch(() => ({ kind: "missing" as const }));
        if (kind.kind === "directory") {
          await openWorkspacePanel(path);
        } else if (kind.kind === "file") {
          await dropIntoExplorer([path]);
        }
      }));
      return;
    }
    const source = dragPath;
    if (!source || !canDrop(source, "")) return;
    void moveEntry(source, "");
  };

  const onTreeDragEnter = (e: React.DragEvent): void => {
    if (drag.isExternalDrop(e)) setExternalDrop(!(e.target as HTMLElement).closest(".tree-row"));
  };

  const onTreeDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setExternalDrop(false);
      setDropDir(null);
    }
  };

  const changes = [...agentFiles.entries()];

  if (collapsed) {
    return null;
  }

  if (singleFile && session) {
    const name = singleFile.split("/").pop() ?? singleFile;
    return (
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title" title={`${session.directory}/${singleFile}`}>
            <span className="sidebar-title-dot" aria-hidden />
            <span className="sidebar-title-name">{name}</span>
          </span>
        </div>
        <div className="section-trigger">
          <span className="section-toggle open">FILE</span>
        </div>
        <div className="sidebar-section explorer">
          <div
             className={`tree ${externalDrop ? "external-drop-active" : ""}`}
             style={{ "--workspace-drop-top": `${orderedPanels.length * 26 + 2}px` } as CSSProperties}
             onDragEnter={onTreeDragEnter}
             onDragOver={onTreeDragOver}
             onDrop={onTreeDrop}
             onDragLeave={onTreeDragLeave}
            onContextMenu={(e) => {
              e.preventDefault();
              openCtxMenu(e.clientX, e.clientY, null);
            }}
          >
            <div
              className="tree-row file active"
              onClick={() => void openFile(singleFile)}
              title={singleFile}
            >
              <FileIcon name={name} isDir={false} />
              <span className="tree-name">{name}</span>
            </div>
          </div>
        </div>
        <ExplorerMenu onOpenTerminal={onOpenTerminal} />
      </div>
    );
  }

  return (
    <div className="sidebar files-sidebar">
      <div className="side-tabs" role="tablist" aria-label="Sidebar panels">
        <button
          className={`side-tab ${activeTab === "sessions" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "sessions"}
          onClick={() => switchTab("sessions")}
        >
          Sessions
        </button>
        <button
          className={`side-tab ${activeTab === "files" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "files"}
          onClick={() => switchTab("files")}
        >
          Files
        </button>
      </div>

      {activeTab === "sessions" ? (
        <SessionsPane />
      ) : (
        <>
          <div className="section-trigger">
            <button
              className={`section-toggle ${changesOpen ? "open" : ""}`}
              aria-expanded={changesOpen}
              onClick={() => setChangesOpen((o) => !o)}
              onContextMenu={(e) => {
                e.preventDefault();
                setChangesMenu({ x: e.clientX, y: e.clientY, path: null });
              }}
            >
              <span>CHANGES</span>
              <span className="sidebar-count changes-count push">{changes.length}</span>
              <span className="section-chevron">
                <ChevronIcon open={changesOpen} />
              </span>
            </button>
          </div>
      {changesOpen && (
        <>
          <div
            className="sidebar-section changes"
            style={{ "--changes-height": `${changesH}px` } as CSSProperties}
          >
            <div className="changes-list">
              {changes.length === 0 && <div className="tree-empty">No changes yet</div>}
              {changes.map(([path, state]) => {
                const name = path.split("/").pop() ?? path;
                const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                return (
                  <div
                    key={path}
                    className={`tree-row file ${state.deleted ? "deleted" : ""}`}
                    onClick={() => void openFile(path, { mode: "diff" })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setChangesMenu({ x: e.clientX, y: e.clientY, path });
                    }}
                    title={state.baseline.kind === "unknown" ? `${path} · pre-change content unavailable` : path}
                  >
                    <FileIcon name={name} isDir={false} />
                    <span className="tree-name">
                      {name}
                      {dir && <span className="tree-dir-suffix"> · {dir}</span>}
                    </span>
                    <span className={`tree-meta ${state.deleted ? "deleted" : ""}`}>
                      {state.deleted ? "deleted" : state.baseline.kind === "unknown" ? "observed" : "modified"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="sidebar-vdivider" onMouseDown={changesDrag} title="Drag to resize changes panel" />
        </>
      )}
      {changesMenu && createPortal(
        <div
          className="ctx-menu"
          ref={changesMenuRef}
          style={{
            left: Math.min(changesMenu.x, window.innerWidth - 190),
            top: Math.min(changesMenu.y, window.innerHeight - 60)
          }}
          data-testid="changes-menu"
        >
          {changesMenu.path ? (
            <button
              className="ctx-item"
              onClick={() => {
                dismissChange(changesMenu.path!);
                setChangesMenu(null);
              }}
            >
              Clear
            </button>
          ) : (
            <button
              className="ctx-item"
              onClick={() => {
                dismissChanges();
                setChangesMenu(null);
              }}
            >
              Clear all changes
            </button>
          )}
        </div>,
        document.body
      )}

       <div className={`section-trigger with-actions ${explorerOpen ? "open" : ""}`}>
        <button
          className={`section-toggle ${explorerOpen ? "open" : ""}`}
          aria-expanded={explorerOpen}
          onClick={() => setExplorerOpen((o) => !o)}
         >
           <span>EXPLORER</span>
         </button>
         <button
           className="section-chevron-button"
           aria-label="Toggle Explorer"
           aria-expanded={explorerOpen}
           onClick={() => setExplorerOpen((o) => !o)}
         >
           <ChevronIcon open={explorerOpen} />
         </button>
       </div>
      {explorerOpen && (
        <div className="sidebar-section explorer">
          <div
             className={`tree ${dropDir === "" && !externalDrop ? "drop-root" : ""} ${externalDrop ? "external-drop-active" : ""}`}
             style={{ "--workspace-drop-top": `${orderedPanels.length * 26 + 2}px` } as CSSProperties}
             onDragEnter={onTreeDragEnter}
             onDragOver={onTreeDragOver}
             onDrop={onTreeDrop}
             onDragLeave={onTreeDragLeave}
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest(".tree-row")) return;
              e.preventDefault();
              openCtxMenu(e.clientX, e.clientY, null);
            }}
          >
            {orderedPanels.length === 0 && (
              session ? <div className="tree-empty">Loading…</div> : <NoWorkspaceEmpty />
            )}
            {orderedPanels.map((panel, index) => panel.id !== session?.id ? (
              <div
                key={panel.id}
                 className={`tree-row dir workspace-root ${index > 0 ? "workspace-root-secondary" : ""}`}
                onClick={() => focusSession(panel.id)}
                title={panel.directory}
              >
                <FileIcon name={panel.directory} isDir />
                <span className="tree-name">{panel.directory.split("/").filter(Boolean).pop() ?? "workspace"}</span>
              </div>
            ) : (
              <Fragment key={panel.id}>
                {(!session || (root.length === 0 && !expanded.has(""))) && <div className="tree-empty">Loading…</div>}
                <div
                    className={`tree-row dir workspace-root ${index > 0 ? "workspace-root-secondary" : ""} ${expanded.has("") ? "open" : ""} ${dropDir === "" ? "drop-target" : ""}`}
                  onClick={() => void toggleDir("")}
                  onDragOver={(e) => drag.onDirDragOver(e, "")}
                   onDrop={onTreeDrop}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openCtxMenu(e.clientX, e.clientY, { path: "", type: "directory" });
                  }}
                  onDragLeave={(e) => {
                    if (drag.isExternalDrop(e)) setDropDir(null);
                  }}
                  title={panel.directory}
                >
                  <FileIcon name={panel.directory} isDir open={expanded.has("")} />
                  <span className="tree-name">{panel.directory.split("/").filter(Boolean).pop() ?? "workspace"}</span>
                  <RowActions entry={{ path: "", type: "directory" }} allowFile allowDir />
                </div>
                {expanded.has("") && root.filter((child) => !hiddenPaths.has(child.path)).map((child) =>
                  child.type === "directory" ? (
                    <DirNode key={child.path} entry={child} depth={0} drag={drag} hiddenPaths={hiddenPaths} />
                  ) : (
                    <FileNode key={child.path} entry={child} depth={0} drag={drag} />
                  )
                )}
                {pendingCreate?.parent === "" && (
                  <TreeNameInput
                    initial={pendingCreate.kind === "file" ? "untitled.txt" : "untitled folder"}
                    isDir={pendingCreate.kind === "dir"}
                    onCommit={(v) => void commitName(v)}
                    onCancel={cancelPending}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}
        </>
      )}
      <ExplorerMenu onOpenTerminal={onOpenTerminal} />
    </div>
  );
}
