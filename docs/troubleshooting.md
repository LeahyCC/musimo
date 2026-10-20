# Troubleshooting

Visit the Diagnostics page to check system readiness. It shows library roots (mounted, writable, free space), the selected destination with write testing, the last library scan, the player, YouTube helper availability and the most recent download outcome. Settings displays a summary with a link to Diagnostics.

## The page does not open

Check Docker, `docker compose ps`, bind/port settings and service logs. A loopback bind cannot be reached from another device. Health is independent of remote provider availability.

## Search works but downloads fail

Metadata and audio come from different systems. Read the job stage and error. Unavailable recordings, source restrictions, rate limits, missing tools and disk permissions need different remedies. Each failed download displays a plain hint and links to the relevant setting, diagnostic or fix. Error codes and their recovery paths are documented in [Downloads](downloads.md#error-codes-and-recovery). Avoid repeatedly retrying a blocked source. See [YouTube troubleshooting](youtube-troubleshooting.md). Use the destination write test in Diagnostics to verify write permissions.

## Coverage is wrong or unknown

Check mounted roots, scan status and tags. Rescan after mount changes. Matches use a priority system: completed downloads first, then ISRC, then MusicBrainz ID, then normalized artist/title and duration. Different editions (same title and artist but different album) are flagged separately with the matched album name shown. Inaccessible files or incomplete provider track lists can produce partial results.

## New files are absent

Confirm the folder is mounted and listed in `MUSIMO_LIBRARY_ROOTS`. Switch to polling if filesystem events do not cross the mount. Wait for the scan to finish. A finished download is indexed as soon as the file is published.

## Settings are locked

Their origin is a bootstrap environment value. Later edits to `.env` do not replace or unlock existing rows. Check the Settings origin field.

## A preview is silent

Check Play, mute, the volume slider and browser/site audio settings. Expired clip URLs may need a new track selection. Some catalog results offer no preview.

## Idle CPU is high

Check active scans, jobs and polling interval. Frequent scans across Windows/network mounts can be costly. [Measurements](measurements.md) records unresolved targets; a short sample does not establish typical idle usage.

## Live updates fail behind a proxy

Disable buffering/caching for `/api/events`, allow long responses, preserve host/scheme, and trust only the real proxy. Reload obtains a new snapshot. See [proxy details](reverse-proxy.md).

## Report a problem

Include version/revision, OS, Docker/Compose versions, screen, reproduction steps, expected behavior and the actual result. Share a short redacted error excerpt. Remove credentials, signed URLs, private hosts, usernames and local paths before posting diagnostics.
