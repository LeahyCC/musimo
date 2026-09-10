# Library player

The player uses Navidrome as the playback server. Musimo keeps its local SQLite index for download ownership, while Navidrome supplies playable IDs, library browsing, audio streams, cover art, lyrics, scrobbles and the saved play queue.

## Configuration

Set `navidrome_url` to the address reachable from the Musimo container. Mount a JSON credentials file containing `username` and `password`, then set `MUSIMO_NAVIDROME_CREDENTIALS_FILE` to its container path. The same file supports selective scanning and playback. Credentials remain on the backend. Browser requests use same-origin Musimo endpoints and never receive the password or salted Subsonic token.

`navidrome_url` accepts HTTP or HTTPS, including a path prefix. Credentials, query strings, fragments and non-HTTP schemes are rejected. The capability endpoint reports an unavailable state instead of failing when Navidrome is not configured or cannot be reached.

## Player experience

Library has Home, Albums, Artists, Tracks and Playlists views. Each view and detail page has its own URL, so refresh and browser Back preserve page navigation. Albums opened from an artist use `/library/artists/{artist}/albums/{album}` and return to that artist. One search field searches the active view; album, artist and track searches run against Navidrome, while the smaller playlist list is filtered in the browser. Sort choices are specific to each view. More results load as you scroll. Grid and list layouts are available for collection views and the choice is remembered in the browser. Artist images come from Navidrome. Artist, album and playlist rows can open, play or shuffle their collection. On album cards, the artwork play button starts the album while the remaining card opens its songs. Album cards and rows carry the release year. Opening an album or playlist reveals its tracks, and Play all and Shuffle both create one persistent queue. The footer player provides seek, previous, next, shuffle, repeat, volume and mute. Its artist and album names open their Library pages, and its expand button opens Now Playing. While playing a library track, a thumbs up button toggles membership in the default linked playlist, and a plus button opens a playlist picker. The queue and position restore from Navidrome after a refresh. Browser media controls receive the current title, artist, album and artwork.

Any play button becomes a pause button while the thing it starts is the thing playing. For a track that means the track itself; for an album, artist, playlist or the Tracks list it means that collection still owns the queue.

Tracks is the one view where search, genre and year filters, sort order, the match count, Play all and Shuffle all run on the server, so they describe the whole library rather than the pages this browser has scrolled through. Shuffle takes a server-side random sample, and Musimo caps one saved queue at 500 songs. Album genre and year filters still work across the loaded pages only.

An artist page sorts its albums by release date, title or play count, and its All songs view sorts by album order, title, play count, length or release date. A popularity chart plots Navidrome's play counts for the artist's dated releases, oldest to newest; it says so plainly when there are not yet enough recorded plays to draw a line.

The liked playlist is the one playlist Musimo maintains, so it is always listed, sorts to the top of every playlist view, and has no delete control. `DELETE /api/library/playlists/{id}` refuses it as well, because the thumbs up button depends on it existing. Its identity is the stored link, so the protection begins when Musimo adopts or creates the playlist rather than applying to anything a user happens to name Liked. Other playlists can be created, renamed, emptied and deleted; the delete control appears on hover or focus. Playlist rows show their song count and length and can be filtered by public or private. The playlist picker in the footer player is a centred modal. Each row shows whether the current song is already in that playlist and toggles between Add and Remove, so the same song cannot be added twice, and each row expands into a scrolling list of that playlist's songs where any of them can be removed. Playlist reads share one cache with the playlist page, so a change made in the player appears there without a reload.

Now Playing shows large artwork, the queue and lyrics. Musimo asks Navidrome first, then checks LRCLIB when the library track has no imported lyrics. Start AudioMuse radio replaces the queue with the current song followed by sonic matches when Navidrome advertises the required extension. The Library badge says AudioMuse is connected because an advertised extension does not prove its analysis and similarity index are ready. AudioMuse connection and index failures receive a short not-ready message instead of exposing the plugin error or its local address. Catalog previews still use the same audio element, so a preview and a library track cannot play at once.

Starting playback keeps the collection in place. Loading feedback appears in the Library header, and other cards keep their play buttons hidden until hovered or focused. Touch layouts keep the buttons visible.

## API

- `GET /api/player/capabilities`: connection, server version and advertised OpenSubsonic extensions. `sonic_similarity` is true when Navidrome advertises the `sonicSimilarity` extension.
- `GET /api/library/albums`: paged Navidrome albums with a bounded sort choice and optional search query.
- `GET /api/library/artists`: paged artists with an optional search query.
- `GET /api/library/tracks`: whole-library track browsing. `q`, `sort`, repeated `genre` and `year`, `offset` and `size` are applied on the server, which returns the page, the matching `total` and the `genres`/`years` present across the library.
- `GET /api/library/tracks/search`: one upstream page of matches, for the playlist song picker.
- `GET /api/library/tracks/selection`: the same filters without paging, for Play all and Shuffle. `shuffle=true` returns a server-side random sample; `limit` is capped at the same 500 songs the saved play queue accepts.
- `GET /api/library/playlists`: playlists visible to the configured account, plus `liked_id` for the linked playlist. Identifying it here is a plain read and never creates one.
- `GET /api/library/playlists/liked`: returns and reuses a cached default linked playlist named `Liked`.
- `GET /api/library/albums/{id}`, `GET /api/library/artists/{id}` and `GET /api/library/playlists/{id}`: detail resources.
- `GET /api/library/artists/{id}/tracks`: all unique tracks from the artist's albums, fetched with bounded concurrency for Play all and Shuffle.
- `POST`, `PATCH` and `DELETE /api/library/playlists`: create, rename and delete playlists. Deleting the linked liked playlist is refused with 409. `POST /api/library/playlists/{id}/songs` adds a song or removes it by its current playlist index.
- `GET /api/player/stream/{id}`: proxied audio. A single valid byte range is forwarded and Navidrome's safe media headers are preserved.
- `GET /api/player/art/{id}`: proxied cover artwork.
- `GET` and `PUT /api/player/queue`: restore and save the Navidrome play queue.
- `POST /api/player/scrobble`: report now playing and completed listens.
- `GET /api/player/lyrics/{id}`: Navidrome structured lyrics with an LRCLIB fallback.
- `GET /api/player/radio/{id}` and `GET /api/player/path`: AudioMuse sonic matches and track-to-track journeys.

Every item ID is length and character checked before it reaches Navidrome. The proxy forwards only a small media-header allowlist. Upstream errors become a generic 503 response without exposing the private address or credentials.

Navidrome does not expose standard API calls for deleting songs, albums or artists. Musimo therefore does not show destructive media actions in Library. Remove files through the storage or Navidrome administration workflow, then let the library scan reconcile the index.

## AudioMuse-AI boundary

The AudioMuse integration uses Navidrome's OpenSubsonic `sonicSimilarity` extension. `getSonicSimilarTracks` powers Start Radio and `findSonicPath` provides the API for track-to-track journeys. These actions are feature-gated by `/api/player/capabilities`; ordinary playback does not depend on AudioMuse.

Natural-language mixes and Song Alchemy require AudioMuse-specific APIs. They remain a later, optional adapter so changes in AudioMuse do not destabilize playback. Analysis, clustering and worker administration remain in AudioMuse's own interface.

## Verification

`tests/test_player.py` covers capability discovery, library and player routing, repeated queue IDs, credential isolation, item-ID validation, safe response headers, artwork and a ranged audio response. It also covers server-side track filtering, sorting, paging, facets, shuffle, the reused track cache and its single-flight walk, and that listing playlists reports the linked liked playlist without creating one and refuses to delete it. Frontend type checking, linting and production builds cover the browser contract. A live credentialed Navidrome playback check remains required for each installation.

Track browsing gathers pages from Navidrome up to a bounded cap and reuses them for a short window, so filters, sort and totals describe the library rather than one page. Beyond that cap they describe the first 10,000 songs Navidrome returns. Concurrent callers share one walk, and a scan started by Musimo clears the snapshot so a new download appears without waiting out the window; a scan started from Navidrome's own interface waits for it.
