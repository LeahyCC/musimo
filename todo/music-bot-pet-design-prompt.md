# Design brief: Musimo music bot as a pet

Paste everything below the line into the design tool.

---

Design a music chat companion for Musimo, a self-hosted web music player. The companion is a small animated pet that sits on top of the Now Playing player. Tapping the pet opens a chat where you ask for music in plain words and get back a list of real songs from your own library, which you can preview, play, queue or save. The pet is customisable.

## Where the pet lives

- **Desktop:** the pet perches on the top edge of the footer player bar, as if sitting on it. It must never cover the play controls, the seek bar or the volume.
- **Phone (390 px wide):** the footer is a one-row mini player above a 64 px bottom navigation bar. The pet perches on the mini player's top edge and stays small.
- **Now Playing page:** the footer player is hidden there, because the page has its own big artwork stage, title, controls and a tab panel (Up next, Lyrics, About, History). Show where the pet sits on this page instead, for example on the corner of the artwork stage or beside the title.
- **Nothing playing:** the footer is hidden on phones until something plays. Show where the pet goes then, or whether it waits in the sidebar or nav.
- The user can hide the pet and still reach the chat from the sidebar's "Music bot" entry.

## Pet states

Design every state as a small, readable pose or loop:

- Idle (nothing playing)
- Listening (music playing). It reacts to play, pause, skip and track change only. It cannot hear the music or detect the beat, so do not design beat-synced dancing.
- Sleeping (paused for a while, or the sleep timer is running)
- Thinking (waiting for a reply; the first reply can take 10 to 15 seconds while the model loads, later ones about 2 to 4 seconds)
- Talking (a reply has arrived)
- Happy (songs were played or queued)
- Confused (it is asking a clarifying question)
- Apologetic (it cannot do the request, or something failed)
- Busy (the library is being scanned, so the chat is not ready yet; this can last minutes)
- Offline (the local model server cannot be reached, or no model is chosen)

Include a gentle way to show there is a new reply when the chat is closed, like a small speech bubble or notification dot, without being noisy.

## The chat

Opening the pet shows a chat panel anchored to the pet: a popover on desktop, a bottom sheet or full page on phones. It needs:

- A text box ("Ask for music", up to 2,000 characters), a send button, and Cancel while waiting.
- A few suggestion chips for first use, for example "An hour of my favourite 90s music", "Play some hip hop", "Something like this song".
- The conversation, with the last eight messages kept.
- **Result card** for each set of songs: the song list (title, artist, length), total length, a one-line summary such as "100 songs, 473 minutes. Based on saved library tags.", and a clear note when too few songs matched ("12 minutes short; no exclusions were relaxed").
- **Actions on a result:** Play, Play next, Add to queue, Replace upcoming (keeps the current song playing), Save as playlist (asks for a name). Results are previews until one of these is pressed.
- **Undo** for the latest bot change to the queue. It can refuse if the queue changed since; show that message.
- **Active filters** shown as small chips on the result: genre, artist, excluded artists, years, favourites, played or unplayed, "not played today", target length. Follow-ups refine them ("make it 80s instead", "remove that artist", "add another song", "allow songs played today").
- **Scope** indicator: whole library, this selection, or the upcoming queue.
- **Reference song:** any song can be marked "Use as reference", for requests like "remove that artist" or "more like this". Show it as a chip with a clear button.
- **Direct commands:** pause, resume and skip work from chat. Show a short confirmation.
- **Clarifying question** with quick-reply buttons.
- **Can't do that yet:** mood, energy, tempo, instrument and "calmer" requests need audio analysis, which is not enabled. Reply honestly in the pet's voice and suggest what it can do instead.
- **Model picker** in the chat's settings: installed local models, a connection test, and the error when none are installed.
- Clear chat.

Errors to design: model server unreachable, no model chosen, model gave an unusable answer, library still scanning, the queue changed since the request, the 500-song queue limit reached.

Honesty rules: the pet never claims to hear or judge how a song sounds. Results come from tags (artist, genre, year, length, favourites, play history). Never invent songs.

## Customisation

A settings screen (under Settings > Music bot) and a quick menu on the pet (long-press or right-click):

- Character: several pet designs to choose from (for example a cat, a bird, a small robot and a blob). Show each one in a few states.
- Name, shown in chat ("Ask Pip for music").
- Colour: follow the theme's accent by default, or pick a colour.
- Size: small, medium, large (phones cap at small or medium).
- Position on the player: left, centre or right.
- Chattiness: quiet (only replies), normal, chatty (small reactions to track changes in a bubble).
- Animation: full, reduced, or off. Follow the system's reduced-motion setting by default.
- Sounds: off by default, and they must never play over or duck the music.
- Hide the pet (chat stays in the sidebar).
- A live preview of the pet on a mock player while changing settings.

## Visual rules

- Musimo uses colour tokens named for their job: canvas, raised, muted, accent, danger background and so on. Users have light, dark and custom themes, so the pet and chat must work with any of them, and text must keep at least WCAG AA contrast.
- There is a Windows 95 skin with square bevelled controls. Design a pixel-art variant of each pet and the chat panel for that skin.
- The Now Playing page tints its background from the album cover's main colour. The pet must stay readable on top of that.
- Keyboard and screen readers: the pet is a labelled button, Escape closes the chat, focus moves into the chat and back to the pet, and new replies are announced.
- Touch targets at least 44 px on phones.

## Deliverables

1. A pet character sheet: each character in every state, in light, dark and Windows 95 styles.
2. Desktop: pet on the footer player, and the chat open with a result card.
3. Phone: pet on the mini player, and the chat as a sheet or full page.
4. The Now Playing page with the pet placed there.
5. Result card states: normal, shortfall, empty, after Play (with Undo), Undo refused.
6. Empty, loading (cold and warm), busy, offline and error states.
7. The customisation screen with live preview, and the pet's quick menu.
