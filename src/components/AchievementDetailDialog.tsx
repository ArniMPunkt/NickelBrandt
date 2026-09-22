/**
 * AchievementDetailDialog - what opens when an "Erfolge" tile is tapped.
 *
 * The gallery tile can only show icon, name and (once earned) a date, so until
 * now nothing in the app ever said what an achievement is actually FOR. This
 * dialog answers that, deliberately for LOCKED achievements too - the catalog
 * has never hidden its entries ("kein Überraschungseffekt"), and a criterion
 * you can't read is a locked door without a sign.
 *
 * Two shapes, driven by the GalleryTile it is handed:
 *   - a standalone achievement -> criterion, status, progress
 *   - one of the two multi-tier families (Nickel, Partien-Meilensteine) -> ALL
 *     three tiers listed separately, each with its own criterion, status and
 *     progress. A family is routinely half-finished (Nickelfarmer earned,
 *     Nickelgott not), and a single collapsed status would misreport that.
 *
 * Progress numbers come from achievementProgress() and only exist where the
 * underlying stat is permanently kept (see ProgressSource there) - a tier
 * without one simply shows its criterion, never an invented number.
 *
 * Built on the same transparent <Modal> as ConfirmDialog, with the content in
 * a ScrollView and the card capped at 85% height: the longest criteria wrap to
 * several lines and must stay readable on a small phone.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  achievementProgress,
  SCOPE_LABEL,
  type AchievementDefinition,
  type GalleryTile,
} from '../services/achievementDefinitions';
import type { LocalProfile } from '../services/achievements';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

/** Shared by the dialog and the gallery tiles, so one date format exists. */
export function formatUnlockDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE');
  } catch {
    return '';
  }
}

/** Filled share of the goal, clamped - an overshoot (137 of 100 Partien) stays a full bar. */
function ProgressBar({ current, target }: { current: number; target: number }) {
  const share = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${Math.round(share * 100)}%` }]} />
    </View>
  );
}

/**
 * One tier inside the dialog. Unlocked tiers show WHEN they were earned, open
 * ones how far along they are - a "12 / 5" on something already achieved would
 * be noise, and a date on something open would be a lie.
 */
function TierRow({
  def,
  unlockedAt,
  stats,
  showIcon,
}: {
  def: AchievementDefinition;
  unlockedAt: string | null;
  stats: LocalProfile['stats'] | null;
  /** Family tiers repeat the icon per row; a standalone one already has it in the header. */
  showIcon: boolean;
}) {
  const unlocked = unlockedAt != null;
  const progress = stats && !unlocked ? achievementProgress(def.id, stats) : null;
  return (
    <View style={styles.tierRow}>
      {showIcon && (
        <Text style={[styles.tierIcon, !unlocked && styles.dimmed]}>{def.icon}</Text>
      )}
      <View style={styles.tierMain}>
        {showIcon && (
          <View style={styles.tierTopLine}>
            <Text style={styles.tierName} numberOfLines={2}>
              {def.name}
            </Text>
            <Text style={[styles.tierStatus, unlocked ? styles.statusDone : styles.statusOpen]}>
              {unlocked ? `✓ ${formatUnlockDate(unlockedAt)}` : 'offen'}
            </Text>
          </View>
        )}
        <Text style={styles.criterion}>{def.description}</Text>
        {!showIcon && (
          <Text style={[styles.tierStatus, unlocked ? styles.statusDone : styles.statusOpen]}>
            {unlocked ? `✓ Errungen am ${formatUnlockDate(unlockedAt)}` : 'Noch offen'}
          </Text>
        )}
        {progress && (
          <View style={styles.progressBlock}>
            <View style={styles.progressTopLine}>
              <Text style={styles.progressLabel} numberOfLines={1}>
                {progress.label}
              </Text>
              <Text style={styles.progressValue}>
                {progress.current} / {progress.target}
              </Text>
            </View>
            <ProgressBar current={progress.current} target={progress.target} />
          </View>
        )}
      </View>
    </View>
  );
}

export function AchievementDetailDialog({
  tile,
  unlockedAt,
  stats,
  onClose,
}: {
  /** The tapped tile; null keeps the dialog closed. */
  tile: GalleryTile | null;
  /** achievement id -> ISO unlock timestamp, for everything already earned. */
  unlockedAt: Readonly<Record<string, string>>;
  /** Current profile stats for the progress readouts; null while still loading. */
  stats: LocalProfile['stats'] | null;
  onClose: () => void;
}) {
  const isFamily = (tile?.tiers.length ?? 0) > 1;
  // The tile's own earned state: for a family that is its highest EARNED tier,
  // so a part-finished family still reads as earned in the header.
  const headerUnlocked = tile != null && unlockedAt[tile.def.id] != null;
  const accent = headerUnlocked ? COLORS.accent : COLORS.border;

  return (
    <Modal
      visible={tile != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Tap anywhere outside to dismiss; the card swallows its own taps so a
          tap inside (e.g. while scrolling a long criterion) doesn't close it. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.card, { borderColor: accent }, glow(accent, { radius: 18, opacity: 0.6 })]}
          onPress={() => {}}
        >
          {tile && (
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.headerIcon, !headerUnlocked && styles.dimmed]}>
                {tile.def.icon}
              </Text>
              <Text style={styles.headerName}>{tile.def.name}</Text>
              {/* The header names the REPRESENTATIVE tier, which on a family is
                  whichever one is currently the highest earned - so say outright
                  how much of the family that is, instead of leaving "Nickelmeister"
                  above a list of three to be puzzled out. */}
              {isFamily && (
                <Text style={styles.headerSub}>
                  {tile.tiers.filter((d) => unlockedAt[d.id] != null).length} von{' '}
                  {tile.tiers.length} Stufen erreicht
                </Text>
              )}
              <View style={styles.scopePill}>
                <Text style={styles.scopeText}>{SCOPE_LABEL[tile.def.scope]}</Text>
              </View>

              {isFamily ? (
                <>
                  <Text style={styles.sectionLabel}>STUFEN</Text>
                  {tile.tiers.map((def) => (
                    <TierRow
                      key={def.id}
                      def={def}
                      unlockedAt={unlockedAt[def.id] ?? null}
                      stats={stats}
                      showIcon
                    />
                  ))}
                </>
              ) : (
                <>
                  <Text style={styles.sectionLabel}>SO SCHALTEST DU IHN FREI</Text>
                  <TierRow
                    def={tile.def}
                    unlockedAt={unlockedAt[tile.def.id] ?? null}
                    stats={stats}
                    showIcon={false}
                  />
                </>
              )}
            </ScrollView>
          )}
          <PressableButton style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>Schließen</Text>
          </PressableButton>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    // Capped rather than sized to content: the family dialogs plus a long
    // criterion would otherwise run off a small screen.
    maxHeight: '85%',
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  scrollContent: { gap: 10, alignItems: 'stretch', paddingBottom: 4 },

  headerIcon: { fontSize: 52, textAlign: 'center' },
  headerName: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  headerSub: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  scopePill: {
    alignSelf: 'center',
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  scopeText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '800' },
  dimmed: { opacity: 0.35 },

  sectionLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginTop: 6,
  },

  tierRow: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: COLORS.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
  },
  tierIcon: { fontSize: 26 },
  tierMain: { flex: 1, gap: 5 },
  tierTopLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tierName: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: '900' },
  tierStatus: { fontSize: 12, fontWeight: '800' },
  statusDone: { color: COLORS.accent },
  statusOpen: { color: COLORS.textMuted },
  criterion: { color: COLORS.textMuted, fontSize: 14, fontWeight: '600', lineHeight: 20 },

  progressBlock: { gap: 5, marginTop: 2 },
  progressTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressLabel: { flex: 1, color: COLORS.textMuted, fontSize: 12, fontWeight: '700' },
  progressValue: { color: COLORS.text, fontSize: 13, fontWeight: '900' },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.border,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 3, backgroundColor: COLORS.accent },

  closeBtn: {
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
});
