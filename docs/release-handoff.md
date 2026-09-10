# Post-0.4.0 release work

Copy the prompt below into a new task in this repository.

```text
Continue Musimo's release-readiness work after version 0.4.0 in https://github.com/LeahyCC/musimo.

Start from main. Version 0.4.0 was tagged 10 September 2026 and is the first public release. Fetch first, inspect the working tree and check current PR/CI status. Follow AGENTS.md and CONTRIBUTING.md. Read docs/downloads.md, docs/search.md, docs/testing.md, docs/measurements.md and docs/releasing.md before changing code. The brief describes future ambitions, not current features.

Version 0.4.0 includes search, library indexing, download workers, queue controls, album batches, Navidrome library playback, playlist management, diagnostics, accessibility work and failure explanations. Pull request CI is paused for the release cut: restore the `pull_request` workflow triggers and required status checks before continuing development.

The first 0.4.0 release ships with these documented limitations (see CHANGELOG.md and docs/measurements.md):
- Cold search latency at 417ms median (target 400ms)
- Idle CPU at 2.35% average (target 1%)
- Match accuracy corpus exists (100 cases) but independent labels pending
- Fifty distinct permitted music downloads not measured
- Native arm64 builds successfully but performance not measured on hardware
- Representative 50k mixed-format library not tested (synthetic scan passes)
- Provider album throughput not measured

Do not repeat already completed checks without reason: 57 Python tests, PR #44 browser run (59 passed and 1 skipped on Chromium, 38 on mobile project), generated album pause/retry tests, container-crash recovery, isolated Navidrome watcher fixture, synthetic 50k scan (45 seconds), seven reliability regressions fixed, permitted public-domain download verified with tags/indexing. Synthetic and repeated-fixture results are not real-music throughput or match-accuracy evidence.

Work in this order:
1. Restore pull request CI workflows and required status checks. Verify the main branch ruleset requires passing CI, CodeQL checks, resolved conversations and up-to-date branches. Document the restoration in docs/releasing.md.
2. Complete independent labels for the 100-case music-match corpus. Record correct recording/edition expectations, provenance and review method. The corpus includes wrong editions, covers, live versions and ambiguous titles. Do not use the resolver's own choices as ground truth. If independent labels need human listening, prepare the review material and continue other work while that input is pending.
3. Test 50 distinct permitted music downloads and representative 12-track albums, recording actual codecs, bitrate, failures, retries and timings. Verify tags, owned badges and Navidrome results. Do not count generated tones or repeated film downloads toward the distinct-music sample.
4. Diagnose the remaining cold search latency gap (417ms vs 400ms target). The provider dominates at 410ms median. Measure provider, queue and local lookup time separately, then browser debounce/render time. Report any demonstrated provider limit.
5. Investigate sustained idle CPU (2.35% with 60s polling). Consider whether the 1% target is achievable with the current watcher implementation or if the target needs revision based on actual deployment constraints.
6. Measure a representative mixed-format 50k library on the intended storage and native arm64 performance on actual hardware (emulated build passes but performance not measured).
7. Update docs/measurements.md with completed gates and docs/releasing.md with final evidence. Verify all release checklist items are ticked or explicitly noted as deferred.

Use isolated databases, music roots and containers. On pancakes, read the machine notes in the notes-vault before touching the installation. Never delete or overwrite the real M:\Media library, and verify drive paths rather than assuming the letter is current. The live app on port 8765 is separate from test containers. No credentials are needed for generated/public-domain fixtures; do not put cookies, passwords or private library exports in Git.

Use small fixes, relevant regression tests and existing tools. Update the docs and evidence with each completed gate. Do not broaden this into imports, new providers, notifications or a redesign. Stop short of production deployment unless separately requested. Finish with tested commits and a short report separating completed work, failed targets and work needing my input.
```
