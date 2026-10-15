import type { ReactNode } from "react";

// Fixed palette: the mark is artwork, so it keeps its own colours in every
// appearance (the same rule the panel's other pixel art follows).
const MARK_PALETTE: Record<string, string> = {
  b: "#ffffff",
  l: "#cbb8ff",
  v: "#8f78e8",
  d: "#8593e0"
};

// Four-point sparkle with two detached glints (one rect per pixel).
const MARK_PIXELS = [
  "....l....",
  "....l..d.",
  "...lll...",
  "..llvll..",
  "lllvbvlll",
  "..llvll..",
  ".d.lll...",
  "....l....",
  "....l...."
];

const MARK_WIDTH = Math.max(...MARK_PIXELS.map((row) => row.length));
const MARK_HEIGHT = MARK_PIXELS.length;

const MARK_RECTS = MARK_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => {
    const fill = MARK_PALETTE[pixel];
    if (!fill) return [];
    return [{ key: `${x}:${y}`, x, y, fill }];
  })
);

export function MiraMark({ className }: { className?: string }): ReactNode {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {MARK_RECTS.map((pixel) => (
        <rect
          key={pixel.key}
          x={pixel.x + 0.06}
          y={pixel.y + 0.06}
          width={0.88}
          height={0.88}
          fill={pixel.fill}
        />
      ))}
    </svg>
  );
}
