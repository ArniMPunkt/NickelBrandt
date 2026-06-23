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
 *  - The official allowance is 15 requests / 18 s (a ROLLING window, not strict
 *    1/s spacing). We burst under a conservative sliding-window cap: up to
 *    MB_MAX_PER_WINDOW actual requests in any MB_WINDOW_MS, dispatched with
 *    MB_CONCURRENCY in flight at once. Counting REAL requests (not tracks) keeps
 *    the cap valid even though a track may cost 1 (ISRC) or 2 (ISRC + fallback)
 *    requests. Cached lookups never hit the network, so they are unthrottled.
 *  - 503 (service busy) responses back off and retry a few times before the track
 *    is recorded as no-match.
 *  - Responses are cached in-memory for the session (a song can appear in several
 *    playlists). No persistence across app restarts (by design).
 */
import type { GameCard } from '../types/game';

const MB_BASE = 'https://musicbrainz.org/ws/2';

// REQUIRED by MusicBrainz. PLACEHOLDER: replace the contact below with your own
// email / project URL before sharing builds.
const USER_AGENT = 'NickelBrandt/1.0 ( kontakt@beispiel.de )';

// Default "significant deviation" threshold (years). Adjustable.
export const YEAR_DIFF_THRESHOLD = 2;

// --- Burst rate-limit calibration -------------------------------------------
// Official cap is 15 req / 18 s; we stay conservatively under it.
const MB_WINDOW_MS = 18000;
const MB_MAX_PER_WINDOW = 13; // ~13% margin below 15
const MB_CONCURRENCY = 5; // requests in flight per batch (the "burst")
// 503 retry/backoff (service busy).
const MB_MAX_RETRIES = 2; // => up to 3 attempts total
const MB_BACKOFF_MS = 2500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Sliding-window rate limiter --------------------------------------------
// Records the start time of each real request and never lets more than
// MB_MAX_PER_WINDOW timestamps live inside the trailing MB_WINDOW_MS. The
// check-and-record step is synchronous (no await between reading length and
// pushing), so concurrent callers can't over-count. Cached lookups skip this.
const requestTimes: number[] = [];

async function acquireRequestSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] >= MB_WINDOW_MS) {
      requestTimes.shift();
    }
    if (requestTimes.length < MB_MAX_PER_WINDOW) {
      requestTimes.push(now);
      return;
    }
    // Window full: wait until the oldest request ages out (+ small slack).
    await sleep(MB_WINDOW_MS - (now - requestTimes[0]) + 20);
  }
}

async function mbFetch(url: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MB_MAX_RETRIES; attempt++) {
    await acquireRequestSlot();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.status === 503) {
        // Service busy / overloaded -> back off and retry.
        lastErr = new Error('MusicBrainz 503');
        console.log(`[MusicBrainz] 503 (attempt ${attempt + 1}/${MB_MAX_RETRIES + 1}) -> backoff`);
        if (attempt < MB_MAX_RETRIES) {
          await sleep(MB_BACKOFF_MS);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
      return res.json();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : '';
      // Deterministic non-503 HTTP error (e.g. 400/404): don't waste retries.
      if (msg.startsWith('MusicBrainz ') && !msg.includes('503')) throw e;
      // Network error (or final 503): brief backoff + retry, else rethrow.
      if (attempt < MB_MAX_RETRIES) {
        await sleep(MB_BACKOFF_MS);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('MusicBrainz request failed');
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

/** The 1-based range of tracks currently being checked in the active batch. */
export interface MbProgress {
  from: number;
  to: number;
}

/**
 * Check all tracks against MusicBrainz in parallel bursts (MB_CONCURRENCY in
 * flight), under the sliding-window rate cap. Reports progress per batch and
 * after each completion, and supports cancellation between batches.
 */
export async function checkPlaylistYears(
  cards: GameCard[],
  opts: {
    onProgress?: (done: number, total: number, batch: MbProgress | null) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<TrackYearCheck[]> {
  const total = cards.length;
  const results: TrackYearCheck[] = new Array(total);
  let completed = 0;
  console.log(`[MusicBrainz] checkPlaylistYears start: ${total} tracks (concurrency ${MB_CONCURRENCY})`);

  for (let start = 0; start < total; start += MB_CONCURRENCY) {
    if (opts.isCancelled?.()) {
      console.log('[MusicBrainz] check cancelled at', start);
      break;
    }
    const batch = cards.slice(start, start + MB_CONCURRENCY);
    const from = start + 1;
    const to = start + batch.length;
    opts.onProgress?.(completed, total, { from, to });

    await Promise.all(
      batch.map(async (card, j) => {
        if (opts.isCancelled?.()) return;
        let res: MbLookupResult & { cached: boolean } = {
          year: null,
          source: 'none',
          cached: false,
        };
        try {
          res = await lookupFirstReleaseYear(card);
        } catch (e) {
          console.log('[MusicBrainz] lookup failed:', card.title, String(e));
        }
        results[start + j] = {
          card,
          spotifyYear: card.year,
          mbYear: res.year,
          source: res.source,
          diff: res.year != null ? Math.abs(res.year - card.year) : null,
        };
        completed += 1;
        opts.onProgress?.(completed, total, { from, to });
      })
    );
  }

  opts.onProgress?.(completed, total, null);
  console.log(`[MusicBrainz] checkPlaylistYears done: ${completed}/${total}`);
  // Drop any holes left by cancellation mid-batch.
  return results.filter(Boolean);
}
