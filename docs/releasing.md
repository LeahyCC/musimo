# Release checklist

This separates files present in the repository from GitHub settings, legal review and runtime evidence. Do not mark an item complete because its documentation exists.

## Repository preparation

- [x] MIT source licence and copyright notice.
- [x] README covering installation, limits, storage, updates and development.
- [x] Contribution guide, issue/PR templates, code ownership and conduct policy.
- [x] Security contact, privacy notice and responsible-use terms.
- [x] Dependency update configuration and CI checks.
- [ ] Review all proposed public files and Git history for secrets, private paths, personal data and unlicensed assets. Evidence files need review too.
- [ ] Confirm maintainer contact addresses and moderation/security arrangements before inviting public reports.
- [x] Enable private vulnerability reporting on GitHub and verify the reporting route. Verified through the repository API. Reports go through the repository Security page.
- [x] Enable Dependabot security updates and require SHA-pinned Actions. Secret scanning and push protection are enabled.
- [ ] Protect main with pull requests, passing CI and CodeQL checks, resolved conversations, a security finding gate, and no force pushes, deletion or bypass actors. Was verified through the repository ruleset API on 6 September 2026. Paused on 10 September 2026 for the first release cut: the `pull_request` workflow triggers and the required status check and code scanning rules were removed so work can merge quickly. Restore both before publishing.
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

- [x] Run lint, format, strict typing, backend tests and frontend build on the final revision. The 7 September release-validation branch passed 41 backend tests, 60 browser checks, 74.84% branch-inclusive coverage, both dependency audits and the isolated HTTP/SSE restart smoke.
- [ ] Build from a clean clone using committed locks and check the image on supported platforms.
- [ ] Run install, persistence/restart, scan, event replay and proxy checks against isolated test data.
- [ ] Verify a permitted track downloads, matches correctly, receives tags/artwork/lyrics where available, and appears in Navidrome.
- [ ] Verify album missing-only batches, repeated clicks, partial failures and batch controls.
- [ ] Exercise pause/resume/cancel/retry, source failure, low disk space, mount loss and restart recovery.
- [ ] Visually check desktop/mobile search, player, queue and Settings, including keyboard operation and error states.
- [ ] Record cold/warm search, accuracy, throughput, large-library scan and idle CPU measurements. Cold/warm search and sustained idle resources are recorded. Match accuracy, permitted-music throughput and a representative mixed-format 50k library remain NOT MEASURED, and the incomplete match gate still fails.
- [ ] Test backup restoration and upgrade compatibility, not just backup creation.

## Publish

- [ ] Align version fields and image tags with the reviewed revision. Document schema changes and upgrade/rollback requirements.
- [ ] Write release notes with actual behavior and known limitations. Link test evidence and distinguish local checks from CI.
- [ ] Publish source/tag and any reviewed container artifacts only after the above checks. Restrict publishing credentials and use reproducible build inputs; record digests.
- [ ] Verify the published installation instructions on a clean machine, and monitor reported regressions.

Dependency update PRs require review. Python changes must regenerate `requirements.lock` as well as `uv.lock`; helper/plugin versions must remain compatible. There is no automatic merge or release policy.
