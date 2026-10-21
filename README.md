# Game Launcher for Steam

A Stream Deck plugin by [quin.tools](https://quin.tools/game-launcher/). One key fills your whole Stream Deck with your Steam games (with artwork); press a game to launch it.

- **Favorites**: your Steam Favorites, or any of your own collections
- **Installed**: everything installed, across all your library drives
- **Recent**: installed games and favorites you have played, last played first
- **All**: installed plus favorites

Favorites that are not installed show in grey with a download badge; pressing one opens Steam's install dialog. Games in your Steam "Hidden" collection are skipped.

## Install

Download the latest `tools.quin.steamlibrary.streamDeckPlugin` from [Releases](https://github.com/fyxtro/game-launcher-for-steam/releases/latest).

1. Make sure the Stream Deck app is version **7.1 or later** (Windows).
2. Double-click the downloaded `.streamDeckPlugin` file.
3. The actions appear under **Game Launcher for Steam** in the action list.

## Use

1. Drag **Open Game Launcher** onto any key of your normal profile.
2. Press it. The first time, Stream Deck asks whether to install the included profile: choose yes.
3. Your whole deck fills itself:

```
[ Back ] [ Game ] [ Game     ] [ Game   ] [ Game ]
[ Game ] [ Game ] [ Game     ] [ Game   ] [ Game ]
[ Game ] [ Game ] [ Previous ] [ Filter ] [ Next ]
```

- Press a game to launch it. The deck then returns to your previous profile (can be turned off).
- **Back** returns without launching anything.
- **Previous / Next** page through your games and show the page number.
- **Filter**: press to switch between Favorites, Installed, Recent and All. Hold for a second to rescan Steam.

Profiles are included for Stream Deck (15 keys), Stream Deck Mini and Stream Deck XL.

Prefer your own layout? Put **Game Slot** actions on any keys (for example in a folder). They fill automatically, left to right, top to bottom.

## Settings (select the Filter key in the Stream Deck app)

| Setting | What it does |
|---|---|
| Show | Starting filter |
| Sort by | Last played (default) or name |
| Favorites from | Steam Favorites or one of your own collections. Click refresh if a new collection is missing |
| Game names | Show the game name below the artwork |
| After launch | Return to your previous profile after launching (default on) |
| Steam folder | Only needed if automatic detection fails (for example `D:\Steam`) |
| Rescan Steam | Reloads your library and rebuilds the artwork cache |

## Where the data comes from

Everything is read locally; no Steam API key is needed.

| What | Source |
|---|---|
| Steam folder | Registry `HKCU\Software\Valve\Steam\SteamPath` |
| Library drives | `steamapps\libraryfolders.vdf` |
| Installed games | `appmanifest_*.acf` in each library |
| Last played | `appmanifest` + `userdata\<id>\config\localconfig.vdf` |
| Favorites / collections | `userdata\<id>\config\cloudstorage\cloud-storage-namespace-1.json` |
| Account | `config\loginusers.vdf` (most recent login) |
| Artwork | `appcache\librarycache`, otherwise the Steam CDN |

Only for favorites that are not installed, the name is fetched once from the public Steam Store API. Rendered keys are cached in `%LOCALAPPDATA%\quin.tools\GameLauncherForSteam`.

Note: Steam sometimes writes its collection file a little later. If a new favorite is missing, hold the Filter key to rescan.

## Development

Requires Node.js 24 or later.

```powershell
npm install
npm install -g @elgato/cli
npm run build      # builds bin\plugin.js
npm run link       # links the folder to Stream Deck (uninstall the packaged version first)
npm run watch      # rebuild and restart on every change
npm run profiles   # regenerates the bundled profiles (tools\build-profiles.mjs)
npm run pack       # profiles + build + new .streamDeckPlugin in dist\
```

Structure:

```
src/
  plugin.ts               action registration and global settings
  controller.ts           filtering, paging, rendering, launching
  actions/game-slot.ts    the game tile
  actions/navigation.ts   previous / next / filter (+ property inspector)
  actions/grid.ts         open the grid profile and go back
  profiles.generated.ts   bundled profile paths (generated)
  steam/vdf.ts            parser for Valve KeyValues (.vdf/.acf)
  steam/library.ts        library, collections and last played scanning
  steam/images.ts         artwork lookup, download and 144x144 rendering
tools.quin.steamlibrary.sdPlugin/
  manifest.json, ui/filter.html, imgs/, profiles/
tools/build-profiles.mjs  generates the .streamDeckProfile files
marketplace/              listing text, privacy policy, thumbnail and gallery images
```

Releasing: update `Version` in the manifest, edit `.github/RELEASE_NOTES.md`, then push a tag (`git tag v1.2.1 && git push origin v1.2.1`). GitHub Actions builds the plugin and publishes the release with the `.streamDeckPlugin` attached.

When changing a profile layout after release: Stream Deck installs a bundled profile only once per file name. Bump `REVISION` in `tools/build-profiles.mjs` so the new layout is picked up.

Logs: `%appdata%\Elgato\StreamDeck\Plugins\tools.quin.steamlibrary.sdPlugin\logs`.

## Privacy

No analytics or tracking. See the [privacy policy](https://quin.tools/game-launcher/privacy/).

## License

MIT, see [LICENSE](LICENSE).

Not affiliated with or endorsed by Valve Corporation. Steam is a trademark of Valve Corporation.
