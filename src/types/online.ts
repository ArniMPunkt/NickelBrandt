/**
 * Types for the Online (Supabase) mode. Reuses GameCard from the Hot-Seat types
 * (types only - the Hot-Seat GameContext/reducer is NOT shared).
 */
import type { GameCard } from './game';

export type { GameCard };

export type LobbyStatus = 'waiting' | 'playing' | 'finished';

/** Round phase synced via lobbies.game_state. */
export type OnlinePhase =
  | 'waiting' // game not started
  | 'card_drawn' // active player must pick a position
  | 'placing' // position chosen, awaiting host confirm + resolve
  | 'revealing' // result shown; host draws next
  | 'finished';

/** The whole synced round state (stored in lobbies.game_state jsonb). */
export interface OnlineGameState {
  /** Remaining cards, drawn from the front. */
  deck: GameCard[];
  /** The card currently being placed (null between games). */
  currentCard: GameCard | null;
  /** Whose turn it is (player_id). */
  activePlayerId: string;
  phase: OnlinePhase;
  /** The active player's chosen slot, before the host resolves it. */
  pendingInsertIndex: number | null;
  /** Result of the resolved placement, for the reveal UI. */
  lastResult: 'correct' | 'incorrect' | null;
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
