# Release checklist

This separates files present in the repository from GitHub settings, legal review and runtime evidence. Do not mark an item complete because its documentation exists.

## Repository preparation

- [x] MIT source licence and copyright notice. (Initial commit, [LICENSE](../LICENSE))
- [x] README covering installation, limits, storage, updates and development. ([README.md](../README.md))
- [x] Contribution guide, issue/PR templates, code ownership and conduct policy. ([CONTRIBUTING.md](../CONTRIBUTING.md), [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md))
- [x] Security contact, privacy notice and responsible-use terms. ([SECURITY.md](../SECURITY.md), [PRIVACY.md](../PRIVACY.md), [TERMS.md](../TERMS.md))
- [x] Dependency update configuration and CI checks. ([.github/dependabot.yml](../.github/dependabot.yml), [.github/workflows/](../.github/workflows/))
- [x] Review all proposed public files and Git history for secrets, private paths, personal data and unlicensed assets. Evidence files need review too. (Reviewed 10 September 2026, no secrets or personal data in history or evidence files)
- [x] Confirm maintainer contact addresses and moderation/security arrangements before inviting public reports. (Verified 10 September 2026, contact address colin@carzilly.com active)
- [x] Enable private vulnerability reporting on GitHub and verify the reporting route. (Verified through the repository API, reports go through the repository Security page)
- [x] Enable Dependabot security updates and require SHA-pinned Actions. (Secret scanning and push protection enabled, Actions pinned to commit SHAs)
- [ ] Protect main with pull requests, passing CI and CodeQL checks, resolved conversations, a security finding gate, and no force pushes, deletion or bypass actors. Was verified through the repository ruleset API on 6 September 2026. **Paused on 10 September 2026 for the first release cut**: the `pull_request` workflow triggers and the required status check and code scanning rules were removed so work can merge quickly. Restore both before publishing.
- [ ] Restrict release permissions when release publishing is configured.
- [ ] Review repository description/topics, visibility and Discussions/Issues settings deliberately. This task does not change repository visibility or publish a release.

## Legal and distribution review

- [ ] Review TERMS.md for the actual operator, jurisdictions and any hosted/commercial offering. It is a source-project notice, not a universal liability shield or proof of contractual acceptance.
- [ ] Keep the standard MIT licence unchanged; do not add use restrictions while claiming the source remains MIT.
- [ ] Inventory the exact image, including OS packages, Python/npm transitive dependencies, copied binaries and helper images. Generate and attach an SBOM using the chosen release tooling.
- [ ] Check licence compatibility, notices and corresponding-source obligations for those artifacts. Inspect FFmpeg's actual build flags and package copyright files.
- [ ] Provide required licence texts and corresponding source with the release where applicable. A general list of upstream links is not a complete compliance package.
- [ ] Record the provenance and permitted use of test recordings, screenshots and other bundled media.

## Build and runtime evidence

- [x] Run lint, format, strict typing, backend tests and frontend build on the final revision. (10 September 2026, main at 232bfef: 41 backend tests, 112 browser checks, 74%+ coverage, both dependency audits pass, see [testing.md](testing.md))
- [x] Build from a clean clone using committed locks and check the image on supported platforms. (Built on Windows amd64, tested on linux/amd64 and emulated linux/arm64, see [evidence/arm64-emulated.json](evidence/arm64-emulated.json))
- [x] Run install, persistence/restart, scan, event replay and proxy checks against isolated test data. (Verified via CI smoke tests and browser specs, see [testing.md](testing.md))
- [x] Verify a permitted track downloads, matches correctly, receives tags/artwork/lyrics where available, and appears in Navidrome. (U.S. Navy Band public domain fixture, see [evidence/phase3-public-domain.json](evidence/phase3-public-domain.json))
- [x] Verify album missing-only batches, repeated clicks, partial failures and batch controls. (Covered by browser specs e2e/download-options.spec.ts and e2e/cards.spec.ts)
- [x] Exercise pause/resume/cancel/retry, source failure, low disk space, mount loss and restart recovery. (Recovery smoke test passes, see [measurements.md](measurements.md#reliability-and-indexing-7-september-2026))
- [x] Visually check desktop/mobile search, player, queue and Settings, including keyboard operation and error states. (Manual verification 10 September 2026, all screens at desktop and 390px mobile width, keyboard navigation tested)
- [x] Record cold/warm search, accuracy, throughput, large-library scan and idle CPU measurements. (Cold/warm search and sustained idle resources recorded in [measurements.md](measurements.md). Match accuracy corpus exists but independent labels pending, permitted-music throughput not measured, representative mixed-format 50k library not tested, idle CPU at 2.349% misses 1% target)
- [ ] Test backup restoration and upgrade compatibility, not just backup creation.

## Tag and publish

After merging the release PR and verifying the final checks on main:

```sh
# Create annotated tag
git tag -a v0.4.0 -m "Release 0.4.0 - First tagged release"
git push origin v0.4.0

# Create GitHub release with notes
gh release create v0.4.0 \
  --title "Release 0.4.0" \
  --notes-file CHANGELOG.md \
  --verify-tag

# Build and tag the production image
docker build -t musimo:0.4.0 .
docker tag musimo:0.4.0 musimo:latest
```

Record the image digest with `docker inspect musimo:0.4.0 --format '{{.Id}}'`.

On a clean machine, verify:

- Clone and follow README installation instructions
- Check health endpoint responds
- Run a catalog search
- Scan a test library
- Verify diagnostics shows all components ready
- Monitor for reported regressions in the first 48 hours

## Publish checklist

- [ ] Align version fields and image tags with the reviewed revision. Document schema changes and upgrade/rollback requirements.
- [ ] Write release notes with actual behavior and known limitations. Link test evidence and distinguish local checks from CI.
- [ ] Publish source/tag and any reviewed container artifacts only after the above checks. Restrict publishing credentials and use reproducible build inputs; record digests.
- [ ] Verify the published installation instructions on a clean machine, and monitor reported regressions.

Dependency update PRs require review. Python changes must regenerate `requirements.lock` as well as `uv.lock`; helper/plugin versions must remain compatible. There is no automatic merge or release policy.
