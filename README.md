# FJBC Notch

A Dynamic Island for Windows. A black pill at the top-center of your screen that grows when something happens and opens into tiles when you hover it.

## Install it

1. Download **FJBC-Notch-Setup-x.y.z.exe** from the [latest release](https://github.com/paramtric-design-3/Notch-setup/releases/latest).
2. Run it. It installs for your user only (no admin rights needed) and starts the app.
3. The first time, Windows SmartScreen may say "Windows protected your PC" because the installer isn't signed by a publisher. Click **More info**, then **Run anyway**. Updates after that install without this warning.

The notch appears at the top-center of your main screen (you can change which screen), and an icon appears in the system tray (you may need to open the tray's ^ arrow to see it). FJBC Notch is also in the Start menu.

- **Hover** the notch: it opens after a quarter second and closes when you move away.
- **Click** it: it stays open. Click again to let it close.
- **Right-click** it, or click the tray icon: settings.
- **Tray menu**: show or hide tiles, which screen, theme, weather city, launch at login, quit.

### Which screen

Tray icon → **Screen**, or Settings → **Screen**:

- **Main screen** (default): the screen Windows marks as your main display.
- **A specific screen**: pick it by name. If Windows renumbers your screens, the notch finds the same screen again by its name and resolution. If that screen is unplugged, the notch moves to the main screen until it's back.
- **Screen with the mouse**: the notch moves to whichever screen your pointer is on (only while it's closed, so it never jumps away while you use it).
- **Identify screens** shows a big number on each screen for a moment so you know which is which.

## What's inside

| Tile | Where the data comes from |
|---|---|
| Music | Windows media controls, so it works with Spotify, browsers and most players. Synced lyrics from LRCLIB (free, no key). If the player shares no cover, it's looked up by artist and title on iTunes Search (free, no key). Both are cached on your PC. |
| League of Legends | Appears while the League client is open. Outside a game: your Solo and Flex rank, LP and win rate. When a game loads: both teams with each player's champion, rank, season win rate and their last 10 games, like Porofessor's loading screen. Uses only the League client on this PC (no Riot account key) plus champion pictures from Riot's Data Dragon. Ranks are looked up once the game is loading, not in champ select, because Riot doesn't allow revealing the hidden names there. **Champ select helper:** opens by itself in champ select with your role and the timer, your stats on the champion you hover or lock, Riot's recommended runes with one-click Import runes (a page named "Notch: <champion>"), both teams' picks and the bans. From OP.GG's open data (free, no key): the champion's tier and win/pick/ban rate, summoner spells, starting items, boots and core items, skill order, the champions that counter you and the ones you beat (enemy picks are tagged), and OP.GG's most played rune page, which Import runes then uses. Every enemy pick gets an estimated role (from how often OP.GG sees that champion in each lane; a ? means it's a guess), and so do teammates in blind pick. Your likely lane opponent is highlighted, and **Suggested picks** for your role mix champions that beat that opponent, your own good champions in this role and the strongest picks of the patch. Outside champ select, click the tile for your most played champions and a tier list per lane (Top, Jungle, Mid, Bot, Support). While the League panel is open it's the only tile in the notch. |
| Sound output | The speaker button on the music tile (top right) lists your playback devices; click one to make it the default. Also in the tray menu under **Sound output**. |
| Weather | Open-Meteo (free, no key) for the city you type in Settings. |
| Messages | The notifications Windows is still holding (WhatsApp, Telegram, Teams…). Read-only and local. |
| Quick controls | Wi-Fi, Bluetooth, dark mode, volume (click mutes, scroll changes), brightness (laptop screens only; click cycles, scroll changes), Start menu. |
| Focus timer | Optional. 25 minutes, with start, pause and reset. |

Each tile can be shown or hidden, set to 1, 2 or 3 cells wide and reordered in Settings.

**Peeks** are small bubbles that appear for a few seconds, for example when champ select starts or a game loads.

**Compact state**: while music plays or the focus timer counts down, the pill widens a little to show it.

## Differences from the Mac version

- **No real notch**: Windows laptops don't have one, so the app draws the black pill itself.
- **Music**: uses Windows' media controls instead of AppleScript, so no Automation permission is needed and Spotify or Music is never launched by the app.
- **AirDrop**: replaced by Bluetooth.
- **App grid**: opens the Start menu.
- **Messages**: Windows has no inbox to read from, so the tile shows the notifications Windows is holding from messaging apps.
- **Do Not Disturb**: Windows has no public API for it, so there is no peek for it.
- **Full screen**: the notch stays on top of normal and borderless full-screen windows, including browser videos. Games running in exclusive full-screen mode draw over it.

## Privacy

Nothing leaves your PC except weather requests (Open-Meteo), lyrics lookups (LRCLIB), cover lookups (iTunes Search) when a player shares no cover, champion, item and rune pictures (Riot Data Dragon), OP.GG's open champion data and update checks (GitHub). There are no accounts and no analytics. Settings, the lyrics and cover caches, and a small troubleshooting log (`helper.log`) live in `%APPDATA%\FJBC Notch`.

## Updates

FJBC Notch updates itself from this repo's [releases](https://github.com/paramtric-design-3/Notch-setup/releases):

- It checks when it starts, every 5 minutes, and whenever your PC wakes from sleep or is unlocked.
- A new version downloads quietly in the background.
- Once it's downloaded, it installs by itself straight away while the notch is closed. The notch shows "Updating to x.y.z" and is back a few seconds later.
- To install straight away instead: tray icon → **Restart to update**.
- Tray icon → **Check for updates**, or Settings → **Updates**, checks right away.

## Remove it

1. Turn off **Launch at login** in Settings if you turned it on.
2. Windows Settings → Apps → Installed apps → **FJBC Notch** → Uninstall.
3. Optionally delete `%APPDATA%\FJBC Notch` (settings and lyrics cache).

## Build from source

Needs Node.js 20 or later.

```
npm install
npm start            # run it from source
npm run dist         # build the installer into dist/ (on Linux or macOS this needs Wine)
```

## Publish a new version

1. Raise `"version"` in `package.json`, for example from `1.2.0` to `1.3.0`.
2. Commit and push to `main`.
3. The **Release** GitHub Action sees the new version, builds the installer on Windows and publishes it as release `v1.3.0`. Installed copies pick it up within about 10 minutes (the build takes about 5, then the next check finds it).

Pushes that don't change the version don't publish anything. You can also start the Action by hand from the repo's **Actions** tab.

### Files

- `main.js`: the window, tray, settings, weather, lyrics, messages and calendar.
- `preload.js`: the small bridge between the window and the main process.
- `helper/helper.ps1`: a hidden Windows PowerShell helper for media, Wi-Fi/Bluetooth, volume, brightness, dark mode and app peeks.
- `renderer/`: the island (`index.html`, `style.css`, `app.js`, `icons.js`) and the settings window.
