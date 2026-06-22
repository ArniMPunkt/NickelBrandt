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
import { MAX_CHIPS } from '../types/game';
import type { GameCard, Lobby, LobbyPlayer, OnlineGameState } from '../types/online';

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
    console.log(`[LobbyDebug] createLobby host=${hostId} -> lobby id=${lobby.id} code=${lobby.code}`);
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
  console.log(`[LobbyDebug] joinLobby player=${playerId} -> lobby id=${lobby.id} code=${lobby.code} (alreadyIn=${!!existing})`);
  return lobby as Lobby;
}

/** Remove this device's player row from a lobby. */
export async function leaveLobby(lobbyId: string): Promise<void> {
  const playerId = getPlayerId();
  await supabase
    .from('lobby_players')
    .delete()
    .eq('lobby_id', lobbyId)
    .eq('player_id', playerId);
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
  console.log(
    `[LobbyDebug] getLobbyPlayers lobby=${lobbyId} -> ${players.length} players:`,
    players.map((p) => p.player_name)
  );
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
      (payload) => {
        console.log(`[LobbyDebug] lobby_players event: ${payload.eventType}`);
        onChange();
      }
    )
    .subscribe((status, err) => {
      console.log(`[LobbyDebug] lobby_players channel status: ${status}`, err ?? '');
    });

  return () => {
    supabase.removeChannel(channel);
  };
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

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function insertAt<T>(arr: T[], item: T, index: number): T[] {
  return [...arr.slice(0, index), item, ...arr.slice(index)];
}

export async function getLobby(lobbyId: string): Promise<Lobby> {
  const { data, error } = await supabase
    .from('lobbies')
    .select('*')
    .eq('id', lobbyId)
    .single();
  if (error) throw new Error(`Lobby konnte nicht geladen werden: ${error.message}`);
  console.log(`[LobbyDebug] getLobby id=${lobbyId} status=${(data as Lobby).status}`);
  return data as Lobby;
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
  opts: { cardsToWin: number; hideCoverUntilRevealed: boolean }
): Promise<void> {
  const players = await getLobbyPlayers(lobbyId);
  if (players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
  if (cards.length < players.length + 1) {
    throw new Error(
      `Playlist hat nur ${cards.length} Tracks - zu wenige für ${players.length} Spieler.`
    );
  }

  const shuffled = shuffle(cards);

  // Deal one start card per player.
  for (let i = 0; i < players.length; i++) {
    const { error } = await supabase
      .from('lobby_players')
      .update({ timeline: [shuffled[i]], score: 0, chips: 2, brandts_count: 0 })
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
    stealResult: null,
    turnOrder,
    cardsToWin: opts.cardsToWin,
    hideCoverUntilRevealed: opts.hideCoverUntilRevealed,
    winnerId: null,
  };

  const { error } = await supabase
    .from('lobbies')
    .update({ game_state: gameState, status: 'playing' })
    .eq('id', lobbyId);
  if (error) throw new Error(`Spiel konnte nicht gestartet werden: ${error.message}`);
}

/** The slot at which `year` keeps a sorted (ascending) timeline sorted. */
function sortedInsertIndex(timeline: GameCard[], year: number): number {
  let i = 0;
  while (i < timeline.length && timeline[i].year <= year) i++;
  return i;
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
    stealResult: null,
    lastResult: null,
  });
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
  console.log(`[GameDebug] callHitster caller=${callerId} won=${won}`, error?.message ?? '');
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
        hitsterCallerId: null,
        winnerId: won ? active.player_id : gs.winnerId,
      } as OnlineGameState,
    })
    .eq('id', lobbyId)
    .filter('game_state->>phase', 'eq', 'hitster_window')
    .filter('game_state->>hitsterCallerId', 'is', null)
    .select();

  if (!data || data.length === 0) {
    console.log('[GameDebug] closeHitsterWindow: lost to a caller, steal proceeds');
    return;
  }
  if (correct) {
    await supabase
      .from('lobby_players')
      .update({ timeline: insertAt(active.timeline, card, idx), score: newScore })
      .eq('id', active.id);
  }
  if (won) await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
}

/**
 * The Hitster caller picks a slot in the ACTIVE player's timeline. Correctness is
 * judged against the active player's timeline + the caller's slot (same logic as
 * hot-seat). Success: card -> caller's OWN sorted timeline + score + brandt, -1
 * Nickel. Miss: -1 Nickel, then the active player's own placement is evaluated.
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
  const stealCorrect = isCorrectPlacement(active.timeline, card, insertIndex);
  const activeCorrect = isCorrectPlacement(active.timeline, card, gs.pendingInsertIndex);
  let winnerId: string | null = gs.winnerId;

  // Caller: always -1 Nickel; on success card joins their own timeline + brandt.
  const callerUpdate: Record<string, unknown> = { chips: Math.max(0, caller.chips - 1) };
  if (stealCorrect) {
    const idx = sortedInsertIndex(caller.timeline, card.year);
    const newScore = caller.score + 1;
    callerUpdate.timeline = insertAt(caller.timeline, card, idx);
    callerUpdate.score = newScore;
    callerUpdate.brandts_count = caller.brandts_count + 1;
    if (newScore >= gs.cardsToWin) winnerId = caller.player_id;
  }
  await supabase.from('lobby_players').update(callerUpdate).eq('id', caller.id);

  // Active player keeps the card only if the steal missed AND they were correct.
  if (!stealCorrect && activeCorrect) {
    const newScore = active.score + 1;
    await supabase
      .from('lobby_players')
      .update({ timeline: insertAt(active.timeline, card, gs.pendingInsertIndex), score: newScore })
      .eq('id', active.id);
    if (newScore >= gs.cardsToWin) winnerId = active.player_id;
  }

  const won = !!winnerId;
  console.log(
    `[GameDebug] resolveHitsterPlacement caller=${callerId} stealCorrect=${stealCorrect} activeCorrect=${activeCorrect}`
  );
  await writeGameState(lobbyId, {
    ...gs,
    phase: won ? 'finished' : 'awaiting_host_confirmation',
    lastResult: activeCorrect ? 'correct' : 'incorrect',
    stealResult: stealCorrect ? 'correct' : 'incorrect',
    hitsterCallerId: callerId,
    winnerId,
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
  if (wasCorrect) {
    const players = await getLobbyPlayers(lobbyId);
    const active = players.find((p) => p.player_id === gs.activePlayerId);
    if (active) {
      await supabase
        .from('lobby_players')
        .update({ chips: Math.min(active.chips + 1, MAX_CHIPS) })
        .eq('id', active.id);
    }
  }
  await writeGameState(lobbyId, { ...gs, phase: 'finished' });
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
    currentCard: next,
    activePlayerId: nextActive,
    phase: 'card_drawn',
    pendingInsertIndex: null,
    lastResult: null,
    hitsterCallerId: null,
    stealResult: null,
  });
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
      (payload) => {
        console.log(`[LobbyDebug] game/lobbies event: ${payload.eventType}`);
        onChange();
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lobby_players', filter: `lobby_id=eq.${lobbyId}` },
      (payload) => {
        console.log(`[LobbyDebug] game/lobby_players event: ${payload.eventType}`);
        onChange();
      }
    )
    .subscribe((status, err) => {
      console.log(`[LobbyDebug] game channel status: ${status}`, err ?? '');
      onStatus?.(status);
    });
  return () => {
    supabase.removeChannel(channel);
  };
}
