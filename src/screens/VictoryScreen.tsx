/**
 * VictoryScreen - Hot-Seat route shown on a win, BEFORE ResultScreen (stats).
 * Reads the winner from GameContext and renders the shared VictoryCelebration;
 * "Weiter zur Statistik" continues to Result. Win detection + ResultScreen are
 * unchanged - this only sits between them.
 *
 * If recordMatchResult (fired from GameScreen) picked a "besonderer Moment"
 * achievement (first-ever, or a top-tier milestone), it shows ON TOP of the
 * celebration once "Weiter" is tapped, and only THEN continues to Result -
 * achievements never interrupt the win moment itself, just delay the next
 * step by one tap. Cleared from context immediately so it can never reappear
 * on a back-navigation.
 */
import { useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useGame } from '../context/GameContext';
import { VictoryCelebration } from '../components/VictoryCelebration';
import { AchievementUnlockedOverlay } from '../components/AchievementUnlockedOverlay';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Victory'>;

export default function VictoryScreen() {
  const navigation = useNavigation<Nav>();
  const { state, dispatch } = useGame();
  const [showCelebration, setShowCelebration] = useState(true);

  if (!showCelebration && state.specialAchievement) {
    return (
      <AchievementUnlockedOverlay
        achievement={state.specialAchievement}
        onContinue={() => {
          dispatch({ type: 'CLEAR_SPECIAL_ACHIEVEMENT' });
          navigation.navigate('Result');
        }}
      />
    );
  }

  return (
    <VictoryCelebration
      winnerName={state.winner?.name ?? '—'}
      onContinue={() => {
        if (state.specialAchievement) {
          setShowCelebration(false);
        } else {
          navigation.navigate('Result');
        }
      }}
    />
  );
}
