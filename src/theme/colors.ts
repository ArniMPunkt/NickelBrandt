/**
 * Brand colour palette derived from the app logo.
 *
 * Party-game energy: dark purple backgrounds with high-contrast neon accents.
 * Final UI/theming comes in a later prompt - for now these are the single source
 * of truth so screens can already set the right backgrounds.
 */
export const COLORS = {
  /** Primary dark-purple background (darkest). */
  background: '#1A0F3C',
  /** Lighter purple, e.g. cards / raised surfaces. */
  backgroundAlt: '#2D1B69',

  /** Neon pink - primary accent / active player / wrong feedback. */
  primary: '#FF3CAC',
  /** Cyan - secondary accent / insert points / correct feedback. */
  secondary: '#00D4FF',
  /** Orange-yellow - highlight accent / years / winner. */
  accent: '#FFB800',

  /** Foreground text on dark background. */
  text: '#FFFFFF',
  /** Muted/secondary text. */
  textMuted: '#AAAAAA',

  /** Semantic feedback colours. */
  correct: '#00C851',
  incorrect: '#FF4444',

  /** Subtle borders / dividers on dark surfaces. */
  border: '#4A3A7A',
} as const;

export type AppColors = typeof COLORS;
