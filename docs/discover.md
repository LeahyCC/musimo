# Discover proposal

Status: planned only. No Discover route, recommendation service or new external data sharing is implemented by this proposal.

## Recommendation

Build a library-based Discover page first. It can suggest missing albums by familiar artists and related artists without a streaming account or listening-history import. Add listening-based ranking later, when the user chooses to connect that data.

```text
Indexed music -> chosen artists -> catalog candidates
                                      |
                          remove owned/queued/hidden
                                      |
                              explain each suggestion
                                      |
                            preview -> choose -> queue
```

The page should feel like an extension of the existing album and preview flow. Recommendations never start downloads automatically.

## What the app knows today

The index stores artist, title, album, duration and some recording identifiers. It does not currently store listening history, favorites, reliable artist MusicBrainz IDs, genres or import timestamps. File modification time is not listening recency. Track count is not evidence of preference.

The catalog service already supports cached artist discographies and album details. Existing library matching can filter owned recordings. The queue exposes active jobs, and the album card already supports previews/navigation and download actions.

## First visit

If the library has not been scanned, show a scan action and explain what it will read. If it is empty, let the user choose a few artists using existing search. If there are indexed artists, offer a small editable seed list derived from the collection and let the user remove compilations or unwanted artists.

Before fetching personalized candidates, explain that the chosen artist names or identifiers are sent to catalog/recommendation providers. Keep paths, the full database and listening history local. Offer a library-only view if the user does not want personalized external requests.

## First version

Use three sections, omitting sections without usable results:

1. **More from your artists:** albums by selected artists that are not fully in the library.
2. **Finish an album:** incomplete catalog albums with a verified missing count.
3. **Related artists:** optional suggestions from a verified provider, with the seed artist named as the reason.

Start with the first two sections using the current catalog service. Related artists are a separate implementation step; do not block the basic page on an experimental recommendation API. A list of an artist's newest catalog entries should say that, not claim they were released since the user's last visit.

Cards reuse the existing art, coverage, artist/album links and queue action. Every recommendation names its reason, such as "More from Khruangbin". Provide Hide and Undo, plus a way to restore hidden suggestions. Show when the list was refreshed and keep existing cards visible while refreshing.

A simple familiar/adventurous control can come with related-artist support, but it should change a documented ranking rule rather than pretend to understand taste. Do not add an unexplained recommendation score to the UI.

## Ranking and matching

Keep ranking rules in a discovery service. For the first version, use explicit artist selection, candidate availability, library coverage and a per-artist cap. Rotate artists so a large discography cannot fill every section. Deduplicate by provider album ID; do not collapse distinct editions by title alone.

Persist seed-to-provider mappings only after a confident match or user selection. Ambiguous artist names require a choice, not a guessed catalog ID. Filter queued tracks with the same active-job identity used by downloads. An old ownership cache must not trigger an automatic download.

Unknown years and incomplete track lists remain visible with honest labels. Provider failure should leave cached suggestions usable and show a retry for that section. A recommendation is not a source-availability or rights check.

## Storage and API proposal

Reuse the catalog cache and provider budgets. Add only local discovery preferences: selected seed identities, mappings, hidden IDs and refresh metadata. Store provider results in the existing bounded cache. Avoid a separate recommendation database, vector store or background service.

Proposed endpoints:

- `GET /api/discover`: cached sections, reasons and refresh status.
- `PATCH /api/discover/preferences`: seeds and provider choices.
- `POST /api/discover/refresh`: a bounded refresh, deduplicated while running.
- `POST /api/discover/hidden`: hide/restore a suggestion by validated provider identity.

Use the existing settings/event patterns for persistence and invalidation. A successful library update invalidates local ownership; it should not refetch entire discographies. Candidate refresh should be explicit or cached for at least a day, and should yield to interactive search under the shared rate budget.

## Provider feasibility

Deezer discography lookup is already implemented in `backend/search_api.py`; that is enough for the initial familiar-artist sections. Test any related-artist endpoint against the current provider behavior before making it a requirement.

ListenBrainz documents a seed-artist radio endpoint returning related artist/recording identities. This is a plausible optional provider, but it needs MusicBrainz artist IDs and a catalog-resolution step. It is not a drop-in Deezer recommendation list. See the [ListenBrainz core API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html#id29).

If MusicBrainz is used for identifier resolution, share its budget with existing enrichment, identify the app and cache mappings. Its [rate guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) describes the default one-request-per-second IP limit. Verify live contracts, attribution and provider conditions during the feasibility step.

No Spotify credentials or paid recommendation subscription is required for the proposed first version.

## Later: listening-based recommendations

Offer an explicit connection to Navidrome favorites/play counts or ListenBrainz listening data. First verify the actual server/API fields and permissions; the current scanner cannot infer them. Explain exactly what is read or submitted and allow disconnect/reset without deleting music.

With those signals, add recently played artists, overlooked artists and new releases since a known refresh date. Keep the library-only mode useful. Do not silently upload listening history or enable scrobbling.

## Delivery order and acceptance

1. Resolve a few chosen artists and prove missing-discography suggestions against a fixture library.
2. Build the route, empty/scanning/loading/error states, reason labels and reuse existing cards/player.
3. Add persistent preferences and hide/undo. Verify reload/back, queued-item exclusion and scan invalidation.
4. Measure provider calls and search latency with Discover open. Keep a bounded request count independent of library size.
5. Prototype related-artist support separately, then consider listening-history integration.

Acceptance covers an empty library, ambiguous artist, compilation-heavy library, fully owned album, queued album, incomplete catalog list, unavailable provider, rate limit, stale cache and hidden-item undo. Browser checks cover keyboard, touch, narrow screens, navigation back from an album and playback continuity. No recommendation may start a download without a user action.

## Decisions still needed before implementation

The proposed defaults are editable library-derived seeds, no listening-history connection, no automatic downloads and no new account requirement. Confirm the external-provider notice and related-artist provider after a small live feasibility check. There is no need to decide those details to ship the current UI improvements.
