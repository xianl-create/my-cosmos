#!/bin/bash
# My Cosmos — start local server and open the app in your browser.
# The browser uses the same fonts as double-clicking index.html (css/app.css).
# Server output goes to .server.log so Terminal stays minimal (no heavy monospace log stream).

cd "$(dirname "$0")"
APP_DIR="$(pwd -P)"
LOG="$APP_DIR/.server.log"
PIDFILE="$APP_DIR/.server.pid"
URL="http://localhost:3000/index.html"

if ! command -v node &>/dev/null; then
  osascript -e 'display dialog "Node.js is not installed or not in PATH. Install Node.js, then try again." buttons {"OK"} default button "OK" with icon stop' 2>/dev/null || echo "Node.js not found."
  exit 1
fi

if curl -sf "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
  open "$URL" 2>/dev/null || open "http://127.0.0.1:3000/index.html"
  exit 0
fi

if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Port 3000 is in use (not our health check). Opening browser anyway."
  open "$URL" 2>/dev/null || true
  exit 0
fi

cd "$APP_DIR" || exit 1
: >"$LOG"
nohup node scripts/server.js >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"

echo "Waiting for server..."
READY=""
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.4
done

if [ -n "$READY" ]; then
  open "$URL" 2>/dev/null || open "http://127.0.0.1:3000/index.html"
else
  osascript -e 'display notification "Server is slow to start. See .server.log in this folder." with title "My Cosmos"' 2>/dev/null || true
  open "$URL" 2>/dev/null || true
fi

echo ""
echo "Server running in the background. Full log: $LOG"
echo "Stop server: kill \$(cat \"$PIDFILE\")"
echo ""
read -r -p "Press Enter to close this window... " _
