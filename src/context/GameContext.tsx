/**
 * Central game state for the Hot-Seat mode, as a React Context + useReducer.
 *
 * The reducer is pure (no Spotify / IO side effects) - screens trigger playback
 * via the spotify service around the dispatch calls.
 */
import { createContext, useContext, useReducer, type ReactNode } from 'react';
import {
  MAX_CHIPS,
  type GameCard,
  type GameSettings,
  type GameState,
  type Player,
} from '../types/game';

/** Insert a card into a sorted timeline at the given slot (pure). */
function insertAt(timeline: GameCard[], card: GameCard, index: number): GameCard[] {
  return [...timeline.slice(0, index), card, ...timeline.slice(index)];
}

/**
 * The slot at which `year` keeps a sorted (ascending) timeline sorted. Used to
 * place a stolen card into the stealer's own timeline (their chosen slot was an
 * index into the ACTIVE player's timeline, so it can't be reused here).
 */
function sortedInsertIndex(timeline: GameCard[], year: number): number {
  let i = 0;
  while (i < timeline.length && timeline[i].year <= year) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Pure placement logic
// ---------------------------------------------------------------------------

/**
 * A placement at slot `insertIndex` (0..timeline.length) is correct when the
 * card's year fits between the neighbouring cards. Equal years count as correct
 * (in the player's favour).
 */
export function isCorrectPlacement(
  timeline: GameCard[],
  card: GameCard,
  insertIndex: number
): boolean {
  const left = insertIndex > 0 ? timeline[insertIndex - 1].year : -Infinity;
  const right =
    insertIndex < timeline.length ? timeline[insertIndex].year : Infinity;
  return left <= card.year && card.year <= right;
}

// ---------------------------------------------------------------------------
// State & actions
// ---------------------------------------------------------------------------

export type GameAction =
  | {
      type: 'START_GAME';
      payload: { playerNames: string[]; settings: GameSettings; deck: GameCard[] };
    }
  | { type: 'DRAW_CARD' }
  | { type: 'PLACE_CARD'; payload: { insertIndex: number } }
  | { type: 'AWARD_CHIP'; payload: { playerId: string } }
  | {
      type: 'ATTEMPT_STEAL';
      payload: {
        stealerId: string;
        stealerInsertIndex: number;
        activeInsertIndex: number;
      };
    }
  | { type: 'NEXT_PLAYER' }
  | { type: 'END_GAME'; payload: { winner: Player } }
  | { type: 'RESET' };

const initialState: GameState = {
  phase: 'setup',
  players: [],
  currentPlayerIndex: 0,
  currentCard: null,
  deck: [],
  settings: {
    cardsToWin: 10,
    playlistId: '',
    hideCoverUntilRevealed: false,
    chipsEnabled: true,
  },
  winner: null,
  lastPlacement: null,
};

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'START_GAME': {
      const { playerNames, settings, deck } = action.payload;

      // Deal one revealed start card to each player from the top of the deck.
      const players: Player[] = playerNames.map((name, i) => ({
        id: `p${i}`,
        name,
        timeline: [deck[i]],
        score: 0,
        chips: 2, // start with 2 Nickel (Hitster-style)
        currentStreak: 0,
        maxBrandtStreak: 0,
      }));
      const remaining = deck.slice(playerNames.length);

      return {
        ...initialState,
        phase: 'playing',
        players,
        deck: remaining,
        settings,
        currentPlayerIndex: 0,
        currentCard: null,
        winner: null,
        lastPlacement: null,
      };
    }

    case 'DRAW_CARD': {
      if (state.deck.length === 0) {
        // Out of cards - nothing to draw; leave currentCard null for the UI.
        return { ...state, currentCard: null, lastPlacement: null };
      }
      const [next, ...rest] = state.deck;
      return { ...state, currentCard: next, deck: rest, lastPlacement: null };
    }

    case 'PLACE_CARD': {
      const card = state.currentCard;
      if (!card) return state;

      const { insertIndex } = action.payload;
      const playerIndex = state.currentPlayerIndex;
      const player = state.players[playerIndex];
      const correct = isCorrectPlacement(player.timeline, card, insertIndex);

      // Correct -> insert (keeps timeline sorted) and score up. Wrong -> discard.
      const newTimeline = correct
        ? [
            ...player.timeline.slice(0, insertIndex),
            card,
            ...player.timeline.slice(insertIndex),
          ]
        : player.timeline;
      const newScore = correct ? player.score + 1 : player.score;

      // "Brandt" hot-streak: consecutive correct OWN placements (this is the
      // player's own turn). +1 on correct, reset to 0 on a miss; track the peak.
      const newStreak = correct ? player.currentStreak + 1 : 0;
      const newMaxStreak = Math.max(player.maxBrandtStreak, newStreak);

      const updatedPlayer: Player = {
        ...player,
        timeline: newTimeline,
        score: newScore,
        currentStreak: newStreak,
        maxBrandtStreak: newMaxStreak,
      };
      const players = state.players.map((p, i) =>
        i === playerIndex ? updatedPlayer : p
      );

      const won = correct && newScore >= state.settings.cardsToWin;

      return {
        ...state,
        players,
        currentCard: null,
        lastPlacement: {
          result: correct ? 'correct' : 'incorrect',
          card,
          insertIndex,
        },
        winner: won ? updatedPlayer : state.winner,
        phase: won ? 'result' : state.phase,
      };
    }

    case 'AWARD_CHIP': {
      const { playerId } = action.payload;
      const players = state.players.map((p) =>
        p.id === playerId && p.chips < MAX_CHIPS ? { ...p, chips: p.chips + 1 } : p
      );
      return { ...state, players };
    }

    case 'ATTEMPT_STEAL': {
      const card = state.currentCard;
      if (!card) return state;

      const { stealerId, stealerInsertIndex, activeInsertIndex } = action.payload;
      const activeIndex = state.currentPlayerIndex;
      const active = state.players[activeIndex];
      const stealer = state.players.find((p) => p.id === stealerId);
      if (!stealer || stealer.id === active.id) return state;

      // The active player's own placement decides whether a steal is even possible.
      const activeCorrect = isCorrectPlacement(
        active.timeline,
        card,
        activeInsertIndex
      );
      // Whether the stealer's slot is year-valid in the active player's timeline.
      const stealerSlotValid = isCorrectPlacement(
        active.timeline,
        card,
        stealerInsertIndex
      );
      // A steal only succeeds if the active player placed WRONGLY and the stealer
      // then found a year-valid slot. If the active player was already correct, no
      // steal is possible - even when an equal-year situation leaves a second valid
      // slot for the stealer (that slot is NOT the active player's actual choice).
      const stealCorrect = !activeCorrect && stealerSlotValid;
      // Equal-year standoff: the steal missed only because the active player was
      // also correct at an equally-valid slot.
      const stealEqualYear = activeCorrect && stealerSlotValid;

      const players = state.players.map((p, i) => {
        if (p.id === stealerId) {
          // The chip is always spent. On success the card joins THEIR timeline at
          // the position that keeps their own timeline sorted (computed fresh -
          // stealerInsertIndex referred to the active player's timeline). A steal
          // does NOT touch the stealer's Brandt streak (that only tracks their own
          // active-turn placements).
          const chips = Math.max(0, p.chips - 1);
          if (stealCorrect) {
            return {
              ...p,
              chips,
              timeline: insertAt(p.timeline, card, sortedInsertIndex(p.timeline, card.year)),
              score: p.score + 1,
            };
          }
          return { ...p, chips };
        }
        if (i === activeIndex) {
          // The active player's OWN placement drives their Brandt streak, whether
          // or not a steal happened: +1 if they were correct, reset to 0 if not.
          const activeStreak = activeCorrect ? p.currentStreak + 1 : 0;
          const activeMax = Math.max(p.maxBrandtStreak, activeStreak);
          if (activeCorrect) {
            // A steal can't succeed when the active player was correct, so they
            // keep the card here.
            return {
              ...p,
              timeline: insertAt(p.timeline, card, activeInsertIndex),
              score: p.score + 1,
              currentStreak: activeStreak,
              maxBrandtStreak: activeMax,
            };
          }
          return { ...p, currentStreak: activeStreak, maxBrandtStreak: activeMax };
        }
        return p;
      });

      const winner =
        players.find((p) => p.score >= state.settings.cardsToWin) ?? null;

      return {
        ...state,
        players,
        currentCard: null,
        lastPlacement: {
          result: activeCorrect ? 'correct' : 'incorrect',
          card,
          insertIndex: activeInsertIndex,
          steal: {
            stealerId,
            insertIndex: stealerInsertIndex,
            result: stealCorrect ? 'correct' : 'incorrect',
            equalYear: stealEqualYear,
          },
        },
        winner: winner ?? state.winner,
        phase: winner ? 'result' : state.phase,
      };
    }

    case 'NEXT_PLAYER': {
      if (state.players.length === 0) return state;
      return {
        ...state,
        currentPlayerIndex:
          (state.currentPlayerIndex + 1) % state.players.length,
        currentCard: null,
        lastPlacement: null,
      };
    }

    case 'END_GAME': {
      return { ...state, phase: 'result', winner: action.payload.winner };
    }

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context wiring
// ---------------------------------------------------------------------------

interface GameContextValue {
  state: GameState;
  dispatch: React.Dispatch<GameAction>;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(gameReducer, initialState);
  return (
    <GameContext.Provider value={{ state, dispatch }}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return ctx;
}
