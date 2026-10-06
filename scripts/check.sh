#!/usr/bin/env sh
# Runs the checks GitHub Actions used to run on every push and pull request.
# CI is manual-only now, so these run on your machine instead:
#   scripts/check.sh fast     lint, format and dependency locks (pre-commit hook)
#   scripts/check.sh full     fast + types, tests, build and audits (pre-push hook)
#   scripts/check.sh browser  Docker smoke and Playwright suite (run by hand)
# Skip a hook once with `git commit --no-verify` or `git push --no-verify`.
set -eu

mode="${1:-full}"
cd "$(dirname "$0")/.."

step() {
  printf '\n==> %s\n' "$*"
  "$@"
}

fast() {
  step uv sync --locked
  step uv run ruff check backend tests scripts
  step uv run ruff format --check backend tests scripts
  step npm run --silent lint --prefix frontend
  step npm run --silent format:check --prefix frontend
}

full() {
  fast
  step uv run mypy
  exported="$(mktemp)"
  uv export --locked --no-header --no-dev --no-emit-project --format requirements-txt --output-file "$exported" > /dev/null
  step diff -u requirements.lock "$exported"
  rm -f "$exported"
  step uv run coverage run -m unittest discover -s tests
  step uv run coverage report
  step npm run --silent test --prefix frontend
  step npm run --silent build --prefix frontend
  step npm run --silent test:e2e:types --prefix frontend
  step uv run pip-audit --disable-pip --no-deps -r requirements.lock
  step npm audit --prefix frontend --audit-level=high
}

browser() {
  project=musimo-ci
  compose="docker compose -f compose.ci.yaml -p $project"
  trap "$compose down --volumes" EXIT
  step $compose up -d --build --wait --wait-timeout 120
  step uv run python scripts/smoke.py --url http://127.0.0.1:18765 --restart --compose-file compose.ci.yaml --project-name "$project"
  step npm run --silent test:e2e --prefix frontend
}

case "$mode" in
  fast) fast ;;
  full) full ;;
  browser) browser ;;
  *)
    echo "usage: scripts/check.sh [fast|full|browser]" >&2
    exit 2
    ;;
esac
printf '\nAll %s checks passed.\n' "$mode"
