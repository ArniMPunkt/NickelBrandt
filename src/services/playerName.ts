/**
 * Local, device-bound "remember my name" convenience (not an account, no
 * server sync) - the single AsyncStorage key that BOTH the Party home
 * screen (prefill on create/join, OnlineHomeScreen.tsx) and the Profil-tab
 * header (SettingsScreen.tsx) read and write. One key, one validation rule
 * set: editing it in either place is visible in the other. Pass & Play does
 * NOT use this - each local player types a fresh name there each match (no
 * stable per-player identity on a shared device), confirmed by grep: this
 * key never appears in SetupScreen.tsx.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PLAYER_NAME_KEY = '@nickelbrandt/player_name';

/** Same cap the Party name field enforces via TextInput's maxLength (never a typed-too-long error - the input simply can't hold more). */
export const PLAYER_NAME_MAX_LENGTH = 20;

export async function loadPlayerName(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PLAYER_NAME_KEY);
  } catch {
    return null;
  }
}

export async function savePlayerName(name: string): Promise<void> {
  await AsyncStorage.setItem(PLAYER_NAME_KEY, name).catch(() => {});
}

/**
 * Same rule the Party home screen enforces (requireName there): trim, then
 * require non-empty. Length is capped structurally by the TextInput's
 * maxLength prop wherever this is used, not re-validated here.
 */
export function validatePlayerName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Bitte einen Namen eingeben.' };
  return { ok: true, value: trimmed };
}
