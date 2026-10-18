# UI refactor plan

This is the build plan for the UI refactor designed in Claude Design (project "Musimo", file `Musimo Refactor.dc.html`). The exported prototypes live in [design/ui-refactor](design/ui-refactor/). They are the visual spec. This file is the build spec: what we ship, in what order, and who owns which files.

All work lands on the `feature/ui-refactor` branch. Each card opens its own PR into that branch. When every card is merged, one PR takes `feature/ui-refactor` into `main`.

## What we ship

One app, two layouts, picked in Settings › Yours. Every screen and control exists in both.

```
Classic (Musimo A.dc.html)              Listening room (Musimo B.dc.html)
+--------+------------------------+     +----+------------------+--------+
|sidebar | top bar: search  ⌘K    |     |rail| page header  ⌘K  | player |
| Home   +------------------------+     | ⌂  +------------------+ dock   |
| Search |                        |     | ⌕  |                  |        |
| Octive |        page            |     | ▤  |      page        | art    |
| LIBRARY|                        |     | ✦  |                  | wave   |
| PINNED |                        |     | ↓  |                  | ▶      |
|        +------------------------+     |    |                  | Up next|
|        | footer player          |     | ⚙  |                  |        |
+--------+------------------------+     +----+------------------+--------+
Inter                                    Geist + Geist Mono
```

Phone: Classic has a mini player above a 5-tab bar (Home, Search, Library, Octive, Downloads). Listening room has a floating mini player above its tab bar.

## Decisions

These were open in the prototypes or are rules the cards must follow. Do not reopen them in a card.

1. **Layout preference.** `musimo.layout` in localStorage, `classic` or `room`, default `classic`. Read and written through `lib/stored-value.ts` so tabs stay in sync. Switching keeps the current route. The palette gets a "Switch layout" action.
2. **Home sections.** `musimo.home-sections` in localStorage, a map of section key to boolean, missing means shown. Keys: `continue`, `stats`, `jump`, `fresh`, `mostPlayed`, `octive`.
3. **Colours are tokens.** No raw colours outside `@theme` (`src/no-raw-colors.test.ts` enforces it). The prototypes use musimo-dark hex values. Map each one to a token. The Foundation card writes the mapping table into this file and adds any missing tokens to all 12 built-in themes and `theme/tokens.ts`.
4. **Fonts are self-hosted.** `@fontsource-variable/inter`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`. No Google Fonts (the CSP and the privacy policy both rule it out). The shell sets `data-layout` on `<html>`, and `--font-sans` / `--font-mono` switch on it.
5. **Icons** are `lucide-react`, which is the same set the prototypes use.
6. **Routes.** `/` becomes the Home dashboard. Search moves to `/search` only. `/library` redirects to `/library/albums`. Every other route keeps its path.
7. **No fake data.** Numbers in the prototypes are placeholders. Use what the API serves. If an element needs data the API does not have, add a small backend endpoint only when the data already exists in the store. Otherwise leave the element out and list it in the PR body.
8. **Keep what works today.** The pet, popout, sleep timer, crossfade, gapless, waveform seek, shortcuts, theme editor, draft guards and save bar all stay. If the prototype has no spot for a control we have today, put it somewhere sensible and say where in the PR.
9. **Gaps in the prototypes, settled:**
   - Listening room phone tab bar gets a 5th tab, Queue, for Downloads (the prototype has no way there).
   - Listening room Now Playing gets the same Auto / Hold visualizer control as Classic, in its pill bar.
   - Settings › Sources lists what the server reports, not the prototype's fixed list.
10. **Toasts** replace error lines inside the player (queue save failed, playback errors). Download failures stay on the Downloads page as banners and grouped sections.
11. **The layout contract in [tailwind-migration.md](tailwind-migration.md) still holds:** 44px touch targets and 16px text inputs on coarse pointers, axe clean on every route, keyboard reachable, `aria-current` on nav.
12. **Test locators.** [testing.md](testing.md) lists the class locators the e2e suite uses. Keep them, or update the spec in the same card.

## Phases

```
Phase 0        Phase 1 + 2 (in parallel, up to 8 at a time)              Phase 3
                ┌ Classic shell
                ├ Listening room shell
                ├ Home dashboard
                ├ Search and catalog pages
Foundation ───► ├ Library browse ──► Library detail                ───► Final check
                ├ Now Playing
                ├ Octive
                ├ Downloads
                ├ Settings and Diagnostics
                └ Overlays
```

Each box is one Kungfu card and one PR into `feature/ui-refactor`. A card starts only once the cards it depends on are merged.

### Phase 0: Foundation

Owns: `src/style.css` tokens, `src/theme/*`, `src/ui/*` (new primitives), `src/lib/layout.ts` (new), `src/app/routes.tsx`, `src/app/shell.tsx` (split only), `package.json`.

- Layout and home-section preferences (decisions 1 and 2) with a `useLayout()` hook.
- Token mapping table (decision 3), fonts (decision 4).
- Shared primitives every screen needs, in `src/ui`, each with a `data-ui` attribute:
  - `SelectChip`: the 36px "Key: value ⌄" toolbar control from Classic, a native `<select>` underneath.
  - `FilterChip` and `AddChip`: the removable and dashed chips from Listening room.
  - `Segmented`: the segmented control (Server / Yours, Art / MilkDrop, scope picker).
  - `Switch`: the 38×22 toggle, a real checkbox with `role="switch"`.
  - `CoverageBar`: the stacked owned / other edition / queued / missing bar with legend.
  - `PipelineBar`: the five steps Match, Download, Convert, Tag, Move.
  - `StatTile`: the label, value and delta tile.
  - Toasts: a provider, `useToast()`, one `role="status"` region.
- Shell split: `src/app/shell.tsx` becomes a switcher that renders `ClassicShell` (`src/app/shell/classic.tsx`) or `RoomShell` (`src/app/shell/room.tsx`). Both start as today's shell so nothing breaks. Phase 1 restyles them.
- Route changes (decision 6). The Home route renders a placeholder `features/home/home.tsx` that the Home card fills in.

### Phase 1: Shells

| Card                 | Owns                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Classic shell        | `src/app/shell/classic.tsx`, `features/player/player.tsx` (footer and mini player look), shell styles |
| Listening room shell | `src/app/shell/room.tsx`, new `features/player/player-dock.tsx` (art, waveform, transport, Up next)   |

### Phase 2: Screens

Every screen card builds both layouts of its screen, switching on `useLayout()`. Shared parts go in the feature folder, not in a layout file.

| Card                     | Prototype                        | Owns                                                                                                                     |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Home dashboard           | A:99-225, B:76-174, Welcome      | `features/home/*`                                                                                                        |
| Search and catalog pages | A:364-428, B:262-313, Catalog    | `features/search/*`, `features/podcasts/*`                                                                               |
| Library browse           | A:228-351, B:177-249             | `features/library/library.tsx` browse views, `library-params.ts`, `collection-items.tsx`                                 |
| Library detail           | Collection                       | `features/library/collection-header.tsx`, `track-list.tsx`, `popularity-chart.tsx`, the detail branches of `library.tsx` |
| Now Playing              | A:431-543, B:316-410             | `features/now-playing/*`, `features/visualizer/*` (controls only)                                                        |
| Octive                   | A:546-616, B:413-485             | `features/music-bot/*` page and chat (not the pet)                                                                       |
| Downloads                | A:619-672, B:488-538, Jobs       | `features/downloads/*`                                                                                                   |
| Settings and Diagnostics | A:675-781, B:541-620, Appearance | `features/settings/*`, `features/diagnostics/*`                                                                          |
| Overlays                 | Overlay                          | `src/app/palette.tsx`, `features/links/*`, `features/player` playlist picker, `features/downloads/artist-download.tsx`   |

Library detail waits for Library browse because both edit `library.tsx`.

### Phase 3: Final check

- Walk every route in both layouts at 1280×800, 390×844 and 360×800, dark and light theme.
- `scripts/check.sh browser`, axe on every route, the themed walk.
- Update [ui-verification.md](ui-verification.md), [testing.md](testing.md), [tailwind-migration.md](tailwind-migration.md) layout contract, and the README screenshots in `docs/assets/`.

## Rules for every card

- Start from the integration branch: `git fetch origin && git reset --hard origin/feature/ui-refactor`, then `cd frontend && npm ci`.
- Open the PR against `feature/ui-refactor`, never `main`.
- Stay inside the files you own. If you must touch another card's file, keep the change small and say so in the PR body.
- Before pushing: `npm run build`, `npm test`, `npm run lint`, `npm run format:check` in `frontend/`. The pre-push hook runs `scripts/check.sh full`; do not skip it.
- Update the e2e specs for your screen. Run them if Docker is available (`scripts/check.sh browser`); if not, say so in the PR body.
- No `any`. No raw colours. No new UI libraries.
- PR body: what changed, what was left out and why (decision 7), what was and was not tested.

## Colour tokens

Filled in by the Foundation card.
