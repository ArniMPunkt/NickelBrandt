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

/**
 * Which part of the game an achievement belongs to. Display metadata only -
 * no condition reads it. It exists because several descriptions are only
 * unambiguous WITH their mode ("Eine ganze Partie ohne einen einzigen Fehler"
 * is Timeline-Quiz, "7 eigene Platzierungen in Folge" is Hitster), and the
 * detail view has to answer "wofür steht dieser Erfolg" on its own.
 */
export type AchievementScope = 'hitster' | 'bingo' | 'timeline_quiz' | 'general';

export const SCOPE_LABEL: Record<AchievementScope, string> = {
  hitster: 'Hitster · Party & Pass & Play',
  bingo: 'Bingo',
  timeline_quiz: 'Timeline-Quiz',
  general: 'Modusübergreifend',
};

export interface AchievementDefinition {
  id: string;
  name: string;
  description: string;
  /** Single emoji - badge icon now, gallery icon later. */
  icon: string;
  /** Display grouping for the detail view; never read by `condition`. */
  scope: AchievementScope;
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

/**
 * Longest run of CARDS (not distinct years) forming a gapless year sequence
 * in the sorted timeline. A duplicate (same year as the reference) EXTENDS
 * the chain without advancing the reference year; a card exactly one year
 * above the reference also extends it AND becomes the new reference; any
 * bigger gap starts a fresh chain at that card. E.g. 1966,1967,1967,1968 is
 * a chain of length 4 (the repeated 1967 counts as its own link), but
 * 1966,1967,1967,1970 tops out at 3 (1970 is a 3-year jump from 1967).
 */
function longestConsecutiveYearRun(years: number[]): number {
  if (years.length === 0) return 0;
  const sorted = [...years].sort((a, b) => a - b);
  let best = 1;
  let current = 1;
  let refYear = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const year = sorted[i];
    if (year === refYear || year === refYear + 1) {
      current += 1;
      refYear = year;
    } else {
      current = 1;
      refYear = year;
    }
    best = Math.max(best, current);
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

/**
 * Local calendar day of a match ("YYYY-M-D"). playedAt is stored as a UTC ISO
 * string, and Date's getFullYear/getMonth/getDate convert to the DEVICE's own
 * time zone - which is the intent: "am selben Kalendertag" and "nachts um
 * halb vier" mean what the player experienced, not what UTC says.
 */
function localDayKey(playedAtIso: string): string | null {
  const d = new Date(playedAtIso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Most matches played on any single local calendar day. */
function maxMatchesPerDay(stats: LocalProfile['stats']): number {
  const perDay = new Map<string, number>();
  let best = 0;
  for (const m of stats.matchHistory) {
    const key = localDayKey(m.playedAt);
    if (key == null) continue;
    const n = (perDay.get(key) ?? 0) + 1;
    perDay.set(key, n);
    if (n > best) best = n;
  }
  return best;
}

/** Local hour (0-23) a match ended in, or null for an unparseable stamp. */
function localHourOf(playedAtIso: string): number | null {
  const d = new Date(playedAtIso);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

const ALL_MODES: GameModeKey[] = ['hitster_party', 'hitster_pnp', 'bingo', 'timeline_quiz'];

/** "Nachtschwärmer" counts matches finished from this hour (inclusive)... */
const NIGHT_OWL_FROM_HOUR = 0;
/** ...up to this hour (exclusive) in LOCAL time. */
const NIGHT_OWL_TO_HOUR = 5;
/** "Vielspieler-Abend": matches on one local calendar day. */
const MANY_MATCHES_PER_DAY = 5;
/**
 * "Punktlandung Marathon": flawless rounds needed on top of Perfect Timeline.
 * The Kartenzahl slider runs 5-30 with a default of 15, so 20 sits clearly
 * above a default game yet well inside what the lobby can actually be set to -
 * an achievement nobody can reach would be worse than none.
 */
const QUIZ_MARATHON_ROUNDS = 20;
/**
 * "Ehrenmann/-frau": reports sent from this device. No slider or rule in the
 * app gives a natural reference here, so this is a judgement call: high enough
 * that it marks a habit rather than a single annoyed tap, low enough to stay
 * reachable for someone who actually curates the pools.
 */
const SONG_REPORTS_NEEDED = 5;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: 'erste-partie',
    name: 'Erste Partie',
    description: 'Die erste Partie gespielt.',
    icon: '🌱',
    scope: 'general',
    condition: (stats) => stats.gamesPlayed >= 1,
  },

  // --- Hitster (Party + Pass & Play) ---
  {
    id: 'total-daneben',
    name: 'Total daneben',
    description: 'Eine Platzierung oder ein Klau lag ≥40 Jahre neben der Lücke.',
    icon: '🌀',
    scope: 'hitster',
    condition: (stats) =>
      hitsterMatches(stats).some((m) => m.events.some((e) => (gapDistance(e) ?? -1) >= 40)),
  },
  {
    id: 'perfect-hit',
    name: 'Perfect Hit',
    description: 'Exakt in eine Ein-Jahr-Lücke getroffen.',
    icon: '🎯',
    scope: 'hitster',
    condition: (stats) => hitsterMatches(stats).some((m) => m.events.some(isPerfectHit)),
  },
  {
    id: 'insane-guess',
    name: 'Insane Guess',
    description: 'Die Lücke zwischen zwei gleichen Jahren exakt getroffen.',
    icon: '🤯',
    scope: 'hitster',
    condition: (stats) => hitsterMatches(stats).some((m) => m.events.some(isInsaneGuess)),
  },
  {
    id: 'hot-hot-streak',
    name: 'Hot Hot Streak',
    description: '7 eigene Platzierungen in Folge richtig.',
    icon: '🔥',
    scope: 'hitster',
    condition: (stats) => stats.hitster.maxStreakEver >= 7,
  },
  {
    id: 'hot-hot-hot-streak',
    name: 'Hot Hot Hot Streak',
    description: '8 eigene Platzierungen in Folge richtig.',
    icon: '🌶️',
    scope: 'hitster',
    condition: (stats) => stats.hitster.maxStreakEver >= 8,
  },
  {
    id: 'perfect-game',
    name: 'Perfect Game',
    description: '9 eigene Platzierungen in Folge richtig.',
    icon: '👑',
    scope: 'hitster',
    condition: (stats) => stats.hitster.maxStreakEver >= 9,
  },
  {
    id: 'total-verbrannt',
    name: 'Total Verbrandt',
    description: '3 eigene erfolglose Klauversuche in einer Partie.',
    icon: '🥵',
    scope: 'hitster',
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
    scope: 'hitster',
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
    scope: 'hitster',
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
    scope: 'hitster',
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
    scope: 'hitster',
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
    scope: 'hitster',
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
    scope: 'hitster',
    condition: (stats) => stats.hitster.chipsPeakEver >= 5,
  },
  {
    id: 'nickelmeister',
    name: 'Nickelmeister',
    description: '8 Nickel gleichzeitig gehalten.',
    icon: '💰',
    scope: 'hitster',
    condition: (stats) => stats.hitster.chipsPeakEver >= 8,
  },
  {
    id: 'nickelgott',
    name: 'Nickelgott',
    description: '12 Nickel gleichzeitig gehalten.',
    icon: '💎',
    scope: 'hitster',
    condition: (stats) => stats.hitster.chipsPeakEver >= 12,
  },
  {
    id: 'diszipliniert',
    name: 'Diszipliniert',
    description:
      'Eine Party-Hitster-Partie mit eingeschalteten Nickeln gewonnen, ohne selbst einen Nickel bekommen und ohne erfolgreich geklaut zu haben.',
    icon: '🧘',
    scope: 'hitster',
    // Party only: Pass & Play records several people into one profile, so
    // "ich habe ohne Nickel gewonnen" has no single owner there.
    // receivedNickel/chipsEnabled are optional on older records - unknown must
    // NOT count as proof, hence the explicit === comparisons.
    condition: (stats) =>
      hitsterMatches(stats).some(
        (m) =>
          m.mode === 'hitster_party' &&
          m.chipsEnabled === true &&
          m.players.some(
            (p) =>
              p.won &&
              p.receivedNickel === false &&
              !m.events.some(
                (e) => e.type === 'steal' && e.playerId === p.playerId && e.correct
              )
          )
      ),
  },
  {
    id: 'poolversenker',
    name: 'Poolversenker',
    description:
      'Einen Songpool bei Reihum auf einem Gerät einmal komplett durchgespielt.',
    icon: '🏊',
    scope: 'hitster',
    condition: (stats) => (stats.poolsCleared ?? []).length >= 1,
  },

  // --- Bingo ---
  {
    id: 'perfect-bingo-easy',
    name: 'Perfect Bingo',
    description: 'Bingo in der minimal möglichen Rundenzahl gewonnen (Easy).',
    icon: '🟩',
    scope: 'bingo',
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
    scope: 'bingo',
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
    scope: 'bingo',
    condition: (stats) => bingoMatches(stats).some((m) => m.events.some((e) => e.overfull)),
  },

  // --- Timeline-Quiz ---
  {
    id: 'perfect-timeline',
    name: 'Perfect Timeline',
    description: 'Eine ganze Partie ohne einen einzigen Fehler gespielt.',
    icon: '🧵',
    scope: 'timeline_quiz',
    condition: (stats) =>
      quizMatches(stats).some((m) => m.correctCount + m.wrongCount > 0 && m.wrongCount === 0),
  },
  {
    id: 'punktlandung-marathon',
    name: 'Punktlandung Marathon',
    description: `Eine Partie über mindestens ${QUIZ_MARATHON_ROUNDS} Runden ohne einen einzigen Fehler gespielt.`,
    icon: '🏁',
    scope: 'timeline_quiz',
    condition: (stats) =>
      quizMatches(stats).some(
        (m) => m.wrongCount === 0 && m.correctCount >= QUIZ_MARATHON_ROUNDS
      ),
  },

  // --- Allgemein/Meta (Erste Partie steht ganz vorn, siehe oben) ---
  {
    id: 'warmgespielt',
    name: 'Warmgespielt',
    description: '10 Partien gespielt.',
    icon: '☕',
    scope: 'general',
    condition: (stats) => stats.gamesPlayed >= 10,
  },
  {
    id: 'dauergast',
    name: 'Dauergast',
    description: '50 Partien gespielt.',
    icon: '🛋️',
    scope: 'general',
    condition: (stats) => stats.gamesPlayed >= 50,
  },
  {
    id: 'partyleiter',
    name: 'Partyleiter',
    description: '100 Partien gespielt.',
    icon: '🎈',
    scope: 'general',
    condition: (stats) => stats.gamesPlayed >= 100,
  },
  {
    id: 'alle-4-modi',
    name: 'Alle 4 Modi',
    description: 'Party-Hitster, Pass & Play, Bingo und Timeline-Quiz je mindestens einmal gespielt.',
    icon: '🧭',
    scope: 'general',
    condition: (stats) => ALL_MODES.every((m) => stats.modesPlayed.includes(m)),
  },
  {
    id: 'big-lobby-winner',
    name: 'Big Lobby Winner',
    description: 'Eine Lobby mit mindestens 6 Spielern gewonnen.',
    icon: '🎊',
    scope: 'general',
    condition: (stats) => stats.maxParticipantsWon >= 6,
  },
  {
    id: 'ehrenmann',
    name: 'Ehrenmann/-frau',
    description: `Von diesem Gerät wurden ${SONG_REPORTS_NEEDED} fehlerhafte Songs gemeldet.`,
    icon: '🚩',
    scope: 'general',
    // Device-wide by design, not per person - song_reports has no player id
    // and the whole profile is device-bound (see stats.songsReported).
    condition: (stats) => (stats.songsReported ?? 0) >= SONG_REPORTS_NEEDED,
  },
  {
    id: 'nachtschwaermer',
    name: 'Nachtschwärmer',
    description: 'Eine Partie zwischen 0 und 5 Uhr morgens beendet.',
    icon: '🦉',
    scope: 'general',
    condition: (stats) =>
      stats.matchHistory.some((m) => {
        const h = localHourOf(m.playedAt);
        return h != null && h >= NIGHT_OWL_FROM_HOUR && h < NIGHT_OWL_TO_HOUR;
      }),
  },
  {
    id: 'vielspieler-abend',
    name: 'Vielspieler-Abend',
    description: `${MANY_MATCHES_PER_DAY} Partien an einem einzigen Tag gespielt.`,
    icon: '🎪',
    scope: 'general',
    condition: (stats) => maxMatchesPerDay(stats) >= MANY_MATCHES_PER_DAY,
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
  // Note the pick order: pickSpecialAchievement takes the FIRST match in
  // catalog order, and 'perfect-timeline' sits above this one. A match that
  // unlocks both at once therefore shows Perfect Timeline - only relevant the
  // very first time, since Perfect Timeline is almost always already earned
  // by the time a 20-round flawless run happens.
  'punktlandung-marathon',
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

// ---------------------------------------------------------------------------
// Progress (detail view only)
// ---------------------------------------------------------------------------

/**
 * The stats fields a progress readout may be built on. DELIBERATELY limited to
 * the monotonic, permanently rolled-up counters in `LocalProfile.stats`.
 *
 * Everything else an achievement checks lives in `matchHistory`, which is
 * capped at MAX_MATCH_HISTORY and drops the oldest matches - a "best ever"
 * derived from it would visibly go DOWN once the cap trims (e.g. "längste
 * Straße bisher: 4" turning back into 3 after 200 further matches). A
 * progress number that can regress is worse than none, so those achievements
 * show their description alone until the underlying best-ever is persisted in
 * `stats` (see the handover notes).
 */
export type ProgressSource =
  | 'gamesPlayed'
  | 'maxStreakEver'
  | 'chipsPeakEver'
  | 'maxParticipantsWon'
  | 'modesPlayedCount'
  | 'songsReported';

function readProgressSource(source: ProgressSource, stats: LocalProfile['stats']): number {
  switch (source) {
    case 'gamesPlayed':
      return stats.gamesPlayed;
    case 'maxStreakEver':
      return stats.hitster.maxStreakEver;
    case 'chipsPeakEver':
      return stats.hitster.chipsPeakEver;
    case 'maxParticipantsWon':
      return stats.maxParticipantsWon;
    case 'modesPlayedCount':
      return stats.modesPlayed.length;
    case 'songsReported':
      return stats.songsReported ?? 0;
  }
}

export interface AchievementProgress {
  /** What the number means, e.g. "Höchster Nickel-Stand bisher". */
  label: string;
  current: number;
  target: number;
}

/**
 * Per-achievement progress readout for the detail view. `target` repeats the
 * threshold its `condition` above uses - the conditions themselves stay
 * untouched, and the two are kept honest by a check that runs every condition
 * at target-1 and at target and asserts it flips exactly there (see
 * test/achievement-progress.test.js).
 *
 * Achievements absent from this table have no meaningful number: either the
 * criterion is binary ("Perfect Hit" - you hit the one-year gap or you didn't)
 * or its raw data only lives in the capped matchHistory (see ProgressSource).
 */
const PROGRESS: Record<string, { label: string; target: number; source: ProgressSource }> = {
  'erste-partie': { label: 'Partien gespielt', target: 1, source: 'gamesPlayed' },
  warmgespielt: { label: 'Partien gespielt', target: 10, source: 'gamesPlayed' },
  dauergast: { label: 'Partien gespielt', target: 50, source: 'gamesPlayed' },
  partyleiter: { label: 'Partien gespielt', target: 100, source: 'gamesPlayed' },
  'hot-hot-streak': { label: 'Längste Serie bisher', target: 7, source: 'maxStreakEver' },
  'hot-hot-hot-streak': { label: 'Längste Serie bisher', target: 8, source: 'maxStreakEver' },
  'perfect-game': { label: 'Längste Serie bisher', target: 9, source: 'maxStreakEver' },
  nickelfarmer: { label: 'Höchster Nickel-Stand bisher', target: 5, source: 'chipsPeakEver' },
  nickelmeister: { label: 'Höchster Nickel-Stand bisher', target: 8, source: 'chipsPeakEver' },
  nickelgott: { label: 'Höchster Nickel-Stand bisher', target: 12, source: 'chipsPeakEver' },
  'big-lobby-winner': {
    label: 'Größte gewonnene Lobby',
    target: 6,
    source: 'maxParticipantsWon',
  },
  'alle-4-modi': { label: 'Modi gespielt', target: 4, source: 'modesPlayedCount' },
  ehrenmann: {
    label: 'Gemeldete Songs',
    target: SONG_REPORTS_NEEDED,
    source: 'songsReported',
  },
};

/** Progress for one achievement, or null when it has no sensible number. */
export function achievementProgress(
  id: string,
  stats: LocalProfile['stats']
): AchievementProgress | null {
  const entry = PROGRESS[id];
  if (!entry) return null;
  return {
    label: entry.label,
    current: readProgressSource(entry.source, stats),
    target: entry.target,
  };
}

/** The progress table as raw data - for the consistency check against the conditions. */
export const PROGRESS_TABLE: Readonly<typeof PROGRESS> = PROGRESS;

/**
 * Multi-tier families, lowest tier first - `unlocked` legitimately contains
 * EVERY crossed tier at once (see recordMatchResult: reaching Nickelmeister
 * also unlocks Nickelfarmer in the same pass), but the GALLERY only wants ONE
 * tile per family showing the current state, not 3 redundant rows. Purely a
 * display-time grouping - the underlying `unlocked` data is untouched.
 */
const NICKEL_FAMILY = ['nickelfarmer', 'nickelmeister', 'nickelgott'];
const MILESTONE_FAMILY = ['warmgespielt', 'dauergast', 'partyleiter'];
const ACHIEVEMENT_FAMILIES: string[][] = [NICKEL_FAMILY, MILESTONE_FAMILY];

/** One tile in the gallery: what the grid shows, plus what the detail view opens. */
export interface GalleryTile {
  /**
   * The definition the TILE itself shows (icon, name, unlock date): for a
   * family the highest tier actually unlocked, otherwise the family's lowest
   * tier - so a name is always visible per "kein Überraschungseffekt".
   */
  def: AchievementDefinition;
  /**
   * Everything behind this tile, LOWEST TIER FIRST. Exactly one entry for a
   * standalone achievement, three for the Nickel/Meilenstein families - the
   * detail view lists every tier with its own criterion and status, so a
   * half-finished family can't collapse into one misleading state.
   */
  tiers: AchievementDefinition[];
}

/**
 * The full catalog collapsed for the "Erfolge" gallery: every standalone
 * achievement as-is, plus exactly ONE representative tile per multi-tier
 * family - the highest tier actually unlocked, or (nothing unlocked yet) the
 * family's lowest/first tier, so its name stays visible per "kein
 * Überraschungseffekt" even before it's reached. Catalog order is preserved -
 * that is exactly the order the gallery's "Offen" section keeps.
 */
export function buildGalleryTiles(unlockedIds: ReadonlySet<string>): GalleryTile[] {
  const familyOf = new Map<string, string[]>();
  for (const family of ACHIEVEMENT_FAMILIES) {
    for (const id of family) familyOf.set(id, family);
  }
  const seenFamilies = new Set<string[]>();
  const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
  const tiles: GalleryTile[] = [];

  for (const def of ACHIEVEMENTS) {
    const family = familyOf.get(def.id);
    if (!family) {
      tiles.push({ def, tiers: [def] });
      continue;
    }
    if (seenFamilies.has(family)) continue; // already added this family's one tile
    seenFamilies.add(family);
    const highestUnlocked = [...family].reverse().find((id) => unlockedIds.has(id));
    tiles.push({
      def: byId.get(highestUnlocked ?? family[0])!,
      tiers: family.map((id) => byId.get(id)!),
    });
  }
  return tiles;
}

/**
 * The gallery's two sections. "Errungen" first, newest unlock at the top;
 * "Offen" after it in untouched catalog order.
 *
 * A FAMILY tile counts as earned through its representative, which
 * buildGalleryTiles already resolved to the highest tier actually unlocked -
 * so a half-finished family (Nickelfarmer yes, Nickelgott no) belongs under
 * "Errungen" and sorts by its most recent tier, not by its lowest.
 *
 * Several achievements routinely share ONE timestamp (recordMatchResult stamps
 * everything a single match unlocked with the same instant). The sort is
 * stable, so those keep catalog order among themselves instead of shuffling
 * from render to render.
 */
export function splitGalleryTiles(
  tiles: GalleryTile[],
  unlockedAt: Readonly<Record<string, string>>
): { earned: GalleryTile[]; open: GalleryTile[] } {
  const earned = tiles
    .filter((t) => unlockedAt[t.def.id] != null)
    .sort((a, b) => {
      // Plain string order is chronological here: every timestamp is a
      // fixed-width ISO string from toISOString(). Returning 0 on a tie is
      // what preserves catalog order for a shared unlock instant.
      const da = unlockedAt[a.def.id];
      const db = unlockedAt[b.def.id];
      if (da === db) return 0;
      return da < db ? 1 : -1; // newest first
    });
  const open = tiles.filter((t) => unlockedAt[t.def.id] == null);
  return { earned, open };
}

/**
 * The highest "Partien gespielt"-Meilenstein reached so far (Warmgespielt ->
 * Dauergast -> Partyleiter), evaluated directly against stats (not against
 * `unlocked` - one less thing to pass around, and the conditions are the
 * same either way). Null if none yet (gamesPlayed < 10). Used for the Profil
 * tab's "Dein Titel" header, which then has no title to show at all.
 */
export function currentMilestone(stats: LocalProfile['stats']): AchievementDefinition | null {
  const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
  const highest = [...MILESTONE_FAMILY].reverse().find((id) => byId.get(id)!.condition(stats));
  return highest ? (byId.get(highest) ?? null) : null;
}
