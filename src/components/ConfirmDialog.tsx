/**
 * ConfirmDialog - the app's themed replacement for Alert.alert confirmations:
 * a dark card in the existing design vocabulary (backgroundAlt surface,
 * rounded corners, glowing accent border) with a neutral cancel button and a
 * confirm button that turns warn-red for destructive actions. Built on the
 * same RN <Modal> the pool picker screen uses, but transparent +
 * fade + centered instead of a full-screen slide.
 */
import { Modal, StyleSheet, Text, View } from 'react-native';
import { PressableButton } from './PressableButton';
import { COLORS } from '../theme/colors';
import { glow } from '../theme/glow';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Destructive actions get the red confirm button + red border glow. */
  isDestructive?: boolean;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Abbrechen',
  onConfirm,
  onCancel,
  isDestructive = false,
}: Props) {
  const accent = isDestructive ? COLORS.incorrect : COLORS.secondary;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { borderColor: accent, ...glow(accent, { radius: 18, opacity: 0.7 }) },
          ]}
        >
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.buttonRow}>
            <PressableButton style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </PressableButton>
            <PressableButton
              style={[styles.confirmBtn, { backgroundColor: accent }]}
              onPress={onConfirm}
            >
              <Text
                style={[
                  styles.confirmText,
                  // White on warn-red; app convention for cyan surfaces is
                  // dark text (see joinBtn/resumeBtn).
                  { color: isDestructive ? COLORS.text : COLORS.background },
                ]}
              >
                {confirmLabel}
              </Text>
            </PressableButton>
          </View>
        </View>
      </View>
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
    maxWidth: 400,
    backgroundColor: COLORS.backgroundAlt,
    borderWidth: 2,
    borderRadius: 20,
    padding: 20,
    gap: 10,
  },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '900', letterSpacing: 0.5 },
  message: { color: COLORS.textMuted, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  cancelText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  confirmBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  confirmText: { fontSize: 16, fontWeight: '900' },
});
