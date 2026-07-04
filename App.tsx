/**
 * Navigation root.
 *
 * Three themed bottom tabs, each with one clear responsibility:
 *  - "Party" (route name "Mit Freunden", unchanged): the online multiplayer
 *    flow - the app's main mode, so it comes FIRST and is the start tab.
 *  - "Pass & Play" (route name "Hot-Seat", unchanged): the single-device game
 *    flow as a Native Stack (Setup -> Intro -> Handoff -> Game -> Result).
 *  - "Einstellungen": Spotify connection, game rules, app info, data.
 *
 * Only the visible labels were renamed (tabBarLabel); the route names stay to
 * avoid a rename refactor across navigation calls.
 *
 * Stack headers are hidden - each screen renders its own header/safe area.
 */
import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, View } from 'react-native';
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
import TimelineQuizScreen from './src/screens/TimelineQuizScreen';
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
      <OnlineStackNav.Screen name="TimelineQuiz" component={TimelineQuizScreen} />
    </OnlineStackNav.Navigator>
  );
}

/** Emoji glyph tab icons (the label is the primary cue). */
function HotSeatTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>📱</Text>;
}

function PartyTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>🎉</Text>;
}

function SettingsTabIcon({ focused }: { focused: boolean }) {
  return <Text style={[styles.tabIcon, { opacity: focused ? 1 : 0.6 }]}>⚙️</Text>;
}

// Tab-bar sizing. The visible content band (icon + label) is the same on both
// platforms; the bottom safe-area inset is added on top so the labels never
// overlap the home indicator / gesture bar.
//
// We set an explicit height, which makes React Navigation use it verbatim and
// skip its own inset math (verified in @react-navigation/bottom-tabs v7
// getTabBarHeight) — so we add insets.bottom back ourselves, to BOTH height and
// paddingBottom. That is NOT a double inset: the two share the same inset and it
// cancels out of the content band; our paddingBottom also overrides the
// library's default paddingBottom rather than stacking on it.
//
// TABBAR_BOTTOM_GAP is a fixed gap BELOW the labels, needed only on platforms
// without a bottom inset: Android 3-button nav sits flush to the screen edge, so
// 10px keeps the labels off it. On iOS the home-indicator inset already provides
// that separation, so adding the gap on top just inflates the bar (this was the
// "iOS tab bar too tall" bug — one shared value, no platform split). Hence iOS
// drops the gap; Android keeps it. Content band stays 46px on both.
const TABBAR_CONTENT_HEIGHT = 46; // icon (20) + label (13) + breathing room
const TABBAR_TOP_PAD = 8;
const TABBAR_BOTTOM_GAP = Platform.OS === 'ios' ? 0 : 10;

/**
 * The bottom-tab root. Split into its own component so it can read the bottom
 * safe-area inset (useSafeAreaInsets only works *inside* SafeAreaProvider).
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
            height:
              TABBAR_CONTENT_HEIGHT + TABBAR_TOP_PAD + TABBAR_BOTTOM_GAP + insets.bottom,
            paddingTop: TABBAR_TOP_PAD,
            paddingBottom: TABBAR_BOTTOM_GAP + insets.bottom,
          },
          tabBarLabelStyle: { fontSize: 13, fontWeight: '800', marginBottom: 2 },
        }}
      >
        <Tab.Screen
          name="Mit Freunden"
          component={OnlineStack}
          options={{ tabBarIcon: PartyTabIcon, tabBarLabel: 'Party' }}
        />
        <Tab.Screen
          name="Hot-Seat"
          component={GameStack}
          options={{ tabBarIcon: HotSeatTabIcon, tabBarLabel: 'Pass & Play' }}
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
