/**
 * Pure aggregation of the per-match stats history (MatchEvent log) into the
 * per-player categories shown on the post-game statistics screens. Shared by
 * BOTH code worlds (Pass & Play ResultScreen + Party > Hitster end view) -
 * the worlds only differ in where the log lives (GameState.history vs.
 * OnlineGameState.statsHistory) and how player ids map to names.
 */
import type { MatchEvent, StatsSong } from '../types/game';

/** A resolved steal attempt, with the other player's id (victim/owner). */
export interface StealEntry {
  song: StatsSong;
  /** The active player whose turn/card it was. */
  victimId: string;
}

/** One player's aggregated match statistics. */
export interface PlayerMatchStats {
  /** Own placements that were correct. */
  placedCorrect: StatsSong[];
  /** Own placements that were wrong. */
  placedWrong: StatsSong[];
  /** Successful "Hitster!" steals (card won). */
  stealsWon: StealEntry[];
  /** Failed steal attempts ("verbrandt" - chip spent, guessed wrong). */
  stealsFailed: StealEntry[];
  /** Nickel actually received; song is set when the trigger is known. */
  nickels: Array<StatsSong | undefined>;
}

/** True when a player has nothing to show at all (fresh joiner, no events). */
export function isEmptyStats(s: PlayerMatchStats): boolean {
  return (
    s.placedCorrect.length === 0 &&
    s.placedWrong.length === 0 &&
    s.stealsWon.length === 0 &&
    s.stealsFailed.length === 0 &&
    s.nickels.length === 0
  );
}

/** Aggregate the match history for ONE player (chronological order kept). */
export function buildPlayerMatchStats(
  history: MatchEvent[],
  playerId: string
): PlayerMatchStats {
  const stats: PlayerMatchStats = {
    placedCorrect: [],
    placedWrong: [],
    stealsWon: [],
    stealsFailed: [],
    nickels: [],
  };
  for (const e of history) {
    if (e.playerId !== playerId) continue;
    switch (e.type) {
      case 'place':
        (e.correct ? stats.placedCorrect : stats.placedWrong).push(e.song);
        break;
      case 'steal':
        (e.correct ? stats.stealsWon : stats.stealsFailed).push({
          song: e.song,
          victimId: e.victimId,
        });
        break;
      case 'nickel':
        stats.nickels.push(e.song);
        break;
    }
  }
  return stats;
}
