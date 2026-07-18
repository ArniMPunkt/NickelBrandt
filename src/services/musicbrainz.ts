/**
 * Minimal in-app MusicBrainz client for exactly ONE job: suggest whether the
 * current bingo song's artist is a group or a solo artist ("Gruppe oder
 * Solokünstler" review assist). One targeted artist-search request per active
 * round (never bulk, never for the whole pool), result cached per artist name.
 *
 * The suggestion is a HINT for the host - it never replaces the host's
 * verdict, and the round must never wait on it: hard timeout, all failures
 * collapse to null (the review then shows a manual search link instead).
 *
 * Deliberately separate from the pool pipeline's MusicBrainz code
 * (scripts/lib/…): different client, so it identifies itself with its own
 * User-Agent as the MB etiquette requires.
 */
import Constants from 'expo-constants';

const MB_TIMEOUT_MS = 3500;

const USER_AGENT = `NickelBrandt-App/${Constants.expoConfig?.version ?? 'dev'} ( https://github.com/ArniMPunkt/NickelBrandt )`;

/** MusicBrainz artist types mapped to the binary question. */
export type ArtistKind = 'person' | 'group';

/**
 * First credited artist of a display string like "A feat. B" / "A & B" /
 * "A, B". Separator set mirrors the pool pipeline's proven ARTIST_SEP
 * (feat./ft./featuring/und/&), extended by comma (MusicBrainz artist credits
 * are comma-joined).
 */
export function firstArtist(artistField: string): string {
  return artistField.split(/\s+(?:feat\.?|ft\.?|featuring|und)\s+|\s*[&,]\s*/i)[0].trim();
}

/** Manual MusicBrainz artist search for the review fallback link. */
export function artistSearchUrl(artistField: string): string {
  return `https://musicbrainz.org/search?query=${encodeURIComponent(firstArtist(artistField))}&type=artist`;
}

// One entry per first-artist name; null = lookup failed/inconclusive (also
// cached: retrying a dead lookup within one game session buys nothing).
const cache = new Map<string, ArtistKind | null>();

function mapType(type: unknown): ArtistKind | null {
  if (type === 'Person') return 'person';
  if (type === 'Group' || type === 'Orchestra' || type === 'Choir') return 'group';
  return null;
}

/**
 * Person/Group suggestion for the FIRST credited artist of `artistField`.
 * Resolves null on timeout, network/HTTP errors, no hits or an inconclusive
 * artist type - callers only ever branch on "have a suggestion or not".
 */
export async function lookupArtistKind(artistField: string): Promise<ArtistKind | null> {
  const name = firstArtist(artistField);
  if (!name) return null;
  if (cache.has(name)) return cache.get(name) ?? null;

  let kind: ArtistKind | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MB_TIMEOUT_MS);
  try {
    // Quoted Lucene phrase query on the artist field; inner quotes stripped
    // (they would terminate the phrase).
    const query = `artist:"${name.replace(/"/g, ' ').trim()}"`;
    const res = await fetch(
      `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(query)}&fmt=json&limit=1`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      }
    );
    if (res.ok) {
      const body = (await res.json()) as { artists?: Array<{ type?: string }> };
      kind = mapType(body.artists?.[0]?.type);
    }
  } catch {
    // Timeout/offline/parse - all collapse to "no suggestion".
  } finally {
    clearTimeout(timer);
  }
  cache.set(name, kind);
  return kind;
}
