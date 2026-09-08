# Library player

The player uses Navidrome as the playback server. Musimo keeps its local SQLite index for download ownership, while Navidrome supplies playable IDs, library browsing, audio streams, cover art, lyrics, scrobbles and the saved play queue.

## Configuration

Set `navidrome_url` to the address reachable from the Musimo container. Mount a JSON credentials file containing `username` and `password`, then set `MUSIMO_NAVIDROME_CREDENTIALS_FILE` to its container path. The same file supports selective scanning and playback. Credentials remain on the backend. Browser requests use same-origin Musimo endpoints and never receive the password or salted Subsonic token.

`navidrome_url` accepts HTTP or HTTPS, including a path prefix. Credentials, query strings, fragments and non-HTTP schemes are rejected. The capability endpoint reports an unavailable state instead of failing when Navidrome is not configured or cannot be reached.

## Player experience

Library has Home, Albums, Artists, Tracks and Playlists views. Each view and detail page has its own URL, so refresh and browser Back preserve page navigation. Albums opened from an artist use `/library/artists/{artist}/albums/{album}` and return to that artist. One search field searches the active view; album, artist and track searches run against Navidrome, while the smaller playlist list is filtered in the browser. Sort choices are specific to each view. Album and track genre/year filters support multiple selections across the pages loaded so far, with one Clear filters action. More results load as you scroll. Grid and list layouts are available for collection views and the choice is remembered in the browser. Artist images come from Navidrome. Artist, album and playlist rows can open, play or shuffle their collection. On album cards, the artwork play button starts the album while the remaining card opens its songs. The Tracks list can play or shuffle all loaded results. Opening an album or playlist reveals its tracks and Play all creates one persistent queue. The footer player provides seek, previous, next, shuffle, repeat, volume and mute. Its artist and album names open their Library pages, and its expand button opens Now Playing. The queue and position restore from Navidrome after a refresh. Browser media controls receive the current title, artist, album and artwork.

Now Playing shows large artwork, the queue and lyrics. Musimo asks Navidrome first, then checks LRCLIB when the library track has no imported lyrics. Start AudioMuse radio replaces the queue with the current song followed by sonic matches when Navidrome advertises the required extension. The Library badge says AudioMuse is connected because an advertised extension does not prove its analysis and similarity index are ready. An AudioMuse 503 receives a short retry-later message instead of exposing the plugin error. Catalog previews still use the same audio element, so a preview and a library track cannot play at once.

## API

- `GET /api/player/capabilities`: connection, server version and advertised OpenSubsonic extensions. `sonic_similarity` is true when Navidrome advertises the `sonicSimilarity` extension.
- `GET /api/library/albums`: paged Navidrome albums with a bounded sort choice and optional search query.
- `GET /api/library/artists`: paged artists with an optional search query.
- `GET /api/library/tracks`: paged track search.
- `GET /api/library/playlists`: playlists visible to the configured account.
- `GET /api/library/albums/{id}`, `GET /api/library/artists/{id}` and `GET /api/library/playlists/{id}`: detail resources.
- `GET /api/library/artists/{id}/tracks`: all unique tracks from the artist's albums, fetched with bounded concurrency for Play all and Shuffle.
- `POST`, `PATCH` and `DELETE /api/library/playlists`: create, rename and delete playlists. `POST /api/library/playlists/{id}/songs` adds a song or removes it by its current playlist index.
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

`tests/test_player.py` covers capability discovery, library and player routing, repeated queue IDs, credential isolation, item-ID validation, safe response headers, artwork and a ranged audio response. Frontend type checking, linting and production builds cover the browser contract. A live credentialed Navidrome playback check remains required for each installation.
