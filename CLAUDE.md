# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Run / develop

No build step, no `package.json`, no test runner. Everything is static + a zero-dep Node server.

- **Start the app:** double-click `start.command`, or `node scripts/server.js` then open <http://localhost:3000/index.html>. The script writes server output to `.server.log` and the PID to `.server.pid`.
- **Health check / "is the server running":** `curl -sf http://127.0.0.1:3000/api/health`. `start.command` polls this; `index.html` shows a launcher overlay when opened via `file://` and auto-redirects to localhost as soon as it answers.
- **Stop the server:** `kill $(cat .server.pid)`.
- **Refresh `file://` preload after editing data on disk:** `node scripts/prepare.js`. Chrome blocks `fetch()` to `./data/*.json` from `file://`, so this script writes `data/file_boot.js` (a `window.__PRELOAD_USER_DATA__ = …` script tag) and `data/users_index.json`. The server does the equivalent automatically on each save.
- **Override server config (env vars):** `MY_COSMOS_PORT` / `PORT`, `MY_COSMOS_DATA` (data dir; legacy `PROGRESS_TRACKER_DATA` still honored), `MY_COSMOS_EMBED_PRELOAD=1` (embed first user into `index.html` on save), `TICKETMASTER_API_KEY`, `MY_COSMOS_OLLAMA_HOST/PORT/MODEL`, `MY_COSMOS_GPT2_MODEL`, `MY_COSMOS_PYTHON`.

## Architecture

This is a single-user-per-browser, single-page app for visualizing tasks as a nested D3 force-directed graph. The codebase is intentionally **three big files** plus a tiny server — there is no module system, no bundler, and no framework.

### The three files that matter
- `index.html` (~1.3k lines) — all DOM for every screen (login, wizard, main app, calendar, progress, notes, settings) is in this one file. Screens are sibling `<div class="screen">` elements toggled by `swView()`. Modals follow the `m-cal-event` pattern (see `guideline.md` "Modal Window Style Standard").
- `js/app.js` (~26k lines) — the entire client. Globals you'll see everywhere: `G` (the user's full graph: `nodes`, `edges`, `workspaces`, `displayName`, …), `CU` (current username), `ST` (the storage layer), `viewStack` / `expandedId` / `expandedIds` (navigation state). No imports, no `module.exports` — everything is hoisted at the top level.
- `css/app.css` (~1k lines) — the visual baseline. **Frozen by default** (see `.cursor/rules/frozen-app-styles.mdc`): logic-only changes must not touch `app.css` or inline styles in `index.html`. Only edit when the user explicitly asks for a visual change.

### Storage model (read this before touching save/load code)
The canonical user file is `data/{username}_data.json` — one JSON file per user, containing `nodes`, `edges`, `workspaces`, `displayName`, `lastSaved`. There are **three independent storage backends** the client falls through, defined in `ST` (`js/app.js:342`):
1. **Local server** — `POST /api/data/:user` writes the canonical JSON via `atomicWriteFileSync` (temp file + rename). This is the only path that produces durable disk files.
2. **File System Access API** — when the user picks the `data/` folder in Chrome/Edge from `index.html` opened directly.
3. **IndexedDB** (`MyCosmos`, store `users`), with `localStorage` (`MyCosmos_users`) as the last-resort fallback for `file://`.

The save fan-out is `sv()` → debounced → `ST.save(CU, G)` → tries server, then writes IndexedDB, then localStorage. **Any data mutation must go through `svWithUndo()`** so undo/redo works (it pushes onto a 10-deep undo stack before mutating). Direct `sv()` calls skip undo.

Server-side recovery: if `data/{user}_data.json` is empty or missing a graph payload, `GET /api/data/:user` falls back to the most recent matching savepoint in `data/savepoints/` and rewrites the canonical file. Don't "clean up" empty user files manually — the server treats them as corrupt and recovers.

### Server endpoints (`scripts/server.js`)
Zero npm dependencies, plain `http`. Routes:
- `GET /api/health` — liveness + reports `dataDir`.
- `GET /api/users` — lists user files (excludes `template-user_data.json`, `users_index.json`, savepoints).
- `GET|POST|DELETE /api/data/:user` — load / save / delete the canonical user JSON. POST also calls `updatePreload()` which keeps `data/file_boot.js` in sync.
- `POST /api/savepoint/:user` — write `data/savepoints/{user}_sp_{ts}.json`; pruned automatically.
- `GET /api/savepoints/:user` — list savepoints for a user.
- `POST /api/interstellar-events` — proxies Ticketmaster Discovery API (server holds the key).
- `POST /api/agents-local` — local LLM inference for the Agents page. Two backends: GPT-2 via `python3 scripts/agents_local_infer.py` (HuggingFace transformers), or Ollama at `127.0.0.1:11434` (`/api/generate`, falling back to `/api/chat`).

### Navigation invariants (from guideline.md, easy to break)
- **Empty-space click resets to root**: closes spheres, resets `viewStack=[]`, `expandedId=null`, `expandedIds.clear()`, calls `zFit()`, briefly highlights all top-level nodes. Must set `window._preventAutoExpand=true` before `zFit()` and clear it ~2s later, otherwise `autoZoom()` immediately re-expands the largest node and the user gets a flicker loop.
- **`autoZoom()` auto-expand condition** must include all of: `coverage>0.6 && expandedIds.size===0 && !expandedId && viewStack.length>0 && !window._preventAutoExpand && ns.length>0`. Dropping `viewStack.length>0` causes auto-expansion at root; dropping the `_preventAutoExpand` check causes the reset loop.
- **Selector** (red outline) must always land on the largest visible node after any level change. Call `initializeNodeSelector()` after `enterN()`, `goUp()`, `goRoot()`, and reset-to-root, with a 200–400ms delay so the simulation has settled.
- **All node levels behave identically** — never special-case content-nodes-inside-spheres differently from top-level nodes.

## Working in this codebase

- **Read `guideline.md` first for any non-trivial UI work.** It is the de-facto spec: per-page component lists, critical-function names, the keyboard-shortcut matrix, modal style standard, and icon style guide. The "⚠️ DO NOT MODIFY" callouts there reflect real past breakages.
- **Preserve existing functions.** The strong project convention is *add new functions; don't change signatures or behavior of existing ones* unless the task is explicitly to change them. New features should be new code paths.
- **Don't touch `css/app.css` or inline styles** for logic-only tasks (see `.cursor/rules/frozen-app-styles.mdc`). The frozen baseline is `_records/my-cosmos/v122`.
- **`data/` is real user data**, not fixtures. `xianl_data.json` is ~28 MB. Don't reformat, sort, or "clean" these files — the server rewrites them with `JSON.stringify(data, null, 2)` and treats anything without a graph payload as corrupt. Savepoints in `data/savepoints/` are the recovery source.
- **Two name-migration paths exist**: `ProgressTracker` → `MyCosmos` for `localStorage` keys (`js/app.js`), and `~/.progress-tracker/data` / `~/.my-cosmos/data` → project `data/` for the server's first-run migration (`scripts/server.js`). Keep both legacy paths working when editing storage code.
