/**
 * VictoryScreen - Hot-Seat route shown on a win, BEFORE ResultScreen (stats).
 * Reads the winner from GameContext and renders the shared VictoryCelebration;
 * "Weiter zur Statistik" continues to Result. Win detection + ResultScreen are
 * unchanged - this only sits between them.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useGame } from '../context/GameContext';
import { VictoryCelebration } from '../components/VictoryCelebration';
import type { GameStackParamList } from '../types/navigation';

type Nav = NativeStackNavigationProp<GameStackParamList, 'Victory'>;

export default function VictoryScreen() {
  const navigation = useNavigation<Nav>();
  const { state } = useGame();
  return (
    <VictoryCelebration
      winnerName={state.winner?.name ?? '—'}
      onContinue={() => navigation.navigate('Result')}
    />
  );
}
