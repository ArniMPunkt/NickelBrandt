/**
 * Deck source abstraction: a game deck can come from EITHER a Spotify playlist or
 * a pre-made themed song pool. Both resolve to the same GameCard[] (which is then
 * shuffled exactly as before). Loading happens only on the playing device
 * (Hot-Seat device / Online host) — the rest of the flow is unchanged.
 */
import * as Spotify from './spotify';
import * as Online from './supabase';
import type { PlaylistSummary } from './spotify';
import type { SongPool } from '../types/online';
import type { GameCard } from '../types/game';

export type DeckSource =
  | { kind: 'playlist'; playlist: PlaylistSummary }
  | { kind: 'pool'; pool: SongPool };

/** Resolve a deck source to its (unshuffled) GameCards. */
export async function loadDeckSource(src: DeckSource): Promise<GameCard[]> {
  if (src.kind === 'playlist') return Spotify.getPlaylistTracks(src.playlist.id);
  return Online.getPoolSongs(src.pool.id);
}

/** Stable identifier for the chosen source (stored in GameSettings.playlistId). */
export function sourceId(src: DeckSource): string {
  return src.kind === 'playlist' ? src.playlist.id : `pool:${src.pool.id}`;
}

/** Display name of the chosen source. */
export function sourceName(src: DeckSource): string {
  return src.kind === 'playlist' ? src.playlist.name : src.pool.name;
}
