/**
 * Navigation param lists for the game flow:
 *   Setup -> Handoff -> Game -> (Weiter) -> Handoff -> Game (loop) -> Result
 */
export type GameStackParamList = {
  Setup: undefined;
  Intro: undefined;
  Handoff: undefined;
  Game: undefined;
  Result: undefined;
};

export type OnlineStackParamList = {
  OnlineHome: undefined;
  Lobby: { lobbyId: string; code: string };
  OnlineIntro: { lobbyId: string };
  OnlineGame: { lobbyId: string };
};
