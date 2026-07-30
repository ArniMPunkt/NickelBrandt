/**
 * SettingsScreen - the "Profil" tab (route name "Einstellungen", unchanged).
 * Single home for everything that used to live in the two gear modals + the
 * old Spotify tab:
 *   - Spotify connection status + connect / disconnect
 *   - Game rules (cards to win, cover delay, Nickel/Hitster) via SettingsContext
 *   - App info (version / about)
 *   - The local stats/achievements profile (services/achievements.ts,
 *     AsyncStorage - device-bound, no account): a "Spielstatistiken" tab with
 *     real numbers + the (now functional) reset button, and an "Erfolge"
 *     gallery of the full achievement catalog.
 *
 * Game logic is untouched; this only reads/writes SettingsContext and calls the
 * existing Spotify service. Status refreshes on focus, so connecting here and
 * switching tabs updates the gated start/create buttons automatically. The
 * profile reloads on focus too, so returning from a just-finished match shows
 * fresh numbers immediately.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Spotify from '../services/spotify';
import * as Achievements from '../services/achievements';
import {
  PLAYER_NAME_MAX_LENGTH,
  loadPlayerName,
  savePlayerName,
  validatePlayerName,
} from '../services/playerName';
import {
  buildGalleryTiles,
  currentMilestone,
  type AchievementDefinition,
} from '../services/achievementDefinitions';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PressableButton } from '../components/PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

const SPOTIFY_GREEN = '#1DB954';
const APP_INFO_TEXT =
  'NickelBrandt — das Musik-Partyspiel für dich und deine Freunde. Errate Jahre, baue deine Songtimeline und klau dir Karten von Mitspielern. Ob Hitster, Bingo oder Timeline-Quiz, ob Online-Party oder Reihum auf einem Gerät — pass nur auf, dass du dich am Ende nicht verBrandt hast.';

function formatAppVersion(version: string | null | undefined): string {
  const cleanVersion = version?.trim();
  if (!cleanVersion) return 'unbekannt';
  return cleanVersion.startsWith('v') ? cleanVersion : `v${cleanVersion}`;
}

const APP_VERSION = formatAppVersion(Constants.expoConfig?.version);

const MODE_LABEL: Record<Achievements.GameModeKey, string> = {
  hitster_party: 'Party-Hitster',
  hitster_pnp: 'Pass & Play',
  bingo: 'Bingo',
  timeline_quiz: 'Timeline-Quiz',
};

// Reuses icons already established elsewhere: 🎉/📱 are the app's own
// Party/Pass & Play tab icons (App.tsx); 🟩/🧵 are the Bingo/Timeline-Quiz
// "Perfect ..." achievement icons - thematically the closest fit without
// inventing a fourth icon language for the same four modes.
const MODE_ICON: Record<Achievements.GameModeKey, string> = {
  hitster_party: '🎉',
  hitster_pnp: '📱',
  bingo: '🟩',
  timeline_quiz: '🧵',
};

function formatUnlockDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE');
  } catch {
    return '';
  }
}

/** One number tile in the "Spielstatistiken" grid (icon + value + label). */
function StatTile({ icon, label, value }: { icon: string; label: string; value: string | number }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** One "Nach Modus" row: icon + name + a bar visualizing this mode's share of gamesPlayed + the raw count. */
function ModeBreakdownRow({
  mode,
  count,
  totalGames,
}: {
  mode: Achievements.GameModeKey;
  count: number;
  totalGames: number;
}) {
  const share = totalGames > 0 ? count / totalGames : 0;
  return (
    <View style={styles.statBreakdownRow}>
      <Text style={styles.statBreakdownIcon}>{MODE_ICON[mode]}</Text>
      <View style={styles.statBreakdownMain}>
        <View style={styles.statBreakdownTopLine}>
          <Text style={styles.statBreakdownName}>{MODE_LABEL[mode]}</Text>
          <Text style={styles.statBreakdownValue}>{count}</Text>
        </View>
        <View style={styles.statBarTrack}>
          <View style={[styles.statBarFill, { width: `${Math.round(share * 100)}%` }]} />
        </View>
      </View>
    </View>
  );
}

/**
 * One tile in the "Erfolge" gallery. Unlocked: full-color icon + name +
 * unlock date. Locked: dimmed icon + name only (never hidden - "kein
 * Überraschungseffekt") - no status subtitle, the 30% icon opacity already
 * makes the locked state unambiguous, and the extra line only got truncated
 * at this tile width anyway.
 */
function AchievementTile({
  achievement,
  unlockedAt,
}: {
  achievement: AchievementDefinition;
  unlockedAt: string | null;
}) {
  const unlocked = unlockedAt != null;
  return (
    <View style={[styles.achTile, !unlocked && styles.achTileLocked]}>
      <Text style={[styles.achIcon, !unlocked && styles.achIconLocked]}>{achievement.icon}</Text>
      <Text style={styles.achName} numberOfLines={2}>
        {achievement.name}
      </Text>
      {unlocked && (
        <Text style={styles.achStatusUnlocked} numberOfLines={1}>
          {formatUnlockDate(unlockedAt)}
        </Text>
      )}
    </View>
  );
}

// iOS only: the native uncaught-exception handler (plugins/withCrashDiagnostics)
// persists the last fatal NSException (name/reason/stack) to NSUserDefaults -
// RN's Settings module reads the same store. Survives app updates, so a crash
// of a build that never got past startup is still readable here later.
const CRASH_RECORD_KEY = 'NBLastNativeCrash';

function readCrashRecord(): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const v = Settings.get(CRASH_RECORD_KEY);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [connected, setConnected] = useState(Spotify.isReadyToPlay());
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crashRecord, setCrashRecord] = useState<string | null>(readCrashRecord);
  const [profile, setProfile] = useState<Achievements.LocalProfile | null>(null);
  const [profileTab, setProfileTab] = useState<'stats' | 'achievements'>('stats');
  const [resetConfirmVisible, setResetConfirmVisible] = useState(false);

  const refreshProfile = useCallback(() => {
    Achievements.loadProfile().then(setProfile).catch(() => {});
  }, []);
  // Reload on every focus, so returning here right after a match shows the
  // just-earned stats/achievements without a manual pull-to-refresh.
  useFocusEffect(refreshProfile);

  // ---- Persistent name header (same stored name Party uses to prefill) ----
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const refreshPlayerName = useCallback(() => {
    loadPlayerName().then(setPlayerName).catch(() => {});
  }, []);
  // Reload on every focus too - editing the name from Party (OnlineHomeScreen)
  // must show up here without needing an app restart, since this tab stays
  // mounted in the background otherwise.
  useFocusEffect(refreshPlayerName);

  const startEditName = () => {
    setNameDraft(playerName ?? '');
    setNameError(null);
    setEditingName(true);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setNameError(null);
  };

  const saveEditName = async () => {
    const result = validatePlayerName(nameDraft);
    if (!result.ok) {
      setNameError(result.error);
      return;
    }
    await savePlayerName(result.value);
    setPlayerName(result.value);
    setEditingName(false);
    setNameError(null);
  };

  const confirmResetProfile = async () => {
    setResetConfirmVisible(false);
    await Achievements.resetProfile().catch(() => {});
    refreshProfile();
  };

  const clearCrashRecord = () => {
    try {
      Settings.set({ [CRASH_RECORD_KEY]: '' });
    } catch {
      // best effort
    }
    setCrashRecord(null);
  };

  const refresh = useCallback(async () => {
    const isConnected = Spotify.isReadyToPlay();
    setConnected(isConnected);
    if (isConnected) {
      try {
        setName(await Spotify.getDisplayName());
      } catch {
        setName(null);
      }
    } else {
      setName(null);
    }
  }, []);

  // Keep the status in sync whenever the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // Live status: react to connect/disconnect events (e.g. iOS dropping the App
  // Remote in the background) even while this tab is already open - not just on
  // focus. subscribeConnection fires immediately with the current value too.
  useEffect(() => {
    const unsub = Spotify.subscribeConnection(() => {
      refresh();
    });
    return unsub;
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await Spotify.connect();
      await refresh();
    } catch (e: any) {
      const code = e?.code ? `[${e.code}] ` : '';
      setError(`${code}${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await Spotify.disconnect();
    } catch {
      // ignore - status will reflect disconnected
    } finally {
      setConnected(false);
      setName(null);
      setBusy(false);
    }
  };

  // "Dein Titel": the highest Partien-Meilenstein reached so far (null below
  // 10 Partien - no empty-state header, it just doesn't render).
  const titleAchievement = profile ? currentMilestone(profile.stats) : null;

  // Siegquote: Party-Hitster only, both numerator and denominator (NOT
  // gamesPlayed overall, which also counts Bingo/Quiz/Pass & Play). "–" for
  // 0 Party-Hitster matches instead of a 0/0 division.
  const partyGamesPlayed = profile?.stats.gamesByMode.hitster_party ?? 0;
  const winRateDisplay =
    partyGamesPlayed > 0
      ? `${Math.round(((profile?.stats.hitster.partyGamesWon ?? 0) / partyGamesPlayed) * 100)}%`
      : '–';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text style={styles.title}>Profil</Text>

      {/* ---- Spielername: persistent header, same stored value Party
          prefills from. Visible/editable regardless of which Statistik/
          Erfolge sub-tab is active further down. ---- */}
      <View style={styles.nameCard}>
        {editingName ? (
          <>
            <TextInput
              style={styles.nameInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Name"
              placeholderTextColor={COLORS.textMuted}
              maxLength={PLAYER_NAME_MAX_LENGTH}
              autoFocus
            />
            {nameError && <Text style={styles.nameErrorText}>{nameError}</Text>}
            <View style={styles.nameButtonRow}>
              <PressableButton style={styles.nameCancelBtn} onPress={cancelEditName}>
                <Text style={styles.nameCancelText}>Abbrechen</Text>
              </PressableButton>
              <PressableButton style={styles.nameSaveBtn} onPress={saveEditName}>
                <Text style={styles.nameSaveText}>Speichern</Text>
              </PressableButton>
            </View>
          </>
        ) : (
          <PressableButton style={styles.nameDisplayRow} onPress={startEditName}>
            <Text style={styles.namePlayerIcon}>👤</Text>
            <Text style={styles.namePlayerText} numberOfLines={1}>
              {playerName && playerName.trim() ? playerName : 'Name festlegen'}
            </Text>
            <Text style={styles.nameEditHint}>✎</Text>
          </PressableButton>
        )}
      </View>

      {/* ---- Spotify ---- */}
      <Text style={styles.section}>SPOTIFY</Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View
            style={[styles.dot, { backgroundColor: connected ? COLORS.correct : COLORS.textMuted }]}
          />
          <Text style={styles.statusText}>
            {connected ? (name ? `Verbunden als ${name}` : 'Verbunden') : 'Nicht verbunden'}
          </Text>
        </View>
        <Text style={styles.spotifyHint}>
          {connected
            ? 'Du kannst jetzt ein Spiel starten oder eine Lobby erstellen.'
            : 'Verbinde dich, um die Musik abzuspielen. Nötig zum Starten eines Pass & Play-Spiels und zum Erstellen einer Online-Lobby.'}
        </Text>
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText} selectable>
              {error}
            </Text>
          </View>
        )}
        {connected ? (
          <PressableButton style={styles.dangerBtn} onPress={disconnect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.incorrect} />
            ) : (
              <Text style={styles.dangerText}>Verbindung trennen</Text>
            )}
          </PressableButton>
        ) : (
          <PressableButton style={[styles.connectBtn, busy && styles.disabled]} onPress={connect} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <Text style={styles.connectBtnText}>Mit Spotify verbinden</Text>
            )}
          </PressableButton>
        )}
      </View>

      {/* Spielregeln editing moved INLINE to where the rules apply: the Party
          lobby (host, hitster mode) and the Pass & Play setup - see
          components/GameRulesSection. This tab keeps Spotify + app info. */}

      {/* ---- App info ---- */}
      <Text style={styles.section}>APP-INFO</Text>
      <View style={styles.card}>
        <Text style={styles.infoRow}>Version {APP_VERSION}</Text>
        <Text style={styles.about}>{APP_INFO_TEXT}</Text>
      </View>

      {/* ---- Crash diagnostics (iOS): last recorded native exception ---- */}
      {crashRecord != null && (
        <>
          <Text style={styles.section}>LETZTER NATIVER CRASH</Text>
          <View style={[styles.card, styles.crashCard]}>
            <Text style={styles.crashText} selectable>
              {crashRecord}
            </Text>
            <PressableButton style={styles.placeholderBtn} onPress={clearCrashRecord}>
              <Text style={styles.placeholderText}>Eintrag verwerfen</Text>
            </PressableButton>
          </View>
        </>
      )}

      {/* ---- Statistik/Erfolge: local, device-bound profile (no account) ---- */}
      <Text style={styles.section}>STATISTIK</Text>
      <View style={styles.tabRow}>
        <PressableButton
          style={[styles.tabBtn, profileTab === 'stats' && styles.tabBtnActive]}
          onPress={() => setProfileTab('stats')}
        >
          <Text style={[styles.tabBtnText, profileTab === 'stats' && styles.tabBtnTextActive]}>
            Spielstatistiken
          </Text>
        </PressableButton>
        <PressableButton
          style={[styles.tabBtn, profileTab === 'achievements' && styles.tabBtnActive]}
          onPress={() => setProfileTab('achievements')}
        >
          <Text
            style={[styles.tabBtnText, profileTab === 'achievements' && styles.tabBtnTextActive]}
          >
            Erfolge
          </Text>
        </PressableButton>
      </View>

      {profileTab === 'stats' ? (
        <>
          {titleAchievement && (
            <View style={styles.titleHeader}>
              <Text style={styles.titleIcon}>{titleAchievement.icon}</Text>
              <View>
                <Text style={styles.titleName}>{titleAchievement.name}</Text>
                <Text style={styles.titleSubline}>
                  {profile?.stats.gamesPlayed ?? 0} Partien gespielt
                </Text>
              </View>
            </View>
          )}
          <View style={styles.card}>
            <View style={styles.statGrid}>
              <StatTile icon="🎮" label="Partien gesamt" value={profile?.stats.gamesPlayed ?? 0} />
              <StatTile icon="🏆" label="Siege" value={profile?.stats.hitster.partyGamesWon ?? 0} />
              <StatTile
                icon="🔥"
                label="Bester Streak"
                value={profile?.stats.hitster.maxStreakEver ?? 0}
              />
              <StatTile icon="📈" label="Siegquote" value={winRateDisplay} />
            </View>
            <Text style={styles.statBreakdownLabel}>NACH MODUS</Text>
            {(Object.keys(MODE_LABEL) as Achievements.GameModeKey[]).map((mode) => (
              <ModeBreakdownRow
                key={mode}
                mode={mode}
                count={profile?.stats.gamesByMode[mode] ?? 0}
                totalGames={profile?.stats.gamesPlayed ?? 0}
              />
            ))}
            <PressableButton
              style={[styles.dangerBtn, { marginTop: 4 }]}
              onPress={() => setResetConfirmVisible(true)}
            >
              <Text style={styles.dangerText}>Spielstatistiken zurücksetzen</Text>
            </PressableButton>
          </View>
        </>
      ) : (
        <View style={styles.achGrid}>
          {buildGalleryTiles(new Set((profile?.unlocked ?? []).map((u) => u.id))).map((def) => (
            <AchievementTile
              key={def.id}
              achievement={def}
              unlockedAt={profile?.unlocked.find((u) => u.id === def.id)?.unlockedAt ?? null}
            />
          ))}
        </View>
      )}

      <ConfirmDialog
        visible={resetConfirmVisible}
        title="Wirklich alle Statistiken und Erfolge zurücksetzen?"
        message="Das löscht dein gesamtes lokales Profil auf diesem Gerät unwiderruflich - alle Partien-Zahlen und freigeschalteten Erfolge."
        confirmLabel="Zurücksetzen"
        isDestructive
        onConfirm={confirmResetProfile}
        onCancel={() => setResetConfirmVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, gap: 10, paddingBottom: 48 },
  title: { color: COLORS.primary, fontSize: 34, fontWeight: '900', marginBottom: 4 },
  section: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.secondary,
    letterSpacing: 2,
    marginTop: 12,
  },
  card: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12,
  },

  // ---- Statistik/Erfolge tab bar (same look as the Lobby mode tabs) ----
  tabRow: { flexDirection: 'row', gap: 10 },
  tabBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  tabBtnActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  tabBtnText: { color: COLORS.text, fontSize: 14, fontWeight: '900', textAlign: 'center' },
  tabBtnTextActive: { color: COLORS.background },

  // ---- Spielstatistiken ----
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statTile: {
    flexBasis: '47%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 2,
    backgroundColor: COLORS.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 14,
  },
  statIcon: { fontSize: 26 },
  statValue: {
    color: COLORS.accent,
    fontSize: 22,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  statLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: '700' },
  statBreakdownLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginTop: 4,
  },
  statBreakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  statBreakdownIcon: { fontSize: 18, width: 22, textAlign: 'center' },
  statBreakdownMain: { flex: 1, gap: 4 },
  statBreakdownTopLine: { flexDirection: 'row', justifyContent: 'space-between' },
  statBreakdownName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  statBreakdownValue: { color: COLORS.accent, fontSize: 14, fontWeight: '900' },
  statBarTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
  },
  statBarFill: { height: '100%', borderRadius: 999, backgroundColor: COLORS.accent },

  // ---- "Dein Titel" header ----
  titleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.accent,
    padding: 16,
    ...glow(COLORS.accent, { radius: 14, opacity: 0.5 }),
  },
  titleIcon: { fontSize: 40 },
  titleName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  titleSubline: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', marginTop: 2 },

  // ---- Erfolge-Galerie ----
  achGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  achTile: {
    flexBasis: '31%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.accent,
    paddingVertical: 12,
    paddingHorizontal: 6,
    ...glow(COLORS.accent, { radius: 8, opacity: 0.4 }),
  },
  achTileLocked: { borderColor: COLORS.border, shadowOpacity: 0, elevation: 0 },
  achIcon: { fontSize: 30 },
  achIconLocked: { opacity: 0.3 },
  achName: { color: COLORS.text, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  achStatusUnlocked: { color: COLORS.accent, fontSize: 10, fontWeight: '700', textAlign: 'center' },

  // ---- Spielername header ----
  nameCard: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    gap: 10,
  },
  nameDisplayRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  namePlayerIcon: { fontSize: 22 },
  namePlayerText: { flex: 1, color: COLORS.text, fontSize: 18, fontWeight: '900' },
  nameEditHint: { color: COLORS.textMuted, fontSize: 16 },
  nameInput: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.background,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 14,
  },
  nameErrorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },
  nameButtonRow: { flexDirection: 'row', gap: 10 },
  nameCancelBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameCancelText: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  nameSaveBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameSaveText: { color: COLORS.background, fontSize: 15, fontWeight: '900' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 999 },
  statusText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  spotifyHint: { color: COLORS.textMuted, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  connectBtn: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: SPOTIFY_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    ...glow(SPOTIFY_GREEN, { radius: 12, opacity: 0.6 }),
  },
  connectBtnText: { color: COLORS.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  dangerBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.incorrect,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: COLORS.incorrect, fontSize: 15, fontWeight: '900' },
  disabled: { opacity: 0.6 },
  errorBox: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.incorrect,
    borderWidth: 2,
    borderRadius: 12,
    padding: 12,
  },
  errorText: { color: COLORS.incorrect, fontSize: 13, fontWeight: '700' },

  infoRow: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  about: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', lineHeight: 20 },

  placeholderBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 15, fontWeight: '800' },

  crashCard: { borderColor: COLORS.incorrect, borderWidth: 2 },
  crashText: {
    color: COLORS.text,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 15,
  },
});
