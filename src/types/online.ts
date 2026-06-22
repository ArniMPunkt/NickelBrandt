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
  /** The steal's outcome (caller prediction), or null if no steal happened. */
  stealResult: 'correct' | 'incorrect' | null;
  /** Turn rotation order (player_ids, join order). */
  turnOrder: string[];
  cardsToWin: number;
  hideCoverUntilRevealed: boolean;
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
  brandts_count: number;
}
