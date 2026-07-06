# My Cosmos — Version Stamps

Tagged snapshots of the **app code** for safe rollback. Local (`localhost:3000`) and
online (Render) are always deployed from the same Git commit, so **one tag captures
both**. Each row below is an annotated Git tag pinned to an exact commit.

> **Scope:** these stamps track **app code only** (`index.html`, `js/app.js`,
> `scripts/…`, `css/…`). They do **not** touch **user data** — that lives in the
> private `my-cosmos-data` repo and is synced continuously. Rolling code back to an
> older version never rewinds anyone's data.

## Conventions

- Tag names: `v<N>_<YYYY-MM-DD>` (e.g. `v1_2026-07-06`). `v1` is the base.
- Each real "we decided to push this" milestone gets the **next** number.
- Cosmetic/data commits between milestones are not stamped.

## How to use these stamps

```bash
# See what changed since a version
git diff v1_2026-07-06 -- .

# Inspect a version
git show v1_2026-07-06

# Roll the working tree back to a version (safe, detached)
git checkout v1_2026-07-06

# Hard reset main to a version (destructive — only when you mean it)
git reset --hard v1_2026-07-06 && git push --force-with-lease origin main
```

**To roll the ONLINE app back to a stamped version:** point `main` at that tag (or
cherry-pick), push, then trigger a Render deploy (autoDeploy is off, so deploys are
manual/triggered).

## Versions

| Tag | Timestamp | Commit | Render deploy | Notes |
|-----|-----------|--------|---------------|-------|
| `v1_2026-07-06` | 2026-07-06 16:01 EDT (UTC-4) | `32712d7` | `dep-d960j2mq1p3s73e130dg` | **Base version.** Local + online in sync. Includes email verification, tiered accounts (beta PINs + ephemeral), stateless single-device sessions, local→cloud data sync daemon, and phone UI (bigger toolbars, larger task text, touch todo-edge drag). |
