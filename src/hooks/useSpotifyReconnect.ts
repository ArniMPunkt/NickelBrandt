/**
 * useSpotifyReconnect - when the app returns to the foreground, silently
 * reconnect the Spotify App Remote if it dropped while backgrounded.
 *
 * iOS tears the App Remote connection down whenever our app is suspended (e.g.
 * the host opens the Spotify app, then switches back). Spotify.reconnectIfDropped
 * re-attaches to the already-running Spotify app WITHOUT an interactive app
 * switch (verified against the SDK), so it is safe to run automatically on every
 * foreground. No-op if still connected or if we never connected.
 *
 * Only the device that plays audio needs this (Online host / Pass & Play device),
 * so pass `enabled` accordingly to avoid needless probes on non-host clients.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Spotify from '../services/spotify';

export function useSpotifyReconnect(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        Spotify.reconnectIfDropped().catch(() => {
          // best-effort; status is pushed to subscribers regardless
        });
      }
    });
    return () => sub.remove();
  }, [enabled]);
}
