# Deploying My Cosmos publicly (Render + private GitHub data repo)

The app runs in two modes from the same codebase:

| | Local (developer machine) | Public (hosted) |
|---|---|---|
| Trigger | default | `MY_COSMOS_PUBLIC=1` |
| Login | username only, no password | register + password, session token on every API call |
| Left rail | all tabs | Home / Calendar / Notes / Agents / Settings only |
| Page drag-rearrange | on | off |
| `data/` over HTTP | served (file:// support) | blocked (except the account template) |
| `/api/users`, local-LLM, Story, Interstellar APIs | open | loopback-only |
| User data durability | project `data/` on disk | disk (ephemeral) + synced to a **private** GitHub repo |

Nothing changes on this machine: never set `MY_COSMOS_PUBLIC` locally.

## 1. Create the private data repo

1. On GitHub create a **private** repo, e.g. `yourname/my-cosmos-data`. Leave it empty (no README needed — an empty repo is handled).
2. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings → Fine-grained tokens.
   - Repository access: *only* `yourname/my-cosmos-data`.
   - Permissions: **Contents → Read and write**. Nothing else.
   - Set a long expiry and put a calendar reminder to rotate it.

The server mirrors its data directory into that repo: `{user}_data.json`, `auth.json`
(scrypt password hashes — no plaintext), and `{user}/agents/**`. Every push is a
commit, so **git history doubles as the savepoint/version trail**. Savepoint files
themselves are not synced.

## 2. Create the public code repo

```bash
# from the project root — .gitignore already excludes data/ (except the template)
git init -b main
git add -A
git status   # VERIFY: no data/*.json except template-user_data.json
git commit -m "My Cosmos"
gh repo create yourname/my-cosmos --public --source . --push
```

## 3. Create the Render service

1. Render dashboard → New → Web Service → connect `yourname/my-cosmos`.
   `render.yaml` in the repo pre-fills everything (free plan, `npm install --omit=optional`,
   `node scripts/server.js`, health check `/api/health`).
2. Set the two secret env vars in the dashboard:
   - `MY_COSMOS_GH_REPO` = `yourname/my-cosmos-data`
   - `MY_COSMOS_GH_TOKEN` = the fine-grained PAT
3. Deploy. Boot log should show `Mode: PUBLIC` and `GitHub sync: yourname/my-cosmos-data@main`.

## How the pieces behave in production

- **Boot hydrate**: on every start the server downloads any repo file missing from
  its local data dir (local files win). This is what makes Render's free-tier
  ephemeral disk safe.
- **Save path**: writes hit local disk immediately; each changed file is pushed to
  GitHub after a 15 s debounce, serialized so commits never race. `SIGTERM`
  (redeploy/restart) flushes pending pushes before exit.
- **Sessions** are in-memory: a restart/redeploy signs everyone out; they log back
  in. Passwords live in `auth.json` as scrypt hashes.
- **Free-tier spin-down**: Render free services sleep after ~15 min idle; the first
  visit after that takes ~30–60 s to wake. Upgrading to Starter removes this.
- **Agents page limits on the hosted instance**: local-LLM inference
  (`/api/agents-local`), the Story Studio, the in-app terminal, and the Anthropic
  proxy are loopback-only or disabled — the Agents page UI and archive work, but
  "run" needs a future cloud-inference path.
- **Testing public mode locally** (loopback requests are exempt from some blocks,
  so test data-route auth specifically):

  ```bash
  MY_COSMOS_PUBLIC=1 MY_COSMOS_PORT=3456 MY_COSMOS_DATA=/tmp/pubtest node scripts/server.js
  ```

## Env var reference (additions)

| Var | Meaning |
|---|---|
| `MY_COSMOS_PUBLIC=1` | enable public mode (auth enforced, lockdowns active) |
| `MY_COSMOS_GH_REPO` | `owner/repo` of the private data repo (unset = sync off) |
| `MY_COSMOS_GH_TOKEN` | fine-grained PAT with Contents read/write on that repo |
| `MY_COSMOS_GH_BRANCH` | branch to sync (default `main`) |
