# Privacy

Last updated: 7 September 2026. This describes the upstream implementation, not every fork or hosted installation.

## Who holds the data

Musimo runs on the operator's machine. There is no Musimo account service, built-in analytics destination or central collection of library data. The operator controls the instance, backups and access. A hosted operator must give its users an accurate notice for that deployment.

## Stored locally

SQLite stores settings and their origins, cached catalog queries/responses, indexed music tags and paths, job metadata and history, source status and event records. Jobs can include selected matches, errors and final paths. Temporary and downloaded files live in the mounted music folders. Diagnostics can include local paths and runtime details.

The browser stores preview volume in local storage. Search/filter state appears in page URLs and can therefore appear in browser history, screenshots, copied links and proxy logs. This is not an anonymous or incognito mode.

## External requests

- Deezer receives catalog searches and detail/preview lookups from the backend.
- iTunes can receive artist/title queries for preview fallback.
- Artwork and audio hosts receive the browser's requests, including the browser's network address.
- Enabled audio sources receive worker matching/download requests from the server.
- MusicBrainz can receive identifiers for optional metadata enrichment.
- LRCLIB can receive track, artist, album and duration for lyrics lookup.
- A configured Navidrome server receives scan requests; API mode uses configured authentication.
- Package registries and container registries receive requests during installation and updates.

These services apply their own policies. Self-hosting does not prevent providers, your network operator or your proxy from observing requests. Optional discovery and listening-history features are only planned; no current claim of a private recommendation service is made.

## Credentials and logs

Keep credentials in dedicated files outside the repository, with restricted permissions and read-only mounts where supported. Do not store secrets in public issues or screenshots. The current generic settings table is not a secret vault. Cookie upload/management and additional redaction controls are unfinished work.

Diagnostics exports, error text, container logs and reverse-proxy logs can contain identifying details. Inspect and redact them before sharing. Turning off uvicorn access logs does not disable logs in other software or providers. Do not upload the SQLite database for a routine bug report.

## Retention and clearing

The catalog cache expires entries and is bounded. Live-event replay retains at most 5,000 records. Jobs/history and the library index persist with the data volume; no general time-based history deletion is promised.

Clear all in Recent activity stores a cutoff for the visible feed. It does not purge replay rows, download history, provider logs, browser history, backups or music. Replay rows age out under their normal limit. Clearing the queue's finished view also does not delete music.

To remove an installation's data, the operator must deliberately handle its application volume, job staging, downloaded files, credentials and backups. Do not remove an entire mounted music collection as a shortcut. Provider-side data removal follows that provider's process.

## Reports

Use [Security](SECURITY.md) for accidental exposure or vulnerabilities. For questions about this upstream notice, contact the maintainer listed in [Governance](GOVERNANCE.md). For data held by another operator, contact that operator.
