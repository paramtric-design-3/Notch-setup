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
| Weather | Open-Meteo (free, no key) for the city you type in Settings. |
| Messages | The notifications Windows is still holding (WhatsApp, Telegram, Teams…). Read-only and local. |
| Quick controls | Wi-Fi, Bluetooth, dark mode, volume (click mutes, scroll changes), brightness (laptop screens only; click cycles, scroll changes), Start menu. |
| Next event | Optional. An ICS calendar link (Outlook.com: Settings → Calendar → Shared calendars → Publish). |
| Focus timer | Optional. 25 minutes, with start, pause and reset. |

Each tile can be shown or hidden, set to 1, 2 or 3 cells wide and reordered in Settings.

**Peeks** are small bubbles that appear for a few seconds: an app opening or closing (with its icon), the charger connected or disconnected, and battery at 20% and 10%.

**Compact state**: while music plays, a Claude Code task runs or the focus timer counts down, the pill widens a little to show it.

## Claude Code in the notch

Open Settings, scroll to **Claude Code** and click **Copy**. Then paste the lines into `%USERPROFILE%\.claude\settings.json`. If that file already has a `"hooks"` block, merge them into it. Start a new Claude Code session afterwards.

They look like this:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/claude", "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/claude", "timeout": 5 }] }],
    "PermissionRequest":[{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/claude", "timeout": 120 }] }],
    "Notification":     [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/claude", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/claude", "timeout": 5 }] }]
  }
}
```

- While Claude works, the pill shows the current step (reading, editing, running a command, searching) and a small animated grid.
- When Claude asks for permission, the notch opens with the full command. **Allow** stays greyed out until you've scrolled through the whole command. Shortcuts: `Ctrl+Alt+Y` allows, `Ctrl+Alt+N` denies.
- If you don't answer within 110 seconds, Claude Code falls back to asking in the terminal.
- When Claude finishes, a peek shows "Done" and how long it took.
- If FJBC Notch isn't running, the hooks fail quietly and Claude Code works as normal.

These are Claude Code's built-in HTTP hooks, so no script is needed. The app only accepts requests from this PC and blocks requests from web pages.

## Differences from the Mac version

- **No real notch**: Windows laptops don't have one, so the app draws the black pill itself.
- **Music**: uses Windows' media controls instead of AppleScript, so no Automation permission is needed and Spotify or Music is never launched by the app.
- **AirDrop**: replaced by Bluetooth.
- **App grid**: opens the Start menu.
- **Messages**: Windows has no inbox to read from, so the tile shows the notifications Windows is holding from messaging apps.
- **Do Not Disturb**: Windows has no public API for it, so there is no peek for it.
- **Full screen**: the notch stays on top of normal and borderless full-screen windows, including browser videos. Games running in exclusive full-screen mode draw over it.

## Privacy

Nothing leaves your PC except weather requests (Open-Meteo), lyrics lookups (LRCLIB), cover lookups (iTunes Search) when a player shares no cover, update checks (GitHub) and your calendar link if you add one. There are no accounts and no analytics. Settings, the lyrics and cover caches, and a small troubleshooting log (`helper.log`) live in `%APPDATA%\FJBC Notch`.

## Updates

FJBC Notch updates itself from this repo's [releases](https://github.com/paramtric-design-3/Notch-setup/releases):

- It checks when it starts, every 5 minutes, and whenever your PC wakes from sleep or is unlocked.
- A new version downloads quietly in the background.
- Once it's downloaded, it installs by itself the next time you've left the PC alone for a minute while the notch is closed and Claude Code isn't busy. The notch shows "Updating to x.y.z" and is back a few seconds later.
- To install straight away instead: tray icon → **Restart to update**.
- Tray icon → **Check for updates**, or Settings → **Updates**, checks right away.

## Remove it

1. Turn off **Launch at login** in Settings if you turned it on.
2. Windows Settings → Apps → Installed apps → **FJBC Notch** → Uninstall.
3. Optionally delete `%APPDATA%\FJBC Notch` (settings and lyrics cache).
4. Remove the Claude Code hook lines from `%USERPROFILE%\.claude\settings.json`.

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

- `main.js`: the window, tray, settings, weather, lyrics, messages, calendar and the Claude Code endpoint.
- `preload.js`: the small bridge between the window and the main process.
- `helper/helper.ps1`: a hidden Windows PowerShell helper for media, Wi-Fi/Bluetooth, volume, brightness, dark mode and app peeks.
- `renderer/`: the island (`index.html`, `style.css`, `app.js`, `icons.js`) and the settings window.
