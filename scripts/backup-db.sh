#!/usr/bin/env bash
# Takes a verified backup of the production database.
#
#   ./scripts/backup-db.sh                    # backs up $PGDATABASE or dir_v3, into ./backups
#   ./scripts/backup-db.sh dir_v3 /root/bak   # explicit database and destination
#
# Run it ON THE DATABASE SERVER: the dump is written at disk speed and compressed before it ever crosses the network, and
# pg_dump must be at least the server's version (PostgreSQL 18 dumps cannot be read by older tools).
#
# Custom format (-Fc), so the result is compressed and a single table can be restored without replaying the whole file:
#   pg_restore -U postgres -d <target> <file>              # whole database
#   pg_restore -U postgres -d <target> -t Company <file>   # one table
#
# The dump holds real personal data (director names and addresses, user accounts and password hashes). Keep it off shared
# storage, encrypt it at rest, and delete copies that are no longer needed.
set -euo pipefail

DB="${1:-${PGDATABASE:-dir_v3}}"
DEST="${2:-./backups}"
USER_="${PGUSER:-postgres}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DEST/${DB}_${STAMP}.dump"

mkdir -p "$DEST"

echo "==> Database: $DB (user $USER_)"
# Fail here rather than halfway through a dump if the database is not reachable or not there.
psql -U "$USER_" -d "$DB" -tAc 'SELECT version()' | head -1

echo "==> Contents before the dump"
# A dump of the wrong (or a half-restored) database is the failure this catches. Tables missing => the restore is incomplete.
for T in Company Director User; do
  N="$(psql -U "$USER_" -d "$DB" -tAc "SELECT count(*) FROM \"$T\"" 2>/dev/null || echo "?")"
  echo "    $T: $N"
done
echo "    (expected roughly: Company 14,026,901 / Director 357,574 - a '?' means the table is missing)"

echo "==> Dumping to $FILE"
pg_dump -U "$USER_" -d "$DB" -Fc -Z6 --no-owner --no-privileges -f "$FILE"

echo "==> Verifying"
# A dump file that exists is not a backup. A dump pg_restore can read and that lists its tables is.
if ! pg_restore -l "$FILE" > /dev/null 2>&1; then
  echo "!!! UNREADABLE: pg_restore cannot list this file. Do NOT rely on it." >&2
  exit 1
fi
OBJECTS="$(pg_restore -l "$FILE" | grep -c '^[0-9]' || true)"
SIZE="$(du -h "$FILE" | cut -f1)"

echo
echo "    File:    $FILE"
echo "    Size:    $SIZE"
echo "    Objects: $OBJECTS"
echo
if [ "$OBJECTS" -lt 20 ]; then
  echo "!!! Only $OBJECTS objects: this looks far too small for this schema (39 models). Check the database name." >&2
  exit 1
fi
echo "==> Backup verified. Copy it off this machine:"
echo "    scp <user>@<host>:$FILE ."
