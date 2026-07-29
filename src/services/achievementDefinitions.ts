/**
 * The full achievement catalog + condition checks - rein clientseitig, no
 * server round-trip. Every condition runs PURELY against `LocalProfile.stats`
 * (see services/achievements.ts) - no game code is touched here.
 *
 * Bundles (Nickelfarmer/-meister/-gott, the three game-count milestones):
 * deliberately NOT special-cased. Each tier is its own independent
 * definition with its own threshold; since the underlying stat is monotonic
 * (chipsPeakEver, gamesPlayed, ...), reaching the top tier automatically
 * satisfies every lower tier's condition too in the SAME evaluation pass -
 * evaluateNewUnlocks below unlocks all of them together.
 */
import type { GameModeKey, HitsterStatsEvent, LocalProfile, MatchRecord } from './achievements';

export interface AchievementDefinition {
  id: string;
  name: string;
  description: string;
  /** Single emoji - badge icon now, gallery icon later. */
  icon: string;
  condition: (stats: LocalProfile['stats']) => boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers over matchHistory (raw data, no thresholds baked in besides
// what each achievement itself specifies).
// ---------------------------------------------------------------------------

type HitsterRecord = Extract<MatchRecord, { mode: 'hitster_party' | 'hitster_pnp' }>;
type BingoRecord = Extract<MatchRecord, { mode: 'bingo' }>;
type QuizRecord = Extract<MatchRecord, { mode: 'timeline_quiz' }>;

function hitsterMatches(stats: LocalProfile['stats']): HitsterRecord[] {
  return stats.matchHistory.filter(
    (m): m is HitsterRecord => m.mode === 'hitster_party' || m.mode === 'hitster_pnp'
  );
}

function bingoMatches(stats: LocalProfile['stats']): BingoRecord[] {
  return stats.matchHistory.filter((m): m is BingoRecord => m.mode === 'bingo');
}

function quizMatches(stats: LocalProfile['stats']): QuizRecord[] {
  return stats.matchHistory.filter((m): m is QuizRecord => m.mode === 'timeline_quiz');
}

/** Distance to the nearest FINITE gap boundary; null when the event was correct or has no boundary at all (shouldn't happen for a miss, but defensive). */
function gapDistance(e: HitsterStatsEvent): number | null {
  if (e.correct) return null;
  const bounds = [e.leftYear, e.rightYear].filter((b): b is number => b != null);
  if (bounds.length === 0) return null;
  return Math.min(...bounds.map((b) => Math.abs(e.year - b)));
}

/** Exact 1-year gap (e.g. 1984/1986), hit dead-on at left+1. */
function isPerfectHit(e: HitsterStatsEvent): boolean {
  return (
    e.correct &&
    e.leftYear != null &&
    e.rightYear != null &&
    e.rightYear - e.leftYear === 2 &&
    e.year === e.leftYear + 1
  );
}

/** Slot between two EQUAL existing years, matched exactly. */
function isInsaneGuess(e: HitsterStatsEvent): boolean {
  return e.leftYear != null && e.rightYear != null && e.leftYear === e.rightYear && e.year === e.leftYear;
}

/**
 * Longest run of DIRECTLY CONSECUTIVE rounds (marked by 'place' events, any
 * player - every round logs exactly one) in which `playerId` had the
 * successful steal ('steal' with correct: true). Works unchanged under
 * "Mehrfaches Hitstern": at most one steal event per round can ever be
 * correct: true, queued failed attempts don't affect this.
 */
function longestConsecutiveSteals(events: HitsterStatsEvent[], playerId: string): number {
  let winnerThisRound: string | null = null;
  let sawARound = false;
  let streak = 0;
  let best = 0;
  const closeRound = () => {
    if (!sawARound) return;
    if (winnerThisRound === playerId) {
      streak += 1;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
  };
  for (const e of events) {
    if (e.type === 'place') {
      closeRound();
      sawARound = true;
      winnerThisRound = null;
    } else if (e.correct) {
      winnerThisRound = e.playerId;
    }
  }
  closeRound();
  return best;
}

/** Longest run of DISTINCT, integer-consecutive years (duplicates collapse, don't break the run). */
function longestConsecutiveYearRun(years: number[]): number {
  const distinct = [...new Set(years)].sort((a, b) => a - b);
  if (distinct.length === 0) return 0;
  let best = 1;
  let current = 1;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] - distinct[i - 1] === 1) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 1;
    }
  }
  return best;
}

/** 4+ ADJACENT cards (in sorted timeline order) from the same decade - may repeat a year, decade only has to match its immediate predecessor. */
function hasDecadeStreet(years: number[]): boolean {
  const sorted = [...years].sort((a, b) => a - b);
  let run = 0;
  let lastDecade: number | null = null;
  for (const y of sorted) {
    const decade = Math.floor(y / 10) * 10;
    run = decade === lastDecade ? run + 1 : 1;
    lastDecade = decade;
    if (run >= 4) return true;
  }
  return false;
}

const ALL_MODES: GameModeKey[] = ['hitster_party', 'hitster_pnp', 'bingo', 'timeline_quiz'];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS: AchievementDefinition[] = [
  // --- Hitster (Party + Pass & Play) ---
  {
    id: 'total-daneben',
    name: 'Total daneben',
    description: 'Eine Platzierung oder ein Klau lag ≥40 Jahre neben der Lücke.',
    icon: '🌀',
    condition: (stats) =>
      hitsterMatches(stats).some((m) => m.events.some((e) => (gapDistance(e) ?? -1) >= 40)),
  },
  {
    id: 'perfect-hit',
    name: 'Perfect Hit',
    description: 'Exakt in eine Ein-Jahr-Lücke getroffen.',
    icon: '🎯',
    condition: (stats) => hitsterMatches(stats).some((m) => m.events.some(isPerfectHit)),
  },
  {
    id: 'insane-guess',
    name: 'Insane Guess',
    description: 'Die Lücke zwischen zwei gleichen Jahren exakt getroffen.',
    icon: '🤯',
    condition: (stats) => hitsterMatches(stats).some((m) => m.events.some(isInsaneGuess)),
  },
  {
    id: 'hot-hot-streak',
    name: 'Hot Hot Streak',
    description: '7 eigene Platzierungen in Folge richtig.',
    icon: '🔥',
    condition: (stats) => stats.hitster.maxStreakEver >= 7,
  },
  {
    id: 'hot-hot-hot-streak',
    name: 'Hot Hot Hot Streak',
    description: '8 eigene Platzierungen in Folge richtig.',
    icon: '🌶️',
    condition: (stats) => stats.hitster.maxStreakEver >= 8,
  },
  {
    id: 'perfect-game',
    name: 'Perfect Game',
    description: '9 eigene Platzierungen in Folge richtig.',
    icon: '👑',
    condition: (stats) => stats.hitster.maxStreakEver >= 9,
  },
  {
    id: 'total-verbrannt',
    name: 'Total Verbrandt',
    description: '3 eigene erfolglose Klauversuche in einer Partie.',
    icon: '🥵',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some(
          (p) =>
            m.events.filter((e) => e.type === 'steal' && e.playerId === p.playerId && !e.correct)
              .length >= 3
        )
      ),
  },
  {
    id: 'double-hitster',
    name: 'Double Hitster',
    description: '2 Runden direkt hintereinander erfolgreich gehitstert.',
    icon: '🥷',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some((p) => longestConsecutiveSteals(m.events, p.playerId) >= 2)
      ),
  },
  {
    id: 'triple-hitster',
    name: 'Triple Hitster',
    description: '3 Runden direkt hintereinander erfolgreich gehitstert.',
    icon: '🏴‍☠️',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some((p) => longestConsecutiveSteals(m.events, p.playerId) >= 3)
      ),
  },
  {
    id: 'kleine-strasse',
    name: 'Kleine Straße',
    description: '4 lückenlos aufeinanderfolgende Jahre in der eigenen Zeitlinie.',
    icon: '🧩',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some((p) => longestConsecutiveYearRun(p.finalTimelineYears) >= 4)
      ),
  },
  {
    id: 'grosse-strasse',
    name: 'Große Straße',
    description: '5 lückenlos aufeinanderfolgende Jahre in der eigenen Zeitlinie.',
    icon: '🛤️',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some((p) => longestConsecutiveYearRun(p.finalTimelineYears) >= 5)
      ),
  },
  {
    id: 'jahrzehnt-strasse',
    name: 'Jahrzehnt-Straße',
    description: '4 Karten desselben Jahrzehnts direkt nebeneinander.',
    icon: '📅',
    condition: (stats) =>
      hitsterMatches(stats).some((m) =>
        m.players.some((p) => hasDecadeStreet(p.finalTimelineYears))
      ),
  },
  {
    id: 'nickelfarmer',
    name: 'Nickelfarmer',
    description: '5 Nickel gleichzeitig gehalten.',
    icon: '🪙',
    condition: (stats) => stats.hitster.chipsPeakEver >= 5,
  },
  {
    id: 'nickelmeister',
    name: 'Nickelmeister',
    description: '8 Nickel gleichzeitig gehalten.',
    icon: '💰',
    condition: (stats) => stats.hitster.chipsPeakEver >= 8,
  },
  {
    id: 'nickelgott',
    name: 'Nickelgott',
    description: '12 Nickel gleichzeitig gehalten.',
    icon: '💎',
    condition: (stats) => stats.hitster.chipsPeakEver >= 12,
  },

  // --- Bingo ---
  {
    id: 'perfect-bingo-easy',
    name: 'Perfect Bingo',
    description: 'Bingo in der minimal möglichen Rundenzahl gewonnen (Easy).',
    icon: '🟩',
    condition: (stats) =>
      bingoMatches(stats).some(
        (m) => m.won && m.difficulty === 'easy' && m.roundsPlayed === m.gridSize
      ),
  },
  {
    id: 'perfect-bingo-hard',
    name: 'Perfect Bingo (Hard Edition)',
    description: 'Bingo in der minimal möglichen Rundenzahl gewonnen (Hard).',
    icon: '🟥',
    condition: (stats) =>
      bingoMatches(stats).some(
        (m) => m.won && m.difficulty === 'hard' && m.roundsPlayed === m.gridSize
      ),
  },
  {
    id: 'sad-bingo',
    name: 'Sad Bingo',
    description: 'Richtig geraten, aber die Farbe war schon voll.',
    icon: '😅',
    condition: (stats) => bingoMatches(stats).some((m) => m.events.some((e) => e.overfull)),
  },

  // --- Timeline-Quiz ---
  {
    id: 'perfect-timeline',
    name: 'Perfect Timeline',
    description: 'Eine ganze Partie ohne einen einzigen Fehler gespielt.',
    icon: '🧵',
    condition: (stats) =>
      quizMatches(stats).some((m) => m.correctCount + m.wrongCount > 0 && m.wrongCount === 0),
  },

  // --- Allgemein/Meta ---
  {
    id: 'erste-partie',
    name: 'Erste Partie',
    description: 'Die erste Partie gespielt.',
    icon: '🌱',
    condition: (stats) => stats.gamesPlayed >= 1,
  },
  {
    id: 'warmgespielt',
    name: 'Warmgespielt',
    description: '10 Partien gespielt.',
    icon: '☕',
    condition: (stats) => stats.gamesPlayed >= 10,
  },
  {
    id: 'dauergast',
    name: 'Dauergast',
    description: '50 Partien gespielt.',
    icon: '🛋️',
    condition: (stats) => stats.gamesPlayed >= 50,
  },
  {
    id: 'partyleiter',
    name: 'Partyleiter',
    description: '100 Partien gespielt.',
    icon: '🎈',
    condition: (stats) => stats.gamesPlayed >= 100,
  },
  {
    id: 'alle-4-modi',
    name: 'Alle 4 Modi',
    description: 'Party-Hitster, Pass & Play, Bingo und Timeline-Quiz je mindestens einmal gespielt.',
    icon: '🧭',
    condition: (stats) => ALL_MODES.every((m) => stats.modesPlayed.includes(m)),
  },
  {
    id: 'big-lobby-winner',
    name: 'Big Lobby Winner',
    description: 'Eine Lobby mit mindestens 6 Spielern gewonnen.',
    icon: '🎊',
    condition: (stats) => stats.maxParticipantsWon >= 6,
  },
];

/**
 * Achievements important enough for the fullscreen "besonderer Moment"
 * reveal (see components/AchievementUnlockedOverlay) instead of just the
 * compact badge row - the top tier of every multi-tier family, deliberately
 * rare so the interruption stays special.
 */
export const SPECIAL_ACHIEVEMENT_IDS: ReadonlySet<string> = new Set([
  'partyleiter',
  'perfect-game',
  'nickelgott',
  'perfect-bingo-hard',
  'perfect-timeline',
]);

/** All definitions whose condition is met now but weren't in `unlocked` yet, in catalog order. */
export function evaluateNewUnlocks(
  stats: LocalProfile['stats'],
  unlocked: LocalProfile['unlocked']
): AchievementDefinition[] {
  const already = new Set(unlocked.map((u) => u.id));
  return ACHIEVEMENTS.filter((def) => !already.has(def.id) && def.condition(stats));
}

/**
 * Which of the newly-unlocked achievements (if any) deserves the rare
 * fullscreen "besonderer Moment": either a top-tier milestone, or (failing
 * that) the player's very first achievement ever. Picks at most one, even if
 * several would qualify at once - every other unlock this match still shows
 * in the normal badge row. Top-tier takes priority over "first ever" when
 * both apply in the same match (e.g. chipsPeak jumps straight to 12, which
 * unlocks all three Nickel tiers AND happens to be a first-ever unlock) -
 * showing "Nickelgott" is more fitting than the lowest tier in that bundle
 * just because it happens to sort first. `totalUnlockedCount` is
 * `profile.unlocked.length` AFTER this match's unlocks were appended
 * (recordMatchResult already does this before returning) - if that total
 * equals exactly what was just added, nothing existed before.
 */
export function pickSpecialAchievement(
  newlyUnlocked: AchievementDefinition[],
  totalUnlockedCount: number
): AchievementDefinition | null {
  if (newlyUnlocked.length === 0) return null;
  const topTier = newlyUnlocked.find((a) => SPECIAL_ACHIEVEMENT_IDS.has(a.id));
  if (topTier) return topTier;
  if (totalUnlockedCount === newlyUnlocked.length) return newlyUnlocked[0];
  return null;
}

/**
 * Multi-tier families, lowest tier first - `unlocked` legitimately contains
 * EVERY crossed tier at once (see recordMatchResult: reaching Nickelmeister
 * also unlocks Nickelfarmer in the same pass), but the GALLERY only wants ONE
 * tile per family showing the current state, not 3 redundant rows. Purely a
 * display-time grouping - the underlying `unlocked` data is untouched.
 */
const ACHIEVEMENT_FAMILIES: string[][] = [
  ['nickelfarmer', 'nickelmeister', 'nickelgott'],
  ['warmgespielt', 'dauergast', 'partyleiter'],
];

/**
 * The full catalog collapsed for the "Erfolge" gallery: every standalone
 * achievement as-is, plus exactly ONE representative tile per multi-tier
 * family - the highest tier actually unlocked, or (nothing unlocked yet) the
 * family's lowest/first tier, so its name stays visible per "kein
 * Überraschungseffekt" even before it's reached.
 */
export function buildGalleryTiles(unlockedIds: ReadonlySet<string>): AchievementDefinition[] {
  const familyOf = new Map<string, string[]>();
  for (const family of ACHIEVEMENT_FAMILIES) {
    for (const id of family) familyOf.set(id, family);
  }
  const seenFamilies = new Set<string[]>();
  const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
  const tiles: AchievementDefinition[] = [];

  for (const def of ACHIEVEMENTS) {
    const family = familyOf.get(def.id);
    if (!family) {
      tiles.push(def);
      continue;
    }
    if (seenFamilies.has(family)) continue; // already added this family's one tile
    seenFamilies.add(family);
    const highestUnlocked = [...family].reverse().find((id) => unlockedIds.has(id));
    tiles.push(byId.get(highestUnlocked ?? family[0])!);
  }
  return tiles;
}
