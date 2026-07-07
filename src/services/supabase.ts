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
import { insertAt, sortedInsertIndex, shuffle } from '../game/cards';
import * as Spotify from './spotify';
import {
  BINGO_PICK_SECONDS,
  BINGO_COUNTDOWN_MS,
  BINGO_REVIEW_SECONDS,
  BINGO_ROUND_SECONDS,
  BINGO_SPIN_MS,
  BINGO_SPIN_OPEN_ALL_MS,
  countMarked,
  decadeRange,
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
  GameCard,
  GameMode,
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

/** Fetch the list of available themed song pools (name + description only). */
export async function getSongPools(): Promise<SongPool[]> {
  const { data, error } = await supabase
    .from('song_pools')
    .select('id, name, description, created_at')
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
 * Load all songs of a pool as GameCards (to be shuffled like a playlist deck).
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
  }
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  if (players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
  if (cards.length < players.length + 1) {
    throw new Error(
      `Playlist hat nur ${cards.length} Tracks - zu wenige für ${players.length} Spieler.`
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
    turnStartedAt: Date.now(),
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
    stealResult: null,
    stealEqualYear: false,
    lastResult: null,
  });
}

/**
 * "Karte überspringen": the active player discards the current card and draws a
 * replacement (same turn, phase stays card_drawn). Costs skipCost Nickel.
 * Locked at match point (score >= cardsToWin - 1): no Nickel assists on the
 * potentially winning card - the endgame has to be guessed.
 * Atomic on phase AND the current card id, so a double-tap (or a stale client)
 * can never skip twice / charge twice: the second write matches 0 rows.
 */
export async function skipCard(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'card_drawn' || !gs.currentCard || !gs.skipEnabled) return;
  if (gs.deck.length === 0) throw new Error('Keine Karten mehr im Deck.');
  const cost = gs.skipCost ?? 1;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active || active.chips < cost) return;
  if (active.score >= gs.cardsToWin - 1) return;

  const [next, ...rest] = gs.deck;
  const { data } = await supabase
    .from('lobbies')
    .update({
      // New song -> restart the music timer (turnStartedAt) too.
      game_state: {
        ...gs,
        currentCard: Spotify.withCachedCover(next),
        deck: rest,
        turnStartedAt: Date.now(),
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
 * is neither hit nor miss). Locked at match point (score >= cardsToWin - 1).
 * The turn ends immediately: no steal window, no host confirmation - rotate +
 * draw the next card directly (or finish on an empty deck, like drawNextCard).
 * Same atomic claim pattern as skipCard (phase + card id).
 */
export async function blindDraw(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'card_drawn' || !gs.currentCard || !gs.blindEnabled) return;
  const cost = gs.blindCost ?? 3;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active || active.chips < cost) return;
  if (active.score >= gs.cardsToWin - 1) return;

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
      turnStartedAt: Date.now(),
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
 * Atomically claim the "Hitster!" call. Returns true if THIS caller won.
 *
 * Atomicity: the UPDATE only writes when the row still has phase 'hitster_window'
 * AND hitster_caller_id IS NULL. Postgres takes a row lock per UPDATE; under READ
 * COMMITTED a second concurrent UPDATE waits for the first to commit and then
 * RE-EVALUATES its WHERE against the now-updated row - where hitster_caller_id is
 * no longer null - so it matches 0 rows. `.select()` returns the updated row only
 * to the winner (the loser gets []). This is the classic "UPDATE ... WHERE col IS
 * NULL RETURNING" claim, applied to a jsonb field via PostgREST json-path filters.
 * No Postgres function / migration needed.
 */
export async function callHitster(lobbyId: string, callerId: string): Promise<boolean> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window') return false;

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
 */
export async function closeHitsterWindow(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window' || !gs.currentCard || gs.pendingInsertIndex == null) {
    return;
  }
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active) return;

  const card = gs.currentCard;
  const idx = gs.pendingInsertIndex;
  const correct = isCorrectPlacement(active.timeline, card, idx);
  const newScore = correct ? active.score + 1 : active.score;
  const won = correct && newScore >= gs.cardsToWin;

  // Atomic transition (only if still an open, unclaimed window).
  const { data } = await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        phase: won ? 'finished' : 'awaiting_host_confirmation',
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
 * >=1 Nickel) has either called "Hitster!" or pressed "Kein Hitster". Safe to call
 * from any client: closeHitsterWindow is itself atomic.
 */
async function checkHitsterWindowComplete(lobbyId: string): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_window') return;

  const players = await getLobbyPlayers(lobbyId);
  const potential = players.filter(
    (p) => p.player_id !== gs.activePlayerId && p.chips >= 1
  );
  const passed = new Set(gs.passedHitster ?? []);
  const allResponded = potential.length > 0 && potential.every((p) => passed.has(p.player_id));
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
 */
export async function resolveHitsterPlacement(
  lobbyId: string,
  insertIndex: number
): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs || gs.phase !== 'hitster_resolving' || !gs.currentCard || gs.pendingInsertIndex == null) {
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
    if (newScore >= gs.cardsToWin) winnerId = caller.player_id;
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
    if (newScore >= gs.cardsToWin) winnerId = active.player_id;
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
      { type: 'place', playerId: active.player_id, song, correct: activeCorrect },
      {
        type: 'steal',
        playerId: caller.player_id,
        victimId: active.player_id,
        song,
        correct: stealCorrect,
      }
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
  if (wasCorrect) {
    const players = await getLobbyPlayers(lobbyId);
    const active = players.find((p) => p.player_id === gs.activePlayerId);
    if (active) {
      // Stats: log only ACTUALLY received Nickel (capped at MAX_CHIPS = not
      // received), together with the song it was earned on.
      if (active.chips < MAX_CHIPS) {
        statsHistory = appendStats(gs, {
          type: 'nickel',
          playerId: active.player_id,
          song: gs.currentCard ? toStatsSong(gs.currentCard) : undefined,
        });
      }
      await supabase
        .from('lobby_players')
        .update({ chips: Math.min(active.chips + 1, MAX_CHIPS) })
        .eq('id', active.id);
    }
  }
  await writeGameState(lobbyId, { ...gs, phase: 'finished', statsHistory });
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
    turnStartedAt: Date.now(),
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
    roundDeadline: Date.now() + durationSeconds * 1000,
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
    resolveClaimedAt: Date.now(),
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
    const deadlinePassed = gs.roundDeadline == null || Date.now() >= gs.roundDeadline;
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
    if (Date.now() - claimedAt < RESOLVE_STALE_MS) return false;
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
            : Date.now() + RESOLVE_RETRY_WINDOW_MS,
          reviewDeadline: backToReview
            ? Date.now() + RESOLVE_RETRY_WINDOW_MS
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
  config: { bingoGridSize: 4 | 5 }
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
    modeConfig: { bingoGridSize: config.bingoGridSize },
    // Decade MC options are cut from the pool's real span (fixed at start, so
    // the shrinking deck can't narrow the choices over the game).
    bingoDecades: decadeRange(cards),
    bingoRound: drawBingoRound(first, decadeRange(cards)),
    bingoStatsHistory: [],
    // Round 1 opens in the SPIN stage: the first player (join order) presses
    // the wheel button; the answer deadline is only set on the press.
    roundNumber: 1,
    roundDeadline: null,
    roundPhase: 'spinning',
    roundResults: null,
    spinnerId: players[0].player_id,
    spinArmedAt: Date.now(),
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
    gs.spinArmedAt == null || Date.now() >= gs.spinArmedAt + BINGO_SPIN_OPEN_ALL_MS;
  if (gs.spinnerId !== myId && !openForAll) return;

  const now = Date.now();
  await supabase
    .from('lobbies')
    .update({
      game_state: {
        ...gs,
        roundPhase: 'collecting',
        spinStartedAt: now,
        // Answer window begins only after the wheel AND the 3-2-1 countdown, so
        // the new song (which starts at the end of the countdown) plays for the
        // full BINGO_ROUND_SECONDS.
        roundDeadline: now + BINGO_SPIN_MS + BINGO_COUNTDOWN_MS + BINGO_ROUND_SECONDS * 1000,
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

  if (pre.roundPhase === 'collecting' && isTitleRound) {
    const answers = await getRoundAnswers(lobbyId, pre.roundNumber);
    if (answers.length > 0) {
      await openBingoReview(lobbyId, pre, answers.length);
      return;
    }
    // else: nobody answered - nothing to review, fall through to resolve.
  }

  if (pre.roundPhase === 'reviewing') {
    if (!isTitleRound) return; // defensive: reviewing only exists for title rounds
    const answers = await getRoundAnswers(lobbyId, pre.roundNumber);
    const verdicts = pre.reviewVerdicts ?? {};
    const allJudged = answers.every((a) => typeof verdicts[a.player_id] === 'boolean');
    const deadlinePassed =
      pre.reviewDeadline == null || Date.now() >= pre.reviewDeadline;
    if (!allJudged && !deadlinePassed) return;
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
          bingoStatsHistory.push({
            playerId: p.player_id,
            category: round.type,
            correct: results[p.player_id] === 'correct',
            song: toStatsSong(card),
          });
        }
      }

      return {
        results,
        patch: {
          pickDeadline: Date.now() + BINGO_PICK_SECONDS * 1000,
          expectedMarks,
          reviewDeadline: null,
          reviewVerdicts: null,
          bingoStatsHistory,
        },
      };
    },
    { fromReviewing: true }
  );
}

/**
 * Open the host-review phase for a title_artist round: collecting ->
 * reviewing (atomic; parallel deadline/all-answered triggers dedupe on the
 * filter). Applies the same premature-trigger defense as normal resolution.
 */
async function openBingoReview(
  lobbyId: string,
  gs: OnlineGameState,
  answerCount: number
): Promise<void> {
  const deadlinePassed = gs.roundDeadline == null || Date.now() >= gs.roundDeadline;
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
        reviewDeadline: Date.now() + BINGO_REVIEW_SECONDS * 1000,
        reviewVerdicts: {},
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
  if (!allPicked && gs.pickDeadline != null && Date.now() < gs.pickDeadline) return;

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
        bingoRound: drawBingoRound(next, gs.bingoDecades ?? undefined),
        roundNumber: gs.roundNumber + 1,
        roundDeadline: null,
        roundPhase: 'spinning',
        roundResults: null,
        pickDeadline: null,
        expectedMarks: null,
        reviewDeadline: null,
        reviewVerdicts: null,
        spinnerId: spinner?.player_id ?? null,
        spinArmedAt: Date.now(),
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
  config: { timelineCardCount: number }
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
    quizTimeline: generateBaseTimeline(cards),
    quizTotalRounds: totalRounds,
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
  const claimed = await resolveSimulRound(lobbyId, (answers, gs) => {
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
    const patch = card
      ? {
          quizTimeline: insertQuizEntry(timeline, {
            year: card.year,
            title: card.title,
            artist: card.artist,
          }),
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
        roundDeadline: Date.now() + QUIZ_ROUND_SECONDS * 1000,
        roundPhase: 'collecting',
        roundResults: null,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>roundPhase', 'eq', 'resolved')
    .filter('game_state->>roundNumber', 'eq', String(gs.roundNumber));
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
