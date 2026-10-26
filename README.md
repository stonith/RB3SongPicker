# 🎸 RB3 Song Picker

> Level up your Rock Band 3 parties! 🎉🥁🎤

Tired of scrolling through hundreds of songs mid-party while your friends are waiting? **RB3 Song Picker** is your party DJ sidekick — a slick web app that lets you and your crew browse, search, and queue up Rock Band 3 songs from any phone or laptop on the same Wi-Fi. No more hogging the TV menu!

![RB3 Song Picker screenshot](docs/screenshot.png)

## 🎮 For party hosts & players

### What can you do with it?

- 🎵 **Browse your full song library** from your phone, tablet, or laptop — no need to touch the Xbox at all.
- 🔍 **Search songs instantly** by title, artist, album, or origin — find that one song in seconds.
- 📋 **Create custom song lists** — build a setlist for your party (e.g. "80s Night 🕺", "Karaoke Hits 🎤", "Hard mode only 💀"). Switch between them on the fly.
- ▶️ **Start an automatic session queue** from a saved Song List. The next song is selected when RB3Enhanced reports song selection; players still start gameplay. Everyone can add, remove, and reorder upcoming songs without changing the saved list.
- 🎲 **Pick a random song** — feeling adventurous? Hit the random button! You can even pick *random unpopular* (discover hidden gems) or *random popular* (crowd-pleasers only). Random picks also work within a specific song list!
- 📊 **Sort your library** by title, artist, album or origin.
- ✏️ **Edit and delete your song lists** — tweak your setlist anytime.
- 📈 **Pick counts** — every time a song gets picked, it's tracked. See what the crowd loves most!
- 📱 **Works on any device** — the UI is fully mobile-friendly. Everyone at the party can connect simultaneously and use it on their own phone.
- ⚡ **Works even when the Xbox is off** — browse your cached library, manage song lists, and prepare setlists without the console being on.

### 🎉 One library, everyone benefits

The host loads the song library once — that's it. Every friend who connects instantly sees the full library and all the custom song lists you've created. No setup on their end, no duplicated work. Your "Karaoke Hits" setlist is ready for everyone the moment they join.

### 👭 Invite your friends to join

No app install needed! Open the **Admin page** (the ⚙️ icon) and show your friends the **QR code** — they just scan it with their phone and they're in. Everyone at the party can browse songs and pick what's next!

### 🛠️ Setup (one-time, for the host)

This app runs on a PC on the same local network as your Xbox.

**What you need:**
- A Windows/Mac/Linux PC connected to the same Wi-Fi or LAN as your Xbox 360.
- [RB3Enhanced](https://github.com/RBEnhanced/RB3Enhanced) installed on the Xbox — this mod enables the Xbox HTTP server that RB3 Song Picker talks to.
- [Node.js](https://nodejs.org/) version 24.20.0 or newer installed on the PC.

> **Note:** RB3 Song Picker completely replaces the built-in web interface that comes with RB3Enhanced with its own full-featured UI.

**Steps:**
1. Open a terminal in the `RB3SongPicker` folder.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000` in your browser.
5. Go to the **Admin page** (⚙️), enter your Xbox's IP address and port, then hit **Refresh library** to load your songs.
6. Share the QR code with your friends!

---

## 🔧 Technical stuff

### Architecture

- Local Node.js/Express backend serving a single-page web app.
- Song library is fetched from the Xbox HTTP server (`/list_songs`) and cached locally in a SQLite database (`songs.sqlite`).
- All browser requests are proxied through the backend at `http://localhost:3000`.
- Song selection sends a `/jump?shortname=...` request to the Xbox server.

### Automatic session queue

1. Enable `[HTTP] EnableHTTPServer=true` and `[Events] EnableEvents=true` in the console's `rb3.ini`. Configure its Events `BroadcastTarget` to reach the app host on UDP 21070 (or your configured events port).
2. In Admin, set the **Xbox IP**, HTTP port, **UDP bind address** and **UDP events port**. The Xbox IP is also the accepted UDP source. Allow that UDP port through the host firewall. Admin shows listener errors and last observed screen/events; silence alone is not a disconnection signal.
3. In Songs, choose a **saved Song List**, choose its sort order, and press **Start queue**. All available list members are included, ignoring search/duplicate filters. Starting from **All songs** is unavailable.
4. Queue becomes the session workspace. **+ Add songs** opens a full-height phone picker or a wide-screen side panel. Add songs, including deliberate repeats; remove or move upcoming entries using their controls. These are session-only edits. The requested/playing entry is locked; use **Skip** to move past it.
5. **Pause/Resume** suspend/resume future selections, **Skip** moves past an entry without interrupting gameplay, and **Stop** releases automatic control. Players handle starting gameplay and navigating back to song selection. The queue stops at its end—no looping.

A valid configured-console `SCREEN_NAME = "song_select_screen"` permits Pick immediately. Start/end events track attempts; the protocol does not distinguish completion, quit, or failure. By default all attempts advance. Admin's **Pause after each song attempt** is off by default; when enabled, every attempt pauses and Resume continues to the next song.

- One shared queue updates all browsers. Closing a phone does not stop it. Browsing elsewhere does not get hijacked by remote edits; use Songs/Queue to switch views.
- Pending Add shows **Adding…**; **Result unknown — Retry** retries the same action rather than adding an accidental repeat. Once resolved, a new Add deliberately creates another entry.
- Manual Pick/Random are blocked while the queue owns selection, even when paused. Stop the queue before manual picking. **Preview** is available on the current and upcoming queue songs as well as in Add songs when previews are enabled. It becomes **Stop** while previewing; repeated entries share one local audio player. Preview never selects, reorders or advances a queue entry. Matching availability comes from cached metadata only; no provider search is triggered by previewing.
- Sessions persist, but app restarts restore them **paused**, never automatically selecting. Ordinary restart recovery needs new screen evidence and Resume, not a console restart.
- Storage failure disables console selections immediately. Restore database/filesystem availability, then use **Reconcile queue storage** in Admin. It records retained results and gameplay boundaries without retransmitting; ongoing failure stays visible. Successful recovery leaves the queue paused and requires new song-selection evidence and explicit Resume. Any unresolved transmitted request remains quarantined.
- A timed-out transmitted selection is different: it may still act later, so it blocks further console selections. If its result cannot resolve it, actually restart the game/console, then use the conditional **Confirm console restarted** action in Admin. Confirmation leaves the queue paused and clears old game observations. Stop cannot retract a command already sent.
- Use one app process per state directory, on a trusted LAN only. The Admin PIN gates the UI, not the APIs; UDP source filtering is not authentication.

#### Queue verification

The normal Jest suite covers decoder/source validation, real SQLite mutations, controller transitions, API/SSE, restart recovery and client state without a console. Optional Playwright checks use only synthetic localhost traffic:

- `node test/queue-workspace-browser.cjs` — workspace/navigation/control states, both themes and phone/desktop layouts.
- `node test/queue-picker-browser.cjs` — six theme/viewport cases, 5,000-song virtualization, two-client edits, accessible controls, repeats/Retry, previews and Admin recovery.
- `node test/queue-browser.cjs` — real app, SQLite, UDP decoder and SSE through two browsers; only Xbox selection is replaced with a fake transport. Proves progression, repeats, browser closure, completion, Start/Stop/Start during manual gameplay, and Admin storage reconciliation without retransmission.

Use an external Playwright installation via `PLAYWRIGHT_MODULE` if needed; `BROWSER_EXECUTABLE` can select an installed Chromium executable. Screenshots are written to an OS temporary directory. These checks do not prove physical-console or Docker-network delivery.

### Optional song previews

Song previews are **off by default**. In Admin → **Song previews**, choose the two-letter storefront country, enable background matching, and save. Confirm that Apple's preview terms permit your use before enabling; this project does not establish that permission. See [Apple's Search API terms](https://performance-partners.apple.com/resources/documentation/itunes-store-web-service-search-api/).

- **Preview** plays a confidently matched clip on the current phone/laptop without selecting it on the Xbox. Its button becomes **Stop** in the same row. There is no player box or separate playback toolbar; starting/stopping playback does not move the song list.
- The current row is highlighted while previewing. After Stop, end-of-clip, or Pick, a quieter **Last previewed** highlight remains until you preview another song. Tap Preview again to replay. One hidden shared audio element keeps playback intact while rows are virtualized; a compact, unboxed iTunes link/credit stays beneath the list.
- **Pick** stops preview playback before sending the selection; disabling previews or changing storefront clears the preview context.
- **Queued** means matching is pending; **No clip** means no sufficiently reliable match was found. Covers and different live/acoustic/remixed recordings are deliberately rejected.
- Audio streams directly from Apple after a tap. It requires internet and is not saved or proxied by this app. The player includes a store link, the official iTunes badge, and attribution; those alone do not establish permission for this use.
- A single background worker spaces Apple metadata requests at least **3.5 seconds apart** (roughly 17/minute). Retries share the same budget, honor `Retry-After`, and apply a persistent provider-wide cooldown. Apple's approximate 20/minute limit may change, and other apps sharing your public IP can still cause throttling.
- Jobs, matches, failed-match results, and request timing persist in SQLite. Restarting resumes work without refilling the rate budget. Disabling previews pauses work and hides playback; cached matches are retained.
- **Refresh library never re-matches unchanged successful songs.** Only new/changed metadata needs reassessment. Equivalent artist/title searches share cached candidates; changing only the album can often be resolved without another search. Refreshing 5,000 unchanged cached matches makes zero Apple requests.
- Unavailable results retry after 30 days by default (configurable from 1–365 for newly checked/cached results; existing deadlines are retained). Successful matches have no automatic expiry. Search-candidate metadata uses the same configured retention interval; audio is never cached. Ordinary browsing and Preview clicks never initiate an Apple search.
- Approximately 5,000 unique searches take **five hours** before retries. Progress is shown in Admin; song rows update their visible preview states without reloading the entire library.
- Changing the storefront uses a separate cache. Switching back reuses existing matches. Catalog availability differs by country.
- Run **one application process per state directory**. Multiple workers/processes or independent installations sharing an IP need additional rate-limit coordination and are not supported by this queue.

Manual match correction and other preview providers are not included in this first version. Preview errors do not automatically trigger provider re-searches, avoiding accidental API retry loops.

#### Preview verification

`npm test -- --runInBand` runs deterministic provider, matcher, rate-limit, real SQLite, API, and player tests without using Apple's quota. The integration suite includes a 5,000-song zero-repeat refresh check.

For optional Chromium UI checks, install Playwright outside the project or in your tooling environment, install its Chromium browser, then run `node test/preview-browser.cjs`. Set `PLAYWRIGHT_MODULE` to an absolute Playwright module path if it is installed externally. The smoke test uses synthetic audio and a temporary in-memory library, checks desktop/mobile playback and virtualization, and writes screenshots to an OS temporary directory. No Xbox, real library, or Apple API calls are used.

### API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/songs` | List songs (supports search, sort, list filter, duplicate filter) |
| `POST` | `/api/songs/refresh` | Reload library from Xbox |
| `POST` | `/api/songs/:shortname/pick` | Pick a song on the Xbox and increment pick count |
| `GET/POST` | `/api/config` | Read/write Xbox IP and port |
| `GET/POST` | `/api/settings` | Read/write UI feature toggles |
| `GET/POST/DELETE` | `/api/songlists` | Manage song lists |
| `GET` | `/api/local-url` | Get the local network URL (used to generate the QR code) |
| `GET/POST` | `/api/previews` | Read progress or save `{ enabled, country, negativeDays }` (default retry interval: 30 days) |
| `POST` | `/api/previews/lookup` | Read cached preview states for `{ shortnames: [...] }` (maximum 200); never calls Apple |
| `GET` | `/api/queue` | Authoritative `{ version, session, operation }` snapshot |
| `GET` | `/api/queue/events` | SSE `snapshot` and `diagnostics` updates |
| `POST` | `/api/queue/commands` | Revisioned/idempotent start, edit, control and console-restart recovery commands |
| `POST` | `/api/queue/storage/reconcile` | Explicit storage recovery, without retransmission; returns snapshot/diagnostics or 503 with ongoing storage failure |
| `GET` | `/api/queue/diagnostics` | UDP listener and observed game-state diagnostics |
| `GET/POST` | `/api/queue/preferences` | Read/save `{ pauseAfterAttempt: boolean }` |

### Configuration

- Set the Xbox IP address and port in the Admin UI, or pre-configure by copying `config.example.json` to `config.json` and editing it.
- `config.json` is generated locally on first run and is excluded from version control.
- Make sure `EnableHTTPServer=true` in `rb3.ini` on the Xbox.

### Data storage

- All data is stored in `songs.sqlite` (excluded from version control).
- Songs, pick counts, custom song lists, session queue snapshots, and command receipts are stored in the local database. Console/network settings and the pause-after-attempt preference are stored in `config.json`.
- The database is created automatically on first run.

### Feature toggles (Admin page)

Some UI features are off by default and can be enabled from the Admin page:

- **Song list management** — show/hide the create/edit/delete controls for song lists.
- **Duplicate filter button** — show a button to filter songs that appear more than once in the library (useful for auditing DLC packs with overlapping content).
- **Shortname column** — show the internal song shortname in the song table.
- **Export to CSV button** — show a button to export the current visible song grid (respects active search, sort, and list filter) to a CSV file.
