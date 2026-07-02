/**
 * Navigation root.
 *
 * Three themed bottom tabs, each with one clear responsibility:
 *  - "Hot-Seat": the single-device game flow as a Native Stack
 *    (Setup -> Intro -> Handoff -> Game -> Result).
 *  - "Mit Freunden": the online multiplayer flow.
 *  - "Einstellungen": Spotify connection, game rules, app info, data.
 *
 * Stack headers are hidden - each screen renders its own header/safe area.
 */
import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GameProvider } from './src/context/GameContext';
import { SettingsProvider } from './src/context/SettingsContext';
import { initSpotifyAuth } from './src/services/spotify';
import { initPlayerId, initResumableLobby } from './src/services/supabase';
import OnboardingScreen, { ONBOARDING_KEY } from './src/screens/OnboardingScreen';
import SetupScreen from './src/screens/SetupScreen';
import IntroScreen from './src/screens/IntroScreen';
import HandoffScreen from './src/screens/HandoffScreen';
import GameScreen from './src/screens/GameScreen';
import VictoryScreen from './src/screens/VictoryScreen';
import ResultScreen from './src/screens/ResultScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OnlineHomeScreen from './src/screens/OnlineHomeScreen';
import LobbyScreen from './src/screens/LobbyScreen';
import OnlineIntroScreen from './src/screens/OnlineIntroScreen';
import OnlineGameScreen from './src/screens/OnlineGameScreen';
import BingoGameScreen from './src/screens/BingoGameScreen';
import { COLORS } from './src/theme/colors';
import type { GameStackParamList, OnlineStackParamList } from './src/types/navigation';

const GameStackNav = createNativeStackNavigator<GameStackParamList>();
const OnlineStackNav = createNativeStackNavigator<OnlineStackParamList>();
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
      <GameStackNav.Screen name="Victory" component={VictoryScreen} />
      <GameStackNav.Screen name="Result" component={ResultScreen} />
    </GameStackNav.Navigator>
  );
}

function OnlineStack() {
  return (
    <OnlineStackNav.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: COLORS.background },
      }}
    >
      <OnlineStackNav.Screen name="OnlineHome" component={OnlineHomeScreen} />
      <OnlineStackNav.Screen name="Lobby" component={LobbyScreen} />
      <OnlineStackNav.Screen name="OnlineIntro" component={OnlineIntroScreen} />
      <OnlineStackNav.Screen name="OnlineGame" component={OnlineGameScreen} />
      <OnlineStackNav.Screen name="BingoGame" component={BingoGameScreen} />
    </OnlineStackNav.Navigator>
  );
}

/** Emoji glyph tab icons (the label is the primary cue). */
function HotSeatTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>📱</Text>;
}

function FriendsTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>👥</Text>;
}

function SettingsTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>⚙️</Text>;
}

/**
 * The bottom-tab root. Split into its own component so it can read the bottom
 * safe-area inset (useSafeAreaInsets only works *inside* SafeAreaProvider).
 *
 * We set an explicit tab-bar height, which would otherwise disable React
 * Navigation's automatic safe-area handling — so we add the bottom inset back
 * ourselves. Without this the labels sit in the home-indicator / gesture-bar
 * zone and the OS indicator line cuts through the text.
 */
function RootTabs() {
  const insets = useSafeAreaInsets();
  return (
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
            // Reserve room for the label + icon AND the bottom safe area, so the
            // labels never overlap the home indicator / gesture bar.
            height: 64 + insets.bottom,
            paddingBottom: insets.bottom + 10,
            paddingTop: 8,
          },
          tabBarLabelStyle: { fontSize: 13, fontWeight: '800', marginBottom: 2 },
        }}
      >
        <Tab.Screen name="Hot-Seat" component={GameStack} options={{ tabBarIcon: HotSeatTabIcon }} />
        <Tab.Screen
          name="Mit Freunden"
          component={OnlineStack}
          options={{ tabBarIcon: FriendsTabIcon }}
        />
        <Tab.Screen
          name="Einstellungen"
          component={SettingsScreen}
          options={{ tabBarIcon: SettingsTabIcon }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  // null = still reading the flag; show a plain background (matches the splash) to
  // avoid a flash before we know whether to show onboarding.
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);

  // Load persisted Spotify tokens + online player id from encrypted storage, then
  // check whether the last active lobby is still resumable (player id must be
  // loaded first, so this runs after initPlayerId).
  useEffect(() => {
    initSpotifyAuth().catch(() => {});
    (async () => {
      await initPlayerId().catch(() => {});
      await initResumableLobby().catch(() => {});
    })();
    // First-launch onboarding flag (fail open to the app on any storage error).
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((v) => setOnboardingSeen(v === '1'))
      .catch(() => setOnboardingSeen(true));
  }, []);

  return (
    <SafeAreaProvider>
      <SettingsProvider>
      <GameProvider>
        {onboardingSeen === null ? (
          <View style={styles.loading} />
        ) : !onboardingSeen ? (
          <OnboardingScreen onDone={() => setOnboardingSeen(true)} />
        ) : (
          <RootTabs />
        )}
      </GameProvider>
      </SettingsProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabIcon: { fontSize: 20 },
  loading: { flex: 1, backgroundColor: COLORS.background },
});
