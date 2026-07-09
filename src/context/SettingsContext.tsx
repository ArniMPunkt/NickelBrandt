/**
 * App-wide game-rule settings, deliberately SEPARATE from the GameContext
 * reducer (which stays pure). These persist across the SetupScreen lifecycle and
 * navigation for the running session; they are read at "Spiel starten" and
 * passed into START_GAME.
 *
 * NOTE: currently in-memory only. Cross-restart persistence would use
 * @react-native-async-storage/async-storage (a native module -> needs install +
 * rebuild), so it's intentionally deferred to a follow-up.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

export interface GameRuleSettings {
  /** Correct placements needed to win. */
  cardsToWin: number;
  /** Hide cover/title/artist until a card is placed. */
  hideCoverUntilRevealed: boolean;
  /** Enable the Nickel / Hitster steal layer. */
  chipsEnabled: boolean;
  /** "Karte überspringen": swap the current card for a fresh one (costs Nickel). */
  skipEnabled: boolean;
  /** Nickel cost of a skip (1-3). */
  skipCost: number;
  /** "Karte ohne Raten ziehen": auto-insert the card correctly, turn ends (costs Nickel). */
  blindEnabled: boolean;
  /** Nickel cost of a blind draw (3-5). */
  blindCost: number;
  /** Music timer: hard-stop the song after timerSeconds (guessing continues). */
  timerEnabled: boolean;
  /** Song duration per turn in seconds (30-120). */
  timerSeconds: number;
  /** Nickel cap; off = unlimited collecting. Default off. */
  chipLimitEnabled: boolean;
  /** The cap when chipLimitEnabled (5-10; original Hitster rule: 5). */
  chipLimit: number;
}

export const DEFAULT_SETTINGS: GameRuleSettings = {
  cardsToWin: 10,
  hideCoverUntilRevealed: true,
  chipsEnabled: true,
  skipEnabled: false,
  skipCost: 1,
  blindEnabled: false,
  blindCost: 3,
  timerEnabled: false,
  timerSeconds: 60,
  chipLimitEnabled: false,
  chipLimit: 5,
};

interface SettingsContextValue {
  settings: GameRuleSettings;
  /** Merge a partial update; changes apply immediately (no save button). */
  update: (partial: Partial<GameRuleSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GameRuleSettings>(DEFAULT_SETTINGS);
  const update = (partial: Partial<GameRuleSettings>) =>
    setSettings((prev) => ({ ...prev, ...partial }));
  return (
    <SettingsContext.Provider value={{ settings, update }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}
