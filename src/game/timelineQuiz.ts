/**
 * Pure Timeline-Quiz logic (no React, no IO - like cards.ts / bingo.ts).
 *
 * The mode plays on ONE shared timeline for everyone: it starts as pure year
 * slots (no songs behind them) and grows by the real song each round, getting
 * denser and harder. Everyone places the same mystery song independently; a
 * year-valid slot scores a point. Highest score after the configured number of
 * rounds wins (ties share the win, like bingo's multi-win).
 */
import type { GameCard } from '../types/game';
import type { QuizTimelineEntry } from '../types/online';

/** Answer window per round (all clients arm the resolve trigger on this). */
export const QUIZ_ROUND_SECONDS = 30;

/** Number of pure year slots the shared base timeline starts with. */
export const QUIZ_BASE_SLOTS = 10;

/** The answer payload stored in round_answers.answer (jsonb). */
export interface QuizAnswer {
  /** Chosen gap index (0..timeline.length). */
  slot: number;
}

/**
 * The shared base timeline: QUIZ_BASE_SLOTS arbitrary years spread over the
 * span of the chosen song pool (evenly spaced centers + jitter, deduped, so
 * the slots feel random but cover the whole era the songs come from).
 */
export function generateBaseTimeline(
  cards: GameCard[],
  count = QUIZ_BASE_SLOTS
): QuizTimelineEntry[] {
  const years = cards.map((c) => c.year);
  const min = Math.min(...years);
  const max = Math.max(...years);
  const span = Math.max(1, max - min);

  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const center = min + (span * (i + 0.5)) / count;
    const jitter = (Math.random() - 0.5) * (span / count);
    let y = Math.round(Math.min(max, Math.max(min, center + jitter)));
    while (used.has(y)) y++; // dedupe upward (may nudge past max - harmless)
    used.add(y);
  }
  return [...used].sort((a, b) => a - b).map((year) => ({ year }));
}

/**
 * A placement at gap `slot` (0..timeline.length) is correct when the song's
 * year fits between the neighbouring entries. Equal years count as correct -
 * same rule as the hitster placement check.
 */
export function isCorrectQuizPlacement(
  timeline: QuizTimelineEntry[],
  year: number,
  slot: number
): boolean {
  const left = slot > 0 ? timeline[slot - 1].year : -Infinity;
  const right = slot < timeline.length ? timeline[slot].year : Infinity;
  return left <= year && year <= right;
}

/** The index at which `year` keeps the timeline sorted (equal years after). */
export function quizInsertIndex(timeline: QuizTimelineEntry[], year: number): number {
  let i = 0;
  while (i < timeline.length && timeline[i].year <= year) i++;
  return i;
}

/** Insert the resolved song (real year + title) into the shared timeline. */
export function insertQuizEntry(
  timeline: QuizTimelineEntry[],
  entry: QuizTimelineEntry
): QuizTimelineEntry[] {
  const i = quizInsertIndex(timeline, entry.year);
  return [...timeline.slice(0, i), entry, ...timeline.slice(i)];
}
