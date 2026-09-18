# Tailwind migration, theming and styling plan

**Done, 17 September 2026.** Every screen is Tailwind utilities and every color is a theme token. The short guide for new work is [Styling in architecture](architecture.md#styling); this note stays as the record and holds the layout contract.

| `frontend/src/style.css` | Before phase 1 | After phase 9 |
| ------------------------ | -------------- | ------------- |
| Lines                    | 3,874          | 402           |
| Class selectors          | 223            | 10            |
| Distinct hex values      | 151            | 28            |
| Media query blocks       | 23             | 9             |

The 28 hex values are the 30 color tokens in `@theme` (two pairs share a value: `accent` and `good`, `scrim` and `shadow`). The 10 class selectors all belong to the leftovers under [What stays handwritten CSS](#what-stays-handwritten-css).

The plan as it was written follows.

Tailwind 4 is already a dependency (`tailwindcss` 4.3.3, `@tailwindcss/vite`, `@import 'tailwindcss'` in `frontend/src/style.css`). It does not style the app yet. Every screen is painted by about 3,900 lines of handwritten CSS and 223 semantic class names. This note is the plan for finishing that move, for letting each person choose or build their own theme, and for fixing the desktop and phone layout work that the current sheet makes expensive.

It is not a visual redesign. The look that ships today becomes the default theme, and it is the only built-in theme at first. What changes is that every color a person sees comes from a token, so a theme is a set of token values: the app can carry several built-in themes later, and a person can make, edit, export and import their own from a new personal settings page. Customization is the main reason for the token work, so a screen that still paints a color a theme cannot reach is not done. Native dialogs, range inputs, meters and the Now Playing popout stay. shadcn / Base UI stay out; [architecture](architecture.md) already chose a smaller set.

## Why migrate now

The next UI work is layout and interaction, on both a wide window and a phone. That work currently means editing a single file that restates the same colors, type sizes and breakpoints many times, then adding a more specific rule at the bottom so the last one wins.

Concrete costs of the present sheet:

- **151 unique hex values.** The same green-black surface is `#111716`, `#17201b`, `#17201c`, `#151c19`, `#151e19` and `#1a211e` depending on the screen.
- **`--text` is used and never defined.** Readiness rows, artist download actions and the artist sheet set `color: var(--text)`. The declaration is invalid, so those nodes inherit `#e8ece8` from `:root`. Token work should make `--text` real.
- **Rules are restated later in the file.** `.ownership`, `.track-title strong`, `.music-card small` and `.result-hint` change size after their first definition. Touch-target rules have to come last so they beat earlier `min-height`s.
- **Six max-width breakpoints** (420, 700, 767, 900, 1100, plus a 1500 min-width) describe overlapping ideas of “phone” and “tablet”.
- **Playwright still finds components by class** (`.sidebar`, `.track-row`, `.live-player`, `.stage`, `.job-card`, …). A class rename without a test update is a silent miss.

Migrating to Tailwind is the way to make the next desktop and phone fixes local: a component owns its classes, a token owns a color, a named breakpoint owns a layout change. It is also what makes themes cheap. Tailwind 4 emits every `@theme` color as a CSS custom property and its utilities read that property, so changing the property at runtime repaints the app with no rebuild and no second stylesheet.

## Current styling inventory

| Item                               | Count / fact                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `frontend/src/style.css`           | 3,874 lines                                                                  |
| Class selectors in that file       | 223                                                                          |
| Distinct `className` tokens in TSX | ~278                                                                         |
| Tailwind utilities in TSX          | none                                                                         |
| Unique hex colors                  | 151                                                                          |
| Media queries                      | 23 blocks, 9 distinct conditions                                             |
| JS-owned CSS variables             | `--player-height` (ResizeObserver in `player.tsx`), `--progress` (seek fill) |

That count is the sheet as it stood before phase 1. The 151 hexes are now 30 color tokens, and `src/no-raw-colors.test.ts` keeps them that way. The sheet itself grew by about a hundred lines of token and variable declarations; the class, media query and JS-variable counts still hold.

Surfaces, by file:

| File                                                | Role                                        |
| --------------------------------------------------- | ------------------------------------------- |
| `main.tsx`                                          | Shell, settings, diagnostics, activity      |
| `search.tsx`                                        | Discover, results, album, artist            |
| `library.tsx`                                       | Library views, toolbars, rows, empty states |
| `player.tsx`                                        | Footer player, playlist picker              |
| `now-playing-overlay.tsx`, `now-playing-popout.tsx` | Stage, full screen, popout                  |
| `downloads.tsx`                                     | Queue dock, sheet, job cards, history       |
| `artist-download.tsx`, `album-download.tsx`         | Sheets and card download controls           |
| `palette.tsx`                                       | Command palette                             |

The popout copies every live stylesheet into the new document (`copyStyles` in `now-playing-popout.tsx`). Generated Tailwind CSS is copied the same way as today’s sheet. Do not split critical popout/stage rules into a document the opener cannot read. A theme that is not the default lives as custom properties on the opener’s `<html>` element, which `copyStyles` does not see, so the theme runtime also writes them to the popout document and rewrites them when the theme changes.

## Layout contract that must survive

These rules were paid for in [UI verification](ui-verification.md) and `e2e/phone.spec.ts`. A migrated screen that regresses any of them is not done.

**Chrome**

- Desktop: 215 px sidebar (184 px under 1100 px), sticky 87 px top bar, footer player 75 px tall, queue dock above the player.
- Phone (max 767 px): sidebar becomes a 64 px bottom bar; brand, caption and sidebar footer hide; Downloads shows a count badge; the floating queue dock is hidden.
- `--player-height`, `--nav-height` and the `env(safe-area-inset-*)` variables keep `main` padding, the Settings save bar, the queue dock and virtual lists clear of the player, bottom bar, notch and home indicator.
- Phone footer is a one-row mini player with a full-width seek bar on its top edge, hidden while idle. Previous, shuffle, repeat, like, volume and add-to-playlist live on the Now Playing stage.

**Touch and text**

- `(pointer: coarse)`: interactive controls are at least 44 px. Text inputs and selects are 16 px so iOS Safari does not zoom. These rules must remain able to win over a control’s own size.
- `(hover: none)` and phone width: play overlays and destructive row actions stay visible. Desktop keeps hover-reveal.
- Minimum readable text on a phone is 10–12 px. Do not bring 9 px captions back.

**Lists and overlays**

- Virtual track and job lists size from the room under the top bar and above the player and bottom bar. Inner scrollers use `overscroll-behavior: contain`.
- Album-card download and the download-options popover sit in the top layer so a virtual row cannot clip them.
- Artist download on a phone is a bottom sheet; the playlist picker stays a centered dialog so a text field is not trapped under the keyboard.
- `prefers-reduced-motion: reduce` disables animation and smooth scrolling.

**Focus**

- Focus-visible rings stay 2 px `--accent` with offset. Skip link, stage, track rows and card overlay links already have specific rings; keep them.

## Token system

Put the design language in Tailwind v4’s CSS-first `@theme` in `style.css`. Do not add a `tailwind.config.js`.

The color tokens below are the theme contract. A theme supplies a value for each one and nothing else, so the list has to stay short enough to edit by hand and complete enough that no screen needs a color outside it.

- No raw color in a component or in the leftover CSS. That means no hex, `rgb()`, `hsl()` or named color outside the `@theme` block, and no arbitrary color utility such as `bg-[#17201b]`. `transparent`, `currentColor` and `inherit` are fine.
- A translucent or blended color comes from a token: an opacity modifier (`bg-accent/20`) or `color-mix(in oklab, var(--color-accent) 20%, transparent)`. Gradients, shadows, washes and backdrops follow the same rule.
- A unit test reads `style.css` and the TSX sources and fails on a raw color outside `@theme`. It lands with the tokens, so every later PR is held to it.

Proposed semantic tokens. Merge the near-duplicate hexes onto these; do not preserve every historical shade.

| Token                                                          | Role                                     | Start from                        |
| -------------------------------------------------------------- | ---------------------------------------- | --------------------------------- |
| `--color-canvas`                                               | Page background                          | `#111716`                         |
| `--color-sidebar`                                              | Desktop nav, phone bar                   | `#0e1312`                         |
| `--color-raised`                                               | Cards, player, sheets                    | `#17201b`                         |
| `--color-sunken`                                               | Inputs, toolbars, filters                | `#151c19`                         |
| `--color-hover`                                                | Row / card hover                         | `#1e2a23`                         |
| `--color-active`                                               | Selected nav, selected track wash        | `#263327`                         |
| `--color-text`                                                 | Primary text (`--text` today)            | `#e8ece8`                         |
| `--color-muted`                                                | Secondary text                           | `#93a39b`                         |
| `--color-faint`                                                | Eyebrows, timestamps                     | `#819088`                         |
| `--color-line`                                                 | Default borders                          | `#2a3630`                         |
| `--color-line-strong`                                          | Player top edge, stronger rules          | `#344035`                         |
| `--color-accent`                                               | Brand, focus, owned, primary buttons     | `#c3e4a2`                         |
| `--color-accent-ink`                                           | Text on accent                           | `#172014`                         |
| `--color-accent-hot`                                           | Queue dock, live job state               | `#d9ff73`                         |
| `--color-good` / `--color-good-bg` / `--color-good-line`       | Ready, healthy                           | `#c3e4a2` / `#283a28` / `#4b6743` |
| `--color-warn` / `--color-warn-bg`                             | Conflict, match warning, offline banner  | `#f8ca76` / `#342e1d`             |
| `--color-danger` / `--color-danger-bg` / `--color-danger-line` | Errors, failed, not-ready                | `#efbaa2` / `#39251f` / `#674343` |
| `--color-owned-bg` / `--color-partial` / `--color-partial-bg`  | Ownership chips                          | `#2a3a27` / `#e4cc9c` / `#3a3224` |
| `--color-scrim`                                                | Dialog and sheet backdrops, image washes | `#000000`                         |
| `--color-shadow`                                               | Drop shadows                             | `#000000`                         |

Phase 1 added three more, because nothing above could express them:

| Token                  | Role                                                                               | Value     |
| ---------------------- | ---------------------------------------------------------------------------------- | --------- |
| `--color-partial-line` | Border of a part-way or not-yet-tested chip, beside `--color-partial`              | `#4b4b3a` |
| `--color-media`        | Solid backing behind artwork and the visualizer                                    | `#020305` |
| `--color-on-media`     | Text and icons over artwork or the scrim; stays light when the page text goes dark | `#ffffff` |

If a later pass finds a color that none of these can express, add a token with a role name and list it here. Do not name a token after a screen.

Layout variables stay CSS custom properties, not Tailwind spacing, because JavaScript and several `calc()`s read them:

```text
--sidebar-width   215px desktop, 184px tablet, 0 phone
--topbar-height   87px desktop, 60px phone
--nav-height      0 desktop, 64px phone
--player-height   75px default, measured by the footer ResizeObserver
--progress        seek fill, set on the range input
--safe-top/right/bottom/left   env(safe-area-inset-*, 0px)
```

Z-index is a named scale in `@theme` (`--z-index-*`, used as `z-bar`, `z-dock` and so on) with the numbers the sheet already had: `base` 1, `raised` 2, `float` 3, `sticky` 4 (save bar), `header` 5 (top bar), `overlay` 15 (filter popover), `bar` 20 (the footer player at every width, and the phone bottom bar), `skip` 30, `dock` 45 (queue pill). Collapse neighbours only when a screen conversion shows two of them never meet.

Type: keep Inter and the system stack on `:root`. Map the sizes we actually use (9/10 captions, 11–14 body, 16–19 section, 27–32 page, clamp heroes) to `--text-*` theme keys so screens stop inventing 13.5 px.

Radius: 4 / 6 / 8 / 12 / 14 / 22 / 999. Four theme radii (`sm`, `md`, `lg`, `pill`) cover them.

## Themes

A theme is data, not a stylesheet.

```text
built-in themes (TypeScript)  --+
                                +--> active theme --> custom properties on <html> --> utilities repaint
custom themes (localStorage)  --+                 +-> same properties on the popout document
```

```ts
type Theme = {
  id: string // 'musimo-dark' for the built-in, 'custom-<uuid>' for a person's own
  name: string
  scheme: 'dark' | 'light' // sets `color-scheme`, so native dialogs, scrollbars and form controls match
  colors: Record<ColorToken, string> // one hex value per token in the table above
}
```

**Where things live.** `frontend/src/theme/` holds the token list (name, label and group, used by the editor), the built-in registry, the zod schema for stored and imported themes, the store, and pure helpers (hex parsing, contrast ratio). One built-in ships first, `musimo-dark`. Its values in TypeScript must equal the `@theme` block; a unit test parses `style.css` and compares them, so the two cannot drift. Adding a built-in theme later is adding one object to the registry.

**Storage.** Themes are a personal preference, like volume and the library layout, so they live in `localStorage` under `musimo.theme` (the active id), `musimo.custom-themes` (the person’s own, versioned) and `musimo.theme-vars` (the resolved properties for the boot script). Server settings are shared, lockable by environment and saved with a save bar; a theme is none of those. Export and import of a JSON file moves a theme between browsers. Syncing through the backend is a later option, not part of this plan.

**Applying a theme.** The default needs no JavaScript: `@theme` already holds it. Any other theme sets each `--color-*` property and `color-scheme` on `<html>`, and updates `<meta name="theme-color">` to the canvas color. The store notifies subscribers so the popout document gets the same writes. A `storage` event applies a change made in another tab.

**No flash on load.** The Content-Security-Policy allows scripts from `'self'` only, so an inline script is out. A small classic script in `frontend/public/theme-boot.js`, loaded in `<head>` before the module, reads `musimo.theme-vars`, accepts only `--color-*` names with hex values, and sets them before first paint. Anything unexpected falls through to the default.

**Untrusted input.** A stored or imported theme goes through the schema: known token names only, six or eight digit hex values only, a bounded name length, and a cap on how many custom themes are kept. A value is written with `style.setProperty`, never into a style string. A theme that fails validation is ignored with a message, not half-applied.

**Personal settings page.** A new route, `/settings/user`, titled “Your settings”, with Appearance as its first section. The Settings page gains a two-item switch at the top, Server and Yours, so the page is reachable from the same Settings entry on desktop and phone. The command palette gets “Change theme”.

```text
Your settings > Appearance
  status line (saved, imported, deleted, cancelled)
  theme cards (swatch + name, the active one marked)      pick = on at once, no save bar
  [Duplicate and edit]  on every card                     built-ins can only be copied
  [Edit] [Export] [Delete]  on your own                   [Reset to default] keeps your themes
  Move a theme between browsers: [Import a theme file]    an import is turned on when it lands
      |
      v
  editor: preview strip (buttons, chips, status messages, badges, rows, text over artwork)
          name, scheme, colors grouped as Surfaces / Text / Lines / Accent / Status
          each color = native color input + hex field; the app around it is the live preview
          contrast ratios for the pairs people read through, low ones named in words
          sticky bar: what is stopping a save, if anything   [Cancel]  [Save]
```

Changes apply while editing but only persist on Save. Leaving the page with unsaved edits asks first, then restores the saved theme. Deleting the active custom theme falls back to the default. At the cap of fifty themes, Duplicate and Import are off until one is deleted.

**What a theme cannot change, for now.** Type, spacing, radii, layout and the visualizer scenes. The stored format carries a version so radius or font choices can be added without breaking saved themes.

## Breakpoints

Normalize the six widths to four named ones, then use Tailwind’s `max-*` variants.

| Name     | Width       | Meaning                                                                                                                                                                                                                                                            |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phone`  | max 767 px  | Bottom bar, mini player, one-column settings, 2-up music grid. Matches [player.md](player.md) “under 768px”.                                                                                                                                                       |
| `narrow` | max 700 px  | Fold into `phone` where the layout is the same (queue actions, Now Playing hero, library tabs). Keep a separate token only if a 701–767 window still needs the desktop treatment after a visual check. Phase 3 decided the shell's share of it: no `narrow` token. |
| `tablet` | max 1099 px | Narrow sidebar, stacked settings index, hide track-album and preview-label, tighter player padding.                                                                                                                                                                |
| `split`  | (folded)    | Retired in phase 8. The Now Playing columns stack at `max-tablet:`, because the Up next rows no longer fit beside the lyrics under 1100 px. See below.                                                                                                             |
| `wide`   | min 1500 px | Extra main padding only.                                                                                                                                                                                                                                           |

**The 700 px decision, taken in phase 3.** Screenshots at 768 px and 1024 px show the same desktop chrome: the 184 px sidebar, the sticky top bar and the full footer player, with the Settings save bar clearing the player at both widths. Nothing between 701 px and 767 px wants the phone treatment, so `narrow` is not becoming a breakpoint token.

The shell had two rules in that band. The save bar's only extra rule was the 767 px padding, which is now `max-phone:p-[12px]`. The queue dock's was `right: calc(12px + var(--safe-right))` at 700 px, and it was already unreachable: the dock is hidden under 768 px, so no window narrow enough to want the smaller offset ever draws it. That rule is deleted rather than folded. The 700 px rules still in the sheet belonged to the queue sheet and job cards (phase 6) and the Now Playing hero and stage controls (phase 8); both folded them into `max-phone:` when they converted.

**The 900 px decision, taken in phase 8.** Screenshots at 899, 900 and 1024 px with long invented titles settled it. At 900 px the Up next rows, whose title, album, time and play columns need about 450 px, ran out of their 1.6fr column and drew over the Lyrics panel. At 1024 px they only just fit, with the title squeezed to its 170 px minimum and the lyrics in a 290 px strip. One column at both widths gives Up next the full width and puts the lyrics under it. So the columns stack at `max-tablet:`, `split` has no users left, and `--breakpoint-split` is gone from the `@theme` block.

Default Tailwind `md` is 768 px, one pixel off our phone cut. Do **not** silently switch to `md` / `max-md` without re-running `e2e/phone.spec.ts` at 360 and 390 and a 768 px desktop check. The sheet declares `--breakpoint-phone: 48rem` (768 px) and `max-phone:` is the documented phone variant. Every breakpoint is in rem and the stock `sm` to `2xl` are reset, because Tailwind sorts breakpoints by unit before size and a px value next to a rem one puts the variants in the wrong order. Every handwritten width query uses the same edge as its variant, so a screen and its shell switch together.

Add custom variants for the non-width queries:

```css
@custom-variant coarse (@media (pointer: coarse));
@custom-variant fine (@media (pointer: fine));
@custom-variant no-hover (@media (hover: none));
```

`motion-reduce:` already exists in Tailwind. Use it instead of a second global animation reset if the generated CSS covers the same elements; keep a small leftover rule if `scroll-behavior` still needs it.

## What stays handwritten CSS

Tailwind utilities will not replace these cleanly. Keep them in `style.css` (or a later `frontend/src/styles/` split) as documented leftovers:

- Footer seek thumb/track (`::-webkit-slider-*`, `::-moz-range-*`) and `--progress` fill.
- `meter` and `progress` vendor bars.
- Card primary-link `::after` hit area and focus ring.
- Dialog / palette / sheet `::backdrop`.
- `:fullscreen` stage and `.popout-root` / `.popout-body`.
- Virtual list height `min(620px, 100dvh - chrome)`.
- Command-palette skip-link off-screen focus move.
- Popularity-chart SVG strokes (can take theme colors, not utilities).

Do not rewrite those as `@apply` piles.

## Shared primitives

Add a tiny `cx` helper (local, no new package unless class lists become painful) and a `frontend/src/ui/` folder for the controls every screen already pretends are components:

| Primitive                          | Replaces                                       | Variants                              |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `Button`                           | `.button`, `.button.primary`, `.button.danger` | default, primary, danger              |
| `IconButton`                       | `.icon-button` plus `active`                   | default, active, 44 px on `coarse`    |
| `TextLink`                         | `.text-link`                                   | none                                  |
| `Tag` / `StatusChip` / `Ownership` | `.tag`, `.status-chip`, `.ownership`           | good, owned, partial, failed, missing |
| `Panel` / `EmptyPanel`             | `.panel`, `.empty-panel`, `.library-empty`     | none                                  |
| `ErrorBanner` / `InlineError`      | `.error`, `.inline-error`, `.failure-summary`  | none                                  |
| `Field`                            | settings, filters, playlist forms              | 16 px / 44 px on `coarse`             |
| `Kbd`                              | `kbd`                                          | hide on phone                         |

A primitive is done when its TSX call sites no longer mention the old class, its coarse/hover behavior is in the component, and the matching Playwright checks still pass. Prefer `getByRole` over a class locator when a primitive lands, so later class churn does not break the suite.

What shipped in phase 2: `Field` has a `FieldSelect` twin for `<select>`. `buttonClassName`, `iconButtonClassName`, `textLinkClassName` and `errorBannerClassName` dress an element the component cannot wrap, such as a routed `<Link>`; that element also sets the matching `data-ui` by hand. Every primitive sets `data-ui`, and `Ownership` sets `data-variant`, which is what the sheet's leftover contextual rules and the specs hook onto where a role or label will not do. `className` on a primitive is for layout. A size or color that differs by context is a variant on the primitive, not an override.

**The cascade rule.** Utilities live in a layer, so any unlayered rule beats them. Bare element resets live in `@layer base`. Unlayered class rules are the old screens, and they win over a primitive on purpose until that screen converts. When you convert a screen, delete its contextual rules for primitives (`.stage-controls [data-ui='icon-button']` and the like) and move what they did onto the call site or a variant.

Do **not** `@apply` a primitive’s entire class string “for cleanliness” and also keep the old CSS class. One source of truth.

## Migration sequence

Each pull request is one surface, merges to `main` in dependency order, keeps the app usable, and is verified on 1280×800 and 390×844 (plus 360×780 for phone chrome). Do not convert the whole sheet in one change.

```text
0   This plan
1   Tokens, variants, --text, cx helper, no-raw-color test      every color in the old sheet reads a token
T1  Theme runtime: registry, store, boot script, popout sync     after 1
2   Primitives (button, icon, chip, error, field)                after 1
T2  Personal settings page: picker, editor, import / export      after T1 and 2
3   Shell + footer player + save bar + dock                      after 2
4   Search, cards, track rows, album / artist                    after 3
6   Downloads, job cards, queue sheet, options                   after 3
5   Library grids, lists, toolbars, detail                       after 4
7   Settings, diagnostics, activity                              after 6 and T2
8   Now Playing stage, overlay, popout leftovers                 after 5 and 6
9   Delete dead CSS; retarget class locators; themed walk        last
```

Two lanes can run at once after phase 3 because search and library touch different TSX files from downloads and settings. They still delete from the same `style.css`, so expect a merge from `main` before each PR lands.

### Phase 1: tokens

- Move `:root` colors, type, radii and the layout variables into `@theme` / a documented `:root` block.
- Replace every raw color in the old sheet with a token or a `color-mix()` of tokens, merging near-duplicate shades onto the table above. Small shifts in shade are expected and accepted; a changed layout is not. This is what lets a theme reach screens that have not been converted yet.
- Add the no-raw-color unit test.
- Define `--text` as `--color-text`.
- Add `coarse`, `no-hover` and the phone/tablet breakpoints.
- Leave class names and markup alone. The diff should be CSS, the `cx` helper, the test and a short architecture note.

**Check:** production CSS still builds; popout still copies rules; visual spot-check of Search, Library, Downloads, Settings, Now Playing at desktop and 390 px.

### Phase T1: theme runtime

- Add `frontend/src/theme/` as described under Themes, `public/theme-boot.js`, the `<head>` script tag and the popout sync.
- No user interface yet. Unit tests cover the schema, the TypeScript and CSS default match, contrast maths and the resolved-property output.

**Check:** with a theme written into `localStorage` by hand, a reload paints it with no flash of the default, the popout matches, and clearing the keys returns the default.

### Phase T2: personal settings page

- Add `/settings/user`, the Server / Yours switch, the palette command, the picker, the editor, import, export, delete and reset.
- Extend `e2e/theme.spec.ts` (phase T1 added it, with the light fixture theme in `e2e/theme-fixtures.ts`): create, edit, cancel, save, reload, export, import, delete, a second tab following the first, a rejected bad import, and axe on the page at desktop and phone width.

**Check:** the new spec, `e2e/a11y.spec.ts` and `e2e/phone.spec.ts`.

What shipped in phase T2: `frontend/src/user-settings.tsx` is the page, all utilities and primitives. The theme rules it needs that are not pure page state live in the store (`saveAndActivate`, `hasRoomForTheme`, `isBuiltInTheme`, `themeFileName`, the file size cap) so a later caller cannot do half of one. `Field` grew `invalid` and `fullWidth` options because a call site cannot swap a primitive's border or width by passing another utility. `frontend/src/theme/contrast.ts` holds the pairs the readability report checks; it refuses the three and four digit hex the arithmetic would accept, because the editor does. The native color input's swatch is the one handwritten rule the page added to the sheet.

### Phase 2: primitives

- Introduce `frontend/src/ui/` and switch obvious buttons, chips and error boxes.
- Put the coarse 44 / 16 rules on the primitives so later screens inherit them.
- Start retiring class locators that those primitives replace (`.button.primary`, `.readiness-badge` can wait until Settings).

**Check:** `e2e/a11y.spec.ts`; click paths in `app.spec.ts`, `album.spec.ts`, `cards.spec.ts`.

### Phase 3: shell and player chrome

Highest leverage for desktop and phone UX. Convert `.app`, `.sidebar`, `.nav-link`, `.workspace`, `.topbar`, `.search-input`, `.connection*`, `.player`, `.live-player`, `.save-bar`, `.queue-dock`.

Keep the JS contract: the footer still publishes `--player-height`; phone still sets `--nav-height` and `--sidebar-width: 0`.

Fold the 700 px queue / save-bar rules into `phone` here if a 768 px window still clears the bottom bar. (Done: the save bar in phase 3, the queue sheet and job cards in phase 6.)

**Check:** all of `e2e/phone.spec.ts`; player and playlist specs that look at `.live-player` and `.sidebar`; axe on every route.

What shipped in phase 3: the shell, the footer player, the Settings save bar and the queue dock are Tailwind utilities in `main.tsx`, `player.tsx` and `downloads.tsx`. The classes the suite locates by (`sidebar`, `live-player`, `save-bar`, `nav-badge`) stay on their elements as bare hooks with no rule behind them, so no locator moved; `playback-controls` stays for the same reason, because the leftover seek-bar rules hang off it. The layout variables did not move: the footer still publishes `--player-height` from its ResizeObserver, `:root` still switches `--sidebar-width`, `--nav-height` and `--topbar-height` at the phone width, and the safe-area insets still pad `main`, the save bar and the dock. `.brand`, `.nav-caption`, `.sidebar nav`, `.sidebar-bottom`, `.sidebar-actions`, `.playlist-actions` and `.playback-controls input` converted with them, because a rule under a converted ancestor cannot be left behind. The contextual rules the footer put on `[data-ui='icon-button']` are gone; the smaller size is `size="compact"` on `IconButton`, used by the footer and by the playlist picker that lives inside it, and the primitive's own `coarse:` rule still raises it to 44 px. Later screens with their own icon sizes (the stage, the layout toggle, collection actions) add a size to the primitive the same way. The title block, the volume slider and the Now Playing link converted too, so the only footer rules left in the sheet are the seek bar's vendor pseudo-elements and its inset focus ring, which has to be handwritten because the unlayered focus ring rule would beat a utility. Every handwritten width query now uses the variants' edges (`width < 48rem` and so on) so the `:root` variables and the utilities switch at the same pixel, including at zoomed, fractional widths. The 700 px decision is under [Breakpoints](#breakpoints) above.

What shipped in phase 6: Downloads (tabs, job cards, the failure summary and its group chips, history and its filters, the queue sheet, the options popover, the virtual job list) and Recent activity are utilities in `downloads.tsx` and `recent-activity.tsx`. The job card's actions and the sheet's close are `IconButton` with `variant="outlined"`. The 700 px queue rules folded into `max-phone:`, as the Breakpoints section allowed. `download-tabs`, `job-card`, `virtual-list`, `download-action`, `download-options` and `download-error` stay as hooks: the download specs locate by the first three, and the track row and album card, which convert in phase 4, still style the last three from the sheet. `meter` and `progress` vendor bars and the sheet's `::backdrop` are the handwritten leftovers, taking token colors.

### Phases 4–8: screens

Convert one journey at a time, in the order people use the app. While a screen is open, fix the UX items listed for it below. Do not “fix later” a wrapping title or an empty View-all link on a screen whose classes you are already touching.

Phase 8 keeps stage/popout/fullscreen CSS conservative. The visualizer canvas and visimo scenes are out of scope.

What shipped in phase 4: Discover, the result sections, music cards, track rows, the album and artist pages, and `album-download.tsx`, `artist-download.tsx` and `download-target.tsx` are Tailwind utilities in `search.tsx` and those three files. `.music-card`, `.track-row`, `.explicit`, `.album-actions` and `.download-target` stay on their elements as bare hooks with no rule behind them (the first three because `e2e/cards.spec.ts` and `phone.spec.ts` query them, the rest two because `album.spec.ts` scopes role queries by them); no locator moved. `.card-primary-link::after` and its focus ring stay handwritten, per the list above; the card's other rules converted, so the class carries only that leftover now. `.section-heading`, `.virtual-list` and the touch-target coarse block are still load-bearing for Library and Settings, which have not converted yet, so their rules stay in the sheet; `.result-tabs` had no users left and its rules went. The search and download tabs set `data-ui="tab"`, which is what the phone spec's touch-target gate reads. The track row places its download control with a `className` on `DownloadButton`, so the sheet's `.track-row .download-action` rule went too. The album card's control is `IconButton` with an `accent` variant (`accent-washed` on the card, where it floats over the art), the search filters are `Field` and `FieldSelect` with `tone="sunken"`, and the album page's download error is the error banner. The phone-width `h1` size and `button:disabled` moved into `@layer base` so a utility on a converted heading or control can win over them. `Badge` takes an optional `className` now, so the track row's phone-width ownership badge is a variant instead of a `.track-row [data-ui='ownership']` override, and `Art` takes a `size` (`card` / `row`) and `className`, so the 46 px row art and the album header's 210/95 px art no longer need their own selectors. `AlbumDownloadButton` takes an `overlay` prop for the card variant (absolute, hidden until the card is hovered, always visible on `no-hover:` and phone), which replaces the `.music-card > .album-card-download` contextual rules. Search sections hide their "View all" link once they have no results, closing that row in the UX table below. The artist download sheet had lost the browser's default modal centering under Tailwind's preflight `margin: 0` reset, because unlike the other dialogs in the sheet it never set its own `margin`; it now does (`m-auto`, `max-phone:m-0` for the bottom sheet).

What shipped in phase 5: the library tabs, toolbar, filters, grids, list rows, album, artist, artist songs, tracks, playlists and playlist detail, empty states, the inline rename and Add songs are Tailwind utilities in `library.tsx`; the scan panel had converted with Settings. `.library-card`, `.library-grid`, `.library-list-row`, `.library-list-open`, `.library-card-copy`, `.library-card-play`, `.library-track-row`, `.library-track-play`, `.library-tracks`, `.library-detail`, `.library-count`, `.library-list-actions`, `.library-artist-card`, `.library-artist-heading` and `.playlist-add-list` stay on their elements as bare hooks with no rule behind them, because `e2e/library-controls.spec.ts`, `player.spec.ts` and `playlists.spec.ts` query them by class; no locator moved. `Field` dresses the playlist create/rename inputs, matching the primitive's stated "playlist forms" use. The row that shows an album, artist or playlist as a sunken pill (art, name, meta, action cluster) repeats across `AlbumItem`'s list layout, `ArtistItem` and `PlaylistRow`'s list layout, so it is a handful of local class-string constants in `library.tsx` rather than a new shared primitive; the grid variant of a playlist row keeps its own markup because its card look and 28 px icon column do not match the pill. `NowPlayingPage`, in the same file, is out of scope: it belongs to Now Playing (phase 8), and only its one shared `EmptyPanel` sizing utility moved so the rule it depended on could be deleted. `.section-heading`, `.button-row`, `.eyebrow`, `.page-heading`, `.muted` is still load-bearing for Now Playing, so Library keeps reading it unconverted; `.small` had no users left and its rule went; `.virtual-list` was never Library's rule to begin with, it belongs to Search and Downloads, and stays untouched. The load error for whichever tab is open now renders under that tab's own heading (`InlineError`) instead of above the whole browser, closing that row in the UX table below.

What shipped in phase 7: the Settings page, the Diagnostics page and the library index panel are Tailwind utilities in `main.tsx` and `library-panel.tsx`. Recent activity had already converted with Downloads in phase 6, so there was nothing left for it here. `.readiness-item`, `.readiness-badge`, `.readiness-panel`, `.health-strip` and `.save-bar` stay as bare hooks with no rule behind them, matching how the shell and Downloads phases left their own locators; `e2e/app.spec.ts` still finds the readiness rows and the health strip by class. The readiness badge is `StatusChip` with `emphasis` and a `danger` variant, which `.readiness-badge` had been waiting for since phase 2. `.section-heading` stayed in the sheet for Library and Search, which have not converted yet; Settings and Diagnostics now write the same row and title classes inline instead of adding a fourth caller to a class due to convert away. Settings already used `Field`/`FieldSelect` for every control from an earlier phase, so that part needed no change. The Settings headings and the "up to date" save bar now wait for `settings.data`, showing the existing loading paragraph or error banner instead, which also stops the section index from painting before the sections it links to exist; `e2e/app.spec.ts` covers a delayed and a failed `/api/settings` response, holding back the shell's own snapshot fetch too since it can otherwise populate the same query cache first.

What shipped in phase 8 (closing the Up next, hero title and breakpoint rows in the UX table below): the Now Playing page (`NowPlayingPage` in `library.tsx`), the stage and its overlay (`now-playing-popout.tsx`, `now-playing-overlay.tsx`), the playlist picker in `player.tsx` and the command palette (`palette.tsx`) are Tailwind utilities. The stage's controls are `IconButton` with a new `on-media` variant and the `compact` size, which replaces the `.stage-controls [data-ui='icon-button']` rules and their coarse copy; the liked thumb now turns accent when on, like shuffle and repeat. The idle fade hangs off the `idle` class the hook already set, through `group-[.idle]:` on the overlay. The handwritten leftovers are `.stage:fullscreen`, `.popout-body`, `.popout-root` and `.popout-root .stage`, which sit outside every layer so they still beat the stage's own utilities, and the `::backdrop` of the palette and the picker. `.stage`, `.stage-art`, `.stage-overlay`, `.stage-top`, `.stage-controls`, `.playlist-picker-row`, `.playlist-picker-songs`, `.playlist-picker-sheet` and `.command-palette` stay on their elements as hooks: the suite and the idle hook find the first five by class, the next two are playlist spec locators, and the last two carry the backdrop rules. `.round-play` stays in the sheet because the footer player shares it and `phone.spec.ts` reads it. The picker's name field is `Field`. Three colors that were page tokens drawn over artwork now take `--color-on-media` at an opacity (the byline under the stage title, the placeholder disc and the popped-out notice), and the stage's sliders take the accent instead of the browser's blue, so a light theme no longer puts dark text on the dark stage. Up next titles, artists and albums cut to one line with an ellipsis, through a `oneLine` option on the shared track list, and the hero heading stops after three lines at the full `text-hero` size. The 700 px hero and stage rules folded into `max-phone:`. "What stays handwritten CSS" lists a command-palette skip-link focus move, but the palette has no skip link; the app's one skip link is in the shell and has been utilities since phase 3, so there was nothing to keep.

### Phase 9: cleanup

- `style.css` should be tokens, leftovers from “What stays handwritten CSS”, and nothing else.
- Walk every route under the light fixture theme at desktop and phone width and run axe there. A dark patch on a light theme is a color that escaped the tokens; fix it.
- Grep for old class names in TSX and e2e; leftover matches are either a missed conversion or a locator that should be a role.
- Record a short “how we style” subsection in [architecture](architecture.md) so new screens start in Tailwind.

What shipped in phase 9: the last class rules left in `style.css` converted where they were used and went where they were not. The page title and its eyebrow are utilities in `page-title.tsx`; `.section-heading`, which Search, Library, Settings and Diagnostics had each copied in their own way, is three class strings in `ui/section-heading.ts` (Search keeps a slightly tighter local version for its result sections); `.round-play` is `IconButton variant="play"`, so the footer and stage play buttons carry `data-ui` and the phone touch-target check no longer needs a class for them; `main`'s padding moved onto the element in `main.tsx`; `.spin` is Tailwind's `animate-spin`; `.sr-only` is Tailwind's own; the format list's option background is an arbitrary variant on the download control; `.button-row`, `.results-section`, `.empty-results`, `.artist-release-heading` and the coarse `.track-row button` rule moved onto their call sites; `.preview-label` had no users. Nineteen bare hook classes that nothing queried any more (`music-card`, `track-title`, `download-options`, `library-cover` and the like) came off their elements. The remaining width queries read `theme(--breakpoint-*)` instead of repeating the rem values, and the three backdrop rules share one block. The `.section-heading` locator in `app.spec.ts` became a heading role, and the sidebar nav locator became its landmark; the class hooks that survive are listed in [Testing](testing.md). `e2e/themed-walk.spec.ts` walks every route under the light fixture theme at both widths, and found no color outside the tokens (logged in [UI verification](ui-verification.md)). The no-raw-color test's allow-list was already empty and is gone; the theme registry is the one file it excuses.

Two places where this plan and the code disagreed. The stylesheet's `.sr-only` duplicated Tailwind's utility of the same name, so it was deleted rather than kept as a leftover. And “What stays handwritten CSS” below does not list the focus ring, the native color swatch, the reduced-motion reset or the coarse-pointer 16px text rule, all of which stay handwritten because they must beat any utility or reach a shadow part; the list in [architecture](architecture.md#styling) is the complete one.

## UX issues to take with the migration

From the 10–11 September walks in [UI verification](ui-verification.md), plus token bugs found while reading the sheet. Split them so a Tailwind PR is not blocked on product behavior, and a behavior PR is not blocked on Tailwind.

### Fix with the screen that owns them

| Issue                                                                                | Screen / phase | Notes                                                                 |
| ------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Search sections offer “View all” with zero results                                   | Search (4)     | Hide the link when the section is empty.                              |
| Library load error sits above “Fresh in your library”, and retries for seconds first | Library (5)    | Put the inline error under the heading; keep `.inline-error` styling. |
| `--text` undefined                                                                   | Tokens (1)     | Define it.                                                            |

### Keep as separate product work

These are real, but they are routing or copy, not styling:

- `/nope` returns the backend JSON 404; the in-app “Page not found” only appears under `/library`. Backend tests assert the JSON 404.
- Real notched iPhone (standalone) and Android-with-keyboard still need a device look. Chromium emulation reports no safe-area insets. Do that pass after the shell phase, not instead of it.
- Catalog preview previous/next, file replacement and Discover remain [roadmap](roadmap.md) items.

### Looked at and left

Do not “clean up” these as part of Tailwind unless a user asks: inline text links staying text-sized (WCAG), centered playlist picker, search/library/queue empty states, command palette, full-screen stage, mobile mini-player shape.

## Testing rules for every styling PR

1. **Commit the CSS/TSX change, then run the suite that owns the screen** before calling it done. A production `vite build` does not prove layout.
2. **Desktop 1280×800 and phone 390×844**, plus 360×780 when chrome or tabs change. `e2e/phone.spec.ts` is the gate for bottom bar, mini player, save bar, download count, 44 px targets, 16 px fields, format-in-popover and the artist sheet.
3. **Do not rename a class that an e2e file still queries** in the same PR without updating the locator. Prefer switching that locator to a role or label while the markup is open. The class hooks the suite still uses are listed in [Testing](testing.md).
4. **Popout:** after any global CSS move, open Now Playing and pop out once. `copyStyles` must still see the generated Tailwind sheet.
5. **Coarse pointer:** if you change a control’s size, the `coarse:` (or leftover `@media (pointer: coarse)`) rule must still win. The phone spec measures this.
6. **No sideways scroll, no element wider than its box** on the screens you touched. That was the 10 September walk’s probe; keep the spirit even without the temporary script.
7. **Themes:** the no-raw-color test passes, and the screens you touched look right under the light fixture theme in `e2e/theme-fixtures.ts`. The rest of the suite runs under the default theme.
8. Update [UI verification](ui-verification.md) only when a walk finds or closes a user-visible issue. Do not log a class-only conversion there.

## Out of scope

- Shipping a second built-in theme. The registry supports it; the first release has one.
- Syncing themes through the backend, a shared theme gallery, per-theme fonts, radii or spacing, and theming the visualizer scenes.
- Adding shadcn, Base UI, cmdk, Vaul, sonner or Zustand. Native `dialog`, the existing palette and the existing sheets are enough.
- Extracting CSS modules per file “as a stepping stone”. That is a second migration.
- Rewriting visimo / WebGPU stage drawing.
- PWA install UI, share target, notifications.

## Suggested first implementation PR

Phase 1 only: tokens, `--text`, custom variants, breakpoint names, every old color pointed at a token, the no-raw-color test, and a short “Styling” subsection in [architecture](architecture.md) that points here. No class renames. That gives every later change a palette and a `max-phone:` / `coarse:` language without risking the phone chrome, and it means the theme runtime that follows already reaches the whole app.
