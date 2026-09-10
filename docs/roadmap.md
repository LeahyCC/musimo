# Roadmap and UX follow-ups

This is a priority list, not a release promise. The [brief](brief.md) preserves the original scope; [measurements](measurements.md) records completed checks. [Discover](discover.md) is planned separately.

## Finish the existing journey first

Search -> inspect recording -> choose destination/format -> queue -> see progress -> handle failure -> find the finished file in Navidrome. Validate that entire path with permitted audio before expanding integrations.

Current UI work covers automatic album coverage, card downloads, linked preview metadata, volume/mute/restart/close and bounded activity with clearing.

## Next UX improvements

1. **Make the download destination visible at the decision point.** Card actions use saved defaults. A compact destination/format summary would reduce accidental queueing to the wrong collection without adding a modal to every click.
2. **Actionable source errors.** Link a job's error to the exact source/credential/disk setting that needs attention. Keep successful jobs visible when enrichment or Navidrome scanning warns.
3. **Track navigation and context** (done 10 September 2026). Highlighted-track links now focus the row, show a visible focus indicator, and display a disabled state when no preview is available. Album and artist pages show "Back to results" when reached from search. Previous/next already exist for library playback over the saved queue and previews stay without them until a preview queue is defined.
4. **Explain duplicates and editions.** Separate "already queued", "in library" and "another edition matched". Offer a deliberate replacement flow without overwriting existing files silently.
5. **First-run readiness.** Show real mount access, selected destination, scan state and one permitted test-download outcome. Avoid a checklist that marks a dependency as connected merely because it is installed.
6. **Long-list accessibility.** Exercise keyboard focus across virtualization, touch targets, screen-reader labels, contrast and zoom. Check queue/player overlap at narrow widths and while errors expand.
7. **Separate settings drafts from live updates.** Verify that scan/queue events do not erase an unsaved form. Show a clear save acknowledgement and preserve drafts during an unrelated background event.

## Release readiness

Public documentation needs accurate feature labels, a working private security contact, contribution templates and dependency notices. Container releases additionally need an inventory and licence/source-distribution review for the exact image. [Releasing](releasing.md) lists concrete checks.

## Deferred implementation

Artist/playlist imports, Discover recommendations, notifications, cookies, account connections, authentication and performance hardening remain separate work. Avoid adding additional preview transport controls or autoplay until the user flow is defined.
