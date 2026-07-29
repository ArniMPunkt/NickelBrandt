/**
 * Local, device-bound achievement/statistics profile - NO account, NO server
 * sync. One JSON blob in AsyncStorage, keyed by a stable per-install device
 * id (reuses the SAME id Party already persists via expo-secure-store, see
 * getPlayerId()/initPlayerId() in services/supabase.ts - one identity, not a
 * second one minted here).
 *
 * recordMatchResult (called once per finished match from each of the four
 * game screens) both collects raw match data into `stats` AND, in the same
 * pass, re-evaluates the full achievement catalog (achievementDefinitions.ts)
 * against the updated stats - every condition runs PURELY against
 * `profile.stats`, never touching game code, which is why matchHistory keeps
 * enough raw detail (full event logs, final timelines) rather than only
 * pre-tallied counts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPlayerId } from './supabase';
import type { MatchEvent } from '../types/game';
import { evaluateNewUnlocks, type AchievementDefinition } from './achievementDefinitions';

// Re-exported so screens that already `import * as Achievements from
// './achievements'` (the data-collection entry point) don't also need a
// separate import from achievementDefinitions.ts just for this one helper.
export { pickSpecialAchievement, type AchievementDefinition } from './achievementDefinitions';

const PROFILE_KEY = '@nickelbrandt/achievement_profile';

/**
 * How many recent matches to keep in full detail (raw events/timelines) -
 * older ones are dropped from matchHistory once exceeded, but the rolled-up
 * `stats` numbers (gamesPlayed, maxStreakEver, ...) already folded them in
 * and are never lost. Generous headroom for a Freundeskreis-scale hobby app;
 * revisit if AsyncStorage size ever becomes a real concern.
 */
const MAX_MATCH_HISTORY = 200;

export type GameModeKey = 'hitster_party' | 'hitster_pnp' | 'bingo' | 'timeline_quiz';

/**
 * One enriched place/steal event, slimmed from MatchEvent down to what a
 * later achievement check could need: gap-distance (Total daneben/Perfect
 * Hit/Insane Guess) and the round SEQUENCE via `type`+`playerId` in order
 * (Double/Triple Hitster - every round logs exactly one 'place' event
 * regardless of player, so that alone marks round boundaries).
 */
export interface HitsterStatsEvent {
  type: 'place' | 'steal';
  playerId: string;
  correct: boolean;
  year: number;
  leftYear: number | null;
  rightYear: number | null;
}

/**
 * Distills a MatchEvent[] log (Party and Pass & Play share the exact same
 * shape) down to the place/steal events recordMatchResult needs, dropping
 * 'nickel' entries (no listed achievement needs them). Shared by both
 * screens' record call so the filter/map logic exists exactly once.
 */
export function toHitsterStatsEvents(history: MatchEvent[]): HitsterStatsEvent[] {
  const out: HitsterStatsEvent[] = [];
  for (const e of history) {
    if (e.type !== 'place' && e.type !== 'steal') continue;
    out.push({
      type: e.type,
      playerId: e.playerId,
      correct: e.correct,
      year: e.song.year,
      leftYear: e.leftYear ?? null,
      rightYear: e.rightYear ?? null,
    });
  }
  return out;
}

export interface HitsterPlayerResult {
  playerId: string;
  won: boolean;
  /** This player's final timeline, years only, ascending (straights - Kleine/Große/Jahrzehnt). */
  finalTimelineYears: number[];
  maxStreak: number;
  chipsPeak: number;
}

export interface HitsterMatchInput {
  mode: 'hitster_party' | 'hitster_pnp';
  participantCount: number;
  /** FULL match event log (every player) - Double/Triple Hitster needs the whole round sequence, not just one player's events. */
  events: HitsterStatsEvent[];
  /**
   * One entry per player THIS DEVICE is responsible for recording: always
   * exactly one for Party (this device's own stable identity - every
   * connected device calls recordMatchResult for itself, never for anyone
   * else). For Pass & Play the device is physically shared by several real
   * people with no stable per-player identity across matches, so ALL of
   * them are recorded into this same device's profile - see the call site
   * in GameScreen.tsx for the reasoning.
   */
  players: HitsterPlayerResult[];
}

export interface BingoMatchInput {
  mode: 'bingo';
  participantCount: number;
  won: boolean;
  gridSize: 4 | 5;
  difficulty: 'easy' | 'hard';
  /** game_state.roundNumber at finish - for Perfect Bingo (== gridSize). */
  roundsPlayed: number;
  events: Array<{ category: string; correct: boolean; overfull: boolean }>;
}

export interface QuizMatchInput {
  mode: 'timeline_quiz';
  participantCount: number;
  won: boolean;
  correctCount: number;
  wrongCount: number;
}

export type MatchInput = HitsterMatchInput | BingoMatchInput | QuizMatchInput;

/** One completed match, stored in full (bounded) detail in matchHistory. */
export type MatchRecord =
  | {
      mode: 'hitster_party' | 'hitster_pnp';
      playedAt: string;
      participantCount: number;
      events: HitsterStatsEvent[];
      players: HitsterPlayerResult[];
    }
  | {
      mode: 'bingo';
      playedAt: string;
      won: boolean;
      participantCount: number;
      gridSize: 4 | 5;
      difficulty: 'easy' | 'hard';
      roundsPlayed: number;
      events: Array<{ category: string; correct: boolean; overfull: boolean }>;
    }
  | {
      mode: 'timeline_quiz';
      playedAt: string;
      won: boolean;
      participantCount: number;
      correctCount: number;
      wrongCount: number;
    };

export interface LocalProfile {
  /** Schema version - bump only if a future change needs a real migration (additive fields never do). */
  version: 1;
  deviceId: string;
  stats: {
    gamesPlayed: number;
    gamesByMode: Record<GameModeKey, number>;
    modesPlayed: GameModeKey[];
    /** Largest lobby (any online mode) THIS profile ever WON in - "Big Lobby Winner" raw data. 0 = never won an online match. */
    maxParticipantsWon: number;
    hitster: {
      maxStreakEver: number;
      chipsPeakEver: number;
    };
    /**
     * Recent matches in full detail (capped at MAX_MATCH_HISTORY, oldest
     * dropped first) - raw ingredients for achievements that need per-match
     * sequence/timeline data (straights, Double/Triple Hitster, Sad Bingo,
     * Perfect Bingo/Timeline), not just a running maximum.
     */
    matchHistory: MatchRecord[];
  };
  /** Every achievement ever unlocked, in unlock order, with an ISO timestamp. */
  unlocked: Array<{ id: string; unlockedAt: string }>;
}

function emptyProfile(deviceId: string): LocalProfile {
  return {
    version: 1,
    deviceId,
    stats: {
      gamesPlayed: 0,
      gamesByMode: { hitster_party: 0, hitster_pnp: 0, bingo: 0, timeline_quiz: 0 },
      modesPlayed: [],
      maxParticipantsWon: 0,
      hitster: { maxStreakEver: 0, chipsPeakEver: 0 },
      matchHistory: [],
    },
    unlocked: [],
  };
}

/** Loads the local profile, creating a fresh empty one on first use or on any read/parse failure. */
export async function loadProfile(): Promise<LocalProfile> {
  const deviceId = getPlayerId();
  try {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalProfile;
      // Defensive: an id mismatch shouldn't happen (both keyed off the same
      // per-install identity), but never silently attribute stats to the
      // wrong device.
      if (parsed.deviceId === deviceId) return parsed;
    }
  } catch {
    // Corrupt/unreadable JSON - start fresh rather than throwing.
  }
  return emptyProfile(deviceId);
}

async function saveProfile(profile: LocalProfile): Promise<void> {
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Destructive, irreversible: wipes the local profile (all stats + unlocked
 * achievements) from AsyncStorage. The device id itself is untouched (it's
 * SecureStore, shared with the online identity) - the NEXT loadProfile() call
 * simply creates a fresh empty profile under that same id. Callers must
 * confirm with the user first (see SettingsScreen's ConfirmDialog) - this
 * function itself has no confirmation of its own.
 */
export async function resetProfile(): Promise<void> {
  await AsyncStorage.removeItem(PROFILE_KEY);
}

/** Result of recordMatchResult: the saved profile plus whatever the SAME call newly unlocked (empty when nothing new qualified). */
export interface RecordMatchOutcome {
  profile: LocalProfile;
  newlyUnlocked: AchievementDefinition[];
}

/**
 * Records one finished match's raw performance into the local profile, then
 * re-evaluates the full achievement catalog against the updated stats in the
 * SAME pass. Called once per match end, from each of the four game screens
 * (guarded there against re-firing on re-render - this function itself has
 * no idempotency check, a duplicate call would double-count AND could
 * re-unlock nothing new since the achievement would already be in
 * `unlocked`, but the stats would still double-increment).
 */
export async function recordMatchResult(input: MatchInput): Promise<RecordMatchOutcome> {
  const profile = await loadProfile();
  const { stats } = profile;
  const playedAt = new Date().toISOString();

  stats.gamesPlayed += 1;
  stats.gamesByMode[input.mode] += 1;
  if (!stats.modesPlayed.includes(input.mode)) stats.modesPlayed.push(input.mode);

  let won: boolean;
  let record: MatchRecord;

  switch (input.mode) {
    case 'hitster_party':
    case 'hitster_pnp': {
      won = input.players.some((p) => p.won);
      for (const p of input.players) {
        stats.hitster.maxStreakEver = Math.max(stats.hitster.maxStreakEver, p.maxStreak);
        stats.hitster.chipsPeakEver = Math.max(stats.hitster.chipsPeakEver, p.chipsPeak);
      }
      record = {
        mode: input.mode,
        playedAt,
        participantCount: input.participantCount,
        events: input.events,
        players: input.players,
      };
      break;
    }
    case 'bingo': {
      won = input.won;
      record = {
        mode: 'bingo',
        playedAt,
        won,
        participantCount: input.participantCount,
        gridSize: input.gridSize,
        difficulty: input.difficulty,
        roundsPlayed: input.roundsPlayed,
        events: input.events,
      };
      break;
    }
    case 'timeline_quiz': {
      won = input.won;
      record = {
        mode: 'timeline_quiz',
        playedAt,
        won,
        participantCount: input.participantCount,
        correctCount: input.correctCount,
        wrongCount: input.wrongCount,
      };
      break;
    }
  }

  if (won) stats.maxParticipantsWon = Math.max(stats.maxParticipantsWon, input.participantCount);

  stats.matchHistory.push(record);
  if (stats.matchHistory.length > MAX_MATCH_HISTORY) {
    stats.matchHistory.splice(0, stats.matchHistory.length - MAX_MATCH_HISTORY);
  }

  // Full re-evaluation against the now-updated stats (cheap - the catalog is
  // small and matchHistory is capped) - no incremental/partial check needed.
  const newlyUnlocked = evaluateNewUnlocks(stats, profile.unlocked);
  const unlockedAt = new Date().toISOString();
  for (const def of newlyUnlocked) {
    profile.unlocked.push({ id: def.id, unlockedAt });
  }

  await saveProfile(profile);
  return { profile, newlyUnlocked };
}
