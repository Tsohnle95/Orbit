import type { ReactNode } from "react";

// Fixed 8-bit palette: the sprite is artwork, so it keeps its own colours in
// every appearance. The star field borrows the panel's faint text colour so it
// blends with whatever surface the panel is painted on.
const SPRITE_PALETTE: Record<string, string> = {
  w: "#dbeaff",
  a: "#7ab6ff",
  b: "#4f8ee6",
  c: "#2f639f",
  d: "#122a4e",
  s: "var(--text-faint)"
};

// Neptune with the Great Dark Spot, two cloud bands, Triton below-left and a
// probe coasting in from the upper right.
const SPRITE_PIXELS = [
  "..................s...........",
  "........................ws....",
  "..s..................s.s......",
  "............wwwwa...s....s....",
  "..........wwwwwaaaa.....s.....",
  ".........wwwwaaaaaaa....ss....",
  "......s.wwwwaaaaaabbb...s.....",
  "........wwwaaaaaabbbb.........",
  ".......wcccccccccccccb........",
  ".......waaaaaabbbbbbbb.....s..",
  ".s.....aaadddbbbbbbbbc........",
  ".......aadddddbbbbbbcc........",
  ".......aadddddbbbbcccc........",
  "...ab....bbccddcccccccc.......",
  "...bc....bbbbbbbcccccc.......s",
  "....s....bbbbbcccccc..........",
  "........s.bbbcccccc...s.......",
  "........ss..ccccc.............",
  "........s.....................",
  ".............................."
];

const SPRITE_WIDTH = Math.max(...SPRITE_PIXELS.map((row) => row.length));
const SPRITE_HEIGHT = SPRITE_PIXELS.length;

// One rect per pixel, inset so the sprite reads as a grid of little squares.
const SPRITE_RECTS = SPRITE_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => {
    const fill = SPRITE_PALETTE[pixel];
    if (!fill) return [];
    return [{ key: `${x}:${y}`, x, y, fill }];
  })
);

export function NeptuneSprite({ className }: { className?: string }): ReactNode {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${SPRITE_WIDTH} ${SPRITE_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {SPRITE_RECTS.map((pixel) => (
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
