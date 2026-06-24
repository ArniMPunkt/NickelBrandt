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

// REQUIRED by MusicBrainz: app name + version + a reachable contact (URL or email).
// TODO(contact): the GitHub URL identifies the project; swap in a contact email
// you actually monitor before any public/wider release.
const USER_AGENT = 'NickelBrandt/1.0 ( https://github.com/ArniMPunkt/NickelBrandt )';

// Default "significant deviation" threshold (years). Adjustable.
export const YEAR_DIFF_THRESHOLD = 2;

// --- Burst rate-limit calibration -------------------------------------------
// Official cap is 15 req / 18 s; we stay conservatively under it.
const MB_WINDOW_MS = 18000;
const MB_MAX_PER_WINDOW = 13; // ~13% margin below 15
const MB_CONCURRENCY = 5; // requests in flight per batch (the "burst")
// Multi-ISRC batching: one `isrc:A OR isrc:B ...` query resolves up to this many
// tracks in a SINGLE request - the main speedup. Each returned recording carries
// its own `isrcs`, so results map back to the exact track (verified vs live API).
const MB_ISRC_BATCH = 12;
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

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (e) {
      // Network error: brief backoff + retry, else rethrow.
      lastErr = e;
      if (attempt < MB_MAX_RETRIES) {
        await sleep(MB_BACKOFF_MS);
        continue;
      }
      throw lastErr;
    }

    if (res.status === 503) {
      // Service busy / overloaded -> back off and retry.
      lastErr = new Error('MusicBrainz 503');
      if (attempt < MB_MAX_RETRIES) {
        await sleep(MB_BACKOFF_MS);
        continue;
      }
      throw lastErr;
    }
    // Deterministic non-503 HTTP error (e.g. 400/404): don't waste retries.
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    return res.json();
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
 * Resolve a batch of ISRCs in ONE request via `isrc:A OR isrc:B ...`. Returns a
 * map UPPER(ISRC) -> earliest first-release year found for that ISRC. Each
 * returned recording carries its own `isrcs`, so results map back to the exact
 * track. ISRCs with no match (or only date-less recordings) are simply absent.
 */
async function isrcBatchLookup(isrcs: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (isrcs.length === 0) return out;
  const wanted = new Set(isrcs.map((s) => s.toUpperCase()));
  const q = isrcs.map((c) => `isrc:${c}`).join(' OR ');
  let data: any;
  try {
    data = await mbFetch(`${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=100`);
  } catch {
    return out;
  }
  for (const rec of data?.recordings ?? []) {
    const y = yearFromDate(rec?.['first-release-date']);
    if (y == null) continue;
    for (const isrc of rec?.isrcs ?? []) {
      const key = String(isrc).toUpperCase();
      if (!wanted.has(key)) continue;
      const prev = out.get(key);
      if (prev == null || y < prev) out.set(key, y); // earliest wins
    }
  }
  return out;
}

/** Fallback: title + artist search for one card (the slower, less certain path). */
async function resolveByTitleArtist(card: GameCard): Promise<number | null> {
  try {
    const q = `recording:"${escapeLucene(card.title)}" AND artist:"${escapeLucene(card.artist)}"`;
    const data = await mbFetch(`${MB_BASE}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=10`);
    return earliestYear(data?.recordings);
  } catch {
    return null;
  }
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
 * Check all tracks against MusicBrainz, two phases:
 *   1) Batched ISRC resolution - up to MB_ISRC_BATCH tracks per request, a few
 *      batches in flight under the rate cap. This is where most tracks resolve in
 *      very few requests.
 *   2) Title+artist fallback (one request each) for tracks without an ISRC or
 *      whose ISRC found no dated recording.
 * Reports progress and supports cancellation between batches. Session cache and
 * the rate limiter behave as before; cached tracks skip the network entirely.
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

  const report = (batch: MbProgress | null) => opts.onProgress?.(completed, total, batch);
  const finalize = (i: number, year: number | null, source: MbSource) => {
    const card = cards[i];
    results[i] = {
      card,
      spotifyYear: card.year,
      mbYear: year,
      source,
      diff: year != null ? Math.abs(year - card.year) : null,
    };
    cache.set(cacheKey(card), { year, source });
    completed += 1;
  };

  // --- Phase 0: cache pass (no network) ---
  const pending: number[] = [];
  for (let i = 0; i < total; i++) {
    const hit = cache.get(cacheKey(cards[i]));
    if (hit) {
      results[i] = {
        card: cards[i],
        spotifyYear: cards[i].year,
        mbYear: hit.year,
        source: hit.source,
        diff: hit.year != null ? Math.abs(hit.year - cards[i].year) : null,
      };
      completed += 1;
    } else {
      pending.push(i);
    }
  }
  report(null);

  const withIsrc = pending.filter((i) => !!cards[i].isrc);
  const withoutIsrc = pending.filter((i) => !cards[i].isrc);
  const isrcMisses: number[] = [];

  // --- Phase 1: batched ISRC resolution ---
  const isrcBatches: number[][] = [];
  for (let k = 0; k < withIsrc.length; k += MB_ISRC_BATCH) {
    isrcBatches.push(withIsrc.slice(k, k + MB_ISRC_BATCH));
  }
  for (let g = 0; g < isrcBatches.length; g += MB_CONCURRENCY) {
    if (opts.isCancelled?.()) break;
    const group = isrcBatches.slice(g, g + MB_CONCURRENCY);
    const groupSize = group.reduce((n, idxs) => n + idxs.length, 0);
    report({ from: completed + 1, to: Math.min(completed + groupSize, total) });

    await Promise.all(
      group.map(async (idxs) => {
        if (opts.isCancelled?.()) return;
        const map = await isrcBatchLookup(idxs.map((i) => cards[i].isrc!));
        for (const i of idxs) {
          const y = map.get(cards[i].isrc!.toUpperCase());
          if (y != null) {
            finalize(i, y, 'isrc');
          } else {
            isrcMisses.push(i); // resolved later via title+artist
          }
        }
        report(null);
      })
    );
  }

  // --- Phase 2: title+artist fallback (no-ISRC tracks + ISRC misses) ---
  const fallback = [...withoutIsrc, ...isrcMisses];
  for (let s = 0; s < fallback.length; s += MB_CONCURRENCY) {
    if (opts.isCancelled?.()) break;
    const group = fallback.slice(s, s + MB_CONCURRENCY);
    report({ from: completed + 1, to: Math.min(completed + group.length, total) });

    await Promise.all(
      group.map(async (i) => {
        if (opts.isCancelled?.()) return;
        const y = await resolveByTitleArtist(cards[i]);
        if (y != null) {
          finalize(i, y, 'search');
        } else {
          finalize(i, null, 'none');
        }
      })
    );
  }

  report(null);
  // Drop any holes left by cancellation mid-batch.
  return results.filter(Boolean);
}
