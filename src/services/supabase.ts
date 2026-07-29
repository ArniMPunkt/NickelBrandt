/**
 * Supabase client + Online lobby helpers.
 *
 * Pure JS (no native module) - @supabase/supabase-js uses fetch + WebSocket,
 * which RN provides. `react-native-url-polyfill/auto` is imported first so URL
 * parsing works reliably in RN.
 *
 * Identity: there is no login. A random player_id is generated once per install
 * and PERSISTED via expo-secure-store (see initPlayerId / getPlayerId), so it is
 * stable across app restarts. Note: @supabase/supabase-js itself is pure JS, but
 * the project now uses expo-secure-store (native) for persistence -> a rebuild is
 * required after this change.
 */
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { isCorrectPlacement } from '../context/GameContext';
import { insertAt, neighborYears, sortedInsertIndex, shuffle } from '../game/cards';
import * as Spotify from './spotify';
import {
  BINGO_PICK_SECONDS,
  BINGO_COUNTDOWN_MS,
  BINGO_REVIEW_SECONDS,
  BINGO_ROUND_SECONDS,
  BINGO_SPIN_MS,
  BINGO_SPIN_OPEN_ALL_MS,
  bandAnswerGroup,
  countMarked,
  decadeRange,
  yearBounds,
  drawBingoRound,
  evaluateBingoAnswer,
  freeCellIndices,
  generateBingoBoard,
  hasBingo,
  markCell,
  titleAnswerText,
} from '../game/bingo';
import {
  QUIZ_ROUND_SECONDS,
  generateBaseTimeline,
  insertQuizEntry,
  isCorrectQuizPlacement,
} from '../game/timelineQuiz';
import { MAX_CHIPS, toStatsSong } from '../types/game';
import type {
  BingoDifficulty,
  GameCard,
  GameMode,
  HitsterQueueEntry,
  Lobby,
  LobbyPlayer,
  MatchEvent,
  ModeConfig,
  OnlineGameState,
  RoundAnswer,
  RoundOutcome,
  SongPool,
} from '../types/online';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export function isSupabaseConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

// --- Server clock (shared time reference across devices) ---------------------
//
// The simultaneous rounds coordinate via ABSOLUTE epoch timestamps in
// game_state (spinStartedAt, roundDeadline, ...). Writing them with the
// writer's Date.now() and comparing against each reader's Date.now() silently
// assumes all device clocks agree - but they don't (an Android emulator's
// clock drifts by many seconds after the host PC sleeps). Observed effect: the
// bingo wheel/countdown was skipped entirely on a device whose clock ran ~9s
// ahead of the spinner's, giving it the answer UI ~9s early.
//
// Fix: every device estimates its offset to the SUPABASE SERVER clock once
// (Date response header of a cheap HEAD request, midpoint-compensated for
// latency, +500ms for the header's whole-second truncation) and uses
// serverNow() wherever cross-device timestamps are written or compared.
// Residual error is well under a second - vs. arbitrary device skew.

let serverClockOffsetMs = 0;

/**
 * Estimate the local-clock -> server-clock offset. Fire-and-forget on the
 * screens that consume shared timestamps (lobby + simultaneous-round modes);
 * until it resolves, serverNow() falls back to the untouched local clock.
 */
export async function syncServerClock(): Promise<void> {
  try {
    const t0 = Date.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    const header = res.headers.get('date');
    if (!header) return;
    const server = Date.parse(header);
    if (!Number.isFinite(server)) return;
    const mid = (t0 + Date.now()) / 2;
    serverClockOffsetMs = server + 500 - mid;
  } catch {
    // Offline etc. -> keep the previous offset (0 = trust the local clock).
  }
}

/** Best-known server time (epoch ms). The shared clock for synced timestamps. */
export function serverNow(): number {
  return Date.now() + serverClockOffsetMs;
}

// --- Identity ---------------------------------------------------------------

const PLAYER_ID_STORE_KEY = 'nb.online.playerId';
let cachedPlayerId: string | null = null;

/**
 * Load (or create + persist) the stable per-install player id from encrypted
 * storage. Call once at app start (App.tsx) so getPlayerId() returns the
 * persisted id. Prefers a stored id over any in-memory fallback.
 */
export async function initPlayerId(): Promise<string> {
  try {
    const stored = await SecureStore.getItemAsync(PLAYER_ID_STORE_KEY);
    if (stored) {
      cachedPlayerId = stored;
      return stored;
    }
  } catch {
    // SecureStore unavailable (e.g. before a rebuild) -> fall back to in-memory.
  }
  if (!cachedPlayerId) cachedPlayerId = Crypto.randomUUID();
  try {
    await SecureStore.setItemAsync(PLAYER_ID_STORE_KEY, cachedPlayerId);
  } catch {
    // ignore - stays in-memory for this session
  }
  return cachedPlayerId;
}

/**
 * Synchronous accessor (used in render). Returns the loaded/persisted id once
 * initPlayerId() has run; before that it returns an in-memory fallback (it does
 * NOT persist, so it can't clobber a stored id that initPlayerId will load).
 */
export function getPlayerId(): string {
  if (!cachedPlayerId) cachedPlayerId = Crypto.randomUUID();
  return cachedPlayerId;
}

// --- Last active lobby (resume after app restart) ---------------------------

const LAST_LOBBY_STORE_KEY = 'nb.online.lastLobbyId';

// In-memory holder for the "resume your lobby" suggestion, computed once at app
// start by initResumableLobby(). OnlineHomeScreen subscribes to render a banner.
let resumableLobby: Lobby | null = null;
const resumeListeners = new Set<() => void>();

function setResumableLobby(lobby: Lobby | null): void {
  resumableLobby = lobby;
  resumeListeners.forEach((fn) => fn());
}

/** Sync accessor for the resume suggestion (used in render). */
export function getResumableLobby(): Lobby | null {
  return resumableLobby;
}

/** Subscribe to resume-suggestion changes; returns an unsubscribe function. */
export function subscribeResumableLobby(fn: () => void): () => void {
  resumeListeners.add(fn);
  return () => {
    resumeListeners.delete(fn);
  };
}

/** Dismiss the resume suggestion for this session (does NOT delete the stored id). */
export function dismissResumableLobby(): void {
  setResumableLobby(null);
}

/** Remember the lobby this device last joined/created, for resume after restart. */
async function saveLastLobbyId(lobbyId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(LAST_LOBBY_STORE_KEY, lobbyId);
  } catch {
    // SecureStore unavailable -> resume is simply not offered next start.
  }
}

/** Forget the last active lobby (on explicit leave, host-end, or stale check). */
export async function clearLastLobbyId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(LAST_LOBBY_STORE_KEY);
  } catch {
    // ignore
  }
  // Whenever the stored id is gone, the resume suggestion is no longer valid.
  dismissResumableLobby();
}

/**
 * App-start check: if a last-active lobby was stored, verify it still exists,
 * is not ended/finished, and that THIS device's player is still a member. If so,
 * publish it as a resume suggestion; otherwise clear the stale id. Requires
 * initPlayerId() to have run first (uses getPlayerId()).
 */
export async function initResumableLobby(): Promise<void> {
  let storedId: string | null = null;
  try {
    storedId = await SecureStore.getItemAsync(LAST_LOBBY_STORE_KEY);
  } catch {
    storedId = null;
  }
  if (!storedId) {
    setResumableLobby(null);
    return;
  }
  try {
    const { data: lobby } = await supabase
      .from('lobbies')
      .select('*')
      .eq('id', storedId)
      .maybeSingle();

    if (!lobby || lobby.status === 'ended' || lobby.status === 'finished') {
      await clearLastLobbyId();
      setResumableLobby(null);
      return;
    }

    const playerId = getPlayerId();
    const { data: mine } = await supabase
      .from('lobby_players')
      .select('id')
      .eq('lobby_id', storedId)
      .eq('player_id', playerId)
      .maybeSingle();

    if (!mine) {
      await clearLastLobbyId();
      setResumableLobby(null);
      return;
    }

    setResumableLobby(lobby as Lobby);
  } catch {
    setResumableLobby(null);
  }
}

// --- Realtime channel naming ------------------------------------------------

// Each subscription gets a UNIQUE channel topic. supabase.channel(topic) returns
// the cached channel for a repeated topic - and you cannot add postgres_changes
// listeners after subscribe(). A unique suffix guarantees a fresh channel per
// call, so two screens (or an old + reconnected subscription) never collide.
let channelSeq = 0;
function uniqueChannelTopic(prefix: string): string {
  channelSeq += 1;
  return `${prefix}:${channelSeq}`;
}

// --- Lobby code -------------------------------------------------------------

// Unambiguous alphabet (no O/0, I/1).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// --- Lobby operations -------------------------------------------------------

/** Create a new lobby (status 'waiting') and add the creator as host player. */
export async function createLobby(playerName: string): Promise<Lobby> {
  const hostId = getPlayerId();

  // Retry on the (rare) unique-code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data: lobby, error } = await supabase
      .from('lobbies')
      .insert({ code, host_id: hostId, status: 'waiting' })
      .select()
      .single();

    if (error) {
      // 23505 = unique_violation (code already taken) -> try another code.
      if ((error as any).code === '23505') continue;
      throw new Error(`Lobby konnte nicht erstellt werden: ${error.message}`);
    }

    const { error: playerError } = await supabase.from('lobby_players').insert({
      lobby_id: lobby.id,
      player_name: playerName.trim(),
      player_id: hostId,
      is_host: true,
    });
    if (playerError) {
      throw new Error(`Beitritt als Host fehlgeschlagen: ${playerError.message}`);
    }
    await saveLastLobbyId(lobby.id);
    return lobby as Lobby;
  }
  throw new Error('Lobby-Code konnte nicht erzeugt werden. Bitte erneut versuchen.');
}

/** Join an existing 'waiting' lobby by code. */
export async function joinLobby(playerName: string, code: string): Promise<Lobby> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== 6) {
    throw new Error('Der Code muss 6 Zeichen lang sein.');
  }

  const { data: lobby, error } = await supabase
    .from('lobbies')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error) throw new Error(`Lobby-Suche fehlgeschlagen: ${error.message}`);
  if (!lobby) throw new Error('Keine Lobby mit diesem Code gefunden.');
  if (lobby.status !== 'waiting') {
    throw new Error('Diese Lobby wurde bereits gestartet.');
  }

  const playerId = getPlayerId();

  // Avoid a duplicate row if this device is already in the lobby.
  const { data: existing } = await supabase
    .from('lobby_players')
    .select('id')
    .eq('lobby_id', lobby.id)
    .eq('player_id', playerId)
    .maybeSingle();

  if (!existing) {
    const { error: insertError } = await supabase.from('lobby_players').insert({
      lobby_id: lobby.id,
      player_name: playerName.trim(),
      player_id: playerId,
      is_host: false,
    });
    if (insertError) {
      throw new Error(`Beitritt fehlgeschlagen: ${insertError.message}`);
    }
  }
  await saveLastLobbyId(lobby.id);
  return lobby as Lobby;
}

/** Remove this device's player row from a lobby. */
export async function leaveLobby(lobbyId: string): Promise<void> {
  // A background cover prefetch must not outlive the lobby it was started for.
  Spotify.abortCoverArtFetch();
  const playerId = getPlayerId();
  await supabase
    .from('lobby_players')
    .delete()
    .eq('lobby_id', lobbyId)
    .eq('player_id', playerId);
  // No longer in this lobby -> drop the resume suggestion + stored id.
  await clearLastLobbyId();
  dismissResumableLobby();
}

/**
 * Host ends the whole lobby/round: set status 'ended'. All other devices detect
 * this via their realtime subscription and navigate back to the Online home.
 */
export async function endLobby(lobbyId: string): Promise<void> {
  // A background cover prefetch must not outlive the lobby it was started for.
  Spotify.abortCoverArtFetch();
  const { error } = await supabase
    .from('lobbies')
    .update({ status: 'ended' })
    .eq('id', lobbyId);
  if (error) throw new Error(`Lobby konnte nicht beendet werden: ${error.message}`);
  await clearLastLobbyId();
  dismissResumableLobby();
}

/**
 * Host: reopen a finished lobby for a rematch - status 'finished' -> 'waiting'
 * (same code, same lobby_players roster; connected devices watch the status
 * and return to the waiting room automatically, no re-join). game_state is
 * deliberately left untouched: the finished match's stats history stays
 * readable until the next start overwrites it wholesale (every start function
 * writes a complete fresh game_state, and the simul modes additionally clear
 * leftover round_answers). Guarded on status='finished' so a double tap or a
 * stale client can never clobber an ended lobby or a game that already
 * restarted.
 */
export async function reopenLobby(lobbyId: string): Promise<void> {
  const { error } = await supabase
    .from('lobbies')
    .update({ status: 'waiting' })
    .eq('id', lobbyId)
    .eq('status', 'finished');
  if (error) throw new Error(`Lobby konnte nicht neu geöffnet werden: ${error.message}`);
}

/** Fetch the current players of a lobby (ordered by join time). */
export async function getLobbyPlayers(lobbyId: string): Promise<LobbyPlayer[]> {
  const { data, error } = await supabase
    .from('lobby_players')
    .select('*')
    .eq('lobby_id', lobbyId)
    .order('joined_at', { ascending: true });
  if (error) throw new Error(`Spielerliste konnte nicht geladen werden: ${error.message}`);
  const players = (data ?? []) as LobbyPlayer[];
  return players;
}

/**
 * Subscribe to live INSERT/UPDATE/DELETE on lobby_players for one lobby.
 * Returns an unsubscribe function. The caller re-fetches on each change.
 */
export function subscribeToLobbyPlayers(
  lobbyId: string,
  onChange: () => void
): () => void {
  const channel = supabase
    .channel(uniqueChannelTopic(`lobby_players:${lobbyId}`))
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'lobby_players',
        filter: `lobby_id=eq.${lobbyId}`,
      },
      () => {
        onChange();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// --- Themed song pools (pre-made reference data) ----------------------------
// Read-only for the app via the anon key (migration 004 grants SELECT to anon).
// Used as an alternative deck source to a Spotify playlist (Hot-Seat + Online).

/**
 * Fetch the list of available themed song pools (name, description, icon).
 * Deliberately select('*') instead of an explicit column list: icon_url only
 * exists once migration 010 is applied - an explicit list would break pool
 * loading on a database that doesn't have the column yet, '*' just omits it
 * (the UI then shows the 🎵 fallback).
 */
export async function getSongPools(): Promise<SongPool[]> {
  const { data, error } = await supabase
    .from('song_pools')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Themen-Pools konnten nicht geladen werden: ${error.message}`);
  return (data ?? []) as SongPool[];
}

/** Number of songs in a pool (head-only count query, no rows transferred). */
export async function getPoolSongCount(poolId: string): Promise<number> {
  const { count, error } = await supabase
    .from('pool_songs')
    .select('*', { count: 'exact', head: true })
    .eq('pool_id', poolId);
  if (error) throw new Error(`Pool-Größe konnte nicht geladen werden: ${error.message}`);
  return count ?? 0;
}

/**
 * Load all songs of a pool as GameCards (shuffled into the deck by the caller).
 * Uses the verified release_year directly (no runtime MusicBrainz). Cover art is
 * not stored in the pool, so coverUrl is left undefined (the UI shows a fallback).
 */
export async function getPoolSongs(poolId: string): Promise<GameCard[]> {
  const { data, error } = await supabase
    .from('pool_songs')
    .select('title, artist, spotify_track_id, release_year, isrc')
    .eq('pool_id', poolId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Pool-Songs konnten nicht geladen werden: ${error.message}`);
  const rows = (data ?? []) as Array<{
    title: string;
    artist: string;
    spotify_track_id: string;
    release_year: number;
    isrc: string | null;
  }>;
  return rows.map((r) => {
    const uri = `spotify:track:${r.spotify_track_id}`;
    return {
      id: uri,
      trackUri: uri,
      title: r.title,
      artist: r.artist,
      year: r.release_year,
      coverUrl: undefined,
      isrc: r.isrc ?? undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Game state + distributed Hitster (Etappe 4).
//
// Race safety:
//  - Per-turn writers act on disjoint data and are gated by phase + role.
//  - The "Hitster!" call is contended (any non-active player may press), so it is
//    claimed ATOMICALLY: callHitster / closeHitsterWindow update the row only
//    WHERE game_state->>phase = 'hitster_window' AND game_state->>hitsterCallerId
//    IS NULL. Postgres row locks + WHERE re-evaluation under READ COMMITTED mean
//    exactly one of N concurrent writers matches (the others affect 0 rows). No
//    Postgres function / migration is required for this.
// ---------------------------------------------------------------------------

export async function getLobby(lobbyId: string): Promise<Lobby> {
  const { data, error } = await supabase
    .from('lobbies')
    .select('*')
    .eq('id', lobbyId)
    .single();
  if (error) throw new Error(`Lobby konnte nicht geladen werden: ${error.message}`);
  return data as Lobby;
}

/**
 * Append post-game-statistics events to game_state.statsHistory (hitster
 * mode). Only called from single-writer paths (atomic window close, steal
 * resolution, host confirm), so the jsonb read-modify-write is race-free.
 * Tolerates rows written before the field existed.
 */
function appendStats(gs: OnlineGameState, ...events: MatchEvent[]): MatchEvent[] {
  return [...(gs.statsHistory ?? []), ...events];
}

async function writeGameState(lobbyId: string, gameState: OnlineGameState): Promise<void> {
  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: gameState })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spielzustand konnte nicht gespeichert werden: ${error.message}`);
}

/**
 * Host starts the game: deal a start card to each player, draw the first card,
 * set the turn order + active player, mark the lobby 'playing'.
 * `cards` are the full GameCards loaded by the host (needed so EVERY device can
 * render card details - only the host has a Spotify connection).
 */
export async function startGame(
  lobbyId: string,
  cards: GameCard[],
  opts: {
    cardsToWin: number;
    hideCoverUntilRevealed: boolean;
    skipEnabled: boolean;
    skipCost: number;
    blindEnabled: boolean;
    blindCost: number;
    timerEnabled: boolean;
    timerSeconds: number;
    /** "Nickel & Hitster-Rufe": false = no steal window / no Nickel awards. */
    chipsEnabled: boolean;
    /** Nickel cap: enabled + value (off = unlimited collecting). */
    chipLimitEnabled: boolean;
    chipLimit: number;
    /** "Mehrfaches Hitstern" (mode_config.hitsterMultiSteal, frozen at start). */
    multiStealEnabled: boolean;
    /** Deck source snapshot for "Song melden" reports. */
    sourceId?: string;
    sourceName?: string;
  }
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  if (players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
  if (cards.length < players.length + 1) {
    throw new Error(
      `Pool hat nur ${cards.length} Tracks - zu wenige für ${players.length} Spieler.`
    );
  }

  // Covers (pool decks only; playlists already carry them): urgently fetch only
  // the start cards + first playing card (+ small buffer); the rest loads in
  // the background AFTER the game_state write below - starting never blocks on
  // the full pool. Later draws stamp cached covers on (drawNextCard/skip/blind).
  const shuffled = await Spotify.addCoverArtUrgent(shuffle(cards), players.length + 3);

  // Deal one start card per player.
  for (let i = 0; i < players.length; i++) {
    const { error } = await supabase
      .from('lobby_players')
      .update({ timeline: [shuffled[i]], score: 0, chips: 2, current_streak: 0, max_brandt_streak: 0 })
      .eq('id', players[i].id);
    if (error) throw new Error(`Startkarte konnte nicht verteilt werden: ${error.message}`);
  }

  const remaining = shuffled.slice(players.length);
  const turnOrder = players.map((p) => p.player_id);

  const gameState: OnlineGameState = {
    deck: remaining.slice(1),
    currentCard: remaining[0] ?? null,
    activePlayerId: turnOrder[0],
    phase: 'card_drawn',
    pendingInsertIndex: null,
    lastResult: null,
    hitsterCallerId: null,
    passedHitster: [],
    multiStealEnabled: opts.multiStealEnabled,
    hitsterQueue: [],
    hitsterQueueVersion: 0,
    chipsPeak: Object.fromEntries(players.map((p) => [p.player_id, 2])),
    stealResult: null,
    stealEqualYear: false,
    turnOrder,
    cardsToWin: opts.cardsToWin,
    hideCoverUntilRevealed: opts.hideCoverUntilRevealed,
    skipEnabled: opts.skipEnabled,
    skipCost: opts.skipCost,
    blindEnabled: opts.blindEnabled,
    blindCost: opts.blindCost,
    timerEnabled: opts.timerEnabled,
    timerSeconds: opts.timerSeconds,
    chipsEnabled: opts.chipsEnabled,
    chipLimitEnabled: opts.chipLimitEnabled,
    chipLimit: opts.chipLimit,
    sourceId: opts.sourceId ?? null,
    sourceName: opts.sourceName ?? null,
    turnStartedAt: serverNow(),
    winnerId: null,
    statsHistory: [],
    // This is the HITSTER start path; bingo / timeline_quiz get their own start
    // functions (follow-ups) that snapshot their mode + config here instead.
    gameMode: 'hitster',
  };

  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: gameState, status: 'playing' })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spiel konnte nicht gestartet werden: ${error.message}`);
  // Remaining covers load in the background while the game runs; draws pull
  // them from the cache (withCachedCover). Aborted on leave/end of the lobby.
  Spotify.startCoverArtPrefetch(shuffled);
}

/**
 * Active player picks a slot. This opens the 5s "Hitster!" window (phase
 * hitster_window) - reveal/resolution happen AFTER the window (or after a steal).
 * With "Nickel & Hitster-Rufe" disabled there is no window: the placement is
 * resolved immediately (the transient hitster_window write keeps
 * closeHitsterWindow's atomic claim/logic reusable; the screen renders no
 * steal UI in that phase when the rule is off, so nothing flashes).
 */
export async function placeCard(lobbyId: string, insertIndex: number): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;
  await writeGameState(lobbyId, {
    ...gs,
    pendingInsertIndex: insertIndex,
    phase: 'hitster_window',
    hitsterCallerId: null,
    passedHitster: [],
    hitsterQueue: [],
    hitsterQueueVersion: 0,
    stealResult: null,
    stealEqualYear: false,
    lastResult: null,
  });
  if (gs.chipsEnabled === false) {
    await closeHitsterWindow(lobbyId);
  }
}

/**
 * "Karte überspringen": the active player discards the current card and draws a
 * replacement (same turn, phase stays card_drawn). Costs skipCost Nickel.
 * Locked at match point (score >= cardsToWin - 2): no Nickel assists on the
 * potentially winning card - the endgame has to be guessed.
 * Atomic on phase AND the current card id, so a double-tap (or a stale client)
 * can never skip twice / charge twice: the second write matches 0 rows.
 */
export async function skipCard(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  // chipsEnabled false disables the whole Nickel economy incl. paid actions
  // (mirrors the Pass & Play gating).
  if (
    !gs ||
    gs.phase !== 'card_drawn' ||
    !gs.currentCard ||
    !gs.skipEnabled ||
    gs.chipsEnabled === false
  ) {
    return;
  }
  if (gs.deck.length === 0) throw new Error('Keine Karten mehr im Deck.');
  const cost = gs.skipCost ?? 1;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active || active.chips < cost) return;
  // Match point = one correct placement away from the win threshold below
  // (cardsToWin - 1, since the dealt start card already counts as the first
  // of the cardsToWin timeline cards) - keep this in lockstep with that check.
  if (active.score >= gs.cardsToWin - 2) return;

  const [next, ...rest] = gs.deck;
  const { data } = await supabase
    .from('lobbies')
    .update({
      // New song -> restart the music timer (turnStartedAt) too.
      game_state: {
        ...gs,
        currentCard: Spotify.withCachedCover(next),
        deck: rest,
        turnStartedAt: serverNow(),
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'card_drawn')
    .filter('game_state->currentCard->>id', 'eq', gs.currentCard.id)
    .select();
  if (!data || data.length === 0) return;

  await supabase
    .from('lobby_players')
    .update({ chips: active.chips - cost })
    .eq('id', active.id);
}

/**
 * "Karte ohne Raten ziehen": the active player pays blindCost Nickel and the
 * current card is auto-inserted year-sorted into their timeline. It does NOT
 * count toward the win (no score - a bought card is no progress to cardsToWin)
 * and does NOT touch the Brandt streak (that tracks own guesses; a bought card
 * is neither hit nor miss). Locked at match point (score >= cardsToWin - 2).
 * The turn ends immediately: no steal window, no host confirmation - rotate +
 * draw the next card directly (or finish on an empty deck, like drawNextCard).
 * Same atomic claim pattern as skipCard (phase + card id).
 */
export async function blindDraw(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  // Same chipsEnabled gate as skipCard (paid Nickel action).
  if (
    !gs ||
    gs.phase !== 'card_drawn' ||
    !gs.currentCard ||
    !gs.blindEnabled ||
    gs.chipsEnabled === false
  ) {
    return;
  }
  const cost = gs.blindCost ?? 3;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active || active.chips < cost) return;
  // Match point (see skipCard) - one correct placement from the win threshold.
  if (active.score >= gs.cardsToWin - 2) return;

  const card = gs.currentCard;

  let nextGs: OnlineGameState;
  if (gs.deck.length === 0) {
    nextGs = { ...gs, phase: 'finished' };
  } else {
    const [next, ...rest] = gs.deck;
    const i = gs.turnOrder.indexOf(gs.activePlayerId);
    nextGs = {
      ...gs,
      deck: rest,
      currentCard: Spotify.withCachedCover(next),
      activePlayerId: gs.turnOrder[(i + 1) % gs.turnOrder.length],
      phase: 'card_drawn',
      pendingInsertIndex: null,
      lastResult: null,
      hitsterCallerId: null,
      passedHitster: [],
      stealResult: null,
      stealEqualYear: false,
      turnStartedAt: serverNow(),
    };
  }

  const { data } = await supabase
    .from('lobbies')
    .update({ game_state: nextGs })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'card_drawn')
    .filter('game_state->currentCard->>id', 'eq', card.id)
    .select();
  if (!data || data.length === 0) return;

  await supabase
    .from('lobby_players')
    .update({
      chips: active.chips - cost,
      timeline: insertAt(active.timeline, card, sortedInsertIndex(active.timeline, card.year)),
    })
    .eq('id', active.id);
  if (gs.deck.length === 0) {
    await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
  }
}

/**
 * Sort key for hitsterQueue: press order by SERVER clock, never write-commit
 * order (two concurrent joins could otherwise land in either order in the
 * array). Every function that writes the queue stores it PRE-SORTED via this,
 * so consumers (UI included) never need to re-sort.
 */
function sortedHitsterQueue(queue: HitsterQueueEntry[]): HitsterQueueEntry[] {
  return [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
}

/** First entry in a (pre-sorted) queue with neither a placement nor a withdrawal yet. */
function firstPendingHitster(queue: HitsterQueueEntry[]): HitsterQueueEntry | undefined {
  return queue.find((e) => e.placedSlot == null && !e.aborted);
}

/**
 * multiStealEnabled join: append this press to hitsterQueue (everyone may
 * join, not just the first - the window itself stays open). Guarded by an
 * explicit version counter (hitsterQueueVersion) rather than comparing the
 * array's serialized content: Postgres's jsonb does NOT preserve object key
 * order, so a text-equality filter on the array's JSON would spuriously
 * "never match" and retry forever. A plain integer sibling field is the same
 * optimistic-concurrency idiom used elsewhere in this file (e.g. roundNumber
 * guards), just scoped to this array. On a lost race (someone else joined
 * first), re-reads and retries once - collisions require two real people to
 * press within the same network round-trip, an acceptable rarity.
 */
async function joinHitsterQueue(
  lobbyId: string,
  gs: OnlineGameState,
  callerId: string,
  attemptsLeft = 5
): Promise<boolean> {
  const queue = gs.hitsterQueue ?? [];
  if (queue.some((e) => e.playerId === callerId)) return true; // already queued - idempotent
  const nextQueue = sortedHitsterQueue([...queue, { playerId: callerId, queuedAt: serverNow() }]);
  // Opinion change: a prior "Kein Hitster" no longer applies once they've queued.
  const nextPassed = (gs.passedHitster ?? []).filter((id) => id !== callerId);
  const version = gs.hitsterQueueVersion ?? 0;
  const { data, error } = await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        hitsterQueue: nextQueue,
        passedHitster: nextPassed,
        hitsterQueueVersion: version + 1,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_window')
    .filter('game_state->>hitsterQueueVersion', 'eq', String(version))
    .select();
  if (error) return false;
  if (data && data.length > 0) return true;
  if (attemptsLeft <= 0) return false;
  const { game_state: fresh } = await getLobby(lobbyId);
  if (!fresh || fresh.phase !== 'hitster_window') return false;
  return joinHitsterQueue(lobbyId, fresh, callerId, attemptsLeft - 1);
}

/**
 * Atomically claim the "Hitster!" call (multiStealEnabled OFF - today's
 * single-winner race) or join the steal queue (multiStealEnabled ON - see
 * joinHitsterQueue). Returns true if THIS caller is now in the running
 * (claimed the race, or successfully queued).
 *
 * OFF-path atomicity: the UPDATE only writes when the row still has phase
 * 'hitster_window' AND hitster_caller_id IS NULL. Postgres takes a row lock
 * per UPDATE; under READ COMMITTED a second concurrent UPDATE waits for the
 * first to commit and then RE-EVALUATES its WHERE against the now-updated row
 * - where hitster_caller_id is no longer null - so it matches 0 rows.
 * `.select()` returns the updated row only to the winner (the loser gets []).
 * This is the classic "UPDATE ... WHERE col IS NULL RETURNING" claim, applied
 * to a jsonb field via PostgREST json-path filters. No Postgres function /
 * migration needed, on either path.
 */
export async function callHitster(lobbyId: string, callerId: string): Promise<boolean> {
  const { game_state: gs } = await getLobby(lobbyId);
  // chipsEnabled false: no steal calls (defensive - the button is hidden, and
  // the disabled-rule window only exists transiently inside placeCard).
  if (!gs || gs.phase !== 'hitster_window' || gs.chipsEnabled === false) return false;

  if (gs.multiStealEnabled) {
    return joinHitsterQueue(lobbyId, gs, callerId);
  }

  const newGs: OnlineGameState = {
    ...gs,
    hitsterCallerId: callerId,
    phase: 'hitster_resolving',
  };
  const { data, error } = await supabase
    .from('lobbies')
    .update({ game_state: newGs })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_window')
    .filter('game_state->>hitsterCallerId', 'is', null)
    .select();

  const won = !error && !!data && data.length > 0;
  return won;
}

/**
 * Host's window timeout: no one stole -> resolve the active player's placement.
 * Claimed atomically (same WHERE guard) so a late callHitster can't be overridden.
 *
 * multiStealEnabled: if the queue is non-empty, hands off to the collection
 * phase instead (front of hitsterQueue becomes hitsterCallerId, phase moves to
 * hitster_resolving same as the OFF-path's single claim) - resolveHitster
 * Placement/withdrawHitsterAttempt take it from there. An empty queue (nobody
 * pressed "Hitster!" in time) falls through to the exact same regular
 * resolution as the OFF-path below.
 */
export async function closeHitsterWindow(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window' || !gs.currentCard || gs.pendingInsertIndex == null) {
    return;
  }

  if (gs.multiStealEnabled) {
    const queue = sortedHitsterQueue(gs.hitsterQueue ?? []);
    if (queue.length > 0) {
      await supabase
        .from('lobbies')
        .update({
          game_state: {
            ...gs,
            hitsterQueue: queue,
            hitsterCallerId: queue[0].playerId,
            phase: 'hitster_resolving',
          } as OnlineGameState,
        })
        .eq('id', lobbyId)
        .filter('game_state->>phase', 'eq', 'hitster_window')
        .filter('game_state->>hitsterCallerId', 'is', null);
      return;
    }
    // Queue empty -> regular resolution below, identical to the OFF-path.
  }

  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active) return;

  const card = gs.currentCard;
  const idx = gs.pendingInsertIndex;
  const correct = isCorrectPlacement(active.timeline, card, idx);
  const { left, right } = neighborYears(active.timeline, idx);
  const newScore = correct ? active.score + 1 : active.score;
  // Win at cardsToWin - 1 correct placements: the dealt start card is the
  // implicit first of the cardsToWin timeline cards (score never counts it),
  // so "10 Karten zum Gewinnen" means 10 cards total, not 10 + the start card.
  const won = correct && newScore >= gs.cardsToWin - 1;

  // Atomic transition (only if still an open, unclaimed window).
  const { data } = await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        // chipsEnabled false: no Nickel question - straight to the round
        // result (the host then draws the next card as usual).
        phase:
          won || gs.chipsEnabled === false ? 'finished' : 'awaiting_host_confirmation',
        lastResult: correct ? 'correct' : 'incorrect',
        stealResult: null,
        stealEqualYear: false,
        hitsterCallerId: null,
        winnerId: won ? active.player_id : gs.winnerId,
        statsHistory: appendStats(gs, {
          type: 'place',
          playerId: active.player_id,
          song: toStatsSong(card),
          correct,
          leftYear: left,
          rightYear: right,
        }),
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_window')
    .filter('game_state->>hitsterCallerId', 'is', null)
    .select();

  if (!data || data.length === 0) {
    return;
  }
  // Update the active player's Brandt streak (+1 if correct, reset to 0 otherwise)
  // and, when correct, their timeline + score.
  const streak = correct ? active.current_streak + 1 : 0;
  const activeUpdate: Record<string, unknown> = {
    current_streak: streak,
    max_brandt_streak: Math.max(active.max_brandt_streak, streak),
  };
  if (correct) {
    activeUpdate.timeline = insertAt(active.timeline, card, idx);
    activeUpdate.score = newScore;
  }
  await supabase.from('lobby_players').update(activeUpdate).eq('id', active.id);
  if (won) await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
}

/**
 * A non-active player presses "Kein Hitster": record their id in passedHitster,
 * then check whether the window can close early. The write is guarded by the same
 * atomic condition as the steal claim (phase still 'hitster_window' AND no caller
 * yet) so it can never clobber a concurrent "Hitster!" call.
 */
export async function passHitster(lobbyId: string, playerId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window') return;
  // Already queued (multiStealEnabled) supersedes a pass - defensive no-op,
  // the UI never offers this button once queued.
  if (gs.hitsterQueue?.some((e) => e.playerId === playerId)) return;

  const passed = gs.passedHitster ?? [];
  if (!passed.includes(playerId)) {
    const nextPassed = [...passed, playerId];
    const newGs: OnlineGameState = { ...gs, passedHitster: nextPassed };
    const { data } = await supabase
      .from('lobbies')
      .update({ game_state: newGs })
      .eq('id', lobbyId)
      .filter('game_state->>phase', 'eq', 'hitster_window')
      .filter('game_state->>hitsterCallerId', 'is', null)
      .select();
    if (!data || data.length === 0) {
      return;
    }
  }

  await checkHitsterWindowComplete(lobbyId);
}

/**
 * Close the steal window early if every potential stealer (non-active player with
 * >=1 Nickel) has either called "Hitster!" (or, multiStealEnabled, joined the
 * queue) or pressed "Kein Hitster". Safe to call from any client:
 * closeHitsterWindow is itself atomic.
 */
async function checkHitsterWindowComplete(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window') return;

  const players = await getLobbyPlayers(lobbyId);
  const potential = players.filter(
    (p) => p.player_id !== gs.activePlayerId && p.chips >= 1
  );
  const passed = new Set(gs.passedHitster ?? []);
  const queued = new Set((gs.hitsterQueue ?? []).map((e) => e.playerId));
  const allResponded =
    potential.length > 0 && potential.every((p) => passed.has(p.player_id) || queued.has(p.player_id));
  if (allResponded) {
    await closeHitsterWindow(lobbyId);
  }
}

/**
 * The Hitster caller picks a slot in the ACTIVE player's timeline. Correctness is
 * judged against the active player's timeline + the caller's slot (same logic as
 * hot-seat). Success: card -> caller's OWN sorted timeline + score, -1 Nickel.
 * Miss: -1 Nickel, then the active player's own placement is evaluated. A steal
 * never affects the Brandt hot-streak (only own active-turn placements do).
 *
 * multiStealEnabled: delegates to placeHitsterQueueSlot instead - the OFF-path
 * body below is untouched (single caller, evaluated immediately, exactly as
 * before).
 */
export async function resolveHitsterPlacement(
  lobbyId: string,
  insertIndex: number
): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_resolving' || !gs.currentCard || gs.pendingInsertIndex == null) {
    return;
  }

  if (gs.multiStealEnabled) {
    await placeHitsterQueueSlot(lobbyId, gs, insertIndex);
    return;
  }

  const callerId = gs.hitsterCallerId;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  const caller = players.find((p) => p.player_id === callerId);
  if (!active || !caller) return;

  const card = gs.currentCard;
  // The active player's own placement decides whether a steal is even possible.
  const activeCorrect = isCorrectPlacement(active.timeline, card, gs.pendingInsertIndex);
  // Whether the caller's slot is year-valid in the active player's timeline.
  const callerSlotValid = isCorrectPlacement(active.timeline, card, insertIndex);
  // Gap info for both attempts (raw data for the stats log).
  const activeNeighbors = neighborYears(active.timeline, gs.pendingInsertIndex);
  const callerNeighbors = neighborYears(active.timeline, insertIndex);
  // A steal only succeeds if the active player placed WRONGLY and the caller then
  // found a year-valid slot. If the active player was already correct, no steal is
  // possible - even when an equal-year situation leaves a second valid slot for the
  // caller (that slot is NOT the active player's actual choice).
  const stealCorrect = !activeCorrect && callerSlotValid;
  // Equal-year standoff: the steal missed only because the active player was also
  // correct at an equally-valid slot.
  const stealEqualYear = activeCorrect && callerSlotValid;
  let winnerId: string | null = gs.winnerId;

  // Caller: always -1 Nickel; on success the card joins their own timeline. A
  // steal does NOT touch the caller's Brandt streak.
  const callerUpdate: Record<string, unknown> = { chips: Math.max(0, caller.chips - 1) };
  if (stealCorrect) {
    const idx = sortedInsertIndex(caller.timeline, card.year);
    const newScore = caller.score + 1;
    callerUpdate.timeline = insertAt(caller.timeline, card, idx);
    callerUpdate.score = newScore;
    // Win threshold cardsToWin - 1 (see closeHitsterWindow).
    if (newScore >= gs.cardsToWin - 1) winnerId = caller.player_id;
  }
  await supabase.from('lobby_players').update(callerUpdate).eq('id', caller.id);

  // Active player's OWN placement drives their Brandt streak (+1 if correct, reset
  // to 0 otherwise), regardless of the steal. They keep the card only when correct
  // (a steal can't succeed when the active player was correct).
  const activeStreak = activeCorrect ? active.current_streak + 1 : 0;
  const activeUpdate: Record<string, unknown> = {
    current_streak: activeStreak,
    max_brandt_streak: Math.max(active.max_brandt_streak, activeStreak),
  };
  if (activeCorrect) {
    const newScore = active.score + 1;
    activeUpdate.timeline = insertAt(active.timeline, card, gs.pendingInsertIndex);
    activeUpdate.score = newScore;
    // Win threshold cardsToWin - 1 (see closeHitsterWindow).
    if (newScore >= gs.cardsToWin - 1) winnerId = active.player_id;
  }
  await supabase.from('lobby_players').update(activeUpdate).eq('id', active.id);

  const won = !!winnerId;
  const song = toStatsSong(card);
  await writeGameState(lobbyId, {
    ...gs,
    phase: won ? 'finished' : 'awaiting_host_confirmation',
    lastResult: activeCorrect ? 'correct' : 'incorrect',
    stealResult: stealCorrect ? 'correct' : 'incorrect',
    stealEqualYear,
    hitsterCallerId: callerId,
    winnerId,
    // Two stats events per resolved steal turn: the active player's OWN
    // placement + the steal attempt (victim = active player).
    statsHistory: appendStats(
      gs,
      {
        type: 'place',
        playerId: active.player_id,
        song,
        correct: activeCorrect,
        leftYear: activeNeighbors.left,
        rightYear: activeNeighbors.right,
      },
      {
        type: 'steal',
        playerId: caller.player_id,
        victimId: active.player_id,
        song,
        correct: stealCorrect,
        leftYear: callerNeighbors.left,
        rightYear: callerNeighbors.right,
      }
    ),
  });
  if (won) await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
}

/**
 * multiStealEnabled: the current front-of-queue member (gs.hitsterCallerId)
 * places `insertIndex`. If someone else is still pending, only hands the turn
 * to them (one atomic write, guarded on phase + the CURRENT hitsterCallerId -
 * which this write changes, so a duplicate/retry submit fails the guard on
 * its second attempt and the Nickel charge below, gated on the write's
 * success, never double-fires). Charges 1 Nickel to the placer immediately
 * regardless of outcome ("Nickel wird erst beim tatsächlichen Setzen
 * abgezogen") - the win/lose OUTCOME itself stays hidden until the whole
 * queue is done (finalizeMultiSteal), matching the "silent, one reveal at the
 * end" design. If this WAS the last pending member, the final evaluation
 * (incl. this entry's own Nickel charge) happens there instead.
 */
async function placeHitsterQueueSlot(
  lobbyId: string,
  gs: OnlineGameState,
  insertIndex: number
): Promise<void> {
  const callerId = gs.hitsterCallerId;
  if (!callerId || callerId !== getPlayerId()) return;
  const queue = sortedHitsterQueue(gs.hitsterQueue ?? []);
  const current = queue.find((e) => e.playerId === callerId);
  if (!current || current.placedSlot != null || current.aborted) return;

  const nextQueue = queue.map((e) =>
    e.playerId === callerId ? { ...e, placedSlot: insertIndex } : e
  );
  const next = firstPendingHitster(nextQueue);

  if (!next) {
    await finalizeMultiSteal(lobbyId, gs, nextQueue, callerId);
    return;
  }

  const { data } = await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        hitsterQueue: nextQueue,
        hitsterCallerId: next.playerId,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_resolving')
    .filter('game_state->>hitsterCallerId', 'eq', callerId)
    .select();
  if (!data || data.length === 0) return; // lost the guard - already advanced past this turn

  const players = await getLobbyPlayers(lobbyId);
  const caller = players.find((p) => p.player_id === callerId);
  if (caller) {
    await supabase
      .from('lobby_players')
      .update({ chips: Math.max(0, caller.chips - 1) })
      .eq('id', caller.id);
  }
}

/**
 * multiStealEnabled: the front-of-queue member withdraws instead of placing -
 * no Nickel charge (nothing was ever deducted for a press/queue join, only
 * for an actual placement), no stats event (no attempt was made). Refused
 * for the very FIRST queue entry (queue[0], always the earliest press) -
 * "kein Abbrechen für A": someone must place on the very first turn, mirroring
 * the OFF-path where the sole caller always commits to a slot.
 */
export async function withdrawHitsterAttempt(lobbyId: string): Promise<void> {
  const myId = getPlayerId();
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    !gs.multiStealEnabled ||
    gs.phase !== 'hitster_resolving' ||
    gs.hitsterCallerId !== myId
  ) {
    return;
  }
  const queue = sortedHitsterQueue(gs.hitsterQueue ?? []);
  if (queue[0]?.playerId === myId) return; // "A" must place, no withdrawal
  const current = queue.find((e) => e.playerId === myId);
  if (!current || current.placedSlot != null || current.aborted) return;

  const nextQueue = queue.map((e) => (e.playerId === myId ? { ...e, aborted: true } : e));
  const next = firstPendingHitster(nextQueue);

  if (!next) {
    await finalizeMultiSteal(lobbyId, gs, nextQueue);
    return;
  }

  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        hitsterQueue: nextQueue,
        hitsterCallerId: next.playerId,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_resolving')
    .filter('game_state->>hitsterCallerId', 'eq', myId)
    .select();
}

/**
 * multiStealEnabled: the queue is fully processed (every entry has either
 * placedSlot or aborted) - the ONE-TIME final evaluation + reveal ("still",
 * no per-attempt hints - see the module doc). Scans front-to-back (queue is
 * pre-sorted by press time) for the first PLACED slot that's actually valid;
 * that entry steals the card - impossible when the active player was already
 * correct, exactly like the OFF-path's stealCorrect formula (only ONE outcome
 * is possible, never both). Every OTHER placed entry logs a "verbrandt"
 * (correct: false) steal event, in queue order; withdrawals log nothing.
 *
 * The active player's OWN placement is evaluated EXACTLY ONCE, here - never
 * per queue entry. That is the correctness pitfall the Schritt-0 analysis
 * flagged: activeCorrect doesn't change between attempts, so applying its
 * score/timeline/streak side effects on every failed attempt (instead of once,
 * at the end) would double- or triple-count them when multiple people fail in
 * a row.
 *
 * `chargePlayerId` is the entry that JUST placed to reach this final step
 * (undefined if they withdrew instead) - every earlier entry's Nickel was
 * already charged at ITS OWN turn (see placeHitsterQueueSlot), so this is the
 * only charge left to apply.
 */
async function finalizeMultiSteal(
  lobbyId: string,
  gs: OnlineGameState,
  queue: HitsterQueueEntry[],
  chargePlayerId?: string
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active || !gs.currentCard || gs.pendingInsertIndex == null) return;
  const card = gs.currentCard;

  const activeCorrect = isCorrectPlacement(active.timeline, card, gs.pendingInsertIndex);
  const activeNeighbors = neighborYears(active.timeline, gs.pendingInsertIndex);
  const placed = queue.filter(
    (e): e is HitsterQueueEntry & { placedSlot: number } => e.placedSlot != null && !e.aborted
  );
  // A steal is only even possible when the active player was wrong (mirrors
  // the OFF-path's stealCorrect = !activeCorrect && callerSlotValid).
  const winnerEntry = !activeCorrect
    ? placed.find((e) => isCorrectPlacement(active.timeline, card, e.placedSlot))
    : undefined;
  const winnerPlayer = winnerEntry
    ? players.find((p) => p.player_id === winnerEntry.playerId)
    : undefined;
  // Equal-year standoff, generalized: active was right AND at least one
  // attempt also landed on an equally-valid slot.
  const stealEqualYear =
    activeCorrect && placed.some((e) => isCorrectPlacement(active.timeline, card, e.placedSlot));

  let winnerId: string | null = gs.winnerId;

  if (winnerEntry && winnerPlayer) {
    const idx = sortedInsertIndex(winnerPlayer.timeline, card.year);
    const newScore = winnerPlayer.score + 1;
    await supabase
      .from('lobby_players')
      .update({ timeline: insertAt(winnerPlayer.timeline, card, idx), score: newScore })
      .eq('id', winnerPlayer.id);
    if (newScore >= gs.cardsToWin - 1) winnerId = winnerPlayer.player_id;
  }

  // Active player's OWN placement - see the doc above: exactly once, here.
  const activeStreak = activeCorrect ? active.current_streak + 1 : 0;
  const activeUpdate: Record<string, unknown> = {
    current_streak: activeStreak,
    max_brandt_streak: Math.max(active.max_brandt_streak, activeStreak),
  };
  if (activeCorrect) {
    const newScore = active.score + 1;
    activeUpdate.timeline = insertAt(active.timeline, card, gs.pendingInsertIndex);
    activeUpdate.score = newScore;
    if (newScore >= gs.cardsToWin - 1) winnerId = active.player_id;
  }
  await supabase.from('lobby_players').update(activeUpdate).eq('id', active.id);

  if (chargePlayerId) {
    const charged = players.find((p) => p.player_id === chargePlayerId);
    if (charged) {
      await supabase
        .from('lobby_players')
        .update({ chips: Math.max(0, charged.chips - 1) })
        .eq('id', charged.id);
    }
  }

  const won = !!winnerId;
  const song = toStatsSong(card);
  // One "steal" event per PLACED (non-withdrawn) attempt, in queue order: the
  // actual winner (if any) logs correct: true, everyone else correct: false -
  // only one placed attempt can ever be the true steal.
  const stealEvents: MatchEvent[] = placed.map((e) => {
    const n = neighborYears(active.timeline, e.placedSlot);
    return {
      type: 'steal',
      playerId: e.playerId,
      victimId: active.player_id,
      song,
      correct: winnerEntry?.playerId === e.playerId,
      leftYear: n.left,
      rightYear: n.right,
    };
  });
  await writeGameState(lobbyId, {
    ...gs,
    phase: won ? 'finished' : 'awaiting_host_confirmation',
    lastResult: activeCorrect ? 'correct' : 'incorrect',
    stealResult: winnerEntry ? 'correct' : placed.length > 0 ? 'incorrect' : null,
    stealEqualYear,
    // Reveal identity for the existing single-name message (stealerName):
    // the winner if there was one, otherwise the LAST (queue-order) placed
    // attempt, otherwise null (nobody placed at all - identical to an empty
    // queue). Known simplification: with several failed attempts, only one
    // name is shown - see the write-up for a possible future "list everyone"
    // enhancement.
    hitsterCallerId: winnerEntry?.playerId ?? placed[placed.length - 1]?.playerId ?? null,
    hitsterQueue: queue,
    winnerId,
    statsHistory: appendStats(
      gs,
      {
        type: 'place',
        playerId: active.player_id,
        song,
        correct: activeCorrect,
        leftYear: activeNeighbors.left,
        rightYear: activeNeighbors.right,
      },
      ...stealEvents
    ),
  });
  if (won) await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
}

/**
 * Host confirms (AFTER reveal) whether title+artist were guessed -> award a Nickel
 * to the active player if yes, then end the round (phase 'finished').
 */
export async function confirmGuess(lobbyId: string, wasCorrect: boolean): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;
  let statsHistory = gs.statsHistory ?? [];
  let chipsPeak = gs.chipsPeak;
  if (wasCorrect) {
    const players = await getLobbyPlayers(lobbyId);
    const active = players.find((p) => p.player_id === gs.activePlayerId);
    if (active) {
      // Configurable Nickel cap. Legacy in-flight games (fields absent in
      // game_state) keep the original hard limit of 5; disabled = unlimited.
      const limit =
        gs.chipLimitEnabled == null
          ? MAX_CHIPS
          : gs.chipLimitEnabled
            ? (gs.chipLimit ?? MAX_CHIPS)
            : Number.POSITIVE_INFINITY;
      // Stats: log only ACTUALLY received Nickel (capped at the limit = not
      // received), together with the song it was earned on.
      if (active.chips < limit) {
        statsHistory = appendStats(gs, {
          type: 'nickel',
          playerId: active.player_id,
          song: gs.currentCard ? toStatsSong(gs.currentCard) : undefined,
        });
      }
      const newChips = Math.min(active.chips + 1, limit);
      await supabase.from('lobby_players').update({ chips: newChips }).eq('id', active.id);
      const peak = gs.chipsPeak ?? {};
      chipsPeak = { ...peak, [active.player_id]: Math.max(peak[active.player_id] ?? 0, newChips) };
    }
  }
  await writeGameState(lobbyId, { ...gs, phase: 'finished', statsHistory, chipsPeak });
}

/**
 * Manual Nickel correction (host, "Nickel korrigieren" dialog): ±1 on one
 * player's chip count, clamped to [0, limit] (limit null = unbegrenzt).
 * Deliberately NO statsHistory append: a manual fix has no song context, and
 * the "Erhaltene Nickel" list requires one. A +1 DOES count toward chipsPeak
 * (game_state, best-effort second write) - the manual fix corrects a real
 * balance, so it counts the same as an honestly earned Nickel for the
 * "Nickelfarmer/-meister/-gott" achievement family.
 *
 * Race-safe against the regular award/steal writes via optimistic
 * concurrency: the update is guarded on the CURRENT count, so if a round
 * write lands in between it matches zero rows and we throw a retry error
 * instead of silently overwriting the newer count.
 */
export async function adjustPlayerChips(
  lobbyId: string,
  playerId: string,
  playerRowId: string,
  currentChips: number,
  delta: 1 | -1,
  limit: number | null
): Promise<void> {
  const next = Math.max(0, Math.min(currentChips + delta, limit ?? Number.POSITIVE_INFINITY));
  if (next === currentChips) return; // already at a bound - nothing to write
  const { data, error } = await supabase
    .from('lobby_players')
    .update({ chips: next })
    .eq('id', playerRowId)
    .eq('chips', currentChips)
    .select('id');
  if (error) throw new Error(`Nickel-Korrektur fehlgeschlagen: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('Nickel-Stand hat sich gerade geändert — bitte nochmal tippen.');
  }
  if (delta === 1) {
    // Best-effort secondary write (the chip change itself already succeeded
    // above) - a lost race here just means chipsPeak briefly under-counts,
    // never a wrong game outcome, so no retry/guard needed.
    const { game_state: gs } = await getLobby(lobbyId);
    if (gs) {
      const peak = gs.chipsPeak ?? {};
      await writeGameState(lobbyId, {
        ...gs,
        chipsPeak: { ...peak, [playerId]: Math.max(peak[playerId] ?? 0, next) },
      });
    }
  }
}

/** Host draws the next card + rotates to the next player (or finishes). */
export async function drawNextCard(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;

  if (gs.deck.length === 0) {
    await writeGameState(lobbyId, { ...gs, phase: 'finished' });
    await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
    return;
  }

  const [next, ...rest] = gs.deck;
  const i = gs.turnOrder.indexOf(gs.activePlayerId);
  const nextActive = gs.turnOrder[(i + 1) % gs.turnOrder.length];

  await writeGameState(lobbyId, {
    ...gs,
    deck: rest,
    currentCard: Spotify.withCachedCover(next),
    activePlayerId: nextActive,
    phase: 'card_drawn',
    pendingInsertIndex: null,
    lastResult: null,
    hitsterCallerId: null,
    passedHitster: [],
    stealResult: null,
    stealEqualYear: false,
    turnStartedAt: serverNow(),
  });
}

// ---------------------------------------------------------------------------
// Game modes & simultaneous rounds (foundation for bingo / timeline_quiz).
//
// Mechanic (mode-agnostic; the follow-up modes only plug in their evaluation):
//   1. startSimulRound: host opens a round (deadline set, answers accepted)
//   2. submitRoundAnswer: each client submits ONCE (DB-unique guarded)
//   3. resolveSimulRound: host resolves when ALL answered OR the deadline
//      passed - atomically claimed, so the "all answered" trigger and the
//      deadline timer can never both resolve. Non-answering players are
//      'missed'. Results land in game_state.roundResults -> synced everywhere.
// ---------------------------------------------------------------------------

/**
 * Host picks the lobby's game mode (+ config) in the waiting room. Visible to
 * all players via the existing lobbies subscription. Requires migration 005.
 */
export async function setLobbyMode(
  lobbyId: string,
  mode: GameMode,
  config: ModeConfig
): Promise<void> {
  const { error } = await supabase
    .from('lobbies')
    .update({ game_mode: mode, mode_config: config })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spielmodus konnte nicht gesetzt werden: ${error.message}`);
}

/**
 * Host starts the next simultaneous round: bumps roundNumber, sets the answer
 * deadline (same absolute-timestamp pattern as turnStartedAt) and opens the
 * collecting phase. `patch` carries the mode-specific round content (e.g. the
 * drawn card). Round 1 of a game clears leftover answers of a previous game in
 * this lobby, so the (lobby, round, player) unique key can never collide.
 */
export async function startSimulRound(
  lobbyId: string,
  durationSeconds: number,
  patch: Partial<OnlineGameState> = {}
): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;
  const roundNumber = (gs.roundNumber ?? 0) + 1;
  if (roundNumber === 1) {
    await supabase.from('round_answers').delete().eq('lobby_id', lobbyId);
  }
  await writeGameState(lobbyId, {
    ...gs,
    ...patch,
    roundNumber,
    roundDeadline: serverNow() + durationSeconds * 1000,
    roundPhase: 'collecting',
    roundResults: null,
  });
}

/**
 * Submit THIS player's answer for the current round. Returns true when the
 * answer was recorded, false when the round is closed or the player already
 * answered. Double submissions are impossible at the DB level: the
 * (lobby, round, player) UNIQUE constraint rejects the second INSERT (23505) -
 * same idea as the atomic claim guards, but insert-shaped because here EVERY
 * player must win exactly once (not just the first).
 */
export async function submitRoundAnswer(
  lobbyId: string,
  playerId: string,
  answer: unknown
): Promise<boolean> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.roundPhase !== 'collecting' || gs.roundNumber == null) return false;
  const { error } = await supabase.from('round_answers').insert({
    lobby_id: lobbyId,
    round_number: gs.roundNumber,
    player_id: playerId,
    answer,
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') return false; // already answered
    throw new Error(`Antwort konnte nicht gespeichert werden: ${error.message}`);
  }
  return true;
}

/** All submitted answers of one round (for resolution and "x/y" displays). */
export async function getRoundAnswers(
  lobbyId: string,
  roundNumber: number
): Promise<RoundAnswer[]> {
  const { data, error } = await supabase
    .from('round_answers')
    .select('*')
    .eq('lobby_id', lobbyId)
    .eq('round_number', roundNumber);
  if (error) throw new Error(`Antworten konnten nicht geladen werden: ${error.message}`);
  return (data ?? []) as RoundAnswer[];
}

/**
 * A round stuck in 'resolving' this long after its claim may be RE-claimed by
 * any client (the original claim winner evidently died before the final
 * write). Screens arm their watchdog timers on the same constant.
 */
export const RESOLVE_STALE_MS = 15000;

/** Fresh collecting window after a failed resolution attempt (rollback path). */
const RESOLVE_RETRY_WINDOW_MS = 10000;

/**
 * Host-authoritative round resolution. Call it when all players answered OR
 * when the deadline passed - both triggers may fire; the atomic claim
 * (collecting -> resolving, guarded on phase + roundNumber) guarantees exactly
 * one resolution. After the claim the answer set is frozen (submits check the
 * phase and are refused), then `evaluate` maps the submitted answers to
 * outcomes; every player without an answer is 'missed'. Returns true for the
 * caller that actually resolved (that caller may then apply mode-specific
 * side effects like score/board updates, knowing it is the single winner).
 *
 * Recovery paths (a claim that never reaches the final write must not strand
 * the round in 'resolving' forever):
 *   - RE-CLAIM: after RESOLVE_STALE_MS a round still in 'resolving' can be
 *     claimed again, atomically guarded on the PREVIOUS claim token. Safe to
 *     re-run in full: every persistent side effect (scores, boards, finish)
 *     only happens after the final write landed, so a dead claim left nothing
 *     behind. The final write is guarded on OUR token - if a slow original
 *     winner wakes up after being superseded, its write matches nothing and
 *     it returns false (no double side effects).
 *   - ROLLBACK: if answers/roster/evaluate throw AFTER the claim (e.g. a
 *     network error), the round is put back to 'collecting' with a short fresh
 *     deadline - the clients' deadline timers re-arm and retry, and the error
 *     surfaces to the caller instead of hanging invisibly.
 */
export async function resolveSimulRound(
  lobbyId: string,
  evaluate: (
    answers: RoundAnswer[],
    gs: OnlineGameState
  ) =>
    | { results: Record<string, RoundOutcome>; patch?: Partial<OnlineGameState> }
    | Promise<{ results: Record<string, RoundOutcome>; patch?: Partial<OnlineGameState> }>,
  opts?: {
    /**
     * Also claim rounds sitting in 'reviewing' (bingo title_artist host
     * review). The CALLER gates when a reviewing round may resolve (verdicts
     * complete / review deadline); the claim here only provides atomicity.
     */
    fromReviewing?: boolean;
  }
): Promise<boolean> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.roundNumber == null) return false;

  // Step 1: atomic claim (deadline timer vs. "all answered" race - and the
  // stale re-claim, all funneled through conditional single-row updates).
  const claimId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const claimedState: OnlineGameState = {
    ...gs,
    roundPhase: 'resolving',
    resolveClaimId: claimId,
    resolveClaimedAt: serverNow(),
  };
  let claim = supabase
    .from('lobbies')
    .update({ game_state: claimedState })
    .eq('id', lobbyId)
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
  if (gs.roundPhase === 'collecting') {
    // Defense-in-depth against premature client triggers (e.g. an effect
    // firing with stale state): a collecting round may only be resolved once
    // its deadline passed OR everyone actually answered - checked against the
    // CURRENT answer rows, not whatever the caller believed.
    const deadlinePassed = gs.roundDeadline == null || serverNow() >= gs.roundDeadline;
    if (!deadlinePassed) {
      const [answers, players] = await Promise.all([
        getRoundAnswers(lobbyId, gs.roundNumber),
        getLobbyPlayers(lobbyId),
      ]);
      if (players.length === 0 || answers.length < players.length) return false;
    }
    claim = claim.filter('game_state->>roundPhase', 'eq', 'collecting');
  } else if (gs.roundPhase === 'reviewing' && opts?.fromReviewing) {
    // Host-review rounds: the caller already gated (verdicts complete or
    // review deadline passed); the filter keeps the claim atomic.
    claim = claim.filter('game_state->>roundPhase', 'eq', 'reviewing');
  } else if (gs.roundPhase === 'resolving') {
    // Stale re-claim: only when the previous claim visibly died. Guarded on
    // the previous token (or its absence, for rounds stuck before this fix),
    // so two rescuers can never both win.
    const claimedAt = gs.resolveClaimedAt ?? gs.roundDeadline ?? 0;
    if (serverNow() - claimedAt < RESOLVE_STALE_MS) return false;
    claim = claim.filter('game_state->>roundPhase', 'eq', 'resolving');
    claim =
      gs.resolveClaimId != null
        ? claim.filter('game_state->>resolveClaimId', 'eq', gs.resolveClaimId)
        : claim.filter('game_state->>resolveClaimId', 'is', null);
  } else {
    return false;
  }
  const { data } = await claim.select();
  if (!data || data.length === 0) return false;

  try {
    // Step 2: frozen snapshot of answers + roster.
    const [answers, players] = await Promise.all([
      getRoundAnswers(lobbyId, gs.roundNumber),
      getLobbyPlayers(lobbyId),
    ]);

    // Step 3: mode-specific evaluation; default everyone to 'missed'.
    const results: Record<string, RoundOutcome> = {};
    for (const p of players) results[p.player_id] = 'missed';
    const evaluated = await evaluate(answers, gs);
    Object.assign(results, evaluated.results);

    // Final write, guarded on OUR claim token: if a rescuer superseded us in
    // the meantime, this matches nothing and we must NOT run side effects.
    const { data: final } = await supabase
      .from('lobbies')
      .update({
        game_state: {
          ...gs,
          ...(evaluated.patch ?? {}),
          roundPhase: 'resolved',
          roundResults: results,
          resolveClaimId: null,
          resolveClaimedAt: null,
        } as OnlineGameState,
      })
      .eq('id', lobbyId)
      .filter('game_state->>resolveClaimId', 'eq', claimId)
      .select();
    return !!final && final.length > 0;
  } catch (e) {
    // Controlled rollback instead of a silent hang: reopen the round in the
    // phase it was claimed from, with a short fresh deadline (clients re-arm
    // + retry), then surface the error. Guarded on our token so a rescuer's
    // progress can't be clobbered.
    const backToReview = gs.roundPhase === 'reviewing';
    await supabase
      .from('lobbies')
      .update({
        game_state: {
          ...gs,
          roundPhase: backToReview ? 'reviewing' : 'collecting',
          roundDeadline: backToReview
            ? (gs.roundDeadline ?? null)
            : serverNow() + RESOLVE_RETRY_WINDOW_MS,
          reviewDeadline: backToReview
            ? serverNow() + RESOLVE_RETRY_WINDOW_MS
            : (gs.reviewDeadline ?? null),
          resolveClaimId: null,
          resolveClaimedAt: null,
        } as OnlineGameState,
      })
      .eq('id', lobbyId)
      .filter('game_state->>resolveClaimId', 'eq', claimId);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Bingo mode (game logic on top of the simultaneous-round foundation).
//
// Flow: startBingoGame (boards + first round) -> everyone submits via
// submitRoundAnswer -> ANY client resolves via resolveBingoRound (deadline
// timer on all clients + "all answered" trigger; the claim dedupes) -> the
// PICK WINDOW opens: correct players choose their own cell (pickBingoCell) ->
// host taps "Nächste Runde" (nextBingoRound: pick gate, then win check on the
// boards, then draw) until someone has a full row/column/diagonal -> phase
// 'finished' + winnerId/winnerIds (same finish contract as hitster).
// ---------------------------------------------------------------------------

/**
 * Host starts a bingo game: one individually randomized board per player and
 * the first simultaneous round (card + spun category). The deck is its own
 * draw source - no timelines involved.
 */
export async function startBingoGame(
  lobbyId: string,
  cards: GameCard[],
  config: {
    bingoGridSize: 4 | 5;
    bingoDifficulty: BingoDifficulty;
    bingoSongSeconds: number;
    sourceId?: string;
    sourceName?: string;
  }
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  if (players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
  if (cards.length < 10) {
    throw new Error(`Nur ${cards.length} Tracks - zu wenige für ein Bingo-Spiel.`);
  }

  for (const p of players) {
    const { error } = await supabase
      .from('lobby_players')
      .update({ bingo_board: generateBingoBoard(config.bingoGridSize) })
      .eq('id', p.id);
    if (error) {
      throw new Error(`Bingo-Board konnte nicht verteilt werden: ${error.message}`);
    }
  }

  // Covers: only the first card urgently (revealed at round end); the rest
  // loads in the background after the start write - never blocks starting.
  const [first, ...deck] = await Spotify.addCoverArtUrgent(shuffle(cards), 2);
  const base: OnlineGameState = {
    deck,
    currentCard: first,
    activePlayerId: '', // no active player in simultaneous modes
    phase: 'simul_round',
    pendingInsertIndex: null,
    lastResult: null,
    hitsterCallerId: null,
    passedHitster: [],
    stealResult: null,
    stealEqualYear: false,
    turnOrder: players.map((p) => p.player_id),
    cardsToWin: 0, // unused in bingo (win = full row/column/diagonal)
    hideCoverUntilRevealed: true,
    winnerId: null,
    gameMode: 'bingo',
    // Difficulty + Song-Zeit ride along in modeConfig (synced to every client
    // via game_state, same as the grid size).
    modeConfig: {
      bingoGridSize: config.bingoGridSize,
      bingoDifficulty: config.bingoDifficulty,
      bingoSongSeconds: config.bingoSongSeconds,
    },
    sourceId: config.sourceId ?? null,
    sourceName: config.sourceName ?? null,
    // Decade MC options are cut from the pool's real span (fixed at start, so
    // the shrinking deck can't narrow the choices over the game).
    bingoDecades: decadeRange(cards),
    // Year-guess slider range = the pool's real span (display only; the
    // ±tolerance grading is independent of these bounds).
    bingoYearMin: yearBounds(cards).min,
    bingoYearMax: yearBounds(cards).max,
    bingoRound: drawBingoRound(first, decadeRange(cards), config.bingoDifficulty),
    bingoStatsHistory: [],
    // Round 1 opens in the SPIN stage: the first player (join order) presses
    // the wheel button; the answer deadline is only set on the press.
    roundNumber: 1,
    roundDeadline: null,
    roundPhase: 'spinning',
    roundResults: null,
    spinnerId: players[0].player_id,
    spinArmedAt: serverNow(),
    spinStartedAt: null,
  };
  // Leftover answers of a previous game in this lobby would collide with the
  // (lobby, round, player) unique key (startSimulRound did this before).
  await supabase.from('round_answers').delete().eq('lobby_id', lobbyId);
  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: base, status: 'playing' })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spiel konnte nicht gestartet werden: ${error.message}`);
  // Remaining covers load in the background; nextBingoRound stamps them on.
  Spotify.startCoverArtPrefetch([first, ...deck]);
}

/**
 * The round's designated spinner (or, after BINGO_SPIN_OPEN_ALL_MS, anyone)
 * presses the wheel button: spinning -> collecting in one atomic write.
 * spinStartedAt is the shared animation timestamp for all clients, and the
 * answer deadline covers spin animation + the normal answer window - so the
 * generic deadline/all-answered triggers keep working unchanged (the answer
 * UI simply stays hidden until the wheel stopped).
 */
export async function triggerBingoSpin(lobbyId: string): Promise<void> {
  const myId = getPlayerId();
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    gs.gameMode !== 'bingo' ||
    gs.roundPhase !== 'spinning' ||
    gs.roundNumber == null
  ) {
    return;
  }
  const openForAll =
    gs.spinArmedAt == null || serverNow() >= gs.spinArmedAt + BINGO_SPIN_OPEN_ALL_MS;
  if (gs.spinnerId !== myId && !openForAll) return;

  const now = serverNow();
  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        roundPhase: 'collecting',
        spinStartedAt: now,
        // Answer window begins only after the wheel AND the 3-2-1 countdown, so
        // the new song (which starts at the end of the countdown) plays for the
        // full configured Song-Zeit (fallback: BINGO_ROUND_SECONDS for games
        // started before the setting existed).
        roundDeadline:
          now +
          BINGO_SPIN_MS +
          BINGO_COUNTDOWN_MS +
          (gs.modeConfig?.bingoSongSeconds ?? BINGO_ROUND_SECONDS) * 1000,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'spinning')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
}

/**
 * Advance the current bingo round. Safe to call from ANY client and multiple
 * times (deadline timers run everywhere + the "all answered" trigger); every
 * state transition below is an atomic conditional update, so parallel callers
 * dedupe.
 *
 * Routing:
 *   - title_artist round in 'collecting' with answers: open the HOST REVIEW
 *     (collecting -> reviewing) instead of resolving - free texts cannot be
 *     auto-graded. Zero answers skip the review (nothing to judge).
 *   - round in 'reviewing': resolve only when the host judged every answer OR
 *     the review deadline passed (any client may then fire; unjudged answers
 *     fall back to the honor rule: non-empty text = correct).
 *   - everything else: normal resolution.
 *
 * The resolution itself no longer marks cells: it opens the PICK WINDOW
 * (pickDeadline) in the same write and records expectedMarks - each correct
 * player then chooses their own cell via pickBingoCell. Win detection happens
 * in nextBingoRound AFTER the pick window (Doppelsieg contract).
 */
export async function resolveBingoRound(lobbyId: string): Promise<void> {
  const { game_state: pre } = await getLobby(lobbyId);
  if (!pre || pre.gameMode !== 'bingo' || pre.roundNumber == null) return;
  const isTitleRound = pre.bingoRound?.type === 'title_artist';
  const isBandRound = pre.bingoRound?.type === 'band_or_solo';
  // Both host-reviewed categories share the reviewing phase: title_artist with
  // per-player verdicts, band_or_solo with a single one-tap truth.
  const needsReview = isTitleRound || isBandRound;

  if (pre.roundPhase === 'collecting' && needsReview) {
    const answers = await getRoundAnswers(lobbyId, pre.roundNumber);
    if (answers.length > 0) {
      await openBingoReview(lobbyId, pre, answers.length);
      return;
    }
    // else: nobody answered - nothing to review, fall through to resolve.
  }

  if (pre.roundPhase === 'reviewing') {
    if (!needsReview) return; // defensive: reviewing only exists for review rounds
    const deadlinePassed =
      pre.reviewDeadline == null || serverNow() >= pre.reviewDeadline;
    if (isBandRound) {
      const truthSet = typeof pre.reviewTruthGroup === 'boolean';
      if (!truthSet && !deadlinePassed) return;
    } else {
      const answers = await getRoundAnswers(lobbyId, pre.roundNumber);
      const verdicts = pre.reviewVerdicts ?? {};
      const allJudged = answers.every((a) => typeof verdicts[a.player_id] === 'boolean');
      if (!allJudged && !deadlinePassed) return;
    }
  }

  await resolveSimulRound(
    lobbyId,
    async (answers, gs) => {
      const card = gs.currentCard;
      const round = gs.bingoRound;
      const results: Record<string, RoundOutcome> = {};
      if (card && round) {
        for (const a of answers) {
          if (round.type === 'title_artist') {
            // Host verdict wins; unjudged (host gone / timeout) falls back to
            // the category's old honor semantics: non-empty text = claim.
            const v = gs.reviewVerdicts?.[a.player_id];
            results[a.player_id] =
              typeof v === 'boolean'
                ? v
                  ? 'correct'
                  : 'incorrect'
                : titleAnswerText(a.answer).trim().length > 0
                  ? 'correct'
                  : 'incorrect';
          } else if (round.type === 'band_or_solo') {
            // Graded against the host's one-tap truth; without one (host gone
            // / timeout) the honor fallback counts every claim as correct.
            const truth = gs.reviewTruthGroup;
            const claim = bandAnswerGroup(a.answer);
            results[a.player_id] =
              typeof truth === 'boolean'
                ? claim === truth
                  ? 'correct'
                  : 'incorrect'
                : claim != null
                  ? 'correct'
                  : 'incorrect';
          } else {
            results[a.player_id] = evaluateBingoAnswer(round, card, a.answer)
              ? 'correct'
              : 'incorrect';
          }
        }
      }

      // Pick targets: base mark count per player, +1 only for correct players
      // that still HAVE a free cell of the round color. Everyone can then tell
      // "has picked" by comparing countMarked(board) against this - no extra
      // column, no concurrent game_state writers.
      const players = await getLobbyPlayers(lobbyId);
      const expectedMarks: Record<string, number> = {};
      for (const p of players) {
        const board = p.bingo_board ?? [];
        const earnsPick =
          round != null &&
          results[p.player_id] === 'correct' &&
          freeCellIndices(board, round.type).length > 0;
        expectedMarks[p.player_id] = countMarked(board) + (earnsPick ? 1 : 0);
      }

      // Stats: one event per player per resolved round (missed = not
      // fulfilled). Appended inside this patch, so it lands in the SAME
      // atomically claimed final write as the round results - a dead claim
      // never wrote, a re-claim recomputes identically: no loss, no dupes.
      const bingoStatsHistory = [...(gs.bingoStatsHistory ?? [])];
      if (card && round) {
        for (const p of players) {
          const board = p.bingo_board ?? [];
          const correct = results[p.player_id] === 'correct';
          bingoStatsHistory.push({
            playerId: p.player_id,
            category: round.type,
            correct,
            // "Sad Bingo" raw data: correct answer, but the color was already
            // fully marked (mirrors earnsPick above, computed independently
            // here since expectedMarks doesn't carry a per-color breakdown).
            overfull: correct && freeCellIndices(board, round.type).length === 0,
            song: toStatsSong(card),
          });
        }
      }

      return {
        results,
        patch: {
          pickDeadline: serverNow() + BINGO_PICK_SECONDS * 1000,
          expectedMarks,
          reviewDeadline: null,
          reviewVerdicts: null,
          reviewTruthGroup: null,
          bingoStatsHistory,
        },
      };
    },
    { fromReviewing: true }
  );
}

/**
 * Open the host-review phase for a title_artist or band_or_solo round:
 * collecting -> reviewing (atomic; parallel deadline/all-answered triggers
 * dedupe on the filter). Applies the same premature-trigger defense as normal
 * resolution.
 */
async function openBingoReview(
  lobbyId: string,
  gs: OnlineGameState,
  answerCount: number
): Promise<void> {
  const deadlinePassed = gs.roundDeadline == null || serverNow() >= gs.roundDeadline;
  if (!deadlinePassed) {
    const players = await getLobbyPlayers(lobbyId);
    if (players.length === 0 || answerCount < players.length) return;
  }
  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        roundPhase: 'reviewing',
        reviewDeadline: serverNow() + BINGO_REVIEW_SECONDS * 1000,
        reviewVerdicts: {},
        reviewTruthGroup: null,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'collecting')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
}

/**
 * Host writes the current verdict map (player_id -> correct?). Full-map
 * writes from the host's local state - single writer, so no read-modify-write
 * races; guarded on phase + roundNumber so a late write can't touch a round
 * that already resolved.
 */
export async function setBingoVerdicts(
  lobbyId: string,
  verdicts: Record<string, boolean>
): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    gs.gameMode !== 'bingo' ||
    gs.roundPhase !== 'reviewing' ||
    gs.roundNumber == null
  ) {
    return;
  }
  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: { ...gs, reviewVerdicts: verdicts } as OnlineGameState })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'reviewing')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
  if (error) throw new Error(`Bewertung konnte nicht gespeichert werden: ${error.message}`);
}

/**
 * Host sets the band_or_solo truth (true = Gruppe/Band) in the review phase;
 * all submitted claims are then graded against it on resolve. Same
 * single-writer + phase/round guards as setBingoVerdicts.
 */
export async function setBingoTruth(lobbyId: string, group: boolean): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    gs.gameMode !== 'bingo' ||
    gs.roundPhase !== 'reviewing' ||
    gs.roundNumber == null
  ) {
    return;
  }
  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: { ...gs, reviewTruthGroup: group } as OnlineGameState })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'reviewing')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
  if (error) throw new Error(`Bewertung konnte nicht gespeichert werden: ${error.message}`);
}

/**
 * A correct player marks the free cell of the round color THEY chose (called
 * by the picker's own client - tap, single-option auto-pick or the timeout
 * random pick). Only the owner writes their board row, so a plain update is
 * race-free; the expectedMarks cap plus the phase/color/free guards make
 * double or foreign marks impossible. Silently a no-op when the round has
 * moved on (late pick after the window: the mark is forfeited, see
 * nextBingoRound's gate).
 */
export async function pickBingoCell(lobbyId: string, cellIndex: number): Promise<void> {
  const myId = getPlayerId();
  const [{ game_state: gs }, players] = await Promise.all([
    getLobby(lobbyId),
    getLobbyPlayers(lobbyId),
  ]);
  const me = players.find((p) => p.player_id === myId);
  if (
    !gs ||
    gs.gameMode !== 'bingo' ||
    gs.roundPhase !== 'resolved' ||
    !gs.bingoRound ||
    !me?.bingo_board ||
    gs.roundResults?.[myId] !== 'correct'
  ) {
    return;
  }
  const expected = gs.expectedMarks?.[myId];
  if (expected == null || countMarked(me.bingo_board) >= expected) return; // already picked
  const cell = me.bingo_board[cellIndex];
  if (!cell || cell.marked || cell.color !== gs.bingoRound.type) return;

  const { error } = await supabase
    .from('lobby_players')
    .update({ bingo_board: markCell(me.bingo_board, cellIndex) })
    .eq('id', me.id);
  if (error) throw new Error(`Feld konnte nicht markiert werden: ${error.message}`);
}

/**
 * Host advances the bingo game (button on the result view). Atomic on
 * roundPhase 'resolved' + the current roundNumber, so a double-tap can never
 * skip a card or bump the round twice.
 *
 * Order of checks:
 *   1. PICK GATE: while the pick window is open and not everyone has picked
 *      (countMarked vs. expectedMarks), do nothing - a slow picker keeps their
 *      choice. After pickDeadline the round moves on regardless; an unpicked
 *      mark is forfeited (never blocks the party on one absent player).
 *   2. WIN CHECK: full row/column/diagonal on the CURRENT boards - everyone
 *      who completed during the same pick window wins together (Doppelsieg).
 *   3. Otherwise draw the next card; empty deck ends the game without winner.
 */
export async function nextBingoRound(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    gs.gameMode !== 'bingo' ||
    gs.roundPhase !== 'resolved' ||
    gs.winnerId ||
    gs.roundNumber == null
  ) {
    return;
  }

  const players = await getLobbyPlayers(lobbyId);
  const allPicked = players.every(
    (p) => countMarked(p.bingo_board) >= (gs.expectedMarks?.[p.player_id] ?? 0)
  );
  if (!allPicked && gs.pickDeadline != null && serverNow() < gs.pickDeadline) return;

  const size = gs.modeConfig?.bingoGridSize ?? 4;
  const winnerIds = players
    .filter((p) => p.bingo_board && hasBingo(p.bingo_board, size))
    .map((p) => p.player_id);
  if (winnerIds.length > 0) {
    const { data } = await supabase
      .from('lobbies')
      .update({
        game_state: {
          ...gs,
          phase: 'finished',
          winnerId: winnerIds[0],
          winnerIds,
          pickDeadline: null,
          expectedMarks: null,
          reviewDeadline: null,
          reviewVerdicts: null,
          reviewTruthGroup: null,
        } as OnlineGameState,
      })
      .eq('id', lobbyId)
      .filter('game_state->>roundPhase', 'eq', 'resolved')
      .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber))
      .select();
    if (data && data.length > 0) {
      await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
    }
    return;
  }

  if (gs.deck.length === 0) {
    await writeGameState(lobbyId, {
      ...gs,
      phase: 'finished',
      pickDeadline: null,
      expectedMarks: null,
      reviewDeadline: null,
      reviewVerdicts: null,
      reviewTruthGroup: null,
    });
    await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
    return;
  }

  const [next, ...rest] = gs.deck;
  // Round-robin spinner over the live roster (join order): new round number is
  // gs.roundNumber + 1, so the 0-based index is gs.roundNumber % players.
  const spinner = players[gs.roundNumber % Math.max(1, players.length)];
  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        deck: rest,
        currentCard: Spotify.withCachedCover(next),
        bingoRound: drawBingoRound(
          next,
          gs.bingoDecades ?? undefined,
          gs.modeConfig?.bingoDifficulty ?? 'easy'
        ),
        roundNumber: gs.roundNumber + 1,
        roundDeadline: null,
        roundPhase: 'spinning',
        roundResults: null,
        pickDeadline: null,
        expectedMarks: null,
        reviewDeadline: null,
        reviewVerdicts: null,
        reviewTruthGroup: null,
        spinnerId: spinner?.player_id ?? null,
        spinArmedAt: serverNow(),
        spinStartedAt: null,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'resolved')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
}

// ---------------------------------------------------------------------------
// Timeline-Quiz mode (game logic on top of the simultaneous-round foundation).
//
// Everyone places the same mystery song into ONE shared timeline (starts as
// pure year slots, grows by the real song each round). Correct slot = +1 point
// (lobby_players.score). Fixed number of rounds; highest score wins - ties
// share the win (winnerIds, like bingo). Resolution may run on ANY client.
// ---------------------------------------------------------------------------

/**
 * Host starts a timeline quiz: scores reset, shared base timeline generated
 * from the pool's year span, first round opened. The round count comes from
 * mode_config (clamped to the deck size).
 */
export async function startTimelineQuiz(
  lobbyId: string,
  cards: GameCard[],
  config: { timelineCardCount: number; sourceId?: string; sourceName?: string }
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  if (players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
  if (cards.length < 5) {
    throw new Error(`Nur ${cards.length} Tracks - zu wenige für ein Timeline-Quiz.`);
  }
  const totalRounds = Math.max(1, Math.min(config.timelineCardCount, cards.length));

  for (const p of players) {
    const { error } = await supabase
      .from('lobby_players')
      .update({ score: 0 })
      .eq('id', p.id);
    if (error) throw new Error(`Punktestand konnte nicht zurückgesetzt werden: ${error.message}`);
  }

  // Covers: only the first card urgently (revealed at round end); the rest
  // loads in the background after the start write - never blocks starting.
  const [first, ...deck] = await Spotify.addCoverArtUrgent(shuffle(cards), 2);
  const base: OnlineGameState = {
    deck,
    currentCard: first,
    activePlayerId: '', // no active player in simultaneous modes
    phase: 'simul_round',
    pendingInsertIndex: null,
    lastResult: null,
    hitsterCallerId: null,
    passedHitster: [],
    stealResult: null,
    stealEqualYear: false,
    turnOrder: players.map((p) => p.player_id),
    cardsToWin: 0, // unused (fixed round count instead)
    hideCoverUntilRevealed: true,
    winnerId: null,
    gameMode: 'timeline_quiz',
    modeConfig: { timelineCardCount: totalRounds },
    sourceId: config.sourceId ?? null,
    sourceName: config.sourceName ?? null,
    quizTimeline: generateBaseTimeline(cards),
    quizTotalRounds: totalRounds,
    quizStatsHistory: [],
  };
  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: base, status: 'playing' })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spiel konnte nicht gestartet werden: ${error.message}`);
  // Remaining covers load in the background; the next-round draw stamps them on.
  Spotify.startCoverArtPrefetch([first, ...deck]);

  // Opens round 1 on the foundation (also clears stale round_answers).
  await startSimulRound(lobbyId, QUIZ_ROUND_SECONDS);
}

/**
 * Resolve the current quiz round (safe from ANY client; the foundation claim
 * dedupes). evaluate grades every submitted slot against the shared timeline
 * and - in the same write - grows the timeline by the song's real year, so all
 * clients see the same denser timeline afterwards. The claim winner then
 * awards +1 score to every correct player.
 */
export async function resolveTimelineQuizRound(lobbyId: string): Promise<void> {
  const claimed = await resolveSimulRound(lobbyId, async (answers, gs) => {
    const card = gs.currentCard;
    const timeline = gs.quizTimeline ?? [];
    const results: Record<string, RoundOutcome> = {};
    if (card) {
      for (const a of answers) {
        const slot = (a.answer as { slot?: unknown } | null)?.slot;
        results[a.player_id] =
          typeof slot === 'number' && isCorrectQuizPlacement(timeline, card.year, slot)
            ? 'correct'
            : 'incorrect';
      }
    }

    // Stats: one event per player per resolved round (missed = wrong, binary
    // like the score). Appended inside this patch, so it lands in the SAME
    // atomically claimed final write as the round results - a dead claim
    // never wrote, a re-claim recomputes identically: no loss, no dupes.
    const quizStatsHistory = [...(gs.quizStatsHistory ?? [])];
    if (card) {
      const players = await getLobbyPlayers(lobbyId);
      for (const p of players) {
        quizStatsHistory.push({
          playerId: p.player_id,
          correct: results[p.player_id] === 'correct',
          song: toStatsSong(card),
        });
      }
    }

    const patch = card
      ? {
          quizTimeline: insertQuizEntry(timeline, {
            year: card.year,
            title: card.title,
            artist: card.artist,
          }),
          quizStatsHistory,
        }
      : {};
    return { results, patch };
  });
  if (!claimed) return;

  // Post-claim side effect - exactly ONE client runs this.
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.gameMode !== 'timeline_quiz') return;
  const players = await getLobbyPlayers(lobbyId);
  for (const p of players) {
    if (gs.roundResults?.[p.player_id] === 'correct') {
      await supabase.from('lobby_players').update({ score: p.score + 1 }).eq('id', p.id);
    }
  }
}

/**
 * Host advances the quiz (button on the result view; atomic on roundPhase +
 * roundNumber like nextBingoRound). After the configured number of rounds (or
 * an empty deck) the game finishes: highest score wins, ties share the win.
 */
export async function nextTimelineQuizRound(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (
    !gs ||
    gs.gameMode !== 'timeline_quiz' ||
    gs.roundPhase !== 'resolved' ||
    gs.winnerId ||
    gs.roundNumber == null
  ) {
    return;
  }

  const isLast = gs.roundNumber >= (gs.quizTotalRounds ?? 1) || gs.deck.length === 0;
  if (isLast) {
    const players = await getLobbyPlayers(lobbyId);
    const top = Math.max(...players.map((p) => p.score));
    const winnerIds = players.filter((p) => p.score === top).map((p) => p.player_id);
    const { data } = await supabase
      .from('lobbies')
      .update({
        game_state: {
          ...gs,
          phase: 'finished',
          winnerId: winnerIds[0] ?? null,
          winnerIds,
        } as OnlineGameState,
      })
      .eq('id', lobbyId)
      .filter('game_state->>roundPhase', 'eq', 'resolved')
      .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber))
      .select();
    if (data && data.length > 0) {
      await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
    }
    return;
  }

  const [next, ...rest] = gs.deck;
  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        deck: rest,
        currentCard: Spotify.withCachedCover(next),
        roundNumber: gs.roundNumber + 1,
        roundDeadline: serverNow() + QUIZ_ROUND_SECONDS * 1000,
        roundPhase: 'collecting',
        roundResults: null,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'resolved')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
}

// ---------------------------------------------------------------------------
// Song reports ("Song melden" from the in-game overflow menu).
// ---------------------------------------------------------------------------

/** Fixed report reasons - deliberately no free text (privacy/security). */
export type SongReportReason = 'wrong_year' | 'wrong_title_artist' | 'not_in_pool' | 'other';

export type SongReportMode = 'hitster' | 'bingo' | 'timeline_quiz' | 'pass_and_play';

/**
 * Write one song report (snapshot of the song AS DISPLAYED at report time -
 * not a pool reference, so it stays traceable after corrections). The
 * song_reports table is INSERT-only for the app (migration 009); Arni reads
 * it manually in the Supabase table editor. Throws on failure (offline etc.) -
 * the dialog surfaces that as a non-blocking retryable message.
 */
export async function reportSong(report: {
  title: string;
  artist: string;
  year: number;
  trackUri: string;
  sourceId?: string | null;
  sourceName?: string | null;
  reason: SongReportReason;
  mode: SongReportMode;
  /** Party lobby id; null/undefined = Pass & Play (local game). */
  lobbyId?: string | null;
}): Promise<void> {
  const { error } = await supabase.from('song_reports').insert({
    title: report.title,
    artist: report.artist,
    year: report.year,
    track_uri: report.trackUri,
    source_id: report.sourceId ?? null,
    source_name: report.sourceName ?? null,
    reason: report.reason,
    mode: report.mode,
    lobby_id: report.lobbyId ?? null,
  });
  if (error) throw new Error(`Meldung konnte nicht gespeichert werden: ${error.message}`);
}

/**
 * Live updates for BOTH lobbies.game_state and lobby_players (timelines/scores).
 * `onStatus` receives the channel lifecycle status so the caller can recover from
 * a stale socket (CLOSED / TIMED_OUT / CHANNEL_ERROR).
 */
export function subscribeToGameState(
  lobbyId: string,
  onChange: () => void,
  onStatus?: (status: string) => void
): () => void {
  const channel = supabase
    .channel(uniqueChannelTopic(`game:${lobbyId}`))
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}` },
      () => {
        onChange();
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lobby_players', filter: `lobby_id=eq.${lobbyId}` },
      () => {
        onChange();
      }
    )
    .on(
      'postgres_changes',
      // Simultaneous-round submissions ("3/5 haben geantwortet", host resolves
      // early when everyone answered). No-op until migration 005 ran.
      { event: '*', schema: 'public', table: 'round_answers', filter: `lobby_id=eq.${lobbyId}` },
      () => {
        onChange();
      }
    )
    .subscribe((status) => {
      onStatus?.(status);
    });
  return () => {
    supabase.removeChannel(channel);
  };
}
