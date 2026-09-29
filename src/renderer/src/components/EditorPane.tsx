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
import { IconChevronRight, IconClose } from "./icons";

const EDITOR_OPTIONS = {
  fontSize: 13,
  fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  minimap: { enabled: false },
  automaticLayout: true,
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

function SplitRightIcon(): ReactNode {
  return (
    <svg className="os-icon editor-split-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.4" />
      <path d="M8 2.5v11M10.25 6.1l2 1.9-2 1.9" />
    </svg>
  );
}

function TabBar({
  tabs,
  activePath,
  ariaLabel,
  disabledPath,
  onSelect,
  onClose,
  actions
}: {
  tabs: Tab[];
  activePath: string | null;
  ariaLabel: string;
  disabledPath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  actions: ReactNode;
}): ReactNode {
  const { setTabMode } = useStore();

  return (
    <div className="tabbar">
      <div className="tab-list" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const visibleInOtherGroup = tab.path === disabledPath;
        const hasDiff =
          tab.baseline?.kind === "known" && !tab.deleted && tab.baseline.content !== tab.content;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            aria-disabled={visibleInOtherGroup || undefined}
            className={"tab" + (active ? " active" : "") + (visibleInOtherGroup ? " visible-in-other-group" : "")}
            onClick={() => { if (!visibleInOtherGroup) onSelect(tab.path); }}
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
                    if (visibleInOtherGroup) return;
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
  const { setTabMode } = useStore();
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

function EditorWithSave({ tab }: { tab: Tab }): ReactNode {
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveTab(tab.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveTab, tab.path]);

  const language = useMemo(() => languageForPath(tab.path), [tab.path]);
  const w3cFile = useMemo(() => /\.(?:html?|css)$/i.test(tab.path), [tab.path]);
  const diffAvailable = tab.baseline?.kind === "known";
  const mode = tab.mode === "diff" && !diffAvailable ? "edit" : tab.mode;
  const options = EDITOR_OPTIONS;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const tabContent = tab.content;
  const tabPath = tab.path;
  const tabContentRef = useRef(tabContent);
  tabContentRef.current = tabContent;

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
  }, [tabPath]);

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

  useEffect(() => () => unregisterEditor(tab.path), [tab.path]);

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
          onMount={(ed) => registerEditor(tab.path, ed.getModifiedEditor())}
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

type EditorGroupID = "primary" | "secondary";

function EditorGroup({
  id,
  tabs,
  activePath,
  otherGroupPath,
  directory,
  focused,
  splitEnabled,
  onSelect,
  onCloseTab,
  onActivate,
  onToggleSplit,
  onCloseSplit
}: {
  id: EditorGroupID;
  tabs: Tab[];
  activePath: string | null;
  otherGroupPath: string | null;
  directory: string | undefined;
  focused: boolean;
  splitEnabled: boolean;
  onSelect: (path: string) => void;
  onCloseTab: (path: string) => void;
  onActivate: (id: EditorGroupID) => void;
  onToggleSplit: () => void;
  onCloseSplit: () => void;
}): ReactNode {
  const activeTab = tabs.find((tab) => tab.path === activePath);
  const title = id === "primary" ? "Primary editor" : "Secondary editor";
  const actions = id === "primary"
    ? <button
        type="button"
        className="editor-group-action"
        aria-label={splitEnabled ? "Close split editor" : "Split editor right"}
        aria-pressed={splitEnabled}
        title={splitEnabled ? "Close split editor" : "Split editor right"}
        onClick={onToggleSplit}
      ><SplitRightIcon /></button>
    : <button
        type="button"
        className="editor-group-action"
        aria-label="Close secondary editor group"
        title="Close secondary editor group"
        onClick={onCloseSplit}
      ><IconClose /></button>;

  return (
    <section
      className={"editor-group" + (id === "primary" ? " editor-group-primary" : " editor-group-secondary") + (focused ? " editor-group-focused" : "")}
      data-editor-group={id}
      role="region"
      aria-label={title}
      onMouseDownCapture={() => onActivate(id)}
      onFocusCapture={() => onActivate(id)}
    >
      <TabBar
        tabs={tabs}
        activePath={activePath}
        ariaLabel={title + " tabs"}
        disabledPath={otherGroupPath}
        onSelect={onSelect}
        onClose={onCloseTab}
        actions={actions}
      />
      {activeTab
        ? <>
            <BreadcrumbBar tab={activeTab} directory={directory} />
            <EditorWithSave key={id + ":" + activeTab.path} tab={activeTab} />
          </>
        : <div className="editor-group-empty">
            <OrbitMark size={30} />
            <strong>Empty editor group</strong>
            <span>Open a file from the Explorer to show it here.</span>
          </div>}
    </section>
  );
}

export function EditorPane(): ReactNode {
  const { tabs, activePath, openPaths, session, setActive, closeTab } = useStore();
  const [externalDrag, setExternalDrag] = useState(false);
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [primaryPath, setPrimaryPath] = useState<string | null>(activePath ?? tabs[0]?.path ?? null);
  const [secondaryPath, setSecondaryPath] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<EditorGroupID>("primary");
  const activePathRef = useRef(activePath);
  const workspaceID = session?.workspace.id ?? null;
  const workspaceRef = useRef(workspaceID);

  useEffect(() => {
    if (workspaceRef.current === workspaceID) return;
    workspaceRef.current = workspaceID;
    activePathRef.current = activePath;
    setPrimaryPath(activePath ?? tabs[0]?.path ?? null);
    setSecondaryPath(null);
    setSplitEnabled(false);
    setActiveGroup("primary");
  }, [activePath, tabs, workspaceID]);

  useEffect(() => {
    if (activePathRef.current === activePath) return;
    activePathRef.current = activePath;
    if (activeGroup === "primary") setPrimaryPath(activePath);
    else setSecondaryPath(activePath);
  }, [activePath, activeGroup]);

  useEffect(() => {
    const paths = new Set(tabs.map((tab) => tab.path));
    const nextPrimary = primaryPath && paths.has(primaryPath)
      ? primaryPath
      : activePath && paths.has(activePath) && activePath !== secondaryPath
        ? activePath
        : tabs.find((tab) => tab.path !== secondaryPath)?.path ?? null;
    if (nextPrimary !== primaryPath) setPrimaryPath(nextPrimary);

    const nextSecondary = splitEnabled
      ? secondaryPath && paths.has(secondaryPath) && secondaryPath !== nextPrimary
        ? secondaryPath
        : tabs.find((tab) => tab.path !== nextPrimary)?.path ?? null
      : null;
    if (nextSecondary !== secondaryPath) setSecondaryPath(nextSecondary);
  }, [activePath, primaryPath, secondaryPath, splitEnabled, tabs]);

  useEffect(() => {
    if (!splitEnabled || !primaryPath || primaryPath !== secondaryPath) return;
    if (activeGroup === "primary") setSecondaryPath(tabs.find((tab) => tab.path !== primaryPath)?.path ?? null);
    else setPrimaryPath(tabs.find((tab) => tab.path !== secondaryPath)?.path ?? null);
  }, [activeGroup, primaryPath, secondaryPath, splitEnabled, tabs]);

  useEffect(() => {
    if (tabs.length > 0 || !splitEnabled) return;
    setSplitEnabled(false);
    setSecondaryPath(null);
    setActiveGroup("primary");
  }, [splitEnabled, tabs.length]);

  const selectPath = (group: EditorGroupID, path: string): void => {
    if (group === "primary") {
      setPrimaryPath(path);
      if (path === secondaryPath) setSecondaryPath(primaryPath);
    } else {
      setSecondaryPath(path);
      if (path === primaryPath) setPrimaryPath(secondaryPath);
    }
    setActiveGroup(group);
    if (path !== activePath) setActive(path);
  };

  const activateGroup = (group: EditorGroupID): void => {
    setActiveGroup(group);
    const path = group === "primary" ? primaryPath : secondaryPath;
    if (path && path !== activePath) setActive(path);
  };

  const toggleSplit = (): void => {
    if (splitEnabled) {
      setSplitEnabled(false);
      setSecondaryPath(null);
      setActiveGroup("primary");
      if (primaryPath && primaryPath !== activePath) setActive(primaryPath);
      return;
    }
    const nextPrimary = primaryPath ?? activePath ?? tabs[0]?.path ?? null;
    const nextSecondary = tabs.find((tab) => tab.path !== nextPrimary)?.path ?? null;
    setPrimaryPath(nextPrimary);
    setSecondaryPath(nextSecondary);
    setSplitEnabled(true);
    setActiveGroup("secondary");
    if (nextSecondary && nextSecondary !== activePath) setActive(nextSecondary);
  };

  const onDragOver = (e: React.DragEvent): void => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setExternalDrag(true);
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent): void => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setExternalDrag(false);
    const group = e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-editor-group]")?.dataset.editorGroup
      : undefined;
    if (group === "primary" || group === "secondary") setActiveGroup(group);
    const files = droppedFilePaths(e);
    if (files.length > 0) void openPaths(files);
  };
  const onDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExternalDrag(false);
  };

  return (
    <div
      className={"editor-pane" + (externalDrag ? " external-drop-active" : "")}
      onDragOverCapture={onDragOver}
      onDropCapture={onDrop}
      onDragEnterCapture={onDragOver}
      onDragLeaveCapture={onDragLeave}
    >
      {tabs.length === 0 && !splitEnabled ? (
        <div className="editor-empty">
          <div className="editor-empty-icon">
            <OrbitMark size={40} />
          </div>
          {session ? (
            <p>Select a file from the explorer to view or edit it.</p>
          ) : (
            <>
              <p>No workspace open.</p>
              <p className="editor-empty-sub">Open a workspace from the explorer to get started.</p>
            </>
          )}
        </div>
      ) : (
        <div className={"editor-groups" + (splitEnabled ? " editor-groups-split" : "")}>
          <EditorGroup
            id="primary"
            tabs={tabs}
            activePath={primaryPath}
            otherGroupPath={splitEnabled ? secondaryPath : null}
            directory={session?.directory}
            focused={activeGroup === "primary"}
            splitEnabled={splitEnabled}
            onSelect={(path) => selectPath("primary", path)}
            onCloseTab={closeTab}
            onActivate={activateGroup}
            onToggleSplit={toggleSplit}
            onCloseSplit={toggleSplit}
          />
          {splitEnabled && <EditorGroup
            id="secondary"
            tabs={tabs}
            activePath={secondaryPath}
            otherGroupPath={primaryPath}
            directory={session?.directory}
            focused={activeGroup === "secondary"}
            splitEnabled
            onSelect={(path) => selectPath("secondary", path)}
            onCloseTab={closeTab}
            onActivate={activateGroup}
            onToggleSplit={toggleSplit}
            onCloseSplit={toggleSplit}
          />}
        </div>
      )}
    </div>
  );
}
