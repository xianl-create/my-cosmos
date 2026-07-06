# Deploying My Cosmos publicly (Render + private GitHub data repo)

The app runs in two modes from the same codebase:

| | Local (developer machine) | Public (hosted) |
|---|---|---|
| Trigger | default | `MY_COSMOS_PUBLIC=1` |
| Login | username only, no password | register (name + email + password, email-verified) + session token on every API call |
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

## Email verification (Resend)

In public mode, registration **always** collects **first name, last name, and a valid
email** (stored on the account). If `MY_COSMOS_RESEND_KEY` is also set, a new account
**cannot sign in until the email is confirmed**.
On register the server emails a one-time verification link (valid 24 h); clicking it flips
the account to verified. A "Resend verification email" button covers lost/expired links.
Names, email, and the `verified` flag live in `auth.json` (synced to the private data repo
like everything else). If `MY_COSMOS_RESEND_KEY` is unset, accounts are auto-verified — so
local/dev mode is completely unchanged.

1. Create a free account at [resend.com] and make an **API key**.
2. In the Render dashboard set `MY_COSMOS_RESEND_KEY`. The default sender
   `onboarding@resend.dev` works immediately for testing; for production set
   `MY_COSMOS_MAIL_FROM` to an address on a domain you've verified in Resend.
3. Verification links use `RENDER_EXTERNAL_URL` automatically. Only set
   `MY_COSMOS_PUBLIC_URL` to override (e.g. a custom domain).

## Two-tier storage & invite PINs

Public mode runs two account tiers:

- **Beta (PIN):** a user who redeems a valid invite PIN gets **persistent cloud storage**
  (synced to the private data repo) up to `MY_COSMOS_MAX_USER_MB`. One PIN → one account,
  consumed on redemption.
- **Ephemeral (no PIN):** anyone else can still use the app, but their graph stays **only in
  their browser**. The server stores just their email, account name, password hash, last
  login, and total usage — never their data.

`MY_COSMOS_PIN_COUNT` PINs are generated on first boot and stored in `pins.json` (private
data repo). When a beta user exceeds their cap, saves are refused and the app shows a red
**"storage limit reached — payment required"** alert; in-progress work is held in the browser.

**View the registry (PIN → account, last login, storage used):**

```bash
curl -s "https://<your-app>.onrender.com/api/admin/pins?token=$MY_COSMOS_ADMIN_TOKEN" | python3 -m json.tool
```

## Env var reference (additions)

| Var | Meaning |
|---|---|
| `MY_COSMOS_PUBLIC=1` | enable public mode (auth enforced, lockdowns active) |
| `MY_COSMOS_MAX_ACCOUNTS` | legacy hard cap (no longer blocks; ephemeral users are unlimited) |
| `MY_COSMOS_PIN_COUNT` | number of invite PINs to generate (default `50`) |
| `MY_COSMOS_MAX_USER_MB` | per-beta-user cloud storage cap in MB (default `50`) |
| `MY_COSMOS_ADMIN_TOKEN` | secret protecting `GET /api/admin/pins` |
| `MY_COSMOS_GH_REPO` | `owner/repo` of the private data repo (unset = sync off) |
| `MY_COSMOS_GH_TOKEN` | fine-grained PAT with Contents read/write on that repo |
| `MY_COSMOS_GH_BRANCH` | branch to sync (default `main`) |
| `MY_COSMOS_RESEND_KEY` | Resend API key — enables email verification (unset = auto-verify) |
| `MY_COSMOS_MAIL_FROM` | verification sender (default `My Cosmos <onboarding@resend.dev>`) |
| `MY_COSMOS_PUBLIC_URL` | base URL for verify links (default: `RENDER_EXTERNAL_URL` / request host) |
