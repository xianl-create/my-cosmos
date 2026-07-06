#!/bin/bash
# Local → cloud data sync daemon (launched by the LaunchAgent, or run by hand).
#
# Mirrors THIS machine's edits to one account's data (graph + agents) up to the
# hosted My Cosmos server, which persists them to the private GitHub data repo.
# It authenticates with the server's sync/admin token (read from the gitignored
# DEPLOY-KEYS.txt) so it NEVER logs in and never kicks your online browser session.
#
# App CODE is never touched by this — only user DATA. Code changes still require an
# explicit git push + Render deploy.
#
# Manual run:  bash scripts/sync-daemon.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

KEYS="$REPO/DEPLOY-KEYS.txt"
if [[ -f "$KEYS" ]]; then
  # Pull the admin token (doubles as the sync token) out of the keys file.
  TOKEN="$(grep -E '^MY_COSMOS_ADMIN_TOKEN=' "$KEYS" | head -1 | cut -d= -f2- | tr -d ' \r')"
fi

if [[ -z "${TOKEN:-}" ]]; then
  echo "sync-daemon: MY_COSMOS_ADMIN_TOKEN not found in $KEYS" >&2
  exit 1
fi

export MC_SYNC_TOKEN="$TOKEN"
export MC_USER="${MC_USER:-xianl}"
export MC_CLOUD_URL="${MC_CLOUD_URL:-https://my-cosmos.onrender.com}"

NODE="$(command -v node || echo /opt/homebrew/bin/node)"
exec "$NODE" scripts/sync-to-cloud.js
