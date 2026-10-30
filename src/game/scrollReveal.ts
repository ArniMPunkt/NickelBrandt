/**
 * Pure scroll decision for the Bingo autoscroll (no React, no IO): given where
 * things sit in the scroll content, is a scroll needed and to which offset?
 * BingoGameScreen does the measuring and the actual scrollTo.
 */

/** A vertical box in scroll-content coordinates. */
export interface ContentBox {
  y: number;
  height: number;
}

export interface ScrollViewportState {
  scrollY: number;
  /** Height of the ScrollView itself. */
  height: number;
  contentHeight: number;
  /** Part of the ScrollView covered at the top (status bar). */
  topInset: number;
  /** Part of the ScrollView covered at the bottom (keyboard). */
  bottomInset: number;
}

/** Breathing room above/below the revealed area, when there is room for it. */
const REVEAL_MARGIN = 12;
/** Sub-pixel differences from layout rounding never justify a scroll. */
const EPSILON = 1;

/**
 * Target offset that brings `target` into view, or null if no scroll is needed.
 *
 * An already fully visible target never scrolls, wherever `keepVisible` sits -
 * that is the normal case on regular screens and must not move anything. Once a
 * scroll happens it is minimal, and `keepVisible` (the pick countdown) wins over
 * the target's lower edge: if both don't fit, `keepVisible` goes to the top of
 * the visible area and the target starts below it, the rest stays one drag away.
 */
export function revealScrollTarget({
  target,
  keepVisible,
  viewport,
}: {
  target: ContentBox;
  keepVisible?: ContentBox | null;
  viewport: ScrollViewportState;
}): number | null {
  const { scrollY, height, contentHeight, topInset, bottomInset } = viewport;
  const visibleBottomEdge = height - bottomInset;
  const targetBottom = target.y + target.height;

  const fullyVisible =
    target.y >= scrollY + topInset - EPSILON &&
    targetBottom <= scrollY + visibleBottomEdge + EPSILON;
  if (fullyVisible) return null;

  const spanTop = Math.min(target.y, keepVisible?.y ?? target.y);
  const spanBottom = Math.max(
    targetBottom,
    keepVisible ? keepVisible.y + keepVisible.height : targetBottom
  );
  const alignTop = spanTop - topInset;
  const alignBottom = spanBottom - visibleBottomEdge;

  let next: number;
  if (spanBottom - spanTop > visibleBottomEdge - topInset) {
    // Doesn't fit: start of the span at the top of the visible area.
    next = alignTop - REVEAL_MARGIN;
  } else if (targetBottom > scrollY + visibleBottomEdge) {
    // Below the fold: just far enough, the margin never pushes the span's top out.
    next = Math.min(alignBottom + REVEAL_MARGIN, alignTop);
  } else {
    // Above the fold (the player scrolled past it).
    next = Math.max(alignTop - REVEAL_MARGIN, alignBottom);
  }

  const maxOffset = Math.max(0, contentHeight - height);
  const clamped = Math.min(maxOffset, Math.max(0, next));
  return Math.abs(clamped - scrollY) < EPSILON ? null : clamped;
}
