import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { FileIcon } from "./FileIcons";
import { IconAdd, IconGlobe } from "./icons";
import { browserTabLabel, type BrowserTab } from "../use-browser-tabs";
import type { Tab } from "@shared/types";
import { isEditorGroupID, type EditorGroupID } from "./editor-groups";

export const EDITOR_TAB_MIME = "application/x-orbit-editor-tab";

export interface EditorTabTransfer {
  path: string;
  source: EditorGroupID;
}

export function readEditorTabTransfer(transfer: DataTransfer): EditorTabTransfer | null {
  try {
    const value = JSON.parse(transfer.getData(EDITOR_TAB_MIME)) as Partial<EditorTabTransfer>;
    if (typeof value.path !== "string" || !isEditorGroupID(value.source)) return null;
    return { path: value.path, source: value.source };
  } catch {
    return null;
  }
}

// Tab sizing mirrors the reference strip: tabs share the available width,
// compressing from TAB_MAX_W down to TAB_MIN_W; past that the remainder moves
// into the overflow menu button.
const TAB_MIN_W = 90;
const TAB_OVERFLOW_W = 30;

export function stripLayout(listWidth: number, count: number, reservedWidth = 0, browserCount = 0): { visibleCount: number; hiddenCount: number } {
  const width = Math.max(0, listWidth - reservedWidth);
  const overflows = count * TAB_MIN_W + browserCount * 120 > width;
  const available = Math.max(0, width - (overflows ? TAB_OVERFLOW_W : 0));
  const files = Math.min(count, Math.floor(available / TAB_MIN_W));
  const browsers = Math.min(browserCount, Math.floor(Math.max(0, available - files * TAB_MIN_W) / 120));
  return { visibleCount: files + browsers, hiddenCount: count + browserCount - files - browsers };
}

function TabChip({
  tab,
  active,
  group,
  onSelect,
  onClose
}: {
  tab: Tab;
  active: boolean;
  group: EditorGroupID;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}): ReactNode {
  const { setTabMode } = useStore();
  const hasDiff =
    tab.baseline?.kind === "known" && !tab.deleted && tab.baseline.content !== tab.content;
  return (
    <div
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
}

function TabOverflowMenu({
  tabs,
  activePath,
  onSelect,
  browsers,
  activeBrowserTabID,
  onSelectBrowser
}: {
  tabs: Tab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  browsers: BrowserTab[];
  activeBrowserTabID: string | null;
  onSelectBrowser?: (id: string) => void;
}): ReactNode {
  return (
    <div className="tab-overflow-menu" role="menu" aria-label="All open tabs">
      {tabs.map((tab) => (
        <button
          key={tab.path}
          type="button"
          role="menuitem"
          className={"tab-overflow-item" + (tab.path === activePath ? " active" : "")}
          title={tab.path}
          onClick={() => onSelect(tab.path)}
        >
          <span className="tab-file-icon"><FileIcon name={tab.name} isDir={false} /></span>
          <span className="tab-overflow-name">{tab.name}</span>
        </button>
      ))}
      {browsers.map((browser) => (
        <button key={browser.id} type="button" role="menuitem"
          className={"tab-overflow-item" + (browser.id === activeBrowserTabID ? " active" : "")}
          title={browser.url || "New tab"} onClick={() => onSelectBrowser?.(browser.id)}>
          <span className="tab-file-icon"><IconGlobe /></span>
          <span className="tab-overflow-name">{browserTabLabel(browser)}</span>
        </button>
      ))}
    </div>
  );
}

function TabOverflow({
  tabs,
  activePath,
  hiddenCount,
  onSelect,
  browsers,
  activeBrowserTabID,
  onSelectBrowser
}: {
  tabs: Tab[];
  activePath: string | null;
  hiddenCount: number;
  onSelect: (path: string) => void;
  browsers: BrowserTab[];
  activeBrowserTabID: string | null;
  onSelectBrowser?: (id: string) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as Element).closest?.(".tab-overflow-menu")) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <div className="tab-overflow" ref={ref}>
      <button
        type="button"
        className={`tab-overflow-button ${open ? "open" : ""}`}
        aria-label={`All open tabs (${hiddenCount} hidden)`}
        aria-expanded={open}
        title="All open tabs"
        onClick={() => setOpen((value) => !value)}
      >
        <i className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div style={{ position: "fixed", top: (ref.current?.getBoundingClientRect().bottom ?? 0) + 6,
          right: Math.max(0, window.innerWidth - (ref.current?.getBoundingClientRect().right ?? window.innerWidth)), zIndex: 1000 }}>
        <TabOverflowMenu
          tabs={tabs}
          activePath={activePath}
          browsers={browsers}
          activeBrowserTabID={activeBrowserTabID}
          onSelectBrowser={(id) => {
            onSelectBrowser?.(id);
            setOpen(false);
          }}
          onSelect={(path) => {
            onSelect(path);
            setOpen(false);
          }}
        />
        </div>, document.body
      )}
    </div>
  );
}

function BrowserChip({ browser, active, onSelect, onClose }: {
  browser: BrowserTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): ReactNode {
  const label = browserTabLabel(browser);
  return (
    <div
      role="tab"
      aria-selected={active}
      className={"tab browser" + (active ? " active" : "")}
      title={browser.url || "New tab"}
      onClick={onSelect}
    >
      <span className="tab-file-icon"><IconGlobe /></span>
      <span className="tab-name">
        {browser.loading && <span className="tab-browser-loading" aria-hidden="true" />}
        {label}
      </span>
      <span className="tab-actions">
        <button
          type="button"
          className="tab-close"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >×</button>
      </span>
    </div>
  );
}

export function TabBar({
  tabs,
  activePath,
  ariaLabel,
  groupFor,
  onSelect,
  onClose,
  onMoveTab,
  browsers = [],
  activeBrowserTabID = null,
  onSelectBrowser,
  onCloseBrowser,
  onNewBrowser
}: {
  tabs: Tab[];
  activePath: string | null;
  ariaLabel: string;
  groupFor?: (path: string) => EditorGroupID;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMoveTab: (path: string, destination: EditorGroupID, source: EditorGroupID) => void;
  browsers?: BrowserTab[];
  activeBrowserTabID?: string | null;
  onSelectBrowser?: (id: string) => void;
  onCloseBrowser?: (id: string) => void;
  onNewBrowser?: () => void;
}): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWidth, setListWidth] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = (): void => setListWidth(list.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const { visibleCount, hiddenCount } = stripLayout(listWidth, tabs.length, 0, browsers.length);
  const visibleTabs = tabs.slice(0, visibleCount);
  const visibleBrowsers = browsers.slice(0, Math.max(0, visibleCount - tabs.length));
  const groupOf = (path: string): EditorGroupID => groupFor?.(path) ?? "primary";

  return (
    <div className="tabbar">
      <div className="tab-list" role="tablist" aria-label={ariaLabel} ref={listRef}>
        {visibleTabs.flatMap((tab, index) => {
          const previous = visibleTabs[index - 1];
          // Split groups share this strip; a hairline keeps their tab blocks
          // readable as belonging to different panels.
          const divider = previous && groupOf(previous.path) !== groupOf(tab.path)
            ? [<span className="tab-group-divider" key={`divider:${tab.path}`} aria-hidden="true" />]
            : [];
          return [...divider, <TabChip
            key={tab.path}
            tab={tab}
            active={tab.path === activePath}
            group={groupOf(tab.path)}
            onSelect={onSelect}
            onClose={onClose}
          />];
        })}
        {visibleBrowsers.map((browser) => (
          <BrowserChip
            key={browser.id}
            browser={browser}
            active={browser.id === activeBrowserTabID}
            onSelect={() => onSelectBrowser?.(browser.id)}
            onClose={() => onCloseBrowser?.(browser.id)}
          />
        ))}
      </div>
      {onNewBrowser && (
          <button
            type="button"
            className="tab-add"
            aria-label="New browser tab"
            title="New browser tab"
            onClick={onNewBrowser}
          >
            <IconAdd />
          </button>
      )}
      {hiddenCount > 0 && (
        <TabOverflow tabs={tabs} activePath={activePath} hiddenCount={hiddenCount} onSelect={onSelect}
          browsers={browsers} activeBrowserTabID={activeBrowserTabID} onSelectBrowser={onSelectBrowser} />
      )}
    </div>
  );
}
