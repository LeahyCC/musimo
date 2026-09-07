# Later release work

Copy the prompt below into a new task in this repository.

```text
Continue Musimo's release-readiness work in https://github.com/LeahyCC/musimo.

Start from fix/download-reliability, or from main if that branch has already been merged. Fetch first, inspect the working tree and check current PR/CI status. Keep existing work. Follow AGENTS.md and CONTRIBUTING.md. Read docs/downloads.md, docs/search.md, docs/testing.md, docs/measurements.md and docs/releasing.md before changing code. The original brief is a list of ambitions, not proof of shipped capability.

The branch includes the reliability fixes from 167504f and the dependency changes from PR #1 (Python 3.14 runtime) and PR #2 (Node 26 frontend build). CI mirrors those versions and retains Python 3.12 compatibility tests. Node is a build dependency, not a server process in the final image. Check the latest validation notes rather than treating the original PRs' older failing runs as current results.

Finish the existing search → choose recording → queue → download → tag → index → Navidrome journey before adding features. Do not repeat already completed checks without a reason: seven reliability regressions, 41 Python tests, 60 browser checks, generated album pause/retry tests, container-crash recovery and an isolated Navidrome watcher fixture are documented. A synthetic 50,000-file scan improved from 209 to 45 seconds. Synthetic and repeated-fixture results are not real-music throughput or match-accuracy evidence.

Work in this order:
1. Establish a reproducible music-match corpus with at least 100 independently labelled cases. Record correct recording/edition expectations, provenance and review method. Include wrong editions, covers, live versions and ambiguous titles. Do not use the resolver's own choices as ground truth. Seven existing live jobs previously failed with NO_MATCH; inspect their current state before proposing corrections and keep private metadata out of Git. If independent labels need human listening, prepare the review material and continue other work while that input is pending.
2. Diagnose uncached search latency before changing caching or provider budgets. The last ten-query HTTP sample had 598 ms p95 against a 400 ms target. Measure provider, queue and local lookup time separately, then browser debounce/render time. Improve what can be demonstrated and report any remaining provider limit.
3. Test 50 distinct permitted music downloads and representative 12-track albums, recording actual codecs, bitrate, failures, retries and timings. Verify tags, owned badges and Navidrome results. Do not count generated tones or repeated film downloads toward the distinct-music sample.
4. Measure a representative mixed-format 50k library on the intended storage, sustained idle CPU/RSS with the deployed watcher settings, and native arm64 behavior. Keep unavailable hardware and unmeasured targets explicit.
5. Complete docs/releasing.md, review the final changes, and pass the required GitHub CI and all three CodeQL checks. Keep release claims tied to recorded evidence.

Use isolated databases, music roots and containers. On pancakes, read the machine notes in the notes-vault before touching the installation. Never delete or overwrite the real M:\Media library, and verify drive paths rather than assuming the letter is current. The live app is separate from musimo-ci. No credentials are needed for generated/public-domain fixtures; do not put cookies, passwords or private library exports in Git. A leftover test folder in Windows Temp had cleanup blocked by automatic approval review; leave it alone unless that restriction is resolved.

Use small fixes, relevant regression tests and existing tools. Update the docs and evidence with each completed gate. Do not broaden this into imports, new providers, notifications or a redesign. Stop short of production deployment or release publication unless separately requested. Finish with tested commits and a short report separating completed work, failed targets and work needing my input.
```
