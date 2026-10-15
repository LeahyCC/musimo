# Handoff: build the music bot pet UI

Paste everything below the line into a new session. Replace `<DESIGN LINK>` with the finished design's link or export folder first.

---

Build the Musimo music bot pet from the approved design.

**Design:** `<DESIGN LINK>`. Read all of it before writing code: every screen, every pet state, the light, dark and Windows 95 variants, phone and desktop. If anything in the design conflicts with this brief or with what the backend can do, stop and ask Colin. Do not quietly pick one.

**Repository:** `C:\Users\cclea\projects\musimo`, branch `feature/local-player`, on pancakes (Windows, PowerShell). The branch holds a lot of uncommitted work from earlier tasks. Do not reset, clean or overwrite it. Snapshot `git status` and `git diff` before starting. Do not commit, push or deploy unless Colin asks.

Read first:

- `todo/music-bot-pet-design-prompt.md`: the brief the design was made from.
- `docs/player.md`, the Music bot section: what the bot does and how its actions behave.
- `docs/genre-mapping.md`: how genre requests are matched.
- `docs/architecture.md`, "Tokens and themes" and "Adding a token": the colour token rules.
- `docs/testing.md`: the commands CI runs.
- `todo/genre-and-bot-handoff.md`: other open work. Leave it alone unless it blocks this.

## What exists today

```
backend   POST /api/music-bot/chat       request -> plan + real songs (preview only)
          POST /api/music-bot/validate   recheck a selection before applying it
          GET  /api/music-bot/models     installed Ollama models
          settings: ollama_url, ollama_model, music_timezone
frontend  features/music-bot/music-bot.tsx      the current chat page at /music-bot
          features/player/player.tsx            footer player and mini player
          features/player/queue-writer.ts       queue saves, Undo support
          features/now-playing/now-playing-page.tsx   Now Playing (footer hidden here)
          theme/  tokens.ts, themes.ts, schema.ts, store.ts, contrast.ts, win95.css
          lib/use-phone.ts                      the 768 px phone edge
```

The backend already does everything the chat needs. This is a frontend job. If the design needs data the API does not return, list it and ask before changing the backend.

## Scope

1. **The pet:** a component that perches on the footer player (desktop), on the mini player (phone) and in its own spot on the Now Playing page. Include every state in the design: idle, listening, sleeping, thinking, talking, happy, confused, apologetic, busy and offline. Map states to real events only: playback (play, pause, skip, track change), the chat request lifecycle, library scanning (`GET /api/library` status) and model availability. It must never sit over the controls or seek bar; the footer publishes its height as `--player-h`.
2. **The chat:** move the existing music-bot behaviour into the design's panel, a popover on desktop and a sheet or page on phones. Keep every current feature: result previews, Play, Play next, Add to queue, Replace upcoming, Save playlist, Undo with its refusal, filter chips, scope, reference song, direct pause, resume and skip, clarify, "needs audio analysis" replies, model picker, Clear chat, Cancel, and the eight-message session history. Reuse the existing logic and queue writer. Do not rewrite how actions apply.
3. **Customisation:** character, name, colour (theme accent by default), size, position, chattiness, animation (follow reduced motion by default), sounds (off by default, never over the music) and hide pet. Include a live preview. These are per-device cosmetic choices, so store them in the browser the way themes are (`musimo.*` keys, a zod schema with a version, and safe fallbacks when storage fails). Ask Colin if he would rather they follow him across devices.
4. **Windows 95 skin:** use the pixel-art pet and panel variants under `html[data-skin]`, the way `win95.css` handles other components.
5. **Keep `/music-bot`** working as the full-page chat, for phones and the sidebar entry.

## Rules

- Colours come from existing role tokens only. A new token follows the "Adding a token" steps, including `CONTRAST_PAIRS` when text sits on it. No raw hex in components and no Tailwind stock colours (they are switched off).
- Text keeps WCAG AA contrast in every built-in theme and over the Now Playing cover wash.
- Respect `prefers-reduced-motion` and the user's animation setting. Animations must not cost noticeable CPU while music plays. Prefer CSS or sprite animation to a heavy runtime library, and ask before adding a dependency.
- Accessibility: the pet is a labelled button; Escape closes the chat; focus moves into the panel and back to the pet; new replies are announced politely; touch targets are at least 44 px.
- The pet never claims to hear the music. Results always read as previews based on tags.
- Write code that matches the surrounding code. Comment why, not what. Never use `any`. Prettier formats.
- No AI wording anywhere in code, comments, commits or branch names.

## Testing

- Unit tests (`npm run test --prefix frontend`) for the state mapping, the settings schema and its fallbacks, and pet placement on phone and desktop.
- Update `frontend/e2e/music-bot.spec.ts` for the new panel and add pet flows: open and close, every result action, Undo, customisation saved across reload, hidden pet, phone layout at 390 px, Windows 95 skin, reduced motion.
- End-to-end tests run against the test server on port 18765 only. **Never point Playwright at port 8765.** That is Colin's real server; a past test run overwrote his settings there.
- Run the full list in `docs/testing.md` before saying it works: lint, format check, unit tests, build, e2e type check and the e2e suite.
- Check by eye in the browser pane: light, dark, Windows 95, phone and desktop, and the Now Playing page with a bright and a dark cover. Send Colin screenshots of each.

## Docs

Update `docs/player.md` (the Music bot section, plus pet placement and settings), `docs/settings.md` if any setting is added, and `docs/testing.md` for the new tests. If a token is added, update its list in the migration plan too.

## Stop and ask Colin

- When the design and the backend disagree.
- Before adding a dependency, changing the backend or adding a server-side setting.
- Before committing, deploying to the running container, or touching his real settings.

## Done when

All design screens and states are built and match the design in every theme and size. Every existing bot feature still works. All checks in `docs/testing.md` pass. Docs are updated. Colin has seen screenshots. Report anything left open as a short list at the end.
