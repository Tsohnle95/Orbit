import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { StoreProvider, useStore } from "./store";
import { IconAdd, IconChevronDown, IconGear, IconRobot, IconSidebarLeft, IconSidebarRight, IconTerminal } from "./components/icons";
import type { SessionInfo } from "@shared/types";
import { Welcome } from "./components/Welcome";
import { FileSidebar, type SidebarTab } from "./components/FileSidebar";
import { EditorPane } from "./components/EditorPane";
import { AgentPanel } from "./components/AgentPanel";
import { TerminalTray } from "./components/TerminalTray";
import { RecoveryNotice } from "./components/RecoveryNotice";
import { OrbitMark } from "./components/OrbitMark";
import { SettingsPage } from "./components/SettingsPage";
import { SettingsSidebar, type SettingsSection } from "./components/SettingsSidebar";
import { ThemeProvider } from "./theme";

const SIDE_MIN_W = 230;
const SIDE_MAX_W = 520;
const SIDE_DEFAULT_W = 280;

function clampSideWidth(width: number): number {
  return Math.max(SIDE_MIN_W, width);
}
const AGENT_DEFAULT_W = 280;
const AGENT_MIN_W = 280;

function EmptyTerminalTray({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className="terminal-tray">
      <div className="terminal-header">
        <span className="terminal-notice">Open a workspace to use the terminal.</span>
        <button className="terminal-close" title="Close the terminal panel (⌥O)" onClick={onClose}>
          <IconChevronDown />
        </button>
      </div>
    </div>
  );
}

function useDragResize(
  width: number,
  setWidth: React.Dispatch<React.SetStateAction<number>>,
  min: number,
  max: number,
  flip: boolean,
  open: boolean,
  left?: number,
  setLeft?: (value: number) => void,
  onSnap?: () => void,
  onPreview?: (width: number, left: number | null) => void
): (e: React.MouseEvent) => void {
  const startRef = useRef<{ x: number; width: number; left: number; live: number; hasDragged: boolean } | null>(null);

  const onMouseDown = (e: React.MouseEvent): void => {
    if (!open) return;
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      width,
      left: left ?? 0,
      live: width,
      hasDragged: false
    };
    const move = (ev: MouseEvent): void => {
      if (!startRef.current) return;
      if (!startRef.current.hasDragged) {
        if (Math.abs(ev.clientX - startRef.current.x) < 4) return;
        startRef.current.hasDragged = true;
      }
      const dx = ev.clientX - startRef.current.x;
      const rawW = startRef.current.width + (flip ? -dx : dx);
      const nextW = Math.max(min, rawW);
      const capped = Math.min(max, nextW);
      startRef.current.live = capped;
      const nextLeft = flip && setLeft ? startRef.current.left + startRef.current.width - capped : null;
      if (onPreview) onPreview(capped, nextLeft);
      else {
        setWidth(capped);
        if (nextLeft !== null && setLeft) setLeft(nextLeft);
      }
    };
    const up = (): void => {
      const start = startRef.current;
      if (start?.hasDragged && onPreview) {
        setWidth(start.live);
        if (flip && setLeft) setLeft(start.left + start.width - start.live);
      }
      if (start && start.hasDragged && start.live < min) {
        if (flip && setLeft) setLeft(start.left + start.width - min);
        setWidth(min);
        onSnap?.();
      }
      startRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return onMouseDown;
}

const TRAY_HEADER_H = 30;
const TRAY_SNAP_H = 32;

function useTrayHeight(onPreview?: (height: number) => void): {
  height: number;
  open: boolean;
  snapped: boolean;
  dragging: boolean;
  toggle: () => void;
  show: () => void;
  close: () => void;
  expand: () => void;
  onDrag: (e: React.MouseEvent) => void;
} {
  const [open, setOpen] = useState(false);
  const [snapped, setSnapped] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState(240);
  const startRef = useRef<{ y: number; height: number; live: number } | null>(null);
  const lastFullRef = useRef(240);

  const onDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    if (startRef.current) return;
    startRef.current = { y: e.clientY, height, live: height };
    setDragging(true);
    const up = (): void => {
      if (startRef.current) {
        const h = startRef.current.live;
        startRef.current = null;
        if (onPreview) setHeight(h);
        if (h <= TRAY_SNAP_H) {
          setHeight(TRAY_HEADER_H);
          setSnapped(true);
        } else {
          setSnapped(false);
        }
        setOpen(true);
      }
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    const move = (ev: MouseEvent): void => {
      if (!startRef.current) return;
      if (ev.clientY >= window.innerHeight) {
        startRef.current = null;
        setDragging(false);
        setOpen(false);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        return;
      }
      const dy = startRef.current.y - ev.clientY;
      const h = Math.min(520, Math.max(TRAY_HEADER_H, startRef.current.height + dy));
      startRef.current.live = h;
      if (h > TRAY_SNAP_H) lastFullRef.current = h;
      if (onPreview) onPreview(h);
      else setHeight(h);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const expand = (): void => {
    setSnapped(false);
    setHeight(lastFullRef.current);
    setOpen(true);
  };

  const toggle = (): void => {
    if (!open || snapped) expand();
    else setOpen(false);
  };

  const close = (): void => setOpen(false);

  const show = (): void => {
    setHeight(lastFullRef.current);
    setSnapped(false);
    setOpen(true);
  };

  return { height, open, snapped, dragging, toggle, show, close, expand, onDrag };
}

interface PanelSlot {
  open: boolean;
  width: number;
  left: number;
  leftAnchored?: boolean;
  top: number;
  height: number;
}

function PanelColumn({
  session,
  sessionChoices,
  defaultSessionID,
  onDefaultSessionChange,
  slot,
  isAnchor,
  freeMove,
  leftMin,
  leftMax,
  rightMax,
  isLast,
  onSlot,
  onFocus,
  onClose,
  onManualAdjust
}: {
  session: SessionInfo;
  sessionChoices?: SessionInfo[];
  defaultSessionID?: string | null;
  onDefaultSessionChange?: (sessionID: string) => void;
  slot: PanelSlot;
  isAnchor: boolean;
  freeMove: boolean;
  leftMin: number;
  leftMax: number;
  rightMax: number;
  isLast: boolean;
  onSlot: React.Dispatch<React.SetStateAction<PanelSlot>>;
  onFocus: () => void;
  onClose: () => void;
  onManualAdjust?: () => void;
}): ReactNode {
  const [settling, setSettling] = useState(false);
  const columnRef = useRef<HTMLDivElement>(null);
  const slideLeftRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, []);
  const settle = useCallback(() => {
    setSettling(true);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setSettling(false);
    }, 200);
  }, []);
  const open = useCallback(() => onSlot((current) => ({ ...current, open: true })), [onSlot]);
  const resizeRight = useDragResize(
    slot.width,
    (width) => onSlot((current) => ({ ...current, width: typeof width === "function" ? width(current.width) : width })),
    AGENT_MIN_W,
    rightMax,
    false,
    slot.open,
    slot.left,
    undefined,
    settle,
    (width) => {
      if (columnRef.current) columnRef.current.style.width = `${width}px`;
    }
  );
  const resizeLeft = useDragResize(
    slot.width,
    (width) => onSlot((current) => ({ ...current, width: typeof width === "function" ? width(current.width) : width })),
    AGENT_MIN_W,
    slot.left + slot.width - leftMin,
    true,
    slot.open,
    slot.left,
    (left) => onSlot((current) => ({ ...current, left, leftAnchored: true })),
    settle,
    (width, left) => {
      if (!columnRef.current) return;
      columnRef.current.style.width = `${width}px`;
      if (left !== null) {
        columnRef.current.style.left = `${left}px`;
        columnRef.current.classList.toggle("edge-left", left <= leftMin + 0.5);
      }
      if (isAnchor) columnRef.current.parentElement?.style.setProperty("--editor-right", `${width}px`);
    }
  );
  const slideBy = (delta: number): void => {
    const next = Math.min(leftMax, Math.max(leftMin, (slideLeftRef.current ?? slot.left) + delta));
    slideLeftRef.current = next;
    if (columnRef.current) columnRef.current.style.left = `${next}px`;
  };
  const finishSlide = (): void => {
    const left = slideLeftRef.current;
    slideLeftRef.current = null;
    if (left !== null) onSlot((current) => ({ ...current, left }));
    onManualAdjust?.();
  };
  const exitModeOnRelease = (event: React.MouseEvent): void => {
    event.preventDefault();
    const release = (): void => {
      window.removeEventListener("mouseup", release);
      onManualAdjust?.();
    };
    window.addEventListener("mouseup", release);
  };
  if (!slot.open) {
    return null;
  }
  return (
    <div ref={columnRef} className={`agent-col ${settling ? "settling" : ""} ${slot.left <= leftMin + 0.5 ? "edge-left" : ""}`} style={{ left: `${slot.left}px`, top: `${slot.top}%`, bottom: "auto", width: `${slot.width}px`, height: `${slot.height}%` }}>
      <AgentPanel session={session} sessionChoices={sessionChoices} defaultSessionID={defaultSessionID} onDefaultSessionChange={onDefaultSessionChange} isAnchor={isAnchor} onFocus={onFocus} onClose={onClose} onResizeLeft={freeMove ? exitModeOnRelease : resizeLeft} onResizeRight={freeMove ? exitModeOnRelease : isAnchor ? undefined : resizeRight} onPanelDrag={freeMove || !isAnchor ? slideBy : undefined} onPanelDragEnd={freeMove || !isAnchor ? finishSlide : undefined} />
    </div>
  );
}

function Layout({ children }: { children?: ReactNode }): ReactNode {
  const { session, panels: allPanels, workspaceOnlyPanelIDs, activeSessionID, focusSession, closePanel, selectAddPanel } = useStore();
  const agentPanels = useMemo(() => {
    const agentPanels = allPanels.filter((panel) => !workspaceOnlyPanelIDs.has(panel.id));
    const active = allPanels.find((panel) => panel.id === activeSessionID);
    if (!active || !workspaceOnlyPanelIDs.has(active.id)) return agentPanels;
    return [active, ...agentPanels.slice(1)];
  }, [allPanels, workspaceOnlyPanelIDs, activeSessionID]);
  const [sideOpen, setSideOpen] = useState(true);
  const [sideW, setSideW] = useState(SIDE_DEFAULT_W);
  const [slots, setSlots] = useState<Record<string, PanelSlot>>({});
  const [pendingModelPanels, setPendingModelPanels] = useState(0);
  const trayAreaRef = useRef<HTMLDivElement>(null);
  const { height: trayH, open: trayOpen, snapped: traySnapped, dragging: trayDragging, toggle: toggleTray, show: showTray, close: closeTray, expand: expandTray, onDrag: trayDrag } = useTrayHeight(
    (height) => trayAreaRef.current?.style.setProperty("--tray-height", `${height}px`)
  );
  const [terminalRequest, setTerminalRequest] = useState<{ id: number; directory: string } | null>(null);
  const [winW, setWinW] = useState(() => window.innerWidth);
  const [sideTab, setSideTab] = useState<SidebarTab>("sessions");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [agentModeActive, setAgentModeActive] = useState(false);
  const [defaultAgentSessionID, setDefaultAgentSessionID] = useState<string | null>(null);
  const [emptyAgentOpen, setEmptyAgentOpen] = useState(true);
  const [emptyAgentWidth, setEmptyAgentWidth] = useState(280);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const emptyAgentRef = useRef<HTMLDivElement>(null);
  const prevSidebarRef = useRef<{ open: boolean; width: number } | null>(null);
  const inAgentMode = agentModeActive;
  const defaultPanel = useMemo(
    () => agentPanels.find((panel) => panel.id === defaultAgentSessionID) ?? agentPanels[0] ?? null,
    [agentPanels, defaultAgentSessionID]
  );
  const panels = inAgentMode ? agentPanels : defaultPanel ? [defaultPanel] : [];

  useEffect(() => {
    if (defaultAgentSessionID && agentPanels.some((panel) => panel.id === defaultAgentSessionID)) return;
    const fallback = agentPanels[0] ?? null;
    setDefaultAgentSessionID(fallback?.id ?? null);
    if (defaultAgentSessionID && fallback) focusSession(fallback.id);
  }, [agentPanels, defaultAgentSessionID, focusSession]);

  const sideShown = sideOpen ? sideW : 0;
  const fixedPanelChrome = 1 + panels.length;
  const areaW = Math.max(0, winW - sideShown - (sideOpen ? 1 : 0));

  const wasOpenWorkspacesRef = useRef(0);
  useEffect(() => {
    if (allPanels.length > 0 && wasOpenWorkspacesRef.current === 0) setSideW(SIDE_MIN_W);
    wasOpenWorkspacesRef.current = allPanels.length;
  }, [allPanels.length]);

  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const prevPanelsRef = useRef<SessionInfo[] | null>(null);
  const sessionSlotsRef = useRef(new Map<string, PanelSlot>());
  const rememberedSlot = (panel: SessionInfo): PanelSlot | undefined =>
    sessionSlotsRef.current.get(panel.id) ??
    (panel.parentID ? sessionSlotsRef.current.get(panel.parentID) : undefined);
  useLayoutEffect(() => {
    const prev = prevPanelsRef.current;
    prevPanelsRef.current = panels;
    if (!prev || prev.length !== panels.length) return;
    // Changing the selected singleton in normal coding mode is a view swap,
    // not a workspace replacement. Keep the target's own slot instead of
    // migrating the previous panel's geometry onto it.
    if (!inAgentMode && panels.length === 1 && prev[0]?.id !== panels[0]?.id) return;
    for (let index = 0; index < panels.length; index += 1) {
      const before = prev[index];
      const after = panels[index];
      if (before.id === after.id) continue;
      setSlots((current) => {
        const migrated = current[before.workspace.id];
        if (!migrated || current[after.workspace.id] === migrated) return current;
        const next = { ...current, [after.workspace.id]: migrated };
        delete next[before.workspace.id];
        return next;
      });
    }
  }, [panels]);

  useLayoutEffect(() => {
    for (const panel of panels) {
      const slot = slots[panel.workspace.id];
      if (slot) sessionSlotsRef.current.set(panel.id, slot);
    }
  }, [panels, slots]);

  useEffect(() => {
    setSlots((current) => {
      const anchorId = panels[0]?.workspace.id ?? null;
      const anchorStored = anchorId ? current[anchorId] : undefined;
      const anchorWidth = anchorStored ? (anchorStored.open ? anchorStored.width : 0) : AGENT_DEFAULT_W;
      const anchorLeft = Math.max(0, areaW - anchorWidth);
      const next: Record<string, PanelSlot> = {};
      let changed = false;
      for (const panel of panels) {
        const id = panel.workspace.id;
        const existing = current[id] ?? rememberedSlot(panel);
        if (existing) {
          next[id] = existing;
          continue;
        }
        if (id === anchorId) {
          next[id] = { open: true, width: AGENT_DEFAULT_W, left: anchorLeft, top: 0, height: 100 };
          changed = true;
          continue;
        }
        let left = anchorLeft - AGENT_DEFAULT_W;
        for (const other of panels) {
          if (other.workspace.id === id || other.workspace.id === anchorId) continue;
          const s = next[other.workspace.id] ?? current[other.workspace.id];
          if (!s) continue;
          left = Math.min(left, s.left - AGENT_DEFAULT_W);
        }
        next[id] = { open: true, width: AGENT_DEFAULT_W, left: Math.max(0, left), top: 0, height: 100 };
        changed = true;
      }
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      return changed ? next : current;
    });
  }, [panels, areaW]);

  const slotShown = (panel: SessionInfo): number => {
    const slot = slots[panel.workspace.id] ?? rememberedSlot(panel) ?? { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 };
    return slot.open ? slot.width : 0;
  };
  const slotFor = (panel: SessionInfo): PanelSlot => {
    const anchorId = panels[0]?.workspace.id ?? null;
    const stored = slots[panel.workspace.id] ?? rememberedSlot(panel);
    if (inAgentMode && panels.length === 1) {
      return {
        open: true,
        width: Math.max(0, areaW),
        left: 0,
        top: 0,
        height: 100
      };
    }
    if (panel.workspace.id === anchorId) {
      const open = stored?.open ?? true;
      const width = stored ? (open ? stored.width : 0) : AGENT_DEFAULT_W;
      if (inAgentMode && stored) {
        return {
          open: true,
          width: Math.max(AGENT_DEFAULT_W, stored.width),
          left: stored.left,
          top: stored.top,
          height: stored.height
        };
      }
      if (open && stored?.left === 0 && stored.leftAnchored) {
        return { open: true, width: areaW, left: 0, top: 0, height: 100 };
      }
      return { open, width, left: Math.max(0, areaW - width), top: 0, height: 100 };
    }
    if (stored) {
      return inAgentMode && !stored.open
        ? { ...stored, open: true, width: Math.max(AGENT_DEFAULT_W, stored.width) }
        : stored;
    }
    const anchorStored = anchorId ? slots[anchorId] : undefined;
    const anchorWidth = anchorStored ? (anchorStored.open ? anchorStored.width : 0) : AGENT_DEFAULT_W;
    const anchorLeft = Math.max(0, areaW - anchorWidth);
    let left = anchorLeft - AGENT_DEFAULT_W;
    for (const other of panels) {
      if (other.workspace.id === panel.workspace.id || other.workspace.id === anchorId) continue;
      const s = slots[other.workspace.id];
      if (!s) continue;
      left = Math.min(left, s.left - AGENT_DEFAULT_W);
    }
    return { open: true, width: AGENT_DEFAULT_W, left: Math.max(0, left), top: 0, height: 100 };
  };

  const ordered = [...panels].sort((a, b) => slotFor(a).left - slotFor(b).left);

  const singlePanel = panels.length <= 1;
  const agentShown = singlePanel && panels.length === 1
    ? slotShown(panels[0])
    : 0;
  const sideMax = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, winW - agentShown - fixedPanelChrome));

  const sideCapRef = useRef<number | null>(null);
  const agentCapRef = useRef<number | null>(null);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  useLayoutEffect(() => {
    const current = slotsRef.current;
    const shown = (panel: SessionInfo): number => {
      const slot = current[panel.workspace.id] ?? rememberedSlot(panel) ?? { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 };
      return slot.open ? slot.width : 0;
    };
    if (prevSidebarRef.current !== null) {
      const avail = Math.max(0, winW - sideShown - (sideShown > 0 ? 1 : 0));
      const openIDs = panels
        .filter((panel) => current[panel.workspace.id]?.open ?? true)
        .map((panel) => panel.workspace.id);
      if (openIDs.length === 0) return;
      const gridIDs = [...panels].reverse()
        .map((panel) => panel.workspace.id)
        .filter((id) => openIDs.includes(id));
      const columns = gridIDs.length === 1 ? 1 : 2;
      const rows = gridIDs.length >= 3 ? 2 : 1;
      const base = Math.max(AGENT_MIN_W, Math.floor(avail / columns));
      setSlots((slots) => {
        const next = { ...slots };
        gridIDs.forEach((id, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          next[id] = {
            ...(next[id] ?? { open: true, width: base, left: 0, top: 0, height: 100 }),
            open: true,
            width: column === columns - 1 ? Math.max(AGENT_MIN_W, avail - base) : base,
            left: column === 0 ? 0 : base,
            top: row * (100 / rows),
            height: 100 / rows
          };
        });
        return next;
      });
      return;
    }
    if (panels.length <= 1) {
      if (panels.length === 0) return;
      const panel0 = panels[0];
      const panelOpen = current[panel0.workspace.id]?.open ?? true;
      if (!sideOpen && !panelOpen) return;
      const avail = Math.max(0, winW - fixedPanelChrome);
      const agentShownNow = panelOpen ? shown(panel0) : 0;
      const agentLimit = Math.max(0, avail - sideShown);
      const sideLimit = Math.max(0, Math.min(SIDE_MAX_W, avail - agentShownNow));
      const agentAnchored = panelOpen && agentCapRef.current !== null && agentShownNow >= agentCapRef.current - 1;
      const sideAnchored = sideOpen && sideCapRef.current !== null && sideW >= sideCapRef.current - 1;
      if (panelOpen) agentCapRef.current = agentLimit;
      if (sideOpen) sideCapRef.current = sideLimit;
      const total = sideShown + agentShownNow;
      if (total <= avail) return;
      if (!sideOpen || !panelOpen) {
        if (panelOpen) setSlotWidth(panel0.workspace.id, agentLimit);
        else setSideW(clampSideWidth(sideLimit));
        return;
      }
      if (agentAnchored !== sideAnchored) {
        if (agentAnchored) setSlotWidth(panel0.workspace.id, agentLimit);
        else setSideW(clampSideWidth(sideLimit));
        return;
      }
      if (agentAnchored) {
        const nextAgent = Math.max(AGENT_MIN_W, agentLimit);
        setSlotWidth(panel0.workspace.id, nextAgent);
        setSideW(clampSideWidth(Math.min(sideShown, avail - nextAgent)));
        return;
      }
      const nextSide = clampSideWidth(Math.round((sideShown * avail) / total));
      const nextAgent = Math.max(AGENT_MIN_W, avail - nextSide);
      setSideW(nextSide);
      setSlotWidth(panel0.workspace.id, nextAgent);
      return;
    }
    const avail = Math.max(0, winW - fixedPanelChrome - sideShown);
    const openIDs = panels
      .filter((panel) => current[panel.workspace.id]?.open)
      .map((panel) => panel.workspace.id);
    if (openIDs.length === 0) return;
    const totalShown = panels.reduce((sum, panel) => sum + shown(panel), 0);
    if (totalShown > avail) {
      const base = Math.max(AGENT_MIN_W, Math.floor(avail / openIDs.length));
      for (const id of openIDs) setSlotWidth(id, Math.min(current[id]?.width ?? base, base));
    }
    const anchorId = panels[0]?.workspace.id ?? null;
    const anchorStored = anchorId ? current[anchorId] : undefined;
    const anchorShown = anchorStored ? (anchorStored.open ? anchorStored.width : 0) : AGENT_DEFAULT_W;
    const anchorLeft = Math.max(0, areaW - anchorShown);
    const others = panels
      .filter((panel) => panel.workspace.id !== anchorId)
      .sort((a, b) => (current[b.workspace.id]?.left ?? 0) - (current[a.workspace.id]?.left ?? 0));
    let boundary = anchorLeft;
    for (const panel of others) {
      const slot = current[panel.workspace.id];
      if (!slot) continue;
      const w = slot.open ? slot.width : 0;
      const capped = Math.max(0, Math.min(slot.left, boundary - w));
      if (capped !== slot.left) setSlotLeft(panel.workspace.id, capped);
      boundary = Math.min(boundary, capped);
    }
  }, [winW, sideOpen, sideW, panels]);

  const sideDrag = useDragResize(
    sideW,
    setSideW,
    SIDE_MIN_W,
    sideMax,
    false,
    sideOpen,
    undefined,
    undefined,
    undefined,
    (width) => mainRowRef.current?.style.setProperty("--pane-columns", `${width}px 1px minmax(0,1fr)`)
  );
  const emptyAgentDrag = useDragResize(
    emptyAgentWidth,
    setEmptyAgentWidth,
    AGENT_MIN_W,
    areaW,
    true,
    emptyAgentOpen,
    undefined,
    undefined,
    undefined,
    (width) => {
      if (emptyAgentRef.current) emptyAgentRef.current.style.width = `${width}px`;
      emptyAgentRef.current?.parentElement?.style.setProperty("--editor-right", `${width}px`);
    }
  );

  const cols = [
    sideOpen ? `${sideW}px` : "0px",
    ...(sideOpen ? ["1px"] : []),
    "minmax(0,1fr)"
  ].join(" ");

  const setSidebarOpen = (open: boolean): void => {
    setSideOpen(open);
  };

  const anchorId = panels[0]?.workspace.id ?? null;
  const anchorOpen = anchorId ? slots[anchorId]?.open ?? true : emptyAgentOpen;
  const setSlotOpen = (id: string | null, open: boolean): void => {
    if (!id) return;
    setSlots((current) => {
      const slot = current[id] ?? { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 };
      if (slot.open === open) return current;
      return { ...current, [id]: { ...slot, open } };
    });
  };

  const distributeEvenly = useCallback((sideShownAt: number, singleRestore: boolean, targetPanels: SessionInfo[] = panels, modelMode = prevSidebarRef.current !== null): void => {
    setSlots((current) => {
      const anchorId = targetPanels[0]?.workspace.id ?? null;
      const openIDs = modelMode
        ? targetPanels.map((panel) => panel.workspace.id)
        : targetPanels
          .filter((panel) => panel.workspace.id === anchorId || (current[panel.workspace.id]?.open ?? true))
          .map((panel) => panel.workspace.id);
      if (openIDs.length === 0) return current;
      if (singleRestore && openIDs.length === 1 && anchorId) {
        return { ...current, [anchorId]: { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 } };
      }
      const area = Math.max(0, winW - sideShownAt - (sideShownAt > 0 ? 1 : 0));
      const total = modelMode ? area : Math.max(0, winW - fixedPanelChrome - sideShownAt);
      const grid = modelMode && openIDs.length >= 3;
      const columns = grid ? 2 : openIDs.length;
      const rows = grid ? 2 : 1;
      const width = Math.max(AGENT_MIN_W, Math.floor(total / columns));
      const anchorW = Math.max(AGENT_MIN_W, total - width * (columns - 1));
      const next: Record<string, PanelSlot> = {};
      let boundary = Math.max(0, area - anchorW);
      for (const [index, panel] of [...targetPanels].reverse().entries()) {
        const id = panel.workspace.id;
        if (id === anchorId || !openIDs.includes(id)) continue;
        boundary -= width;
        next[id] = {
          open: true,
          width,
          left: grid ? (index % columns) * Math.floor(total / columns) : Math.max(0, boundary),
          leftAnchored: false,
          top: grid ? Math.floor(index / columns) * (100 / rows) : 0,
          height: grid ? 100 / rows : 100
        };
      }
      if (anchorId) {
        const anchorIndex = openIDs.length - 1;
        next[anchorId] = {
          open: true,
          width: anchorW,
          left: grid ? (anchorIndex % columns) * Math.floor(total / columns) : Math.max(0, area - anchorW),
          leftAnchored: false,
          top: grid ? Math.floor(anchorIndex / columns) * (100 / rows) : 0,
          height: grid ? 100 / rows : 100
        };
      }
      return { ...current, ...next };
    });
  }, [fixedPanelChrome, panels, winW]);

  const previousPanelCountRef = useRef(panels.length);
  useEffect(() => {
    if (inAgentMode && panels.length > previousPanelCountRef.current) {
      distributeEvenly(sideShown, false, agentPanels, true);
    }
    previousPanelCountRef.current = panels.length;
  }, [agentPanels, distributeEvenly, inAgentMode, panels.length, sideShown]);

  useLayoutEffect(() => {
    if (inAgentMode && sideOpen) distributeEvenly(sideW, false, agentPanels, true);
  }, [agentPanels, distributeEvenly, inAgentMode, sideOpen, sideW]);

  const addModelPanel = (): void => {
    if (!inAgentMode || agentPanels.length + pendingModelPanels >= 4) return;
    setPendingModelPanels((count) => count + 1);
    void selectAddPanel().finally(() => setPendingModelPanels((count) => Math.max(0, count - 1)));
  };

  const toggleAgentMode = (): void => {
    if (!inAgentMode) {
      prevSidebarRef.current = { open: sideOpen, width: sideW };
      setAgentModeActive(true);
      setSettingsOpen(false);
      setSideOpen(false);
      distributeEvenly(0, false, agentPanels, true);
    } else {
      const prev = prevSidebarRef.current;
      if (!prev) return;
      prevSidebarRef.current = null;
      setAgentModeActive(false);
      setSideOpen(prev.open);
      setSideW(prev.width);
      distributeEvenly(prev.open ? prev.width : 0, true, defaultPanel ? [defaultPanel] : [], false);
      if (defaultPanel) focusSession(defaultPanel.id);
    }
  };

  const leaveAgentModeForManualAdjustment = (): void => {
    if (!inAgentMode) return;
    prevSidebarRef.current = null;
    setAgentModeActive(false);
  };

  const closeAgentPanel = (panel: SessionInfo): void => {
    if (agentPanels.length > 1) {
      closePanel(panel.id);
      return;
    }
    if (inAgentMode) {
      const previous = prevSidebarRef.current;
      prevSidebarRef.current = null;
      setAgentModeActive(false);
      if (previous) {
        setSideOpen(previous.open);
        setSideW(previous.width);
      }
    }
    setSlotOpen(panel.workspace.id, false);
  };

  const setSlotWidth = (id: string, width: number): void => {
    setSlots((current) => {
      const slot = current[id] ?? { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 };
      if (slot.width === width) return current;
      return { ...current, [id]: { ...slot, width } };
    });
  };

  const setSlotLeft = (id: string, left: number): void => {
    setSlots((current) => {
      const slot = current[id] ?? { open: true, width: AGENT_DEFAULT_W, left, top: 0, height: 100 };
      if (slot.left === left) return current;
      return { ...current, [id]: { ...slot, left } };
    });
  };

  return (
    <div className={`app ${inAgentMode ? "agent-mode" : ""}`}>
      <div className="titlebar">
        <span className="titlebar-leading-actions">
          <button
            className={`icon-btn ${sideOpen ? "on" : ""}`}
            data-panel-action="toggle-sidebar"
            title={sideOpen ? "Hide sidebar" : "Show sidebar"}
            aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={sideOpen}
            onClick={() => setSidebarOpen(!sideOpen)}
          >
            <IconSidebarLeft />
          </button>
        </span>
        <span className="titlebar-title"><OrbitMark size={16} />Orbit</span>
        <span className="titlebar-actions">
          {inAgentMode && (
            <button
              className="icon-btn"
              data-panel-action="add-model-panel"
              title={agentPanels.length + pendingModelPanels >= 4 ? "Model panel limit reached (4)" : "Add model panel (choose a folder for the new panel)"}
              aria-label="Add model panel"
              disabled={agentPanels.length + pendingModelPanels >= 4}
              onClick={addModelPanel}
            >
              <IconAdd />
            </button>
          )}
          <button
            className={`icon-btn ${inAgentMode ? "on" : ""}`}
            data-panel-action="toggle-model-mode"
            aria-label={inAgentMode ? "Exit Agent Mode" : "Enter Agent Mode"}
            aria-pressed={inAgentMode}
            title={inAgentMode
              ? "Exit Agent Mode — restore the previous panel layout"
              : "Agent Mode — collapse the sidebar and split models across the workspace"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleAgentMode();
            }}
          >
            <IconRobot />
          </button>
          <button
            className={`icon-btn ${trayOpen ? "on" : ""}`}
            title={!session
              ? "No workspace open"
              : trayOpen
                ? (traySnapped ? "Expand terminal (⌥O)" : "Hide terminal (⌥O)")
                : "Show terminal (⌥O)"}
            onClick={toggleTray}
          >
            <IconTerminal />
          </button>
          <button
            className={`icon-btn ${settingsOpen ? "on" : ""}`}
            title={settingsOpen ? "Back to workspace" : "Settings"}
            aria-label={settingsOpen ? "Back to workspace" : "Settings"}
            aria-pressed={settingsOpen}
            onClick={() => {
              if (!settingsOpen) setSidebarOpen(true);
              setSettingsOpen((open) => !open);
            }}
          >
            <IconGear />
          </button>
          <button
            className={`icon-btn ${anchorOpen ? "on" : ""}`}
            data-panel-action="toggle-agent-panel"
            title={anchorOpen ? "Hide agent panel" : "Show agent panel"}
            aria-label={anchorOpen ? "Hide agent panel" : "Show agent panel"}
            aria-pressed={anchorOpen}
            onClick={() => anchorId ? setSlotOpen(anchorId, !anchorOpen) : setEmptyAgentOpen(!anchorOpen)}
          >
            <IconSidebarRight />
          </button>
        </span>
      </div>

      <div ref={mainRowRef} className="main-row" style={{ "--pane-columns": cols } as CSSProperties}>
        {settingsOpen ? <SettingsSidebar
          section={settingsSection}
          onSectionChange={setSettingsSection}
        /> : <FileSidebar
          collapsed={!sideOpen}
          onCollapse={setSidebarOpen}
          onDrag={sideDrag}
          onOpenTerminal={(directory) => {
            setTerminalRequest((current) => ({ id: (current?.id ?? 0) + 1, directory }));
            showTray();
          }}
          tab={sideTab}
          onTabChange={(tab) => {
            setSideTab(tab);
            setSettingsOpen(false);
          }}
        />}
        <div className={`divider ${sideOpen ? "" : "collapsed"}`} onMouseDown={sideDrag} style={{ pointerEvents: sideOpen ? undefined : "none" }} />
        {settingsOpen ? <SettingsPage section={settingsSection} onClose={() => setSettingsOpen(false)} /> : <div
          className="workspace-area"
          style={
            {
              "--editor-right": `${ordered.length > 0 ? Math.max(0, areaW - slotFor(ordered[0]).left) : emptyAgentOpen && !inAgentMode ? emptyAgentWidth : 0}px`
            } as CSSProperties
          }
        >
          <EditorPane />
          {ordered.map((panel, index) => {
            const s = slotFor(panel);
            const anchorId = panels[0]?.workspace.id ?? null;
            const isAnchor = panel.workspace.id === anchorId;
            const leftN = index > 0 ? ordered[index - 1] : null;
            const rightN = index < ordered.length - 1 ? ordered[index + 1] : null;
            const leftMin = Math.max(0, leftN ? slotFor(leftN).left + slotShown(leftN) : 0);
            const leftMax = rightN ? slotFor(rightN).left - slotShown(panel) : areaW - slotShown(panel);
            const rightMax = (rightN ? slotFor(rightN).left : areaW) - s.left;
            return (
              <PanelColumn
                key={panel.workspace.id}
                session={panel}
                sessionChoices={agentPanels}
                defaultSessionID={defaultPanel?.id ?? null}
                onDefaultSessionChange={(sessionID) => {
                  const next = agentPanels.find((candidate) => candidate.id === sessionID);
                  if (!next) return;
                  if (!inAgentMode) {
                    setSlots((current) => ({
                      ...current,
                      [next.workspace.id]: {
                        open: true,
                        width: AGENT_DEFAULT_W,
                        left: Math.max(0, areaW - AGENT_DEFAULT_W),
                        top: 0,
                        height: 100,
                        leftAnchored: false
                      }
                    }));
                  }
                  setDefaultAgentSessionID(next.id);
                  focusSession(next.id);
                }}
                slot={s}
                isAnchor={isAnchor}
                freeMove={inAgentMode}
                leftMin={leftMin}
                leftMax={leftMax}
                rightMax={rightMax}
                isLast={index === ordered.length - 1}
                onSlot={(update) =>
                  setSlots((current) => {
                    const base = current[panel.workspace.id] ?? { open: true, width: AGENT_DEFAULT_W, left: 0, top: 0, height: 100 };
                    return { ...current, [panel.workspace.id]: typeof update === "function" ? update(base) : update };
                  })
                }
                onFocus={() => focusSession(panel.id)}
                onClose={() => closeAgentPanel(panel)}
                onManualAdjust={leaveAgentModeForManualAdjustment}
              />
            );
          })}
          {panels.length === 0 && emptyAgentOpen && (
            <div
              ref={emptyAgentRef}
              className={`agent-col empty-agent-col ${inAgentMode ? "agent-mode-empty" : ""}`}
              style={inAgentMode ? undefined : { width: `${emptyAgentWidth}px`, right: "0px" }}
            >
              <AgentPanel
                onClose={() => setEmptyAgentOpen(false)}
                onResizeLeft={emptyAgentDrag}
              />
            </div>
          )}
        </div>}
      </div>

      <div
        ref={trayAreaRef}
        className={`tray-area ${trayOpen ? "open" : ""} ${trayDragging ? "dragging" : ""}`}
        style={{ "--tray-height": `${trayH}px` } as CSSProperties}
      >
        {!settingsOpen && <div className="tray-inner">
          <div className="tray-divider" onMouseDown={trayDrag} title="Drag to resize" />
          {session ? (
            <TerminalTray height={trayH} snapped={traySnapped} request={terminalRequest} onClose={closeTray} onExpand={expandTray} />
          ) : (
            <EmptyTerminalTray onClose={closeTray} />
          )}
        </div>}
      </div>

      <Toasts />
      <RecoveryNotice />
    </div>
  );
}

function Toasts(): ReactNode {
  const { toasts } = useStore();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App(): ReactNode {
  useEffect(() => {
    document.documentElement.classList.toggle(
      "darwin",
      window.openshell.platform === "darwin"
    );
  }, []);

  return (
    <ThemeProvider>
      <StoreProvider>
        <Root />
      </StoreProvider>
    </ThemeProvider>
  );
}

function Root(): ReactNode {
  const { session, toggleWordWrap } = useStore();
  const wasOpen = useRef(false);
  const [enteredIde, setEnteredIde] = useState(false);
  const pendingView = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (session && !enteredIde) setEnteredIde(true);
  }, [session, enteredIde]);

  useEffect(() => {
    if (pendingView.current) clearTimeout(pendingView.current);
    const isOpen = Boolean(session);
    if (isOpen === wasOpen.current) return;
    pendingView.current = setTimeout(() => {
      pendingView.current = null;
      if (isOpen && !wasOpen.current) void window.openshell.windowView("session").catch(() => {});
      wasOpen.current = isOpen;
    }, 120);
    return () => {
      if (pendingView.current) clearTimeout(pendingView.current);
    };
  }, [session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyZ") {
        e.preventDefault();
        toggleWordWrap();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleWordWrap]);

  if (!session && !enteredIde) return <Welcome />;
  return <Layout />;
}
