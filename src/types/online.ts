/**
 * Types for the Online (Supabase) mode. Reuses GameCard from the Hot-Seat types
 * (types only - the Hot-Seat GameContext/reducer is NOT shared).
 */
import type { GameCard } from './game';

export type { GameCard };

export type LobbyStatus = 'waiting' | 'playing' | 'finished' | 'ended';

/** Round phase synced via lobbies.game_state. */
export type OnlinePhase =
  | 'waiting' // game not started
  | 'card_drawn' // active player must pick a position
  | 'hitster_window' // active placed; 5s window for others to call "Hitster!"
  | 'hitster_resolving' // someone claimed the steal; awaiting their slot choice
  | 'awaiting_host_confirmation' // card revealed + placement resolved; host answers title/artist
  | 'finished'; // round result shown (winnerId set => game over)

/** The whole synced round state (stored in lobbies.game_state jsonb). */
export interface OnlineGameState {
  /** Remaining cards, drawn from the front. */
  deck: GameCard[];
  /** The card currently being placed (null between games). */
  currentCard: GameCard | null;
  /** Whose turn it is (player_id). */
  activePlayerId: string;
  phase: OnlinePhase;
  /** The active player's chosen slot, before the round is resolved. */
  pendingInsertIndex: number | null;
  /** Result of the active player's own placement, for the reveal UI. */
  lastResult: 'correct' | 'incorrect' | null;
  /** Who won the "Hitster!" call this turn (player_id), or null. */
  hitsterCallerId: string | null;
  /**
   * Player ids who pressed "Kein Hitster" this turn (reset each round). When all
   * potential stealers (non-active players with >=1 Nickel) have either stolen or
   * passed, the window closes early. Optional for backward-compat with rows
   * written before this field existed.
   */
  passedHitster?: string[];
  /** The steal's outcome (caller prediction), or null if no steal happened. */
  stealResult: 'correct' | 'incorrect' | null;
  /**
   * True when the steal missed ONLY because the active player was also correct at
   * an equal-year slot (both slots year-valid). Drives the "Gleiches Jahr, beide
   * Plätze richtig" reveal message. Optional for backward-compat.
   */
  stealEqualYear?: boolean;
  /** Turn rotation order (player_ids, join order). */
  turnOrder: string[];
  cardsToWin: number;
  hideCoverUntilRevealed: boolean;
  /**
   * "Karte überspringen" / "Karte ohne Raten ziehen" rule config, taken from the
   * HOST's settings at game start. All optional for backward-compat with
   * game_state rows written before these fields existed (absent = disabled).
   */
  skipEnabled?: boolean;
  skipCost?: number;
  blindEnabled?: boolean;
  blindCost?: number;
  /** Music timer (host settings): hard-stop the song after timerSeconds. */
  timerEnabled?: boolean;
  timerSeconds?: number;
  /**
   * Epoch ms when the current turn's song started (written on every draw AND on
   * a skip - the replacement song restarts the timer). Clients derive the
   * countdown locally from this; only the HOST's timer pauses the music.
   */
  turnStartedAt?: number | null;
  winnerId: string | null;
}

export interface Lobby {
  id: string;
  code: string;
  host_id: string;
  status: LobbyStatus;
  created_at: string;
  game_state: OnlineGameState | null;
}

/** A pre-made themed song pool (reference data in Supabase, read-only for the app). */
export interface SongPool {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface LobbyPlayer {
  id: string;
  lobby_id: string;
  player_name: string;
  player_id: string;
  is_host: boolean;
  joined_at: string;
  timeline: GameCard[];
  score: number;
  chips: number;
  /** Running count of consecutive correct OWN placements (resets on a miss). */
  current_streak: number;
  /** "Brandt": best hot-streak of correct own placements this game (not steals). */
  max_brandt_streak: number;
}
