#!/usr/bin/env bash
# Production scheduler supervisor for LINUX servers. Keeps scripts/scheduler.ts running and restarts it if it exits or crashes.
#
#   bash <REPO_ROOT>/scripts/run-production-scheduler.sh
#
# Start it from a Plesk / cron scheduled task (e.g. @reboot AND every 5 minutes: the single-instance lock below makes a second
# launch exit at once), or from a systemd unit (see docs/PRODUCTION_SCHEDULER.md) if you have root.
#
#   - works from the REPOSITORY ROOT (the folder holding scripts/, src/, node_modules/), never from .next/standalone;
#   - runs:  node node_modules/tsx/dist/cli.mjs scripts/scheduler.ts
#   - configuration: process environment first, <REPO_ROOT>/.env second (scripts/load-env.ts). Nothing is printed from either;
#   - single instance via flock; the scheduler additionally holds a database lease;
#   - restart delay by exit code: 2 (database guard refused: fix .env) 300 s, 3 (another scheduler owns the jobs) 120 s, else 15 s;
#   - graceful stop: SIGTERM to this script (or `touch` the stop file): the scheduler finishes its request, saves its checkpoint, exits.
#
# Environment overrides: SCHEDULER_LOG_DIR, SCHEDULER_STOP_FILE, SCHEDULER_MAX_LOG_MB (default 20).
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

LOG_DIR="${SCHEDULER_LOG_DIR:-$REPO/tmp-ingest/logs}"
STOP_FILE="${SCHEDULER_STOP_FILE:-$REPO/tmp-ingest/production-scheduler.stop}"
MAX_MB="${SCHEDULER_MAX_LOG_MB:-20}"
mkdir -p "$LOG_DIR" "$(dirname "$STOP_FILE")" || exit 1
LOG="$LOG_DIR/scheduler.log"
LOCK="$LOG_DIR/scheduler.supervisor.lock"

say() { printf '[%s] supervisor: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG"; }

# ---- single instance ---------------------------------------------------------------------------------------------------------
if ! command -v flock >/dev/null 2>&1; then say "PREFLIGHT FAILED: flock is not installed (util-linux)"; exit 1; fi
exec 9>"$LOCK"
flock -n 9 || exit 0

# ---- preflight ---------------------------------------------------------------------------------------------------------------
TSX="$REPO/node_modules/tsx/dist/cli.mjs"
command -v node >/dev/null 2>&1 || { say "PREFLIGHT FAILED: node is not on PATH for this user"; exit 1; }
[ -f "$TSX" ] || { say "PREFLIGHT FAILED: node_modules/tsx is missing. Run 'npm ci' (WITH dev dependencies) in $REPO, then 'npx prisma generate'"; exit 1; }
[ -f "$REPO/scripts/scheduler.ts" ] || { say "PREFLIGHT FAILED: scripts/scheduler.ts not found under $REPO (is this the repository root?)"; exit 1; }
if [ -z "${DATABASE_URL:-}" ] && [ ! -f "$REPO/.env" ]; then say "PREFLIGHT FAILED: DATABASE_URL is not set and $REPO/.env does not exist"; exit 1; fi
[ -f "$REPO/.env.local" ] && say "WARNING: .env.local exists in the repository root. The scheduler ignores it, but remove it from a server."

export NODE_ENV=production
export SCHEDULER_STOP_FILE="$STOP_FILE"
export LOG_FORMAT="${LOG_FORMAT:-json}"

rotate() {
  [ -f "$LOG" ] || return 0
  local size; size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt $((MAX_MB * 1024 * 1024)) ]; then
    for i in 4 3 2 1; do [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"; done
    mv -f "$LOG" "$LOG.1"
  fi
}

CHILD=""
STOPPING=0
# A signal (server shutdown, service stop) stops this supervisor for THIS boot only; it must not leave a stop file behind, or the
# scheduler would never start again after a reboot. The stop FILE is the explicit, persistent "keep it stopped" switch.
on_term() { STOPPING=1; say "signal received: stopping scheduler gracefully"; [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null; }
trap on_term TERM INT HUP

while [ ! -f "$STOP_FILE" ] && [ "$STOPPING" -eq 0 ]; do
  rotate
  say "starting scheduler (repo $REPO)"
  node "$TSX" scripts/scheduler.ts >>"$LOG" 2>&1 &
  CHILD=$!
  wait "$CHILD"; CODE=$?
  CHILD=""
  DELAY=15; [ "$CODE" -eq 2 ] && DELAY=300; [ "$CODE" -eq 3 ] && DELAY=120
  say "scheduler exited (code $CODE); restarting in ${DELAY}s unless the stop file exists"
  for ((i = 0; i < DELAY; i++)); do { [ -f "$STOP_FILE" ] || [ "$STOPPING" -eq 1 ]; } && break; sleep 1; done
done
say "stopping: stop file or signal, exiting"
