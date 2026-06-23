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
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GameProvider } from './src/context/GameContext';
import { SettingsProvider } from './src/context/SettingsContext';
import { initSpotifyAuth } from './src/services/spotify';
import { initPlayerId, initResumableLobby } from './src/services/supabase';
import SetupScreen from './src/screens/SetupScreen';
import IntroScreen from './src/screens/IntroScreen';
import HandoffScreen from './src/screens/HandoffScreen';
import GameScreen from './src/screens/GameScreen';
import ResultScreen from './src/screens/ResultScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OnlineHomeScreen from './src/screens/OnlineHomeScreen';
import LobbyScreen from './src/screens/LobbyScreen';
import OnlineIntroScreen from './src/screens/OnlineIntroScreen';
import OnlineGameScreen from './src/screens/OnlineGameScreen';
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

export default function App() {
  // Load persisted Spotify tokens + online player id from encrypted storage, then
  // check whether the last active lobby is still resumable (player id must be
  // loaded first, so this runs after initPlayerId).
  useEffect(() => {
    initSpotifyAuth().catch(() => {});
    (async () => {
      await initPlayerId().catch(() => {});
      await initResumableLobby().catch(() => {});
    })();
  }, []);

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
              name="Hot-Seat"
              component={GameStack}
              options={{ tabBarIcon: HotSeatTabIcon }}
            />
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
      </GameProvider>
      </SettingsProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabIcon: { fontSize: 20 },
});
