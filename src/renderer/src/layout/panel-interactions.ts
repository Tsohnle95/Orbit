import { useRef, useState } from "react";

export function useDragResize(
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

export function useTrayHeight(onPreview?: (height: number) => void): {
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
  const [height, setHeight] = useState(176);
  const startRef = useRef<{ y: number; height: number; live: number } | null>(null);
  const lastFullRef = useRef(176);

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

