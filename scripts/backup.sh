#!/bin/sh
# Daily database backup with retention. Run from cron, e.g.:
#   15 2 * * *  DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=aayme BACKUP_DIR=/var/backups/aayme /path/to/backup.sh
# Restore:  gunzip -c aayme-YYYYmmdd-HHMMSS.sql.gz | mysql -h HOST -u USER -p DBNAME
# TEST A RESTORE regularly: an untested backup is not a backup.
set -eu

: "${DB_HOST:?}" "${DB_USER:?}" "${DB_PASSWORD:?}" "${DB_NAME:?}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/aayme-$(date +%Y%m%d-%H%M%S).sql.gz"

# --single-transaction = consistent snapshot without locking the live app (InnoDB)
MYSQL_PWD="$DB_PASSWORD" mysqldump -h "$DB_HOST" -P "${DB_PORT:-3306}" -u "$DB_USER" \
  --single-transaction --routines --triggers --no-tablespaces "$DB_NAME" | gzip > "$FILE"

# refuse to call an empty/corrupt file a success
[ "$(gzip -dc "$FILE" | grep -c 'CREATE TABLE')" -ge 15 ] || { echo "backup looks incomplete: $FILE" >&2; rm -f "$FILE"; exit 1; }

find "$BACKUP_DIR" -name 'aayme-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
