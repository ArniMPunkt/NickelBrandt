# NickelBrandt — Übergabe und Projektstand

Stand: 22.09.2026 · Fassung v3 · Repo-Basis: `279c31b` plus vorhandene lokale Dateien.

Diese Fassung aktualisiert `nickelbrandt_uebergabe_20260922_v2.md` anhand des Repositories. Sie ist als Einstieg für neue Projekt-Chats gedacht. Die Hinweise der v2 wurden geprüft; sie sind keine eigenständigen Arbeitsaufträge. Das Playlist-Import-Konzept bleibt ein separates Backlog-Thema.

**Aussagekraft:** „Im Code vorhanden“ bedeutet durch Lesen nachvollzogen, nicht auf Geräten getestet. Frühere Testbestätigungen aus v2 sind ausdrücklich als solche bezeichnet. Weder der Migrationsstand der produktiven Supabase-Instanz noch Spotify-Logins, Spielabläufe auf Geräten oder Secrets wurden live geprüft. Bei Abweichungen beschreibt dieses Dokument die Implementierung und kennzeichnet offene Produktentscheidungen.

**Wichtige Korrekturen gegenüber v2:**

- In Party wird „Hitster!“ per Button ausgelöst; beim Pass & Play werden die Klauenden am gemeinsamen Gerät ausgewählt.
- Pass & Play hat einen lokalen Spielzustand, braucht aber Supabase zum Laden des Pools und Spotify zur Musikwiedergabe. Eine vollständig offline nutzbare App ist nicht implementiert.
- Es gibt eine persistente Geräte-ID. Es gibt kein geräteübergreifendes Benutzerkonto.
- Das sogenannte Protokoll-Versions-Gate ist eine **nicht blockierende Versionswarnung**.
- Der Katalog enthält **30 Erfolge / 26 Galerie-Kacheln**. „Jahrzehnt-Straße“ und „Big Lobby Winner“ waren falsch beschrieben.
- Die Pipeline umfasst inzwischen ListenBrainz-Anreicherung, einen separaten Review-only-Modus und einen strengen Upload-Vertrag.
- Eine kleinere Cover-Datei spart Bilddaten; allein dadurch sinkt die Zahl der Spotify-Metadaten-Requests nicht.

---

# Zusammenarbeit und Workflow

## Bisherige Konventionen und ihre Grenzen

Die v2 beschreibt: Arni führt alle Terminal-Befehle, Builds und Commits selbst aus; der Coding-Agent erhält strukturierte Anforderungen; fast immer wird zuerst „Schritt 0: nur analysieren und zurückmelden“ beauftragt, danach separat die Umsetzung. Migrationen werden nur als Dateien vorbereitet. Builds erfolgen lokal auf Windows/Android beziehungsweise dem MacBook Air M1/iOS, bewusst ohne EAS-Cloud-Builds. Bei schwieriger SQL-/Nebenläufigkeitslogik wird eine zweite unabhängige Prüfung eingeholt.

**Bewertung:** Analyse vor einer Änderung ist sinnvoll. Eine obligatorische Übergabe nach jeder Analyse verursacht bei klaren Aufgaben aber zusätzliche Schleifen und veraltet schnell, wenn Claude Chat Dateinamen oder technische Lösungen vorgibt, die nicht zum Repository passen. „Arni führt alle Befehle aus“ verhindert zudem, dass der Coding-Agent seine eigene Arbeit zuverlässig überprüft. Dagegen bleiben persönliche Kontrolle über Commits, Releases und produktive Datenbankänderungen gut begründete Grenzen.

Die folgenden Regeln sind ein **Vorschlag für kommende Chats**, keine rückwirkend vereinbarte Änderung aller bisherigen Arbeitsregeln.

## Vorschlag: Aufgabenumfang bestimmt die Zahl der Abstimmungen

| Aufgabe | Vorgehen | Wann zurückfragen? |
| --- | --- | --- |
| Klare Text-/UI-Korrektur, kleiner reproduzierbarer Bug | Kurz im Repo prüfen, beheben, passende Checks, Ergebnis liefern | Nur bei einem Widerspruch oder einer Entscheidung außerhalb des Auftrags |
| Feature mit klarer Zielwirkung, aber mehreren betroffenen Bereichen | Kurzen Plan mitteilen; nach Repo-Prüfung zusammenhängend umsetzen und prüfen | Wenn Produktverhalten oder Umfang tatsächlich offen ist |
| Unklare Fehlerursache | Reproduktion, Logs und betroffene Zustandsübergänge untersuchen | Wenn Beobachtungen fehlen; gezielte Fragen statt spekulativer Umsetzung |
| Neue Architektur, Migration, Synchronisationsmodell | Separate Analyse mit Alternativen, Empfehlung, Risiken und konkretem Entscheidungsbedarf | Vor Umsetzung der noch nicht abgestimmten Architektur |
| Kritische SQL-/Nebenläufigkeitsänderung | Zusätzlich unabhängiges Review und, soweit verfügbar, Tests gegen eine Wegwerf-DB | Vor produktiven Datenänderungen; Code-Lesen allein reicht als Nachweis nicht |

**Schritt 0 bleibt also als Tätigkeit erhalten, aber nur bei Bedarf als eigene Freigaberunde.** Für eine klar beauftragte Umsetzung sollte der Agent nach seiner Untersuchung weiterarbeiten dürfen. Unbekannte Dateinamen oder eine überschaubare Implementierungswahl sind für sich noch kein Grund für einen Stopp.

## Rollen für Claude Chat, Claude Code/Codex und Arni

- **Arni:** Ziel, Priorität und gewünschtes Spielerlebnis; Entscheidungen über offene Spielregeln; Gerätetests; abschließender Commit und Release.
- **Claude Chat:** Produktideen, Gegenbeispiele, Regelvarianten und überprüfbare Akzeptanzkriterien erarbeiten. Technische Vermutungen als Hypothesen formulieren, solange kein aktueller Repo-Nachweis vorliegt.
- **Claude Code oder Codex mit Repo-Zugriff:** Ist-Zustand prüfen, technische Lösung konkretisieren, implementieren, lokal verifizieren und die betroffene Dokumentation aktualisieren.
- **Zweiter Coding-Agent:** Gezielt ein unabhängiges Review des Diffs bei Synchronisation, SQL, Auth oder besonders schwierigen Änderungen. Dafür nicht automatisch jede Kleinigkeit durch zwei Agenten schicken. Bei paralleler Arbeit klare Dateizuständigkeiten oder getrennte Worktrees verwenden.

**Vorgeschlagene Ausführungsgrenzen:** Read-only-Recherche, lokale Code-/Doku-Änderungen, Typecheck und passende isolierte Tests kann der Coding-Agent selbst erledigen. Native Builds nach der im jeweiligen Chat vereinbarten Zuständigkeit, weiterhin lokal. Commits und Releases bleiben bei Arni. Migrationen nur als Datei; produktive Migrationen, Pool-Uploads und andere echte Datenänderungen brauchen einen konkreten Auftrag. Die hier gezeigten Pipeline-Befehle dokumentieren den Betrieb und lösen keinen Upload aus.

## Übergabe zwischen Produkt-Chat und Coding-Chat

Ein Feature-Brief sollte enthalten:

1. **Ziel und Beispiel:** Wer tut was, was soll vorher/nachher passieren?
2. **Geltungsbereich:** Party-Hitster, Pass & Play, Bingo, Timeline-Quiz, Profil oder Pipeline.
3. **Akzeptanzkriterien:** Sichtbares Verhalten und relevante Randfälle, insbesondere mehrere Geräte, Abbruch, Rematch und alte Daten.
4. **Nicht-Ziele und Grenzen:** Was gehört nicht dazu? Dürfen Migrationen vorbereitet werden?
5. **Offene Entscheidungen:** Was muss Arni entscheiden, was darf der Coding-Agent selbst konkretisieren?
6. **Prüfung:** Automatisierbare Checks und nötige manuelle Geräte-/Mehrspieler-Tests.

Der Coding-Agent ergänzt betroffene Dateien und einen belastbaren Umsetzungsplan nach der Repo-Prüfung. Sein Abschluss enthält Änderungen, tatsächlich ausgeführte Checks, verbleibende Grenzen und höchstens die wirklich offenen Entscheidungen.

**Startvorlage für einen neuen Coding-Chat:**

> Lies die aktuelle Übergabe und prüfe den betroffenen Code. Ziel: [Feature/Zielwirkung]. Geltungsbereich: [Modi]. Akzeptanzkriterien: [konkrete Fälle]. Analysiere kurz und setze den klar definierten Umfang anschließend um; halte nur bei offenen Produktentscheidungen, widersprüchlichen Anforderungen oder einer wesentlichen Architekturerweiterung an. Führe passende lokale Checks selbst aus und dokumentiere Geräte-/Live-Tests, die noch fehlen. Keine produktiven Datenänderungen; Supabase-Migrationen nur als Datei. Kein Commit am Ende — Arni committet selbst nach Prüfung/Test.

Für einen reinen Konzeptauftrag wird „setze … um“ durch „liefere Optionen und eine Empfehlung; noch keine Implementierung“ ersetzt.

**Dokumentationspflege:** Die Übergabe beschreibt den aktuellen Stand. Feature-Briefs und Spezialkonzepte können separat unter `docs/` liegen; die Übergabe verlinkt sie. Status möglichst als „geplant“, „implementiert“, „lokal geprüft“, „auf Gerät getestet“ oder „produktiv eingespielt“ benennen. Ein grüner Typecheck ist kein Spieltest. Der allgemeine Teil von `README.md` beschreibt noch den alten Spotify-Spike und ist für den App-Funktionsumfang nicht maßgeblich; der Abschnitt „Songpool Scripts“ ist wesentlich aktueller.

---

# Kapitel 1: Die App und die Spiele

NickelBrandt setzt das Musik-Zeitlinienprinzip von Hitster als private App für den Freundeskreis um. Haupt-Tabs: **Party**, **Pass & Play** und **Profil**. Spotify spielt auf dem Host-Gerät beziehungsweise dem gemeinsamen Pass-&-Play-Gerät; Party-Mitspieler benötigen keine eigene Spotify-Verbindung.

## Einstieg, Songpool und Spielregeln

Beim ersten Start gibt es ein überspringbares Onboarding mit drei Seiten; der Abschluss wird lokal gespeichert. In `OnboardingScreen.tsx` stehen noch die älteren Begriffe „Hot-Seat“ und „Mit Freunden“ sowie „Hitster rufen“. Diese Texte sind gegenüber den aktuellen Tabs und der Button-Bedienung überarbeitungsbedürftig; bei dieser Doku-Prüfung wurde kein App-Code geändert.

Die derzeit einzige spielbare Deckquelle sind kuratierte Supabase-Themenpools. `PlaylistPickerScreen.tsx` heißt historisch so, bietet aber keinen aktiven Spotify-Playlist-Import. Poolname, Beschreibung und optionales Icon werden angezeigt. Icons kommen aus dem Bucket `pool-icons`, laut bisheriger Projektkonvention 168×168 px WebP/PNG, manueller Upload durch Arni; ohne Icon erscheint ein Musik-Glyph.

Setup und Lobby enthalten die Spielregeln direkt. Startvoraussetzungen werden als Checkliste angezeigt. Party benötigt mindestens zwei Spieler und einen ausgewählten Pool. Die Spotify-Bereitschaft wird beim Start per `ensureReadyToPlay()` geprüft und gegebenenfalls durch stillen Reconnect wiederhergestellt.

**Gemeinsame Hitster-Einstellungen** aus `SettingsContext.tsx` / `GameRulesSection.tsx`:

| Einstellung | Aktueller Bereich / Default | Wirkung |
| --- | --- | --- |
| Karten zum Gewinnen | 5–20 / 10 | Siegschwelle berücksichtigt die Startkarte |
| Cover erst nach Aufdeckung zeigen | an | Verbirgt Songinformationen in der App bis zur Aufdeckung |
| Nickel & Hitster-Rufe | an | Master-Schalter für Nickel, Klauen und Nickel-Aktionen |
| Nickel-Obergrenze | **aus**, gespeicherter Grenzwert 5 | Eingeschaltet auf 5–10 einstellbar; alte Spielstände ohne Konfiguration fallen auf 5 zurück |
| Karte überspringen | aus / Kosten 1 | Kosten 1–3; aktuelle Karte verwerfen und Ersatz ziehen |
| Karte ohne Raten ziehen | aus / Kosten 3 | Kosten 3–5; richtig einsortieren und Zug beenden, **kein Siegpunkt**, keine Änderung der eigenen Platzierungsserie |
| Musik-Timer | aus / 60 s | 30–120 s; stoppt Musik, Raten bleibt erlaubt |
| Mehrfaches Hitstern | aus | Getrennter Schalter in Party-Lobby und Pass-&-Play-Setup |

Die allgemeinen Hitster-Regeln sind zunächst gerätelokal im Speicher. In Party kopiert der Host sie beim Spielstart in `game_state`. Dagegen werden `game_mode` und `mode_config` bereits in der Lobby synchronisiert. Nicht alle lokalen Settings sind deshalb vor dem Start auf jedem Gerät identisch.

## Party: Lobby und gemeinsame Funktionen

Sechsstelliger Lobby-Code, Supabase Realtime für Lobby, Spieler und simultane Antworten. Der Host startet und beendet die Lobby; Spieler können sie verlassen. Über die gespeicherte letzte Lobby und Geräte-ID kann die App nach einem Neustart eine noch aktive Lobby wieder anbieten.

**Versionswarnung:** `lobby_players.app_version` wird beim Erstellen/Beitreten aus `Constants.expoConfig.version` gesetzt (Migration 011). Unterschiedliche Werte, einschließlich „unbekannt“ für fehlende Werte, erzeugen einen Hinweis. **Der Start bleibt möglich.** Es gibt kein separates Protokollversionsfeld und keinen harten Kompatibilitätscheck; unterschiedliche Builds mit derselben App-Versionsnummer werden so nicht unterschieden.

**Overflow-Menü:** `HeaderMenu` bündelt je nach Modus/Rolle Play/Pause, Song melden, Nickel korrigieren, Lobbycode, Kartenzähler und Verlassen/Beenden. Nickel-Einträge betreffen Hitster.

**Rematch:** „Nochmal spielen“ ist Host-only, verwendet denselben Lobby-Code und lässt die Mitspieler in der Lobby. Bei Pass & Play führt ein neues Spiel dagegen zurück zum lokalen Setup.

**Song melden:** Live über das Menü und nachträglich aus der Match-Statistik, auch in Pass & Play. Host beziehungsweise Geräteinhaber melden einen Song mit einem von vier Gründen: `wrong_year`, `wrong_title_artist`, `not_in_pool`, `other`; kein Freitext. Das ist ein Eintrag in `song_reports`, keine automatische Datenkorrektur. Arni prüft die Meldungen im Dashboard.

## Hitster (Party)

Song hören, Karte in die eigene Zeitlinie einordnen. Jeder Spieler beginnt mit einer Startkarte und zwei Nickel. Eine erfolgreiche eigene Platzierung oder ein erfolgreicher Klau erhöht den `score`; die Startkarte zählt nicht zum Score.

**Sieg:** `score >= cardsToWin - 1`. Bei Ziel 10 sind also neun erspielte Punkte plus Startkarte erforderlich. Die vorhandene Anzeige `{score} / {cardsToWin} richtig platziert` hat damit einen anderen Nenner als die Punktschwelle. Das ist ein noch zu klärender UI-Wortlaut, kein Anlass, die behobene Sieglogik wieder um eins zu verschieben. Gekaufte Blind-Karten zählen ebenfalls nicht zum Score. Skip und Blind-Draw sind ab `score >= cardsToWin - 2` gesperrt.

**Hitstern:** Nach der Platzierung drücken berechtigte Mitspieler auf ihrem Gerät **„Hitster!“**, um einen Klauversuch anzumelden. Das reguläre Fenster beträgt **8 Sekunden** (`STEAL_WINDOW_MS`); ein „Kein Hitster“ kann den Ablauf verkürzen, wenn alle entschieden haben. Der Klauende wählt eine andere Lücke **auf der Zeitlinie des aktiven Spielers**. Er darf die Karte nur behalten, wenn dessen ursprüngliche Platzierung falsch und sein eigener Versuch richtig ist. Bei gleichen Jahren können mehrere Lücken korrekt sein; eine bereits korrekte Originalplatzierung bleibt geschützt.

Fehlschlag-Texte: „{Name} hat sich verBrandt.“ beziehungsweise „Beide haben sich verBrandt.“. Die „Brandt“-Serie zählt eigene korrekte Platzierungen in Folge, nicht erfolgreiche Klauversuche.

**Mehrfaches Hitstern:** `mode_config.hitsterMultiSteal` wird beim Start zu `game_state.multiStealEnabled`. Während des Fensters werden Anmeldungen nach `queuedAt = serverNow()` sortiert. `hitsterQueueVersion` schützt konkurrierende Queue-Änderungen. Nach dem Fenster setzen die Angemeldeten nacheinander, ohne eigenes Platzierungs-Zeitlimit. Der erste muss setzen; spätere Spieler sehen bereits belegte Lücken und dürfen kostenlos abbrechen. Nickel kostet erst das tatsächliche Setzen. Die gemeinsame Auflösung folgt nach Abschluss aller Versuche: Bei falscher Originalplatzierung gewinnt der erste korrekte Versuch in Queue-Reihenfolge. Ist die Originalplatzierung korrekt, bleibt die Karte beim aktiven Spieler. Ohne erfolgreichen Klau wird die Originalplatzierung regulär gewertet. Laut v2 ist Party-Mehrfach-Hitstern bereits im Spiel getestet.

**Nickel-Vergabe:** Titel **und** Interpret richtig erraten; der Host bestätigt das Ergebnis, es gibt keine automatische Spracherkennung. Der Master-Schalter deaktiviert das gesamte Nickel-/Klau-System, nicht nur Anzeigen.

**Manuelle Korrektur:** Host kann Nickel über das Menü korrigieren. Kein zusätzlicher Nickel-Statistikeintrag; der Höchststand für Erfolge kann dennoch steigen. Update mit Vergleich des vorherigen Chipwerts (`.eq('chips', aktuellerWert)`), bei Konflikt Hinweis statt stillem Überschreiben. Parallelkorrekturen laut v2 getestet.

**Offen:** Die Siegkartenzahl ist ein fester 5–20-Slider, nicht dynamisch aus Poolgröße/Jahresspanne abgeleitet. Eine entsprechende Erweiterung ist ein Backlog-Wunsch, kein vorhandenes Feature.

## Bingo (Party)

Eigenes Board pro Spieler, 4×4 oder 5×5. Vollständige Reihe, Spalte oder Diagonale gewinnt; mehrere Gewinner derselben Auswertung sind möglich.

| Farbe/Kategorie | Easy | Hard |
| --- | --- | --- |
| Cyan: Jahrzehnt | Jahrzehnt wählen | Jahrzehnt wählen |
| Pink: zeitliche Einordnung | Vor/ab 2000 | Jahr ±2 |
| Orange: Jahr schätzen | Jahr ±3 | Exaktes Jahr |
| Grün: Interpret/Titel | Interpret | Interpret und Titel |
| Violett: Gruppe oder Solo | Host legt gemeinsame Wahrheit fest | Ebenso |

Das Rad wird vom vorgesehenen Spieler ausgelöst, indem er die Scheibe mit dem Finger anwischt/anschnippt; ein Tipp-Button bleibt als Fallback daneben stehen. Nach 20 Sekunden dürfen auch andere auslösen. Stärke und Richtung der Geste beeinflussen nur die Animation (Richtung, Umdrehungen, Auslaufen) — das Ergebnis steht vorher fest und ist auf allen Geräten identisch. Auf die synchronisierte Animation (4,5 s) folgt der Countdown (2 s). Song-/Antwortzeit: 30–75 Sekunden, Default 30. Die Schwierigkeit ist Easy/Hard; ein zusätzliches „Expert Mode“-Feature existiert nicht.

Optional, per Lobby-Schalter und standardmäßig aus: „Schnellschluss“. Sobald der erste Spieler geantwortet hat, bleiben allen anderen höchstens 10 Sekunden; waren ohnehin weniger übrig, ändert sich nichts. Nur ab 45 Sekunden Song-Zeit wählbar — fällt die Song-Zeit darunter, schaltet sich die Option mit ab. Technisch wird die geteilte `roundDeadline` einmalig gekappt (Guard `bingoRushArmedAt`), die Auswertungslogik bleibt unberührt.

Titel-/Interpretenantworten bewertet der Host je Spieler. Gruppe/Solo braucht eine gemeinsame Host-Entscheidung, optional unterstützt durch einen MusicBrainz-Vorschlag. Die Review-Phase hat 30 Sekunden; bei fehlendem Host-Urteil gelten implementierte Vertrauens-Fallbacks: nichtleerer Titel-/Interpretentext beziehungsweise eine abgegebene Gruppe-/Solo-Antwort werden als richtig gewertet.

Nach richtiger Antwort wählt der Spieler ein freies Feld der gezogenen Farbe. Dafür gibt es 10 Sekunden, danach automatische Auswahl durch den eigenen Client. Ist die Farbe schon voll, bleibt die Antwort richtig, bringt aber keine Markierung. Die Statistik zeigt das finale Board jedes Spielers. Kein Nickel, kein Klauen. Sieganimation mit 1,3 Sekunden Ruhephase laut bisherigem Projektstand.

## Timeline-Quiz (Party)

Alle platzieren denselben Song unabhängig auf einer gemeinsam wachsenden Zeitlinie. Startbasis sind zehn reine Jahresmarken aus dem Zeitraum des Pools; pro Runde kommt der aufgelöste Song hinzu. Antwortfenster 30 Sekunden. Ein korrekter Slot gibt einen Punkt; nicht abgegebene Antworten zählen als falsch.

Nach der konfigurierten, auf den verfügbaren Stapel begrenzten Rundenzahl gewinnt der höchste Punktestand; Gleichstand erlaubt gemeinsame Gewinner. Kein Nickel, kein Klauen. Statistik: richtig/falsch plus Songdetails.

## Match-Statistik

Spielerweise aufklappbar:

- Hitster: richtig, falsch, geklaut, verBrandt und Nickel.
- Bingo: erfüllt/nicht erfüllt plus finales Board.
- Timeline-Quiz: richtig/falsch.

Die Daten entstehen aus Match-Ereignissen und sind von der dauerhaften Profilstatistik zu unterscheiden. Neue Erfolge werden nach der Partie angezeigt; für den ersten Erfolg oder bestimmte hohe Stufen gibt es zusätzlich eine besondere Einblendung.

## Pass & Play

Hitster mit mehreren Menschen an einem gemeinsamen Gerät. Lokaler Reducer in `GameContext.tsx`; keine Party-Lobby und keine laufende Multiplayer-Synchronisation. Startkarten-/Introansicht, Übergabe-Screen, Spiel, Siegansicht und anschließend `ResultScreen.tsx` mit Spieler-Statistik, Songdetails und Meldefunktion sind vorhanden. Bingo und Timeline-Quiz gibt es hier nicht.

**Netzbedarf:** Poolauswahl und Deckladen verwenden Supabase. Wiedergabe und Cover verwenden Spotify; Songmeldungen Supabase. Der lokale Reducer ist keine Zusage für einen vollständig offline verfügbaren Ablauf.

**Mehrfaches Hitstern:** Auswahl der Klauenden am gemeinsamen Gerät in Antipp-Reihenfolge. Erster muss setzen, spätere dürfen bei kumulativ gesperrten Positionen abbrechen. Versuche werden im Unterschied zur Party einzeln sofort aufgelöst. Die Settings sind getrennt verdrahtet: lokal `SettingsContext.hitsterMultiSteal`, Party `ModeConfig.hitsterMultiSteal`; keine gemeinsame synchronisierte Toggle-Quelle. Beide Schalter stehen bewusst außerhalb von `GameRulesSection`.

**Teststatus aus v2:** Implementiert und seinerzeit Typecheck grün; Simulator-/Gerätetest noch offen. Besonders prüfen: ein möglicher Klauender trotz aktiviertem Mehrfach-Toggle, Reihenfolge, Abbruch ab dem zweiten Versuch und Gleichjahresfälle.

**Pool-Fortschritt:** `poolProgress.ts` speichert gezogene Track-IDs pro Pool in AsyncStorage. Startkarten und gezogene Karten gelten sofort als gespielt, auch bei später abgebrochener Partie. Der Pool-Picker zeigt „X/Y verbleibend“ und einen Reset pro Pool. Neue Spiele bevorzugen ungespielte Songs. Bleiben weniger als Spielerzahl + 1 übrig, wird genau dieser Pool mit Hinweis zurückgesetzt. Party benutzt diese Ausschlussliste nicht.

**Persistenzgrenze:** Die verbrauchten Song-IDs überleben App-Neustarts. Reihenfolge des verbleibenden Stapels und laufende Pass-&-Play-Partie werden nicht persistent gespeichert. Der alte Backlog-Punkt war daher zu ungenau: Wiederholungsvermeidung ist vorhanden; eine exakte Wiederaufnahme der Partie nicht.

## Profil

- Spielername dauerhaft in AsyncStorage, für neue Eingaben vorausgefüllt.
- Spotify verbinden/trennen, Verbindungsstatus und Fehlertexte.
- App-Version sowie auf iOS vorhandene native Crash-Diagnose.
- Statistik-/Erfolge-Ansicht, Meilenstein als Profil-Titel.
- Erfolge-Galerie in zwei Abschnitten: „Errungen“ (nach Erreichungsdatum, neueste zuerst) und „Offen“ (Katalogreihenfolge). Jede Kachel ist antippbar und öffnet eine Detailansicht mit Name, Icon, Modus-Zuordnung und vollständigem Kriterium — auch bei noch nicht erreichten Erfolgen. Die beiden zusammengefassten Gruppen zeigen dort alle drei Stufen einzeln mit eigenem Status. Wo ein dauerhaft gespeicherter Zähler existiert, kommt ein Fortschrittsbalken dazu (12 der 25 Erfolge); die übrigen sind entweder binär oder hängen an der gekappten `matchHistory` — siehe offene Punkte.
- Funktionsfähiger Reset für Statistiken **und** Erfolge mit Bestätigung.

Kein Konto und kein geräteübergreifender Sync. Party verwendet eine in SecureStore persistierte zufällige `player_id` pro Installation; die Lobby-Mitgliedschaft ist eine eigene Zeile. Profil und Party greifen auf dieselbe Geräteidentität zurück.

**Profilzählung:** Party erfasst den Spieler dieses Geräts; Pass & Play erfasst alle lokalen Spieler in einem gemeinsamen Geräteprofil. Daher sind Pass-&-Play-Erfolge nicht einer dauerhaften natürlichen Person zugeordnet. Die Siegesstatistik für Hitster zählt ausdrücklich nur Party-Siege des eigenen Spielers. `matchHistory` hält maximal 200 detaillierte Partien; bereits aggregierte Zähler und freigeschaltete Erfolge bleiben erhalten. Die Speicherung erfolgt am Match-Ende, nicht rückwirkend für alte Partien. Doppelte Aufrufe verhindert derzeit der jeweilige Screen; `recordMatchResult()` selbst besitzt keinen Match-ID-basierten Duplikatschutz.

### Vollständiger Erfolgskatalog

Quelle: `src/services/achievementDefinitions.ts`. **30 Definitionen**, durch Zusammenfassung der drei Nickel-Stufen und drei Partien-Meilensteine **26 Galerie-Kacheln**.

| Nr. | Erfolg | Implementierte Bedingung |
| --- | --- | --- |
| 1 | Erste Partie | Mindestens eine Partie |
| 2 | Total daneben | Falsche Platzierung/Klau mindestens 40 Jahre von der nächstliegenden endlichen Lückengrenze entfernt |
| 3 | Perfect Hit | Korrekt zwischen zwei Jahren mit Abstand 2, genau das Jahr dazwischen |
| 4 | Insane Guess | Genau das Jahr zwischen zwei gleichen Jahreszahlen |
| 5 | Hot Hot Streak | 7 eigene Platzierungen in Folge richtig |
| 6 | Hot Hot Hot Streak | 8 eigene Platzierungen in Folge richtig |
| 7 | Perfect Game | 9 eigene Platzierungen in Folge richtig |
| 8 | Total Verbrandt | 3 erfolglose Klauversuche desselben erfassten Spielers in einer Partie |
| 9 | Double Hitster | Erfolgreicher Klau desselben Spielers in 2 direkt aufeinanderfolgenden Runden |
| 10 | Triple Hitster | Wie zuvor, 3 Runden |
| 11 | Kleine Straße | 4 Karten in einer lückenlosen Jahresfolge; gleiche Jahre verlängern die Folge |
| 12 | Große Straße | Wie zuvor, 5 Karten |
| 13 | Jahrzehnt-Straße | **4 benachbarte Karten desselben Jahrzehnts** |
| 14 | Nickelfarmer | Höchststand mindestens 5 Nickel |
| 15 | Nickelmeister | Höchststand mindestens 8 Nickel |
| 16 | Nickelgott | Höchststand mindestens 12 Nickel |
| 17 | Diszipliniert | Party-Hitster-Sieg bei eingeschaltetem Nickel-System, ohne selbst einen Nickel erhalten und ohne erfolgreichen eigenen Klau. Nur Party (Pass & Play kennt kein eindeutiges „ich"). Alte Datensätze ohne die Felder `chipsEnabled`/`receivedNickel` zählen nicht |
| 18 | Poolversenker | Ein Songpool in Pass & Play einmal komplett durchgespielt (`stats.poolsCleared`) |
| 19 | Perfect Bingo | Easy-Sieg in genau so vielen Runden wie die Board-Kantenlänge |
| 20 | Perfect Bingo (Hard Edition) | Entsprechender Hard-Sieg |
| 21 | Sad Bingo | Richtig geantwortet, Farbe war bereits voll |
| 22 | Perfect Timeline | Mindestens eine gewertete Runde, ganze Partie ohne Fehler |
| 23 | Punktlandung Marathon | Fehlerfreie Timeline-Quiz-Partie über **mindestens 20 Runden** (Kartenzahl-Slider: 5–30, Default 15) |
| 24 | Warmgespielt | Mindestens 10 Partien |
| 25 | Dauergast | Mindestens 50 Partien |
| 26 | Partyleiter | Mindestens 100 Partien |
| 27 | Alle 4 Modi | Party-Hitster, Pass & Play, Bingo, Timeline-Quiz jeweils gespielt |
| 28 | Big Lobby Winner | Sieg mit **mindestens 6** Teilnehmern |
| 29 | Nachtschwärmer | Partie zwischen 0:00 und 4:59 **lokaler** Zeit beendet (`playedAt` ist UTC, `Date#getHours()` rechnet in die Gerätezone) |
| 30 | Vielspieler-Abend | 5 Partien an einem lokalen Kalendertag |

„Nickelbrandt Profi“ ist kein aktueller Definitionsname. „Warmgespielt“ ist die Zehn-Partien-Stufe. Big Lobby Winner nutzt die Teilnehmerzahl bei Match-Ende. Nickelgott ist mit aktivierter Obergrenze von maximal 10 nicht erreichbar. `chipsPeak` wird während der Partie mitgeführt, nicht aus dem Endstand geschätzt. Double/Triple Hitster beruhen auf der Reihenfolge der Runden-Ereignisse; eine dazwischenliegende Runde ohne erfolgreichen Klau setzt die Serie zurück.

**Für die neuen Erfolge zusätzlich erfasst:** `HitsterMatchInput.chipsEnabled` (war das Nickel-System an?), `HitsterPlayerResult.receivedNickel` (aus den `nickel`-Ereignissen des vollen Match-Logs, die die schlanke Ereignisliste weiterhin verwirft) und `stats.poolsCleared`. Letzteres schreibt `markPoolCleared()` beim Spielstart, sobald `SetupScreen` einen erschöpften Pool zurücksetzt — das ist der Moment, den die App selbst „Pool durchgespielt" nennt. Freigeschaltet wird trotzdem erst beim nächsten `recordMatchResult()`, also am Ende genau der Partie, die gerade startet; es gibt weiterhin nur einen Ort, an dem Erfolge freigeschaltet werden. Alle drei Felder sind optional — Altbestände gelten als „nicht nachweisbar" und schalten nichts frei.

**Technische Feinheit für künftige Reviews:** Die Bedingungen von Total daneben/Perfect Hit/Insane Guess lesen alle gespeicherten Hitster-Ereignisse; Party übergibt das vollständige Match-Log. Diese drei Checks filtern aktuell nicht ausdrücklich auf den eigenen Spieler. Die Aussage „ausschließlich meine Leistung“ wäre deshalb für diese Erfolge nicht abgesichert. Hier dokumentiert, nicht stillschweigend als App-Fix mit umgesetzt.

---

# Kapitel 2: Architektur und Betrieb

## Laufzeit und zentrale Dateien

Expo SDK 54, React Native 0.81.5, React 19, TypeScript; `newArchEnabled: false` wegen der Spotify-Bridge. Native Development-/Release-Builds, kein Expo-Go-Betrieb der nativen Spotify-Anbindung.

| Bereich | Einstieg |
| --- | --- |
| Navigation, App-Start, Provider, Onboarding | `App.tsx` |
| Lokale Regeln / Pass-&-Play-Spielzustand | `src/context/SettingsContext.tsx`, `GameContext.tsx` |
| Party-Service und bedingte DB-Schreibvorgänge | `src/services/supabase.ts` |
| Zustandsverträge | `src/types/game.ts`, `src/types/online.ts` |
| Reine Karten-, Bingo-, Quiz- und Statistiklogik | `src/game/` |
| Spotify / Reconnect | `src/services/spotify.ts`, `src/hooks/useSpotifyReconnect.ts` |
| Poolzugriff und lokaler Verbrauch | `src/services/deck.ts`, `poolProgress.ts` |
| Profil und Erfolge | `src/services/achievements.ts`, `achievementDefinitions.ts` |
| Tabellen und Rechte | `supabase/migrations/` |
| Externe Song-Kuration | `scripts/`, `test/` |

Party und Pass & Play haben getrennte Zustandsmaschinen. Features mit gemeinsamer Spielregel müssen meist in beiden implementiert werden, einschließlich Screens und Statistikpfaden. Wiederverwendbare reine Hilfsfunktionen wie Platzierungsprüfung, Nachbarjahre und Statistikaufbereitung reduzieren Abweichungen.

**Wichtig zur Serverrolle:** Party speichert Zustand in Supabase, aber die Regelauswertung läuft überwiegend in den Clients in `supabase.ts`. Es gibt keinen separaten autoritativen Spielserver, der jede Spielaktion prüft. Die Datenbank schützt bestimmte konkurrierende Writes per Bedingungen/Constraints.

## Supabase: Schema der vorhandenen App

Übersicht aus Migrationen 001–011; kein Nachweis, welche Migrationen bereits auf der echten Instanz ausgeführt wurden. Die vorbereiteten Dateien 012/013 gehören ausschließlich zum separaten Playlist-Import-Backlog.

| Objekt | Wesentliche Felder / Zweck |
| --- | --- |
| `lobbies` | `id, code, host_id, status, created_at, game_state, game_mode, mode_config` |
| `lobby_players` | `id, lobby_id, player_name, player_id, is_host, joined_at, score, chips, timeline, current_streak, max_brandt_streak, bingo_board, app_version` |
| `round_answers` | `id, lobby_id, round_number, player_id, answer, submitted_at`; UNIQUE auf Lobby/Runde/Spieler |
| `song_pools` | `id, name, description, created_at, icon_url` |
| `pool_songs` | `id, pool_id, title, artist, spotify_track_id, release_year, isrc, created_at`; UNIQUE auf Pool/Spotify-Track |
| `song_reports` | Song-/Quell-/Modus-Snapshot plus Meldegrund; App darf einfügen |
| `crash_reports` | App-/Build-/Geräte-/OS-Daten, Exception-Name/-Grund und Stacktrace; App darf einfügen |
| Storage `pool-icons` | Öffentliche Pool-Icons, URL im Pooldatensatz |

Kein Unique-Constraint auf ISRC: verschiedene Spotify-Versionen können dieselbe ISRC teilen. `pool_songs` hat neben dem Pool-Index auch die durch den Unique-Constraint erzeugte Eindeutigkeit für Pool/Track.

**Rechte:** Spieltabellen haben bewusst offene Prototyp-RLS-Regeln für den Freundeskreis. Geräte-ID und Host-Prüfungen im Client sind keine serverseitige Benutzer-Authentifizierung. Pools sind für App-Clients lesbar, vom externen Skript mit Service Role beschreibbar. Song- und Crashmeldungen sind aus der App INSERT-only. Dieser Befund gehört zur vorhandenen Architektur; er ist kein hiermit beauftragtes Security-Umbauprojekt.

**`game_state` ist eine JSONB-Spalte**, keine separate Menge SQL-Spalten pro Modus. Der Typvertrag steht in `OnlineGameState`:

| Bereich | Zentrale JSON-Schlüssel |
| --- | --- |
| Gemeinsam / Hitster | `deck, currentCard, activePlayerId, phase, turnOrder, cardsToWin, winnerId`, Regel-Snapshots, `sourceId, sourceName, turnStartedAt` |
| Platzieren / Klauen | `pendingInsertIndex, lastResult, hitsterCallerId, passedHitster, stealResult, stealEqualYear, multiStealEnabled, hitsterQueue, hitsterQueueVersion, chipsPeak, statsHistory` |
| Simultane Runden | `gameMode, modeConfig, roundNumber, roundDeadline, roundPhase, roundResults, resolveClaimId, resolveClaimedAt` |
| Bingo | `bingoRound, bingoDecades, bingoYearMin, bingoYearMax, spinnerId, spinArmedAt, spinStartedAt, reviewDeadline, reviewVerdicts, reviewTruthGroup, pickDeadline, expectedMarks, bingoStatsHistory, winnerIds` |
| Timeline-Quiz | `quizTimeline, quizTotalRounds, quizStatsHistory, winnerIds` |

`lobbies.mode_config` enthält `bingoGridSize, bingoDifficulty, bingoSongSeconds, timelineCardCount, hitsterMultiSteal`; beim Start entsteht ein Snapshot für die Partie.

## Nebenläufigkeit, Realtime und Zeit

**Bedingtes Update / Atomic Claim:** Read-then-conditional-Update mit erwarteter Phase, Runde, Claim-ID oder einem Versionswert im Filter. Nur ein passender Write gewinnt; eine leere Ergebnisliste bedeutet, dass der beobachtete Zustand nicht mehr aktuell war. Beispiele: Hitster-Fenster, Queue-Anmeldung, Rundenauflösung, Rematch und Bingo-Review. Nicht pauschal jeder DB-Write verwendet dasselbe Muster.

Ein Claim macht mehrere nachfolgende Tabellenupdates nicht automatisch zu einer Datenbanktransaktion. Insbesondere schreibt Hitster anschließend auch Spielerwerte. Bei neuen kritischen Pfaden deshalb neben konkurrierenden Aufrufen immer einen Abbruch zwischen den Writes betrachten.

**Simultanauflösung:** `resolveClaimId` / `resolveClaimedAt` erlauben nach 15 Sekunden eine erneute Übernahme eines steckengebliebenen Claims. Der abschließende Write prüft das Claim-Token, damit ein verspäteter früherer Bearbeiter keine neuere Auflösung überschreibt.

**Antworten:** `round_answers` speichert pro Spieler eine eigene Zeile, statt konkurrierende Antworten in dieselbe JSON-Map zu schreiben. Der Unique-Constraint verhindert doppelte Antworten derselben Runde.

**Statistikereignisse:** Append-only innerhalb des jeweiligen Match-Logs; konkurrierende Auflösungen sollen nur über den Claim-Gewinner Ereignisse hinzufügen. Optionale Felder brauchen für ältere Zustände `?? []` beziehungsweise passende Defaults.

**Manuelle Nickel-Korrektur:** Optimistischer Vergleich des vorherigen Chipwerts; kein blindes Last-write-wins.

**Realtime:** `postgres_changes` für Lobby, Spieler und Rundenantworten. Eindeutige Channel-Namen vermeiden Konflikte zwischen mehreren/erneuten Subscriptions. Songpools sind statische Referenzdaten ohne eigene Realtime-Veröffentlichung.

**Zeitbasis:** `syncServerClock()` schätzt den Offset anhand des HTTP-Date-Headers eines Supabase-HEAD-Requests mit Latenzkorrektur. `serverNow()` ist lokale Zeit plus Offset, keine vom Server signierte Aktionszeit. Ohne erfolgreiche Synchronisation wird die lokale Uhr verwendet. Geteilte Deadlines müssen dieselbe Zeitbasis verwenden; der gemeinsame `TurnCountdown` benutzt sie auch für den lokalen Pass-&-Play-Musiktimer.

## Spotify und Cover

**App-Authentifizierung:** PKCE-Login und Refresh-Token in SecureStore, kombiniert mit der nativen App-Remote-Anbindung für Wiedergabe. Spotify-App muss installiert sein; das Wiedergabegerät benötigt Premium. Mitspieler steuern keinen eigenen Musikstream. Ereignisbasierter Verbindungsstatus, stiller Reconnect, App-Wakeup und `ensureReadyToPlay()` sollen abgerissene Verbindungen auffangen. Historische iOS-/Android-Verbindungsfixes aus v2 bleiben Teil des Projektstands, sind hier nicht neu auf Geräten getestet.

**Tatsächlich direkt im App-Service genutzte HTTP-Endpunkte:**

| Endpoint | Verwendung |
| --- | --- |
| `https://accounts.spotify.com/authorize` | Browser-/SDK-Autorisierung |
| `POST https://accounts.spotify.com/api/token` | Code-Tausch und Refresh |
| `GET https://api.spotify.com/v1/me` | Anzeigename des verbundenen Spotify-Nutzers; Fehler liefern zugleich Hinweise auf fehlenden Web-API-Zugriff |
| `GET https://api.spotify.com/v1/tracks/{id}` | Cover pro Track |

Wiedergabe, Pause/Fortsetzen und Player-Status laufen über App Remote; der App-Code benutzt dafür keine eigene `/me/player`-REST-Steuerung. Playlist-Endpunkte aus früheren Recherchen sind keine aktuellen App-Aufrufe. Die externen Skripte haben ihre eigenen Spotify-Auth-/Such-/Playlist-Pfade.

**Cover-Ladeweg:** Die Pools speichern keine Cover. `loadDeckSource()` lädt die Karten ohne Spotify-Metadatenanreicherung; der Startpfad lädt nur dringende erste Cover, der Rest folgt im Hintergrund. In-Memory-Cache, maximal sechs parallele Requests, Verarbeitung in Blöcken von 24. Bei zwei langen 429-`Retry-After`-Antworten über 30 Sekunden bricht der Circuit Breaker den weiteren Coverlauf ab. Fallback-Karten bleiben spielbar. Der Code wählt derzeit `album.images[0]`. Eine kleinere Bildvariante spart Transfer/Speicher, nicht den vorgelagerten Einzel-Track-Request; für weniger API-Aufrufe braucht es zusätzlich weniger Lookups beziehungsweise wirksameres Caching.

**Externe Grenzen, am 22.09.2026 gegen offizielle Spotify-Seiten geprüft:**

- Der Migrationsleitfaden nennt Einzel-Track-Aufrufe statt Batch, `/items` statt `/tracks` sowie Playlist-Inhalte nur für Eigentümer **oder Mitbearbeiter**. Eine Beschränkung ausschließlich auf den Eigentümer wäre zu eng. Spotifys Mitteilung vom 9. März verschob allerdings Endpoint-Änderungen für bestehende Integrationen; reale App-Berechtigungen deshalb nicht allein aus einem Datum ableiten. [Migrationsleitfaden](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [Mitteilung mit März-Update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security).
- Der Leitfaden nennt fünf autorisierte Nutzer und Bestandsschutz für bereits vorhandene höhere Nutzerzahlen. Der App-Owner braucht Premium. Die in v2 genannte Owner-Ausnahme ist eine frühere Projektbeobachtung, kein hier erneut getesteter Vertrag. [Migrationsleitfaden](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
- Seit 23. Juli: bis zu 25 Client-IDs, aber gemeinsames Development-Kontingent pro Entwicklerkonto. Eine zweite Client-ID isoliert nicht das Budget. 429 kann `reason: QUOTA_EXCEEDED` enthalten. [Spotify-Quota-Update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).
- Extended Access verlangt unter anderem eine Organisation und mindestens 250.000 monatlich aktive Nutzer. Die Developer Policy verbietet Spiele einschließlich Trivia. Der private Freundeskreis bleibt die bisherige Projektentscheidung, ist aber keine von Spotify dokumentierte Ausnahme. [Quota-Modi](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [Developer Policy](https://developer.spotify.com/policy).

Die in v2 berichteten 401/403 und langen Retry-After-Werte um 2300–2480 Sekunden sind historische Beobachtungen, keine in dieser Prüfung reproduzierten API-Tests. „Einzel-Track-Lookups funktionieren uneingeschränkt“ wäre ebenfalls zu absolut.

## MusicBrainz in der App

`src/services/musicbrainz.ts` unterstützt ausschließlich den Bingo-Hinweis Gruppe/Solo mit Timeout, Cache und Fallback. Der Host entscheidet weiter selbst. Das ist getrennt von der wesentlich umfangreicheren MusicBrainz-/ListenBrainz-Jahresprüfung der externen Song-Pipeline.

## Native Builds und Diagnose

Lokale Builds: Android auf Windows, iOS mit Xcode auf separatem MacBook Air M1; keine EAS-Cloud-Builds laut Projektkonvention. Eine EAS-Projektverknüpfung in der Config bedeutet nicht automatisch Cloud-Build-Nutzung.

`app.config.ts` enthält aktuell Version **1.1.6**, Android `versionCode 14`, iOS `buildNumber 16`; `package.json` steht separat auf 1.0.0. Die Lobbywarnung verwendet die Expo-App-Version.

- `withSpotifyRemote`: native Spotify-Integration/Redirects; `patch-package` und das vendorte SDK gehören zur Buildgrundlage.
- `withAndroidReleaseSigning` und `scripts/build-android-release.ps1`: lokale signierte APK/AAB.
- `withFmtCppStandard`, `withIosSigning` und `scripts/release-ios.js`: iOS-Build-/Release-Unterstützung.
- `withCrashDiagnostics`: native iOS-Exception-Diagnose lokal und Upload nach `crash_reports`; Ansicht im Profil. Kein allgemeiner JavaScript-/Android-Crashdienst.
- `postinstall` wendet Patches an und kopiert das Spotify-XCFramework. Bei Änderungen an nativen Plugins/Modulen ist ein neuer nativer Build nötig.

App-`.env` enthält öffentliche `EXPO_PUBLIC_*`-Konfiguration; Skript-Secrets liegen getrennt in `scripts/.env`, Signierdaten separat. Service-Role-Key und Spotify-Client-Secret gehören nicht ins App-Bundle.

---

# Kapitel 3: Song-Pipeline — vom Rohsong zum spielbaren Pool

## Zweck und Abgrenzung

Die vorhandene Pipeline läuft **außerhalb der App** als Node.js/CommonJS-Skriptwerk. Sie kuratiert Titel, findet eine Spotify-Aufnahme, prüft deren Erscheinungsjahr, führt unsichere Fälle einer manuellen Entscheidung zu und lädt freigegebene Songs als Themenpool hoch. Die App liest später nur die fertigen Zeilen; keine Laufzeit-KI und keine MusicBrainz-Jahresrecherche während einer Partie.

Bisher wurde die Pipeline in einem eigenen Chat gepflegt. Das ist eine sinnvolle thematische Trennung, keine technische Notwendigkeit für einen dauerhaft parallelen Chat. Änderungen an CSV-Vertrag, Upload-Mapping oder Poolschema müssen mit der App abgestimmt werden.

Der vorhandene lokale Playlist-CSV-Importer ist von dem **geplanten In-App-Playlist-Import** zu unterscheiden. Dessen Konzept wird hier nicht neu ausgearbeitet.

```text
Roh-CSV / zugängliche Spotify-Playlist
                  |
        precheck-song-pool.js
                  |
  Spotify-Zuordnung -> MusicBrainz -> gezielte Discogs-Prüfung
                  |
  Entscheidung + Soft-Check + optional ListenBrainz -> MusicBrainz
                  |
              Review-CSV
                  |
       review-song-pool.js (manuell, ohne Provider-Aufrufe)
                  |
      Upload-Prüfung + upload-song-pool.js
                  |
    song_pools / pool_songs in Supabase
                  |
   deck.ts -> getPoolSongs() -> Spielkarten + separate Cover
```

## 1. Eingaben und Spotify-Zuordnung

**Rohlisten:** CSV mit `title, artist, estimated_year`; zusätzlich können `spotify_track_id, isrc` und Albumkontext enthalten sein. `load-smart-input-csv.js` liest Header und auch die alte positionsbasierte Form. Bestehende bestätigte Jahre werden aus `final_year`, `release_year` oder `csv_year` erkannt. Ein `estimated_year` ist zunächst ein Hinweis, kein bestätigtes Originaljahr.

**Lokaler Playlist-Importer:** `scripts/import-spotify-playlist.js` liest per Benutzer-PKCE `GET /playlists/{id}/items`, folgt der Pagination und schreibt eine Roh-CSV. ID, URL oder Spotify-URI werden akzeptiert. Null-/lokale/unvollständige Einträge werden gezählt und übersprungen. CSV enthält unter anderem Track-ID, ISRC, Albumname/-typ/-datum, Dauer, Albuminterpret und Track-/Discnummer. Das Albumjahr wird nur `estimated_year`. Kein Supabase-Schreibzugriff.

Auth für dieses Skript: `SPOTIFY_CLIENT_ID`, Browserlogin und lokaler Callback standardmäßig `http://127.0.0.1:8888/callback`; optional `SPOTIFY_PLAYLIST_REDIRECT_URI`. Token-Cache in `scripts/.spotify-user-token.json`. Nur tatsächlich zugängliche Playlists funktionieren; dieses Skript ist kein Ersatz für das separat geplante Importprojekt.

**Precheck-Fast-Path:** Sind Track-ID **und** ISRC vorhanden, übernimmt `verify-songs.js` diese Zuordnung, ohne Spotify-/Credits-/Deezer-Suche oder Ähnlichkeitsprüfung. Das spart Anfragen, setzt aber vertrauenswürdige Eingabedaten voraus. Die Jahresprüfung läuft trotzdem.

**Sonstige Rohzeilen:** Credits.fm-Batch-Resolver versucht ISRCs zu finden; danach folgen Spotify-ISRC-Suche, optional Deezer-ISRC-Hilfe und Spotify-Textsuche mit Titel-/Interpretenvergleich. Die Spotify-Suche verwendet Client Credentials aus `scripts/.env`. Fast-Path und Vollsuche sind daher unterschiedliche Kosten- und Fehlerpfade.

**Kurationskonvention:** CSV-Dateien unter `scripts/`, nicht im Projekt-Root. Keine Artist-Obergrenze für importierte kuratierte Playlists; Artist-Caps beziehen sich auf die Erstellung KI-gestützter Rohlisten.

## 2. Jahresprüfung und Entscheidungsmodul

Ziel ist ein für das Spiel passendes ursprüngliches Veröffentlichungsjahr der Aufnahme, nicht blind das Veröffentlichungsjahr eines Remasters oder Samplers. Automatische Hauptquelle ist **MusicBrainz**.

`verify-songs.js` erledigt Provider-Aufrufe, Matching und Aufbereitung. `scripts/lib/decision/` trennt die pure Entscheidung von Netzwerkzugriffen:

| Modul | Verantwortung |
| --- | --- |
| `map-verification-result.js` | Provider-/CSV-Felder in ein einheitliches Entscheidungsformat bringen |
| `detect-risk-flags.js` | Fehlende ISRC, unsichere/textbasierte MB-Treffer, Album-/Compilation-/Remaster-Kontext und Jahreskonflikte erkennen |
| `decide-year.js` | Status, finales Jahr/Quelle, Reviewgrund und Empfehlung bestimmen |
| `plan-discogs-lookup.js` | Gezielt nötige Discogs-Abfragen planen |

Ein starker MusicBrainz-Treffer braucht ein plausibles Jahr, ISRC-basiertes Matching und keinen ausschließenden Matchstatus; falls ein Score vorliegt, mindestens 0,72.

| Interne Entscheidung | Übergang in die Review-CSV | Upload |
| --- | --- | --- |
| `accepted_auto` | `auto_accepted_mb` mit `final_year` | Möglich |
| `accepted_auto_soft` | Zunächst `soft_discogs_pending`, Kandidat in `chosen_candidate`, noch kein freigegebenes `final_year` | Blockiert |
| `needs_review` | `review_needed` bzw. offene Reviewzustände | Blockiert |
| Soft-Check ohne relevanten früheren Discogs-Konflikt | `auto_accepted_mb_soft_checked` | Möglich |
| Saubere optionale LB→MB-Bestätigung | `auto_accepted_mb_lb_confirmed` | Möglich |
| Manuell entschieden | Passender `manual_confirmed_*`-/`manual_entered_year`-Status | Bei gültigem Jahr möglich |
| Explizit ausgeschlossen | `excluded_from_pool` | Wird übersprungen |

**Harte Risiken:** Kein/unsicherer MB-Treffer, Text-only-Match, Konflikt zum Bestandsjahr, früheres Discogs-Jahr oder verdächtig spätes MB-Jahr. **Weiche Risiken:** Katalog-, Compilation-, Remaster-/Deluxe-Kontext bei ansonsten starkem Match.

**Discogs:** Im reinen Planer fünf Trigger: `mb_no_match, mb_uncertain, mb_text_match_only, mb_year_suspicious_late, existing_year_conflict`. Dazu kommen im Gesamtlauf Soft-Checks sowie explizit breitere Modi. Deshalb ist „Discogs wird ausschließlich bei fünf Flags aufgerufen“ als Beschreibung der gesamten Pipeline falsch. Discogs kann bei fehlendem MB-Match Hinweise liefern; sein Jahr wird aber nicht automatisch als neuer Hauptanker übernommen.

Soft-Checks liegen in `precheck/soft-discogs-checks.js`: Ein Discogs-Kandidat **mehr als ein Jahr früher** löst manuelles Review aus. Ein fehlerfreier Lookup ohne solchen Konflikt kann freigeben, auch ohne identischen bestätigenden Treffer. Timeout/Rate-Limit/Fehler bleiben pending. „Konfliktfrei“ bedeutet deshalb nicht „zwei Quellen bestätigen exakt dasselbe Jahr“.

**Deezer:** Optionaler Kompatibilitäts-/Hilfspfad, über `--deezer=needed|full|off` steuerbar. Deezer-Felder beeinflussen die neue reine automatische Jahresentscheidung nicht; manuell bestätigte Legacy-Deezer-Status bleiben uploadfähig.

## 3. ListenBrainz als zusätzliche Reviewhilfe

Bereits implementiert, in v2 nahezu nicht beschrieben:

1. `listenbrainz-review-enrichment.js` nimmt offene Reviewfälle.
2. `sources/listenbrainz.js` fragt Metadaten anhand von Titel, Interpret und Release-Kontext ab.
3. Gefundene MusicBrainz-IDs werden über `sources/musicbrainz-recording.js` weiter untersucht.
4. `listenbrainz-mb-analysis.js` bewertet Aufnahme-/Release-Jahre sowie Versions- und Kontextwarnungen.
5. Empfehlungen und Evidenz werden in zusätzlichen CSV-Spalten gespeichert; damit wird das manuelle Review schneller.

Option `--listenbrainz=needed`; benötigt `LISTENBRAINZ_USER_TOKEN`. Ohne Token wird der Schritt als übersprungen erfasst.

`--lb-auto-accept=safe` ist eine zusätzliche bewusste Option. Automatische Freigabe nur bei `likely_accept_existing_mb`, übereinstimmendem vorhandenem MB- und LB→MB-Jahr, keinen Versions-/Kontextflags und keinem bekannten früheren Discogs-Konflikt. Alternative Jahre oder Empfehlungen mit Warnungen bleiben manuell. `final_source` bleibt **musicbrainz**: ListenBrainz dient hier als Zugang zu zusätzlicher MusicBrainz-Evidenz.

CLI-Defaults sind **ListenBrainz aus und Auto-Accept aus**. Der aktuelle Beispiel-Standardlauf aktiviert beides ausdrücklich. Das darf nicht mit implizitem Defaultverhalten verwechselt werden.

## 4. Precheck, CSV, Resume und manuelles Review

`precheck-song-pool.js` ist nur der CLI-Einstieg. `lib/precheck/run-precheck.js` orchestriert Laden, Verifikation, Review-Zeilen, Wiederaufnahme, Soft-Checks, optionale ListenBrainz-Anreicherung, Speicherung und bei Bedarf interaktives Review.

Die Review-CSV enthält Quelldaten, Spotify-Zuordnung, Kandidatenjahre, `status`, `final_year`, Entscheidungs-/Warnfelder, Notizen und gegebenenfalls ListenBrainz-Evidenz. Sie ist das Übergabeformat zwischen automatischer Recherche, menschlicher Entscheidung und Upload.

**Resume:** Vorhandene Entscheidungen aus der Output-CSV werden über Spotify-Track-ID, ersatzweise normalisierten Titel/Interpret, zugeordnet. Bestimmte Felder wie `final_year, status, notes, chosen_candidate, manual_source_url, exclusion_reason` bleiben erhalten. Provider-Caches sparen erneute Recherche. Das ist kein vollständiger transaktionaler Checkpoint jeder laufenden Netzwerkanfrage. Bei hartem Spotify-Cooldown vor dem Speichern wird keine neue Review-CSV geschrieben. Ein- und Ausgabepfad des Prechecks müssen verschieden sein.

**Review-only:** `review-song-pool.js` liest eine vorhandene Review-CSV und benötigt keine neuen Spotify-/MB-/Discogs-/ListenBrainz-Lookups. Es bewahrt vorhandene Spalten und speichert manuelle Änderungen. Offene Fälle werden nach Empfehlungen gruppiert; Gruppenannahme und Einzelentscheidungen sind möglich.

Manuell lassen sich MB-, LB→MB-, Discogs-, Spotify- oder angezeigtes Defaultjahr übernehmen, ein Jahr eingeben, Fälle zurückstellen oder explizit aus dem Pool ausschließen. **Enter kann den angezeigten Vorschlag bestätigen, auch einen Spotify-Fallback; es bedeutet nicht generell „überspringen“.** Zurückgestellte Fälle bleiben uploadblockierend. Ein bekanntes Warnsignal wird durch eine manuelle Entscheidung bewusst akzeptiert, nicht automatisch widerlegt.

## 5. Upload-Vertrag und Datenbankmapping

`upload-song-pool.js` ruft **keine Musikprovider** auf. Es prüft zuerst die gesamte CSV mit `validate-upload-rows.js`.

- Jede nicht ausgeschlossene Zeile braucht einen erlaubten Freigabestatus und ein vierstelliges `final_year` zwischen 1850 und aktuellem Jahr + 1.
- Ein offener Status blockiert den gesamten Upload auch dann, wenn jemand bereits ein Jahr eingetragen hat.
- Ausgeschlossene Zeilen werden übersprungen. Erst nach erfolgreicher Status-/Jahresprüfung werden Zeilen ohne gültige Spotify-Zuordnung separat übersprungen; `spotify_not_found` ist selbst ein blockierender Status.
- Duplikate werden pro `spotify_track_id` entfernt.
- Ein schon vorhandener Poolname führt zum Abbruch, nicht zum automatischen Überschreiben. Das ist ein Skript-Check, kein Unique-Constraint auf dem Poolnamen.

Mapping in `map-upload-row.js`:

| Review-CSV | Supabase |
| --- | --- |
| Spotify-Titel, sonst Roh-Titel | `pool_songs.title` |
| Spotify-Interpret, sonst Roh-Interpret | `pool_songs.artist` |
| `spotify_track_id` | `spotify_track_id` |
| **`final_year`** | **`release_year`** |
| `isrc` | `isrc` oder null |
| Neu angelegter Pool | `pool_id` |

Beim Lesen erzeugt `getPoolSongs()` aus der Spotify-ID `spotify:track:<id>` als Karten-ID und `trackUri`; `release_year` wird zu `GameCard.year`. Erst der jeweilige Startpfad mischt die Karten. Diese Schnittstelle verbindet die Kuration mit beiden Spielwelten.

Reviewnotizen, ListenBrainz-Felder und die detaillierte Herkunft des Jahres werden nicht als solche in `pool_songs` gespeichert. Die finale Review-CSV bleibt daher der Prüfbeleg.

Ablauf: neuen `song_pools`-Datensatz anlegen, alle Songs in einem Bulk-Insert schreiben. Bei Insertfehler versucht das Skript, den neu angelegten Pool wieder zu löschen; es gibt keinen stillen Einzelzeilen-Retry. **Das ist ein kompensierender Rollback, keine gemeinsame Datenbanktransaktion**; bei ebenfalls fehlgeschlagenem Rollback meldet das Skript beide Fehler.

## 6. Konfiguration, Drosselung und Caches

Node.js mit globalem `fetch` erforderlich (Skripte nennen Node 18+). Entscheidungslogik ist CommonJS ohne Framework-Abhängigkeit; Upload verwendet den Supabase-Client aus dem Projekt.

`scripts/.env`:

| Variable | Zweck |
| --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Client-Credentials-Suche im Vollpfad |
| `SPOTIFY_PLAYLIST_REDIRECT_URI` | Optionaler Callback des lokalen Playlist-PKCE-Imports |
| `DISCOGS_TOKEN` | Discogs-Abfragen |
| `LISTENBRAINZ_USER_TOKEN` | Optionale ListenBrainz-Anreicherung |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Ausschließlich Pool-Upload |

Die vorhandene `scripts/.env.example` dokumentiert noch nicht alle optionalen Provider-/Callback-Variablen. Ihre tatsächliche Belegung wurde für diese Doku nicht geprüft.

**MusicBrainz:** Request-Starts mindestens 1200 ms auseinander, höchstens drei laufende Requests; ISRC-Suchbatches mit zwölf ISRCs. Drei laufende Requests bedeuten also nicht drei Starts pro Sekunde. Eigener User-Agent, Timeout/Retry und Dateicaches.

**Discogs:** Gezielte Prüfungen, Cache und Drosselung; normale Hard-Checks im `needed`-Modus sind ohne `--deep` auf 50 Kandidaten begrenzt. `--discogs=full` / `--deep` erweitern die Recherche. Diese Grenze ist kein pauschales Gesamtlimit inklusive aller nachfolgenden Soft-Checks.

**Caches:** Unter `scripts/.cache/`, unter anderem MusicBrainz-Suchcache, Deezer-, Discogs-, ListenBrainz- und MusicBrainz-Recording/Release-Cache. Die Cache-Pfade der beiden `sources/`-Module zeigen inzwischen ebenfalls dorthin. Rohes Provider-Ergebnis und kontextabhängige Jahresentscheidung getrennt halten: derselbe ISRC-Lookup kann bei anderem Albumkontext anders bewertet werden.

**Spotify-Rate-Limits:** Timeout-/Retry-Helfer beachten 429; lange Cooldowns führen zum Laufabbruch statt endloser Wiederholung. Das ist eine andere Implementierung als der Cover-Circuit-Breaker in der App.

## 7. Dokumentierte Bedienfolge

Vom Projekt-Root; Beispiele, bei dieser Doku-Arbeit nicht gegen Provider oder Supabase ausgeführt:

```powershell
node scripts/precheck-song-pool.js scripts/raw_pool.csv scripts/review_pool.csv --no-interactive --deezer=off --discogs=needed --listenbrainz=needed --lb-auto-accept=safe
node scripts/review-song-pool.js scripts/review_pool.csv scripts/review_pool_final.csv
```

Nach abgeschlossener menschlicher Prüfung erfolgt als separater, bewusst ausgelöster Datenbank-Schreibschritt:

```powershell
node scripts/upload-song-pool.js scripts/review_pool_final.csv "Poolname" "Beschreibung"
```

Der Upload ist kein Dry-run. Erfolg zeigt tatsächliche geschriebene Songzahl, ausgeschlossene/fehlende Spotify-Ziele, Duplikate und vom MB-Jahr abweichende manuelle Entscheidungen.

## 8. Prüfung dieser Fassung

Am 22.09.2026 ausgeführt:

```powershell
node --test --test-reporter=spec test/*.test.js
```

**117 Tests bestanden, 0 fehlgeschlagen.** Vorhandene Tests decken unter anderem Jahresentscheidung, Soft-Checks, ListenBrainz, Caches, Resume, interaktives/Review-only-Verhalten und Uploadvalidierung/-Rollback mit isolierten Abhängigkeiten ab. Kein Live-Pool importiert, keine produktive Migration, kein nativer Build und kein Geräte-Spieltest. Der Doku-Abgleich ist kein neuer vollständiger App-Code-Audit.

---


# Kapitel 4: Backlog

Die folgenden historischen Planungs- und Testangaben stammen aus v2, sofern nicht ausdrücklich als Repo-Abgleich gekennzeichnet. Insbesondere wurden externe Deployments, frühere manuelle Tests und die Hosting-Anfrage nicht erneut überprüft.

## Playlist-Import-Neuauflage (eigenständiges Konzeptdokument, nicht hier ausformuliert)

Das separate Konzept liegt in [spotify-playlist-import-konzept.md](spotify-playlist-import-konzept.md) (laut v2 Version 4.0, mehrere Prüfrunden). Migrationen `012_playlist_import.sql`/`013_seed_song_year_overrides.sql` liegen bereit; DDL-Tests gegen eine Wegwerf-Instanz und die Behebung der dabei gefundenen Blocker sind in v2 berichtet. Das Konzept wurde für diese Übergabe nicht erneut geprüft oder erweitert.

**Späterer nächster Schritt laut v2:** Arnis eigener Testlauf gegen eine Wegwerf-Instanz, danach gegebenenfalls Ausführung gegen die echte Instanz. Worker und App-UI stehen aus. Das gesamte Thema ist auf Arnis Wunsch aktuell zurückgestellt.

**Bekanntes, akzeptiertes Restrisiko:** Verstößt gegen Spotifys Verbot von automatisiertem Scraping — bewusst akzeptiert für einen privaten, nicht-öffentlichen Rollout.

**Hosting-Frage (offen):** Läuft entweder auf einem bestehenden, selbst verwalteten Server (Docker + genug freie RAM-Reserve nötig) oder bei einem externen Anbieter (Railway/Fly.io). Anfrage bei einem Bekannten mit eigenem Server läuft.

## Ergänzungen aus der Doku-Prüfung

- **Dynamische Siegkartenzahl:** Der aktuelle Slider ist fest auf 5–20 begrenzt. Ableitung aus Poolinhalt/Spielerzahl ist bislang nur ein Wunsch.
- **Siegfortschritt verständlich benennen:** Anzeige „score / cardsToWin richtig platziert“ mit Startkarte und tatsächlicher Siegschwelle abgleichen; Spielregel nicht versehentlich wieder um eins verschieben.
- **Erfolg „Ehrenmann/-frau" (X Songs gemeldet) — zurückgestellt:** `song_reports` (Migration 009) hat keine Spielerzuordnung; die Tabelle speichert Song, Quelle, Grund, Modus und `lobby_id`, und `reportSong()` sendet keine Spieler-ID. Personenbezogen ist der Erfolg damit nicht baubar. Anmerkung zur Entscheidung: Das Erfolgsprofil ist ohnehin komplett gerätelokal, ein lokaler Zähler „von diesem Gerät gemeldet" wäre also genauso personenbezogen wie jeder andere Erfolg auch — das wurde bewusst nicht ungefragt eingebaut.
- **Erfolg „Comeback-König" — zurückgestellt:** Ein Zwischenstand ließe sich im Prinzip aus dem Ereignis-Log rekonstruieren (Startkarte + korrekte `place`/`steal`-Ereignisse je Spieler), **aber**: `blindDraw()` legt eine Karte in die Zeitleiste und schreibt bewusst kein `MatchEvent` („eine gekaufte Karte ist weder richtig noch falsch platziert"). In jeder Partie mit aktiviertem Blind-Kauf wäre der rekonstruierte Kartenstand also falsch. Für einen belastbaren Erfolg bräuchte es entweder ein Ereignis für den Blindkauf oder einen mitgeführten Rankingverlauf — beides neue Tracking-Infrastruktur.
- **Fortschrittsbalken für die übrigen Erfolge:** Ihre Rohdaten liegen nur in `matchHistory` (max. 200 Partien). Ein daraus abgeleiteter Bestwert kann sinken, sobald die Kappung greift, deshalb zeigt die Detailansicht dort bewusst keine Zahl. Sieben davon sind ohnehin binär (Perfect Hit, Insane Guess, Jahrzehnt-Straße, Perfect Bingo Easy/Hard, Sad Bingo, Perfect Timeline). Für die sechs abstufbaren (Total daneben, Kleine/Große Straße, Double/Triple Hitster, Total Verbrandt) bräuchte es je einen dauerhaften Bestwert in `LocalProfile.stats` — eigenständige Änderung an der Statistikerfassung, nicht Teil des Galerie-Auftrags.
- **Drei Hitster-Erfolge auf Spielerbezug prüfen:** Total daneben, Perfect Hit und Insane Guess lesen aktuell das vollständige Match-Log. Entscheiden, ob die Erfolge nur die eigene Party-Leistung berücksichtigen sollen.
- **Onboarding-Texte und README nachziehen:** Alte Tabnamen/„rufen“-Formulierung sowie Spotify-Spike-Beschreibung passen nicht vollständig zur aktuellen App.
- **Skript-Konfigurationsvorlage ergänzen:** `scripts/.env.example` fehlen unter anderem ListenBrainz, Discogs und der optionale Playlist-Callback.
- **Pass-&-Play-Mehrfach-Hitstern:** Der in v2 offene Gerätetest bleibt offen; lokale Skripttests sind dafür kein Ersatz.

Diese Punkte sind dokumentierte Folgethemen, keine in dieser Bearbeitung umgesetzten App-Änderungen.

## Neu

- **Cover-Art-Ladeoptimierung:** Der Code wählt `album.images[0]`. Eine kleinere Bildvariante spart zunächst Transfer und Speicher; weniger Spotify-API-Calls erfordern zusätzlich weniger Lookups beziehungsweise Caching. Prefetch mit Circuit Breaker existiert. Niedrige Priorität laut v2.
- **AFK-Host-Override:** Für einen hängenden Platzierungs-Zug in der Mehrfaches-Hitstern-Warteschlange (Party) — niedrig priorisiert, da man im selben Raum sitzt.

## Größere Themen, brauchen erst eine Konzept-Runde

- **Single-Player-Mode** — weiterhin nur Konzept, kein Code vorhanden.

## Offene Design-Entscheidung

- **App-Redesign/Farbrichtung:** zwei Mockup-Richtungen vorgestellt ("Nickel & Brandt" — warmes Kupfer/Bronze + Glutorange; "Retro-Vinyl" — Senfgelb + Terrakotta auf Petrol). Auslöser: aktueller Look (Neon-Pink/Cyan/Orange auf Dunkel) wirkt zu Hitster-ähnlich. Weiterhin die **älteste offene Entscheidung** im gesamten Verlauf, wartet auf Arnis Reaktion.

## Bewusst zurückgestellt

- **Dynamic-Island-Hinweistext:** Cover/Titel/Interpret sind während der Wiedergabe im iOS-Dynamic-Island-Mini-Cover sichtbar (Spotifys eigene Anzeige, technisch nicht unterdrückbar). Fix: erklärender Zusatzsatz am „Cover erst nach Aufdeckung zeigen"-Toggle, Text-Vorschlag liegt fertig vor, bewusst noch nicht losgeschickt.

## Gegen den Code präzisierter Altpunkt

- **Wiederaufnahme einer laufenden Pass-&-Play-Partie:** Der Reducer und die konkrete Stapelreihenfolge sind nicht persistent. Eine persistente Menge verbrauchter Songs pro Pool existiert bereits. Eine vollständige Spiel-Wiederaufnahme wäre eine gesonderte Erweiterung; Bedarf noch offen.

## Administrativ, läuft weiter

- Freunde/Tester ins Spotify Developer Dashboard eintragen (Nutzerlimit 5) — Dauer-Fakt, kein Ticket, siehe Kapitel 2/Spotify.

## Erledigt laut bisheriger Übergabe (Test-/Deploymentstatus nicht neu bestätigt)

Kartenanzahl-Off-by-one-Fix, Mehrfaches Hitstern (Party, getestet und bestätigt) + Toggle-Sichtbarkeits-Nachtrag, Mehrfaches Hitstern (Pass & Play, implementiert/Typecheck grün, Simulator-Test steht noch aus), Achievements-System + Statistik-Tab (lokales Profil, cross-mode), Bingo-Board-in-Statistik-Accordion + Sieganimation verlängert, manuelle Nickel-Korrektur Parallel-Konflikt-Fix, Bingo-Expert-Mode-Klärung (kein eigenes Feature), nicht blockierende App-Versionswarnung (kein hartes Protokoll-Gate), Cache-Pfad-Off-by-one (Pipeline), `DISCOGS_TOKEN` (Pipeline), Playlist-Import-Konzeption (Architektur + Migration, Umsetzung selbst noch offen, siehe oben).

## Obsolet/gestrichen (nicht wieder aufgreifen)

PlaylistPickerScreen-Fehlertexte, `createTask:false`, Cover-Art-Batch-Kappung, die freundliche 403-Fehlertext-Arbeit (hinfällig durch die alte Playlist-Import-Entfernung), „Freunde ins Spotify-Dashboard eintragen" als Feature-Ticket (ist Dauer-Fakt, siehe Kapitel 2, kein Ticket mehr), alle Alt-Punkte aus der allerersten Übergabe außer dem Kartenstapel-Punkt oben.
