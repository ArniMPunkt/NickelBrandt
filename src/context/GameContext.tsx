/**
 * Central game state for the Hot-Seat mode, as a React Context + useReducer.
 *
 * The reducer is pure (no Spotify / IO side effects) - screens trigger playback
 * via the spotify service around the dispatch calls.
 */
import { createContext, useContext, useReducer, type ReactNode } from 'react';
import type {
  GameCard,
  GameSettings,
  GameState,
  Player,
} from '../types/game';

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
  | { type: 'NEXT_PLAYER' }
  | { type: 'END_GAME'; payload: { winner: Player } }
  | { type: 'RESET' };

const initialState: GameState = {
  phase: 'setup',
  players: [],
  currentPlayerIndex: 0,
  currentCard: null,
  deck: [],
  settings: { cardsToWin: 10, playlistId: '', hideCoverUntilRevealed: false },
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

      const updatedPlayer: Player = {
        ...player,
        timeline: newTimeline,
        score: newScore,
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
