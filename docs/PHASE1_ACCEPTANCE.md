# Phase One acceptance record

Date: 2026-10-23

## Implemented

- Node 24 TypeScript-stripping service with SQLite WAL persistence, HTTP endpoints, and authenticated WebSocket observations.
- 15×15 freestyle Gomoku rules and a local zero-model-token opponent. The server randomly assigns sides and the opening move in each new UI game; the page shows the human side.
- Human actions use `requestId` and `expectedVersion`; requests replay idempotently and stale actions are rejected.
- Human seat token is stored only as a SHA-256 hash and is never accepted in URLs. WebSocket access requires a token in the first frame.
- Refresh and service restart recover the same game from SQLite.
- Normal play UI hides decision-source details. The default-closed “走子记录” dialog shows the recorded source for each move when opened.
- `mock` companion path is exercised through the authenticated API; it is explicitly recorded as `mock` and does not call a model.
- Game-only usage table, authenticated per-game usage view, `pnpm usage` CLI, and in-page project/current-game totals are in place. New Worker usage is pushed over the existing WebSocket; no model polling is used. Only usage reported by the game Worker enters this table; QQ chat totals are excluded. No real DSH usage exists in Phase One.
- New project remains separate from the existing QQ bridge and DSH profile.

## Verification

- `pnpm check` — passed, including server, store, Gomoku and browser script syntax.
- `pnpm test` — passed: rules, invalid actions, wins, 100 local Bot-vs-Bot games, seat authentication, URL-token rejection, WebSocket auth, idempotent replay, and restart recovery.
- Browser interaction — completed three full local games, opened the move-history dialog, and verified the main game view does not show model/local-AI source labels.
- The chessboard grid overlay is drawn at the same 15×15 cell centers as clickable intersections; see `web/index.html` and `web/styles.css`.

## Scope boundary

Phase One does not call a real model, modify the existing bridge, connect QQ, or implement other games. Those remain future-phase work.



## Phase 2 Gomoku test readiness

- The web game starts in `hybrid` mode and randomly assigns black/white and the opening move. Normal turns use the local algorithm. A one-step win or must-block threat dispatches one compact task to the separate Route A Worker; the server accepts only one of its current legal candidate IDs.
- The per-game decision attempt limit is configurable up to 8. Worker/API failures and interrupted pending turns use a local fallback, recorded distinctly in move history.
- The Worker has no DSH/QQ history, MCP tools, database access, or shell access. It only calls an explicitly configured OpenAI-compatible endpoint and returns a candidate ID. Actual provider usage is saved and pushed to the page when reported by the provider.
- `pnpm check` and `pnpm test` pass, including a mocked provider test and end-to-end server/Worker callback test. These tests make no external model requests and spend no model tokens.
- Real Route A/DSH model testing still needs a valid direct model API endpoint, key, and model name. The audited DSH desktop `deepseek-account` session does not provide a safely reusable API key; starting the desktop app alone does not connect it to this Worker. No DSH or QQ bridge files were changed.