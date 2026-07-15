#!/bin/bash
# Double-click this file (in Finder) to start Marketing OS's Founder
# Workspace — no Terminal typing required. This window IS the app running:
# closing it stops Marketing OS, the same way closing any other app would.
#
# First time only: copy .env.example to .env.local in this same folder and
# fill in your Supabase project's URL and service role key — see SETUP.md.
# If macOS says it can't verify the developer of this file the first time
# you double-click it, right-click it and choose "Open" once instead.

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4321}"
URL="http://127.0.0.1:${PORT}/"

# A single attempt at reaching the server — any completed response (even an
# HTTP error status) counts as "responding"; only a failed connection
# (nothing listening yet) counts as not ready.
server_responding() {
  curl -s -o /dev/null --max-time 1 "$URL" 2>/dev/null
}

if server_responding; then
  echo "Marketing OS is already running — opening your browser."
  open "$URL"
  exit 0
fi

echo "Starting Marketing OS..."

# Job control, so the backgrounded job below gets its own process group —
# npm doesn't reliably forward SIGHUP/SIGTERM to the node process it spawns,
# so killing just npm's own PID can leave the real server running orphaned.
# Killing the whole group (negative PID) below catches it regardless.
set -m
npm run founder-ui &
SERVER_PID=$!
set +m

trap 'kill -- -"$SERVER_PID" 2>/dev/null' EXIT

echo "Waiting for Founder Workspace..."

# Poll instead of guessing a fixed delay — startup time varies by machine,
# and a fixed sleep is either too short (browser opens to "can't connect,"
# the original bug) or too long on a fast machine. 60 tries at 0.5s apart
# gives it up to 30 seconds before giving up.
READY=""
for _ in $(seq 1 60); do
  if server_responding; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    # The server process already exited — no point continuing to poll.
    break
  fi
  sleep 0.5
done

if [ -n "$READY" ]; then
  echo "✓ Founder Workspace ready"
  echo "Opening browser..."
  open "$URL"
  wait "$SERVER_PID"
else
  echo ""
  echo "Founder Workspace failed to start."
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "The server is still running but never responded at $URL within 30 seconds."
  else
    echo "The server process exited on its own before it started listening."
  fi
  echo "Check the output above for the actual error, fix it, then close this window and try again."
  echo ""
  read -n 1 -s -r -p "Press any key to close this window..."
  echo ""
  exit 1
fi
