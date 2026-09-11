/**
 * The "two voices" mark: two overlapping hairline rings, gold on the left, ink
 * on the right, the story in the overlap (design handoff README "Logo", board
 * 1a). Inline SVG on purpose — no image asset, and the strokes take the theme
 * tokens so the dark palette recolors it for free.
 *
 * stroke-width compensates for scale so the hairline holds its weight: 2.2 at
 * the 29px nav size, 2.4 at 27px, 1.2 at the 66px display size.
 */
const SIZES = {
  nav: { width: 29, height: 19, strokeWidth: 2.2 },
  compact: { width: 27, height: 17, strokeWidth: 2.4 },
  display: { width: 66, height: 42, strokeWidth: 1.2 },
} as const;

export type MarkSize = keyof typeof SIZES;

export function Mark({ size = "nav", className }: { size?: MarkSize; className?: string }) {
  const { width, height, strokeWidth } = SIZES[size];
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 66 42"
      fill="none"
      aria-hidden="true"
      // A class, not an inline style: the production CSP has no 'unsafe-inline'
      // for style-src-attr (src/lib/security/csp.ts).
      className={className ? `shrink-0 ${className}` : "shrink-0"}
    >
      <circle cx="24" cy="21" r="15" stroke="var(--accent)" strokeWidth={strokeWidth} />
      <circle cx="42" cy="21" r="15" stroke="var(--foreground)" strokeWidth={strokeWidth} />
    </svg>
  );
}

/** The lockup: mark + "Fabula" in Cormorant 600 at 19px, 9px apart. */
export function Wordmark({ size = "nav" }: { size?: MarkSize }) {
  return (
    <span className="inline-flex items-center gap-[9px]">
      <Mark size={size} />
      <span className="font-heading text-[19px] font-semibold leading-none tracking-[0.01em] text-foreground">
        Fabula
      </span>
    </span>
  );
}
