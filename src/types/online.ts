/**
 * Types for the Online (Supabase) mode. Reuses GameCard from the Hot-Seat types
 * (types only - the Hot-Seat GameContext/reducer is NOT shared).
 */
import type { GameCard, MatchEvent, StatsSong } from './game';

export type { GameCard, MatchEvent };

export type LobbyStatus = 'waiting' | 'playing' | 'finished' | 'ended';

/** The lobby's game mode, chosen by the host in the waiting room. */
export type GameMode = 'hitster' | 'bingo' | 'timeline_quiz';

/** Mode-specific config (lobbies.mode_config jsonb; keys per mode, all optional). */
export interface ModeConfig {
  /** Bingo: grid edge length. */
  bingoGridSize?: 4 | 5;
  /** Bingo: question difficulty (absent = 'easy', for configs predating it). */
  bingoDifficulty?: BingoDifficulty;
  /** Bingo: song/answer window seconds (absent = BINGO_ROUND_SECONDS). */
  bingoSongSeconds?: number;
  /** Timeline-Quiz: number of cards to play. */
  timelineCardCount?: number;
  /**
   * Hitster: allow multiple sequential steal attempts per steal window
   * (queued by press order) instead of the default single-winner race.
   * Absent/false = today's atomic-claim behavior.
   */
  hitsterMultiSteal?: boolean;
}

/** Outcome of one player in a resolved simultaneous round. */
export type RoundOutcome = 'correct' | 'incorrect' | 'missed';

/**
 * Lifecycle of a simultaneous round:
 *   spinning   -> (bingo only) waiting for the round's designated player to
 *                 press the spin button; no answers accepted, no deadline yet
 *   collecting -> answers may be submitted (until deadline / all answered)
 *   reviewing  -> (bingo title_artist only) answers frozen; everyone sees all
 *                 free-text answers, the HOST grades each with ✓/✕
 *   resolving  -> transient: a resolver claimed the round (submits now refused)
 *   resolved   -> roundResults written; all clients show the outcome
 */
export type SimulRoundPhase =
  | 'spinning'
  | 'collecting'
  | 'reviewing'
  | 'resolving'
  | 'resolved';

/** One player's submitted answer of a simultaneous round (round_answers row). */
export interface RoundAnswer {
  id: string;
  lobby_id: string;
  round_number: number;
  player_id: string;
  /** Mode-specific payload (e.g. bingo cell index, timeline slot). */
  answer: unknown;
  submitted_at: string;
}

/** Round phase synced via lobbies.game_state. */
export type OnlinePhase =
  | 'waiting' // game not started
  | 'card_drawn' // active player must pick a position
  | 'hitster_window' // active placed; 5s window for others to call "Hitster!"
  | 'hitster_resolving' // someone claimed the steal; awaiting their slot choice
  | 'awaiting_host_confirmation' // card revealed + placement resolved; host answers title/artist
  | 'simul_round' // bingo / timeline_quiz: the simultaneous roundPhase drives the flow
  | 'finished'; // round result shown (winnerId set => game over)

// --- Timeline-Quiz mode -------------------------------------------------------

/**
 * One logged timeline-quiz round for the post-game statistics: which song was
 * to be placed and whether THIS player guessed the slot correctly. One event
 * per player per resolved round; a missed round (no answer) counts as wrong
 * (binary, matching the score that the round awards). The quiz counterpart to
 * BingoRoundEvent - no category (the mode has none).
 */
export interface QuizRoundEvent {
  playerId: string;
  correct: boolean;
  song: StatsSong;
}

/**
 * One entry of the SHARED quiz timeline (game_state.quizTimeline). Base slots
 * are pure years; resolved songs carry title/artist too. Single writer per
 * round (start / resolve-claim winner), so game_state jsonb is safe here.
 */
export interface QuizTimelineEntry {
  year: number;
  /** Set when this entry is a resolved song (base slots are pure years). */
  title?: string;
  artist?: string;
}

// --- Bingo mode --------------------------------------------------------------

/**
 * The bingo categories = the cell colors. decade / before-after-2000 / year±N
 * grade against GameCard.year; title_artist and band_or_solo are host-reviewed
 * (free text verdicts resp. a one-tap truth), with the honor pattern as the
 * absent-host fallback. band_or_solo has no verified truth in the pool data -
 * the host decides, assisted by a live MusicBrainz artist-type suggestion
 * (services/musicbrainz).
 */
export type BingoCategoryType =
  | 'decade'
  | 'before_after_2000'
  | 'year_guess'
  | 'title_artist'
  | 'band_or_solo';

/**
 * Bingo difficulty, chosen by the host in the lobby. Same five colors in both;
 * two slots sharpen their question in 'hard' (before_after_2000 -> year ±2,
 * year_guess -> exact year) and title_artist relaxes to artist-only in 'easy'.
 */
export type BingoDifficulty = 'easy' | 'hard';

export interface BingoCell {
  color: BingoCategoryType;
  marked: boolean;
}

/** Row-major, length = size*size. Stored in lobby_players.bingo_board (jsonb). */
export type BingoBoard = BingoCell[];

/**
 * One logged bingo round for the post-game statistics: what was asked, of
 * whom, and whether they fulfilled it. One event per PLAYER per resolved
 * round; a missed round (no answer) counts as not fulfilled (binary, matching
 * the round outcome that drives the cell marks). Bingo's counterpart to the
 * hitster MatchEvent - separate type because the categories/colors have no
 * hitster equivalent.
 */
export interface BingoRoundEvent {
  playerId: string;
  /** The spun category = the cell color this round played on. */
  category: BingoCategoryType;
  /**
   * True when the player's ANSWER was correct - NOT the same as "earned a
   * mark pick" (see overfull below): a correct answer on an already-full
   * color earns no mark, but is still logged correct: true here.
   */
  correct: boolean;
  /**
   * True when the answer was correct but earned NO mark because every cell
   * of that color was already marked on this player's board ("Sad Bingo" raw
   * data). False whenever correct is false (a wrong answer was never
   * "overfull", it just missed). Optional for backward-compat with events
   * logged before this field existed.
   */
  overfull?: boolean;
  song: StatsSong;
}

/** The current round's spun category ("digitale Discokugel"), synced in game_state. */
export interface BingoRoundSpec {
  type: BingoCategoryType;
  /** decade: the multiple-choice options (decade start years, shuffled). */
  decadeOptions?: number[];
  /** year_guess: allowed absolute deviation from the real year. */
  tolerance?: number;
}

/**
 * One "Hitster!" press during a multiStealEnabled window/collection phase.
 * See OnlineGameState.hitsterQueue for the full lifecycle.
 */
export interface HitsterQueueEntry {
  playerId: string;
  /** serverNow() at press time - the array's sort key (NOT write order). */
  queuedAt: number;
  /** The slot this entry chose once it was their turn (absent = not their turn yet). */
  placedSlot?: number | null;
  /** True if they withdrew instead of placing (kept their Nickel, no stats event). */
  aborted?: boolean;
}

/** The whole synced round state (stored in lobbies.game_state jsonb). */
export interface OnlineGameState {
  /** Remaining cards, drawn from the front. */
  deck: GameCard[];
  /** The card currently being placed (null between games). */
  currentCard: GameCard | null;
  /** Whose turn it is (player_id). */
  activePlayerId: string;
  phase: OnlinePhase;
  /** The active player's chosen slot, before the round is resolved. */
  pendingInsertIndex: number | null;
  /** Result of the active player's own placement, for the reveal UI. */
  lastResult: 'correct' | 'incorrect' | null;
  /**
   * Off (default): who won the "Hitster!" claim race this turn (player_id), or
   * null. On (multiStealEnabled): during the collection phase, whoever is
   * CURRENTLY placing their slot - the front of the still-pending hitsterQueue,
   * NOT a fixed "winner" - see resolveHitsterPlacement/withdrawHitsterAttempt.
   */
  hitsterCallerId: string | null;
  /**
   * Player ids who pressed "Kein Hitster" this turn (reset each round). When all
   * potential stealers (non-active players with >=1 Nickel) have either stolen/
   * queued or passed, the window closes early. Optional for backward-compat
   * with rows written before this field existed. With multiStealEnabled, a
   * later "Hitster!" press retracts a prior entry here (opinion change).
   */
  passedHitster?: string[];
  /**
   * "Mehrfaches Hitstern" (host setting, frozen at game start from
   * mode_config.hitsterMultiSteal). false/absent = today's single-winner
   * atomic-claim race (hitsterQueue is never written to or read). true =
   * every "Hitster!" press during the window joins hitsterQueue (press-order),
   * and once the window closes each queued player gets an unbounded,
   * sequential turn to place a slot or withdraw - see hitsterQueue.
   */
  multiStealEnabled?: boolean;
  /**
   * Queue of "Hitster!" presses during the window, ALWAYS stored pre-sorted by
   * queuedAt ascending (press order by server clock, not write-commit order -
   * two concurrent joins could otherwise land in either order). Only written/
   * read when multiStealEnabled is true.
   *
   * Collection phase (after the window closes): entries are processed
   * front-to-back. placedSlot/aborted are filled in as each entry's turn comes
   * ("pending" = both absent). hitsterCallerId always names the first still-
   * pending entry. Final evaluation (once every entry has placedSlot or
   * aborted) scans front-to-back for the first placedSlot that is actually
   * correct - that entry steals the card; everyone else who placed (whether
   * before or after) gets a "verbrandt" stats event; withdrawals get neither a
   * Nickel charge nor a stats event.
   */
  hitsterQueue?: HitsterQueueEntry[] | null;
  /**
   * Scalar optimistic-concurrency guard for hitsterQueue joins (see
   * joinHitsterQueue in supabase.ts): bumped by 1 on every successful join.
   * A plain counter, not the array's content, because jsonb does not preserve
   * object key order - a text-equality filter on the serialized array would
   * spuriously never match.
   */
  hitsterQueueVersion?: number;
  /**
   * Highest chips value reached this game per player_id (not the final
   * balance) - for the "Nickelfarmer/-meister/-gott" achievement family.
   * Maintained at every point a player's chips actually go UP (Nickel award
   * in confirmGuess + manual "Nickel korrigieren" in adjustPlayerChips), same
   * idea as lobby_players.max_brandt_streak but kept in game_state (no
   * migration needed - purely transient, reset fresh every startGame).
   * Absent player_id = never tracked (pre-instrumentation game).
   */
  chipsPeak?: Record<string, number>;
  /** The steal's outcome (caller prediction), or null if no steal happened. */
  stealResult: 'correct' | 'incorrect' | null;
  /**
   * True when the steal missed ONLY because the active player was also correct at
   * an equal-year slot (both slots year-valid). With multiStealEnabled: true if
   * the active player was correct AND at least one queued attempt also landed
   * on an equally-valid slot. Drives the "Gleiches Jahr, beide Plätze richtig"
   * reveal message. Optional for backward-compat.
   */
  stealEqualYear?: boolean;
  /** Turn rotation order (player_ids, join order). */
  turnOrder: string[];
  cardsToWin: number;
  hideCoverUntilRevealed: boolean;
  /**
   * "Karte überspringen" / "Karte ohne Raten ziehen" rule config, taken from the
   * HOST's settings at game start. All optional for backward-compat with
   * game_state rows written before these fields existed (absent = disabled).
   */
  skipEnabled?: boolean;
  skipCost?: number;
  blindEnabled?: boolean;
  blindCost?: number;
  /**
   * "Nickel & Hitster-Rufe" master switch (host setting). false = no steal
   * window, no Nickel question, no Nickel-costing actions - placements resolve
   * directly. Absent = game started before the switch reached the online world
   * -> enabled (the original behavior).
   */
  chipsEnabled?: boolean;
  /** Music timer (host settings): hard-stop the song after timerSeconds. */
  timerEnabled?: boolean;
  timerSeconds?: number;
  /**
   * Nickel cap (host settings). Absent = game started before the cap became
   * configurable -> the original hard limit of 5 applies (MAX_CHIPS).
   * chipLimitEnabled false = unlimited collecting.
   */
  chipLimitEnabled?: boolean;
  chipLimit?: number;
  /**
   * Deck source snapshot at game start ("pool:<id>" + display
   * name), so any game screen can attach it to a "Song melden" report.
   * Optional for backward-compat with game_state rows written before this.
   */
  sourceId?: string | null;
  sourceName?: string | null;
  /**
   * Epoch ms when the current turn's song started (written on every draw AND on
   * a skip - the replacement song restarts the timer). Clients derive the
   * countdown locally from this; only the HOST's timer pauses the music.
   */
  turnStartedAt?: number | null;
  winnerId: string | null;
  /**
   * Append-only event log of the running HITSTER match for the post-game
   * statistics (playerId = player_id uuid). Only appended by single-writer
   * paths (window close / steal resolution / host confirm), so the jsonb
   * read-modify-write is race-free. Optional for backward-compat with
   * game_state rows written before this field existed.
   */
  statsHistory?: MatchEvent[] | null;

  // --- Generic simultaneous-round support (bingo / timeline_quiz) -----------
  // All optional: absent in hitster games / rows written before migration 005.
  /** Snapshot of the lobby's mode at game start ('hitster' when absent). */
  gameMode?: GameMode;
  /** Snapshot of the lobby's mode config at game start. */
  modeConfig?: ModeConfig;
  /** 1-based counter of the current simultaneous round. */
  roundNumber?: number;
  /** Epoch ms deadline of the current round (host writes; clients count down). */
  roundDeadline?: number | null;
  roundPhase?: SimulRoundPhase | null;
  /**
   * Resolution claim token + timestamp (written together with roundPhase
   * 'resolving'). If the claim winner dies before the final 'resolved' write,
   * any client may atomically RE-claim after RESOLVE_STALE_MS by swapping the
   * token; the original winner's late final write (guarded on its own token)
   * then matches nothing and stays side-effect free.
   */
  resolveClaimId?: string | null;
  resolveClaimedAt?: number | null;
  /** Written ONCE at resolution: player_id -> outcome (single writer: host). */
  roundResults?: Record<string, RoundOutcome> | null;
  /** Bingo: the current round's category (drawn together with the card). */
  bingoRound?: BingoRoundSpec | null;
  /**
   * Append-only per-player round log of the running BINGO match for the
   * post-game statistics. Only appended by the resolve-claim winner (inside
   * the atomically guarded final write of resolveSimulRound), so the jsonb
   * read-modify-write is race-free. Optional for backward-compat.
   */
  bingoStatsHistory?: BingoRoundEvent[] | null;
  /** Bingo: the pool's decade span, fixed at game start (decade MC options). */
  bingoDecades?: number[] | null;
  /**
   * Bingo: the pool's real min/max song year, fixed at game start - the
   * VISIBLE range of the year-guess slider (grading is unaffected). Absent =
   * game started before these existed -> fallback constants.
   */
  bingoYearMin?: number | null;
  bingoYearMax?: number | null;
  /**
   * Bingo: cell-pick window after a resolution. Correct players choose which
   * free cell of the round color to mark (their own client auto-picks on
   * timeout). expectedMarks = per player the marked-cell count AFTER their
   * pick (base + 1 only for correct players with a free cell) - written once
   * by the resolve-claim winner, so "has picked" is detectable everywhere
   * without extra columns: countMarked(board) >= expectedMarks[player].
   */
  pickDeadline?: number | null;
  expectedMarks?: Record<string, number> | null;
  /**
   * Bingo title_artist review window: while roundPhase is 'reviewing', the
   * host grades every submitted free text (player_id -> correct?). Written
   * only by the host (full-map writes); after reviewDeadline ANY client may
   * resolve, unjudged answers then fall back to the category's old honor
   * rule (non-empty text counts as a claim -> correct).
   */
  reviewDeadline?: number | null;
  reviewVerdicts?: Record<string, boolean> | null;
  /**
   * Bingo band_or_solo review: the host's one-tap truth (true = Gruppe/Band,
   * false = Solokünstler); all submitted answers are graded against it. Written
   * only by the host (setBingoTruth); null while undecided - after
   * reviewDeadline the honor fallback grades every answered player as correct.
   */
  reviewTruthGroup?: boolean | null;
  /**
   * Bingo spin stage: the player who must press the spin button this round
   * (round-robin over the live roster by join order, fixed at round start).
   * spinArmedAt = when the stage opened - after BINGO_SPIN_OPEN_ALL_MS anyone
   * may press instead (absent spinner must never stall the game).
   * spinStartedAt = when the button WAS pressed; all clients replay the same
   * deterministic wheel animation from this shared timestamp (the category
   * itself was already drawn server-side at round start - pure cosmetics).
   */
  spinnerId?: string | null;
  spinArmedAt?: number | null;
  spinStartedAt?: number | null;
  /** Timeline-Quiz: the shared timeline everyone places into (grows each round). */
  quizTimeline?: QuizTimelineEntry[] | null;
  /** Timeline-Quiz: fixed number of rounds (from mode_config, clamped to deck). */
  quizTotalRounds?: number;
  /**
   * Append-only per-player round log of the running TIMELINE-QUIZ match for
   * the post-game statistics. Only appended by the resolve-claim winner
   * (inside the atomically guarded final write of resolveSimulRound), so the
   * jsonb read-modify-write is race-free. Optional for backward-compat.
   */
  quizStatsHistory?: QuizRoundEvent[] | null;
  /**
   * Bingo: ALL players who completed a row/column/diagonal in the same
   * resolution (simultaneous multi-win is allowed). winnerId stays set to the
   * first entry so the shared finish contract (phase 'finished' + winnerId)
   * keeps working everywhere.
   */
  winnerIds?: string[] | null;
}

export interface Lobby {
  id: string;
  code: string;
  host_id: string;
  status: LobbyStatus;
  created_at: string;
  game_state: OnlineGameState | null;
  /** Optional until migration 005 ran; treat absent as 'hitster'. */
  game_mode?: GameMode;
  mode_config?: ModeConfig | null;
}

/** A pre-made themed song pool (reference data in Supabase, read-only for the app). */
export interface SongPool {
  id: string;
  name: string;
  description: string | null;
  /**
   * Public URL of the pool's icon (Supabase Storage "pool-icons", maintained
   * manually in the dashboard - migration 010). Null/absent = 🎵 fallback.
   */
  icon_url?: string | null;
  created_at: string;
}

export interface LobbyPlayer {
  id: string;
  lobby_id: string;
  player_name: string;
  player_id: string;
  is_host: boolean;
  joined_at: string;
  timeline: GameCard[];
  score: number;
  chips: number;
  /** Running count of consecutive correct OWN placements (resets on a miss). */
  current_streak: number;
  /** "Brandt": best hot-streak of correct own placements this game (not steals). */
  max_brandt_streak: number;
  /**
   * Bingo mode only (migration 006). Written by startBingoGame (fresh board)
   * and by the round-resolve claim winner (marks) - single writer per round,
   * so a jsonb column on the player row is safe (unlike answers, which are
   * concurrent multi-client writes and therefore live in round_answers).
   */
  bingo_board?: BingoBoard | null;
  /**
   * App-Version (Constants.expoConfig?.version) at the moment this device
   * created/joined the lobby (migration 011). null = row written before this
   * migration existed (old client) - treated as its own "unbekannt" bucket
   * when comparing, never assumed equal to any known version.
   */
  app_version?: string | null;
}
