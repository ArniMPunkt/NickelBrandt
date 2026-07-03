/**
 * Local per-pool play progress (Hot-Seat): which pool songs were already drawn
 * into a game on THIS device. Pure AsyncStorage, one key per pool id - no
 * server involvement, deliberately device-local. A song counts as "played" the
 * moment it is drawn into an active game (start cards + every drawn card), NOT
 * at game end - an aborted game keeps its drawn cards excluded.
 *
 * All writes are best-effort: progress tracking must never break a game.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = '@nickelbrandt/pool_played:';
const keyFor = (poolId: string) => `${KEY_PREFIX}${poolId}`;

/** The set of track ids already played from this pool (empty on any error). */
export async function getPlayedIds(poolId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(poolId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(
      Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    );
  } catch {
    return new Set();
  }
}

/** Merge `trackIds` into the pool's played set. */
export async function addPlayedIds(poolId: string, trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) return;
  try {
    const set = await getPlayedIds(poolId);
    for (const id of trackIds) set.add(id);
    await AsyncStorage.setItem(keyFor(poolId), JSON.stringify([...set]));
  } catch {
    // best-effort
  }
}

/** Forget the played set for exactly this pool (the UI reset button). */
export async function resetPlayed(poolId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(poolId));
  } catch {
    // best-effort
  }
}
