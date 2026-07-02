/**
 * Types for the Online (Supabase) mode. Reuses GameCard from the Hot-Seat types
 * (types only - the Hot-Seat GameContext/reducer is NOT shared).
 */
import type { GameCard } from './game';

export type { GameCard };

export type LobbyStatus = 'waiting' | 'playing' | 'finished' | 'ended';

/** The lobby's game mode, chosen by the host in the waiting room. */
export type GameMode = 'hitster' | 'bingo' | 'timeline_quiz';

/** Mode-specific config (lobbies.mode_config jsonb; keys per mode, all optional). */
export interface ModeConfig {
  /** Bingo: grid edge length. */
  bingoGridSize?: 4 | 5;
  /** Timeline-Quiz: number of cards to play. */
  timelineCardCount?: number;
}

/** Outcome of one player in a resolved simultaneous round. */
export type RoundOutcome = 'correct' | 'incorrect' | 'missed';

/**
 * Lifecycle of a simultaneous round:
 *   collecting -> answers may be submitted (until deadline / all answered)
 *   resolving  -> transient: a resolver claimed the round (submits now refused)
 *   resolved   -> roundResults written; all clients show the outcome
 */
export type SimulRoundPhase = 'collecting' | 'resolving' | 'resolved';

/** One player's submitted answer of a simultaneous round (round_answers row). */
export interface RoundAnswer {
  id: string;
  lobby_id: string;
  round_number: number;
  player_id: string;
  /** Mode-specific payload (e.g. bingo cell index, timeline slot). */
  answer: unknown;
  submitted_at: string;
}

/** Round phase synced via lobbies.game_state. */
export type OnlinePhase =
  | 'waiting' // game not started
  | 'card_drawn' // active player must pick a position
  | 'hitster_window' // active placed; 5s window for others to call "Hitster!"
  | 'hitster_resolving' // someone claimed the steal; awaiting their slot choice
  | 'awaiting_host_confirmation' // card revealed + placement resolved; host answers title/artist
  | 'simul_round' // bingo / timeline_quiz: the simultaneous roundPhase drives the flow
  | 'finished'; // round result shown (winnerId set => game over)

// --- Bingo mode --------------------------------------------------------------

/**
 * The bingo categories = the cell colors. Only digitally verifiable checks:
 * decade / before-after-2000 / year±N grade against GameCard.year; title_artist
 * uses the Nickel honor pattern (the player's own claim counts).
 * 'band_or_solo' is deliberately NOT here yet: Band vs. Solo is not derivable
 * from GameCard data - it needs artist-type enrichment first (e.g. MusicBrainz
 * artist type Person/Group in the song-pool pipeline).
 */
export type BingoCategoryType =
  | 'decade'
  | 'before_after_2000'
  | 'year_guess'
  | 'title_artist';

export interface BingoCell {
  color: BingoCategoryType;
  marked: boolean;
}

/** Row-major, length = size*size. Stored in lobby_players.bingo_board (jsonb). */
export type BingoBoard = BingoCell[];

/** The current round's spun category ("digitale Discokugel"), synced in game_state. */
export interface BingoRoundSpec {
  type: BingoCategoryType;
  /** decade: the multiple-choice options (decade start years, shuffled). */
  decadeOptions?: number[];
  /** year_guess: allowed absolute deviation from the real year. */
  tolerance?: number;
}

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

  // --- Generic simultaneous-round support (bingo / timeline_quiz) -----------
  // All optional: absent in hitster games / rows written before migration 005.
  /** Snapshot of the lobby's mode at game start ('hitster' when absent). */
  gameMode?: GameMode;
  /** Snapshot of the lobby's mode config at game start. */
  modeConfig?: ModeConfig;
  /** 1-based counter of the current simultaneous round. */
  roundNumber?: number;
  /** Epoch ms deadline of the current round (host writes; clients count down). */
  roundDeadline?: number | null;
  roundPhase?: SimulRoundPhase | null;
  /** Written ONCE at resolution: player_id -> outcome (single writer: host). */
  roundResults?: Record<string, RoundOutcome> | null;
  /** Bingo: the current round's category (drawn together with the card). */
  bingoRound?: BingoRoundSpec | null;
  /**
   * Bingo: ALL players who completed a row/column/diagonal in the same
   * resolution (simultaneous multi-win is allowed). winnerId stays set to the
   * first entry so the shared finish contract (phase 'finished' + winnerId)
   * keeps working everywhere.
   */
  winnerIds?: string[] | null;
}

export interface Lobby {
  id: string;
  code: string;
  host_id: string;
  status: LobbyStatus;
  created_at: string;
  game_state: OnlineGameState | null;
  /** Optional until migration 005 ran; treat absent as 'hitster'. */
  game_mode?: GameMode;
  mode_config?: ModeConfig | null;
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
  /**
   * Bingo mode only (migration 006). Written by startBingoGame (fresh board)
   * and by the round-resolve claim winner (marks) - single writer per round,
   * so a jsonb column on the player row is safe (unlike answers, which are
   * concurrent multi-client writes and therefore live in round_answers).
   */
  bingo_board?: BingoBoard | null;
}
