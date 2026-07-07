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
  // Playlists already carry album cover art from the Web API.
  if (src.kind === 'playlist') return Spotify.getPlaylistTracks(src.playlist.id);
  // Pools store no cover art. Deliberately NOT fetched here: covers for a full
  // pool are hundreds of single-track requests and must never block "Spiel
  // starten". The game-start paths fetch the first few urgently
  // (Spotify.addCoverArtUrgent) and the rest in the background
  // (Spotify.startCoverArtPrefetch) once the game is already running.
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
