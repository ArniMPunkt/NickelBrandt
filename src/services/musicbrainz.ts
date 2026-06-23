/**
 * MusicBrainz lookup for a track's ORIGINAL first-release year.
 *
 * Why: Spotify's album.release_date is the date of the *concrete* release the
 * track sits on (a remaster / best-of / compilation), which is often years after
 * the song actually came out. MusicBrainz exposes a dedicated `first-release-date`
 * on the RECORDING level, independent of any particular album - exactly the
 * "when did this song first appear" signal we want.
 *
 * This is a pure fetch() client (no API key, no native module - JS only). It is a
 * read-only DIAGNOSTIC helper: it never changes the deck or the in-game year.
 *
 * MusicBrainz etiquette (enforced here):
 *  - A descriptive User-Agent with contact info is REQUIRED (see USER_AGENT;
 *    replace the placeholder contact with your own).
 *  - Unauthenticated use is limited to ~1 request/second. We enforce this with a
 *    single global gate (rateLimitGate) so EVERY request - regardless of how many
 *    we make per track - starts at least MB_RATE_LIMIT_MS after the previous one.
 *  - Responses are cached in-memory for the session (a song can appear in several
 *    playlists). No persistence across app restarts (by design).
 */
import type { GameCard } from '../types/game';

const MB_BASE = 'https://musicbrainz.org/ws/2';

// REQUIRED by MusicBrainz. PLACEHOLDER: replace the contact below with your own
// email / project URL before sharing builds.
const USER_AGENT = 'NickelBrandt/1.0 ( kontakt@beispiel.de )';

// Unauthenticated limit is ~1 req/s; 1100ms gives a small safety margin.
export const MB_RATE_LIMIT_MS = 1100;

// Default "significant deviation" threshold (years). Adjustable.
export const YEAR_DIFF_THRESHOLD = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Rate-limit gate --------------------------------------------------------
// Spaces the START of consecutive requests by >= MB_RATE_LIMIT_MS. Cached
// lookups never reach here, so re-runs / duplicate songs are not throttled.
let lastRequestAt = 0;
async function rateLimitGate(): Promise<void> {
  const wait = MB_RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function mbFetch(url: string): Promise<any> {
  await rateLimitGate();
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    // 503 = rate limited / service busy; surface a readable error either way.
    throw new Error(`MusicBrainz ${res.status}`);
  }
  return res.json();
}

function yearFromDate(date?: string | null): number | null {
  if (!date) return null;
  const y = parseInt(String(date).slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/** Earliest first-release-date year across a set of recordings (or null). */
function earliestYear(recordings: any[]): number | null {
  let best: number | null = null;
  for (const rec of recordings ?? []) {
    const y = yearFromDate(rec?.['first-release-date']);
    if (y != null && (best == null || y < best)) best = y;
  }
  return best;
}

/** Escape Lucene special handling for the title/artist search query. */
function escapeLucene(s: string): string {
  // Strip quotes/backslashes (we wrap the term in quotes ourselves).
  return s.replace(/["\\]/g, ' ').trim();
}

export type MbSource = 'isrc' | 'search' | 'none';

export interface MbLookupResult {
  year: number | null;
  source: MbSource;
}

// Session cache (keyed by ISRC, else normalized title|artist). No persistence.
const cache = new Map<string, MbLookupResult>();

function cacheKey(card: { isrc?: string; title: string; artist: string }): string {
  return card.isrc
    ? `isrc:${card.isrc.toUpperCase()}`
    : `ta:${card.title.trim().toLowerCase()}|${card.artist.trim().toLowerCase()}`;
}

/**
 * Look up a track's original first-release year.
 *  1) Primary: ISRC search (identifies the exact recording).
 *  2) Fallback: title + artist search (second, less certain stage).
 * Returns the year (or null) plus which path produced it, and whether it came
 * from cache (so the caller can avoid counting it against the rate limit).
 */
export async function lookupFirstReleaseYear(
  card: { isrc?: string; title: string; artist: string }
): Promise<MbLookupResult & { cached: boolean }> {
  const key = cacheKey(card);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  let result: MbLookupResult = { year: null, source: 'none' };

  // 1) Primary: ISRC.
  if (card.isrc) {
    try {
      const data = await mbFetch(
        `${MB_BASE}/recording?query=${encodeURIComponent(`isrc:${card.isrc}`)}&fmt=json`
      );
      const y = earliestYear(data?.recordings);
      if (y != null) result = { year: y, source: 'isrc' };
    } catch (e) {
      console.log('[MusicBrainz] ISRC lookup error:', card.title, String(e));
    }
  }

  // 2) Fallback: title + artist (uncertain).
  if (result.year == null) {
    try {
      const q = `recording:"${escapeLucene(card.title)}" AND artist:"${escapeLucene(card.artist)}"`;
      const data = await mbFetch(
        `${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=10`
      );
      const y = earliestYear(data?.recordings);
      if (y != null) result = { year: y, source: 'search' };
    } catch (e) {
      console.log('[MusicBrainz] search lookup error:', card.title, String(e));
    }
  }

  cache.set(key, result);
  return { ...result, cached: false };
}

export interface TrackYearCheck {
  card: GameCard;
  spotifyYear: number;
  mbYear: number | null;
  source: MbSource;
  /** Absolute year difference, or null when no MusicBrainz year was found. */
  diff: number | null;
}

/**
 * Check every track sequentially against MusicBrainz, throttled by the global
 * rate-limit gate. Reports progress and supports cancellation.
 */
export async function checkPlaylistYears(
  cards: GameCard[],
  opts: {
    onProgress?: (done: number, total: number, current: GameCard | null) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<TrackYearCheck[]> {
  const results: TrackYearCheck[] = [];
  const total = cards.length;
  console.log(`[MusicBrainz] checkPlaylistYears start: ${total} tracks`);

  for (let i = 0; i < total; i++) {
    if (opts.isCancelled?.()) {
      console.log('[MusicBrainz] check cancelled at', i);
      break;
    }
    const card = cards[i];
    opts.onProgress?.(i, total, card);

    let res: MbLookupResult & { cached: boolean } = { year: null, source: 'none', cached: false };
    try {
      res = await lookupFirstReleaseYear(card);
    } catch (e) {
      console.log('[MusicBrainz] lookup failed:', card.title, String(e));
    }

    results.push({
      card,
      spotifyYear: card.year,
      mbYear: res.year,
      source: res.source,
      diff: res.year != null ? Math.abs(res.year - card.year) : null,
    });
  }

  opts.onProgress?.(results.length, total, null);
  console.log(`[MusicBrainz] checkPlaylistYears done: ${results.length}/${total}`);
  return results;
}
