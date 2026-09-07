# Contributing

Start with the [README](README.md), [architecture](docs/architecture.md) and the document covering the behavior you want to change. The brief and roadmap contain unfinished work. Check the source before treating a feature as implemented.

## Before starting

Search existing issues and pull requests. Small fixes can go straight to a pull request. For a new provider, dependency, database change or substantial screen redesign, open a proposal describing the user problem and the complete flow first.

Useful contributions include reproducible bug reports, keyboard/touch accessibility, matching fixtures, documentation corrections, performance measurements and recovery tests. Do not submit credentials, copyrighted recordings without permission, private library indexes or unredacted diagnostics.

## Develop locally

Fork the repository, clone your fork, and make a focused branch such as `fix/preview-volume`. Install Python 3.12, Node 24 and uv. Then:

```sh
uv sync --locked
npm ci --prefix frontend
docker compose up -d --build --wait
npm run dev --prefix frontend
```

Use the isolated test music folder. The README explains host mounts, the frontend proxy and direct Python development. Do not run restart, watcher or download tests against irreplaceable files.

## Code conventions

- Reuse existing services and dependencies before adding new ones.
- Keep domain decisions in services. Generic formatting and transforms can remain pure helpers.
- Use strict types. Use `unknown` and validate untrusted data; do not use TypeScript `any`.
- Validate API input, provider responses, output paths and credentials at their boundaries.
- Explain non-obvious decisions in comments. Avoid comments that repeat the code.
- Keep search responsive. Respect shared provider budgets and avoid per-result filesystem reads.
- Preserve queue state, idempotency and file safety through retries, reloads and restarts.
- Make loading, empty, error and retry states usable with keyboard and touch.
- Format with Prettier and Ruff. Avoid unrelated formatting changes.

## Tests and documentation

Run the checks relevant to your change, then the required repository checks:

```sh
uv run ruff check backend tests scripts
uv run ruff format --check backend tests scripts
uv run mypy
uv run coverage run -m unittest discover -s tests
uv run coverage report
npm run lint --prefix frontend
npm run build --prefix frontend
npm run format:check --prefix frontend
npm run test:e2e:types --prefix frontend
```

Leave a focused regression test for changed logic. Provider tests should use mock transports or recordings you have permission to use. Record the source/licence of contributed fixtures. Never make ordinary unit tests download arbitrary songs.

For UI changes, run the isolated browser suite in [Testing and CI](docs/testing.md). Exercise the full journey on desktop and a narrow screen: action, feedback, navigation away/back, failure/retry, and refresh where state should persist. A TypeScript build does not establish browser behavior. Describe any untested path honestly.

Update the relevant docs in the same pull request. Dependency changes include manifests, lockfiles and the exported Python runtime requirements. Database changes include migration, recovery and compatibility notes. Performance claims include method, environment and measured results.

## Pull requests

Keep one problem per pull request when practical. Explain the observed problem, resulting behavior and checks performed. Include screenshots for visible changes, using generated or permitted data and redacting local paths. Name outstanding limitations rather than presenting a partial feature as finished.

Maintainers may request smaller scope, tests or documentation before merging. A proposal does not guarantee acceptance, and there is no promised review time. Do not add unrelated work while addressing review feedback.

## Contribution rights

By submitting a contribution, you confirm that you have the right to submit it and intend your original contribution to be distributed under this project's MIT licence. Keep required notices and identify material under another licence. You retain your copyright. No separate CLA or copyright assignment is currently required.

Permission to contribute software does not grant permission to redistribute music, artwork, lyrics or proprietary SDKs. New integrations must describe their supported, permitted uses and handle provider restrictions without deceptive claims.

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [Security](SECURITY.md), not a public issue.
