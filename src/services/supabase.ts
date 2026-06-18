/**
 * Supabase client + Online lobby helpers.
 *
 * Pure JS (no native module) - @supabase/supabase-js uses fetch + WebSocket,
 * which RN provides. `react-native-url-polyfill/auto` is imported first so URL
 * parsing works reliably in RN.
 *
 * Identity: there is no login. Each app session gets a random player_id. It is
 * currently IN-MEMORY (lost on app restart). For per-install persistence use
 * @react-native-async-storage/async-storage (native module -> needs a rebuild) -
 * swap only the getPlayerId() implementation below.
 */
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
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

let cachedPlayerId: string | null = null;

/** Stable-per-session random id for this device/install (see note above). */
export function getPlayerId(): string {
  if (!cachedPlayerId) cachedPlayerId = Crypto.randomUUID();
  return cachedPlayerId;
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
    .channel(`lobby_players:${lobbyId}`)
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
// Game state (Etappe 2) — NO steal/Hitster yet (comes in Etappe 4).
//
// Race safety: per turn only TWO writers act, and on disjoint data — the active
// player writes pendingInsertIndex (placeCard), the host writes everything else
// (confirmGuess / resolvePlacement / drawNextCard). UI buttons are gated by phase
// + role so the same action isn't triggered twice. Good enough for this stage;
// DB-level optimistic concurrency can be added later if needed.
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

/** Active player picks a slot; host resolves it afterwards. */
export async function placeCard(lobbyId: string, insertIndex: number): Promise<void> {
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;
  await writeGameState(lobbyId, { ...gs, pendingInsertIndex: insertIndex, phase: 'placing' });
}

/** Host confirms whether title+artist were guessed -> award a Nickel if yes. */
export async function confirmGuess(lobbyId: string, wasCorrect: boolean): Promise<void> {
  if (!wasCorrect) return;
  const { game_state: gs } = await getLobby(lobbyId);
  if (!gs) return;
  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active) return;
  const chips = Math.min(active.chips + 1, MAX_CHIPS);
  await supabase.from('lobby_players').update({ chips }).eq('id', active.id);
}

/** Host resolves the pending placement (reuses isCorrectPlacement from game.ts). */
export async function resolvePlacement(lobbyId: string): Promise<void> {
  const lobby = await getLobby(lobbyId);
  const gs = lobby.game_state;
  if (!gs || !gs.currentCard || gs.pendingInsertIndex == null) return;

  const players = await getLobbyPlayers(lobbyId);
  const active = players.find((p) => p.player_id === gs.activePlayerId);
  if (!active) return;

  const card = gs.currentCard;
  const idx = gs.pendingInsertIndex;
  const correct = isCorrectPlacement(active.timeline, card, idx);
  const newTimeline = correct ? insertAt(active.timeline, card, idx) : active.timeline;
  const newScore = correct ? active.score + 1 : active.score;

  await supabase
    .from('lobby_players')
    .update({ timeline: newTimeline, score: newScore })
    .eq('id', active.id);

  const won = correct && newScore >= gs.cardsToWin;
  await writeGameState(lobbyId, {
    ...gs,
    lastResult: correct ? 'correct' : 'incorrect',
    phase: won ? 'finished' : 'revealing',
    winnerId: won ? active.player_id : gs.winnerId,
  });
  if (won) {
    await supabase.from('lobbies').update({ status: 'finished' }).eq('id', lobbyId);
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
    currentCard: next,
    activePlayerId: nextActive,
    phase: 'card_drawn',
    pendingInsertIndex: null,
    lastResult: null,
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
    .channel(`game:${lobbyId}`)
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
