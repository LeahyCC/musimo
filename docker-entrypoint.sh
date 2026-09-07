#!/bin/sh
set -eu
PUID=${PUID:-1000}
PGID=${PGID:-1000}
case "$PUID:$PGID" in *[!0-9:]*|:*|*:) echo 'PUID and PGID must be numeric' >&2; exit 1;; esac
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo 'Use non-root PUID and PGID values' >&2
  exit 1
fi
umask 077
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /data/tmp
  chown "$PUID:$PGID" /data /data/tmp
  find /data -maxdepth 1 -type f -name 'musimo.sqlite3*' -exec chown "$PUID:$PGID" {} +
  exec gosu "$PUID:$PGID" "$@"
fi
exec "$@"
