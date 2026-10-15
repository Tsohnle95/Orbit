import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCtxMenu, useStore } from "../store";
import { OrbitMark } from "./OrbitMark";
import { FileIcon } from "./FileIcons";
import { droppedFilePaths, isExternalFileDrag } from "../drop";
import { compactExplorerSelection, movableExplorerPaths } from "../explorer-selection";
import type { TreeEntry } from "@shared/types";
import { SessionsPane } from "./SessionsPane";
import {
  DirNode,
  ExplorerMenu,
  FileNode,
  RowActions,
  TreeNameInput,
  type DragHandlers,
  type SelectionHandlers
} from "./ExplorerTree";

export type SidebarTab = "sessions" | "files";

const EMPTY_HIDDEN_PATHS = new Set<string>();
const EXPLORER_PATHS_MIME = "application/x-orbit-explorer-paths";

function explorerPathsFromDrag(e: React.DragEvent): string[] {
  try {
    const value: unknown = JSON.parse(e.dataTransfer.getData(EXPLORER_PATHS_MIME));
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
  } catch {
    return [];
  }
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
  onOpenTerminal
}: {
  collapsed: boolean;
  onCollapse: (open: boolean) => void;
  onDrag: (e: React.MouseEvent) => void;
  initialTab?: SidebarTab;
  tab?: SidebarTab;
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
    openFile,
    tabs = [],
    expanded,
    pendingCreate,
    commitName,
    cancelPending,
    deleteEntry,
    deleteEntries,
    moveEntry,
    moveEntries,
    startCreate,
    singleFile,
    importPaths,
    dropIntoExplorer,
    openWorkspacePanel,
    hiddenPaths = EMPTY_HIDDEN_PATHS
  } = useStore();
  const { openCtxMenu } = useCtxMenu();
  const [fallbackTab] = useState<SidebarTab>(initialTab);
  const activeTab = tab ?? fallbackTab;
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const dragPathsRef = useRef<string[] | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [externalDrop, setExternalDrop] = useState(false);
  const [blankMoveDrop, setBlankMoveDrop] = useState(false);
  const root = tree[""] ?? [];
  const orderedPanels = panels.length > 0 ? panels : session ? [session] : [];
  const rootName = session?.directory.split("/").filter(Boolean).pop() ?? "workspace";
  const rootOpen = expanded.has("");
  const blankDropImports = Boolean(session && !singleFile && rootOpen);
  const blankDropLabel = blankDropImports ? `Add to ${rootName}` : "Open as new workspace";
  const loadedSessionKey = useRef<string | null>(null);
  const selectedPathSet = new Set(selectedPaths);

  useEffect(() => {
    setSelectedPaths([]);
    selectionAnchor.current = null;
  }, [session?.workspace.id]);

  const focusTree = (): void => {
    treeRef.current?.focus({ preventScroll: true });
  };

  const selection: SelectionHandlers = {
    selectedPaths: selectedPathSet,
    onClick: (event, path, activate) => {
      const additive = event.metaKey || event.ctrlKey;
      if (!event.shiftKey && !additive) {
        setSelectedPaths([path]);
        selectionAnchor.current = path;
        focusTree();
        activate();
        return;
      }

      event.preventDefault();
      focusTree();
      if (event.shiftKey) {
        const visiblePaths = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-entry-path]") ?? [])
          .map((row) => row.dataset.entryPath ?? "");
        const anchor = selectionAnchor.current ?? path;
        const anchorIndex = visiblePaths.indexOf(anchor);
        const pathIndex = visiblePaths.indexOf(path);
        const range = anchorIndex < 0 || pathIndex < 0
          ? [path]
          : visiblePaths.slice(Math.min(anchorIndex, pathIndex), Math.max(anchorIndex, pathIndex) + 1);
        setSelectedPaths((current) => additive
          ? compactExplorerSelection([...current, ...range])
          : range);
      } else {
        setSelectedPaths((current) => current.includes(path)
          ? current.filter((selected) => selected !== path)
          : [...current, path]);
        selectionAnchor.current = path;
      }
    },
    onContextMenu: (event, entry) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedPathSet.has(entry.path)) {
        setSelectedPaths([entry.path]);
        selectionAnchor.current = entry.path;
      }
      openCtxMenu(event.clientX, event.clientY, entry);
    }
  };

  const deleteSelection = (paths: string[]): void => {
    const compact = compactExplorerSelection(paths);
    setSelectedPaths([]);
    selectionAnchor.current = null;
    if (typeof deleteEntries === "function" && compact.length > 1) {
      void deleteEntries(compact);
    } else {
      for (const path of compact) void deleteEntry(path);
    }
  };

  const moveSelection = (paths: string[], destination: string): void => {
    const movable = movableExplorerPaths(paths, destination);
    if (movable.length === 0) return;
    setSelectedPaths([]);
    selectionAnchor.current = null;
    if (movable.length > 1 && typeof moveEntries === "function") {
      void moveEntries(movable, destination);
    } else {
      for (const path of movable) void moveEntry(path, destination);
    }
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      setSelectedPaths([]);
      selectionAnchor.current = null;
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (target.closest("input, textarea, button, [contenteditable='true']") || selectedPaths.length === 0) return;
    event.preventDefault();
    deleteSelection(selectedPaths);
  };

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
    dragPaths,
    dropDir,
    isExternalDrop: isExternalFileDrag,
    onDragStart: (e, path) => {
      if ((e.target as HTMLElement).closest("button")) {
        e.preventDefault();
        return;
      }
      const paths = compactExplorerSelection(selectedPathSet.has(path) ? selectedPaths : [path]);
      e.dataTransfer.setData("text/plain", paths[0] ?? path);
      e.dataTransfer.setData(EXPLORER_PATHS_MIME, JSON.stringify(paths));
      e.dataTransfer.effectAllowed = "move";
      dragPathsRef.current = paths;
      setDragPaths(paths);
    },
    onDragEnd: () => {
      setBlankMoveDrop(false);
      dragPathsRef.current = null;
      setDragPaths(null);
      setDropDir(null);
    },
    onDirDragOver: (e, dir) => {
      setBlankMoveDrop(false);
      if (drag.isExternalDrop(e)) {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropDir(dir);
        setExternalDrop(false);
        return;
      }
      const draggedPaths = dragPathsRef.current ?? dragPaths;
      if (!draggedPaths?.length) return;
      e.stopPropagation();
      if (movableExplorerPaths(draggedPaths, dir).length === 0) {
        setDropDir(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropDir(dir);
    },
    onDirDrop: (e, dir) => {
      setBlankMoveDrop(false);
      e.preventDefault();
      e.stopPropagation();
      const external = droppedFilePaths(e);
      const draggedPaths = dragPathsRef.current ?? dragPaths;
      dragPathsRef.current = null;
      setDragPaths(null);
      setDropDir(null);
      setExternalDrop(false);
      if (external.length > 0) {
        void (dir === "" ? dropIntoExplorer(external) : importPaths(dir, external));
        return;
      }
      const sources = explorerPathsFromDrag(e);
      const selection = sources.length > 0 ? sources : draggedPaths;
      if (!selection?.length) return;
      moveSelection(selection, dir);
    }
  };

  const onTreeDragOver = (e: React.DragEvent): void => {
    const draggedPaths = dragPathsRef.current ?? dragPaths;
    if (!draggedPaths?.length && !drag.isExternalDrop(e)) return;
    if (drag.isExternalDrop(e)) {
      setBlankMoveDrop(false);
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if ((e.target as HTMLElement).closest(".tree-row")) {
        setDropDir(null);
        setExternalDrop(false);
        return;
      }
      setDropDir(null);
      setExternalDrop(true);
      return;
    }
    if ((e.target as HTMLElement).closest(".tree-row")) {
      setBlankMoveDrop(false);
      setDropDir(null);
      return;
    }
    if (!draggedPaths?.length) return;
    if (movableExplorerPaths(draggedPaths, "").length === 0) {
      setBlankMoveDrop(false);
      setDropDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setBlankMoveDrop(true);
    setDropDir("");
  };

  const onTreeDrop = (e: React.DragEvent): void => {
    setBlankMoveDrop(false);
    e.preventDefault();
    const external = droppedFilePaths(e);
    const draggedPaths = dragPathsRef.current ?? dragPaths;
    dragPathsRef.current = null;
    const targetRow = (e.target as HTMLElement).closest(".tree-row");
    if (external.length === 0 && targetRow && !targetRow.hasAttribute("data-explorer-root")) return;
    setDragPaths(null);
    setDropDir(null);
    setExternalDrop(false);
    if (external.length > 0) {
      if (targetRow) return;
      if (blankDropImports) {
        void dropIntoExplorer(external);
        return;
      }
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
    const sources = explorerPathsFromDrag(e);
    const selection = sources.length > 0 ? sources : draggedPaths;
    if (!selection?.length) return;
    moveSelection(selection, "");
  };

  const onTreeDragEnter = (e: React.DragEvent): void => {
    if (drag.isExternalDrop(e)) setExternalDrop(!(e.target as HTMLElement).closest(".tree-row"));
  };

  const onTreeDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setBlankMoveDrop(false);
      setExternalDrop(false);
      setDropDir(null);
    }
  };

  const dropSpace = <div className={`tree-drop-space ${externalDrop || blankMoveDrop ? "active" : ""}`}>
    {(externalDrop || blankMoveDrop) && <span className="tree-drop-label">
      {externalDrop ? blankDropLabel : `Move into ${session?.directory.split("/").filter(Boolean).pop() ?? "workspace"}`}
    </span>}
  </div>;

  if (collapsed) {
    return null;
  }

  if (singleFile && session) {
    const name = singleFile.split("/").pop() ?? singleFile;
    const singleFileUnsaved = tabs.some((tab) => tab.path === singleFile && tab.dirty);
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
             className="tree"
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
              className={`tree-row file active${singleFileUnsaved ? " unsaved" : ""}`}
              onClick={() => void openFile(singleFile)}
              title={singleFile}
            >
              <FileIcon name={name} isDir={false} />
              <span className="tree-name">{name}</span>
              {singleFileUnsaved && <span className="tree-unsaved-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
            </div>
            <div className={`tree-drop-space ${externalDrop ? "active" : ""}`}>
              {externalDrop && <span className="tree-drop-label">Open as new workspace</span>}
            </div>
          </div>
        </div>
        <ExplorerMenu onOpenTerminal={onOpenTerminal} />
      </div>
    );
  }

  return (
    <div className="sidebar files-sidebar">
      {activeTab === "sessions" ? (
        <SessionsPane />
      ) : (
        <>
          <div className="section-trigger files-brand-header">
            <span className="sidebar-brand">Mira</span>
          </div>

       <div
         className={`section-trigger with-actions explorer-trigger ${rootOpen ? "open" : ""} ${dropDir === "" ? "drop-target" : ""}`}
         data-explorer-root=""
         title={session?.directory}
         onDragOver={(e) => drag.onDirDragOver(e, "")}
         onDrop={(e) => drag.onDirDrop(e, "")}
         onDragLeave={(e) => {
           if (drag.isExternalDrop(e)) setDropDir(null);
         }}
         onContextMenu={(e) => {
           e.preventDefault();
           e.stopPropagation();
           openCtxMenu(e.clientX, e.clientY, { path: "", type: "directory" });
         }}
       >
         <button
           className="section-chevron-button explorer-chevron"
           aria-label="Toggle workspace files"
           aria-expanded={rootOpen}
           onClick={() => {
             if (session) void toggleDir("");
           }}
         >
           <i className={`codicon codicon-chevron-right ${rootOpen ? "open" : ""}`} aria-hidden="true" />
         </button>
         <button
           className={`section-toggle ${rootOpen ? "open" : ""}`}
           aria-expanded={rootOpen}
           onClick={() => {
             if (session) void toggleDir("");
           }}
         >
           <span className="explorer-root-name">{rootName}</span>
         </button>
         {session && <RowActions entry={{ path: "", type: "directory" }} allowFile allowDir />}
       </div>
        <div className="sidebar-section explorer">
          <div
             ref={treeRef}
             className="tree"
             tabIndex={0}
             onKeyDown={onTreeKeyDown}
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openCtxMenu(event.clientX, event.clientY, { path: "", type: "directory" }, panel.id);
                }}
                title={panel.directory}
              >
                <span className="tree-chevron empty" aria-hidden="true" />
                <span className="tree-name">{panel.directory.split("/").filter(Boolean).pop() ?? "workspace"}</span>
              </div>
            ) : (
              <div key={panel.id} className={`tree-workspace ${rootOpen ? "expanded" : ""}`}>
                {(!session || (root.length === 0 && !rootOpen)) && <div className="tree-empty">Loading…</div>}
                {rootOpen && root.filter((child) => !hiddenPaths.has(child.path)).map((child) =>
                  child.type === "directory" ? (
                    <DirNode key={child.path} entry={child} depth={0} drag={drag} hiddenPaths={hiddenPaths} selection={selection} />
                  ) : (
                    <FileNode key={child.path} entry={child} depth={0} drag={drag} selection={selection} />
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
                {blankDropImports && dropSpace}
              </div>
            ))}
            {!blankDropImports && dropSpace}
          </div>
        </div>
        </>
      )}
      <ExplorerMenu onOpenTerminal={onOpenTerminal} selectedPaths={selectedPaths} onDeleteSelection={deleteSelection} />
    </div>
  );
}
