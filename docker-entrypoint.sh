#!/bin/sh
set -e

DATA_DIR="${MODELGATE_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
