import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentFileState } from "@shared/types";
import { useStore } from "../store";
import { OpenCodeFile } from "./OpenCodeFile";
import { FileIcon } from "./FileIcons";
import { IconChevronRight, IconClose } from "./icons";
import {
  buildChangeTreeRows,
  changeDiffStats,
  changeList,
  isHiddenChangePath,
  type ChangeFile,
  type ChangeTreeRow
} from "../changes-view-model";

// The editor-area Changes review surface: a directory tree of observed file
// changes beside stacked Pierre diffs, in the style of the reference app's
// changes panel. Diffs mount only as their section approaches the viewport so a
// large change set stays cheap.

const VIEWPORT_MARGIN = "600px 0px";

function useNearViewport(): { ref: React.RefObject<HTMLDivElement | null>; visible: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: VIEWPORT_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

function changeStatusLabel(state: AgentFileState): string {
  if (state.deleted) return "Deleted";
  if (state.baseline.kind !== "known") return "Observed";
  return "Modified";
}

function ChangeStats({ state }: { state: AgentFileState }): ReactNode {
  const stats = useMemo(() => changeDiffStats(state), [state]);
  if (!stats) return null;
  return (
    <span className="change-stats" aria-label={`+${stats.additions} -${stats.deletions}`}>
      <span className="change-additions">+{stats.additions}</span>
      <span className="change-deletions">-{stats.deletions}</span>
    </span>
  );
}

function ChangeDiff({ file, wrap }: { file: ChangeFile; wrap: boolean }): ReactNode {
  const { ref, visible } = useNearViewport();
  const state = file.state;
  const available = state.baseline.kind === "known";
  if (!available) {
    return (
      <div className="change-section-body" ref={ref}>
        <p className="change-section-unavailable">
          Pre-change content wasn't observed for this file, so a diff isn't available.
        </p>
      </div>
    );
  }
  const before = state.baseline.kind === "known" ? state.baseline.content : "";
  const after = state.deleted ? "" : state.content ?? "";
  return (
    <div className="change-section-body" ref={ref}>
      {visible
        ? <OpenCodeFile mode="diff" file={file.path} before={before} after={after} overflow={wrap ? "wrap" : "scroll"} />
        : <div className="change-section-pending" aria-hidden="true" />}
    </div>
  );
}

function ChangeSection({ file, open, active, wrap, onToggle, onOpenInEditor, onDismiss, onRegister }: {
  file: ChangeFile;
  open: boolean;
  active: boolean;
  wrap: boolean;
  onToggle: () => void;
  onOpenInEditor: () => void;
  onDismiss: () => void;
  onRegister: (element: HTMLDivElement | null) => void;
}): ReactNode {
  return (
    <section className={`change-section${active ? " active" : ""}`} data-change-path={file.path} ref={onRegister}>
      <header className="change-section-header">
        <button type="button" className="change-section-toggle" aria-expanded={open} onClick={onToggle}>
          <span className={`change-section-chevron${open ? " open" : ""}`}><IconChevronRight /></span>
          <FileIcon name={file.name} isDir={false} />
          <span className="change-section-path">
            {file.directory && <span className="change-section-directory">{file.directory}/</span>}
            <span
              className="change-section-name"
              title="Open in editor"
              onClick={(event) => { event.stopPropagation(); onOpenInEditor(); }}
            >{file.name}</span>
          </span>
        </button>
        <span className="change-section-status">{changeStatusLabel(file.state)}</span>
        <ChangeStats state={file.state} />
        <button
          type="button"
          className="change-section-action"
          aria-label={`Clear ${file.path}`}
          title="Clear this change"
          onClick={onDismiss}
        ><IconClose /></button>
      </header>
      {open && <ChangeDiff file={file} wrap={wrap} />}
    </section>
  );
}

function ChangesTree({ rows, collapsed, selected, onToggleDirectory, onSelect }: {
  rows: ChangeTreeRow[];
  collapsed: ReadonlySet<string>;
  selected: string | null;
  onToggleDirectory: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactNode {
  return (
    <nav className="changes-tree" aria-label="Changed files">
      {rows.map((row) => {
        const indent = { paddingInlineStart: `${8 + row.depth * 12}px` };
        return row.kind === "directory"
          ? <button
              key={row.key}
              type="button"
              className="changes-tree-row directory"
              style={indent}
              aria-expanded={!collapsed.has(row.path)}
              onClick={() => onToggleDirectory(row.path)}
            >
              <span className={`changes-tree-chevron${collapsed.has(row.path) ? "" : " open"}`}><IconChevronRight /></span>
              <span className="changes-tree-label">{row.label}</span>
            </button>
          : <button
              key={row.key}
              type="button"
              className={`changes-tree-row file${selected === row.path ? " active" : ""}`}
              style={indent}
              title={row.path}
              onClick={() => onSelect(row.path)}
            >
              <FileIcon name={row.label} isDir={false} />
              <span className="changes-tree-label">{row.label}</span>
            </button>;
      })}
    </nav>
  );
}

function ChangesToolbar({ count, allCollapsed, wrap, onToggleAll, onToggleWrap, onClearAll, onClose }: {
  count: number;
  allCollapsed: boolean;
  wrap: boolean;
  onToggleAll: () => void;
  onToggleWrap: () => void;
  onClearAll: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="changes-toolbar">
      <span className="changes-title">Changes</span>
      <span className="changes-count">{count}</span>
      <span className="changes-spacer" />
      {count > 0 && <>
        <button type="button" className="changes-action" onClick={onToggleAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
        <button
          type="button"
          className={`changes-action${wrap ? " on" : ""}`}
          aria-pressed={wrap}
          title={wrap ? "Disable line wrap" : "Enable line wrap"}
          onClick={onToggleWrap}
        >Wrap</button>
        <button type="button" className="changes-action danger" onClick={onClearAll}>Clear all</button>
      </>}
      <button type="button" className="changes-action" aria-label="Close changes view" title="Close changes view" onClick={onClose}><IconClose /></button>
    </div>
  );
}

export function ChangesView({ onClose }: { onClose: () => void }): ReactNode {
  const { session, agentFiles, hiddenPaths, dismissChange, dismissChanges, openFile } = useStore();
  const files = useMemo(() => {
    const visible = changeList(agentFiles);
    // Paths detached from this workspace, or owned by a nested workspace that is
    // open separately, are hidden in the Explorer and must not resurface here.
    return hiddenPaths.size === 0 ? visible : visible.filter((file) => !isHiddenChangePath(file.path, hiddenPaths));
  }, [agentFiles, hiddenPaths]);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(() => new Set());
  const [wrap, setWrap] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const sections = useRef(new Map<string, HTMLDivElement>());
  const rows = useMemo(() => buildChangeTreeRows(files, collapsedDirs), [files, collapsedDirs]);
  const allCollapsed = files.length > 0 && files.every((file) => collapsedSections.has(file.path));

  const registerSection = useCallback((path: string, element: HTMLDivElement | null): void => {
    if (element) sections.current.set(path, element);
    else sections.current.delete(path);
  }, []);

  const toggleSet = (set: ReadonlySet<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const reveal = (path: string): void => {
    setSelected(path);
    setCollapsedSections((current) => current.has(path) ? toggleSet(current, path) : current);
    requestAnimationFrame(() => sections.current.get(path)?.scrollIntoView({ block: "start" }));
  };

  const openInEditor = (path: string): void => {
    onClose();
    void openFile(path);
  };

  if (files.length === 0) {
    return (
      <section className="changes-view" aria-label="Changes">
        <ChangesToolbar count={0} allCollapsed={false} wrap={wrap}
          onToggleAll={() => {}} onToggleWrap={() => setWrap((value) => !value)} onClearAll={dismissChanges} onClose={onClose} />
        <div className="changes-empty">
          {session ? "No changes yet. Files the agent edits appear here." : "Open a workspace to review changes."}
        </div>
      </section>
    );
  }

  return (
    <section className="changes-view" aria-label="Changes">
      <ChangesToolbar
        count={files.length}
        allCollapsed={allCollapsed}
        wrap={wrap}
        onToggleAll={() => setCollapsedSections(allCollapsed ? new Set() : new Set(files.map((file) => file.path)))}
        onToggleWrap={() => setWrap((value) => !value)}
        onClearAll={() => { dismissChanges(); setSelected(null); }}
        onClose={onClose}
      />
      <div className="changes-body">
        <ChangesTree
          rows={rows}
          collapsed={collapsedDirs}
          selected={selected}
          onToggleDirectory={(path) => setCollapsedDirs((current) => toggleSet(current, path))}
          onSelect={reveal}
        />
        <div className="changes-diffs">
          {files.map((file) => (
            <ChangeSection
              key={file.path}
              file={file}
              open={!collapsedSections.has(file.path)}
              active={selected === file.path}
              wrap={wrap}
              onToggle={() => setCollapsedSections((current) => toggleSet(current, file.path))}
              onOpenInEditor={() => openInEditor(file.path)}
              onDismiss={() => dismissChange(file.path)}
              onRegister={(element) => registerSection(file.path, element)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
