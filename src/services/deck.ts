/**
 * Deck source abstraction: a game deck comes from a pre-made themed song pool
 * (Supabase). Loading happens only on the playing device (Hot-Seat device /
 * Online host) — the rest of the flow is unchanged.
 *
 * Spotify playlists used to be a second source here; that path was removed
 * deliberately (Dev-Mode restrictions, see PlaylistPickerScreen). The
 * DeckSource shape (discriminated union with a single member) is kept so the
 * call sites and a possible future second source stay cheap.
 */
import * as Online from './supabase';
import type { SongPool } from '../types/online';
import type { GameCard } from '../types/game';

export type DeckSource = { kind: 'pool'; pool: SongPool };

/** Resolve a deck source to its (unshuffled) GameCards. */
export async function loadDeckSource(src: DeckSource): Promise<GameCard[]> {
  // Pools store no cover art. Deliberately NOT fetched here: covers for a full
  // pool are hundreds of single-track requests and must never block "Spiel
  // starten". The game-start paths fetch the first few urgently
  // (Spotify.addCoverArtUrgent) and the rest in the background
  // (Spotify.startCoverArtPrefetch) once the game is already running.
  return Online.getPoolSongs(src.pool.id);
}

/** Stable identifier for the chosen source (stored in GameSettings.playlistId). */
export function sourceId(src: DeckSource): string {
  return `pool:${src.pool.id}`;
}

/** Display name of the chosen source. */
export function sourceName(src: DeckSource): string {
  return src.pool.name;
}
