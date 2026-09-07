# Why is YouTube failing?

Phase 1 includes the tools but does not expose a download API. These are the diagnostic rules for the upcoming worker.

- **Video unavailable:** check a second known accessible video. A removed test fixture is not evidence that your setup is broken.
- **POT_MISSING or SABR warnings:** check the bgutil helper and that its version matches the installed plugin. Preserve warnings; they can explain missing audio formats even when extraction does not throw an exception.
- **JS_RUNTIME_MISSING:** inspect Deno and yt-dlp-ejs in Diagnostics. A runtime without the solver scripts is incomplete.
- **COOKIES_EXPIRED:** replace the selected cookie file. Do not import cookies from a browser automatically or expose their contents in logs.
- **SOURCE_BLOCKED / RATE_LIMITED:** pause that source, respect Retry-After and wait. Lower concurrency if failures recur. Do not keep retrying a refused endpoint.
- **TIMEOUT:** separate catalog lookup, matching and media transfer timings. Retry only the failed stage when its input artifact is intact.

Keep yt-dlp's default client selection. The image pins yt-dlp and bgutil; update through a rebuilt, tested image for now. A safe hot updater with separate installations, self-test and rollback is not implemented yet.

Source quality is measured from the downloaded file. Selecting FLAC or 320 kbps cannot improve an already lossy source. Missing 256 kbps AAC on an anonymous account is not a transcoder fault.

Current upstream references: [EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [PO tokens](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide), [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider). Checked 6 September 2026.
