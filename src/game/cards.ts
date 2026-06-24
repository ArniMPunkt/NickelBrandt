/**
 * Pure, shared card/deck helpers used by both the Hot-Seat reducer (GameContext)
 * and the Online service (supabase). No React, no IO — safe to import anywhere.
 *
 * (isCorrectPlacement still lives in GameContext to keep this change minimal; it
 * is not duplicated. These three WERE duplicated and are now consolidated here.)
 */
import type { GameCard } from '../types/game';

/** Insert `item` at `index`, returning a new array (does not mutate). */
export function insertAt<T>(arr: T[], item: T, index: number): T[] {
  return [...arr.slice(0, index), item, ...arr.slice(index)];
}

/**
 * The slot at which `year` keeps an ascending-by-year timeline sorted. Equal
 * years sort AFTER existing ones (same as the original implementations).
 */
export function sortedInsertIndex(timeline: GameCard[], year: number): number {
  let i = 0;
  while (i < timeline.length && timeline[i].year <= year) i++;
  return i;
}

/** Fisher-Yates shuffle returning a new array (does not mutate the input). */
export function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
