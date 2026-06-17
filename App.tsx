/**
 * Navigation root.
 *
 * Two themed bottom tabs:
 *  - "Spiel": the Hot-Seat game flow as a Native Stack
 *    (Setup -> Handoff -> Game -> Result), wrapped in GameProvider.
 *  - "Spotify": connect/disconnect screen.
 *
 * Stack headers are hidden - each screen renders its own header/safe area.
 */
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GameProvider } from './src/context/GameContext';
import { SettingsProvider } from './src/context/SettingsContext';
import SetupScreen from './src/screens/SetupScreen';
import IntroScreen from './src/screens/IntroScreen';
import HandoffScreen from './src/screens/HandoffScreen';
import GameScreen from './src/screens/GameScreen';
import ResultScreen from './src/screens/ResultScreen';
import SpotifyConnectScreen from './src/screens/SpotifyConnectScreen';
import { COLORS } from './src/theme/colors';
import type { GameStackParamList } from './src/types/navigation';

const SPOTIFY_GREEN = '#1DB954';

const GameStackNav = createNativeStackNavigator<GameStackParamList>();
const SpotifyStackNav = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function GameStack() {
  return (
    <GameStackNav.Navigator
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: { backgroundColor: COLORS.background },
      }}
    >
      <GameStackNav.Screen name="Setup" component={SetupScreen} />
      <GameStackNav.Screen name="Intro" component={IntroScreen} />
      <GameStackNav.Screen name="Handoff" component={HandoffScreen} />
      <GameStackNav.Screen name="Game" component={GameScreen} />
      <GameStackNav.Screen name="Result" component={ResultScreen} />
    </GameStackNav.Navigator>
  );
}

function SpotifyStack() {
  return (
    <SpotifyStackNav.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: COLORS.background },
      }}
    >
      <SpotifyStackNav.Screen name="SpotifyConnect" component={SpotifyConnectScreen} />
    </SpotifyStackNav.Navigator>
  );
}

/** Emoji glyph tab icon (the label is the primary cue). */
function GameTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>🎵</Text>;
}

/** Small Spotify-green dot tab icon. */
function SpotifyTabIcon({ focused }: { focused: boolean }) {
  return (
    <View
      style={[
        styles.spotifyDot,
        { opacity: focused ? 1 : 0.6 },
      ]}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
      <GameProvider>
        <NavigationContainer>
          <Tab.Navigator
            screenOptions={{
              headerShown: false,
              tabBarActiveTintColor: COLORS.primary,
              tabBarInactiveTintColor: COLORS.textMuted,
              tabBarStyle: {
                backgroundColor: COLORS.backgroundAlt,
                borderTopColor: COLORS.border,
                borderTopWidth: 1,
                height: 64,
                paddingBottom: 8,
                paddingTop: 6,
              },
              tabBarLabelStyle: { fontSize: 13, fontWeight: '800' },
            }}
          >
            <Tab.Screen
              name="Spiel"
              component={GameStack}
              options={{ tabBarIcon: GameTabIcon }}
            />
            <Tab.Screen
              name="Spotify"
              component={SpotifyStack}
              options={{ tabBarIcon: SpotifyTabIcon }}
            />
          </Tab.Navigator>
        </NavigationContainer>
      </GameProvider>
      </SettingsProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabIcon: { fontSize: 20 },
  spotifyDot: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: SPOTIFY_GREEN,
  },
});
