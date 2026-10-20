# Genre tag mapping

14 October 2026. Used by the music bot's genre filter, in `backend/library/genres.py` (`TAG_GENRES`). Maps each genre word found in the library to zero, one or two broad genres. Raw tags stay as they are in the files and the database, and stay searchable. A word not in this table keeps working as a raw tag and gets no broad genre. The Library tab's genre menus still use raw tags only.

Counts are tracks carrying the word, from the read-only catalogue snapshot used by the audio trials (44,070 files, 2,935 with no genre). The live library may have gained words since.

**?** marks a row Colin decided on 14 October: Alternative and Singer & Songwriter stay without a broad genre, soundtrack is its own genre, latin and world are kept apart, and Disco, Chill and Gospel take the genre shown.

| Tag word                  | Tracks | Broad genre        |
| ------------------------- | -----: | ------------------ |
| Rock                      |  8,870 | rock/metal         |
| Electro                   |  6,010 | electronic         |
| Dance                     |  5,663 | electronic         |
| Electronic                |  5,015 | electronic         |
| Rap/Hip Hop               |  4,824 | hip-hop            |
| Alternative               |  4,136 | none ?             |
| Trance                    |  3,382 | electronic         |
| Pop                       |  2,601 | pop                |
| Metal                     |  1,257 | rock/metal         |
| Hip-Hop                   |  1,152 | hip-hop            |
| R&B                       |    861 | soul/R&B           |
| Reggae                    |    687 | reggae             |
| Dubstep                   |    622 | electronic         |
| Techno/House              |    283 | electronic         |
| Indie Rock                |    278 | rock/metal         |
| Jazz                      |    267 | jazz               |
| Indie Pop                 |    227 | pop                |
| Films/Games               |    210 | soundtrack ?       |
| House                     |    199 | electronic         |
| Hard Rock                 |    179 | rock/metal         |
| Dub                       |    173 | reggae             |
| Film Scores               |    157 | soundtrack ?       |
| Podcast                   |    154 | spoken             |
| Country                   |    153 | folk/country       |
| Indie Rock/Rock Pop       |    148 | rock/metal + pop   |
| Folk                      |    133 | folk/country       |
| Rock & Roll/Rockabilly    |    133 | rock/metal         |
| Soundtrack                |    129 | soundtrack ?       |
| Singer & Songwriter       |    128 | none ?             |
| International Pop         |    113 | pop                |
| Chill                     |     75 | electronic ?       |
| Latin Music               |     63 | latin ?            |
| Comedy                    |     53 | spoken             |
| Dancehall/Ragga           |     50 | reggae             |
| Latin                     |     49 | latin ?            |
| Kids                      |     46 | none               |
| Christian                 |     46 | none               |
| African Music             |     46 | world ?            |
| Soul & Funk               |     44 | soul/R&B           |
| Blues                     |     43 | blues              |
| Disco                     |     40 | electronic ?       |
| Classical                 |     38 | classical          |
| Grime                     |     37 | hip-hop            |
| Gospel                    |     35 | soul/R&B ?         |
| Ska                       |     34 | reggae             |
| Asian Music               |     34 | world ?            |
| Chill Out/Trip-Hop/Lounge |     29 | electronic         |
| East Coast                |     26 | hip-hop            |
| Bluegrass                 |     23 | folk/country       |
| Contemporary R&B          |     17 | soul/R&B           |
| Asian                     |     15 | world ?            |
| TV Soundtracks            |     14 | soundtrack ?       |
| Drum and Bass             |     12 | electronic         |
| Liquid Drum and Bass      |        | electronic         |
| Neurofunk                 |        | electronic         |
| Jungle                    |        | electronic         |
| Dancehall                 |      8 | reggae             |
| Brazilian Music           |      6 | latin ?            |
| Opera                     |      5 | classical          |
| Indie Pop/Folk            |      5 | pop + folk/country |
| Contemporary Soul         |      5 | soul/R&B           |
| Traditional Mexicano      |      5 | latin ?            |
| Reggaeton                 |      4 | latin ?            |
| Non-Music - Radioplay     |      3 | spoken             |
| African                   |      2 | world ?            |
| Soul                      |      1 | soul/R&B           |

## Broad genres in this draft

electronic, rock/metal, hip-hop, pop, soul/R&B, reggae, jazz, folk/country, world, classical, blues, latin, soundtrack, spoken, drum and bass.

Changes from the genre trial's list: folk/country/world is split into folk/country and world, soundtrack is added, and "other" is dropped (an unmapped word simply has no broad genre).

## How the bot searches

A requested word matches a song when any of these hold:

- it names a broad genre in everyday words (`GENRE_WORDS`): "hip hop", "rap", "electronic", "edm", "r&b", "film score", "spoken word", "dnb" and so on;
- it equals one of the song's tags, ignoring case and extra spaces;
- it equals one part of a tag split at "/", so "house" finds Techno/House and "trip-hop" finds Chill Out/Trip-Hop/Lounge.

A hyphen and a space are the same spelling, and `&` means "and", so "trip hop" and "trip-hop" match, and "drum & bass" is "drum and bass". `dnb` and `drum n bass` are the same word. Drum and bass is its own group over the tags Drum and Bass, Liquid Drum and Bass, Neurofunk and Jungle, and those tags stay electronic too. `liquid`, `liquid dnb` and `liquid drum n bass` mean the liquid tag only, not Neurofunk or a song tagged just Drum and Bass. Liquid Drum and Bass, Neurofunk and Jungle were not in the 14 October count, so those rows have no number.

A trailing "music" is optional: "latin music" means latin, while "dance music" means the Dance tag, not every electronic song. Tag values holding several genres separated by ";" are split first.

So "hip hop" finds Rap/Hip Hop, Hip-Hop, East Coast and Grime; "trance" finds only Trance; "rock" finds the whole rock/metal group; "metal" finds only Metal. "drum and bass" finds Drum and Bass, Liquid Drum and Bass, Neurofunk and Jungle. "liquid" finds Liquid Drum and Bass and not the rest of that group. "More like this" passes the reference song's tags through the same rule, so a song tagged Pop finds the pop group.

The bot's instructions tell the model to put genre words in `genres`, never `artists`. The server searches that list as given. It does not scan the request text for genre words, and it does not move a genre word out of `artists`. `genre_words_in` is the phrase table used by the mapping tests: longer phrases win, so "drum and bass" does not also mean "bass", and a negation (no, not, without, except, excluding, other than, instead of, apart from) matches nothing, because "no hip hop" must not become hip hop. World, film, movie, films, games and music are left out of that table because they show up in ordinary sentences.

`scripts/music_bot_benchmark.py` has six genre cases (hip hop, electronic, trance, drum and bass, rock from the 90s, rap from the 2000s). On 14 October Qwen passed 27 of 28 on two runs. Both times it missed "some rap from the 2000s": it copied the queued songs' artist, decade and rock genre into a fresh request.

Adding a tag word: add it to `TAG_GENRES` and to the table above. `tests/test_genres.py` fails if a mapped word is missing from this page.
