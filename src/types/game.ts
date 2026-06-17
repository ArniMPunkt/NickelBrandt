/**
 * Core domain types for the Hot-Seat (single-device, pass-and-play) game.
 *
 * Rules (digital Hitster): each player owns an ordered timeline of cards
 * (revealed, with year). On their turn a player hears a track and must slot it
 * between two of their existing cards (or before/after all). Correct = the card
 * stays; wrong = discarded. First to place X cards correctly wins.
 */

/** A single track/card in the game. */
export interface GameCard {
  /** Stable id (we use the Spotify track URI). */
  id: string;
  trackUri: string;
  title: string;
  artist: string;
  /** Release year as a number (from release_date.substring(0,4)). */
  year: number;
  coverUrl?: string;
}

/** A player's ordered timeline of revealed cards (ascending by year). */
export type PlayerTimeline = GameCard[];

export interface Player {
  id: string;
  name: string;
  /** Revealed cards, kept sorted ascending by year. Includes the free start card. */
  timeline: PlayerTimeline;
  /** Number of cards placed correctly (the free start card does NOT count). */
  score: number;
}

export type GamePhase = 'setup' | 'playing' | 'result';

export interface GameSettings {
  /** Correct placements needed to win (default 10). */
  cardsToWin: number;
  /** Spotify playlist id the deck was built from. */
  playlistId: string;
  /**
   * When true, the cover/title/artist stay hidden ("????") until the card is
   * placed (for title/artist-guessing variants). Default false.
   */
  hideCoverUntilRevealed: boolean;
}

export type PlacementResult = 'correct' | 'incorrect';

/** Snapshot of the most recent placement, used to reveal the result on screen. */
export interface LastPlacement {
  result: PlacementResult;
  /** The card that was just placed (year now revealed). */
  card: GameCard;
  /** The insert slot that was chosen (0..timeline.length). */
  insertIndex: number;
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  currentPlayerIndex: number;
  /** The track currently being placed (year hidden until placed). */
  currentCard: GameCard | null;
  /** Remaining shuffled cards still to be drawn. */
  deck: GameCard[];
  settings: GameSettings;
  winner: Player | null;
  lastPlacement: LastPlacement | null;
}
