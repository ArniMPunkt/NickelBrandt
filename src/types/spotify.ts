/**
 * Track metadata shown by the Spike screen.
 * Combines what the Remote SDK exposes with what we fetch from the Web API
 * (release year + a usable album cover URL are not in the Remote PlayerState).
 */
export interface TrackMeta {
  title: string;
  artist: string;
  /** First 4 chars of album.release_date (Spotify returns full date or just year). */
  year: string;
  /** Album cover image URL (largest available), or undefined if none. */
  coverUrl?: string;
}
