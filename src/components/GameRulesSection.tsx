/**
 * GameRulesSection - the complete Hitster rule editor (cards to win, cover
 * toggle, Nickel/Hitster calls, skip, blind draw, music timer), extracted
 * 1:1 from the old "Spielregeln" card in the Einstellungen tab.
 *
 * Rendered inline where the rules actually apply: the Party lobby (host,
 * hitster mode) and the Pass & Play setup. Reads/writes the shared
 * SettingsContext, so values persist across screens/session exactly as
 * before - only the editing surface moved.
 */
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useSettings } from '../context/SettingsContext';
import { StepSlider } from './StepSlider';
import { COLORS } from '../theme/colors';

export function GameRulesSection() {
  const { settings, update } = useSettings();

  return (
    <View style={styles.card}>
      <View style={styles.winHeader}>
        <Text style={styles.ruleLabel}>Karten zum Gewinnen</Text>
        <Text style={styles.winValue}>{settings.cardsToWin}</Text>
      </View>
      <StepSlider
        value={settings.cardsToWin}
        min={5}
        max={20}
        milestones={[5, 10, 15, 20]}
        onChange={(v) => update({ cardsToWin: v })}
      />

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Cover erst nach Aufdeckung zeigen</Text>
          <Text style={styles.toggleHint}>Für Spielvarianten mit Titel/Interpret-Rätseln</Text>
        </View>
        <Switch
          value={settings.hideCoverUntilRevealed}
          onValueChange={(v) => update({ hideCoverUntilRevealed: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Nickel & Hitster-Rufe aktivieren</Text>
          <Text style={styles.toggleHint}>
            Nickel für richtig erratenen Titel + Interpret; „Hitster!" zum Klauen
          </Text>
        </View>
        <Switch
          value={settings.chipsEnabled}
          onValueChange={(v) => update({ chipsEnabled: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Nickel-Obergrenze</Text>
          <Text style={styles.toggleHint}>
            Maximal haltbare Nickel pro Spieler; aus = unbegrenzt sammeln
            (Original-Hitster-Regel: 5)
          </Text>
        </View>
        <Switch
          value={settings.chipLimitEnabled}
          onValueChange={(v) => update({ chipLimitEnabled: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>
      {settings.chipLimitEnabled && (
        <View style={styles.costBlock}>
          <View style={styles.winHeader}>
            <Text style={styles.costLabel}>Obergrenze</Text>
            <Text style={styles.costValue}>{settings.chipLimit} 🪙</Text>
          </View>
          <StepSlider
            value={settings.chipLimit}
            min={5}
            max={10}
            milestones={[5, 10]}
            onChange={(v) => update({ chipLimit: v })}
          />
        </View>
      )}

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Karte überspringen</Text>
          <Text style={styles.toggleHint}>
            Aktuelle Karte gegen Nickel abwerfen und eine neue ziehen
          </Text>
        </View>
        <Switch
          value={settings.skipEnabled}
          onValueChange={(v) => update({ skipEnabled: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>
      {settings.skipEnabled && (
        <View style={styles.costBlock}>
          <View style={styles.winHeader}>
            <Text style={styles.costLabel}>Kosten pro Überspringen</Text>
            <Text style={styles.costValue}>{settings.skipCost} 🪙</Text>
          </View>
          <StepSlider
            value={settings.skipCost}
            min={1}
            max={3}
            milestones={[1, 2, 3]}
            onChange={(v) => update({ skipCost: v })}
          />
        </View>
      )}

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Karte ohne Raten ziehen</Text>
          <Text style={styles.toggleHint}>
            Karte wird gegen Nickel automatisch richtig einsortiert; Zug endet sofort.
            Zählt nicht als Fortschritt zum Sieg.
          </Text>
        </View>
        <Switch
          value={settings.blindEnabled}
          onValueChange={(v) => update({ blindEnabled: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>
      {settings.blindEnabled && (
        <View style={styles.costBlock}>
          <View style={styles.winHeader}>
            <Text style={styles.costLabel}>Kosten pro Blind-Zug</Text>
            <Text style={styles.costValue}>{settings.blindCost} 🪙</Text>
          </View>
          <StepSlider
            value={settings.blindCost}
            min={3}
            max={5}
            milestones={[3, 4, 5]}
            onChange={(v) => update({ blindCost: v })}
          />
        </View>
      )}

      <View style={styles.ruleToggleRow}>
        <View style={styles.toggleTextWrap}>
          <Text style={styles.toggleTitle}>Timer</Text>
          <Text style={styles.toggleHint}>
            Musik stoppt nach Ablauf der Zeit; geraten werden darf weiter
          </Text>
        </View>
        <Switch
          value={settings.timerEnabled}
          onValueChange={(v) => update({ timerEnabled: v })}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor={COLORS.text}
          ios_backgroundColor={COLORS.border}
        />
      </View>
      {settings.timerEnabled && (
        <View style={styles.costBlock}>
          <View style={styles.winHeader}>
            <Text style={styles.costLabel}>Songdauer pro Zug</Text>
            <Text style={styles.costValue}>{settings.timerSeconds}s</Text>
          </View>
          <StepSlider
            value={settings.timerSeconds}
            min={30}
            max={120}
            step={5}
            milestones={[30, 60, 90, 120]}
            onChange={(v) => update({ timerSeconds: v })}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.backgroundAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12,
  },
  ruleLabel: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  winHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  winValue: {
    color: COLORS.accent,
    fontSize: 24,
    fontWeight: '900',
    textShadowColor: COLORS.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  ruleToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  toggleTextWrap: { flex: 1 },
  toggleTitle: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  toggleHint: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  costBlock: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  costLabel: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700' },
  costValue: { color: COLORS.accent, fontSize: 16, fontWeight: '900' },
});
