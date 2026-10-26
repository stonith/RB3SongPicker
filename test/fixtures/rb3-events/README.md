# RB3Enhanced v0 fixture matrix

## Provenance

`packets.json` contains **synthetic**, hand-encoded physical-Xbox big-endian packets, not hardware captures. They follow upstream revision `b4678376f503744f8be2f6b0fea3cb56227415f7`:

- [`include/net_events.h`](https://github.com/RBEnhanced/RB3Enhanced/blob/b4678376f503744f8be2f6b0fea3cb56227415f7/include/net_events.h): packed header, event/platform IDs and payload sizes.
- [`source/net_events.c`](https://github.com/RBEnhanced/RB3Enhanced/blob/b4678376f503744f8be2f6b0fea3cb56227415f7/source/net_events.c): native-endian sending, 255-byte payload cap, initialization-only ALIVE.
- [`source/GameHooks.c`](https://github.com/RBEnhanced/RB3Enhanced/blob/b4678376f503744f8be2f6b0fea3cb56227415f7/source/GameHooks.c): shortname, optional title/artist, band, STATE 1 at construction; STATE 0 at destruction.
- [`source/rb3enhanced.c`](https://github.com/RBEnhanced/RB3Enhanced/blob/b4678376f503744f8be2f6b0fea3cb56227415f7/source/rb3enhanced.c): SCREEN_NAME from presence updates.

No installed build or console was contacted. The loopback integration test only sends these fixtures to a local test socket. Tests dynamically construct malformed packets, maximum-length strings and irrelevant binary events.

## Supported observations and fail-closed cases

| Input/sequence | Expected observation |
| --- | --- |
| Exact configured IPv4 source, physical Xbox platform 0, BE magic, version 0, exact length | Decode with local receive timestamp; source port is not an identity gate |
| Non-NUL string or one optional terminal NUL; up to 255 payload bytes | Decode; unsigned length, maximum datagram 263 bytes |
| Wrong source/platform/endian/magic/version/type/size; malformed STATE/binary payload; invalid UTF-8 or embedded NUL/control characters | Drop, no game evidence mutation |
| Valid SCORE/STAGEKIT/BAND_INFO/DX_DATA | Validate/copy payload, never infer lifecycle or readiness |
| Valid title/artist/venue | Display-only/irrelevant to identity; cannot establish an attempt |
| SCREEN_NAME song_select_screen | Immediately offer selection opportunity without another readiness gate |
| Repeated same screen, including after opportunity consumption | Preserve same opportunity; never authorize a duplicate dispatch |
| Different screen | Invalidate selection readiness; returning selection creates another opportunity |
| ALIVE then silence | Last-observed context only; neither ready nor connected/disconnected |
| Known selection screen then arbitrary silence | Still valid, no heartbeat/age/debounce expiry |
| Shortname then STATE 1 within 1,000ms (inclusive) | One uniquely identified attempt, no successful-playback claim |
| Optional construction metadata/band | Does not delay the attempt or supply missing identity |
| Duplicate shortname/STATE 1 while active | Same attempt; no new start |
| STATE 0 after active attempt, including duplicate STATE 0 | One end, no completion/quit/failure classification |
| End then new identity/STATE 1, even identical shortname | Distinct attempt identity |
| Selection screen before end | Not a post-end opportunity; requires selection observation after end |
| STATE 1 before identity, conflicting identity, STATE 0 during partial construction, expired identity | Latched uncertainty, epoch invalidated; no synthetic start/end/readiness |
| Identity alone exceeding construction window | Incomplete-construction uncertainty, never an invented completion |
| Startup/listener restart/error/close/endpoint change/shutdown/explicit reset | Clear observations and require new screen event |
| Bind failure | Nonfatal diagnostic; browsing integration can remain available |

The construction correlation window is not a screen readiness delay or screen expiry. This implementation deliberately supports identity-before-STATE ordering only, rather than guessing when STATE arrives first. Duplicate identity does not extend the window. UDP cannot distinguish a lost boundary or delayed old packet that exactly imitates a coherent new boundary; these fixtures do not claim exactly-once network correlation.

## U3/U4 integration contract

- `rb3-events.js` exports `decodePacket(packet, remote, { sourceAddress, receivedAt })` (observation or `null`) and `Rb3Events(config, { now, createSocket })`. Configuration requires a literal IPv4 `sourceAddress`; optional `bindAddress` defaults to `0.0.0.0`, `port` to `21070`. Other platforms/endian formats are unsupported, not auto-detected.
- Subscribe to listener `observation` and `invalidate` before `start()`. Feed decoded observations synchronously into `GameState.observe()` and invalidations into `GameState.reset(reason)` so evidence changes can invalidate unsent reservations immediately. `start()` resolves `true`/`false`; socket/bind errors are diagnostics, not unhandled EventEmitter errors. `configure()` validates before replacing the endpoint, closes the old socket, invalidates and starts the replacement. `stop()` closes and invalidates. Obsolete socket callbacks cannot supply evidence.
- `GameState` is exported as a CommonJS class with injectable `now` and `identityWindowMs` (default 1,000). `observe()`, `expire(at = now())` and `snapshot()` return detached evidence snapshots. The controller should call `expire()` while partial construction is pending (or on its regular reconciliation tick); no hidden timer runs here. Silence during active gameplay does not end an attempt.
- `snapshot().canSelect` means an unconsumed accepted song-selection observation, no active/partial attempt and no uncertainty. It is **not** queue ownership/transport authorization. U3 must additionally require a running queue, pending entry and no unresolved command/gameplay. Do not add screen-age, ALIVE, readiness-probe, debounce or hardware-approval gates.
- Capture `screen.epoch`/`screen.opportunityId` in reservations and revalidate immediately before sending. `consumeSelectionOpportunity(id)` returns `true` once; duplicate notifications cannot replenish it. It does not perform HTTP or advance any queue entry.
- `transition` emits `attempt-started`, `attempt-ended`, `uncertain` and `reset`. Start/end events include the actual shortname and a distinct epoch-qualified attempt ID. Correlate these with the expected locked queue entry in U3; this layer does not know queue disposition, pause policy, expected identity, HTTP acknowledgement or outcome.
- Uncertainty invalidates the epoch/screen and remains latched, even after a selection event, until explicit controller-authorized reset. Its event includes the previous active attempt when present. Reset only clears observed evidence: it must never reconcile an unresolved console operation or silently resolve gameplay/queue progress. U3 owns those durable safety decisions.
- U4 must wire listener lifecycle to controller pause/invalidation; neither module is composed into `server.js` in U1. Ordinary application restart and operation-bound console-restart recovery remain U3/U4 responsibilities.
