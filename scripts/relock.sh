#!/usr/bin/env sh
# Rewrites the exported requirements files from uv.lock:
#   requirements.lock, worker/requirements.lock,
#   worker/beat/requirements-cpu.lock and worker/beat/requirements-gpu.lock
# Run it on a Dependabot Python PR, then commit the result.
# scripts/check.sh full calls it with a temp directory and diffs the output, so
# these are the only copies of the export flags.
#   scripts/relock.sh          write into the repository
#   scripts/relock.sh DIR      write the same layout under DIR
set -eu

cd "$(dirname "$0")/.."
dest="${1:-.}"
mkdir -p "$dest/worker/beat"

export_lock() {
  out="$1"
  shift
  uv export --locked --no-header --no-emit-project --format requirements-txt --output-file "$dest/$out" "$@" > /dev/null
}

export_lock requirements.lock --no-dev
export_lock worker/requirements.lock --project worker
# The tempo-beat-v1 images: one lock, exported once for the CPU and once for CUDA.
for variant in cpu gpu; do
  export_lock "worker/beat/requirements-$variant.lock" --project worker/beat --extra "$variant"
done
