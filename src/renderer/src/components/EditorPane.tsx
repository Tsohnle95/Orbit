import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { languageForPath } from "../monaco";
import { wireEmmetKeys } from "../emmet-keys";
import { wireEditorNavigationKeys } from "../editor-navigation";
import { clearW3cMarkers } from "../w3c-validation";
import { useStore } from "../store";
import { OrbitMark } from "./OrbitMark";
import { FileIcon } from "./FileIcons";
import { useTheme } from "../theme";
import { registerEditor, unregisterEditor } from "../reveal";
import { droppedFilePaths, isExternalFileDrag } from "../drop";
import type { Tab } from "@shared/types";
import type { EditorStatus } from "./editor-status";
import { IconChevronRight, IconClose } from "./icons";

const EDITOR_OPTIONS = {
  fontSize: 13,
  fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  minimap: { enabled: false },
  automaticLayout: true,
  fixedOverflowWidgets: true,
  overflowWidgetsDomNode: document.body,
  quickSuggestions: { other: true, comments: false, strings: true },
  quickSuggestionsDelay: 25,
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: "currentDocument" as const,
  tabCompletion: "on" as const,
  acceptSuggestionOnEnter: "on" as const,
  folding: true,
  glyphMargin: false,
  showFoldingControls: "mouseover" as const,
  foldingHighlight: true,
  tabSize: 2,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: "smooth" as const,
  padding: { top: 10, bottom: 10 },
  renderWhitespace: "none" as const,
  scrollbar: { verticalScrollbarSize: 3, horizontalScrollbarSize: 3 },
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 0,
  wordWrap: "on" as const
};
const ignoreEditorStatus = (): void => {};

function SplitRightIcon(): ReactNode {
  return (
    <svg className="os-icon editor-split-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.4" />
      <path d="M8 2.5v11M10.25 6.1l2 1.9-2 1.9" />
    </svg>
  );
}

function TabBar({
  group,
  tabs,
  activePath,
  ariaLabel,
  onSelect,
  onClose,
  onMoveTab,
  actions
}: {
  group: EditorGroupID;
  tabs: Tab[];
  activePath: string | null;
  ariaLabel: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMoveTab: (path: string, destination: EditorGroupID, source: EditorGroupID) => void;
  actions: ReactNode;
}): ReactNode {
  const { setTabMode } = useStore();

  return (
    <div className="tabbar">
      <div className="tab-list" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const hasDiff =
          tab.baseline?.kind === "known" && !tab.deleted && tab.baseline.content !== tab.content;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            className={"tab" + (active ? " active" : "")}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(EDITOR_TAB_MIME, JSON.stringify({ path: tab.path, source: group }));
            }}
            onClick={() => onSelect(tab.path)}
            title={tab.path}
          >
            <span className="tab-file-icon"><FileIcon name={tab.name} isDir={false} /></span>
            <span className="tab-name">
              {tab.dirty && <span className="tab-dirty" />}
              {tab.name}
            </span>
            <span className="tab-actions">
              {hasDiff && (
                <span
                  className="tab-diff-badge"
                  title="Toggle diff view"
                  aria-label={`Toggle diff for ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabMode(tab.path, active && tab.mode === "diff" ? "edit" : "diff");
                  }}
                >
                  ⇄
                </span>
              )}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.name}`}
                title={`Close ${tab.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.path);
                }}
              >×</button>
            </span>
          </div>
        );
      })}
      </div>
      <div className="editor-group-actions">{actions}</div>
    </div>
  );
}

function BreadcrumbBar({ tab, directory }: { tab: Tab; directory: string | undefined }): ReactNode {
  const { setTabMode, saveTab } = useStore();
  const root = directory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
  const segments = tab.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const diffAvailable = tab.baseline?.kind === "known";
  const diffUnknown = tab.baseline?.kind === "unknown";
  const mode = tab.mode === "diff" && !diffAvailable ? "edit" : tab.mode;

  return (
    <div className="editor-breadcrumbs">
      <nav className="editor-breadcrumb-path" aria-label="File path">
        <span className="breadcrumb-workspace">{root}</span>
        {segments.map((segment, index) => (
          <span className="breadcrumb-segment" key={`${index}:${segment}`}>
            <IconChevronRight />
            <span aria-current={index === segments.length - 1 ? "page" : undefined}>{segment}</span>
          </span>
        ))}
      </nav>
      <div className="editor-breadcrumb-actions">
        {tab.dirty && <span className="editor-dirty">unsaved</span>}
        {tab.dirty && !tab.conflict && (
          <button
            type="button"
            className="toolbar-btn"
            aria-label={`Save ${tab.name}`}
            title="Save this file"
            onClick={() => void saveTab(tab.path)}
          >Save</button>
        )}
        {tab.stale && <span className="editor-stale">changed on disk</span>}
        {tab.deleted && <span className="editor-deleted">deleted on disk</span>}
        {diffAvailable && (
          <>
            <button className={`toolbar-btn ${mode === "edit" ? "on" : ""}`} onClick={() => setTabMode(tab.path, "edit")}>Edit</button>
            <button className={`toolbar-btn ${mode === "diff" ? "on" : ""}`} onClick={() => setTabMode(tab.path, "diff")}>Diff</button>
          </>
        )}
        {diffUnknown && <button className="toolbar-btn" disabled title="Pre-change content was not observed">Diff unavailable</button>}
      </div>
    </div>
  );
}

function EditorWithSave({
  tab,
  focused,
  onStatusChange
}: {
  tab: Tab;
  focused: boolean;
  onStatusChange: (status: EditorStatus) => void;
}): ReactNode {
  const { theme } = useTheme();
  const {
    editContent,
    saveTab,
    reloadTab,
    overwriteTab,
    mergeTab
  } = useStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (focused && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveTab(tab.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, saveTab, tab.path]);

  const language = useMemo(() => languageForPath(tab.path), [tab.path]);
  const w3cFile = useMemo(() => /\.(?:html?|css)$/i.test(tab.path), [tab.path]);
  const diffAvailable = tab.baseline?.kind === "known";
  const mode = tab.mode === "diff" && !diffAvailable ? "edit" : tab.mode;
  const options = EDITOR_OPTIONS;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const cursorListenerRef = useRef<{ dispose: () => void } | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const tabContent = tab.content;
  const tabPath = tab.path;
  const tabContentRef = useRef(tabContent);
  tabContentRef.current = tabContent;

  const publishStatus = useCallback((ed: editor.IStandaloneCodeEditor | null = editorRef.current): void => {
    if (!focusedRef.current || !ed) return;
    const position = ed.getPosition();
    const model = ed.getModel();
    if (!position || !model) return;
    const modelOptions = model.getOptions();
    onStatusChange({
      path: tabPath,
      lineNumber: position.lineNumber,
      column: position.column,
      tabSize: modelOptions.tabSize,
      insertSpaces: modelOptions.insertSpaces
    });
  }, [onStatusChange, tabPath]);

  const watchCursor = useCallback((ed: editor.IStandaloneCodeEditor): void => {
    cursorListenerRef.current?.dispose();
    cursorListenerRef.current = ed.onDidChangeCursorPosition(() => publishStatus(ed));
    publishStatus(ed);
  }, [publishStatus]);

  const handleChange = useCallback((value: string | undefined): void => {
    if (value !== undefined) editContent(tabPath, value);
  }, [editContent, tabPath]);

  const handleMount = useCallback((ed: editor.IStandaloneCodeEditor): void => {
    editorRef.current = ed;
    registerEditor(tabPath, ed);
    wireEmmetKeys(ed);
    wireEditorNavigationKeys(ed);
    const model = ed.getModel();
    const latest = tabContentRef.current;
    if (model && model.getValue() !== latest) {
      model.pushEditOperations([], [{
        range: model.getFullModelRange(),
        text: latest
      }], () => null);
    }
    watchCursor(ed);
  }, [tabPath, watchCursor]);

  useEffect(() => {
    if (focused) publishStatus();
  }, [focused, publishStatus]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || mode !== "edit") return;
    const model = ed.getModel();
    if (!model || model.getValue() === tabContent) return;
    const selections = ed.getSelections();
    const scrollTop = ed.getScrollTop();
    const scrollLeft = ed.getScrollLeft();
    model.pushEditOperations(selections ?? [], [{
      range: model.getFullModelRange(),
      text: tabContent
    }], () => null);
    if (selections) {
      try {
        ed.setSelections(selections);
      } catch {
        // selection may be out of bounds after an external edit
      }
    }
    ed.setScrollTop(scrollTop);
    ed.setScrollLeft(scrollLeft);
  }, [tabContent, mode]);

  useEffect(() => {
    if (!w3cFile) return;
    clearW3cMarkers(tab.path);
    return () => clearW3cMarkers(tab.path);
  }, [tab.content, tab.path, w3cFile]);

  useEffect(() => () => {
    cursorListenerRef.current?.dispose();
    cursorListenerRef.current = null;
    unregisterEditor(tabPath);
  }, [tabPath]);

  return (
    <div className="editor-wrap">
      {tab.deleted && (
        <div className="deleted-banner">
          This file was deleted from disk while you were viewing it.
        </div>
      )}

      {tab.conflict && (
        <div className="conflict-banner">
          <span>
            {tab.conflict.deleted
              ? "This file was deleted outside Orbit. Your edits are safe and saving is paused."
              : "This file changed outside Orbit. Your edits are safe and saving is paused."}
          </span>
          <div className="conflict-actions">
            <button onClick={() => reloadTab(tab.path)}>Reload disk version</button>
            {tab.conflict.resolution === "pending" ? (
              <button onClick={() => mergeTab(tab.path)}>Keep editing to merge</button>
            ) : (
              <button onClick={() => void overwriteTab(tab.path)}>Save merged content</button>
            )}
            <button className="danger" onClick={() => void overwriteTab(tab.path)}>Overwrite disk</button>
          </div>
        </div>
      )}

      {mode === "diff" ? (
        <DiffEditor
          theme={`orbit-${theme}`}
          language={language}
          original={tab.baseline?.kind === "known" ? tab.baseline.content : ""}
          modified={tab.content}
          onMount={(ed) => {
            const modifiedEditor = ed.getModifiedEditor();
            editorRef.current = modifiedEditor;
            registerEditor(tab.path, modifiedEditor);
            watchCursor(modifiedEditor);
          }}
          options={{
            ...options,
            readOnly: true,
            renderSideBySide: false,
            ignoreTrimWhitespace: false,
            enableSplitViewResizing: false,
            renderOverviewRuler: false,
            overviewRulerBorder: false
          }}
        />
      ) : (
        <Editor
          theme={`orbit-${theme}`}
          language={language}
          path={tab.path}
          defaultValue={tab.content}
          onMount={handleMount}
          options={options}
          onChange={handleChange}
        />
      )}
    </div>
  );
}

type EditorGroupID = "primary" | "secondary" | "tertiary" | "quaternary";
const EDITOR_GROUP_IDS: EditorGroupID[] = ["primary", "secondary", "tertiary", "quaternary"];
const EDITOR_TAB_MIME = "application/x-orbit-editor-tab";

interface EditorTabTransfer {
  path: string;
  source: EditorGroupID;
}

interface EditorGroupState {
  id: EditorGroupID;
  paths: string[];
  activePath: string | null;
}

interface EditorLayoutState {
  groups: EditorGroupState[];
  activeGroup: EditorGroupID;
}

function isEditorGroupID(value: unknown): value is EditorGroupID {
  return EDITOR_GROUP_IDS.includes(value as EditorGroupID);
}

function readEditorTabTransfer(transfer: DataTransfer): EditorTabTransfer | null {
  try {
    const value = JSON.parse(transfer.getData(EDITOR_TAB_MIME)) as Partial<EditorTabTransfer>;
    if (typeof value.path !== "string" || !isEditorGroupID(value.source)) return null;
    return { path: value.path, source: value.source };
  } catch {
    return null;
  }
}

function sameGroupLayout(left: EditorGroupState[], right: EditorGroupState[]): boolean {
  return left.length === right.length && left.every((group, index) => {
    const other = right[index];
    return other !== undefined && group.id === other.id && group.activePath === other.activePath &&
      group.paths.length === other.paths.length && group.paths.every((path, pathIndex) => path === other.paths[pathIndex]);
  });
}

function editorGroupTitle(id: EditorGroupID, index: number): string {
  if (id === "primary") return "Primary editor";
  if (id === "secondary") return "Secondary editor";
  return `Editor group ${index + 1}`;
}

function EditorGroup({
  id,
  index,
  groupCount,
  tabs,
  activePath,
  directory,
  focused,
  onStatusChange,
  onSelect,
  onCloseTab,
  onMoveTab,
  onActivate,
  onSplit,
  onCloseGroup
}: {
  id: EditorGroupID;
  index: number;
  groupCount: number;
  tabs: Tab[];
  activePath: string | null;
  directory: string | undefined;
  focused: boolean;
  onStatusChange: (status: EditorStatus) => void;
  onSelect: (path: string) => void;
  onCloseTab: (path: string) => void;
  onMoveTab: (path: string, destination: EditorGroupID, source: EditorGroupID) => void;
  onActivate: (id: EditorGroupID) => void;
  onSplit: (id: EditorGroupID) => void;
  onCloseGroup: (id: EditorGroupID) => void;
}): ReactNode {
  const [tabDragOver, setTabDragOver] = useState(false);
  const activeTab = tabs.find((tab) => tab.path === activePath);
  const title = editorGroupTitle(id, index);
  const splitLabel = id === "primary" ? "Split editor right" : `Split editor group ${index + 1} right`;
  const closeLabel = id === "secondary" ? "Close secondary editor group" : `Close editor group ${index + 1}`;
  const actions = <>
    <button
      type="button"
      className="editor-group-action"
      aria-label={splitLabel}
      title={groupCount >= EDITOR_GROUP_IDS.length ? "Orbit supports up to four editor groups" : splitLabel}
      disabled={groupCount >= EDITOR_GROUP_IDS.length}
      onClick={() => onSplit(id)}
    ><SplitRightIcon /></button>
    {index > 0 && <button
      type="button"
      className="editor-group-action"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={() => onCloseGroup(id)}
    ><IconClose /></button>}
  </>;
  const onTabDragOver = (event: React.DragEvent): void => {
    if (!Array.from(event.dataTransfer.types).includes(EDITOR_TAB_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setTabDragOver(true);
  };
  const onTabDrop = (event: React.DragEvent): void => {
    const transfer = readEditorTabTransfer(event.dataTransfer);
    if (!transfer) return;
    event.preventDefault();
    event.stopPropagation();
    setTabDragOver(false);
    onMoveTab(transfer.path, id, transfer.source);
  };

  return (
    <section
      className={`editor-group editor-group-${id}${focused ? " editor-group-focused" : ""}${tabDragOver ? " editor-group-drop-target" : ""}`}
      data-editor-group={id}
      role="region"
      aria-label={title}
      onMouseDownCapture={() => onActivate(id)}
      onFocusCapture={() => onActivate(id)}
      onDragOver={onTabDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTabDragOver(false);
      }}
      onDrop={onTabDrop}
    >
      <TabBar
        group={id}
        tabs={tabs}
        activePath={activePath}
        ariaLabel={title + " tabs"}
        onSelect={onSelect}
        onClose={onCloseTab}
        onMoveTab={onMoveTab}
        actions={actions}
      />
      {activeTab
        ? <>
            <BreadcrumbBar tab={activeTab} directory={directory} />
            <EditorWithSave key={id + ":" + activeTab.path} tab={activeTab} focused={focused} onStatusChange={onStatusChange} />
          </>
        : <div className="editor-group-empty">
            <OrbitMark size={30} />
            <strong>Empty editor group</strong>
            <span>Open a file from the Explorer to show it here.</span>
          </div>}
    </section>
  );
}

export function EditorPane({ onStatusChange = ignoreEditorStatus }: { onStatusChange?: (status: EditorStatus) => void }): ReactNode {
  const { tabs, activePath, openPaths, session, setActive, closeTab } = useStore();
  const workspaceID = session?.workspace.id ?? null;
  const [externalDrag, setExternalDrag] = useState(false);
  const [groups, setGroups] = useState<EditorGroupState[]>(() => [{
    id: "primary",
    paths: tabs.map((tab) => tab.path),
    activePath: activePath ?? tabs[0]?.path ?? null
  }]);
  const [activeGroup, setActiveGroup] = useState<EditorGroupID>("primary");
  const activeGroupRef = useRef<EditorGroupID>("primary");
  const [groupWorkspaceID, setGroupWorkspaceID] = useState(workspaceID);
  const layoutsByWorkspaceRef = useRef(new Map<string, EditorLayoutState>());
  const activePathRef = useRef(activePath);

  const focusGroup = useCallback((group: EditorGroupID): void => {
    activeGroupRef.current = group;
    setActiveGroup(group);
  }, []);

  useEffect(() => {
    if (groupWorkspaceID === workspaceID) return;
    const paths = tabs.map((tab) => tab.path);
    layoutsByWorkspaceRef.current.set(groupWorkspaceID ?? "", {
      groups: groups.map((group) => ({ ...group, paths: [...group.paths] })),
      activeGroup: activeGroupRef.current
    });
    const savedLayout = layoutsByWorkspaceRef.current.get(workspaceID ?? "");
    setGroupWorkspaceID(workspaceID);
    activePathRef.current = activePath;
    setGroups(savedLayout?.groups ?? [{ id: "primary", paths, activePath: activePath ?? paths[0] ?? null }]);
    focusGroup(savedLayout?.activeGroup ?? "primary");
  }, [activeGroup, activePath, focusGroup, groupWorkspaceID, groups, tabs, workspaceID]);

  useEffect(() => {
    if (groupWorkspaceID !== workspaceID || activePathRef.current === activePath) return;
    activePathRef.current = activePath;
    const owner = activePath ? groups.find((group) => group.paths.includes(activePath)) : undefined;
    const destination = owner?.id ?? activeGroupRef.current;
    setGroups((current) => current.map((group) => group.id === destination
      ? { ...group, activePath }
      : group));
    focusGroup(destination);
  }, [activePath, focusGroup, groupWorkspaceID, groups, workspaceID]);

  useEffect(() => {
    if (groupWorkspaceID !== workspaceID) return;
    const livePaths = new Set(tabs.map((tab) => tab.path));
    const next = groups.map((group) => ({ ...group, paths: group.paths.filter((path) => livePaths.has(path)) }));
    const assigned = new Set(next.flatMap((group) => group.paths));
    const unassigned = tabs.map((tab) => tab.path).filter((path) => !assigned.has(path));
    const destinationIndex = Math.max(0, next.findIndex((group) => group.id === activeGroupRef.current));
    next[destinationIndex] = {
      ...next[destinationIndex],
      paths: [...next[destinationIndex]!.paths, ...unassigned]
    };
    for (const group of next) {
      if (activePath && group.paths.includes(activePath)) {
        group.activePath = activePath;
        continue;
      }
      if (group.activePath && group.paths.includes(group.activePath)) continue;
      group.activePath = group.paths[0] ?? null;
    }
    if (!sameGroupLayout(groups, next)) setGroups(next);
  }, [activePath, groupWorkspaceID, groups, tabs, workspaceID]);

  const selectPath = (groupID: EditorGroupID, path: string): void => {
    setGroups((current) => current.map((group) => group.id === groupID ? { ...group, activePath: path } : group));
    focusGroup(groupID);
    if (path !== activePath) setActive(path);
  };

  const activateGroup = (groupID: EditorGroupID): void => {
    focusGroup(groupID);
    const path = groups.find((group) => group.id === groupID)?.activePath;
    if (path && path !== activePath) setActive(path);
  };

  const moveTabToGroup = (path: string, destination: EditorGroupID, source: EditorGroupID): void => {
    if (!tabs.some((tab) => tab.path === path) || source === destination) return;
    const sourceGroup = groups.find((group) => group.id === source);
    const destinationGroup = groups.find((group) => group.id === destination);
    if (!sourceGroup?.paths.includes(path) || destinationGroup?.paths.includes(path)) return;
    setGroups((current) => current.map((group) => {
      if (group.id === source) {
        const paths = group.paths.filter((item) => item !== path);
        return { ...group, paths, activePath: group.activePath === path ? paths[0] ?? null : group.activePath };
      }
      if (group.id === destination) return { ...group, paths: [...group.paths, path], activePath: path };
      return group;
    }));
    focusGroup(destination);
    if (path !== activePath) setActive(path);
  };

  const splitGroupAfter = (sourceID: EditorGroupID): void => {
    if (groups.length >= EDITOR_GROUP_IDS.length) return;
    const sourceIndex = groups.findIndex((group) => group.id === sourceID);
    if (sourceIndex < 0) return;
    const source = groups[sourceIndex]!;
    const newID = EDITOR_GROUP_IDS.find((id) => !groups.some((group) => group.id === id));
    if (!newID) return;
    const movePath = source.paths.find((path) => path !== source.activePath) ?? null;
    const next = groups.map((group) => {
      if (group.id !== sourceID || !movePath) return group;
      const paths = group.paths.filter((path) => path !== movePath);
      return { ...group, paths, activePath: group.activePath ?? paths[0] ?? null };
    });
    const newGroup: EditorGroupState = { id: newID, paths: movePath ? [movePath] : [], activePath: movePath };
    next.splice(sourceIndex + 1, 0, newGroup);
    setGroups(next);
    focusGroup(newID);
    if (movePath && movePath !== activePath) setActive(movePath);
  };

  const closeGroup = (groupID: EditorGroupID): void => {
    if (groups.length <= 1) return;
    const index = groups.findIndex((group) => group.id === groupID);
    if (index <= 0) return;
    const closing = groups[index]!;
    const neighborIndex = index - 1;
    const next = groups.filter((group) => group.id !== groupID);
    const neighbor = next[neighborIndex]!;
    const paths = [...neighbor.paths, ...closing.paths.filter((path) => !neighbor.paths.includes(path))];
    next[neighborIndex] = { ...neighbor, paths };
    setGroups(next);
    focusGroup(neighbor.id);
    if (neighbor.activePath && neighbor.activePath !== activePath) setActive(neighbor.activePath);
  };

  const onDragOver = (event: React.DragEvent): void => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setExternalDrag(true);
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: React.DragEvent): void => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setExternalDrag(false);
    const group = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-editor-group]")?.dataset.editorGroup
      : undefined;
    if (isEditorGroupID(group)) activateGroup(group);
    const files = droppedFilePaths(event);
    if (files.length > 0) void openPaths(files);
  };
  const onDragLeave = (event: React.DragEvent): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExternalDrag(false);
  };

  return (
    <div
      className={`editor-pane${externalDrag ? " external-drop-active" : ""}`}
      onDragOverCapture={onDragOver}
      onDropCapture={onDrop}
      onDragEnterCapture={onDragOver}
      onDragLeaveCapture={onDragLeave}
    >
      {tabs.length === 0 && groups.length === 1 ? (
        <div className="editor-empty">
          <div className="editor-empty-icon"><OrbitMark size={40} /></div>
          {session ? <p>Select a file from the explorer to view or edit it.</p> : <>
            <p>No workspace open.</p>
            <p className="editor-empty-sub">Open a workspace from the explorer to get started.</p>
          </>}
        </div>
      ) : (
        <div className={`editor-groups editor-groups-count-${groups.length}`} data-group-count={groups.length}>
          {groups.map((group, index) => <EditorGroup
            key={group.id}
            id={group.id}
            index={index}
            groupCount={groups.length}
            tabs={tabs.filter((tab) => group.paths.includes(tab.path))}
            activePath={group.activePath}
            directory={session?.directory}
            focused={activeGroup === group.id}
            onStatusChange={onStatusChange}
            onSelect={(path) => selectPath(group.id, path)}
            onCloseTab={closeTab}
            onMoveTab={moveTabToGroup}
            onActivate={activateGroup}
            onSplit={splitGroupAfter}
            onCloseGroup={closeGroup}
          />)}
        </div>
      )}
    </div>
  );
}
