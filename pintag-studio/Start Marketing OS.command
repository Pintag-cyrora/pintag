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

if curl -s -o /dev/null "$URL" 2>/dev/null; then
  echo "Marketing OS is already running — opening your browser."
  open "$URL"
  sleep 2
  exit 0
fi

echo "Starting Marketing OS..."
( sleep 2 && open "$URL" ) &

npm run founder-ui
